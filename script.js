
"use strict";

/*
 * VoiceFax Audio 1.3
 * Experimental acoustic file-transfer protocol.
 * This is NOT a certified T.30 fax modem.
 */

const BAUD = 1200;
const FREQ_ZERO = 1200;
const FREQ_ONE = 2200;
const MAX_FILE_SIZE = 256 * 1024;
const PREAMBLE_BYTES = 160;
const SYNC = [0xD3, 0x91, 0xC5, 0xA7];
const $ = id => document.getElementById(id);

let selectedFile = null;
let preparedWav = null;
let sendAudio = null;
let sendUrl = null;

let microphoneContext = null;
let microphoneStream = null;
let processor = null;
let analyser = null;
let recordingChunks = [];
let recordingActive = false;
let animationFrame = null;
let receivedUrl = null;
let recordingStartedAt = 0;

function status(message, active = true) {
  $("mainStatus").textContent = message;
  $("statusLight").style.background = active ? "#65db8b" : "#e4a35c";
  $("statusLight").style.boxShadow = active ? "0 0 9px #65db8b" : "0 0 9px #e4a35c";
}

function setProgress(id, value) {
  $(id).style.width = Math.max(0, Math.min(100, value)) + "%";
}

function formatTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return "—";
  const s = Math.ceil(seconds);
  return s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`;
}

/* TABS */
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

/* MODE SELECTOR */
$("modeSelect").addEventListener("change", () => {
  $("modeNote").textContent = $("modeSelect").value === "fax"
    ? "Adds fax calling and answer tones before the experimental data transfer. This does not provide telephone-line T.30 compatibility."
    : "Transfers files between VoiceFax devices using speaker-to-microphone audio.";

  preparedWav = null;
  $("playButton").disabled = true;
  $("downloadAudioButton").disabled = true;
});

/* CRC32 */
const crcTable = (() => {
  const table = new Uint32Array(256);

  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++)
      c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    table[n] = c >>> 0;
  }

  return table;
})();

function crc32(bytes) {
  let crc = 0xFFFFFFFF;

  for (const byte of bytes)
    crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8);

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

/* FILE PACKET */
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
  const bits = new Uint8Array(bytes.length * 8);
  let p = 0;

  for (const byte of bytes)
    for (let i = 0; i < 8; i++)
      bits[p++] = (byte >> i) & 1;

  return bits;
}

function makeTransmissionBits(packet) {
  const preamble = new Uint8Array(PREAMBLE_BYTES).fill(0x55);

  return new Uint8Array([
    ...bytesToBits(preamble),
    ...bytesToBits(new Uint8Array(SYNC)),
    ...bytesToBits(new Uint8Array(u32(packet.length))),
    ...bytesToBits(packet)
  ]);
}

/* AUDIO GENERATOR */
function makeWav(bits, sampleRate = 48000, faxLead = false) {
  const spb = sampleRate / BAUD;

  const lead = Math.floor(sampleRate * (faxLead ? 1.8 : 0.45));
  const gap = Math.floor(sampleRate * 0.12);
  const answer = Math.floor(sampleRate * (faxLead ? 2.6 : 0.45));
  const dataLength = Math.ceil(bits.length * spb);
  const tail = Math.floor(sampleRate * 0.45);

  const samples = new Float32Array(
    lead + gap + answer + gap + dataLength + tail
  );

  let position = 0;

  function tone(freq, count, amplitude = 0.48) {
    for (let i = 0; i < count; i++) {
      const fade = Math.min(1, i / 240, (count - i) / 240);

      samples[position++] =
        amplitude * Math.max(0, fade) *
        Math.sin(2 * Math.PI * freq * i / sampleRate);
    }
  }

  if (faxLead) {
    const pulse = Math.floor(sampleRate * 0.5);
    const silence = Math.floor(sampleRate * 3.0);

    for (let t = 0; t < lead; t += pulse + silence) {
      const count = Math.min(pulse, lead - t);

      for (let i = 0; i < count; i++)
        samples[t + i] = 0.42 *
          Math.sin(2 * Math.PI * 1100 * i / sampleRate);
    }

    position = lead;
  } else {
    tone(1100, lead);
  }

  position += gap;
  tone(2100, answer);
  position += gap;

  const dataStart = position;

  for (let i = 0; i < bits.length; i++) {
    const start = Math.floor(i * spb);
    const end = Math.min(dataLength, Math.floor((i + 1) * spb));
    const freq = bits[i] ? FREQ_ONE : FREQ_ZERO;

    for (let j = start; j < end; j++) {
      const edge = Math.min(1, j / 5, (end - j) / 5);

      samples[dataStart + j] =
        0.48 * Math.max(0, edge) *
        Math.sin(2 * Math.PI * freq * j / sampleRate);
    }
  }

  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);

  function writeText(offset, text) {
    for (let i = 0; i < text.length; i++)
      view.setUint8(offset + i, text.charCodeAt(i));
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

/* FREQUENCY DETECTION */
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
    const start = Math.floor(phase + i * spb + spb * 0.08);
    const window = Math.floor(spb * 0.84);

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

  for (let i = 0; i < count; i++)
    for (let b = 0; b < 8; b++)
      bytes[i] |= (bits[start + i * 8 + b] || 0) << b;

  return bytes;
}

/* PACKET DECODER */
function parseDecodedBits(bits) {
  const syncBits = bytesToBits(new Uint8Array(SYNC));
  const syncAt = findSequence(bits, syncBits);

  if (syncAt < 0) return null;

  const lengthAt = syncAt + syncBits.length;

  if (lengthAt + 32 > bits.length) return null;

  const packetLength = readU32(
    bitsToBytes(bits, lengthAt, 4), 0
  );

  if (packetLength < 12 || packetLength > MAX_FILE_SIZE + 2048)
    return null;

  const packetAt = lengthAt + 32;

  if (packetAt + packetLength * 8 > bits.length)
    return null;

  const packet = bitsToBytes(bits, packetAt, packetLength);

  const storedCRC = readU32(packet, packet.length - 4);
  const actualCRC = crc32(packet.subarray(0, packet.length - 4));

  if (storedCRC !== actualCRC) return null;

  const metadataLength = packet[0] | (packet[1] << 8);
  let cursor = 2;

  if (metadataLength < 4 ||
      cursor + metadataLength > packet.length - 4)
    return null;

  const decoder = new TextDecoder();

  const nameLength = packet[cursor] | (packet[cursor + 1] << 8);
  cursor += 2;

  if (cursor + nameLength + 2 > packet.length - 4)
    return null;

  const filename = decoder.decode(
    packet.subarray(cursor, cursor + nameLength)
  );

  cursor += nameLength;

  const mimeLength = packet[cursor] | (packet[cursor + 1] << 8);
  cursor += 2;

  if (cursor + mimeLength > packet.length - 4)
    return null;

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

/* TIMING SEARCH */
function decodeSamples(samples, sampleRate) {
  const candidates = [
    1194, 1196, 1198, 1200, 1202, 1204, 1206
  ];

  for (const baud of candidates) {
    const spb = sampleRate / baud;
    const step = Math.max(1, Math.floor(spb / 24));

    for (let phase = 0; phase < spb; phase += step) {
      const bits = decodeBits(samples, sampleRate, phase, baud);
      const result = parseDecodedBits(bits);

      if (result) return result;
    }
  }

  return null;
}

/* SENDING */
$("fileInput").addEventListener("change", () => {
  selectedFile = $("fileInput").files[0] || null;
  preparedWav = null;

  $("playButton").disabled = true;
  $("downloadAudioButton").disabled = true;
  setProgress("sendProgress", 0);

  if (!selectedFile) {
    $("fileInformation").textContent = "No file selected.";
    return;
  }

  $("fileInformation").textContent =
    `${selectedFile.name} · ${selectedFile.size.toLocaleString()} bytes`;

  $("sendStatus").textContent =
    selectedFile.size > MAX_FILE_SIZE
      ? "File too large. Maximum is 256 KB."
      : "File selected. Ready to prepare.";
});

$("prepareButton").addEventListener("click", async () => {
  if (!selectedFile) {
    $("sendStatus").textContent = "Choose a file first.";
    return;
  }

  if (selectedFile.size > MAX_FILE_SIZE) {
    $("sendStatus").textContent = "File exceeds the 256 KB limit.";
    return;
  }

  try {
    $("prepareButton").disabled = true;
    $("sendStatus").textContent = "Reading and encoding file...";
    setProgress("sendProgress", 8);

    const bytes = new Uint8Array(await selectedFile.arrayBuffer());
    const packet = makePacket(bytes, selectedFile.name, selectedFile.type);
    const bits = makeTransmissionBits(packet);

    setProgress("sendProgress", 35);

    preparedWav = makeWav(
      bits,
      48000,
      $("modeSelect").value === "fax"
    );

    const seconds = preparedWav.size / (48000 * 2);

    $("playButton").disabled = false;
    $("downloadAudioButton").disabled = false;

    setProgress("sendProgress", 100);

    $("sendStatus").textContent =
      `Ready. ${bits.length.toLocaleString()} bits at ${BAUD} baud.`;

    $("sendDetails").textContent =
      `Approximate audio duration: ${formatTime(seconds)} · WAV size: ${(preparedWav.size / 1024).toFixed(1)} KB`;

    status("TRANSMISSION READY");

  } catch (error) {
    $("sendStatus").textContent =
      "Preparation error: " + error.message;

    status("PREPARATION ERROR", false);

  } finally {
    $("prepareButton").disabled = false;
  }
});

$("playButton").addEventListener("click", async () => {
  if (!preparedWav) return;

  if (sendAudio && !sendAudio.paused) return;

  if (sendUrl) URL.revokeObjectURL(sendUrl);

  sendUrl = URL.createObjectURL(preparedWav);
  sendAudio = new Audio(sendUrl);
  sendAudio.preload = "auto";

  $("playButton").disabled = true;
  $("stopSendButton").disabled = false;

  $("sendStatus").textContent =
    "Transmitting audio. Receiver can listen at the same time.";

  status("TRANSMITTING");

  sendAudio.ontimeupdate = () => {
    const percent = sendAudio.duration
      ? sendAudio.currentTime / sendAudio.duration * 100
      : 0;

    setProgress("sendProgress", percent);

    $("sendDetails").textContent =
      `Sent ${percent.toFixed(1)}% · ${formatTime(sendAudio.duration - sendAudio.currentTime)} remaining`;
  };

  sendAudio.onended = () => finishSending(false);

  sendAudio.onerror = () => {
    $("sendStatus").textContent = "Audio playback failed.";
    finishSending(true);
  };

  try {
    await sendAudio.play();
  } catch (error) {
    $("sendStatus").textContent =
      "Playback error: " + error.message;

    finishSending(true);
  }
});

function finishSending(stopped) {
  if (sendAudio) {
    sendAudio.onended = null;
    sendAudio.ontimeupdate = null;
    sendAudio.pause();
    sendAudio = null;
  }

  $("playButton").disabled = false;
  $("stopSendButton").disabled = true;

  if (!stopped) {
    setProgress("sendProgress", 100);
    $("sendStatus").textContent = "Transmission audio finished.";

    status(
      recordingActive
        ? "TRANSMITTED · RECEIVER LISTENING"
        : "SYSTEM READY"
    );

  } else {
    $("sendStatus").textContent = "Transmission stopped.";
    status("TRANSMISSION STOPPED", false);
  }
}

$("stopSendButton").addEventListener("click", () => {
  finishSending(true);
});

$("downloadAudioButton").addEventListener("click", () => {
  if (!preparedWav) return;

  const url = URL.createObjectURL(preparedWav);
  const a = document.createElement("a");

  a.href = url;
  a.download = "voicefax-transmission.wav";
  a.click();

  setTimeout(() => URL.revokeObjectURL(url), 5000);
});

/* MICROPHONE INPUT */
async function startListening() {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error("Microphone unavailable. Use HTTPS.");
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
    if (recordingActive) {
      recordingChunks.push(
        new Float32Array(event.inputBuffer.getChannelData(0))
      );
    }
  };

  source.connect(processor);
  processor.connect(mute);
  mute.connect(microphoneContext.destination);

  recordingChunks = [];
  recordingActive = true;
  recordingStartedAt = performance.now();

  monitorMicrophone();

  $("recordButton").disabled = true;
  $("stopRecordButton").disabled = false;

  $("receiveStatus").textContent =
    `Listening at ${microphoneContext.sampleRate} Hz. Start the sender now.`;

  $("signalText").textContent = "Microphone is active.";

  status(sendAudio ? "SENDING + RECEIVING" : "MICROPHONE LISTENING");
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

  const elapsed =
    (performance.now() - recordingStartedAt) / 1000;

  $("signalText").textContent =
    `Input: ${level.toFixed(1)}% · ${rms > 0.003 ? "Audio detected" : "Quiet"} · ${formatTime(elapsed)} recorded`;

  animationFrame = requestAnimationFrame(monitorMicrophone);
}

function stopMicrophone() {
  recordingActive = false;

  if (animationFrame) cancelAnimationFrame(animationFrame);
  animationFrame = null;

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

/* RECEIVING */
$("recordButton").addEventListener("click", async () => {
  try {
    $("receiveStatus").textContent =
      "Requesting microphone permission...";

    await startListening();

  } catch (error) {
    $("receiveStatus").textContent =
      "Microphone error: " + error.message;

    $("recordButton").disabled = false;
    $("stopRecordButton").disabled = true;

    status("MICROPHONE ERROR", false);
  }
});

$("stopRecordButton").addEventListener("click", async () => {
  if (!recordingActive || !microphoneContext) return;

  $("receiveStatus").textContent =
    "Stopping microphone and decoding...";

  $("stopRecordButton").disabled = true;

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

  $("recordButton").disabled = false;
  setProgress("receiveProgress", 15);

  $("receiveStatus").textContent =
    `Captured ${(samples.length / sampleRate).toFixed(1)} seconds. Searching for a complete packet...`;

  await new Promise(resolve => setTimeout(resolve, 30));

  try {
    const result = decodeSamples(samples, sampleRate);

    if (!result) {
      setProgress("receiveProgress", 0);

      $("receiveStatus").textContent =
        "No valid packet found. Record the entire transmission, keep devices close, reduce background noise, and try again.";

      status("NO VALID PACKET", false);
      return;
    }

    setProgress("receiveProgress", 100);
    showReceivedFile(result);

    $("receiveStatus").textContent =
      "File decoded successfully. CRC checksum verified.";

    status("FILE RECEIVED");

  } catch (error) {
    $("receiveStatus").textContent =
      "Decode error: " + error.message;

    status("DECODE ERROR", false);
  }
});

/* DISPLAY RECEIVED FILE */
function showReceivedFile(result) {
  if (receivedUrl) URL.revokeObjectURL(receivedUrl);

  const blob = new Blob([result.fileBytes], {
    type: result.mime || "application/octet-stream"
  });

  receivedUrl = URL.createObjectURL(blob);

  $("receivedName").textContent =
    "Filename: " + result.filename;

  $("receivedDetails").textContent =
    `Size: ${result.fileBytes.length.toLocaleString()} bytes · CRC verified`;

  $("downloadLink").href = receivedUrl;
  $("downloadLink").download = result.filename;

  $("receivedResult").hidden = false;

  const image = $("imagePreview");

  if ((result.mime || "").startsWith("image/")) {
    image.src = receivedUrl;
    image.hidden = false;
  } else {
    image.hidden = true;
    image.removeAttribute("src");
  }
}

/* SELF-TEST */
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
    const wav = makeWav(bits, 48000, false);

    $("testStatus").textContent =
      "Decoding generated audio...";

    const context = new (
      window.AudioContext || window.webkitAudioContext
    )();

    const buffer = await context.decodeAudioData(
      await wav.arrayBuffer()
    );

    const result = decodeSamples(
      buffer.getChannelData(0),
      buffer.sampleRate
    );

    await context.close();

    if (!result) throw new Error("No valid packet found in self-test.");

    const matches =
      result.fileBytes.length === original.length &&
      result.fileBytes.every(
        (byte, index) => byte === original[index]
      );

    if (!matches) {
      throw new Error("Recovered data did not match original.");
    }

    $("testStatus").textContent =
      "SELF-TEST PASSED. Packet encoded, decoded, and verified.";

    status("SELF-TEST PASSED");

  } catch (error) {
    $("testStatus").textContent =
      "SELF-TEST FAILED: " + error.message;

    status("SELF-TEST FAILED", false);

  } finally {
    $("selfTestButton").disabled = false;
  }
});

window.addEventListener("beforeunload", () => {
  stopMicrophone();

  if (sendUrl) URL.revokeObjectURL(sendUrl);
  if (receivedUrl) URL.revokeObjectURL(receivedUrl);
});
