
const fileInput = document.getElementById("fileInput");
const fileName = document.getElementById("fileName");
const documentText = document.getElementById("documentText");

const voiceSelect = document.getElementById("voiceSelect");
const speedSelect = document.getElementById("speedSelect");

const transmitButton = document.getElementById("transmitButton");
const pauseButton = document.getElementById("pauseButton");
const stopButton = document.getElementById("stopButton");

const mainStatus = document.getElementById("mainStatus");
const statusMessage = document.getElementById("statusMessage");
const connectionStatus = document.getElementById("connectionStatus");

let voices = [];
let transmissionQueue = [];
let currentIndex = 0;
let transmitting = false;
let paused = false;
let transmissionId = 0;


// ------------------------------------
// SYSTEM STATUS
// ------------------------------------

function setStatus(status, message, connection = "STANDBY") {
    mainStatus.textContent = status;
    statusMessage.textContent = message;
    connectionStatus.textContent = connection;
}


// ------------------------------------
// LOAD AVAILABLE VOICES
// ------------------------------------

function loadVoices() {
    voices = speechSynthesis.getVoices();

    const previousVoice = voiceSelect.value;

    voiceSelect.innerHTML = "";

    if (voices.length === 0) {
        const option = document.createElement("option");
        option.textContent = "Default system voice";
        option.value = "";
        voiceSelect.appendChild(option);
        return;
    }

    voices.forEach((voice, index) => {
        const option = document.createElement("option");

        option.value = index;
        option.textContent =
            voice.name + " (" + voice.lang + ")";

        voiceSelect.appendChild(option);
    });

    if (previousVoice !== "" &&
        voices[Number(previousVoice)]) {
        voiceSelect.value = previousVoice;
    } else {
        const englishVoice = voices.findIndex(
            voice => voice.lang.toLowerCase().startsWith("en")
        );

        if (englishVoice !== -1) {
            voiceSelect.value = englishVoice;
        }
    }
}

loadVoices();

speechSynthesis.onvoiceschanged = loadVoices;


// ------------------------------------
// DOCUMENT UPLOAD
// ------------------------------------

fileInput.addEventListener("change", async function(event) {

    const file = event.target.files[0];

    if (!file) return;

    stopTransmission();

    fileName.textContent = file.name;

    setStatus(
        "READING",
        "Processing document..."
    );

    try {

        if (file.name.toLowerCase().endsWith(".txt")) {

            documentText.value = await file.text();

        } else if (file.name.toLowerCase().endsWith(".pdf")) {

            await loadPDF(file);

        } else {

            throw new Error("Unsupported document format.");

        }

        if (!documentText.value.trim()) {
            throw new Error("No readable text was found.");
        }

        setStatus(
            "READY",
            "Document successfully loaded."
        );

    } catch (error) {

        documentText.value = "";

        setStatus(
            "ERROR",
            error.message
        );

    }

});


// ------------------------------------
// PDF READER
// ------------------------------------

async function loadPDF(file) {

    if (!window.pdfjsLib) {

        setStatus(
            "LOADING",
            "Loading PDF reader..."
        );

        await new Promise((resolve, reject) => {

            const script = document.createElement("script");

            script.src =
                "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js";

            script.onload = resolve;

            script.onerror = () => {
                reject(new Error("Could not load PDF reader."));
            };

            document.head.appendChild(script);

        });

        pdfjsLib.GlobalWorkerOptions.workerSrc =
            "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
    }

    const buffer = await file.arrayBuffer();

    const pdf = await pdfjsLib.getDocument({
        data: new Uint8Array(buffer)
    }).promise;

    let extractedText = "";

    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {

        setStatus(
            "READING",
            "Reading page " + pageNumber + " of " + pdf.numPages
        );

        const page = await pdf.getPage(pageNumber);

        const content = await page.getTextContent();

        const pageText = content.items
            .map(item => item.str)
            .join(" ");

        extractedText +=
            "\n\nPage " + pageNumber + ".\n\n" +
            pageText;
    }

    documentText.value = extractedText.trim();
}


// ------------------------------------
// PREPARE TRANSMISSION
// ------------------------------------

function prepareTransmission(text) {

    const cleanedText = text
        .replace(/\r/g, "")
        .replace(/[ \t]+/g, " ")
        .trim();

    const paragraphs = cleanedText
        .split(/\n\s*\n/)
        .filter(paragraph => paragraph.trim());

    let messages = [];

    messages.push(
        "Beginning VoiceFax document transmission."
    );

    messages.push(
        "Please listen carefully. The following is a spoken document."
    );

    paragraphs.forEach((paragraph, index) => {

        const parts = paragraph.match(/[^.!?]+[.!?]+|[^.!?]+$/g) || [paragraph];

        let currentMessage = "";

        parts.forEach(sentence => {

            sentence = sentence.trim();

            if (!sentence) return;

            if ((currentMessage + " " + sentence).length > 450) {

                messages.push(currentMessage.trim());

                currentMessage = sentence;

            } else {

                currentMessage += " " + sentence;

            }

        });

        if (currentMessage.trim()) {
            messages.push(currentMessage.trim());
        }

    });

    messages.push(
        "End of VoiceFax document transmission. Thank you."
    );

    return messages;
}


// ------------------------------------
// SPEECH ENGINE
// ------------------------------------

function speakNext() {

    if (!transmitting || paused) return;

    if (currentIndex >= transmissionQueue.length) {

        transmitting = false;

        setStatus(
            "COMPLETE",
            "Document transmission finished."
        );

        transmitButton.disabled = false;
        pauseButton.disabled = true;
        stopButton.disabled = true;

        return;
    }

    const id = transmissionId;

    const message = transmissionQueue[currentIndex];

    const utterance = new SpeechSynthesisUtterance(message);

    const selectedVoice = voices[Number(voiceSelect.value)];

    if (selectedVoice) {
        utterance.voice = selectedVoice;
    }

    utterance.rate = Number(speedSelect.value);
    utterance.pitch = 1;
    utterance.volume = 1;

    setStatus(
        "TRANSMITTING",
        "Speaking section " +
        (currentIndex + 1) +
        " of " +
        transmissionQueue.length,
        "ACTIVE"
    );

    utterance.onend = function() {

        if (id !== transmissionId) return;

        if (!transmitting || paused) return;

        currentIndex++;

        speakNext();
    };

    utterance.onerror = function(event) {

        if (id !== transmissionId) return;

        if (event.error === "canceled" ||
            event.error === "interrupted") {
            return;
        }

        transmitting = false;

        setStatus(
            "ERROR",
            "Speech playback encountered an error."
        );

        transmitButton.disabled = false;
        pauseButton.disabled = true;
        stopButton.disabled = true;
    };

    speechSynthesis.speak(utterance);
}


// ------------------------------------
// START TRANSMISSION
// ------------------------------------

transmitButton.addEventListener("click", function() {

    const text = documentText.value.trim();

    if (!text) {

        setStatus(
            "ERROR",
            "Please upload or enter a document first."
        );

        return;
    }

    stopTransmission();

    transmissionQueue = prepareTransmission(text);

    currentIndex = 0;

    transmitting = true;
    paused = false;

    transmitButton.disabled = true;
    pauseButton.disabled = false;
    stopButton.disabled = false;

    pauseButton.textContent = "PAUSE";

    setStatus(
        "CONNECTING",
        "Preparing document transmission...",
        "ACTIVE"
    );

    // Allow the browser to initialize speech playback.
    setTimeout(() => {

        if (transmitting && !paused) {
            speakNext();
        }

    }, 300);

});


// ------------------------------------
// PAUSE / RESUME
// ------------------------------------

pauseButton.addEventListener("click", function() {

    if (!transmitting) return;

    if (!paused) {

        paused = true;

        speechSynthesis.pause();

        pauseButton.textContent = "RESUME";

        setStatus(
            "PAUSED",
            "Transmission temporarily suspended.",
            "PAUSED"
        );

    } else {

        paused = false;

        pauseButton.textContent = "PAUSE";

        speechSynthesis.resume();

        setStatus(
            "TRANSMITTING",
            "Resuming document transmission.",
            "ACTIVE"
        );

    }

});


// ------------------------------------
// STOP TRANSMISSION
// ------------------------------------

function stopTransmission() {

    transmissionId++;

    speechSynthesis.cancel();

    transmitting = false;
    paused = false;

    currentIndex = 0;

    transmitButton.disabled = false;
    pauseButton.disabled = true;
    stopButton.disabled = true;

    pauseButton.textContent = "PAUSE";

    setStatus(
        "READY",
        "Transmission stopped."
    );

}

stopButton.addEventListener("click", stopTransmission);


// ------------------------------------
// INITIALIZE CONTROLS
// ------------------------------------

pauseButton.disabled = true;
stopButton.disabled = true;

setStatus(
    "READY",
    "Awaiting document input."
);
