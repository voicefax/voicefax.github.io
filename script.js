
const $ = id => document.getElementById(id);

const photoInput = $("photoInput");
const preview = $("preview");
const sendButton = $("sendButton");
const listenButton = $("listenButton");
const stopButton = $("stopButton");

const sendStatus = $("sendStatus");
const receiveStatus = $("receiveStatus");

const sendProgress = $("sendProgress");
const sendPercent = $("sendPercent");

let selectedPhoto = null;
let mediaRecorder = null;
let recordedChunks = [];
let microphoneStream = null;
let sending = false;

const SAMPLE_RATE = 48000;
const SYMBOL_TIME = 0.060;
const TONE_TIME = 0.048;
const BASE_FREQUENCY = 1100;
const FREQUENCY_STEP = 400;

const TONES = [1100, 1500, 1900, 2300];

function crc32(bytes) {
  let crc = 0xffffffff;

  for (const byte of bytes) {
    crc ^= byte;

    for (let i = 0; i < 8; i++) {
      crc = (crc >>> 1) ^ (
        (crc & 1) ? 0xedb88320 : 0
      );
    }
  }

  return (crc ^ 0xffffffff) >>> 0;
}

// Convert a byte into four 2-bit audio symbols.
function bytesToSymbols(bytes) {
  const symbols = [];

  for (const byte of bytes) {
    symbols.push(
      (byte >> 6) & 3,
      (byte >> 4) & 3,
      (byte >> 2) & 3,
      byte & 3
    );
  }

  return symbols;
}

// Convert audio symbols back into bytes.
function symbolsToBytes(symbols) {
  if (symbols.length % 4 !== 0) {
    throw new Error("Incomplete transmission.");
  }

  const bytes = [];

  for (let i = 0; i < symbols.length; i += 4) {
    bytes.push(
      (symbols[i] << 6) |
      (symbols[i + 1] << 4) |
      (symbols[i + 2] << 2) |
      symbols[i + 3]
    );
  }

  return new Uint8Array(bytes);
}

// Compress the selected photograph.
async function compressPhoto(file) {
  const bitmap = await createImageBitmap(file);

  const canvas = document.createElement("canvas");
  canvas.width = 96;
  canvas.height = 96;

  const ctx = canvas.getContext("2d");

  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, 96, 96);

  const scale = Math.min(
    96 / bitmap.width,
    96 / bitmap.height
  );

  const width = bitmap.width * scale;
  const height = bitmap.height * scale;

  ctx.drawImage(
    bitmap,
    (96 - width) / 2,
    (96 - height) / 2,
    width,
    height
  );

  bitmap.close();

  const blob = await new Promise(resolve => {
    canvas.toBlob(resolve, "image/jpeg", 0.50);
  });

  if (!blob) {
    throw new Error("Could not compress photograph.");
  }

  return new Uint8Array(await blob.arrayBuffer());
}

// Create the VoiceFax transmission packet.
function createPacket(imageBytes) {
  const packet = new Uint8Array(12 + imageBytes.length);

  // VoiceFax identifier: VFX1
  packet.set([86, 70, 88, 49], 0);

  // Four-byte image length.
  const view = new DataView(packet.buffer);
  view.setUint32(4, imageBytes.length, false);

  // Photograph.
  packet.set(imageBytes, 8);

  // Checksum.
  const checksum = crc32(imageBytes);
  view.setUint32(8 + imageBytes.length, checksum, false);

  return packet;
}

// Transmit the packet as audible sound.
async function transmit(packet) {
  const symbols = [
    ...Array.from(
      { length: 16 },
      (_, i) => i % 2 === 0 ? 0 : 3
    ),
    ...bytesToSymbols(packet)
  ];

  const AudioContextClass =
    window.AudioContext || window.webkitAudioContext;

  const context = new AudioContextClass();

  await context.resume();

  const oscillator = context.createOscillator();
  const gain = context.createGain();

  oscillator.type = "sine";
  gain.gain.value = 0.0001;

  oscillator.connect(gain);
  gain.connect(context.destination);

  const start = context.currentTime + 0.7;

  oscillator.start(start);

  symbols.forEach((symbol, index) => {
    const time = start + index * SYMBOL_TIME;

    oscillator.frequency.setValueAtTime(
      TONES[symbol],
      time
    );

    gain.gain.setValueAtTime(0.0001, time);

    gain.gain.linearRampToValueAtTime(
      0.18,
      time + 0.003
    );

    gain.gain.setValueAtTime(
      0.18,
      time + TONE_TIME - 0.003
    );

    gain.gain.linearRampToValueAtTime(
      0.0001,
      time + TONE_TIME
    );
  });

  const duration = symbols.length * SYMBOL_TIME;

  let progressTimer = setInterval(() => {
    const elapsed = context.currentTime - start;
    const percent = Math.min(
      100,
      Math.max(0, Math.floor(elapsed / duration * 100))
    );

    sendProgress.value = percent;
    sendPercent.textContent = percent + "%";
    sendStatus.textContent = "Transmitting audio signals...";
  }, 250);

  await new Promise(resolve => {
    setTimeout(resolve, (duration + 0.8) * 1000);
  });

  clearInterval(progressTimer);

  oscillator.stop();
  await context.close();

  sendProgress.value = 100;
  sendPercent.textContent = "100%";
}

// Photograph selection.
photoInput.addEventListener("change", async () => {
  const file = photoInput.files[0];

  if (!file) return;

  if (!file.type.startsWith("image/")) {
    sendStatus.textContent = "Please select an image.";
    return;
  }

  try {
    const url = URL.createObjectURL(file);

    preview.src = url;
    preview.style.display = "block";

    selectedPhoto = file;
    sendButton.disabled = false;

    sendStatus.textContent = "Photograph ready to transmit.";
    sendProgress.value = 0;
    sendPercent.textContent = "0%";
  } catch (error) {
    sendStatus.textContent = error.message;
  }
});

// Send photograph.
sendButton.addEventListener("click", async () => {
  if (!selectedPhoto || sending) return;

  sending = true;
  sendButton.disabled = true;

  try {
    sendStatus.textContent = "Preparing photograph...";

    const imageBytes = await compressPhoto(selectedPhoto);

    const packet = createPacket(imageBytes);

    sendStatus.textContent =
      `Compressed image: ${imageBytes.length} bytes. Preparing audio...`;

    await transmit(packet);

    sendStatus.textContent =
      "Transmission finished! Check the receiving device.";

  } catch (error) {
    sendStatus.textContent = "Transmission error: " + error.message;
  } finally {
    sending = false;
    sendButton.disabled = false;
  }
});

// Start microphone recording.
listenButton.addEventListener("click", async () => {
  try {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error("Microphone access requires HTTPS.");
    }

    microphoneStream =
      await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false
        }
      });

    recordedChunks = [];

    mediaRecorder = new MediaRecorder(microphoneStream);

    mediaRecorder.ondataavailable = event => {
      if (event.data.size > 0) {
        recordedChunks.push(event.data);
      }
    };

    mediaRecorder.start();

    listenButton.disabled = true;
    stopButton.disabled = false;

    receiveStatus.textContent =
      "Listening for VoiceFax signals...";

    $("receivedImage").style.display = "none";
    $("downloadButton").hidden = true;

  } catch (error) {
    receiveStatus.textContent =
      "Microphone error: " + error.message;
  }
});

// Stop recording and decode.
stopButton.addEventListener("click", async () => {
  if (!mediaRecorder || mediaRecorder.state !== "recording") {
    return;
  }

  stopButton.disabled = true;

  receiveStatus.textContent = "Processing audio...";

  const finished = new Promise(resolve => {
    mediaRecorder.onstop = resolve;
  });

  mediaRecorder.stop();

  await finished;

  microphoneStream.getTracks().forEach(track => track.stop());

  listenButton.disabled = false;

  try {
    const blob = new Blob(recordedChunks, {
      type: mediaRecorder.mimeType
    });

    const audioContext = new (
      window.AudioContext || window.webkitAudioContext
    )();

    const audioBuffer = await audioContext.decodeAudioData(
      await blob.arrayBuffer()
    );

    const imageBytes = decodeTransmission(audioBuffer);

    const imageBlob = new Blob([imageBytes], {
      type: "image/jpeg"
    });

    const imageURL = URL.createObjectURL(imageBlob);

    $("receivedImage").src = imageURL;
    $("receivedImage").style.display = "block";

    const download = $("downloadButton");

    download.href = imageURL;
    download.hidden = false;

    receiveStatus.textContent =
      "Photograph successfully reconstructed!";

    await audioContext.close();

  } catch (error) {
    receiveStatus.textContent =
      "Could not decode transmission: " + error.message;
  }
});

// Detect a transmitted audio symbol using Goertzel frequency analysis.
function detectSymbol(samples, start, sampleRate) {
  const length = Math.floor(sampleRate * 0.012);

  if (start < 0 || start + length > samples.length) {
    return -1;
  }

  let bestSymbol = -1;
  let bestPower = 0;

  for (let symbol = 0; symbol < 4; symbol++) {
    const frequency = TONES[symbol];

    const coefficient =
      2 * Math.cos(2 * Math.PI * frequency / sampleRate);

    let s1 = 0;
    let s2 = 0;

    for (let i = 0; i < length; i++) {
      const s0 =
        samples[start + i] +
        coefficient * s1 - s2;

      s2 = s1;
      s1 = s0;
    }

    const power =
      s1 * s1 + s2 * s2 - coefficient * s1 * s2;

    if (power > bestPower) {
      bestPower = power;
      bestSymbol = symbol;
    }
  }

  return bestPower > 0.00001 ? bestSymbol : -1;
}

// Find the beginning of the VoiceFax transmission.
function findPreamble(samples, sampleRate) {
  const sync = Array.from(
    { length: 16 },
    (_, i) => i % 2 === 0 ? 0 : 3
  );

  const symbolSamples = Math.round(
    SYMBOL_TIME * sampleRate
  );

  const center = Math.round(
    0.024 * sampleRate
  );

  const maxOffset = Math.min(
    4 * sampleRate,
    samples.length - 16 * symbolSamples
  );

  for (
    let offset = 0;
    offset < maxOffset;
    offset += Math.round(0.003 * sampleRate)
  ) {
    let matches = 0;

    for (let i = 0; i < sync.length; i++) {
      const position =
        offset + i * symbolSamples + center;

      const detected = detectSymbol(
        samples,
        position,
        sampleRate
      );

      if (detected === sync[i]) {
        matches++;
      }

      if (matches + sync.length - i - 1 < 14) {
        break;
      }
    }

    if (matches >= 14) {
      return offset;
    }
  }

  throw new Error("VoiceFax synchronization signal not found.");
}

// Read a sequence of symbols from a recording.
function readSymbols(
  samples,
  sampleRate,
  offset,
  count
) {
  const result = [];

  const symbolSamples = Math.round(
    SYMBOL_TIME * sampleRate
  );

  const center = Math.round(
    0.024 * sampleRate
  );

  for (let i = 0; i < count; i++) {
    const position =
      offset + i * symbolSamples + center;

    const symbol = detectSymbol(
      samples,
      position,
      sampleRate
    );

    if (symbol < 0) {
      throw new Error("Missing audio data.");
    }

    result.push(symbol);
  }

  return result;
}

// Reconstruct and verify the photograph.
function decodeTransmission(audioBuffer) {
  const channels = [];

  for (let i = 0; i < audioBuffer.numberOfChannels; i++) {
    channels.push(audioBuffer.getChannelData(i));
  }

  const samples = new Float32Array(channels[0].length);

  for (let i = 0; i < samples.length; i++) {
    let total = 0;

    for (const channel of channels) {
      total += channel[i];
    }

    samples[i] = total / channels.length;
  }

  const sampleRate = audioBuffer.sampleRate;

  const offset = findPreamble(samples, sampleRate);

  const dataOffset =
    offset + 16 * Math.round(SYMBOL_TIME * sampleRate);

  // Read the eight-byte header.
  const headerSymbols = readSymbols(
    samples,
    sampleRate,
    dataOffset,
    32
  );

  const header = symbolsToBytes(headerSymbols);

  if (
    header[0] !== 86 ||
    header[1] !== 70 ||
    header[2] !== 88 ||
    header[3] !== 49
  ) {
    throw new Error("Invalid VoiceFax header.");
  }

  const headerView = new DataView(
    header.buffer,
    header.byteOffset,
    header.byteLength
  );

  const length = headerView.getUint32(4, false);

  if (length < 1 || length > 100000) {
    throw new Error("Invalid photograph size.");
  }

  const totalBytes = 12 + length;
  const totalSymbols = totalBytes * 4;

  const allSymbols = readSymbols(
    samples,
    sampleRate,
    dataOffset,
    totalSymbols
  );

  const packet = symbolsToBytes(allSymbols);

  const imageBytes = packet.slice(8, 8 + length);

  const packetView = new DataView(
    packet.buffer,
    packet.byteOffset,
    packet.byteLength
  );

  const receivedChecksum = packetView.getUint32(
    8 + length,
    false
  );

  const calculatedChecksum = crc32(imageBytes);

  if (receivedChecksum !== calculatedChecksum) {
    throw new Error("Checksum failed. Audio may have been interrupted.");
  }

  return imageBytes;
}
