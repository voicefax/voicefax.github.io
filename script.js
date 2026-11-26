
"use strict";

/* VOICEFAX 3.1
   Local digital file transfer prototype.
   Fax-inspired audio accompanies the transfer.
*/

const $ = id => document.getElementById(id);

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
let audioContext = null;
let receivedURL = null;

let paused = false;
let stopped = false;
let transferring = false;

const MAX_FILE_SIZE = 100 * 1024 * 1024;
const CHUNK_SIZE = 256 * 1024;

function setStatus(text, mode = "") {
  mainStatus.textContent = text;
  statusLight.className = "status-light";

  if (mode) {
    statusLight.classList.add(mode);
  }
}

function formatBytes(bytes) {
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1048576) return (bytes / 1024).toFixed(1) + " KB";
  return (bytes / 1048576).toFixed(2) + " MB";
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/* FILE SELECTION */

fileInput.addEventListener("change", () => {
  selectedFile = fileInput.files && fileInput.files[0]
    ? fileInput.files[0]
    : null;

  preparedFile = null;

  transmitButton.disabled = true;
  prepareButton.disabled = !selectedFile;

  if (!selectedFile) {
    fileInformation.textContent = "No document selected.";
    return;
  }

  if (selectedFile.size > MAX_FILE_SIZE) {
    fileInformation.textContent = "File exceeds the 100 MB limit.";
    selectedFile = null;
    prepareButton.disabled = true;
    return;
  }

  fileInformation.textContent =
    selectedFile.name + " · " + formatBytes(selectedFile.size);

  transmissionState.textContent = "DOCUMENT SELECTED";
  setStatus("STANDBY");
});

/* PREPARATION */

prepareButton.addEventListener("click", async () => {
  if (!selectedFile) return;

  prepareButton.disabled = true;
  transmitButton.disabled = true;

  transmissionState.textContent = "PREPARING DOCUMENT";

  try {
    // The original File object already contains the complete file.
    // No conversion or text extraction is needed.
    preparedFile = selectedFile;

    if (preparedFile.size !== selectedFile.size) {
      throw new Error("File verification failed.");
    }

    transmissionState.textContent = "DOCUMENT READY";

    fileInformation.textContent =
      selectedFile.name + " · " +
      formatBytes(selectedFile.size) + " · READY";

    transmitButton.disabled = false;
    setStatus("STANDBY");

  } catch (error) {
    console.error("Preparation error:", error);

    preparedFile = null;
    transmissionState.textContent = "PREPARATION FAILED";

    fileInformation.textContent =
      error.message || "Unable to prepare document.";

    setStatus("ERROR", "error");

  } finally {
    prepareButton.disabled = !selectedFile;
  }
});

/* AUDIO */

async function getAudioContext() {
  const AudioClass =
    window.AudioContext || window.webkitAudioContext;

  if (!AudioClass) {
    throw new Error("Audio is not supported by this browser.");
  }

  if (!audioContext) {
    audioContext = new AudioClass();
  }

  if (audioContext.state === "suspended") {
    await audioContext.resume();
  }

  return audioContext;
}

async function tone(frequency, duration, volume = 0.1) {
  if (!soundEnabled.checked) return;

  const context = await getAudioContext();

  const oscillator = context.createOscillator();
  const gain = context.createGain();

  oscillator.type = "sine";
  oscillator.frequency.value = frequency;

  const start = context.currentTime;
  const end = start + duration / 1000;

  gain.gain.setValueAtTime(0, start);
  gain.gain.linearRampToValueAtTime(volume, start + 0.02);
  gain.gain.setValueAtTime(volume, end - 0.03);
  gain.gain.linearRampToValueAtTime(0, end);

  oscillator.connect(gain);
  gain.connect(context.destination);

  oscillator.start(start);
  oscillator.stop(end + 0.02);

  await wait(duration);
}

async function handshake() {
  transmissionState.textContent = "ESTABLISHING CONNECTION";

  await tone(1100, 450);
  await wait(100);

  await tone(2100, 450);
  await wait(100);

  for (let i = 0; i < 4; i++) {
    await tone(i % 2 ? 2400 : 1200, 100);
  }
}

async function completionSound() {
  if (!soundOnCompletion.checked) return;

  await tone(1500, 150);
  await wait(90);
  await tone(1900, 220);
}

/* RECEIVE */

function receiveDocument(blob, filename) {
  if (receivedURL) {
    URL.revokeObjectURL(receivedURL);
  }

  receivedURL = URL.createObjectURL(blob);

  downloadLink.href = receivedURL;
  downloadLink.download = filename;
  downloadLink.hidden = false;

  receiveStatus.textContent = "DOCUMENT RECEIVED";

  receiveInformation.textContent =
    filename + " · " + formatBytes(blob.size);

  imagePreview.hidden = true;

  if (blob.type.startsWith("image/")) {
    receivedImage.src = receivedURL;
    imagePreview.hidden = false;
  }
}

/* TRANSMISSION */

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

  progressBar.style.width = "0%";
  progressText.textContent = "0%";

  try {
    await handshake();

    if (stopped) return;

    connectionStatus.textContent = "CONNECTED";
    transmissionState.textContent = "TRANSMITTING";

    receiveStatus.textContent = "RECEIVING DOCUMENT";
    receiveInformation.textContent = "Incoming data detected.";

    const source = new Uint8Array(
      await preparedFile.arrayBuffer()
    );

    const output = new Uint8Array(source.length);

    const started = performance.now();
    let offset = 0;

    while (offset < source.length) {
      if (stopped) return;

      while (paused && !stopped) {
        await wait(100);
      }

      if (stopped) return;

      const end = Math.min(
        offset + CHUNK_SIZE,
        source.length
      );

      output.set(source.subarray(offset, end), offset);
      offset = end;

      const percent = source.length
        ? offset / source.length * 100
        : 100;

      progressBar.style.width = percent + "%";
      progressText.textContent = Math.floor(percent) + "%";

      const elapsed = Math.max(
        0.001,
        (performance.now() - started) / 1000
      );

      transferSpeed.textContent =
        formatBytes(offset / elapsed) + "/S";

      // Give the browser time to update the display.
      await new Promise(resolve => requestAnimationFrame(resolve));
    }

    if (stopped) return;

    const result = new Blob([output], {
      type: preparedFile.type || "application/octet-stream"
    });

    receiveDocument(result, selectedFile.name);

    progressBar.style.width = "100%";
    progressText.textContent = "100%";

    transmissionState.textContent = "TRANSMISSION COMPLETE";
    receiveStatus.textContent = "SUCCESSFULLY RECEIVED";
    connectionStatus.textContent = "TRANSFER COMPLETE";

    setStatus("COMPLETE");

    await completionSound();

  } catch (error) {
    console.error("Transmission error:", error);

    transmissionState.textContent = "TRANSMISSION ERROR";
    receiveStatus.textContent = "RECEPTION FAILED";

    receiveInformation.textContent =
      error.message || "An unexpected error occurred.";

    setStatus("ERROR", "error");

  } finally {
    transferring = false;
    paused = false;

    prepareButton.disabled = !selectedFile;
    transmitButton.disabled = !preparedFile;
    pauseButton.disabled = true;
    stopButton.disabled = true;

    pauseButton.textContent = "PAUSE";
  }
}

transmitButton.addEventListener("click", transmit);

/* PAUSE / RESUME */

pauseButton.addEventListener("click", () => {
  if (!transferring) return;

  paused = !paused;

  pauseButton.textContent = paused ? "RESUME" : "PAUSE";

  transmissionState.textContent =
    paused ? "TRANSMISSION PAUSED" : "TRANSMITTING";
});

/* STOP */

stopButton.addEventListener("click", () => {
  if (!transferring) return;

  stopped = true;
  paused = false;

  transmissionState.textContent = "TRANSMISSION STOPPED";
  connectionStatus.textContent = "DISCONNECTED";

  setStatus("STANDBY");
});

/* INITIALIZATION */

setStatus("STANDBY");

connectionStatus.textContent = "NOT CONNECTED";
transmissionState.textContent = "READY TO TRANSMIT";

progressBar.style.width = "0%";
progressText.textContent = "0%";
transferSpeed.textContent = "0 KB/S";

receiveStatus.textContent = "RECEIVER STANDBY";

prepareButton.disabled = true;
transmitButton.disabled = true;
pauseButton.disabled = true;
stopButton.disabled = true;

console.log("VoiceFax 3.1 initialized successfully.");
