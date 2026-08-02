// Settings popup: reads/writes the extension config (chrome.storage.sync), the
// model picker, Save & Test, VRAM readout, and the theme. Talks to background.ts
// via chrome.runtime for privileged work.
import type { MlConfig, Theme, LoadedModel } from "./contract";
import { DEFAULT_CONFIG, fmtCtx } from "./contract";   // single source of truth (see contract.ts)

// The popup is a QUICK LAUNCHER: connection (the bare minimum to work) + the two
// always-handy toggles (theme, debug panel). Everything else — OCR/utility/grounding/
// model-filter/auto-approve — lives in the workbench Settings. All fields here are
// text/select inputs read via .value; there are no number/checkbox fields anymore.
const FIELDS: (keyof MlConfig)[] = ["chatUrl", "apiKey", "model", "apiFormat", "theme", "debugMode"];

// Every referenced element is an <input>/<select> (or close enough for the props
// we touch: value/checked/textContent/className/style/replaceChildren).
const $ = (id: string) => document.getElementById(id) as HTMLInputElement;
const statusEl = () => $("status");

// --- theme: light/dark/auto → a data-theme attribute the CSS variables key on ---
const themeMedia = window.matchMedia("(prefers-color-scheme: dark)");
const resolveTheme = (pref: Theme): "dark" | "light" =>
    (pref === "light" || pref === "dark") ? pref : (themeMedia.matches ? "dark" : "light");
const applyTheme = (pref: Theme) => { document.documentElement.dataset.theme = resolveTheme(pref); };
// Re-resolve on OS change while in "auto".
themeMedia.addEventListener("change", () => {
    if (($("theme").value || "auto") === "auto") applyTheme("auto");
});

function setStatus(text: string, kind?: string) {
    statusEl().textContent = text;
    statusEl().className = kind || "";
}

function readForm(): Record<string, string> {
    const config: Record<string, string> = {};
    for (const field of FIELDS) config[field] = $(field).value.trim();
    return config;
}

async function loadForm() {
    const config = await chrome.storage.sync.get(DEFAULT_CONFIG) as MlConfig;
    for (const field of FIELDS) $(field).value = config[field] as string;
    applyTheme(config.theme);
    // Connection block: expanded (and flagged) when unconfigured — it's the first thing
    // to do; collapsed once a URL is set.
    (document.getElementById("conn") as HTMLDetailsElement).open = !config.chatUrl.trim();
    updateConnSummary();
}

// The <summary> of the connection block reflects its state: a call-to-action when unset,
// a green host readout once configured (so a glance tells you it's wired up).
function updateConnSummary() {
    const url = $("chatUrl").value.trim();
    const el = document.getElementById("connStatus")!;
    if (!url) { el.innerHTML = `<span class="todo">① Set up your connection</span>`; return; }
    let host = url;
    try { host = new URL(url).host || url; } catch { /* keep the raw string */ }
    el.textContent = "Connection ";
    const ok = document.createElement("span");
    ok.className = "ok"; ok.textContent = `✓ ${host}`;
    el.append(ok);
}

async function save() {
    await chrome.storage.sync.set(readForm());
    setStatus("Saved.", "ok");
}

// Model-list fetching lives in background.ts (listAvailableModels); the
// current form values are passed as overrides so Load works before saving.
function loadModels() {
    const { chatUrl, apiKey } = readForm();
    setStatus("Loading models…", "busy");

    chrome.runtime.sendMessage(
        { type: "LIST_MODELS", payload: { chatUrl, apiKey } },
        (response: any) => {
            if (chrome.runtime.lastError) {
                setStatus(`Failed to load models: ${chrome.runtime.lastError.message}`, "err");
                return;
            }
            if (response && response.error) {
                setStatus(`Failed to load models: ${response.error}`, "err");
                return;
            }

            const models: string[] = response.data;
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
            $(field).value = changes[field].newValue as string;
        }
    }
    if (changes.theme && changes.theme.newValue !== undefined) applyTheme(changes.theme.newValue as Theme);
    if (changes.chatUrl && changes.chatUrl.newValue !== undefined) updateConnSummary();
});

async function saveAndTest() {
    await chrome.storage.sync.set(readForm());
    setStatus("Saved. Testing chat endpoint…", "busy");

    chrome.runtime.sendMessage(
        { type: "FETCH_LLM", payload: { messages: [{ role: "user", content: "Reply with exactly: OK" }] } },
        (response: any) => {
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

    chrome.runtime.sendMessage({ type: "OLLAMA_UNLOAD", payload: {} }, async (response: any) => {
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

// ---- Google Sheets host access (python_exec `sheet`) ----
// The background CSV fetch needs docs.google.com host permission, which "On click" site
// access withholds (activeTab covers content scripts, not the SW fetch). Request it — plus
// the hosts the export can redirect to (login / large-file viewer) — in one click, from the
// user gesture. These are all within the manifest's <all_urls>, so request() can re-grant them.
const SHEETS_ORIGINS = ["https://docs.google.com/*", "https://accounts.google.com/*", "https://*.googleusercontent.com/*"];

function reflectSheetsAccess(granted: boolean) {
    const btn = $("sheetsAccess"), hint = document.getElementById("sheetsHint")!;
    // Summary reflects state at a glance (green ✓ when all granted, like the connection block);
    // the block collapses when everything's granted and opens when a grant is still needed.
    const status = document.getElementById("permsStatus")!;
    const perms = document.getElementById("perms") as HTMLDetailsElement;
    status.textContent = "Permissions ";
    const tag = document.createElement("span");
    tag.className = granted ? "ok" : "todo";
    tag.textContent = granted ? "✓ Google Sheets" : "Google Sheets access off";
    status.append(tag);
    perms.open = !granted;
    if (granted) {
        btn.textContent = "Enabled ✓"; (btn as unknown as HTMLButtonElement).disabled = true;
        hint.innerHTML = `<span class="ok">Google Sheets access granted.</span>`;
    } else {
        btn.textContent = "Enable"; (btn as unknown as HTMLButtonElement).disabled = false;
        hint.innerHTML = `Lets <code>python_exec</code> load a Google Sheet (the <code>sheet</code> arg) as a pandas DataFrame — needs host access to docs.google.com.`;
    }
}

async function refreshSheetsAccess() {
    try { reflectSheetsAccess(await chrome.permissions.contains({ origins: SHEETS_ORIGINS })); }
    catch { document.getElementById("sheetsSection")?.remove(); /* API missing → hide it */ }
}

async function enableSheetsAccess() {
    try {
        const granted = await chrome.permissions.request({ origins: SHEETS_ORIGINS });
        reflectSheetsAccess(granted);
        setStatus(granted ? "Google Sheets access granted." : "Access not granted — you can also allow it via the browser's Extensions manager (Site access → On all sites).", granted ? "ok" : "err");
    } catch (e: any) {
        setStatus(`Couldn't request access: ${e?.message || e}. Allow it manually: Extensions manager → this extension → Site access → On all sites.`, "err");
    }
}

// --- self-approval whitelist (mirrors Settings → Permissions) --------------------
// Sites the user trusts to supply their OWN ml.agent approval gate; every other origin routes a
// privileged tool call through the extension's approval card. Normalise to a bare hostname.
function normDomain(input: string): string | null {
    let s = input.trim().toLowerCase();
    if (!s) return null;
    try { if (/^[a-z]+:\/\//.test(s)) s = new URL(s).hostname; } catch { /* bare host */ }
    s = s.replace(/^\/+/, "").split("/")[0].split(/[?#:]/)[0];
    return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(s) ? s : null;
}
function renderPermList(domains: string[]) {
    const list = document.getElementById("permList")!;
    list.replaceChildren();
    if (!domains.length) {
        const e = document.createElement("div"); e.className = "hint"; e.textContent = "No trusted domains — every site's privileged agent calls go through the approval card.";
        list.append(e); return;
    }
    for (const d of domains) {
        const chip = document.createElement("span"); chip.className = "perm-chip";
        const host = document.createElement("span"); host.className = "perm-host"; host.textContent = d;
        const x = document.createElement("button"); x.className = "perm-x"; x.textContent = "✕"; x.title = `Remove ${d}`;
        x.addEventListener("click", () => setDomains((cur) => cur.filter(v => v !== d)));
        chip.append(host, x); list.append(chip);
    }
}
async function setDomains(fn: (cur: string[]) => string[]) {
    const { pageApprovalDomains = [] } = await chrome.storage.sync.get({ pageApprovalDomains: [] });
    const next = fn(pageApprovalDomains as string[]);
    await chrome.storage.sync.set({ pageApprovalDomains: next });
    renderPermList(next);
}
function addDomain() {
    const input = $("permDomain");
    const d = normDomain(input.value);
    if (!d) { setStatus("Enter a valid hostname, e.g. docs.google.com", "err"); return; }
    setDomains((cur) => cur.includes(d) ? cur : [...cur, d].sort());
    input.value = "";
}
async function loadPerms() {
    const { pageApprovalDomains = [] } = await chrome.storage.sync.get({ pageApprovalDomains: [] });
    renderPermList(pageApprovalDomains as string[]);
}

// Renders per-model VRAM usage from Ollama's /api/ps (used only — Ollama's API
// doesn't report total GPU capacity, so there's no denominator to show).
function renderVram(models: LoadedModel[]) {
    if (!models.length) {
        $("vram").textContent = "Nothing loaded.";
        return;
    }
    const usedGB = models.reduce((sum, m) => sum + (m.vramGB || 0), 0);
    // Show the loaded context too — Ollama preallocates KV cache for the whole window,
    // so it's a big part of why a model costs what it costs.
    const list = models.map(m => `• ${m.model}${m.contextLength ? ` (${fmtCtx(m.contextLength)} ctx)` : ""} — ${m.vramGB ?? "?"} GB`).join("\n");
    $("vram").textContent = `${usedGB.toFixed(1)} GB in use\n${list}`;
}

// Resolves to the loaded-model list (so callers can poll after an unload), or
// null when there's no Ollama backend to report on.
function refreshVram(): Promise<LoadedModel[] | null> {
    return new Promise((resolve) => {
        chrome.runtime.sendMessage({ type: "OLLAMA_PS", payload: {} }, (response: any) => {
            // No Ollama backend (e.g. a cloud-only setup) — hide the section
            // entirely rather than showing an error for something that doesn't apply.
            if (chrome.runtime.lastError || (response && response.error)) {
                $("vramSection").style.display = "none";
                resolve(null);
                return;
            }
            $("vramSection").style.display = "block";
            const models: LoadedModel[] = response.data || [];
            renderVram(models);
            resolve(models);
        });
    });
}

// Theme + debug panel are one-glance toggles → persist immediately on change (no Save
// needed). The connection fields still gather under Save / Save & Test.
$("theme").addEventListener("change", () => { applyTheme($("theme").value as Theme); chrome.storage.sync.set({ theme: $("theme").value }); });
$("debugMode").addEventListener("change", () => chrome.storage.sync.set({ debugMode: $("debugMode").value }));
$("chatUrl").addEventListener("input", updateConnSummary);
$("save").addEventListener("click", save);
$("unload").addEventListener("click", freeVram);
$("test").addEventListener("click", saveAndTest);
$("refreshVram").addEventListener("click", refreshVram);
$("sheetsAccess").addEventListener("click", enableSheetsAccess);
$("permAdd").addEventListener("click", addDomain);
$("permDomain").addEventListener("keydown", (e) => { if ((e as KeyboardEvent).key === "Enter") { e.preventDefault(); addDomain(); } });

// Populate the form, then auto-fetch the model list (no Load button — the
// datalist just fills in). refreshVram in parallel.
loadForm().then(loadModels);
refreshVram();
refreshSheetsAccess();
loadPerms();
