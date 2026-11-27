
const $ = id => document.getElementById(id);

const input = $("messageInput");
const received = $("receivedMessage");
const sendButton = $("sendButton");
const listenButton = $("listenButton");
const stopButton = $("stopButton");
const copyButton = $("copyButton");

const SAMPLE_RATE = 48000;
const SYMBOL_TIME = 0.080;
const TONE_TIME = 0.060;

const TONES = [1100, 1500, 1900, 2300];

let recorder;
let stream;
let chunks = [];
let sending = false;

input.addEventListener("input", () => {
  $("counter").textContent = `${input.value.length} / 500`;
});

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

function symbolsToBytes(symbols) {
  if (symbols.length % 4 !== 0) {
    throw new Error("Incomplete message.");
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

function createPacket(message) {
  const encoder = new TextEncoder();
  const data = encoder.encode(message);

  const packet = new Uint8Array(12 + data.length);
  const view = new DataView(packet.buffer);

  packet.set([86, 70, 88, 49], 0);

  view.setUint32(4, data.length, false);

  packet.set(data, 8);

  view.setUint32(
    8 + data.length,
    crc32(data),
    false
  );

  return packet;
}

async function transmit(packet) {
  const symbols = [
    ...Array.from(
      { length: 16 },
      (_, i) => i % 2 === 0 ? 0 : 3
    ),
    ...bytesToSymbols(packet)
  ];

  const AudioClass =
    window.AudioContext || window.webkitAudioContext;

  const context = new AudioClass();

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

  const timer = setInterval(() => {
    const percent = Math.min(
      100,
      Math.floor(
        (context.currentTime - start) / duration * 100
      )
    );

    $("sendProgress").value = percent;
    $("sendPercent").textContent = percent + "%";
    $("sendStatus").textContent = "Transmitting audio...";
  }, 200);

  await new Promise(resolve => {
    setTimeout(resolve, (duration + 0.8) * 1000);
  });

  clearInterval(timer);

  oscillator.stop();
  await context.close();

  $("sendProgress").value = 100;
  $("sendPercent").textContent = "100%";
}

sendButton.addEventListener("click", async () => {
  const message = input.value;

  if (!message.trim() || sending) {
    $("sendStatus").textContent = "Enter a message first.";
    return;
  }

  sending = true;
  sendButton.disabled = true;

  try {
    $("sendStatus").textContent = "Preparing message...";

    const packet = createPacket(message);

    await transmit(packet);

    $("sendStatus").textContent =
      "Transmission completed!";

  } catch (error) {
    $("sendStatus").textContent = error.message;
  } finally {
    sending = false;
    sendButton.disabled = false;
  }
});

// Frequency detector.
function detectSymbol(samples, start, sampleRate) {
  const length = Math.floor(sampleRate * 0.012);

  if (start < 0 || start + length > samples.length) {
    return -1;
  }

  let best = -1;
  let bestPower = 0;

  for (let symbol = 0; symbol < 4; symbol++) {
    const coefficient = 2 * Math.cos(
      2 * Math.PI * TONES[symbol] / sampleRate
    );

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
      s1 * s1 + s2 * s2 -
      coefficient * s1 * s2;

    if (power > bestPower) {
      bestPower = power;
      best = symbol;
    }
  }

  return bestPower > 0.00001 ? best : -1;
}

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
      const detected = detectSymbol(
        samples,
        offset + i * symbolSamples + center,
        sampleRate
      );

      if (detected === sync[i]) {
        matches++;
      }
    }

    if (matches >= 14) {
      return offset;
    }
  }

  throw new Error("No VoiceFax signal found.");
}

function readSymbols(samples, sampleRate, offset, count) {
  const symbols = [];

  const symbolSamples = Math.round(
    SYMBOL_TIME * sampleRate
  );

  const center = Math.round(
    0.024 * sampleRate
  );

  for (let i = 0; i < count; i++) {
    const symbol = detectSymbol(
      samples,
      offset + i * symbolSamples + center,
      sampleRate
    );

    if (symbol < 0) {
      throw new Error("Audio signal interrupted.");
    }

    symbols.push(symbol);
  }

  return symbols;
}

function decodeAudio(buffer) {
  const samples = buffer.getChannelData(0);
  const rate = buffer.sampleRate;

  const offset = findPreamble(samples, rate);

  const dataOffset =
    offset + 16 * Math.round(SYMBOL_TIME * rate);

  const headerSymbols = readSymbols(
    samples,
    rate,
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
    throw new Error("Invalid VoiceFax transmission.");
  }

  const view = new DataView(header.buffer);

  const length = view.getUint32(4, false);

  if (length < 1 || length > 2000) {
    throw new Error("Invalid message length.");
  }

  const totalBytes = 12 + length;

  const symbols = readSymbols(
    samples,
    rate,
    dataOffset,
    totalBytes * 4
  );

  const packet = symbolsToBytes(symbols);

  const messageBytes = packet.slice(8, 8 + length);

  const packetView = new DataView(
    packet.buffer,
    packet.byteOffset,
    packet.byteLength
  );

  const expectedChecksum = packetView.getUint32(
    8 + length,
    false
  );

  if (crc32(messageBytes) !== expectedChecksum) {
    throw new Error("Message checksum failed.");
  }

  return new TextDecoder("utf-8", {
    fatal: true
  }).decode(messageBytes);
}

// Start receiving.
listenButton.addEventListener("click", async () => {
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false
      }
    });

    chunks = [];

    recorder = new MediaRecorder(stream);

    recorder.ondataavailable = event => {
      if (event.data.size > 0) {
        chunks.push(event.data);
      }
    };

    recorder.start();

    listenButton.disabled = true;
    stopButton.disabled = false;

    $("receiveStatus").textContent =
      "Listening for incoming messages...";

  } catch (error) {
    $("receiveStatus").textContent = error.message;
  }
});

// Stop and decode.
stopButton.addEventListener("click", async () => {
  if (!recorder || recorder.state !== "recording") return;

  stopButton.disabled = true;

  const finished = new Promise(resolve => {
    recorder.onstop = resolve;
  });

  recorder.stop();

  await finished;

  stream.getTracks().forEach(track => track.stop());

  listenButton.disabled = false;

  try {
    $("receiveStatus").textContent = "Decoding message...";

    const blob = new Blob(chunks, {
      type: recorder.mimeType
    });

    const context = new (
      window.AudioContext || window.webkitAudioContext
    )();

    const audio = await context.decodeAudioData(
      await blob.arrayBuffer()
    );

    const message = decodeAudio(audio);

    received.value = message;

    copyButton.disabled = false;

    $("receiveStatus").textContent =
      "Message successfully received!";

    await context.close();

  } catch (error) {
    $("receiveStatus").textContent =
      "Unable to decode: " + error.message;
  }
});

// Copy received message.
copyButton.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(received.value);
    $("receiveStatus").textContent = "Message copied!";
  } catch {
    $("receiveStatus").textContent =
      "Clipboard access unavailable.";
  }
});
