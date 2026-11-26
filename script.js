
"use strict";

/* VoiceFax Audio 1.0
   Experimental, non-standard FSK audio file modem.
   The sound carries the bytes; it is not merely an effect.
*/

const $ = id => document.getElementById(id);

const SAMPLE_RATE = 48000;
const BAUD = 1200;
const SAMPLES_PER_BIT = SAMPLE_RATE / BAUD;
const FREQ_ZERO = 1200;
const FREQ_ONE = 2200;
const MAX_FILE_BYTES = 96 * 1024;
const PREAMBLE_BYTES = 80;
const SYNC = [0xD3, 0x91, 0xC5, 0xA7];

let chosenFile = null;
let preparedBlob = null;
let preparedAudioURL = null;
let player = null;
let mediaRecorder = null;
let recordedChunks = [];
let receiveStream = null;
let receivedURL = null;

function setStatus(message, mode = "") {
  $("mainStatus").textContent = message;
  $("statusLight").className = mode;
}

function fmt(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1048576).toFixed(2)} MB`;
}

function crc32(bytes) {
  let c = 0xFFFFFFFF;

  for (const b of bytes) {
    c ^= b;

    for (let k = 0; k < 8; k++) {
      c = (c >>> 1) ^ ((c & 1) ? 0xEDB88320 : 0);
    }
  }

  return (c ^ 0xFFFFFFFF) >>> 0;
}

function pushByteBits(out, value) {
  for (let i = 0; i < 8; i++) {
    out.push((value >>> i) & 1);
  }
}

function makePacket(fileBytes, name, mime) {
  const enc = new TextEncoder();

  const nameBytes = enc.encode(name.slice(0, 180));
  const mimeBytes = enc.encode(
    (mime || "application/octet-stream").slice(0, 100)
  );

  const meta = new Uint8Array(
    2 + nameBytes.length + 1 + mimeBytes.length
  );

  let p = 0;

  meta[p++] = nameBytes.length;
  meta.set(nameBytes, p);
  p += nameBytes.length;

  meta[p++] = mimeBytes.length;
  meta.set(mimeBytes, p);

  const payload = new Uint8Array(
    4 + meta.length + fileBytes.length + 4
  );

  let q = 0;

  payload[q++] = (meta.length >>> 8) & 255;
  payload[q++] = meta.length & 255;

  payload.set(meta, q);
  q += meta.length;

  payload.set(fileBytes, q);
  q += fileBytes.length;

  const crc = crc32(payload.subarray(0, q));

  payload[q++] = (crc >>> 24) & 255;
  payload[q++] = (crc >>> 16) & 255;
  payload[q++] = (crc >>> 8) & 255;
  payload[q++] = crc & 255;

  return payload;
}

function bytesToBits(packet) {
  const bits = [];

  for (let i = 0; i < PREAMBLE_BYTES; i++) {
    pushByteBits(bits, 0x55);
  }

  for (const b of SYNC) {
    pushByteBits(bits, b);
  }

  const len = packet.length;

  pushByteBits(bits, (len >>> 24) & 255);
  pushByteBits(bits, (len >>> 16) & 255);
  pushByteBits(bits, (len >>> 8) & 255);
  pushByteBits(bits, len & 255);

  for (const b of packet) {
    pushByteBits(bits, b);
  }

  for (let i = 0; i < 12; i++) {
    pushByteBits(bits, 0x55);
  }

  return bits;
}

function makeWav(bits) {
  const lead = SAMPLE_RATE * 0.7;
  const tail = SAMPLE_RATE * 0.5;

  const total = lead + bits.length * SAMPLES_PER_BIT + tail;
  const samples = new Float32Array(total);

  let phase = 0;

  for (let i = 0; i < bits.length; i++) {
    const f = bits[i] ? FREQ_ONE : FREQ_ZERO;
    const step = 2 * Math.PI * f / SAMPLE_RATE;
    const start = lead + i * SAMPLES_PER_BIT;

    for (let j = 0; j < SAMPLES_PER_BIT; j++) {
      samples[start + j] = 0.68 * Math.sin(phase);
      phase += step;

      if (phase > Math.PI * 2) {
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

  const str = (off, s) => {
    for (let i = 0; i < s.length; i++) {
      view.setUint8(off + i, s.charCodeAt(i));
    }
  };

  str(0, "RIFF");
  view.setUint32(4, 36 + pcm.length * 2, true);
  str(8, "WAVE");
  str(12, "fmt ");

  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, SAMPLE_RATE, true);
  view.setUint32(28, SAMPLE_RATE * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);

  str(36, "data");
  view.setUint32(40, pcm.length * 2, true);

  for (let i = 0; i < pcm.length; i++) {
    view.setInt16(44 + i * 2, pcm[i], true);
  }

  return new Blob([buffer], { type: "audio/wav" });
}

$("fileInput").addEventListener("change", () => {
  chosenFile = $("fileInput").files?.[0] || null;

  preparedBlob = null;

  $("prepareButton").disabled = !chosenFile;
  $("playButton").disabled = true;
  $("downloadAudioButton").disabled = true;

  if (!chosenFile) {
    $("fileInformation").textContent = "No file selected.";
    return;
  }

  if (chosenFile.size > MAX_FILE_BYTES) {
    $("fileInformation").textContent =
      `File is too large. Maximum size is ${fmt(MAX_FILE_BYTES)} for this experimental audio modem.`;

    chosenFile = null;
    $("prepareButton").disabled = true;
    return;
  }

  $("fileInformation").textContent =
    `${chosenFile.name} · ${fmt(chosenFile.size)} · ${chosenFile.type || "unknown file type"}`;

  setStatus("FILE SELECTED");
});

$("prepareButton").addEventListener("click", async () => {
  if (!chosenFile) return;

  try {
    $("prepareButton").disabled = true;
    $("progressText").textContent = "ENCODING FILE INTO MODEM DATA…";

    setStatus("ENCODING", "busy");

    const bytes = new Uint8Array(
      await chosenFile.arrayBuffer()
    );

    const packet = makePacket(
      bytes,
      chosenFile.name,
      chosenFile.type
    );

    const bits = bytesToBits(packet);

    preparedBlob = makeWav(bits);

    if (preparedAudioURL) {
      URL.revokeObjectURL(preparedAudioURL);
    }

    preparedAudioURL = URL.createObjectURL(preparedBlob);

    $("playButton").disabled = false;
    $("downloadAudioButton").disabled = false;

    const seconds = (bits.length / BAUD).toFixed(1);

    $("progressBar").style.width = "100%";

    $("progressText").textContent =
      `READY · ${fmt(bytes.length)} FILE · APPROX. ${seconds} SECONDS OF AUDIO`;

    setStatus("DOCUMENT ENCODED");

  } catch (e) {
    console.error(e);

    $("progressText").textContent = e.message;
    setStatus("ENCODING ERROR", "error");

  } finally {
    $("prepareButton").disabled = !chosenFile;
  }
});

$("playButton").addEventListener("click", async () => {
  if (!preparedBlob) return;

  if (player) {
    player.pause();
    player = null;
  }

  player = new Audio(preparedAudioURL);

  player.onplay = () => {
    setStatus("TRANSMITTING", "busy");

    $("connectionStatus").textContent =
      "AUDIO MODEM SIGNAL ACTIVE";

    $("progressText").textContent =
      "PLAYING ENCODED FILE DATA…";
  };

  player.ontimeupdate = () => {
    $("progressBar").style.width =
      `${Math.min(100, player.currentTime / player.duration * 100)}%`;
  };

  player.onended = () => {
    setStatus("TRANSMISSION COMPLETE");

    $("connectionStatus").textContent =
      "AUDIO PLAYBACK FINISHED";

    $("progressText").textContent =
      "AUDIO SENT · SWITCH TO RECEIVER TO DECODE";
  };

  try {
    await player.play();

  } catch (e) {
    $("progressText").textContent =
      `Playback error: ${e.message}`;

    setStatus("PLAYBACK ERROR", "error");
  }
});

$("downloadAudioButton").addEventListener("click", () => {
  if (!preparedBlob) return;

  const a = document.createElement("a");

  a.href = preparedAudioURL;
  a.download = `${chosenFile.name}.voicefax.wav`;

  a.click();
});

// RECEIVER

$("recordButton").addEventListener("click", async () => {
  try {
    recordedChunks = [];

    receiveStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        channelCount: 1
      }
    });

    const options = {};

    if (
      MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
    ) {
      options.mimeType = "audio/webm;codecs=opus";
    }

    mediaRecorder = new MediaRecorder(receiveStream, options);

    mediaRecorder.ondataavailable = e => {
      if (e.data.size) {
        recordedChunks.push(e.data);
      }
    };

    mediaRecorder.start(250);

    $("recordButton").disabled = true;
    $("stopRecordButton").disabled = false;

    $("recordInformation").textContent =
      "Recording microphone audio. Play the sender's WAV/audio now.";

    $("receiveStatus").textContent =
      "LISTENING FOR FAX AUDIO";

    setStatus("RECEIVING AUDIO", "busy");

    $("connectionStatus").textContent =
      "MICROPHONE ACTIVE";

  } catch (e) {
    $("recordInformation").textContent =
      `Microphone error: ${e.message}. Check site permission and use HTTPS.`;

    setStatus("MICROPHONE ERROR", "error");
  }
});

$("stopRecordButton").addEventListener("click", () => {
  if (!mediaRecorder || mediaRecorder.state === "inactive") {
    return;
  }

  $("stopRecordButton").disabled = true;

  mediaRecorder.onstop = async () => {
    receiveStream?.getTracks().forEach(t => t.stop());
    receiveStream = null;

    $("recordButton").disabled = false;

    const blob = new Blob(recordedChunks, {
      type: mediaRecorder.mimeType || "audio/webm"
    });

    $("recordInformation").textContent =
      `Recorded ${fmt(blob.size)} of audio. Decoding…`;

    try {
      await decodeRecording(blob);

    } catch (e) {
      console.error(e);

      $("receiveStatus").textContent =
        `DECODE FAILED: ${e.message}`;

      setStatus("DECODE FAILED", "error");
    }
  };

  mediaRecorder.stop();
});

function goertzel(samples, start, n, freq, sampleRate) {
  const k = Math.round(n * freq / sampleRate);
  const w = 2 * Math.PI * k / n;
  const coeff = 2 * Math.cos(w);

  let q0 = 0;
  let q1 = 0;
  let q2 = 0;

  for (let i = 0; i < n; i++) {
    q0 = coeff * q1 - q2 + samples[start + i];
    q2 = q1;
    q1 = q0;
  }

  return q1 * q1 + q2 * q2 - coeff * q1 * q2;
}

function bitsForOffset(samples, offset, sampleRate) {
  const spb = Math.round(sampleRate / BAUD);
  const bits = [];

  for (
    let pos = offset;
    pos + spb <= samples.length;
    pos += spb
  ) {
    const start = pos + 4;
    const n = spb - 8;

    const e0 = goertzel(
      samples, start, n, FREQ_ZERO, sampleRate
    );

    const e1 = goertzel(
      samples, start, n, FREQ_ONE, sampleRate
    );

    bits.push(e1 > e0 ? 1 : 0);
  }

  return bits;
}

function readByte(bits, pos) {
  let v = 0;

  for (let i = 0; i < 8; i++) {
    v |= (bits[pos + i] & 1) << i;
  }

  return v;
}

function findPacket(bits) {
  const syncBits = [];

  for (const b of SYNC) {
    pushByteBits(syncBits, b);
  }

  for (
    let pos = 0;
    pos <= bits.length - syncBits.length - 64;
    pos++
  ) {
    let ok = true;

    for (let j = 0; j < syncBits.length; j++) {
      if (bits[pos + j] !== syncBits[j]) {
        ok = false;
        break;
      }
    }

    if (!ok) continue;

    const lenPos = pos + syncBits.length;

    const len = (
      readByte(bits, lenPos) * 0x1000000 +
      (readByte(bits, lenPos + 8) << 16) +
      (readByte(bits, lenPos + 16) << 8) +
      readByte(bits, lenPos + 24)
    ) >>> 0;

    if (
      len < 8 ||
      len > MAX_FILE_BYTES + 512 ||
      len * 8 > bits.length - (lenPos + 32)
    ) {
      continue;
    }

    const packet = new Uint8Array(len);

    for (let i = 0; i < len; i++) {
      packet[i] = readByte(bits, lenPos + 32 + i * 8);
    }

    const dataEnd = len - 4;

    const expected = (
      packet[dataEnd] * 0x1000000 +
      (packet[dataEnd + 1] << 16) +
      (packet[dataEnd + 2] << 8) +
      packet[dataEnd + 3]
    ) >>> 0;

    if (
      crc32(packet.subarray(0, dataEnd)) !== expected
    ) {
      continue;
    }

    return packet;
  }

  return null;
}

async function decodeRecording(blob) {
  $("receiveStatus").textContent =
    "ANALYZING MODEM SIGNAL…";

  setStatus("DECODING", "busy");

  const audioCtx = new (
    window.AudioContext || window.webkitAudioContext
  )();

  const raw = await blob.arrayBuffer();
  const decoded = await audioCtx.decodeAudioData(raw.slice(0));

  const src = decoded.getChannelData(0);

  let samples = src;

  if (decoded.sampleRate !== SAMPLE_RATE) {
    const outLen = Math.floor(
      src.length * SAMPLE_RATE / decoded.sampleRate
    );

    samples = new Float32Array(outLen);

    for (let i = 0; i < outLen; i++) {
      const x = i * decoded.sampleRate / SAMPLE_RATE;
      const a = Math.floor(x);
      const f = x - a;

      samples[i] =
        (src[a] || 0) * (1 - f) +
        (src[Math.min(a + 1, src.length - 1)] || 0) * f;
    }
  }

  let packet = null;

  for (
    let offset = 0;
    offset < SAMPLES_PER_BIT && !packet;
    offset++
  ) {
    const bits = bitsForOffset(
      samples, offset, SAMPLE_RATE
    );

    packet = findPacket(bits);
  }

  await audioCtx.close();

  if (!packet) {
    throw new Error(
      "No valid packet found. Try a quieter room, move the phones closer, and record the entire playback."
    );
  }

  const metaLen = (packet[0] << 8) | packet[1];
  const meta = packet.subarray(2, 2 + metaLen);

  let p = 0;

  const nameLen = meta[p++];
  const name = new TextDecoder().decode(
    meta.subarray(p, p + nameLen)
  );

  p += nameLen;

  const mimeLen = meta[p++];

  const mime = new TextDecoder().decode(
    meta.subarray(p, p + mimeLen)
  ) || "application/octet-stream";

  const fileStart = 2 + metaLen;
  const fileEnd = packet.length - 4;

  const fileBytes = packet.slice(fileStart, fileEnd);

  const outBlob = new Blob([fileBytes], {
    type: mime
  });

  if (receivedURL) {
    URL.revokeObjectURL(receivedURL);
  }

  receivedURL = URL.createObjectURL(outBlob);

  $("downloadLink").href = receivedURL;
  $("downloadLink").download = name || "received-file";

  $("receivedName").textContent = name || "Received file";

  $("receivedDetails").textContent =
    `${fmt(fileBytes.length)} · ${mime} · CRC verified`;

  $("receivedResult").hidden = false;

  const img = $("imagePreview");

  if (mime.startsWith("image/")) {
    img.src = receivedURL;
    img.hidden = false;
  } else {
    img.hidden = true;
  }

  $("receiveProgress").style.width = "100%";

  $("receiveStatus").textContent =
    "FILE SUCCESSFULLY DECODED · CRC VERIFIED";

  $("recordInformation").textContent =
    "Audio decoded successfully.";

  setStatus("FILE RECEIVED");

  $("connectionStatus").textContent =
    "AUDIO DATA DECODED";
}

// TAB CONTROLS

$("sendTab").addEventListener("click", () => {
  $("sendTab").classList.add("active");
  $("receiveTab").classList.remove("active");

  $("sendPanel").hidden = false;
  $("receivePanel").hidden = true;
});

$("receiveTab").addEventListener("click", () => {
  $("receiveTab").classList.add("active");
  $("sendTab").classList.remove("active");

  $("receivePanel").hidden = false;
  $("sendPanel").hidden = true;
});

setStatus("STANDBY");
