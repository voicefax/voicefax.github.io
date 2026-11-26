
"use strict";

/*
  VOICEFAX AUDIO 1.1

  Experimental audio-carried file transfer.
  Custom binary FSK protocol; not an ITU-T fax modem.

  Data frequencies:
  0 = 1200 Hz
  1 = 2200 Hz

  Baud rate: 1200
  Audio sample rate: 48000 Hz
*/

const $ = id => document.getElementById(id);

const SAMPLE_RATE = 48000;
const BAUD = 1200;
const SAMPLES_PER_BIT = SAMPLE_RATE / BAUD;

const FREQ_ZERO = 1200;
const FREQ_ONE = 2200;

const MAX_FILE_BYTES = 96 * 1024;
const PREAMBLE_BYTES = 120;
const SYNC = [0xD3, 0x91, 0xC5, 0xA7];

let selectedFile = null;
let preparedBlob = null;
let preparedURL = null;

let mediaRecorder = null;
let recordedChunks = [];
let receiveStream = null;

let receivedURL = null;
let recordingSamples = [];
let recordingContext = null;
let recordingSource = null;
let recordingProcessor = null;

let activeTab = "send";

function setStatus(message, mode = "") {
  $("mainStatus").textContent = message;
  $("statusLight").className = mode;
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1048576).toFixed(2)} MB`;
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/* ---------------- CRC ---------------- */

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

/* ---------------- PACKET ENCODING ---------------- */

function pushByteBits(output, value) {
  for (let i = 0; i < 8; i++) {
    output.push((value >>> i) & 1);
  }
}

function makePacket(fileBytes, filename, mimeType) {
  const encoder = new TextEncoder();

  const nameBytes = encoder.encode(filename.slice(0, 180));
  const mimeBytes = encoder.encode(
    (mimeType || "application/octet-stream").slice(0, 100)
  );

  const metadata = new Uint8Array(
    2 + nameBytes.length + mimeBytes.length
  );

  let m = 0;

  metadata[m++] = nameBytes.length;
  metadata.set(nameBytes, m);
  m += nameBytes.length;

  metadata[m++] = mimeBytes.length;
  metadata.set(mimeBytes, m);

  const packet = new Uint8Array(
    4 + metadata.length + fileBytes.length + 4
  );

  let p = 0;

  packet[p++] = (metadata.length >>> 8) & 255;
  packet[p++] = metadata.length & 255;

  packet.set(metadata, p);
  p += metadata.length;

  packet.set(fileBytes, p);
  p += fileBytes.length;

  const checksum = crc32(packet.subarray(0, p));

  packet[p++] = (checksum >>> 24) & 255;
  packet[p++] = (checksum >>> 16) & 255;
  packet[p++] = (checksum >>> 8) & 255;
  packet[p++] = checksum & 255;

  return packet;
}

function packetToBits(packet) {
  const bits = [];

  // Alternating preamble for signal acquisition.
  for (let i = 0; i < PREAMBLE_BYTES; i++) {
    pushByteBits(bits, 0x55);
  }

  // Synchronization word.
  for (const byte of SYNC) {
    pushByteBits(bits, byte);
  }

  // Packet length.
  const length = packet.length;

  pushByteBits(bits, (length >>> 24) & 255);
  pushByteBits(bits, (length >>> 16) & 255);
  pushByteBits(bits, (length >>> 8) & 255);
  pushByteBits(bits, length & 255);

  // Payload.
  for (const byte of packet) {
    pushByteBits(bits, byte);
  }

  // End padding.
  for (let i = 0; i < 16; i++) {
    pushByteBits(bits, 0x55);
  }

  return bits;
}

/* ---------------- AUDIO GENERATION ---------------- */

function addTone(samples, start, duration, frequency, volume = 0.45) {
  const count = Math.floor(duration * SAMPLE_RATE);
  let phase = 0;

  for (let i = 0; i < count; i++) {
    const envelope = Math.min(
      1,
      i / 500,
      (count - i) / 500
    );

    samples[start + i] =
      Math.sin(phase) * volume * Math.max(0, envelope);

    phase += 2 * Math.PI * frequency / SAMPLE_RATE;
  }

  return start + count;
}

function addSilence(samples, start, duration) {
  return start + Math.floor(duration * SAMPLE_RATE);
}

function makeWav(bits) {
  const leadSamples = Math.floor(SAMPLE_RATE * 0.25);
  const cngSamples = Math.floor(SAMPLE_RATE * 0.5);
  const gapSamples = Math.floor(SAMPLE_RATE * 0.2);
  const cedSamples = Math.floor(SAMPLE_RATE * 2.0);
  const bitSamples = Math.ceil(bits.length * SAMPLES_PER_BIT);
  const tailSamples = Math.floor(SAMPLE_RATE * 0.4);

  const total =
    leadSamples +
    cngSamples +
    gapSamples +
    cedSamples +
    gapSamples +
    bitSamples +
    tailSamples;

  const samples = new Float32Array(total);

  let position = leadSamples;

  // Fax-style calling tone: 1100 Hz.
  position = addTone(
    samples, position, 0.5, 1100, 0.35
  );

  position = addSilence(samples, position, 0.2);

  // Fax-style answering tone: 2100 Hz.
  position = addTone(
    samples, position, 2.0, 2100, 0.35
  );

  position = addSilence(samples, position, 0.2);

  // FSK data follows the connection tones.
  let phase = 0;

  for (let i = 0; i < bits.length; i++) {
    const frequency = bits[i] ? FREQ_ONE : FREQ_ZERO;
    const step = 2 * Math.PI * frequency / SAMPLE_RATE;

    const start = position + Math.floor(i * SAMPLES_PER_BIT);

    for (
      let j = 0;
      j < Math.ceil(SAMPLES_PER_BIT);
      j++
    ) {
      const index = start + j;

      if (index >= samples.length - tailSamples) break;

      samples[index] = Math.sin(phase) * 0.68;

      phase += step;

      if (phase >= Math.PI * 2) {
        phase -= Math.PI * 2;
      }
    }
  }

  const pcm = new Int16Array(samples.length);

  for (let i = 0; i < samples.length; i++) {
    pcm[i] = Math.max(
      -32768,
      Math.min(32767, Math.round(samples[i] * 32767))
    );
  }

  const buffer = new ArrayBuffer(44 + pcm.length * 2);
  const view = new DataView(buffer);

  function writeString(offset, value) {
    for (let i = 0; i < value.length; i++) {
      view.setUint8(offset + i, value.charCodeAt(i));
    }
  }

  writeString(0, "RIFF");
  view.setUint32(4, 36 + pcm.length * 2, true);
  writeString(8, "WAVE");
  writeString(12, "fmt ");

  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, SAMPLE_RATE, true);
  view.setUint32(28, SAMPLE_RATE * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);

  writeString(36, "data");
  view.setUint32(40, pcm.length * 2, true);

  for (let i = 0; i < pcm.length; i++) {
    view.setInt16(44 + i * 2, pcm[i], true);
  }

  return new Blob([buffer], { type: "audio/wav" });
}

/* ---------------- TRANSMITTER ---------------- */

$("fileInput").addEventListener("change", () => {
  selectedFile = $("fileInput").files?.[0] || null;

  preparedBlob = null;

  $("prepareButton").disabled = !selectedFile;
  $("playButton").disabled = true;
  $("downloadAudioButton").disabled = true;

  $("progressBar").style.width = "0%";
  $("progressText").textContent = "WAITING FOR FILE";

  if (!selectedFile) {
    $("fileInformation").textContent = "No file selected.";
    return;
  }

  if (selectedFile.size > MAX_FILE_BYTES) {
    $("fileInformation").textContent =
      `File too large. Maximum size: ${formatBytes(MAX_FILE_BYTES)}.`;

    selectedFile = null;
    $("prepareButton").disabled = true;
    return;
  }

  $("fileInformation").textContent =
    `${selectedFile.name} · ${formatBytes(selectedFile.size)}`;

  setStatus("FILE SELECTED");
});

$("prepareButton").addEventListener("click", async () => {
  if (!selectedFile) return;

  $("prepareButton").disabled = true;
  $("playButton").disabled = true;

  try {
    setStatus("ENCODING", "busy");
    $("progressText").textContent = "READING DOCUMENT…";

    const fileBytes = new Uint8Array(
      await selectedFile.arrayBuffer()
    );

    $("progressText").textContent = "BUILDING DATA PACKET…";

    const packet = makePacket(
      fileBytes,
      selectedFile.name,
      selectedFile.type
    );

    const bits = packetToBits(packet);

    $("progressText").textContent = "GENERATING MODEM AUDIO…";

    preparedBlob = makeWav(bits);

    if (preparedURL) {
      URL.revokeObjectURL(preparedURL);
    }

    preparedURL = URL.createObjectURL(preparedBlob);

    $("progressBar").style.width = "100%";
    $("progressText").textContent =
      `READY · ${bits.length} BITS · ${(bits.length / BAUD).toFixed(1)} SEC DATA`;

    $("fileInformation").textContent =
      `${selectedFile.name} · ${formatBytes(selectedFile.size)} · ENCODED`;

    $("playButton").disabled = false;
    $("downloadAudioButton").disabled = false;

    setStatus("DOCUMENT ENCODED");

  } catch (error) {
    console.error(error);

    $("progressText").textContent = error.message;
    setStatus("ENCODING ERROR", "error");

  } finally {
    $("prepareButton").disabled = !selectedFile;
  }
});

$("playButton").addEventListener("click", async () => {
  if (!preparedBlob || !preparedURL) return;

  const audio = new Audio(preparedURL);

  $("playButton").disabled = true;

  audio.onplay = () => {
    setStatus("TRANSMITTING", "busy");

    $("connectionStatus").textContent =
      "FAX AUDIO SIGNAL ACTIVE";

    $("progressText").textContent =
      "PLAYING ENCODED DOCUMENT DATA…";
  };

  audio.ontimeupdate = () => {
    if (!audio.duration) return;

    const percent = audio.currentTime / audio.duration * 100;

    $("progressBar").style.width = `${percent}%`;
  };

  audio.onended = () => {
    setStatus("TRANSMISSION COMPLETE");

    $("connectionStatus").textContent =
      "AUDIO PLAYBACK FINISHED";

    $("progressText").textContent =
      "SIGNAL FINISHED · READY FOR NEXT TRANSMISSION";

    $("playButton").disabled = false;
  };

  audio.onerror = () => {
    setStatus("PLAYBACK ERROR", "error");
    $("progressText").textContent =
      "Unable to play the generated audio.";
    $("playButton").disabled = false;
  };

  try {
    await audio.play();
  } catch (error) {
    $("progressText").textContent = error.message;
    setStatus("PLAYBACK ERROR", "error");
    $("playButton").disabled = false;
  }
});

$("downloadAudioButton").addEventListener("click", () => {
  if (!preparedURL || !selectedFile) return;

  const link = document.createElement("a");

  link.href = preparedURL;
  link.download = `${selectedFile.name}.voicefax.wav`;

  link.click();
});

/* ---------------- AUDIO DECODER ---------------- */

function goertzel(samples, start, count, frequency, sampleRate) {
  const omega = 2 * Math.PI * frequency / sampleRate;
  const coefficient = 2 * Math.cos(omega);

  let q1 = 0;
  let q2 = 0;

  for (let i = 0; i < count; i++) {
    const sample = samples[start + i] || 0;
    const q0 = coefficient * q1 - q2 + sample;

    q2 = q1;
    q1 = q0;
  }

  return q1 * q1 + q2 * q2 - coefficient * q1 * q2;
}

function decodeBits(samples, sampleRate, offset) {
  const samplesPerBit = sampleRate / BAUD;
  const bits = [];

  for (
    let position = offset;
    position + samplesPerBit <= samples.length;
    position += samplesPerBit
  ) {
    const start = Math.floor(position + samplesPerBit * 0.15);
    const count = Math.floor(samplesPerBit * 0.7);

    const zeroEnergy = goertzel(
      samples, start, count, FREQ_ZERO, sampleRate
    );

    const oneEnergy = goertzel(
      samples, start, count, FREQ_ONE, sampleRate
    );

    bits.push(oneEnergy > zeroEnergy ? 1 : 0);
  }

  return bits;
}

function readByte(bits, position) {
  let value = 0;

  for (let i = 0; i < 8; i++) {
    value |= (bits[position + i] & 1) << i;
  }

  return value;
}

function findPacket(bits) {
  const syncBits = [];

  for (const byte of SYNC) {
    pushByteBits(syncBits, byte);
  }

  for (
    let position = 0;
    position + syncBits.length + 64 < bits.length;
    position++
  ) {
    let matched = true;

    for (let j = 0; j < syncBits.length; j++) {
      if (bits[position + j] !== syncBits[j]) {
        matched = false;
        break;
      }
    }

    if (!matched) continue;

    const lengthPosition = position + syncBits.length;

    const length = (
      readByte(bits, lengthPosition) * 0x1000000 +
      (readByte(bits, lengthPosition + 8) << 16) +
      (readByte(bits, lengthPosition + 16) << 8) +
      readByte(bits, lengthPosition + 24)
    ) >>> 0;

    if (
      length < 8 ||
      length > MAX_FILE_BYTES + 512 ||
      length * 8 > bits.length - lengthPosition - 32
    ) {
      continue;
    }

    const packet = new Uint8Array(length);

    for (let i = 0; i < length; i++) {
      packet[i] = readByte(
        bits,
        lengthPosition + 32 + i * 8
      );
    }

    const dataEnd = length - 4;

    const expectedCRC = (
      packet[dataEnd] * 0x1000000 +
      (packet[dataEnd + 1] << 16) +
      (packet[dataEnd + 2] << 8) +
      packet[dataEnd + 3]
    ) >>> 0;

    const actualCRC = crc32(packet.subarray(0, dataEnd));

    if (expectedCRC === actualCRC) {
      return packet;
    }
  }

  return null;
}

function reconstructFile(packet) {
  const metadataLength =
    (packet[0] << 8) | packet[1];

  const metadata = packet.subarray(
    2,
    2 + metadataLength
  );

  let p = 0;

  const nameLength = metadata[p++];

  const filename = new TextDecoder().decode(
    metadata.subarray(p, p + nameLength)
  );

  p += nameLength;

  const mimeLength = metadata[p++];

  const mime = new TextDecoder().decode(
    metadata.subarray(p, p + mimeLength)
  ) || "application/octet-stream";

  const fileStart = 2 + metadataLength;
  const fileEnd = packet.length - 4;

  const fileBytes = packet.slice(fileStart, fileEnd);

  return {
    filename: filename || "received-file",
    mime,
    bytes: fileBytes,
    blob: new Blob([fileBytes], { type: mime })
  };
}

async function decodeAudioBlob(blob) {
  const AudioContextClass =
    window.AudioContext || window.webkitAudioContext;

  const context = new AudioContextClass();

  try {
    const buffer = await blob.arrayBuffer();

    const decoded = await context.decodeAudioData(
      buffer.slice(0)
    );

    const source = decoded.getChannelData(0);

    const sampleRate = decoded.sampleRate;

    $("signalLevel").textContent =
      `${Math.round(decoded.duration * 10) / 10} sec audio`;

    // Try each possible bit alignment.
    const step = Math.max(
      1,
      Math.floor(sampleRate / BAUD / 20)
    );

    for (
      let offset = 0;
      offset < sampleRate / BAUD;
      offset += step
    ) {
      const bits = decodeBits(
        source,
        sampleRate,
        offset
      );

      $("detectedBits").textContent =
        bits.length.toLocaleString();

      const packet = findPacket(bits);

      if (packet) {
        return reconstructFile(packet);
      }
    }

    throw new Error(
      "No valid packet found. The recording may be distorted or incomplete."
    );

  } finally {
    await context.close();
  }
}

/* ---------------- RECEIVER ---------------- */

$("recordButton").addEventListener("click", async () => {
  try {
    recordedChunks = [];

    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error(
        "Microphone access is unavailable. Use HTTPS."
      );
    }

    receiveStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false
      }
    });

    const options = {};

    if (
      MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
    ) {
      options.mimeType = "audio/webm;codecs=opus";
    } else if (
      MediaRecorder.isTypeSupported("audio/mp4")
    ) {
      options.mimeType = "audio/mp4";
    }

    mediaRecorder = new MediaRecorder(receiveStream, options);

    mediaRecorder.ondataavailable = event => {
      if (event.data.size > 0) {
        recordedChunks.push(event.data);
      }
    };

    mediaRecorder.start(250);

    $("recordButton").disabled = true;
    $("stopRecordButton").disabled = false;

    $("recordInformation").textContent =
      "Recording audio. Play the sender's VoiceFax WAV now.";

    $("receiveStatus").textContent =
      "LISTENING FOR MODEM SIGNAL";

    $("receivedResult").hidden = true;

    $("connectionStatus").textContent =
      "MICROPHONE ACTIVE";

    setStatus("RECEIVING AUDIO", "busy");

  } catch (error) {
    $("recordInformation").textContent =
      `Microphone error: ${error.message}`;

    setStatus("MICROPHONE ERROR", "error");
  }
});

$("stopRecordButton").addEventListener("click", () => {
  if (!mediaRecorder || mediaRecorder.state === "inactive") {
    return;
  }

  $("stopRecordButton").disabled = true;

  mediaRecorder.onstop = async () => {
    receiveStream?.getTracks().forEach(track => track.stop());
    receiveStream = null;

    $("recordButton").disabled = false;

    const audioBlob = new Blob(recordedChunks, {
      type: mediaRecorder.mimeType || "audio/webm"
    });

    $("recordInformation").textContent =
      `Recorded ${formatBytes(audioBlob.size)}. Analyzing audio…`;

    try {
      const result = await decodeAudioBlob(audioBlob);

      showReceivedFile(result);

    } catch (error) {
      console.error(error);

      $("receiveStatus").textContent =
        `DECODE FAILED: ${error.message}`;

      $("recordInformation").textContent =
        "The recording could not be decoded.";

      setStatus("DECODE FAILED", "error");
    }
  };

  mediaRecorder.stop();
});

function showReceivedFile(result) {
  if (receivedURL) {
    URL.revokeObjectURL(receivedURL);
  }

  receivedURL = URL.createObjectURL(result.blob);

  $("receivedName").textContent = result.filename;

  $("receivedDetails").textContent =
    `${formatBytes(result.bytes.length)} · ${result.mime} · CRC VERIFIED`;

  $("downloadLink").href = receivedURL;
  $("downloadLink").download = result.filename;

  $("receivedResult").hidden = false;

  const image = $("imagePreview");

  if (result.mime.startsWith("image/")) {
    image.src = receivedURL;
    image.hidden = false;
  } else {
    image.hidden = true;
  }

  $("receiveProgress").style.width = "100%";

  $("receiveStatus").textContent =
    "FILE SUCCESSFULLY DECODED";

  $("recordInformation").textContent =
    "Document reconstructed successfully.";

  $("connectionStatus").textContent =
    "DATA PACKET VERIFIED";

  setStatus("FILE RECEIVED");
}

/* ---------------- SELF-TEST ---------------- */

$("selfTestButton").addEventListener("click", async () => {
  const button = $("selfTestButton");

  button.disabled = true;

  $("testInformation").textContent =
    "Creating a test document…";

  $("testProgress").style.width = "10%";

  $("testStatus").textContent =
    "ENCODING TEST DATA";

  setStatus("SELF-TEST", "busy");

  try {
    const testText =
      "VOICEFAX AUDIO 1.1 SELF TEST\n" +
      "This document is being encoded into FSK audio data.\n" +
      "The decoder must reconstruct these exact bytes.\n" +
      "0123456789 ABCDEFGHIJKLMNOPQRSTUVWXYZ";

    const originalBytes = new TextEncoder().encode(testText);

    const packet = makePacket(
      originalBytes,
      "voicefax-self-test.txt",
      "text/plain"
    );

    const bits = packetToBits(packet);

    $("testProgress").style.width = "35%";
    $("testStatus").textContent = "GENERATING AUDIO WAVEFORM";

    const wav = makeWav(bits);

    $("testProgress").style.width = "65%";
    $("testStatus").textContent = "DECODING GENERATED AUDIO";

    const result = await decodeAudioBlob(wav);

    $("testProgress").style.width = "90%";

    const same =
      result.bytes.length === originalBytes.length &&
      result.bytes.every(
        (value, index) => value === originalBytes[index]
      );

    if (!same) {
      throw new Error("Reconstructed data did not match the original.");
    }

    $("testProgress").style.width = "100%";

    $("testInformation").textContent =
      `SUCCESS · ${formatBytes(result.bytes.length)} reconstructed · CRC VERIFIED`;

    $("testStatus").textContent =
      "ENCODER AND DECODER PASSED";

    setStatus("SELF-TEST PASSED");

  } catch (error) {
    console.error(error);

    $("testInformation").textContent = error.message;
    $("testStatus").textContent = "SELF-TEST FAILED";

    setStatus("TEST FAILED", "error");

  } finally {
    button.disabled = false;
  }
});

/* ---------------- TAB CONTROLS ---------------- */

function switchTab(tab) {
  activeTab = tab;

  $("sendPanel").hidden = tab !== "send";
  $("receivePanel").hidden = tab !== "receive";
  $("testPanel").hidden = tab !== "test";

  $("sendTab").classList.toggle("active", tab === "send");
  $("receiveTab").classList.toggle("active", tab === "receive");
  $("testTab").classList.toggle("active", tab === "test");
}

$("sendTab").addEventListener("click", () => switchTab("send"));
$("receiveTab").addEventListener("click", () => switchTab("receive"));
$("testTab").addEventListener("click", () => switchTab("test"));

/* ---------------- INITIAL STATE ---------------- */

$("prepareButton").disabled = true;
$("playButton").disabled = true;
$("downloadAudioButton").disabled = true;
$("stopRecordButton").disabled = true;

$("progressBar").style.width = "0%";
$("receiveProgress").style.width = "0%";
$("testProgress").style.width = "0%";

setStatus("STANDBY");

$("connectionStatus").textContent = "NO CONNECTION";

console.log("VoiceFax Audio 1.1 initialized.");
