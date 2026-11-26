
/* ============================================
   VOICEFAX 2.0
   Acoustic Binary File Transfer
   Experimental dial-up-inspired modem
   ============================================ */

const $ = id => document.getElementById(id);

const MAGIC = [86, 70, 88, 49]; // VFX1
const SYNC = [221, 170];
const PREAMBLE_LENGTH = 64;
const MAX_FILE_SIZE = 256 * 1024;

let selectedFile = null;
let preparedFrame = null;
let preparedBits = [];

let audioContext = null;
let modemOscillator = null;
let modemGain = null;

let transmitting = false;
let paused = false;
let recording = false;

let mediaRecorder = null;
let recordedChunks = [];
let recordedBlob = null;

let progressTimer = null;
let receiveStream = null;
let downloadURL = null;

let transmissionStart = 0;
let transmissionDuration = 0;

// --------------------------------------------
// INTERFACE
// --------------------------------------------

function setStatus(message) {
  $("mainStatus").textContent = message;
}

function setConnection(message) {
  $("connectionStatus").textContent = message;
}

function setLight(state) {
  const light = $("statusLight");

  light.classList.remove("active", "error");

  if (state === "active") {
    light.classList.add("active");
  }

  if (state === "error") {
    light.classList.add("error");
  }
}

function setProgress(value) {
  value = Math.max(0, Math.min(100, value));

  $("progressBar").style.width = value + "%";
  $("progressText").textContent = Math.round(value) + "%";
}

function formatSize(bytes) {
  if (bytes < 1024) return bytes + " bytes";

  if (bytes < 1024 * 1024) {
    return (bytes / 1024).toFixed(1) + " KB";
  }

  return (bytes / 1024 / 1024).toFixed(2) + " MB";
}

function fail(message) {
  setStatus(message);
  setConnection("ERROR");
  setLight("error");
  console.error(message);
}

// --------------------------------------------
// BINARY UTILITIES
// --------------------------------------------

function uint16(value) {
  return [
    (value >> 8) & 255,
    value & 255
  ];
}

function uint32(value) {
  return [
    (value >>> 24) & 255,
    (value >>> 16) & 255,
    (value >>> 8) & 255,
    value & 255
  ];
}

function readUint16(bytes, offset) {
  return (bytes[offset] << 8) | bytes[offset + 1];
}

function readUint32(bytes, offset) {
  return (
    bytes[offset] * 16777216 +
    bytes[offset + 1] * 65536 +
    bytes[offset + 2] * 256 +
    bytes[offset + 3]
  );
}

function bytesToBits(bytes) {
  const bits = [];

  for (const byte of bytes) {
    for (let i = 7; i >= 0; i--) {
      bits.push((byte >> i) & 1);
    }
  }

  return bits;
}

function bitsToBytes(bits) {
  if (bits.length % 8 !== 0) {
    throw new Error("Invalid binary data length.");
  }

  const result = new Uint8Array(bits.length / 8);

  for (let i = 0; i < result.length; i++) {
    let value = 0;

    for (let j = 0; j < 8; j++) {
      value = (value << 1) | bits[i * 8 + j];
    }

    result[i] = value;
  }

  return result;
}

function joinBytes(...arrays) {
  const length = arrays.reduce(
    (sum, array) => sum + array.length,
    0
  );

  const result = new Uint8Array(length);

  let offset = 0;

  for (const array of arrays) {
    result.set(array, offset);
    offset += array.length;
  }

  return result;
}

// --------------------------------------------
// CRC-32 ERROR DETECTION
// --------------------------------------------

function crc32(bytes) {
  let crc = 0xFFFFFFFF;

  for (const byte of bytes) {
    crc ^= byte;

    for (let i = 0; i < 8; i++) {
      crc = (crc >>> 1) ^
        ((crc & 1) ? 0xEDB88320 : 0);
    }
  }

  return (crc ^ 0xFFFFFFFF) >>> 0;
}

// --------------------------------------------
// BUILD FILE FRAME
// --------------------------------------------

async function buildFileFrame(file) {
  const fileBytes = new Uint8Array(
    await file.arrayBuffer()
  );

  const filename = new TextEncoder().encode(
    file.name
  );

  const mime = new TextEncoder().encode(
    file.type || "application/octet-stream"
  );

  if (filename.length > 65535 || mime.length > 65535) {
    throw new Error("File metadata is too long.");
  }

  const header = new Uint8Array([
    ...MAGIC,
    ...uint16(filename.length),
    ...uint16(mime.length),
    ...uint32(fileBytes.length)
  ]);

  const content = joinBytes(
    header,
    filename,
    mime,
    fileBytes
  );

  const checksum = crc32(content);

  const frame = joinBytes(
    content,
    new Uint8Array(uint32(checksum))
  );

  const preamble = [];

  for (let i = 0; i < PREAMBLE_LENGTH; i++) {
    preamble.push(i % 2 === 0 ? 1 : 0);
  }

  const bits = [
    ...preamble,
    ...bytesToBits(new Uint8Array(SYNC)),
    ...bytesToBits(frame)
  ];

  return {
    frame,
    bits,
    size: fileBytes.length
  };
}

// --------------------------------------------
// FILE SELECTION
// --------------------------------------------

$("fileInput").addEventListener("change", event => {
  selectedFile = event.target.files[0] || null;

  preparedFrame = null;
  preparedBits = [];

  $("transmitButton").disabled = true;

  if (!selectedFile) {
    $("fileInformation").textContent = "No file selected";
    $("prepareButton").disabled = true;
    return;
  }

  $("fileInformation").textContent =
    selectedFile.name + " · " +
    formatSize(selectedFile.size) + " · " +
    (selectedFile.type || "Unknown file type");

  if (selectedFile.size > MAX_FILE_SIZE) {
    setStatus("File exceeds the 256 KB prototype limit.");
    $("prepareButton").disabled = true;
    return;
  }

  $("prepareButton").disabled = false;

  setStatus("File selected.");
  setConnection("FILE READY");
  setLight("active");
});

// --------------------------------------------
// PREPARE TRANSMISSION
// --------------------------------------------

$("prepareButton").addEventListener("click", async () => {
  if (!selectedFile) return;

  try {
    $("prepareButton").disabled = true;

    setStatus("Preparing binary file...");
    setConnection("ENCODING");

    preparedFrame = await buildFileFrame(selectedFile);
    preparedBits = preparedFrame.bits;

    const baud = Number($("modemSpeed").value);

    const seconds = preparedBits.length / baud;

    setStatus(
      "File encoded. Estimated data time: " +
      Math.ceil(seconds) + " seconds."
    );

    setConnection("READY TO CONNECT");
    setLight("active");

    $("transmitButton").disabled = false;

  } catch (error) {
    fail(error.message);
  } finally {
    $("prepareButton").disabled = false;
  }
});

// --------------------------------------------
// DIAL-UP CONNECTION SOUND
// --------------------------------------------

function playHandshake(context, oscillator, start) {
  const frequency = oscillator.frequency;

  // Dial tone
  frequency.setValueAtTime(350, start);
  frequency.setValueAtTime(440, start + 0.25);

  // Dial-up carrier sweep
  frequency.setValueAtTime(400, start + 0.65);
  frequency.exponentialRampToValueAtTime(
    2200,
    start + 1.4
  );

  // Modem negotiation chirps
  frequency.setValueAtTime(1800, start + 1.45);
  frequency.setValueAtTime(1200, start + 1.60);
  frequency.setValueAtTime(2100, start + 1.75);
  frequency.setValueAtTime(1500, start + 1.90);
  frequency.setValueAtTime(2400, start + 2.05);
  frequency.setValueAtTime(1300, start + 2.20);

  // Carrier settling
  frequency.setValueAtTime(2100, start + 2.35);
  frequency.setValueAtTime(2100, start + 2.55);
}

// --------------------------------------------
// TRANSMIT
// --------------------------------------------

async function startTransmission() {
  if (!preparedBits.length || transmitting) return;

  try {
    const baud = Number($("modemSpeed").value);

    const frequency0 = Number($("frequency").value);
    const frequency1 = frequency0 + 800;

    const symbolDuration = 1 / baud;

    const handshakeDuration = 2.8;
    const silenceDuration = 0.35;

    transmissionDuration =
      handshakeDuration +
      silenceDuration +
      preparedBits.length * symbolDuration;

    audioContext = new (
      window.AudioContext ||
      window.webkitAudioContext
    )();

    await audioContext.resume();

    modemOscillator = audioContext.createOscillator();
    modemGain = audioContext.createGain();

    modemOscillator.type = "sine";
    modemGain.gain.value = 0;

    modemOscillator.connect(modemGain);
    modemGain.connect(audioContext.destination);

    const now = audioContext.currentTime;
    const start = now + 0.1;

    const dataStart =
      start + handshakeDuration + silenceDuration;

    // Start audible connection sequence
    modemGain.gain.setValueAtTime(0.12, start);
    playHandshake(
      audioContext,
      modemOscillator,
      start
    );

    // Silence between handshake and data
    modemGain.gain.setValueAtTime(
      0,
      start + handshakeDuration
    );

    modemGain.gain.setValueAtTime(
      0.12,
      dataStart
    );

    // Send the actual binary data
    preparedBits.forEach((bit, index) => {
      const time =
        dataStart + index * symbolDuration;

      modemOscillator.frequency.setValueAtTime(
        bit ? frequency1 : frequency0,
        time
      );
    });

    const dataEnd =
      dataStart + preparedBits.length * symbolDuration;

    modemGain.gain.setValueAtTime(0.12, dataEnd);
    modemGain.gain.setValueAtTime(0, dataEnd + 0.4);

    modemOscillator.start(start);
    modemOscillator.stop(dataEnd + 0.5);

    transmitting = true;
    paused = false;

    transmissionStart = now;

    setStatus("Connecting to receiving modem...");
    setConnection("CONNECTING");
    setLight("active");

    $("transmitButton").disabled = true;
    $("pauseButton").disabled = false;
    $("stopButton").disabled = false;

    updateTransmissionProgress(dataStart, dataEnd);

  } catch (error) {
    fail(error.message);
    await stopTransmission();
  }
}

function updateTransmissionProgress(dataStart, dataEnd) {
  clearInterval(progressTimer);

  progressTimer = setInterval(() => {
    if (!audioContext || !transmitting || paused) return;

    const current = audioContext.currentTime;

    if (current < dataStart) {
      setStatus("Modem handshake in progress...");
      setConnection("HANDSHAKE");
      return;
    }

    const percentage =
      ((current - dataStart) / (dataEnd - dataStart)) * 100;

    setProgress(percentage);

    setStatus("Transmitting binary file...");
    setConnection("DATA TRANSFER");

    if (current >= dataEnd + 0.3) {
      finishTransmission();
    }

  }, 100);
}

function finishTransmission() {
  if (!transmitting) return;

  transmitting = false;
  paused = false;

  clearInterval(progressTimer);

  setProgress(100);

  setStatus("Transmission completed.");
  setConnection("TRANSFER FINISHED");
  setLight("active");

  cleanupAudio();

  $("pauseButton").disabled = true;
  $("stopButton").disabled = true;
  $("transmitButton").disabled = false;
}

async function cleanupAudio() {
  const context = audioContext;

  audioContext = null;
  modemOscillator = null;
  modemGain = null;

  if (context) {
    try {
      await context.close();
    } catch (error) {}
  }
}

async function stopTransmission() {
  transmitting = false;
  paused = false;

  clearInterval(progressTimer);

  await cleanupAudio();

  setProgress(0);
  setStatus("Transmission stopped.");
  setConnection("STANDBY");

  $("pauseButton").disabled = true;
  $("stopButton").disabled = true;
  $("transmitButton").disabled = !preparedBits.length;
}

// --------------------------------------------
// TRANSMISSION CONTROLS
// --------------------------------------------

$("transmitButton").addEventListener(
  "click",
  startTransmission
);

$("pauseButton").addEventListener("click", async () => {
  if (!audioContext || !transmitting) return;

  if (!paused) {
    await audioContext.suspend();

    paused = true;

    setStatus("Transmission paused.");
    setConnection("PAUSED");

  } else {
    await audioContext.resume();

    paused = false;

    setStatus("Transmission resumed.");
    setConnection("DATA TRANSFER");
  }
});

$("stopButton").addEventListener(
  "click",
  stopTransmission
);

// --------------------------------------------
// AUDIO RECEIVER
// --------------------------------------------

$("receiveButton").addEventListener("click", async () => {
  if (recording) {
    recording = false;

    mediaRecorder.stop();

    $("receiveButton").textContent = "START RECEIVER";

    setStatus("Recording stopped.");
    setConnection("RECORDING SAVED");

    return;
  }

  try {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error(
        "Microphone access requires HTTPS and a supported browser."
      );
    }

    receiveStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false
      }
    });

    recordedChunks = [];
    recordedBlob = null;

    const options = MediaRecorder.isTypeSupported(
      "audio/webm;codecs=opus"
    ) ? {
      mimeType: "audio/webm;codecs=opus"
    } : {};

    mediaRecorder = new MediaRecorder(
      receiveStream,
      options
    );

    mediaRecorder.ondataavailable = event => {
      if (event.data.size) {
        recordedChunks.push(event.data);
      }
    };

    mediaRecorder.onstop = () => {
      recordedBlob = new Blob(recordedChunks, {
        type: mediaRecorder.mimeType
      });

      if (receiveStream) {
        receiveStream.getTracks().forEach(
          track => track.stop()
        );

        receiveStream = null;
      }

      $("decodeButton").disabled = false;

      $("receiveInformation").textContent =
        "Audio recording saved · " +
        formatSize(recordedBlob.size);
    };

    mediaRecorder.start(250);

    recording = true;

    $("receiveButton").textContent = "STOP RECEIVER";

    setStatus("Listening for incoming modem audio...");
    setConnection("RECEIVER ACTIVE");
    setLight("active");

  } catch (error) {
    fail(error.message);
  }
});

// --------------------------------------------
// AUDIO DECODER
// --------------------------------------------

function goertzel(samples, start, length, sampleRate, frequency) {
  const omega =
    2 * Math.PI * frequency / sampleRate;

  const coefficient = 2 * Math.cos(omega);

  let q1 = 0;
  let q2 = 0;

  for (let i = 0; i < length; i++) {
    const q0 =
      samples[start + i] +
      coefficient * q1 -
      q2;

    q2 = q1;
    q1 = q0;
  }

  return (
    q1 * q1 +
    q2 * q2 -
    coefficient * q1 * q2
  );
}

function detectBit(
  samples,
  start,
  symbolSamples,
  sampleRate,
  frequency0,
  frequency1
) {
  const skip = Math.floor(symbolSamples * 0.2);

  const length = symbolSamples - skip * 2;

  const power0 = goertzel(
    samples,
    start + skip,
    length,
    sampleRate,
    frequency0
  );

  const power1 = goertzel(
    samples,
    start + skip,
    length,
    sampleRate,
    frequency1
  );

  return power1 > power0 ? 1 : 0;
}

function readAudioBits(
  samples,
  start,
  count,
  symbolSamples,
  sampleRate,
  frequency0,
  frequency1
) {
  const bits = [];

  for (let i = 0; i < count; i++) {
    bits.push(
      detectBit(
        samples,
        start + i * symbolSamples,
        symbolSamples,
        sampleRate,
        frequency0,
        frequency1
      )
    );
  }

  return bits;
}

// --------------------------------------------
// FIND PREAMBLE
// --------------------------------------------

function findPreamble(
  samples,
  sampleRate,
  symbolSamples,
  frequency0,
  frequency1
) {
  const expected = [];

  for (let i = 0; i < PREAMBLE_LENGTH; i++) {
    expected.push(i % 2 === 0 ? 1 : 0);
  }

  const step = Math.max(
    1,
    Math.floor(symbolSamples / 4)
  );

  const searchLimit = Math.min(
    samples.length - symbolSamples * 100,
    sampleRate * 12
  );

  let bestStart = -1;
  let bestScore = 0;

  for (
    let start = 0;
    start < searchLimit;
    start += step
  ) {
    let score = 0;

    for (let i = 0; i < PREAMBLE_LENGTH; i++) {
      const bit = detectBit(
        samples,
        start + i * symbolSamples,
        symbolSamples,
        sampleRate,
        frequency0,
        frequency1
      );

      if (bit === expected[i]) score++;
    }

    if (score > bestScore) {
      bestScore = score;
      bestStart = start;
    }

    if (bestScore === PREAMBLE_LENGTH) break;
  }

  if (bestStart < 0 || bestScore < 54) {
    throw new Error(
      "Modem signal not found. Check the recording and settings."
    );
  }

  return bestStart;
}

// --------------------------------------------
// DECODE FRAME
// --------------------------------------------

async function decodeRecording() {
  if (!recordedBlob) {
    throw new Error("No recording is available.");
  }

  setStatus("Analyzing modem audio...");
  setConnection("DECODING");

  const context = new (
    window.AudioContext ||
    window.webkitAudioContext
  )();

  try {
    const buffer = await recordedBlob.arrayBuffer();

    const audio = await context.decodeAudioData(buffer);

    const samples = audio.getChannelData(0);
    const sampleRate = audio.sampleRate;

    const baud = Number($("modemSpeed").value);

    const symbolSamples = Math.round(
      sampleRate / baud
    );

    const frequency0 = Number($("frequency").value);
    const frequency1 = frequency0 + 800;

    setStatus("Searching for modem carrier...");

    const preambleStart = findPreamble(
      samples,
      sampleRate,
      symbolSamples,
      frequency0,
      frequency1
    );

    const syncStart =
      preambleStart +
      PREAMBLE_LENGTH * symbolSamples;

    const syncBits = readAudioBits(
      samples,
      syncStart,
      16,
      symbolSamples,
      sampleRate,
      frequency0,
      frequency1
    );

    const syncBytes = bitsToBytes(syncBits);

    if (
      syncBytes[0] !== SYNC[0] ||
      syncBytes[1] !== SYNC[1]
    ) {
      throw new Error("Invalid modem synchronization.");
    }

    const frameStart =
      syncStart + 16 * symbolSamples;

    // Read the fixed-size header first.
    const headerBits = readAudioBits(
      samples,
      frameStart,
      96,
      symbolSamples,
      sampleRate,
      frequency0,
      frequency1
    );

    const header = bitsToBytes(headerBits);

    for (let i = 0; i < 4; i++) {
      if (header[i] !== MAGIC[i]) {
        throw new Error("Unrecognized VoiceFax file.");
      }
    }

    const filenameLength = readUint16(header, 4);
    const mimeLength = readUint16(header, 6);
    const fileLength = readUint32(header, 8);

    if (
      filenameLength > 4096 ||
      mimeLength > 4096 ||
      fileLength > MAX_FILE_SIZE
    ) {
      throw new Error("Invalid or oversized file frame.");
    }

    const remainingLength =
      filenameLength + mimeLength + fileLength + 4;

    const remainingBits = remainingLength * 8;

    const remainingStart =
      frameStart + 96 * symbolSamples;

    setStatus("Reconstructing original file...");

    const remaining = readAudioBits(
      samples,
      remainingStart,
      remainingBits,
      symbolSamples,
      sampleRate,
      frequency0,
      frequency1
    );

    const remainingBytes = bitsToBytes(remaining);

    const completeFrame = joinBytes(
      header,
      remainingBytes
    );

    const checksumOffset = completeFrame.length - 4;

    const expectedChecksum = readUint32(
      completeFrame,
      checksumOffset
    );

    const actualChecksum = crc32(
      completeFrame.subarray(0, checksumOffset)
    );

    if (expectedChecksum !== actualChecksum) {
      throw new Error(
        "File verification failed. The recording may be distorted."
      );
    }

    let offset = 12;

    const filename = new TextDecoder().decode(
      completeFrame.subarray(
        offset,
        offset + filenameLength
      )
    );

    offset += filenameLength;

    const mime = new TextDecoder().decode(
      completeFrame.subarray(
        offset,
        offset + mimeLength
      )
    );

    offset += mimeLength;

    const fileData = completeFrame.slice(
      offset,
      offset + fileLength
    );

    const receivedFile = new Blob(
      [fileData],
      { type: mime || "application/octet-stream" }
    );

    displayReceivedFile(receivedFile, filename);

    setStatus("File received and verified.");
    setConnection("TRANSFER SUCCESSFUL");
    setLight("active");
    setProgress(100);

  } finally {
    await context.close();
  }
}

// --------------------------------------------
// DISPLAY RECEIVED FILE
// --------------------------------------------

function displayReceivedFile(blob, filename) {
  if (downloadURL) {
    URL.revokeObjectURL(downloadURL);
  }

  downloadURL = URL.createObjectURL(blob);

  const link = $("downloadLink");

  link.href = downloadURL;
  link.download = filename;
  link.textContent =
    "DOWNLOAD " + filename.toUpperCase();

  link.hidden = false;

  $("receiveInformation").textContent =
    filename + " · " + formatSize(blob.size);

  const preview = $("imagePreview");
  const image = $("receivedImage");

  if (blob.type.startsWith("image/")) {
    image.src = downloadURL;
    preview.hidden = false;
  } else {
    image.removeAttribute("src");
    preview.hidden = true;
  }
}

// --------------------------------------------
// DECODE BUTTON
// --------------------------------------------

$("decodeButton").addEventListener("click", async () => {
  $("decodeButton").disabled = true;

  try {
    await decodeRecording();
  } catch (error) {
    fail(error.message);
  } finally {
    $("decodeButton").disabled = false;
  }
});

// --------------------------------------------
// INITIALIZATION
// --------------------------------------------

$("prepareButton").disabled = true;
$("transmitButton").disabled = true;
$("decodeButton").disabled = true;
$("pauseButton").disabled = true;
$("stopButton").disabled = true;

setStatus("VoiceFax modem ready.");
setConnection("STANDBY");
setLight("idle");
setProgress(0);
