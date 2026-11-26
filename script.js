
"use strict";

/*
  VoiceFax 3.0
  Local digital transmission with fax-inspired audio.

  This is a local browser transfer prototype.
  It does not connect to telephone lines or
  communicate with conventional fax machines.
*/

const $ = (id) => document.getElementById(id);

const fileInput = $("fileInput");
const fileInformation = $("fileInformation");
const prepareButton = $("prepareButton");
const transmitButton = $("transmitButton");
const pauseButton = $("pauseButton");
const stopButton = $("stopButton");

const statusLight = $("statusLight");
const mainStatus = $("mainStatus");
const connectionStatus = $("connectionStatus");

const transmissionState = $("transmissionState");
const progressBar = $("progressBar");
const progressText = $("progressText");
const transferSpeed = $("transferSpeed");

const receiveStatus = $("receiveStatus");
const receiveInformation = $("receiveInformation");
const downloadLink = $("downloadLink");

const imagePreview = $("imagePreview");
const receivedImage = $("receivedImage");

const soundEnabled = $("soundEnabled");
const soundOnCompletion = $("soundOnCompletion");

let selectedFile = null;
let preparedFile = null;
let receivedFile = null;

let audioContext = null;
let transferTimer = null;
let transferStarted = 0;
let transferredBytes = 0;

let paused = false;
let stopped = false;
let transferring = false;

const MAX_FILE_SIZE = 100 * 1024 * 1024;
const CHUNK_SIZE = 256 * 1024;

function setStatus(status, mode = "normal") {
  mainStatus.textContent = status;

  statusLight.className = "status-light";

  if (mode === "busy") {
    statusLight.classList.add("busy");
  }

  if (mode === "error") {
    statusLight.classList.add("error");
  }
}

function formatBytes(bytes) {
  if (bytes < 1024) {
    return bytes + " B";
  }

  if (bytes < 1024 * 1024) {
    return (bytes / 1024).toFixed(1) + " KB";
  }

  return (bytes / (1024 * 1024)).toFixed(2) + " MB";
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/* --------------------------------
   FILE SELECTION
-------------------------------- */

fileInput.addEventListener("change", () => {
  selectedFile = fileInput.files[0] || null;
  preparedFile = null;

  transmitButton.disabled = true;
  prepareButton.disabled = !selectedFile;

  if (!selectedFile) {
    fileInformation.textContent = "No document selected.";
    return;
  }

  if (selectedFile.size > MAX_FILE_SIZE) {
    fileInformation.textContent =
      "File exceeds the 100 MB prototype limit.";

    selectedFile = null;
    prepareButton.disabled = true;
    return;
  }

  fileInformation.textContent =
    selectedFile.name + " · " +
    formatBytes(selectedFile.size) + " · " +
    (selectedFile.type || "Unknown file type");

  transmissionState.textContent = "DOCUMENT SELECTED";
});

/* --------------------------------
   FAX AUDIO
-------------------------------- */

async function getAudioContext() {
  if (!audioContext) {
    const AudioContextClass =
      window.AudioContext || window.webkitAudioContext;

    if (!AudioContextClass) {
      throw new Error("Web Audio is unavailable.");
    }

    audioContext = new AudioContextClass();
  }

  if (audioContext.state === "suspended") {
    await audioContext.resume();
  }

  return audioContext;
}

function playTone(frequency, duration, volume = 0.12) {
  if (!soundEnabled.checked) return;

  return getAudioContext().then(context => {
    const oscillator = context.createOscillator();
    const gain = context.createGain();

    oscillator.type = "sine";
    oscillator.frequency.value = frequency;

    gain.gain.setValueAtTime(0, context.currentTime);
    gain.gain.linearRampToValueAtTime(
      volume,
      context.currentTime + 0.025
    );

    gain.gain.setValueAtTime(
      volume,
      context.currentTime + duration / 1000 - 0.04
    );

    gain.gain.linearRampToValueAtTime(
      0,
      context.currentTime + duration / 1000
    );

    oscillator.connect(gain);
    gain.connect(context.destination);

    oscillator.start();
    oscillator.stop(context.currentTime + duration / 1000 + 0.02);
  });
}

async function playHandshake() {
  if (!soundEnabled.checked) return;

  transmissionState.textContent = "ESTABLISHING CONNECTION";

  // Fax-inspired calling tone.
  await playTone(1100, 500);
  await wait(150);

  // Modem answer tone.
  await playTone(2100, 450);
  await wait(100);

  // Alternating connection tones.
  for (let i = 0; i < 5; i++) {
    await playTone(i % 2 === 0 ? 1200 : 2400, 110);
    await wait(35);
  }

  await wait(200);
}

async function playDataSound() {
  if (!soundEnabled.checked) return;

  // A short transmission activity sound.
  await playTone(1800, 65, 0.045);
}

async function playCompletion() {
  if (!soundEnabled.checked || !soundOnCompletion.checked) {
    return;
  }

  await playTone(1500, 160);
  await wait(90);
  await playTone(1900, 220);
}

/* --------------------------------
   PREPARE DOCUMENT
-------------------------------- */

prepareButton.addEventListener("click", async () => {
  if (!selectedFile) return;

  prepareButton.disabled = true;
  transmissionState.textContent = "PREPARING DOCUMENT";

  try {
    // Preserve the original binary file.
    const buffer = await selectedFile.arrayBuffer();

    preparedFile = new Blob(
      [buffer],
      { type: selectedFile.type || "application/octet-stream" }
    );

    transmissionState.textContent = "DOCUMENT READY";
    transmitButton.disabled = false;

    fileInformation.textContent =
      selectedFile.name + " · " +
      formatBytes(preparedFile.size) +
      " · READY FOR TRANSMISSION";

  } catch (error) {
    transmissionState.textContent = "PREPARATION FAILED";
    setStatus("ERROR", "error");
    console.error(error);
  }

  prepareButton.disabled = false;
});

/* --------------------------------
   RECEIVE DOCUMENT
-------------------------------- */

function receiveDocument(blob, filename, mimeType) {
  if (receivedFile) {
    URL.revokeObjectURL(receivedFile);
  }

  receivedFile = URL.createObjectURL(blob);

  downloadLink.href = receivedFile;
  downloadLink.download = filename;
  downloadLink.hidden = false;

  receiveStatus.textContent = "DOCUMENT RECEIVED";

  receiveInformation.textContent =
    filename + " · " + formatBytes(blob.size);

  imagePreview.hidden = true;

  if (mimeType.startsWith("image/")) {
    receivedImage.src = receivedFile;
    imagePreview.hidden = false;
  }

  if (mimeType === "application/pdf") {
    receiveInformation.textContent += " · PDF DOCUMENT";
  }
}

/* --------------------------------
   TRANSMISSION
-------------------------------- */

function updateProgress(percent) {
  const safePercent = Math.max(0, Math.min(100, percent));

  progressBar.style.width = safePercent + "%";
  progressText.textContent = Math.floor(safePercent) + "%";
}

function stopTransfer() {
  stopped = true;
  paused = false;
  transferring = false;

  if (transferTimer) {
    clearInterval(transferTimer);
    transferTimer = null;
  }

  pauseButton.disabled = true;
  stopButton.disabled = true;
  transmitButton.disabled = !preparedFile;

  setStatus("STANDBY");
  connectionStatus.textContent = "DISCONNECTED";

  transmissionState.textContent = "TRANSMISSION STOPPED";
}

async function transmit() {
  if (!preparedFile || transferring) return;

  transferring = true;
  paused = false;
  stopped = false;

  transmitButton.disabled = true;
  prepareButton.disabled = true;
  pauseButton.disabled = false;
  stopButton.disabled = false;

  setStatus("CONNECTING", "busy");
  connectionStatus.textContent = "CONNECTING";

  transmissionState.textContent = "INITIALIZING";

  updateProgress(0);

  try {
    await playHandshake();

    if (stopped) return;

    connectionStatus.textContent = "CONNECTED";
    transmissionState.textContent = "TRANSMITTING";

    receiveStatus.textContent = "RECEIVING DOCUMENT";
    receiveInformation.textContent = "Incoming data detected.";

    transferStarted = performance.now();
    transferredBytes = 0;

    const sourceBuffer = await preparedFile.arrayBuffer();

    const output = new Uint8Array(sourceBuffer);
    const reconstructed = new Uint8Array(output.length);

    let offset = 0;

    while (offset < output.length) {
      if (stopped) return;

      while (paused && !stopped) {
        await wait(100);
      }

      if (stopped) return;

      const end = Math.min(
        offset + CHUNK_SIZE,
        output.length
      );

      reconstructed.set(
        output.subarray(offset, end),
        offset
      );

      const chunkSize = end - offset;

      offset = end;
      transferredBytes += chunkSize;

      updateProgress(
        (offset / output.length) * 100
      );

      const elapsed =
        Math.max(0.001, (performance.now() - transferStarted) / 1000);

      const speed = transferredBytes / elapsed;

      transferSpeed.textContent =
        formatBytes(speed) + "/S";

      // Occasional sound keeps the audio from becoming
      // excessively repetitive during large transfers.
      if (offset === output.length || offset % (CHUNK_SIZE * 4) === 0) {
        await playDataSound();
      }

      // Yield to the browser so the interface can update.
      await new Promise(resolve => requestAnimationFrame(resolve));
    }

    if (stopped) return;

    const mimeType =
      preparedFile.type || "application/octet-stream";

    const resultBlob = new Blob(
      [reconstructed],
      { type: mimeType }
    );

    receiveDocument(
      resultBlob,
      selectedFile.name,
      mimeType
    );

    updateProgress(100);

    transmissionState.textContent = "TRANSMISSION COMPLETE";
    receiveStatus.textContent = "SUCCESSFULLY RECEIVED";

    connectionStatus.textContent = "TRANSFER COMPLETE";

    setStatus("COMPLETE");

    await playCompletion();

  } catch (error) {
    console.error(error);

    transmissionState.textContent = "TRANSMISSION ERROR";
    receiveStatus.textContent = "RECEPTION FAILED";

    setStatus("ERROR", "error");

  } finally {
    transferring = false;
    paused = false;

    prepareButton.disabled = !selectedFile;
    transmitButton.disabled = !preparedFile;
    pauseButton.disabled = true;
    stopButton.disabled = true;
  }
}

transmitButton.addEventListener("click", transmit);

/* --------------------------------
   PAUSE / RESUME
-------------------------------- */

pauseButton.addEventListener("click", () => {
  if (!transferring) return;

  paused = !paused;

  pauseButton.textContent = paused ? "RESUME" : "PAUSE";

  transmissionState.textContent =
    paused ? "TRANSMISSION PAUSED" : "TRANSMITTING";
});

/* --------------------------------
   STOP
-------------------------------- */

stopButton.addEventListener("click", () => {
  if (!transferring) return;

  stopTransfer();
});

/* --------------------------------
   INITIALIZATION
-------------------------------- */

setStatus("STANDBY");

connectionStatus.textContent = "NOT CONNECTED";

transmissionState.textContent = "READY TO TRANSMIT";

updateProgress(0);

transferSpeed.textContent = "0 KB/S";

receiveStatus.textContent = "RECEIVER STANDBY";

receiveInformation.textContent =
  "Incoming documents will appear here after transmission.";

console.log("VoiceFax 3.0 initialized.");
