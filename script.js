
"use strict";

const BAUD = 300;
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
    ? "0 0 9px #65db8b" : "0 0 9px #e4a35c";
}

function setProgress(id, value) {
  $(id).style.width = Math.max(0, Math.min(100, value)) + "%";
}

// TABS
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
    crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8);
  }

  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function u16(n) {
  return [n & 255, (n >>> 8) & 255];
}

function u32(n) {
  return [
    n & 255,
    (n >>> 8) & 255,
    (n >>> 16) & 255,
    (n >>> 24) & 255
  ];
}

function readU32(bytes, i) {
  return (
    bytes[i] |
    (bytes[i + 1] << 8) |
    (bytes[i + 2] << 16) |
    (bytes[i + 3] << 24)
  ) >>> 0;
}

// FILE PACKET
function makePacket(fileBytes, filename, mime) {
  const enc = new TextEncoder();
  const name = enc.encode(filename);
  const type = enc.encode(mime || "application/octet-stream");

  const metadata = new Uint8Array([
    ...u16(name.length),
    ...name,
    ...u16(type.length),
    ...type
  ]);

  const body = new Uint8Array([
    ...u16(metadata.length),
    ...metadata,
    ...fileBytes
  ]);

  return new Uint8Array([
    ...body,
    ...u32(crc32(body))
  ]);
}

function bytesToBits(bytes) {
  const bits = [];

  for (const byte of bytes) {
    for (let i = 0; i < 8; i++) {
      bits.push((byte >> i) & 1);
    }
  }

  return bits;
}

function makeTransmissionBits(packet) {
  const preamble = new Uint8Array(PREAMBLE_BYTES).fill(0x55);

  return [
    ...bytesToBits(preamble),
    ...bytesToBits(new Uint8Array(SYNC)),
    ...bytesToBits(new Uint8Array(u32(packet.length))),
    ...bytesToBits(packet)
  ];
}

// AUDIO GENERATOR
function makeWav(bits, sampleRate = 48000) {
  const spb = sampleRate / BAUD;

  const lead = Math.floor(sampleRate * 0.5);
  const gap = Math.floor(sampleRate * 0.15);
  const answer = Math.floor(sampleRate * 1.0);
  const dataLength = Math.ceil(bits.length * spb);
  const tail = Math.floor(sampleRate * 0.3);

  const samples = new Float32Array(
    lead + gap + answer + gap + dataLength + tail
  );

  let position = 0;

  function tone(freq, count) {
    for (let i = 0; i < count; i++) {
      const fade = Math.min(1, i / 300, (count - i) / 300);

      samples[position++] =
        0.55 * Math.max(0, fade) *
        Math.sin(2 * Math.PI * freq * i / sampleRate);
    }
  }

  tone(1100, lead);
  position += gap;
  tone(2100, answer);
  position += gap;

  const dataStart = position;

  for (let i = 0; i < bits.length; i++) {
    const start = Math.floor(i * spb);
    const end = Math.min(dataLength, Math.floor((i + 1) * spb));
    const freq = bits[i] ? FREQ_ONE : FREQ_ZERO;

    for (let j = start; j < end; j++) {
      const fade = Math.min(1, j / 8, (end - j) / 8);

      samples[dataStart + j] =
        0.55 * Math.max(0, fade) *
        Math.sin(2 * Math.PI * freq * j / sampleRate);
    }
  }

  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);

  function writeText(offset, text) {
    for (let i = 0; i < text.length; i++) {
      view.setUint8(offset + i, text.charCodeAt(i));
    }
  }

  writeText(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  writeText(8, "WAVE");
  writeText(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeText(36, "data");
  view.setUint32(40, samples.length * 2, true);

  let offset = 44;

  for (const sample of samples) {
    const value = Math.max(-1, Math.min(1, sample));

    view.setInt16(
      offset,
      value < 0 ? value * 32768 : value * 32767,
      true
    );

    offset += 2;
  }

  return new Blob([buffer], { type: "audio/wav" });
}

// FREQUENCY DETECTION
function frequencyEnergy(samples, start, count, frequency, sampleRate) {
  const omega = 2 * Math.PI * frequency / sampleRate;
  const coeff = 2 * Math.cos(omega);

  let q1 = 0;
  let q2 = 0;

  for (let i = 0; i < count; i++) {
    const q0 = (samples[start + i] || 0) + coeff * q1 - q2;
    q2 = q1;
    q1 = q0;
  }

  return q1 * q1 + q2 * q2 - coeff * q1 * q2;
}

function decodeBits(samples, sampleRate, phase, baud) {
  const spb = sampleRate / baud;
  const bits = [];
  const total = Math.floor((samples.length - phase) / spb);

  for (let i = 0; i < total; i++) {
    const start = Math.floor(phase + i * spb + spb * 0.1);
    const window = Math.floor(spb * 0.8);

    if (start + window >= samples.length) break;

    const zero = frequencyEnergy(
      samples, start, window, FREQ_ZERO, sampleRate
    );

    const one = frequencyEnergy(
      samples, start, window, FREQ_ONE, sampleRate
    );

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

function bitsToBytes(bits, start, count) {
  const bytes = new Uint8Array(count);

  for (let i = 0; i < count; i++) {
    for (let b = 0; b < 8; b++) {
      bytes[i] |= (bits[start + i * 8 + b] || 0) << b;
    }
  }

  return bytes;
}

// PACKET DECODER
function parseDecodedBits(bits) {
  const syncBits = bytesToBits(new Uint8Array(SYNC));
  const syncAt = findSequence(bits, syncBits);

  if (syncAt < 0) return null;

  const lengthAt = syncAt + syncBits.length;

  if (lengthAt + 32 > bits.length) return null;

  const lengthBytes = bitsToBytes(bits, lengthAt, 4);
  const packetLength = readU32(lengthBytes, 0);

  if (packetLength < 12 || packetLength > MAX_FILE_SIZE + 2048) {
    return null;
  }

  const packetAt = lengthAt + 32;

  if (packetAt + packetLength * 8 > bits.length) {
    return null;
  }

  const packet = bitsToBytes(bits, packetAt, packetLength);

  const storedCRC = readU32(packet, packet.length - 4);
  const actualCRC = crc32(packet.subarray(0, packet.length - 4));

  if (storedCRC !== actualCRC) return null;

  const metadataLength = packet[0] | (packet[1] << 8);
  let cursor = 2;

  if (metadataLength < 4 || cursor + metadataLength > packet.length - 4) {
    return null;
  }

  const decoder = new TextDecoder();

  const nameLength = packet[cursor] | (packet[cursor + 1] << 8);
  cursor += 2;

  if (cursor + nameLength + 2 > packet.length - 4) return null;

  const filename = decoder.decode(
    packet.subarray(cursor, cursor + nameLength)
  );

  cursor += nameLength;

  const mimeLength = packet[cursor] | (packet[cursor + 1] << 8);
  cursor += 2;

  if (cursor + mimeLength > packet.length - 4) return null;

  const mime = decoder.decode(
    packet.subarray(cursor, cursor + mimeLength)
  );

  cursor += mimeLength;

  return {
    filename,
    mime,
    fileBytes: packet.slice(cursor, packet.length - 4)
  };
}

// TIMING SEARCH
function decodeSamples(samples, sampleRate) {
  const baudCandidates = [297, 298, 299, 300, 301, 302, 303];

  for (const baud of baudCandidates) {
    const spb = sampleRate / baud;
    const step = Math.max(1, Math.floor(spb / 20));

    for (let phase = 0; phase < spb; phase += step) {
      const bits = decodeBits(samples, sampleRate, phase, baud);
      const result = parseDecodedBits(bits);

      if (result) return result;
    }
  }

  return null;
}

// SENDING
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

  $("sendStatus").textContent =
    selectedFile.size > MAX_FILE_SIZE
      ? "File is too large. Maximum: 64 KB."
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
      `Ready. ${bits.length.toLocaleString()} data bits encoded at ${BAUD} baud.`;

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
    URL.revokeObjectURL(url);
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

// MICROPHONE INPUT
async function startListening() {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error("Microphone unavailable. Open the site over HTTPS.");
  }

  microphoneStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
      channelCount: 1
    }
  });

  microphoneContext = new (
    window.AudioContext || window.webkitAudioContext
  )();

  await microphoneContext.resume();

  const source = microphoneContext.createMediaStreamSource(
    microphoneStream
  );

  analyser = microphoneContext.createAnalyser();
  analyser.fftSize = 2048;

  source.connect(analyser);

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
    `Listening at ${microphoneContext.sampleRate} Hz. Play sender audio now.`;

  $("signalText").textContent = "Microphone is active.";

  status("MICROPHONE LISTENING");
}

function monitorMicrophone() {
  if (!recordingActive || !analyser) return;

  const values = new Float32Array(analyser.fftSize);
  analyser.getFloatTimeDomainData(values);

  let sum = 0;

  for (const value of values) {
    sum += value * value;
  }

  const rms = Math.sqrt(sum / values.length);
  const level = Math.min(100, rms * 500);

  $("signalBar").style.width = level + "%";

  $("signalText").textContent =
    `Input level: ${level.toFixed(1)}% · ${
      rms > 0.003 ? "Audio detected" : "Very quiet / no audio"
    }`;

  animationFrame = requestAnimationFrame(monitorMicrophone);
}

function stopMicrophone() {
  recordingActive = false;

  if (animationFrame) {
    cancelAnimationFrame(animationFrame);
    animationFrame = null;
  }

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

// START RECEIVING
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

// STOP AND DECODE
$("stopRecordButton").addEventListener("click", async () => {
  if (!recordingActive) return;

  $("receiveStatus").textContent = "Stopping microphone and decoding...";
  $("stopRecordButton").disabled = true;
  $("recordButton").disabled = false;

  setProgress("receiveProgress", 20);

  const sampleRate = microphoneContext.sampleRate;

  const totalLength = recordingChunks.reduce(
    (sum, chunk) => sum + chunk.length, 0
  );

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

  await new Promise(resolve => setTimeout(resolve, 50));

  try {
    const result = decodeSamples(samples, sampleRate);

    setProgress("receiveProgress", 100);

    if (!result) {
      $("receiveStatus").textContent =
        "No valid packet found. The audio was captured, but the data could not be recovered. Try playing the audio louder and recording the complete transmission.";

      status("NO VALID PACKET", false);
      return;
    }

    showReceivedFile(result);

    $("receiveStatus").textContent =
      "File decoded successfully. Checksum verified.";

    status("FILE RECEIVED");

  } catch (error) {
    $("receiveStatus").textContent = "Decode error: " + error.message;
    status("DECODE ERROR", false);
  }
});

// DISPLAY RECEIVED FILE
function showReceivedFile(result) {
  if (receivedUrl) {
    URL.revokeObjectURL(receivedUrl);
  }

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
      "VOICEFAX AUDIO 1.3 SELF TEST - actual data packet."
    );

    const packet = makePacket(
      original,
      "voicefax-test.txt",
      "text/plain"
    );

    const bits = makeTransmissionBits(packet);
    const wav = makeWav(bits);

    $("testStatus").textContent = "Decoding generated audio...";

    const context = new (
      window.AudioContext || window.webkitAudioContext
    )();

    const buffer = await context.decodeAudioData(
      await wav.arrayBuffer()
    );

    const samples = buffer.getChannelData(0);
    const result = decodeSamples(samples, buffer.sampleRate);

    await context.close();

    if (!result) {
      throw new Error("No valid packet found in self-test.");
    }

    const matches =
      result.fileBytes.length === original.length &&
      result.fileBytes.every((byte, index) => byte === original[index]);

    if (!matches) {
      throw new Error("Recovered data did not match original.");
    }

    $("testStatus").textContent =
      "SELF-TEST PASSED. The test file was encoded, decoded, and verified.";

    status("SELF-TEST PASSED");

  } catch (error) {
    $("testStatus").textContent =
      "SELF-TEST FAILED: " + error.message;

    status("SELF-TEST FAILED", false);

  } finally {
    $("selfTestButton").disabled = false;
  }
});
