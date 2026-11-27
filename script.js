(() => {
"use strict";

/*
 * VoiceFax acoustic demo protocol.
 * This is a deliberately conservative, low-rate FSK implementation.
 * It is not a telephone fax/T.30 modem and is not suitable for large files
 * in a one-minute transfer. The receiver records first, then decodes.
 */

const $ = id => document.getElementById(id);
const els = {
  sendTab: $("sendTab"), receiveTab: $("receiveTab"),
  sendPanel: $("sendPanel"), receivePanel: $("receivePanel"),
  fileInput: $("fileInput"), fileName: $("fileName"),
  prepareBtn: $("prepareBtn"), transmitBtn: $("transmitBtn"),
  stopPlaybackBtn: $("stopPlaybackBtn"),
  startReceiveBtn: $("startReceiveBtn"), stopReceiveBtn: $("stopReceiveBtn"),
  statusDot: $("statusDot"), statusTitle: $("statusTitle"),
  statusText: $("statusText"), progressBar: $("progressBar"),
  progressText: $("progressText"), resultPanel: $("resultPanel"),
  receivedName: $("receivedName"), downloadLink: $("downloadLink"),
  preview: $("preview")
};

const RATE = 12000;
const SYMBOL_MS = 40;
const SYMBOL_SAMPLES = RATE * SYMBOL_MS / 1000;
const TONES = [1200, 1600, 2000, 2400];
const PREAMBLE = [0,1,2,3,0,1,2,3,3,2,1,0,3,1,0,2];
const MAX_BYTES = 256 * 1024;
let prepared = null;
let playback = null;
let recorder = null;
let stream = null;
let chunks = [];
let recording = false;
let receiveStartedAt = 0;
let currentObjectUrl = null;

function status(title, message, percent = 0) {
  els.statusTitle.textContent = title;
  els.statusText.textContent = message;
  els.progressBar.style.width = `${Math.max(0, Math.min(100, percent))}%`;
  els.progressText.textContent = `${Math.round(percent)}%`;
}
function bytesConcat(...arrays) {
  const total = arrays.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const a of arrays) { out.set(a, offset); offset += a.length; }
  return out;
}
function crc32(bytes) {
  let c = 0xffffffff;
  for (const b of bytes) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return (c ^ 0xffffffff) >>> 0;
}
function put32(n) {
  return new Uint8Array([n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255]);
}
function get32(b, i) {
  return (b[i] | b[i+1] << 8 | b[i+2] << 16 | b[i+3] << 24) >>> 0;
}
function bytesToSymbols(bytes) {
  const out = [];
  for (const byte of bytes) {
    out.push((byte >>> 6) & 3, (byte >>> 4) & 3, (byte >>> 2) & 3, byte & 3);
  }
  return out;
}
function symbolsToBytes(symbols) {
  if (symbols.length % 4) throw new Error("Incomplete data symbols.");
  const out = new Uint8Array(symbols.length / 4);
  for (let i = 0, j = 0; i < symbols.length; i += 4, j++) {
    out[j] = (symbols[i] << 6) | (symbols[i+1] << 4) | (symbols[i+2] << 2) | symbols[i+3];
  }
  return out;
}
function tone(samples, hz, ms, amp = 0.65) {
  const n = Math.round(RATE * ms / 1000);
  for (let i = 0; i < n; i++) {
    const edge = Math.min(1, i / 100, (n - 1 - i) / 100);
    samples.push(Math.sin(2 * Math.PI * hz * i / RATE) * amp * Math.max(0, edge));
  }
}
function silence(samples, ms) {
  const n = Math.round(RATE * ms / 1000);
  for (let i = 0; i < n; i++) samples.push(0);
}
function makeWav(samples) {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const v = new DataView(buffer);
  const str = (p, s) => [...s].forEach((c, i) => v.setUint8(p+i, c.charCodeAt(0)));
  str(0, "RIFF"); v.setUint32(4, 36 + samples.length*2, true);
  str(8, "WAVE"); str(12, "fmt "); v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, RATE, true); v.setUint32(28, RATE*2, true);
  v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  str(36, "data"); v.setUint32(40, samples.length*2, true);
  for (let i = 0; i < samples.length; i++) {
    const x = Math.max(-1, Math.min(1, samples[i]));
    v.setInt16(44 + i*2, x * 32767, true);
  }
  return new Blob([buffer], {type:"audio/wav"});
}
function buildSignal(packet) {
  const samples = [];
  tone(samples, 900, 250);
  silence(samples, 100);
  for (const s of PREAMBLE) tone(samples, TONES[s], SYMBOL_MS);
  silence(samples, 100);
  for (const s of bytesToSymbols(packet)) tone(samples, TONES[s], SYMBOL_MS);
  silence(samples, 300);
  return makeWav(Float32Array.from(samples));
}
async function compressPhoto(file) {
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    const maxSide = 1100;
    const scale = Math.min(1, maxSide / Math.max(image.width, image.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(image.width * scale));
    canvas.height = Math.max(1, Math.round(image.height * scale));
    canvas.getContext("2d").drawImage(image, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise(resolve => canvas.toBlob(resolve, "image/jpeg", 0.68));
    if (!blob) throw new Error("Photo compression failed.");
    return blob;
  } finally { URL.revokeObjectURL(url); }
}
async function prepareFile() {
  const file = els.fileInput.files && els.fileInput.files[0];
  if (!file) { status("Choose a file", "Select a photo or PDF first."); return; }
  try {
    els.prepareBtn.disabled = true;
    status("Preparing", "Reading and preparing your file…", 10);
    let blob = file;
    let name = file.name;
    if (file.type.startsWith("image/")) {
      blob = await compressPhoto(file);
      name = file.name.replace(/\.[^.]+$/, "") + ".jpg";
    } else if (file.type !== "application/pdf") {
      throw new Error("Please choose an image or PDF.");
    }
    if (blob.size > MAX_BYTES) {
      throw new Error(`Prepared file is ${Math.round(blob.size/1024)} KB. This demo's limit is 256 KB.`);
    }
    const nameBytes = new TextEncoder().encode(name.slice(0, 120));
    const data = new Uint8Array(await blob.arrayBuffer());
    const packet = bytesConcat(
      new TextEncoder().encode("VFX2"),
      put32(data.length),
      put32(crc32(data)),
      new Uint8Array([nameBytes.length]),
      nameBytes,
      data
    );
    prepared = {packet, name, bytes:data.length, mime:blob.type || file.type};
    const estimatedSeconds = (PREAMBLE.length + packet.length * 4) * SYMBOL_MS / 1000 + 0.8;
    els.transmitBtn.disabled = false;
    status("File prepared", `${name} · ${Math.ceil(data.length/1024)} KB · estimated audio ${Math.ceil(estimatedSeconds)} sec.`, 100);
  } catch (e) {
    prepared = null;
    els.transmitBtn.disabled = true;
    status("Could not prepare file", e.message, 0);
  } finally { els.prepareBtn.disabled = false; }
}
async function playTransmission() {
  if (!prepared) { status("No prepared file", "Prepare a file first."); return; }
  try {
    const wav = buildSignal(prepared.packet);
    const url = URL.createObjectURL(wav);
    playback = new Audio(url);
    els.transmitBtn.disabled = true;
    els.stopPlaybackBtn.disabled = false;
    status("Transmitting", "Keep the speaker close to the receiving microphone.", 0);
    playback.ontimeupdate = () => {
      if (playback.duration) status("Transmitting", "Keep both devices still and nearby.", playback.currentTime / playback.duration * 100);
    };
    playback.onended = () => {
      URL.revokeObjectURL(url);
      playback = null;
      els.transmitBtn.disabled = false;
      els.stopPlaybackBtn.disabled = true;
      status("Audio finished", "If the receiver recorded the full signal, tap Stop & decode there.", 100);
    };
    playback.onerror = () => {
      URL.revokeObjectURL(url);
      playback = null;
      els.transmitBtn.disabled = false;
      els.stopPlaybackBtn.disabled = true;
      status("Playback error", "Your browser could not play the generated audio.");
    };
    await playback.play();
  } catch (e) {
    els.transmitBtn.disabled = false;
    els.stopPlaybackBtn.disabled = true;
    status("Playback failed", e.message);
  }
}
function stopPlayback() {
  if (!playback) return;
  playback.pause(); playback.currentTime = 0; playback = null;
  els.transmitBtn.disabled = !prepared;
  els.stopPlaybackBtn.disabled = true;
  status("Playback stopped", "Transmission was stopped before completion.");
}
function powerAt(samples, start, length, hz, sampleRate) {
  const w = 2 * Math.PI * hz / sampleRate, coeff = 2 * Math.cos(w);
  let q1 = 0, q2 = 0;
  for (let i = 0; i < length; i++) {
    const q0 = (samples[start+i] || 0) + coeff*q1 - q2;
    q2 = q1; q1 = q0;
  }
  return q1*q1 + q2*q2 - coeff*q1*q2;
}
function decodeAt(samples, start, symbolSamples, sampleRate) {
  const offset = Math.round(symbolSamples * 0.15);
  const len = Math.round(symbolSamples * 0.7);
  let best = 0, bestPower = -1;
  for (let i = 0; i < TONES.length; i++) {
    const p = powerAt(samples, start + offset, len, TONES[i], sampleRate);
    if (p > bestPower) { bestPower = p; best = i; }
  }
  return best;
}
function findPreamble(samples, sampleRate) {
  const sym = Math.round(sampleRate * SYMBOL_MS / 1000);
  const hop = Math.max(1, Math.round(sym / 8));
  const maxStart = samples.length - sym * (PREAMBLE.length + 2);
  for (let start = 0; start < maxStart; start += hop) {
    let matches = 0;
    for (let j = 0; j < PREAMBLE.length; j++) {
      if (decodeAt(samples, start + j*sym, sym, sampleRate) === PREAMBLE[j]) matches++;
    }
    if (matches >= PREAMBLE.length - 1) return start + PREAMBLE.length*sym + Math.round(sampleRate*0.1);
  }
  throw new Error("No clear VoiceFax signal found. Record again with the devices closer together.");
}
async function decodeAudio(blob) {
  const AC = window.AudioContext || window.webkitAudioContext;
  const context = new AC();
  try {
    const audioBuffer = await context.decodeAudioData(await blob.arrayBuffer());
    const samples = audioBuffer.getChannelData(0);
    const sampleRate = audioBuffer.sampleRate;
    const symbolSamples = sampleRate * SYMBOL_MS / 1000;
    status("Analyzing recording", "Finding the signal start…", 8);
    const start = findPreamble(samples, sampleRate);
    const maxSymbols = Math.floor((samples.length - start) / symbolSamples);
    const decoded = [];
    for (let i = 0; i < maxSymbols; i++) {
      decoded.push(decodeAt(samples, Math.round(start + i*symbolSamples), symbolSamples, sampleRate));
      if (i % 1500 === 0) {
        status("Decoding", "Reading audio data…", 10 + 80*i/Math.max(1,maxSymbols));
        await new Promise(r => setTimeout(r, 0));
      }
    }
    const bytes = symbolsToBytes(decoded);
    if (bytes.length < 13 || new TextDecoder().decode(bytes.slice(0,4)) !== "VFX2") {
      throw new Error("The data header is damaged. Try a quieter room and move the devices closer.");
    }
    const length = get32(bytes, 4), expectedCrc = get32(bytes, 8), nameLength = bytes[12];
    const dataStart = 13 + nameLength, dataEnd = dataStart + length;
    if (length > MAX_BYTES || dataEnd > bytes.length) throw new Error("The recording ended before the whole file arrived.");
    const name = new TextDecoder().decode(bytes.slice(13, dataStart));
    const data = bytes.slice(dataStart, dataEnd);
    if (crc32(data) !== expectedCrc) throw new Error("File verification failed. The signal was distorted; please record and transmit again.");
    return {name, data};
  } finally { await context.close(); }
}
async function startRecording() {
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
    status("Microphone unavailable", "Open this page in Safari or Chrome over HTTPS and allow microphone access.");
    return;
  }
  try {
    chunks = [];
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation:false, noiseSuppression:false, autoGainControl:false }
    });
    const options = {};
    if (MediaRecorder.isTypeSupported("audio/webm;codecs=opus")) options.mimeType = "audio/webm;codecs=opus";
    else if (MediaRecorder.isTypeSupported("audio/mp4")) options.mimeType = "audio/mp4";
    recorder = new MediaRecorder(stream, options);
    recorder.ondataavailable = e => { if (e.data?.size) chunks.push(e.data); };
    recorder.onstop = finishRecording;
    recorder.start(250);
    recording = true;
    receiveStartedAt = Date.now();
    els.startReceiveBtn.disabled = true;
    els.stopReceiveBtn.disabled = false;
    status("Listening", "Play the sender's complete audio now. Then tap Stop & decode.", 0);
  } catch (e) {
    stopTracks();
    status("Microphone permission needed", e.message || "Allow microphone access and try again.");
  }
}
function stopTracks() {
  if (stream) { stream.getTracks().forEach(t => t.stop()); stream = null; }
}
function stopRecording() {
  if (!recording) return;
  recording = false;
  if (recorder && recorder.state !== "inactive") recorder.stop();
  stopTracks();
  els.startReceiveBtn.disabled = false;
  els.stopReceiveBtn.disabled = true;
}
async function finishRecording() {
  stopTracks();
  els.startReceiveBtn.disabled = false;
  els.stopReceiveBtn.disabled = true;
  if (!chunks.length) { status("No recording", "No audio was captured."); return; }
  try {
    status("Processing", "Decoding the recording…", 5);
    const blob = new Blob(chunks, {type: recorder.mimeType || chunks[0].type});
    const result = await decodeAudio(blob);
    const isPdf = result.name.toLowerCase().endsWith(".pdf");
    const mime = isPdf ? "application/pdf" : "image/jpeg";
    const fileBlob = new Blob([result.data], {type:mime});
    if (currentObjectUrl) URL.revokeObjectURL(currentObjectUrl);
    currentObjectUrl = URL.createObjectURL(fileBlob);
    els.receivedName.textContent = `${result.name} · ${Math.round(result.data.length/1024)} KB · verified`;
    els.downloadLink.href = currentObjectUrl;
    els.downloadLink.download = result.name;
    els.resultPanel.classList.remove("hidden");
    els.preview.replaceChildren();
    if (!isPdf && mime.startsWith("image/")) {
      const img = document.createElement("img");
      img.src = currentObjectUrl;
      img.alt = "Received photo preview";
      els.preview.appendChild(img);
    }
    status("File received", "CRC check passed. Your recovered file is ready.", 100);
  } catch (e) {
    status("Receive failed", e.message || "Could not decode the recording.", 0);
  }
}
function showTab(which) {
  const sending = which === "send";
  els.sendPanel.classList.toggle("hidden", !sending);
  els.receivePanel.classList.toggle("hidden", sending);
  els.sendTab.classList.toggle("active", sending);
  els.receiveTab.classList.toggle("active", !sending);
  els.sendTab.setAttribute("aria-selected", String(sending));
  els.receiveTab.setAttribute("aria-selected", String(!sending));
}
els.sendTab.addEventListener("click", () => showTab("send"));
els.receiveTab.addEventListener("click", () => showTab("receive"));
els.fileInput.addEventListener("change", () => {
  const file = els.fileInput.files?.[0];
  els.fileName.textContent = file ? `${file.name} · ${Math.ceil(file.size/1024)} KB` : "No file selected";
  prepared = null;
  els.transmitBtn.disabled = true;
  status(file ? "File selected" : "Ready", file ? "Tap Prepare file to continue." : "Choose a file to get started.", 0);
});
els.prepareBtn.addEventListener("click", prepareFile);
els.transmitBtn.addEventListener("click", playTransmission);
els.stopPlaybackBtn.addEventListener("click", stopPlayback);
els.startReceiveBtn.addEventListener("click", startRecording);
els.stopReceiveBtn.addEventListener("click", stopRecording);
status("Ready", "Choose a file to get started.", 0);
})();