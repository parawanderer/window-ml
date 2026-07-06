// Must match DEFAULT_CONFIG in background.js
const DEFAULT_CONFIG = {
    chatUrl: "http://localhost:3000/api/chat/completions",
    apiKey: "",
    model: "",
    apiFormat: "openai",
    ocrModel: ""
};

const FIELDS = ["chatUrl", "apiKey", "model", "apiFormat", "ocrModel"];

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

    chrome.runtime.sendMessage({ type: "OLLAMA_UNLOAD", payload: {} }, async (response) => {
        if (chrome.runtime.lastError) {
            setStatus(`Unload failed: ${chrome.runtime.lastError.message}`, "err");
        } else if (response && response.error) {
            setStatus(`Unload failed: ${response.error}`, "err");
        } else if (!response.data.length) {
            setStatus("Nothing was loaded.", "ok");
        } else {
            setStatus(`Unloaded: ${response.data.join(", ")}`, "ok");
        }
        // Eviction is async on the server: right after the unload returns,
        // /api/ps often still lists the model. Poll a few times until VRAM
        // actually drops (or we give up) so the readout reflects reality.
        let models = await refreshVram();
        for (let i = 0; i < 4 && models && models.length; i++) {
            await new Promise(r => setTimeout(r, 500));
            models = await refreshVram();
        }
    });
}

// Renders per-model VRAM usage from Ollama's /api/ps (used only — Ollama's API
// doesn't report total GPU capacity, so there's no denominator to show).
function renderVram(models) {
    if (!models.length) {
        $("vram").textContent = "Nothing loaded.";
        return;
    }
    const usedGB = models.reduce((sum, m) => sum + (m.vramGB || 0), 0);
    const list = models.map(m => `• ${m.model} — ${m.vramGB ?? "?"} GB`).join("\n");
    $("vram").textContent = `${usedGB.toFixed(1)} GB in use\n${list}`;
}

// Resolves to the loaded-model list (so callers can poll after an unload), or
// null when there's no Ollama backend to report on.
function refreshVram() {
    return new Promise((resolve) => {
        chrome.runtime.sendMessage({ type: "OLLAMA_PS", payload: {} }, (response) => {
            // No Ollama backend (e.g. a cloud-only setup) — hide the section
            // entirely rather than showing an error for something that doesn't apply.
            if (chrome.runtime.lastError || (response && response.error)) {
                $("vramSection").style.display = "none";
                resolve(null);
                return;
            }
            $("vramSection").style.display = "block";
            const models = response.data || [];
            renderVram(models);
            resolve(models);
        });
    });
}

$("save").addEventListener("click", save);
$("unload").addEventListener("click", freeVram);
$("test").addEventListener("click", saveAndTest);
$("loadModels").addEventListener("click", loadModels);
$("refreshVram").addEventListener("click", refreshVram);

loadForm();
refreshVram();
