/*
 * VoiceFax acoustic transfer protocol, version 1.
 * Browser-to-browser, local acoustic transfer. No server or cloud storage.
 * The receiver must be listening before the sender calls.
 */

const $ = id => document.getElementById(id);

const input = $("messageInput");
const received = $("receivedMessage");
const sendButton = $("sendButton");
const listenButton = $("listenButton");
const stopButton = $("stopButton");
const copyButton = $("copyButton");
const fileInput = $("fileInput");
const chooseFileButton = $("chooseFileButton");
const downloadButton = $("downloadButton");

// 16-FSK: four data bits per tone. The analysis window sits inside each symbol
// so small timing offsets and ordinary room noise are less likely to corrupt it.
const SYMBOL_TIME = 0.012;
const TONE_WINDOW = 0.009;
const DATA_TONES = Array.from({ length: 16 }, (_, i) => 900 + i * 200);
const CALL_TONE = 1100;
const ANSWER_TONE = 2100;
const TRAINING_MARKER = 2600;
const READY_TONE = 2800;
const END_TONE = 700;
const ACK_TONE = ANSWER_TONE;
const FRAME_BYTES = 128;
const MAX_TRANSFER_BYTES = 24 * 1024;
const SYNC = [0, 15, 1, 14, 2, 13, 3, 12, 4, 11, 5, 10, 6, 9, 7, 8];

let selectedFile = null;
let receiver = null;
let currentDownloadUrl = null;
let sending = false;

input.addEventListener("input", () => {
  $("counter").textContent = `${input.value.length} / 500`;
});

function setSendProgress(value) {
  const percent = Math.max(0, Math.min(100, Math.floor(value)));
  $("sendProgress").value = percent;
  $("sendPercent").textContent = `${percent}%`;
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) {
      crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function bytesToSymbols(bytes) {
  const symbols = [];
  for (const byte of bytes) {
    symbols.push((byte >>> 4) & 15, byte & 15);
  }
  return symbols;
}

function symbolsToBytes(symbols) {
  if (symbols.length % 2) throw new Error("Incomplete audio frame.");
  const bytes = new Uint8Array(symbols.length / 2);
  for (let i = 0; i < symbols.length; i += 2) {
    bytes[i / 2] = (symbols[i] << 4) | symbols[i + 1];
  }
  return bytes;
}

function concatBytes(...arrays) {
  const length = arrays.reduce((sum, a) => sum + a.length, 0);
  const output = new Uint8Array(length);
  let offset = 0;
  for (const array of arrays) {
    output.set(array, offset);
    offset += array.length;
  }
  return output;
}

function uint32Bytes(value) {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value >>> 0, false);
  return bytes;
}

function buildFrames(metadata, payload) {
  const metadataBytes = new TextEncoder().encode(JSON.stringify(metadata));
  if (metadataBytes.length > 1024) throw new Error("File information is too large.");

  const packet = concatBytes(
    new Uint8Array([metadataBytes.length >>> 8, metadataBytes.length & 255]),
    metadataBytes,
    payload
  );

  const totalFrames = Math.ceil(packet.length / FRAME_BYTES);
  const frames = [];

  for (let index = 0; index < totalFrames; index++) {
    const part = packet.slice(index * FRAME_BYTES, (index + 1) * FRAME_BYTES);
    const header = new Uint8Array(5);
    const view = new DataView(header.buffer);
    view.setUint16(0, index, false);
    view.setUint16(2, totalFrames, false);
    header[4] = part.length;

    const body = concatBytes(header, part);
    const frame = concatBytes(body, uint32Bytes(crc32(body)));
    frames.push([...SYNC, ...bytesToSymbols(frame)]);
  }
  return frames;
}

function goertzelPower(samples, start, length, sampleRate, frequency) {
  if (start < 0 || start + length > samples.length) return 0;
  const coefficient = 2 * Math.cos(2 * Math.PI * frequency / sampleRate);
  let s1 = 0;
  let s2 = 0;
  let energy = 0;
  for (let i = 0; i < length; i++) {
    const w = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (length - 1));
    const value = samples[start + i] * w;
    energy += value * value;
    const s0 = value + coefficient * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  return { power: s1 * s1 + s2 * s2 - coefficient * s1 * s2, energy };
}

function detectTone(samples, sampleRate, frequency) {
  const length = Math.min(samples.length, Math.floor(sampleRate * 0.07));
  if (length < sampleRate * 0.045) return false;
  const start = samples.length - length;
  let energy = 0;
  for (let i = start; i < samples.length; i++) energy += samples[i] * samples[i];
  const rms = Math.sqrt(energy / length);
  if (rms < 0.0025) return false;
  const wanted = goertzelPower(samples, start, length, sampleRate, frequency).power;
  // Absolute narrow-band energy is more reliable than comparing against the
  // other handshake tones, which can overlap acoustically during the answer.
  return wanted > energy * 7;
}

function detectDataSymbol(samples, offset, sampleRate) {
  const length = Math.floor(sampleRate * TONE_WINDOW);
  const start = Math.floor(offset + sampleRate * ((SYMBOL_TIME - TONE_WINDOW) / 2));
  if (start < 0 || start + length > samples.length) return -1;

  let total = 0;
  for (let i = 0; i < length; i++) total += samples[start + i] * samples[start + i];
  const rms = Math.sqrt(total / length);
  if (rms < 0.0018) return -1;

  let bestSymbol = -1;
  let bestPower = 0;
  let secondPower = 0;
  for (let i = 0; i < DATA_TONES.length; i++) {
    const power = goertzelPower(samples, start, length, sampleRate, DATA_TONES[i]).power;
    if (power > bestPower) {
      secondPower = bestPower;
      bestPower = power;
      bestSymbol = i;
    } else if (power > secondPower) {
      secondPower = power;
    }
  }
  if (bestPower < total * 5 || bestPower < secondPower * 1.45) return -1;
  return bestSymbol;
}

function readSymbols(samples, rate, offset, count) {
  const result = [];
  for (let i = 0; i < count; i++) {
    const symbol = detectDataSymbol(samples, offset + i * SYMBOL_TIME * rate, rate);
    if (symbol < 0) throw new Error("Audio was too noisy to decode a frame.");
    result.push(symbol);
  }
  return result;
}

function syncMatches(samples, rate, offset, required = 13) {
  let matches = 0;
  for (let i = 0; i < SYNC.length; i++) {
    const symbol = detectDataSymbol(samples, offset + i * SYMBOL_TIME * rate, rate);
    if (symbol === SYNC[i]) matches++;
  }
  return matches >= required;
}

function findSync(samples, rate, from, to, step) {
  const lastStart = Math.min(to, samples.length - (SYNC.length + 16) * SYMBOL_TIME * rate);
  for (let offset = Math.max(0, from); offset < lastStart; offset += step) {
    // Test four alternating sync symbols first to keep the search inexpensive.
    const probes = [0, 1, 2, 3];
    let matches = 0;
    for (const i of probes) {
      if (detectDataSymbol(samples, offset + i * SYMBOL_TIME * rate, rate) === SYNC[i]) matches++;
    }
    if (matches >= 3 && syncMatches(samples, rate, offset, 13)) return offset;
  }
  return -1;
}

function decodeFrames(samples, rate) {
  const symbolSamples = SYMBOL_TIME * rate;
  const searchEnd = Math.min(samples.length, rate * 8);
  let offset = findSync(samples, rate, 0, searchEnd, Math.max(1, Math.floor(rate * 0.003)));
  if (offset < 0) throw new Error("No VoiceFax data frames found. Keep the phones close and try again.");

  let expectedIndex = 0;
  let totalFrames = null;
  const parts = [];
  let decodedCount = 0;

  while (totalFrames === null || expectedIndex < totalFrames) {
    const headerSymbols = readSymbols(samples, rate, offset + SYNC.length * symbolSamples, 10);
    const header = symbolsToBytes(headerSymbols);
    const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
    const frameIndex = view.getUint16(0, false);
    const declaredTotal = view.getUint16(2, false);
    const payloadLength = header[4];

    if (declaredTotal < 1 || declaredTotal > 2000 || payloadLength < 1 || payloadLength > FRAME_BYTES) {
      throw new Error("Invalid frame header. The signal may have been interrupted.");
    }
    if (totalFrames === null) totalFrames = declaredTotal;
    if (declaredTotal !== totalFrames || frameIndex !== expectedIndex) {
      throw new Error("A frame arrived out of order. Please retry with the phones closer together.");
    }

    const remainingBytes = payloadLength + 4;
    const payloadAndCrcSymbols = readSymbols(
      samples,
      rate,
      offset + (SYNC.length + 10) * symbolSamples,
      remainingBytes * 2
    );
    const payloadAndCrc = symbolsToBytes(payloadAndCrcSymbols);
    const frameBody = concatBytes(header, payloadAndCrc.slice(0, payloadLength));
    const expectedCrc = new DataView(
      payloadAndCrc.buffer,
      payloadAndCrc.byteOffset + payloadLength,
      4
    ).getUint32(0, false);

    if (crc32(frameBody) !== expectedCrc) {
      throw new Error(`Frame ${frameIndex + 1} failed its noise check. Move the phones closer and resend.`);
    }

    parts.push(payloadAndCrc.slice(0, payloadLength));
    decodedCount++;
    expectedIndex++;

    if (expectedIndex < totalFrames) {
      const frameSymbolCount = SYNC.length + (5 + payloadLength + 4) * 2;
      const expectedNext = offset + frameSymbolCount * symbolSamples;
      offset = findSync(
        samples,
        rate,
        Math.max(0, expectedNext - rate * 0.025),
        expectedNext + rate * 0.035,
        Math.max(1, Math.floor(rate * 0.001))
      );
      if (offset < 0) throw new Error(`Only ${decodedCount} of ${totalFrames} frames arrived. Please resend.`);
    }
  }
  return concatBytes(...parts);
}

function decodePacket(packet) {
  if (packet.length < 4) throw new Error("The received packet is incomplete.");
  const metadataLength = (packet[0] << 8) | packet[1];
  if (metadataLength < 2 || metadataLength > 1024 || metadataLength + 2 > packet.length) {
    throw new Error("Invalid file information in the transmission.");
  }
  const metadata = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(packet.slice(2, 2 + metadataLength)));
  const payload = packet.slice(2 + metadataLength);
  if (!metadata || typeof metadata.name !== "string" || typeof metadata.type !== "string") {
    throw new Error("The sender's file information was invalid.");
  }
  return { metadata, payload };
}

function makeAudioContext() {
  const AudioClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioClass) throw new Error("This browser does not support Web Audio.");
  return new AudioClass();
}

function playTone(context, frequency, duration, volume = 0.2) {
  return new Promise(resolve => {
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    const start = context.currentTime + 0.03;
    oscillator.type = "sine";
    oscillator.frequency.setValueAtTime(frequency, start);
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.linearRampToValueAtTime(volume, start + 0.012);
    gain.gain.setValueAtTime(volume, start + Math.max(0.02, duration - 0.02));
    gain.gain.linearRampToValueAtTime(0.0001, start + duration);
    oscillator.connect(gain);
    gain.connect(context.destination);
    oscillator.start(start);
    oscillator.stop(start + duration + 0.03);
    oscillator.onended = () => resolve();
  });
}

async function waitForAcknowledgement(analyser, sampleRate, expectedTone = ACK_TONE, timeoutMs = 12000) {
  const buffer = new Float32Array(analyser.fftSize);
  const started = Date.now();
  let hits = 0;
  while (Date.now() - started < timeoutMs) {
    analyser.getFloatTimeDomainData(buffer);
    if (detectTone(buffer, sampleRate, expectedTone)) hits++;
    else hits = 0;
    if (hits >= 2) return true;
    await new Promise(resolve => setTimeout(resolve, 35));
  }
  return false;
}

async function loadImageForCompression(file) {
  if (typeof createImageBitmap === "function") {
    try { return await createImageBitmap(file); } catch {}
  }
  // Fallback for mobile browsers whose ImageBitmap decoder does not support a photo format.
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.decoding = "async";
    image.src = url;
    if (image.decode) await image.decode();
    else await new Promise((resolve, reject) => {
      image.onload = resolve;
      image.onerror = () => reject(new Error("The selected image could not be opened."));
    });
    return {
      width: image.naturalWidth,
      height: image.naturalHeight,
      draw: (ctx, width, height) => ctx.drawImage(image, 0, 0, width, height),
      close: () => URL.revokeObjectURL(url)
    };
  } catch (error) {
    URL.revokeObjectURL(url);
    throw error;
  }
}

async function compressImage(file) {
  let bitmap;
  try { bitmap = await loadImageForCompression(file); }
  catch { throw new Error("This browser could not open that photo. Try saving it as JPEG or PNG first."); }

  const sizes = [480, 360, 280, 220, 180];
  const qualities = [0.32, 0.24, 0.18, 0.13, 0.10];
  let compressed = null;
  try {
    for (let attempt = 0; attempt < sizes.length; attempt++) {
      const scale = Math.min(1, sizes[attempt] / Math.max(bitmap.width, bitmap.height));
      const width = Math.max(1, Math.round(bitmap.width * scale));
      const height = Math.max(1, Math.round(bitmap.height * scale));
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      if (!ctx) throw new Error("Image processing is unavailable in this browser.");
      if (bitmap.draw) bitmap.draw(ctx, width, height);
      else ctx.drawImage(bitmap, 0, 0, width, height);

      const image = ctx.getImageData(0, 0, width, height);
      const pixels = image.data;
      const gray = new Float32Array(width * height);
      for (let i = 0, p = 0; i < pixels.length; i += 4, p++) {
        gray[p] = 0.299 * pixels[i] + 0.587 * pixels[i + 1] + 0.114 * pixels[i + 2];
      }
      // Floyd-Steinberg dithering gives the image a fax-like monochrome texture.
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const p = y * width + x;
          const oldValue = gray[p];
          const newValue = oldValue < 128 ? 0 : 255;
          const error = oldValue - newValue;
          gray[p] = newValue;
          if (x + 1 < width) gray[p + 1] += error * 7 / 16;
          if (y + 1 < height) {
            if (x > 0) gray[p + width - 1] += error * 3 / 16;
            gray[p + width] += error * 5 / 16;
            if (x + 1 < width) gray[p + width + 1] += error / 16;
          }
        }
      }
      for (let p = 0, i = 0; p < gray.length; p++, i += 4) {
        const value = gray[p] < 128 ? 0 : 255;
        pixels[i] = pixels[i + 1] = pixels[i + 2] = value;
        pixels[i + 3] = 255;
      }
      ctx.putImageData(image, 0, 0);
      const blob = await new Promise(resolve => canvas.toBlob(resolve, "image/jpeg", qualities[attempt]));
      if (!blob) continue;
      compressed = blob;
      if (blob.size <= MAX_TRANSFER_BYTES) break;
    }
  } finally {
    bitmap.close?.();
  }

  if (!compressed || compressed.size > MAX_TRANSFER_BYTES) {
    throw new Error("This photo is still too large for the current acoustic limit after fax compression. Try cropping it and selecting it again.");
  }
  const base = file.name.replace(/\.[^.]+$/, "") || "photo";
  return {
    blob: compressed,
    metadata: { name: `${base}-voicefax.jpg`, type: "image/jpeg", kind: "file", originalName: file.name }
  };
}

chooseFileButton.addEventListener("click", () => {
  // Call the picker synchronously from the tap; this is important on iPhone/iPad.
  try {
    if (typeof fileInput.showPicker === "function") fileInput.showPicker();
    else fileInput.click();
  } catch {
    fileInput.click();
  }
});

fileInput.addEventListener("change", async () => {
  const file = fileInput.files && fileInput.files[0];
  if (!file) return;
  chooseFileButton.disabled = true;
  $("fileStatus").textContent = "Preparing file...";
  try {
    let prepared;
    if (file.type.startsWith("image/") || /\.(jpe?g|png|gif|webp|heic|heif|bmp|tiff?)$/i.test(file.name)) {
      prepared = await compressImage(file);
    } else {
      prepared = {
        blob: file,
        metadata: { name: file.name, type: file.type || "application/octet-stream", kind: "file", originalName: file.name }
      };
    }
    if (prepared.blob.size > MAX_TRANSFER_BYTES) {
      throw new Error(`This acoustic version supports files up to ${Math.round(MAX_TRANSFER_BYTES / 1024)} KB after compression. This file is ${Math.ceil(prepared.blob.size / 1024)} KB.`);
    }
    selectedFile = prepared;
    input.value = "";
    sendButton.textContent = "Transmit file";
    $("fileStatus").textContent = `${prepared.metadata.name} · ${Math.ceil(prepared.blob.size / 1024)} KB ready`;
  } catch (error) {
    selectedFile = null;
      sendButton.textContent = "Transmit message";
    $("fileStatus").textContent = error.message;
  } finally {
    chooseFileButton.disabled = false;
    fileInput.value = "";
  }
});

function clearSelectedFile() {
  selectedFile = null;
  sendButton.textContent = "Transmit message";
  $("fileStatus").textContent = "No file selected.";
}

input.addEventListener("input", () => {
  if (selectedFile) clearSelectedFile();
});

function buildTransferFromMessage(message) {
  const bytes = new TextEncoder().encode(message);
  return {
    metadata: { name: "VoiceFax-message.txt", type: "text/plain;charset=utf-8", kind: "text" },
    payload: bytes
  };
}

async function transmitFrames(context, frames) {
  const oscillator = context.createOscillator();
  const gain = context.createGain();
  oscillator.type = "sine";
  gain.gain.value = 0.18;
  oscillator.connect(gain);
  gain.connect(context.destination);

  const allSymbols = frames.flat();
  const start = context.currentTime + 0.15;
  const duration = allSymbols.length * SYMBOL_TIME;
  oscillator.start(start);

  // Schedule the entire stream against the audio clock. Using JavaScript
  // timers between frames can introduce timing gaps on slower phones.
  for (let i = 0; i < allSymbols.length; i++) {
    oscillator.frequency.setValueAtTime(DATA_TONES[allSymbols[i]], start + i * SYMBOL_TIME);
  }
  oscillator.stop(start + duration + 0.03);

  let lastFrame = 0;
  const progressTimer = setInterval(() => {
    const elapsed = Math.max(0, context.currentTime - start);
    const ratio = Math.min(1, elapsed / duration);
    setSendProgress(ratio * 94);
    const frameNumber = Math.min(frames.length, Math.floor(ratio * frames.length) + 1);
    if (frameNumber !== lastFrame) {
      lastFrame = frameNumber;
      $("sendStatus").textContent = `Transmitting frame ${frameNumber} of ${frames.length}...`;
    }
  }, 200);

  await new Promise(resolve => setTimeout(resolve, (duration + 0.2) * 1000));
  clearInterval(progressTimer);
  await playTone(context, END_TONE, 0.55, 0.2);
}

function startCallingSignal(context) {
  const oscillator = context.createOscillator();
  const gain = context.createGain();
  oscillator.type = "sine";
  oscillator.frequency.value = CALL_TONE;
  oscillator.connect(gain);
  gain.connect(context.destination);
  const start = context.currentTime + 0.04;
  gain.gain.setValueAtTime(0.0001, start);
  // Repeated 0.48-second calling bursts resemble a fax calling signal.
  for (let i = 0; i < 14; i++) {
    const burst = start + i * 0.9;
    gain.gain.setValueAtTime(0.18, burst);
    gain.gain.setValueAtTime(0.0001, burst + 0.48);
  }
  oscillator.start(start);
  oscillator.stop(start + 13);
  return () => { try { oscillator.stop(); } catch {} };
}

async function sendModemTraining(context) {
  // Audible multi-tone training exchange, followed by a distinct training marker.
  for (const frequency of [1300, 1500, 1700, 1900, 2100, 2300]) {
    await playTone(context, frequency, 0.13, 0.19);
  }
  await playTone(context, TRAINING_MARKER, 0.48, 0.19);
}

async function sendTransfer(transfer) {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error("Microphone access is unavailable. Open VoiceFax over HTTPS in a supported browser.");
  }
  const packetFrames = buildFrames(transfer.metadata, transfer.payload);
  const estimatedSeconds = packetFrames.reduce((sum, frame) => sum + frame.length * SYMBOL_TIME, 0) + 4;
  $("sendStatus").textContent = `Preparing modem handshake. Estimated audio time: about ${Math.ceil(estimatedSeconds / 60)} min.`;

  let stream;
  let context;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false }
    });
    context = makeAudioContext();
    await context.resume();
    const source = context.createMediaStreamSource(stream);
    const analyser = context.createAnalyser();
    analyser.fftSize = 4096;
    analyser.smoothingTimeConstant = 0;
    source.connect(analyser);

    $("sendStatus").textContent = "Calling the receiving device...";
    const stopCalling = startCallingSignal(context);
    const answered = await waitForAcknowledgement(analyser, context.sampleRate, ACK_TONE, 14000);
    stopCalling();
    if (!answered) {
      throw new Error("No modem answer detected. Make sure the other phone is listening, raise its volume, and try again.");
    }

    $("sendStatus").textContent = "Receiver answered. Negotiating modem connection...";
    await sendModemTraining(context);
    const ready = await waitForAcknowledgement(analyser, context.sampleRate, READY_TONE, 8000);
    if (!ready) {
      throw new Error("The receiver answered but did not confirm modem readiness. Keep the phones close and try again.");
    }
    // Let the receiver's ready tone finish before the first data symbol begins.
    await new Promise(resolve => setTimeout(resolve, 500));

    $("sendStatus").textContent = "Modem link established. Sending data...";
    await transmitFrames(context, packetFrames);
    setSendProgress(100);
    $("sendStatus").textContent = "Audio sent. Check the receiving phone for its confirmation.";
  } finally {
    if (stream) stream.getTracks().forEach(track => track.stop());
    if (context && context.state !== "closed") await context.close();
  }
}

sendButton.addEventListener("click", async () => {
  if (sending) return;
  let transfer;
  if (selectedFile) {
    const bytes = new Uint8Array(await selectedFile.blob.arrayBuffer());
    transfer = { metadata: selectedFile.metadata, payload: bytes };
  } else {
    const message = input.value;
    if (!message.trim()) {
      $("sendStatus").textContent = "Enter a message or choose a photo or file first.";
      return;
    }
    transfer = buildTransferFromMessage(message);
  }

  if (transfer.payload.length > MAX_TRANSFER_BYTES) {
    $("sendStatus").textContent = "This file is too large for the current acoustic transfer limit.";
    return;
  }

  sending = true;
  sendButton.disabled = true;
  chooseFileButton.disabled = true;
  setSendProgress(0);
  try {
    await sendTransfer(transfer);
  } catch (error) {
    $("sendStatus").textContent = error.message || "Transmission failed.";
  } finally {
    sending = false;
    sendButton.disabled = false;
    chooseFileButton.disabled = false;
  }
});

function stopReceiver() {
  if (!receiver) return;
  receiver.stopped = true;
  try { receiver.processor.disconnect(); } catch {}
  try { receiver.source.disconnect(); } catch {}
  if (receiver.stream) receiver.stream.getTracks().forEach(track => track.stop());
  if (receiver.context && receiver.context.state !== "closed") receiver.context.close();
  receiver = null;
  listenButton.disabled = false;
  stopButton.disabled = true;
}

async function finishReceive() {
  if (!receiver || receiver.finishing) return;
  receiver.finishing = true;
  $("receiveStatus").textContent = "Decoding audio frames and checking for errors...";
  const active = receiver;
  const samples = new Float32Array(active.blocks.reduce((sum, block) => sum + block.length, 0));
  let cursor = 0;
  for (const block of active.blocks) {
    samples.set(block, cursor);
    cursor += block.length;
  }

  try {
    const packet = decodeFrames(samples, active.context.sampleRate);
    const result = decodePacket(packet);
    if (result.metadata.kind === "text") {
      received.value = new TextDecoder("utf-8", { fatal: true }).decode(result.payload);
      copyButton.disabled = false;
      downloadButton.hidden = true;
      downloadButton.disabled = true;
      $("receiveStatus").textContent = "Message successfully received and verified.";
    } else {
      if (currentDownloadUrl) URL.revokeObjectURL(currentDownloadUrl);
      const blob = new Blob([result.payload], { type: result.metadata.type || "application/octet-stream" });
      currentDownloadUrl = URL.createObjectURL(blob);
      received.value = `Received file: ${result.metadata.name}\nSize: ${Math.ceil(blob.size / 1024)} KB\nThe file passed its frame checks and is ready to download.`;
      copyButton.disabled = true;
      downloadButton.hidden = false;
      downloadButton.disabled = false;
      downloadButton.textContent = `Download ${result.metadata.name}`;
      downloadButton.dataset.filename = result.metadata.name;
      $("receiveStatus").textContent = "File successfully received and verified.";
    }
  } catch (error) {
    $("receiveStatus").textContent = `Unable to decode: ${error.message}`;
  } finally {
    stopReceiver();
  }
}

listenButton.addEventListener("click", async () => {
  if (!navigator.mediaDevices?.getUserMedia) {
    $("receiveStatus").textContent = "Microphone access requires HTTPS and a supported browser.";
    return;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false }
    });
    const context = makeAudioContext();
    await context.resume();
    const source = context.createMediaStreamSource(stream);
    const processor = context.createScriptProcessor(4096, 1, 1);
    const silent = context.createGain();
    silent.gain.value = 0;
    source.connect(processor);
    processor.connect(silent);
    silent.connect(context.destination);

    receiver = {
      stream, context, source, processor, blocks: [], state: "listening",
      callHits: 0, trainingHits: 0, endHits: 0, finishing: false, stopped: false, blockSamples: 0, startedAt: Date.now()
    };

    processor.onaudioprocess = event => {
      if (!receiver || receiver.stopped || receiver !== activeReceiver) return;
      const block = new Float32Array(event.inputBuffer.getChannelData(0));
      receiver.blocks.push(block);
      receiver.blockSamples += block.length;
      // Keep the receiver bounded to roughly 12 minutes of mono audio.
      if (receiver.blockSamples > context.sampleRate * 60 * 12) {
        $("receiveStatus").textContent = "Listening limit reached. Stop and restart before another transfer.";
        stopReceiver();
        return;
      }

      if (receiver.state === "listening") {
        receiver.callHits = detectTone(block, context.sampleRate, CALL_TONE) ? receiver.callHits + 1 : 0;
        if (receiver.callHits >= 2) {
          receiver.state = "training";
          // Discard idle listening history; keep the answer, training, and data.
          receiver.blocks = [];
          receiver.blockSamples = 0;
          $("receiveStatus").textContent = "Incoming call detected. Sending modem answer...";
          playTone(context, ANSWER_TONE, 1.05, 0.2);
        }
      } else if (receiver.state === "training") {
        receiver.trainingHits = detectTone(block, context.sampleRate, TRAINING_MARKER) ? receiver.trainingHits + 1 : 0;
        if (receiver.trainingHits >= 2) {
          receiver.state = "receiving";
          $("receiveStatus").textContent = "Modem handshake complete. Receiving data...";
          playTone(context, READY_TONE, 0.42, 0.2);
        }
      } else if (receiver.state === "receiving") {
        receiver.endHits = detectTone(block, context.sampleRate, END_TONE) ? receiver.endHits + 1 : 0;
        if (receiver.endHits >= 2) finishReceive();
      }
    };

    const activeReceiver = receiver;
    listenButton.disabled = true;
    stopButton.disabled = false;
    $("receiveStatus").textContent = "Listening for the VoiceFax calling tone... Keep this page open.";
  } catch (error) {
    $("receiveStatus").textContent = error.message || "Could not access the microphone.";
  }
});

stopButton.addEventListener("click", () => {
  if (receiver) {
    $("receiveStatus").textContent = "Listening stopped.";
    stopReceiver();
  }
});

copyButton.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(received.value);
    $("receiveStatus").textContent = "Message copied!";
  } catch {
    $("receiveStatus").textContent = "Clipboard access unavailable.";
  }
});

downloadButton.addEventListener("click", () => {
  if (!currentDownloadUrl) return;
  const link = document.createElement("a");
  link.href = currentDownloadUrl;
  link.download = downloadButton.dataset.filename || "voicefax-file";
  document.body.appendChild(link);
  link.click();
  link.remove();
});

window.addEventListener("beforeunload", () => {
  if (receiver) stopReceiver();
  if (currentDownloadUrl) URL.revokeObjectURL(currentDownloadUrl);
});
