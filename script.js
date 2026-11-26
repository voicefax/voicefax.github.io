
/* =========================================
   VOICEFAX 3.0
   Experimental acoustic data modem
   ========================================= */

const $ = id => document.getElementById(id);

let encodedBits = [];
let audioContext = null;
let oscillator = null;
let gainNode = null;
let recording = false;
let mediaRecorder = null;
let recordedChunks = [];
let recordedBlob = null;
let animationFrame = null;
let transmitting = false;
let paused = false;

// Protocol settings
const PREAMBLE = 0xAA;
const SYNC = 0xD3;

function status(message) {
  $("mainStatus").textContent = message;
  $("statusMessage").textContent = message;
}

function connection(message) {
  $("connectionStatus").textContent = message;
}

function progress(value) {
  $("progressBar").style.width =
    Math.max(0, Math.min(100, value)) + "%";

  $("progressText").textContent =
    Math.round(value) + "%";
}

// Convert bytes into binary bits
function bytesToBits(bytes) {
  const bits = [];

  for (const byte of bytes) {
    for (let i = 7; i >= 0; i--) {
      bits.push((byte >> i) & 1);
    }
  }

  return bits;
}

// Convert binary bits into bytes
function bitsToBytes(bits) {
  const bytes = [];

  for (let i = 0; i + 7 < bits.length; i += 8) {
    let value = 0;

    for (let j = 0; j < 8; j++) {
      value = (value << 1) | bits[i + j];
    }

    bytes.push(value);
  }

  return new Uint8Array(bytes);
}

// CRC-16/CCITT checksum
function crc16(bytes) {
  let crc = 0xFFFF;

  for (const byte of bytes) {
    crc ^= byte << 8;

    for (let i = 0; i < 8; i++) {
      if (crc & 0x8000) {
        crc = ((crc << 1) ^ 0x1021) & 0xFFFF;
      } else {
        crc = (crc << 1) & 0xFFFF;
      }
    }
  }

  return crc;
}

function uint32Bytes(value) {
  return [
    (value >>> 24) & 255,
    (value >>> 16) & 255,
    (value >>> 8) & 255,
    value & 255
  ];
}

// Build a complete VoiceFax data frame
function buildFrame(text) {
  const payload = new TextEncoder().encode(text);

  if (payload.length > 10000) {
    throw new Error("Document is too large. Maximum size is 10 KB of text.");
  }

  const length = uint32Bytes(payload.length);
  const checksum = crc16(payload);

  const frame = new Uint8Array([
    PREAMBLE,
    PREAMBLE,
    PREAMBLE,
    PREAMBLE,
    SYNC,
    ...length,
    ...payload,
    (checksum >> 8) & 255,
    checksum & 255
  ]);

  return {
    payload,
    frame,
    bits: bytesToBits(frame)
  };
}

// Load text, PDF, or image documents
async function extractDocument(file) {
  const name = file.name.toLowerCase();

  if (name.endsWith(".txt")) {
    return await file.text();
  }

  if (name.endsWith(".pdf")) {
    if (!window.pdfjsLib) {
      throw new Error("PDF reader could not load.");
    }

    pdfjsLib.GlobalWorkerOptions.workerSrc =
      "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";

    const buffer = await file.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({
      data: buffer
    }).promise;

    let result = "";

    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();

      result += content.items
        .map(item => item.str)
        .join(" ") + "\n\n";
    }

    if (!result.trim()) {
      throw new Error(
        "This PDF has no selectable text. Scanned PDFs need OCR first."
      );
    }

    return result;
  }

  if (
    name.endsWith(".jpg") ||
    name.endsWith(".jpeg") ||
    name.endsWith(".png") ||
    name.endsWith(".webp")
  ) {
    if (!window.Tesseract) {
      throw new Error("Image text reader could not load.");
    }

    status("Reading text from image...");

    const result = await Tesseract.recognize(
      file,
      "eng"
    );

    return result.data.text;
  }

  throw new Error("Unsupported document format.");
}

// Prepare document
$("fileInput").addEventListener("change", async event => {
  const file = event.target.files[0];

  if (!file) return;

  $("fileName").textContent = file.name;

  try {
    const text = await extractDocument(file);

    $("documentText").value = text;

    status("Document loaded successfully.");
    connection("DOCUMENT READY");

  } catch (error) {
    status(error.message);
    console.error(error);
  }
});

// Prepare transmission
$("prepareButton").addEventListener("click", () => {
  try {
    const text = $("documentText").value;

    if (!text.trim()) {
      status("Please load or enter a document first.");
      return;
    }

    const result = buildFrame(text);

    encodedBits = result.bits;

    const baud = Number($("modemSpeed").value);
    const seconds = encodedBits.length / baud;

    status(
      "Document encoded. Estimated transmission: " +
      Math.ceil(seconds) + " seconds."
    );

    connection("DATA ENCODED");
    progress(0);

    $("transmitButton").disabled = false;

  } catch (error) {
    status(error.message);
  }
});

// Generate actual modem audio
async function transmit() {
  if (!encodedBits.length || transmitting) return;

  const baud = Number($("modemSpeed").value);
  const symbolDuration = 1 / baud;

  const frequency0 = Number($("frequency").value);
  const frequency1 = frequency0 + 700;

  const startDelay = 0.5;
  const totalDuration =
    startDelay + encodedBits.length * symbolDuration + 0.5;

  audioContext = new (
    window.AudioContext || window.webkitAudioContext
  )();

  await audioContext.resume();

  oscillator = audioContext.createOscillator();
  gainNode = audioContext.createGain();

  oscillator.type = "sine";
  oscillator.frequency.value = frequency0;

  gainNode.gain.value = 0;

  oscillator.connect(gainNode);
  gainNode.connect(audioContext.destination);

  const startTime = audioContext.currentTime + startDelay;

  gainNode.gain.setValueAtTime(0, audioContext.currentTime);
  gainNode.gain.setValueAtTime(0.16, startTime);

  encodedBits.forEach((bit, index) => {
    const time = startTime + index * symbolDuration;

    oscillator.frequency.setValueAtTime(
      bit ? frequency1 : frequency0,
      time
    );
  });

  gainNode.gain.setValueAtTime(
    0.16,
    startTime + encodedBits.length * symbolDuration
  );

  gainNode.gain.setValueAtTime(
    0,
    startTime + encodedBits.length * symbolDuration + 0.4
  );

  oscillator.start();
  oscillator.stop(startTime + encodedBits.length * symbolDuration + 0.5);

  transmitting = true;
  paused = false;

  connection("TRANSMITTING DATA");
  status("Sending modem audio...");

  const update = () => {
    if (!transmitting || paused) return;

    const elapsed = Math.max(
      0,
      audioContext.currentTime - startTime
    );

    progress(
      Math.min(100, elapsed / (encodedBits.length * symbolDuration) * 100)
    );

    if (elapsed >= encodedBits.length * symbolDuration + 0.5) {
      finishTransmission();
      return;
    }

    animationFrame = requestAnimationFrame(update);
  };

  update();
}

function finishTransmission() {
  transmitting = false;
  paused = false;

  cancelAnimationFrame(animationFrame);

  progress(100);
  status("Transmission complete.");
  connection("TRANSMISSION FINISHED");

  if (audioContext) {
    audioContext.close();
    audioContext = null;
  }

  oscillator = null;
}

async function stopTransmission() {
  transmitting = false;
  paused = false;

  cancelAnimationFrame(animationFrame);

  if (audioContext) {
    try {
      await audioContext.close();
    } catch (error) {}
  }

  audioContext = null;
  oscillator = null;

  progress(0);
  status("Transmission stopped.");
  connection("READY");
}

$("transmitButton").addEventListener("click", transmit);

$("pauseButton").addEventListener("click", async () => {
  if (!audioContext || !transmitting) return;

  if (!paused) {
    await audioContext.suspend();
    paused = true;
    status("Transmission paused.");
    connection("PAUSED");
  } else {
    await audioContext.resume();
    paused = false;
    status("Transmission resumed.");
    connection("TRANSMITTING DATA");
  }
});

$("stopButton").addEventListener("click", stopTransmission);

// Start and stop microphone recording
$("receiveButton").addEventListener("click", async () => {
  if (recording) {
    mediaRecorder.stop();
    recording = false;

    $("receiveButton").textContent = "ENABLE AUDIO RECEIVER";

    status("Recording stopped. Ready to decode.");
    connection("RECORDING COMPLETE");

    return;
  }

  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false
      }
    });

    recordedChunks = [];

    mediaRecorder = new MediaRecorder(stream);

    mediaRecorder.ondataavailable = event => {
      if (event.data.size > 0) {
        recordedChunks.push(event.data);
      }
    };

    mediaRecorder.onstop = () => {
      recordedBlob = new Blob(recordedChunks, {
        type: mediaRecorder.mimeType
      });

      stream.getTracks().forEach(track => track.stop());

      $("decodeButton").disabled = false;
    };

    mediaRecorder.start();

    recording = true;

    $("receiveButton").textContent = "STOP AUDIO RECEIVER";

    status("Listening for incoming modem audio...");
    connection("RECEIVER ACTIVE");

  } catch (error) {
    status("Microphone unavailable: " + error.message);
  }
});

// Goertzel frequency detector
function tonePower(samples, start, length, sampleRate, frequency) {
  const omega = 2 * Math.PI * frequency / sampleRate;
  const coefficient = 2 * Math.cos(omega);

  let q1 = 0;
  let q2 = 0;

  for (let i = 0; i < length; i++) {
    const sample = samples[start + i] || 0;

    const q0 = sample + coefficient * q1 - q2;

    q2 = q1;
    q1 = q0;
  }

  return q1 * q1 + q2 * q2 -
    coefficient * q1 * q2;
}

function detectBit(
  samples,
  start,
  length,
  sampleRate,
  frequency0,
  frequency1
) {
  // Ignore the edges of each tone to reduce transition noise.
  const skip = Math.floor(length * 0.2);
  const usableLength = length - skip * 2;

  const power0 = tonePower(
    samples,
    start + skip,
    usableLength,
    sampleRate,
    frequency0
  );

  const power1 = tonePower(
    samples,
    start + skip,
    usableLength,
    sampleRate,
    frequency1
  );

  return power1 > power0 ? 1 : 0;
}

// Decode recorded audio
$("decodeButton").addEventListener("click", async () => {
  if (!recordedBlob) {
    status("No recording available.");
    return;
  }

  try {
    status("Analyzing received audio...");
    connection("DECODING");

    const context = new (
      window.AudioContext || window.webkitAudioContext
    )();

    const arrayBuffer = await recordedBlob.arrayBuffer();

    const audioBuffer = await context.decodeAudioData(arrayBuffer);

    const samples = audioBuffer.getChannelData(0);
    const sampleRate = audioBuffer.sampleRate;

    const baud = Number($("modemSpeed").value);
    const symbolDuration = 1 / baud;
    const symbolSamples = Math.round(
      sampleRate * symbolDuration
    );

    const frequency0 = Number($("frequency").value);
    const frequency1 = frequency0 + 700;

    // Search for the alternating preamble.
    const preambleBits = bytesToBits(
      new Uint8Array([PREAMBLE, PREAMBLE, PREAMBLE, PREAMBLE])
    );

    let bestStart = -1;
    let bestScore = -Infinity;

    const searchLimit = Math.min(
      samples.length - symbolSamples * 40,
      sampleRate * 4
    );

    const step = Math.max(
      1,
      Math.floor(symbolSamples / 8)
    );

    for (
      let start = 0;
      start < searchLimit;
      start += step
    ) {
      let score = 0;

      for (let i = 0; i < preambleBits.length; i++) {
        const detected = detectBit(
          samples,
          start + i * symbolSamples,
          symbolSamples,
          sampleRate,
          frequency0,
          frequency1
        );

        if (detected === preambleBits[i]) {
          score++;
        }
      }

      if (score > bestScore) {
        bestScore = score;
        bestStart = start;
      }

      if (bestScore === preambleBits.length) break;
    }

    if (
      bestStart < 0 ||
      bestScore < preambleBits.length * 0.8
    ) {
      throw new Error("Could not find a valid VoiceFax signal.");
    }

    // Read the frame after the preamble.
    const frameStart =
      bestStart + preambleBits.length * symbolSamples;

    function readBits(count, offset) {
      const result = [];

      for (let i = 0; i < count; i++) {
        result.push(
          detectBit(
            samples,
            offset + i * symbolSamples,
            symbolSamples,
            sampleRate,
            frequency0,
            frequency1
          )
        );
      }

      return result;
    }

    function readBytes(count, offset) {
      return bitsToBytes(
        readBits(count * 8, offset)
      );
    }

    const sync = readBytes(1, frameStart);

    if (sync[0] !== SYNC) {
      throw new Error("Invalid frame synchronization.");
    }

    const lengthOffset = frameStart + 8 * symbolSamples;
    const lengthBytes = readBytes(4, lengthOffset);

    const payloadLength =
      lengthBytes[0] * 16777216 +
      lengthBytes[1] * 65536 +
      lengthBytes[2] * 256 +
      lengthBytes[3];

    if (payloadLength > 10000 || payloadLength < 0) {
      throw new Error("Invalid document length.");
    }

    const payloadOffset =
      lengthOffset + 32 * symbolSamples;

    const payload = readBytes(
      payloadLength,
      payloadOffset
    );

    const checksumOffset =
      payloadOffset + payloadLength * 8 * symbolSamples;

    const receivedChecksum = readBytes(
      2,
      checksumOffset
    );

    const expectedChecksum = crc16(payload);

    const actualChecksum =
      (receivedChecksum[0] << 8) |
      receivedChecksum[1];

    if (actualChecksum !== expectedChecksum) {
      throw new Error(
        "Checksum failed. The audio may have been distorted."
      );
    }

    const decodedText = new TextDecoder().decode(payload);

    $("receivedText").value = decodedText;

    status("Document received and verified.");
    connection("SUCCESS");

    progress(100);

    await context.close();

  } catch (error) {
    status(error.message);
    connection("DECODE ERROR");
    console.error(error);
  }
});

// Initial state
$("transmitButton").disabled = true;
$("decodeButton").disabled = true;

status("VoiceFax ready.");
connection("STANDBY");
progress(0);
