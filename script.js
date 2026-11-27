
/* VoiceFax — script.js
   Part 1 of 2
   Paste Part 2 directly after this code.
*/

"use strict";

const $ = (id) => document.getElementById(id);

const fileInput = $("fileInput");
const prepareBtn = $("prepareBtn");
const transmitBtn = $("transmitBtn");
const receiveBtn = $("receiveBtn");
const stopBtn = $("stopBtn");
const progressBar = $("progressBar");
const progressText = $("progressText");
const statusText = $("statusText");
const receivedArea = $("receivedArea");

const SAMPLE_RATE = 8000;
const SYMBOL_RATE = 100;
const SYMBOL_SECONDS = 1 / SYMBOL_RATE;
const SAMPLES_PER_SYMBOL = SAMPLE_RATE / SYMBOL_RATE;
const TONES = Array.from({ length: 8 }, (_, i) => 1500 + i * 200);
const PREAMBLE_HZ = 1100;
const PREAMBLE_SECONDS = 0.8;
const GAP_SECONDS = 0.15;
const MAX_FILE_BYTES = 2 * 1024 * 1024;

let preparedFile = null;
let preparedBytes = null;
let audioContext = null;
let activeSource = null;
let micStream = null;
let recorder = null;
let recordingChunks = [];
let recording = false;
let stopRequested = false;

function setStatus(message) {
  if (statusText) statusText.textContent = message;
}

function setProgress(value, message) {
  const percent = Math.max(0, Math.min(100, value));
  if (progressBar) {
    progressBar.style.width = percent + "%";
    progressBar.setAttribute("aria-valuenow", String(percent));
  }
  if (progressText) {
    progressText.textContent = message || Math.round(percent) + "%";
  }
}

function setButtonEnabled(button, enabled) {
  if (button) button.disabled = !enabled;
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    crc ^= bytes[i];
    for (let j = 0; j < 8; j++) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function uint32Bytes(value) {
  return new Uint8Array([
    value & 255,
    (value >>> 8) & 255,
    (value >>> 16) & 255,
    (value >>> 24) & 255
  ]);
}

function readUint32(bytes, offset) {
  return (
    bytes[offset] |
    (bytes[offset + 1] << 8) |
    (bytes[offset + 2] << 16) |
    (bytes[offset + 3] << 24)
  ) >>> 0;
}

function concatBytes(...arrays) {
  const length = arrays.reduce((sum, a) => sum + a.length, 0);
  const result = new Uint8Array(length);
  let offset = 0;
  for (const array of arrays) {
    result.set(array, offset);
    offset += array.length;
  }
  return result;
}

function bytesToSymbols(bytes) {
  const symbols = [];
  let buffer = 0;
  let bits = 0;

  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;

    while (bits >= 3) {
      bits -= 3;
      symbols.push((buffer >>> bits) & 7);
    }
  }

  if (bits > 0) {
    symbols.push((buffer << (3 - bits)) & 7);
  }

  return symbols;
}

function symbolsToBytes(symbols, byteLength) {
  const output = new Uint8Array(byteLength);
  let buffer = 0;
  let bits = 0;
  let index = 0;

  for (const symbol of symbols) {
    buffer = (buffer << 3) | (symbol & 7);
    bits += 3;

    while (bits >= 8 && index < byteLength) {
      bits -= 8;
      output[index++] = (buffer >>> bits) & 255;
    }

    if (index >= byteLength) break;
  }

  if (index !== byteLength) {
    throw new Error("The received data is incomplete.");
  }

  return output;
}

function makeWav(samples, sampleRate) {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);

  function writeString(offset, value) {
    for (let i = 0; i < value.length; i++) {
      view.setUint8(offset + i, value.charCodeAt(i));
    }
  }

  writeString(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  writeString(8, "WAVE");
  writeString(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeString(36, "data");
  view.setUint32(40, samples.length * 2, true);

  for (let i = 0; i < samples.length; i++) {
    const sample = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(44 + i * 2, sample * 32767, true);
  }

  return new Blob([buffer], { type: "audio/wav" });
}

function addTone(samples, frequency, seconds, amplitude = 0.65) {
  const count = Math.round(SAMPLE_RATE * seconds);
  const start = samples.length;

  for (let i = 0; i < count; i++) {
    const fade = Math.min(1, i / 80, (count - i) / 80);
    samples.push(
      Math.sin(2 * Math.PI * frequency * i / SAMPLE_RATE) *
      amplitude * Math.max(0, fade)
    );
  }

  return start;
}

function addSilence(samples, seconds) {
  const count = Math.round(SAMPLE_RATE * seconds);
  for (let i = 0; i < count; i++) samples.push(0);
}

function buildTransmission(bytes) {
  const symbols = bytesToSymbols(bytes);
  const samples = [];

  addTone(samples, 1000, 0.25, 0.55);
  addSilence(samples, 0.08);
  addTone(samples, PREAMBLE_HZ, PREAMBLE_SECONDS, 0.7);
  addSilence(samples, GAP_SECONDS);

  for (let i = 0; i < symbols.length; i++) {
    addTone(samples, TONES[symbols[i]], SYMBOL_SECONDS, 0.65);

    if (i % 1000 === 0) {
      setProgress(
        15 + (i / Math.max(1, symbols.length)) * 80,
        "Preparing audio… " + Math.round(i / symbols.length * 100) + "%"
      );
    }
  }

  addSilence(samples, 0.2);
  return makeWav(Float32Array.from(samples), SAMPLE_RATE);
}

async function prepareSelectedFile() {
  if (!fileInput || !fileInput.files || !fileInput.files[0]) {
    setStatus("Choose a photo or PDF first.");
    return;
  }

  const file = fileInput.files[0];
  setProgress(0, "Preparing file…");
  setStatus("Preparing " + file.name);

  try {
    let outputBlob = file;

    if (file.type.startsWith("image/")) {
      outputBlob = await compressImage(file);
    } else if (file.type !== "application/pdf") {
      throw new Error("Please select a photo or PDF.");
    }

    if (outputBlob.size > MAX_FILE_BYTES) {
      throw new Error(
        "This file is still too large after preparation. Try a smaller file."
      );
    }

    const data = new Uint8Array(await outputBlob.arrayBuffer());
    const name = new TextEncoder().encode(
      file.name.slice(0, 100)
    );

    const header = concatBytes(
      new TextEncoder().encode("VFX1"),
      uint32Bytes(data.length),
      uint32Bytes(crc32(data)),
      new Uint8Array([name.length]),
      name
    );

    preparedBytes = concatBytes(header, data);
    preparedFile = {
      name: file.name,
      type: outputBlob.type || file.type,
      size: outputBlob.size
    };

    setProgress(100, "Ready");
    setStatus(
      "Ready to transmit: " + file.name +
      " (" + Math.round(outputBlob.size / 1024) + " KB)"
    );
    setButtonEnabled(transmitBtn, true);
  } catch (error) {
    preparedBytes = null;
    preparedFile = null;
    setProgress(0, "Not ready");
    setStatus(error.message || "Could not prepare this file.");
    setButtonEnabled(transmitBtn, false);
  }
}

function compressImage(file) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    const url = URL.createObjectURL(file);

    image.onload = () => {
      URL.revokeObjectURL(url);

      const maxDimension = 1200;
      const scale = Math.min(
        1,
        maxDimension / Math.max(image.width, image.height)
      );

      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(image.width * scale));
      canvas.height = Math.max(1, Math.round(image.height * scale));

      const context = canvas.getContext("2d");
      context.drawImage(image, 0, 0, canvas.width, canvas.height);

      canvas.toBlob(
        blob => blob ? resolve(blob) : reject(
          new Error("Could not compress the photo.")
        ),
        "image/jpeg",
        0.65
      );
    };

    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Could not open this photo."));
    };

    image.src = url;
  });
}

async function transmitPreparedFile() {
  if (!preparedBytes || !preparedFile) {
    setStatus("Prepare a file first.");
    return;
  }

  try {
    setButtonEnabled(transmitBtn, false);
    setStatus("Generating transmission audio…");
    setProgress(0, "Generating audio…");

    const wav = buildTransmission(preparedBytes);
    const url = URL.createObjectURL(wav);
    const audio = new Audio(url);

    activeSource = audio;
    audio.onended = () => {
      URL.revokeObjectURL(url);
      activeSource = null;
      setProgress(100, "Transmission finished");
      setStatus("Audio finished. The receiving device must have recorded it.");
      setButtonEnabled(transmitBtn, true);
    };

    audio.onerror = () => {
      URL.revokeObjectURL(url);
      activeSource = null;
      setStatus("Could not play the transmission audio.");
      setButtonEnabled(transmitBtn, true);
    };

    audio.ontimeupdate = () => {
      if (audio.duration > 0) {
        setProgress(
          audio.currentTime / audio.duration * 100,
          "Transmitting… " +
          Math.round(audio.currentTime / audio.duration * 100) + "%"
        );
      }
    };

    await audio.play();
    setStatus("Transmitting. Keep the speaker near the receiving microphone.");
  } catch (error) {
    setStatus(error.message || "Transmission could not start.");
    setButtonEnabled(transmitBtn, true);
  }
}

function stopTransmission() {
  if (activeSource) {
    activeSource.pause();
    activeSource.currentTime = 0;
    activeSource = null;
    setStatus("Transmission stopped.");
    setButtonEnabled(transmitBtn, true);
  }
}

/* VoiceFax — script.js
   Part 2 of 2
*/

function goertzel(samples, start, length, frequency, sampleRate) {
  const omega = 2 * Math.PI * frequency / sampleRate;
  const coefficient = 2 * Math.cos(omega);
  let previous = 0;
  let previous2 = 0;

  for (let i = 0; i < length; i++) {
    const sample = samples[start + i] || 0;
    const current = sample + coefficient * previous - previous2;
    previous2 = previous;
    previous = current;
  }

  return previous2 * previous2 +
    previous * previous -
    coefficient * previous * previous2;
}

function findPreamble(samples, sampleRate) {
  const windowSize = Math.round(sampleRate * 0.04);
  const hop = Math.round(sampleRate * 0.01);
  let bestPosition = -1;
  let bestScore = 0;

  for (
    let position = 0;
    position + windowSize < samples.length;
    position += hop
  ) {
    const marker = goertzel(
      samples, position, windowSize, PREAMBLE_HZ, sampleRate
    );

    const other = Math.max(
      goertzel(samples, position, windowSize, 1000, sampleRate),
      goertzel(samples, position, windowSize, 1500, sampleRate),
      goertzel(samples, position, windowSize, 1900, sampleRate)
    );

    const score = marker / Math.max(1, other);

    if (score > bestScore) {
      bestScore = score;
      bestPosition = position;
    }
  }

  if (bestPosition < 0 || bestScore < 1.5) {
    throw new Error("No VoiceFax signal detected. Try recording again.");
  }

  return bestPosition;
}

function decodeSymbol(samples, position, sampleRate) {
  const length = Math.round(sampleRate * SYMBOL_SECONDS);
  const start = Math.round(position);

  let strongestTone = 0;
  let strongestPower = -1;

  for (let i = 0; i < TONES.length; i++) {
    const power = goertzel(
      samples, start, length, TONES[i], sampleRate
    );

    if (power > strongestPower) {
      strongestPower = power;
      strongestTone = i;
    }
  }

  return strongestTone;
}

async function decodeRecording(blob) {
  const AudioContextClass =
    window.AudioContext || window.webkitAudioContext;

  if (!AudioContextClass) {
    throw new Error("This browser does not support audio decoding.");
  }

  const context = new AudioContextClass();
  const buffer = await context.decodeAudioData(
    await blob.arrayBuffer()
  );

  const samples = buffer.getChannelData(0);
  const sampleRate = buffer.sampleRate;

  setStatus("Searching for the incoming signal…");
  setProgress(10, "Analyzing audio…");

  const markerPosition = findPreamble(samples, sampleRate);

  // The data follows the 0.8-second marker and 0.15-second gap.
  const dataStart =
    markerPosition +
    Math.round(sampleRate * (PREAMBLE_SECONDS + GAP_SECONDS));

  const symbolSamples = Math.round(sampleRate * SYMBOL_SECONDS);
  const availableSymbols = Math.floor(
    (samples.length - dataStart) / symbolSamples
  );

  if (availableSymbols < 20) {
    throw new Error("The recording ended before the data arrived.");
  }

  const symbols = [];

  for (let i = 0; i < availableSymbols; i++) {
    if (stopRequested) {
      throw new Error("Receiving stopped.");
    }

    symbols.push(
      decodeSymbol(samples, dataStart + i * symbolSamples, sampleRate)
    );

    if (i % 1000 === 0) {
      setProgress(
        10 + (i / availableSymbols) * 70,
        "Decoding… " + Math.round(i / availableSymbols * 100) + "%"
      );

      await new Promise(resolve => setTimeout(resolve, 0));
    }
  }

  await context.close();

  const raw = symbolsToBytes(
    symbols,
    Math.floor(symbols.length * 3 / 8)
  );

  return recoverFile(raw);
}

function recoverFile(raw) {
  if (
    raw.length < 13 ||
    new TextDecoder().decode(raw.slice(0, 4)) !== "VFX1"
  ) {
    throw new Error("The VoiceFax header could not be read.");
  }

  const dataLength = readUint32(raw, 4);
  const expectedCrc = readUint32(raw, 8);
  const nameLength = raw[12];

  const nameStart = 13;
  const dataStart = nameStart + nameLength;
  const dataEnd = dataStart + dataLength;

  if (dataEnd > raw.length) {
    throw new Error("The recording does not contain the complete file.");
  }

  const name = new TextDecoder().decode(
    raw.slice(nameStart, dataStart)
  );

  const data = raw.slice(dataStart, dataEnd);

  if (crc32(data) !== expectedCrc) {
    throw new Error(
      "File verification failed. The audio was distorted or incomplete."
    );
  }

  const type = name.toLowerCase().endsWith(".pdf")
    ? "application/pdf"
    : "image/jpeg";

  return {
    name: name || "received-file",
    blob: new Blob([data], { type })
  };
}

async function startReceiving() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    setStatus("Microphone access is not available in this browser.");
    return;
  }

  try {
    stopRequested = false;
    recordingChunks = [];

    micStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false
      }
    });

    recorder = new MediaRecorder(micStream);
    recorder.ondataavailable = event => {
      if (event.data && event.data.size > 0) {
        recordingChunks.push(event.data);
      }
    };

    recorder.onstop = async () => {
      micStream.getTracks().forEach(track => track.stop());
      micStream = null;

      if (stopRequested) {
        setStatus("Recording stopped.");
        return;
      }

      try {
        setStatus("Processing recording…");
        setProgress(5, "Processing…");

        const recordingBlob = new Blob(recordingChunks, {
          type: recorder.mimeType || "audio/webm"
        });

        const recovered = await decodeRecording(recordingBlob);
        showRecoveredFile(recovered);

        setProgress(100, "File recovered and verified");
        setStatus("Successfully recovered: " + recovered.name);
      } catch (error) {
        setProgress(0, "Receive failed");
        setStatus(error.message || "Could not recover the file.");
      }
    };

    recorder.start();
    recording = true;

    setButtonEnabled(receiveBtn, false);
    setButtonEnabled(stopBtn, true);
    setStatus("Listening. Play the VoiceFax audio near this microphone.");
    setProgress(0, "Listening…");
  } catch (error) {
    setStatus("Microphone error: " + error.message);
    stopMicrophone();
  }
}

function stopMicrophone() {
  if (recorder && recorder.state !== "inactive") {
    recorder.stop();
  }

  if (micStream) {
    micStream.getTracks().forEach(track => track.stop());
    micStream = null;
  }

  recording = false;
  setButtonEnabled(receiveBtn, true);
  setButtonEnabled(stopBtn, false);
}

function stopReceiving() {
  if (!recording) return;

  stopRequested = true;

  if (recorder && recorder.state !== "inactive") {
    recorder.stop();
  }

  recording = false;
  setButtonEnabled(receiveBtn, true);
  setButtonEnabled(stopBtn, false);
}

function showRecoveredFile(file) {
  if (!receivedArea) return;

  receivedArea.innerHTML = "";

  const heading = document.createElement("p");
  heading.textContent = "Received: " + file.name;

  const download = document.createElement("a");
  const url = URL.createObjectURL(file.blob);

  download.href = url;
  download.download = file.name;
  download.textContent = "Download recovered file";
  download.className = "download-link";

  receivedArea.append(heading, download);

  if (file.blob.type.startsWith("image/")) {
    const image = document.createElement("img");
    image.src = url;
    image.alt = "Recovered photo";
    image.style.maxWidth = "100%";
    image.style.display = "block";
    image.style.marginTop = "12px";
    receivedArea.appendChild(image);
  }
}

// Connect the page controls.
if (prepareBtn) {
  prepareBtn.addEventListener("click", prepareSelectedFile);
}

if (transmitBtn) {
  transmitBtn.addEventListener("click", transmitPreparedFile);
  transmitBtn.disabled = true;
}

if (receiveBtn) {
  receiveBtn.addEventListener("click", startReceiving);
}

if (stopBtn) {
  stopBtn.addEventListener("click", stopReceiving);
  stopBtn.disabled = true;
}

setStatus("Choose a photo or PDF to begin.");
setProgress(0, "Waiting");
