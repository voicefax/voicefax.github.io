
"use strict";

const BAUD = 1200;
const FREQ_ZERO = 1200;
const FREQ_ONE = 2200;
const MAX_FILE_SIZE = 64 * 1024;
const PREAMBLE_BYTES = 100;
const SYNC = [0xD3, 0x91, 0xC5, 0xA7];

const $ = id => document.getElementById(id);

let selectedFile = null;
let preparedWav = null;
let microphoneContext = null;
let microphoneStream = null;
let processor = null;
let analyser = null;
let recordingChunks = [];
let recordingActive = false;
let animationFrame = null;
let receivedUrl = null;

function status(message, active = true) {
  $("mainStatus").textContent = message;
  $("statusLight").style.background = active ? "#65db8b" : "#e4a35c";
  $("statusLight").style.boxShadow = active
    ? "0 0 9px #65db8b"
    : "0 0 9px #e4a35c";
}

function setProgress(id, value) {
  $(id).style.width = Math.max(0, Math.min(100, value)) + "%";
}

document.querySelectorAll(".tab").forEach(button => {
  button.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach(b => b.classList.remove("active"));
    document.querySelectorAll(".panel").forEach(p => {
      p.hidden = true;
      p.classList.remove("active");
    });

    button.classList.add("active");
    const panel = $(button.dataset.panel);
    panel.hidden = false;
    panel.classList.add("active");
  });
});

// CRC32
const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let crc = 0xFFFFFFFF;
  for (const byte of bytes) {
    crc = crcTable[(crc ^ byte) & 0xFF] ^ (crc >>> 8);
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function u16(value) {
  return [value & 255, (value >>> 8) & 255];
}

function u32(value) {
  return [
    value & 255,
    (value >>> 8) & 255,
    (value >>> 16) & 255,
    (value >>> 24) & 255
  ];
}

function readU32(bytes, offset) {
  return (
    bytes[offset] |
    (bytes[offset + 1] << 8) |
    (bytes[offset + 2] << 16) |
    (bytes[offset + 3] << 24)
  ) >>> 0;
}

function makePacket(fileBytes, filename, mime) {
  const encoder = new TextEncoder();
  const nameBytes = encoder.encode(filename);
  const mimeBytes = encoder.encode(mime || "application/octet-stream");

  const metadata = new Uint8Array([
    ...u16(nameBytes.length),
    ...nameBytes,
    ...u16(mimeBytes.length),
    ...mimeBytes
  ]);

  const body = new Uint8Array([
    ...u16(metadata.length),
    ...metadata,
    ...fileBytes
  ]);

  const checksum = crc32(body);
  return new Uint8Array([...body, ...u32(checksum)]);
}

function bytesToBits(bytes) {
  const bits = [];
  for (const byte of bytes) {
    for (let bit = 0; bit < 8; bit++) {
      bits.push((byte >> bit) & 1);
    }
  }
  return bits;
}

function makeTransmissionBits(packet) {
  const preamble = new Uint8Array(PREAMBLE_BYTES).fill(0x55);
  const sync = new Uint8Array(SYNC);
  const length = new Uint8Array(u32(packet.length));

  return [
    ...bytesToBits(preamble),
    ...bytesToBits(sync),
    ...bytesToBits(length),
    ...bytesToBits(packet)
  ];
}

// Create fax-like audio with a calling tone, an answering tone,
// then the actual changing FSK data tones.
function makeWav(bits, sampleRate = 48000) {
  const samplesPerBit = sampleRate / BAUD;
  const leadLength = Math.floor(sampleRate * 0.45);
  const gapLength = Math.floor(sampleRate * 0.12);
  const answerLength = Math.floor(sampleRate * 0.8);
  const dataLength = Math.ceil(bits.length * samplesPerBit);
  const tailLength = Math.floor(sampleRate * 0.2);

  const total = leadLength + gapLength + answerLength +
    gapLength + dataLength + tailLength;

  const samples = new Float32Array(total);
  let position = 0;

  function tone(frequency, count, amplitude = 0.55) {
    for (let i = 0; i < count; i++) {
      const fade = Math.min(1, i / 250, (count - i) / 250);
      samples[position++] =
        amplitude * Math.max(0, fade) *
        Math.sin(2 * Math.PI * frequency * i / sampleRate);
    }
  }

  function silence(count) {
    position += count;
  }

  tone(1100, leadLength);
  silence(gapLength);
  tone(2100, answerLength);
  silence(gapLength);

  const dataStart = position;

  for (let i = 0; i < bits.length; i++) {
    const start = dataStart + Math.floor(i * samplesPerBit);
    const end = Math.min(
      dataStart + dataLength,
      dataStart + Math.floor((i + 1) * samplesPerBit)
    );
    const frequency = bits[i] ? FREQ_ONE : FREQ_ZERO;

    for (let j = start; j < end; j++) {
      const local = j - start;
      const fade = Math.min(1, local / 5, (end - j) / 5);
      samples[j] = 0.55 * Math.max(0, fade) *
        Math.sin(2 * Math.PI * frequency * (j - dataStart) / sampleRate);
    }
  }

  const wav = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(wav);
  const write = (offset, text) => {
    for (let i = 0; i < text.length; i++) {
      view.setUint8(offset + i, text.charCodeAt(i));
    }
  };

  write(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  write(8, "WAVE");
  write(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  write(36, "data");
  view.setUint32(40, samples.length * 2, true);

  let offset = 44;
  for (const sample of samples) {
    const value = Math.max(-1, Math.min(1, sample));
    view.setInt16(offset, value < 0 ? value * 32768 : value * 32767, true);
    offset += 2;
  }

  return new Blob([wav], { type: "audio/wav" });
}

// Frequency energy detector
function frequencyEnergy(samples, start, count, frequency, sampleRate) {
  const omega = 2 * Math.PI * frequency / sampleRate;
  const coeff = 2 * Math.cos(omega);
  let q1 = 0;
  let q2 = 0;

  for (let i = 0; i < count; i++) {
    const sample = samples[start + i] || 0;
    const q0 = sample + coeff * q1 - q2;
    q2 = q1;
    q1 = q0;
  }

  return q1 * q1 + q2 * q2 - coeff * q1 * q2;
}

function decodeBits(samples, sampleRate, phase) {
  const spb = sampleRate / BAUD;
  const bits = [];
  const count = Math.floor((samples.length - phase) / spb);

  for (let i = 0; i < count; i++) {
    const start = Math.floor(phase + i * spb + spb * 0.1);
    const window = Math.max(8, Math.floor(spb * 0.8));

    if (start + window >= samples.length) break;

    const zero = frequencyEnergy(samples, start, window, FREQ_ZERO, sampleRate);
    const one = frequencyEnergy(samples, start, window, FREQ_ONE, sampleRate);

    bits.push(one > zero ? 1 : 0);
  }

  return bits;
}

function findSequence(bits, sequence) {
  outer:
  for (let i = 0; i <= bits.length - sequence.length; i++) {
    for (let j = 0; j < sequence.length; j++) {
      if (bits[i + j] !== sequence[j]) continue outer;
    }
    return i;
  }
  return -1;
}

function bitsToBytes(bits, start, byteCount) {
  const bytes = new Uint8Array(byteCount);

  for (let i = 0; i < byteCount; i++) {
    let value = 0;
    for (let bit = 0; bit < 8; bit++) {
      value |= (bits[start + i * 8 + bit] || 0) << bit;
    }
    bytes[i] = value;
  }

  return bytes;
}

function parseDecodedBits(bits) {
  const syncBits = bytesToBits(new Uint8Array(SYNC));
  const syncAt = findSequence(bits, syncBits);
  if (syncAt < 0) return null;

  const lengthStart = syncAt + syncBits.length;
  if (lengthStart + 32 > bits.length) return null;

  const lengthBytes = bitsToBytes(bits, lengthStart, 4);
  const packetLength = readU32(lengthBytes, 0);

  if (packetLength < 12 || packetLength > MAX_FILE_SIZE + 2048) {
    return null;
  }

  const packetStart = lengthStart + 32;
  const required = packetStart + packetLength * 8;
  if (required > bits.length) return null;

  const packet = bitsToBytes(bits, packetStart, packetLength);
  const storedCRC = readU32(packet, packet.length - 4);
  const actualCRC = crc32(packet.subarray(0, packet.length - 4));

  if (storedCRC !== actualCRC) return null;

  const metadataLength = packet[0] | (packet[1] << 8);
  let cursor = 2;

  if (metadataLength < 4 || cursor + metadataLength > packet.length - 4) {
    return null;
  }

  const nameLength = packet[cursor] | (packet[cursor + 1] << 8);
  cursor += 2;

  if (cursor + nameLength + 2 > packet.length - 4) return null;

  const decoder = new TextDecoder();
  const filename = decoder.decode(packet.subarray(cursor, cursor + nameLength));
  cursor += nameLength;

  const mimeLength = packet[cursor] | (packet[cursor + 1] << 8);
  cursor += 2;

  if (cursor + mimeLength > packet.length - 4) return null;

  const mime = decoder.decode(packet.subarray(cursor, cursor + mimeLength));
  cursor += mimeLength;

  const fileBytes = packet.slice(cursor, packet.length - 4);

  return { filename, mime, fileBytes };
}

function decodeSamples(samples, sampleRate) {
  const spb = sampleRate / BAUD;
  const phaseStep = Math.max(1, Math.floor(spb / 20));

  // Try different bit-clock alignments to compensate for when
  // the receiver starts recording at a different point in the signal.
  for (let phase = 0; phase < spb; phase += phaseStep) {
    const bits = decodeBits(samples, sampleRate, phase);
    const result = parseDecodedBits(bits);
    if (result) return result;
  }

  return null;
}

// SEND
$("fileInput").addEventListener("change", () => {
  selectedFile = $("fileInput").files[0] || null;
  preparedWav = null;
  $("playButton").disabled = true;
  $("downloadAudioButton").disabled = true;

  if (!selectedFile) {
    $("fileInformation").textContent = "No file selected.";
    return;
  }

  $("fileInformation").textContent =
    `${selectedFile.name} · ${selectedFile.size.toLocaleString()} bytes`;

  $("sendStatus").textContent = selectedFile.size > MAX_FILE_SIZE
    ? "File is too large for this prototype. Maximum: 64 KB."
    : "File selected. Ready to prepare.";
});

$("prepareButton").addEventListener("click", async () => {
  if (!selectedFile) {
    $("sendStatus").textContent = "Choose a file first.";
    return;
  }

  if (selectedFile.size > MAX_FILE_SIZE) {
    $("sendStatus").textContent = "File exceeds the 64 KB limit.";
    return;
  }

  try {
    $("prepareButton").disabled = true;
    $("sendStatus").textContent = "Encoding file data...";
    setProgress("sendProgress", 10);

    const bytes = new Uint8Array(await selectedFile.arrayBuffer());
    const packet = makePacket(bytes, selectedFile.name, selectedFile.type);
    const bits = makeTransmissionBits(packet);

    setProgress("sendProgress", 50);
    preparedWav = makeWav(bits);

    $("playButton").disabled = false;
    $("downloadAudioButton").disabled = false;
    $("sendStatus").textContent =
      `Ready. ${bits.length.toLocaleString()} data bits encoded.`;
    setProgress("sendProgress", 100);
    status("TRANSMISSION READY");
  } catch (error) {
    $("sendStatus").textContent = "Preparation error: " + error.message;
  } finally {
    $("prepareButton").disabled = false;
  }
});

$("playButton").addEventListener("click", async () => {
  if (!preparedWav) return;

  const url = URL.createObjectURL(preparedWav);
  const audio = new Audio(url);

  $("sendStatus").textContent = "Playing fax audio. Let it finish.";
  status("TRANSMITTING");

  audio.onended = () => {
    $("sendStatus").textContent = "Audio transmission finished.";
    status("SYSTEM READY");
    URL.revokeObjectURL(url);
  };

  audio.onerror = () => {
    $("sendStatus").textContent = "Audio playback failed.";
    status("PLAYBACK ERROR", false);
    URL.revokeObjectURL(url);
  };

  try {
    await audio.play();
  } catch (error) {
    $("sendStatus").textContent = "Playback error: " + error.message;
    status("PLAYBACK ERROR", false);
  }
});

$("downloadAudioButton").addEventListener("click", () => {
  if (!preparedWav) return;
  const url = URL.createObjectURL(preparedWav);
  const a = document.createElement("a");
  a.href = url;
  a.download = "voicefax-transmission.wav";
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
});

// RECEIVE: raw microphone PCM capture, not MediaRecorder/Opus.
async function startListening() {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error("Microphone access is unavailable. Use HTTPS.");
  }

  microphoneStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
      channelCount: 1
    }
  });

  microphoneContext = new (window.AudioContext || window.webkitAudioContext)();
  await microphoneContext.resume();

  const source = microphoneContext.createMediaStreamSource(microphoneStream);
  analyser = microphoneContext.createAnalyser();
  analyser.fftSize = 2048;
  source.connect(analyser);

  // ScriptProcessor captures uncompressed microphone samples.
  processor = microphoneContext.createScriptProcessor(4096, 1, 1);
  const mute = microphoneContext.createGain();
  mute.gain.value = 0;

  processor.onaudioprocess = event => {
    if (!recordingActive) return;
    const input = event.inputBuffer.getChannelData(0);
    recordingChunks.push(new Float32Array(input));
  };

  source.connect(processor);
  processor.connect(mute);
  mute.connect(microphoneContext.destination);

  recordingChunks = [];
  recordingActive = true;
  monitorMicrophone();

  $("recordButton").disabled = true;
  $("stopRecordButton").disabled = false;
  $("receiveStatus").textContent =
    `Listening at ${microphoneContext.sampleRate} Hz. Play the sender audio now.`;
  $("signalText").textContent = "Microphone is active.";
  status("MICROPHONE LISTENING");
}

function monitorMicrophone() {
  if (!recordingActive || !analyser) return;

  const values = new Float32Array(analyser.fftSize);
  analyser.getFloatTimeDomainData(values);

  let sum = 0;
  for (const value of values) sum += value * value;
  const rms = Math.sqrt(sum / values.length);
  const level = Math.min(100, rms * 500);

  $("signalBar").style.width = level + "%";
  $("signalText").textContent =
    `Input level: ${level.toFixed(1)}% · ${rms > 0.003 ? "Audio detected" : "Very quiet / no audio"}`;

  animationFrame = requestAnimationFrame(monitorMicrophone);
}

function stopMicrophone() {
  recordingActive = false;
  if (animationFrame) cancelAnimationFrame(animationFrame);

  if (processor) {
    processor.disconnect();
    processor.onaudioprocess = null;
    processor = null;
  }

  if (microphoneStream) {
    microphoneStream.getTracks().forEach(track => track.stop());
    microphoneStream = null;
  }

  if (microphoneContext) {
    microphoneContext.close();
    microphoneContext = null;
  }

  analyser = null;
}

$("recordButton").addEventListener("click", async () => {
  try {
    $("receiveStatus").textContent = "Requesting microphone permission...";
    await startListening();
  } catch (error) {
    $("receiveStatus").textContent = "Microphone error: " + error.message;
    $("signalText").textContent = "Microphone could not start.";
    $("recordButton").disabled = false;
    $("stopRecordButton").disabled = true;
    status("MICROPHONE ERROR", false);
  }
});

$("stopRecordButton").addEventListener("click", async () => {
  if (!recordingActive) return;

  $("receiveStatus").textContent = "Stopping microphone and decoding...";
  $("stopRecordButton").disabled = true;
  $("recordButton").disabled = false;
  setProgress("receiveProgress", 20);

  const sampleRate = microphoneContext.sampleRate;
  const totalLength = recordingChunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const samples = new Float32Array(totalLength);

  let offset = 0;
  for (const chunk of recordingChunks) {
    samples.set(chunk, offset);
    offset += chunk.length;
  }

  stopMicrophone();
  setProgress("receiveProgress", 50);

  $("receiveStatus").textContent =
    `Captured ${(samples.length / sampleRate).toFixed(1)} seconds. Searching for data...`;

  // Allow the browser to update the screen before the decode work.
  await new Promise(resolve => setTimeout(resolve, 50));

  try {
    const result = decodeSamples(samples, sampleRate);
    setProgress("receiveProgress", 100);

    if (!result) {
      $("receiveStatus").textContent =
        "No valid file packet found. Check that the sender audio played clearly and the entire transmission was recorded.";
      status("NO VALID PACKET", false);
      return;
    }

    showReceivedFile(result);
    $("receiveStatus").textContent = "File decoded and checksum verified.";
    status("FILE RECEIVED");
  } catch (error) {
    $("receiveStatus").textContent = "Decode error: " + error.message;
    status("DECODE ERROR", false);
  }
});

function showReceivedFile(result) {
  if (receivedUrl) URL.revokeObjectURL(receivedUrl);

  const blob = new Blob([result.fileBytes], {
    type: result.mime || "application/octet-stream"
  });

  receivedUrl = URL.createObjectURL(blob);
  $("receivedName").textContent = "Filename: " + result.filename;
  $("receivedDetails").textContent =
    `Size: ${result.fileBytes.length.toLocaleString()} bytes · CRC verified`;

  $("downloadLink").href = receivedUrl;
  $("downloadLink").download = result.filename;
  $("receivedResult").hidden = false;

  const image = $("imagePreview");
  if (result.mime.startsWith("image/")) {
    image.src = receivedUrl;
    image.hidden = false;
  } else {
    image.hidden = true;
    image.removeAttribute("src");
  }
}

// SELF-TEST
$("selfTestButton").addEventListener("click", async () => {
  $("selfTestButton").disabled = true;
  $("testStatus").textContent = "Building test transmission...";

  try {
    const original = new TextEncoder().encode(
      "VOICEFAX AUDIO 1.2 SELF TEST — actual data packet."
    );

    const packet = makePacket(original, "voicefax-test.txt", "text/plain");
    const bits = makeTransmissionBits(packet);
    const wav = makeWav(bits);

    $("testStatus").textContent = "Decoding generated audio...";
    const context = new (window.AudioContext || window.webkitAudioContext)();
    const buffer = await context.decodeAudioData(await wav.arrayBuffer());
    const samples = buffer.getChannelData(0);
    const result = decodeSamples(samples, buffer.sampleRate);
    await context.close();

    if (!result) throw new Error("No valid packet found in self-test.");

    const matches = result.fileBytes.length === original.length &&
      result.fileBytes.every((byte, index) => byte === original[index]);

    if (!matches) throw new Error("Recovered data did not match original.");

    $("testStatus").textContent =
      "SELF-TEST PASSED. The test file was encoded, decoded, and verified.";
    status("SELF-TEST PASSED");
  } catch (error) {
    $("testStatus").textContent = "SELF-TEST FAILED: " + error.message;
    status("SELF-TEST FAILED", false);
  } finally {
    $("selfTestButton").disabled = false;
  }
});
