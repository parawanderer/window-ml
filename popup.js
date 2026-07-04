// Must match DEFAULT_CONFIG in background.js
const DEFAULT_CONFIG = {
    chatUrl: "http://localhost:3000/api/chat/completions",
    apiKey: "",
    model: "",
    apiFormat: "openai",
    ocrUrl: ""
};

const FIELDS = ["chatUrl", "apiKey", "model", "apiFormat", "ocrUrl"];

const $ = (id) => document.getElementById(id);
const statusEl = () => $("status");

function setStatus(text, kind) {
    statusEl().textContent = text;
    statusEl().className = kind || "";
}

function readForm() {
    const config = {};
    for (const field of FIELDS) {
        config[field] = $(field).value.trim();
    }
    return config;
}

async function loadForm() {
    const config = await chrome.storage.sync.get(DEFAULT_CONFIG);
    for (const field of FIELDS) {
        $(field).value = config[field];
    }
}

async function save() {
    await chrome.storage.sync.set(readForm());
    setStatus("Saved.", "ok");
}

// Model-list fetching lives in background.js (listAvailableModels); the
// current form values are passed as overrides so Load works before saving.
function loadModels() {
    const { chatUrl, apiKey } = readForm();
    setStatus("Loading models…", "busy");

    chrome.runtime.sendMessage(
        { type: "LIST_MODELS", payload: { chatUrl, apiKey } },
        (response) => {
            if (chrome.runtime.lastError) {
                setStatus(`Failed to load models: ${chrome.runtime.lastError.message}`, "err");
                return;
            }
            if (response && response.error) {
                setStatus(`Failed to load models: ${response.error}`, "err");
                return;
            }

            const models = response.data;
            const list = $("modelList");
            list.replaceChildren(...models.map(id => {
                const opt = document.createElement("option");
                opt.value = id;
                return opt;
            }));

            if (!$("model").value) $("model").value = models[0];
            setStatus(`${models.length} model(s) loaded — pick one in the Model field.`, "ok");
        }
    );
}

// Reflect config changes made while the popup is open (e.g. ml.setModel()).
chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "sync") return;
    for (const field of FIELDS) {
        if (changes[field] && changes[field].newValue !== undefined) {
            $(field).value = changes[field].newValue;
        }
    }
});

async function saveAndTest() {
    await chrome.storage.sync.set(readForm());
    setStatus("Saved. Testing chat endpoint…", "busy");

    chrome.runtime.sendMessage(
        { type: "FETCH_LLM", payload: { messages: [{ role: "user", content: "Reply with exactly: OK" }] } },
        (response) => {
            if (chrome.runtime.lastError) {
                setStatus(`Test failed: ${chrome.runtime.lastError.message}`, "err");
            } else if (response && response.error) {
                setStatus(`Test failed: ${response.error}`, "err");
            } else {
                setStatus(`Test OK — extracted response:\n${response.data}`, "ok");
            }
        }
    );
}

async function freeVram() {
    await chrome.storage.sync.set(readForm());
    setStatus("Unloading models…", "busy");

    chrome.runtime.sendMessage({ type: "OLLAMA_UNLOAD", payload: {} }, (response) => {
        if (chrome.runtime.lastError) {
            setStatus(`Unload failed: ${chrome.runtime.lastError.message}`, "err");
        } else if (response && response.error) {
            setStatus(`Unload failed: ${response.error}`, "err");
        } else if (!response.data.length) {
            setStatus("Nothing was loaded.", "ok");
        } else {
            setStatus(`Unloaded: ${response.data.join(", ")}`, "ok");
        }
    });
}

$("save").addEventListener("click", save);
$("unload").addEventListener("click", freeVram);
$("test").addEventListener("click", saveAndTest);
$("loadModels").addEventListener("click", loadModels);

loadForm();
