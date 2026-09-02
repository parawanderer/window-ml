// The full settings view (mirrors the popup): tabbed Connection / Models /
// Appearance / Advanced. Reads/writes chrome.storage.sync directly — safe because
// this runs in the extension-origin iframe, not the page DOM — so edits sync live
// with the popup. Text fields persist on change (blur) to avoid chatty writes; the
// signal updates on input for a responsive UI + the utility-field enable gating.
import { signal } from "@preact/signals";
import { useState, useEffect, useRef } from "preact/hooks";
import type { ComponentChildren } from "preact";
import type { MlConfig, ApiFormat, Theme, DebugMode, CardCorner, AgentHud, LoadedModel, VisionSupport } from "../contract";
import { DEFAULT_CONFIG, DEFAULT_GROUNDING_RANGE, VISION_NUM_CTX, detectGroundingModel, modelFilterAllows } from "../contract";
import { PY_PACKAGES } from "../python-env";
import {
    config, models, fontScale, codeWrap, codeLineNumbers, showStatsTokens, showStatsTps, outMaxH,
    MAX_FS, MIN_FS, FONT_KEY, WRAP_KEY, LINES_KEY, STATS_TOKENS_KEY, STATS_TPS_KEY, OUTMAX_KEY, OUTMAX_DEFAULT,
} from "./store";
import { truncate } from "./format";
import { applyTheme, applyFont, applyCodePrefs } from "./prefs";
import { IconCheck } from "./icons";

// Update one config field: mirror it into the signal (live UI), optionally
// persist to chrome.storage.sync (which the popup also reads → they sync).
function setField(key: keyof MlConfig, value: string | number | boolean, persist = true): void {
    config.value = { ...config.value, [key]: value };
    if (persist) chrome.storage.sync.set({ [key]: value });
    if (key === "theme") applyTheme();
}

// A collapsible settings section whose open/closed state PERSISTS (localStorage), so reopening Settings
// keeps your layout. `id` keys the stored state. Replaces the ad-hoc `<details class="set-section" open>`.
const SECT_KEY = "ml_set_collapsed";
const collapsedSections = signal<Record<string, boolean>>((() => {
    try { return JSON.parse(localStorage.getItem(SECT_KEY) || "{}"); } catch { return {}; }
})());
function Section({ id, title, children }: { id: string; title: ComponentChildren; children: ComponentChildren }) {
    const onToggle = (e: any) => {
        const next = { ...collapsedSections.value, [id]: !e.currentTarget.open };
        collapsedSections.value = next;
        try { localStorage.setItem(SECT_KEY, JSON.stringify(next)); } catch { /* opaque origin — skip */ }
    };
    return (
        <details class="set-section" open={!collapsedSections.value[id]} onToggle={onToggle}>
            <summary class="set-group">{title}</summary>
            {children}
        </details>
    );
}

// --- Python sandbox environment probe (Settings → Advanced) --------------------
// The packages are static (PY_PACKAGES). The VERSION needs the real sandbox, so it's a
// one-click probe (not auto — spinning up ~24 MB of Pyodide just to open Settings is rude).
// The settings iframe messages the background's PYTHON_EXEC directly (like the model tests).
const pyEnv = signal<{ state: "idle" | "probing" | "ok" | "err"; text?: string }>({ state: "idle" });
const PY_PROBE = "import sys\n_out = {'python': sys.version.split()[0]}\n" +
    "for _l, _m in [('numpy','numpy'), ('Pillow','PIL'), ('pandas','pandas'), ('scipy','scipy')]:\n" +
    "    try:\n        _out[_l] = getattr(__import__(_m), '__version__', '?')\n    except Exception:\n        _out[_l] = '—'\n" +
    "return _out";
function probePython(): void {
    pyEnv.value = { state: "probing" };
    chrome.runtime.sendMessage({ type: "PYTHON_EXEC", payload: { code: PY_PROBE, hardened: true } }, (resp: any) => {
        if (chrome.runtime.lastError) { pyEnv.value = { state: "err", text: chrome.runtime.lastError.message }; return; }
        if (resp?.error) { pyEnv.value = { state: "err", text: resp.error }; return; }
        const r = resp?.data;
        if (!r || !r.ok) { pyEnv.value = { state: "err", text: (r && r.error) || "probe failed" }; return; }
        const v = (r.value || {}) as Record<string, string>;
        const pkgs = Object.entries(v).filter(([k]) => k !== "python").map(([k, ver]) => `${k} ${ver}`).join(" · ");
        pyEnv.value = { state: "ok", text: `Python ${v.python || "?"} · ${pkgs}` };
    });
}

// Clarification text — same wording as the popup's hints (keep in sync).
const TIP = {
    apiFormat: "Request and response shape — match it to the URL above.",
    model: "The model list loads automatically — start typing to pick one.",
    modelFilter: "Optional regex WHITELIST. When set, only models whose id matches are callable via window.ml, and pages (ml.models()) never even see the others — a guard against a page invoking, e.g., an expensive cloud model. Applies to every resolved model (main/OCR/grounding/utility). Blank = no restriction. Example: ^(qwen|gemma) to allow only local families.",
    ocrModel: "Vision model ml.read() uses for OCR and for other vision subtasks — kept separate from the chat model.",
    defaultModelVision: "Whether the default model sees images natively. Auto-detect probes Ollama; set Yes/No only for a cloud model the probe can't read (e.g. GPT-4o) — declaring Yes lets the agent use its own model to see (HUD native vision) instead of delegating to the OCR model. For an Ollama model we detect the real answer, so this override is ignored (and flagged).",
    utilityModel: "A small, cheap model for side tasks like session-title summaries. Leave blank to reuse the main model. Suggestions: qwen3.5:0.8b for an average machine, a gemma4:e2b-class model for a beefier one.",
    utilityNumCtx: "Context window (num_ctx) for the utility model. Summarising needs little context — keep it small on modest hardware; larger just uses more KV-cache memory. Only used when a utility model is set.",
    utilityForceCpu: "Run the utility model on CPU (num_gpu: 0) so it never competes with your main model for VRAM. Only used when a utility model is set.",
    autoTitles: "Let the utility model write short summaries for you: debug session titles, and the plain-English gloss above a code approval / the description of a custom tool call in the off-mode card. Off = titles fall back to the first prompt and the card shows no summary. Only runs when a utility model is set.",
    autoApproveReadonly: "Experimental. Run read-only exec surveys (querySelectorAll → filter → map, no mutation) without an approval prompt, via a mediated interpreter that can't reach window/fetch and never eval()s a string. Anything that mutates or isn't recognised still asks. Also lets these surveys run on Trusted-Types pages where eval is blocked. The agent can likewise read its own setup without asking — ml.getModel/config/models/capabilities/ps/serverTools, the same non-secret values any page can read; every other ml method still prompts.",
    autoApprovePython: "Experimental. Run readonly-mode python_exec calls without an approval prompt. A readonly run is isolated by construction — the WASM sandbox has no DOM, no filesystem, and (in this mode) no network or JS/extension scope — so it's a pure function over the injected data and can't affect the page or exfiltrate. A `mode:'full'` call (which the agent must explicitly request to get network) ALWAYS asks. Code with hidden/bidi characters also still asks.",
    autoApproveSameOriginAuth: "Advanced, default OFF. Auto-approve a fetch that spends your session on the SAME origin you're already on — a fetch_url/ml.fetch with credentials:true (sends your cookies), or a rendered:true load in a normal (non-incognito) tab that inherits your login. OFF keeps you in charge: those always ask. This never touches cross-origin fetches (always ask) or the uncredentialed same-origin reads (already free — the page could fetch its own origin itself).",
    autoApproveSelfSource: "Default ON. Auto-approve an UNCREDENTIALED fetch_url/ml.fetch of the agent's OWN repo source — committed files (raw.githubusercontent.com) or structural/code API endpoints (api.github.com/repos/<owner>/<repo>/…), locked to this build's repoUrl — so it can read the code it's running to explain/debug itself. NEVER auto-approves user-generated PROSE endpoints (issues/pulls/comments/discussions/reviews/releases — a prompt-injection surface), a credentialed fetch, or a rendered load; those still ask. Public, read-only, uncredentialed → near-zero risk.",
    cdp: "Experimental. Use chrome.debugger (CDP) for two things a normal page context can't do: (1) CLICK surfaces a synthetic click can't reach — cross-origin iframes and declarative/native closed shadow roots; (2) run imperative `exec` on strict-CSP / Trusted-Types pages (GitHub, Google apps) where main-world eval is blocked. The debugger is exempt from the page's CSP/TT, so it's the only mechanism that works. The `debugger` permission is declared at install; this toggle gates USAGE (the API stays unused until it's on AND the model hits a reserved surface). Still gated by the per-action approval. Attaching flashes Chrome's \"is debugging this browser\" banner — only for these reserved actions, so the flash marks the risk. Off by default; while off, a reserved click / a blocked exec just reports an actionable error and the agent falls back to read-only / ml.fetch.",
    pierceClosedShadow: "Let the DOM tools reach inside CLOSED shadow roots too (normally selector-invisible). A tiny script captures each closed root as the page builds it — the tools then treat it like an open root (same `host >>> inner` syntax). Closed shadow DOM is encapsulation, not a security boundary, so this doesn't cross any origin. On by default: the capture script wraps attachShadow on every page regardless of this setting (capture only — page behaviour is unchanged), so this just gates whether the tools use it. Turn it off to keep the tools' selector reach limited to open roots. Declarative/native closed roots still can't be captured; the agent falls back to visual locate/@pt for those.",
    groundingEnabled: "Experimental. When on, ml.agent's `locate` tool asks a grounding VLM for bounding-box coordinates. This loads an extra model into VRAM — leave off if memory is tight. Off = locate still works via the Set-of-Marks screenshot tool, which needs no extra model.",
    groundingModel: "A vision model that outputs coordinates (recommended qwen2.5vl:7b, or :3b for lower latency). Blank auto-detects a qwen2.5vl on your server. Real-world grounding accuracy is unproven.",
    groundingRange: "The coordinate scale the model outputs (the divisor for its x,y). The screenshot is sent as a square, so one number covers every convention: 1000 (0-1000 normalized OR qwen2.5vl absolute pixels), 100 (Molmo percent), 1024 (PaliGemma tokens), 1 (0.0-1.0 fractions). Leave at 1000 unless your model uses a different range.",
};

// The model a role actually resolves to. Grounding, when enabled with a blank
// field, falls back to the auto-detected qwen (detectGroundingModel, shared with
// ml.agent) — the same effective model — so the status row + Test act on what runs.
function roleModel(key: keyof MlConfig): string {
    const raw = (config.value[key] as string).trim();
    if (key === "groundingModel" && config.value.groundingEnabled && !raw) return detectGroundingModel(models.value);
    return raw;
}

// Field label with an optional hover tooltip. Left-anchored (.left) so it opens
// rightward into the panel — far-left labels would clip a centered pop.
const Lbl = ({ children, tip }: { children: string; tip?: string }) =>
    tip
        ? <span class="tt">{children}<span class="tt-pop left" role="tooltip">{tip}</span></span>
        : <span>{children}</span>;

// --- model liveness test (per model) ---
// `model` records which model this result is for, so a row auto-invalidates (shows
// as not-tested) when you change the field; `at` timestamps it for the hover.
type TestState = { status: "loading" | "ok" | "err"; error?: string; detail?: string; at?: number; model?: string; image?: string };
const modelTests = signal<Record<string, TestState | undefined>>({});

// Name the quadrant of a point given as fractions [0,1] (image y-down: 0=top).
const areaName = (fx: number, fy: number) => `${fy > 0.5 ? "bottom" : "top"}-${fx > 0.5 ? "right" : "left"}`;
const MODEL_ROLES: { key: keyof MlConfig; label: string; vision?: boolean }[] = [
    { key: "model", label: "Default" },
    { key: "ocrModel", label: "OCR", vision: true },   // must be vision-capable
    { key: "utilityModel", label: "Utility" },
    { key: "groundingModel", label: "Grounding", vision: true },   // needs vision (grounding itself isn't cap-detectable)
];

const setTest = (key: keyof MlConfig, state: TestState) => { modelTests.value = { ...modelTests.value, [key]: state }; };

// Probe a model's Ollama capabilities. Returns an error string if it POSITIVELY
// lacks vision; null otherwise — including unknown/null (cloud, non-Ollama, or an
// old Ollama), which we must NOT flag red (unknown ≠ "no").
function visionGate(name: string): Promise<string | null> {
    return new Promise(resolve => {
        chrome.runtime.sendMessage({ type: "MODEL_CAPS", payload: { model: name } }, (resp: any) => {
            if (chrome.runtime.lastError || !resp || resp.error) return resolve(null);
            const caps = resp.data;
            resolve(Array.isArray(caps) && !caps.includes("vision")
                ? `"${name}" doesn't report vision capability — this role needs a vision model.`
                : null);
        });
    });
}

// Real words, not letter-soup: a general-purpose VLM reads prose far better than
// random glyphs (which it mis-reads, e.g. V→√), and accurate letter-soup OCR wants
// a specialised model this extension isn't chasing. Common, clearly-spelled words.
const OCR_WORDS = [
    "bright", "frozen", "gentle", "silver", "hidden", "golden", "clever", "purple",
    "quiet", "wander", "jumping", "running", "flowing", "gliding", "whisper", "thunder",
    "crimson", "meadow", "harbor", "velvet", "morning", "coffee", "garden", "planet",
];

// A generated PNG of one known word — genuinely tests OCR (a text ping passes on
// ANY model without exercising vision). null if no canvas (e.g. jsdom).
function ocrTestImage(): { dataUrl: string; token: string } | null {
    try {
        const word = OCR_WORDS[Math.floor(Math.random() * OCR_WORDS.length)];
        const cv = document.createElement("canvas");
        cv.width = 360; cv.height = 84;
        const ctx = cv.getContext("2d");
        if (!ctx) return null;
        ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, cv.width, cv.height);
        ctx.fillStyle = "#111"; ctx.font = "bold 48px sans-serif"; ctx.textBaseline = "middle";
        ctx.fillText(word, 20, 44);
        return { dataUrl: cv.toDataURL("image/png"), token: word };
    } catch { return null; }
}

// A white PNG with ONE red dot in a random quadrant — a mini VISUAL GROUNDING task:
// can the model point at where something is? Uses a 1000×1000 canvas so the dot's
// centre coords (250/750) match the 0–1000 answer space whether the model returns
// pixels (qwen2.5vl's native absolute output) or normalized values — sidestepping
// the pixel-vs-normalized ambiguity. Returns the dot's centre (cx/cy) to grade.
function groundingTestImage(): { dataUrl: string; fx: number; fy: number } | null {
    try {
        const S = DEFAULT_GROUNDING_RANGE;   // the square size locate also sends at
        const fx = Math.random() < 0.5 ? 0.25 : 0.75;
        const fy = Math.random() < 0.5 ? 0.25 : 0.75;
        const cv = document.createElement("canvas");
        cv.width = S; cv.height = S;
        const ctx = cv.getContext("2d");
        if (!ctx) return null;
        ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, S, S);
        ctx.fillStyle = "#e11d48"; ctx.beginPath(); ctx.arc(fx * S, fy * S, S * 0.07, 0, Math.PI * 2); ctx.fill();
        return { dataUrl: cv.toDataURL("image/png"), fx, fy };
    } catch { return null; }
}

// Snapshot of models resident BEFORE a Test run (from OLLAMA_PS). null = unknown
// (probe failed / non-Ollama) → we don't auto-unload, to avoid evicting a warm one.
let loadedBefore: Set<string> | null = null;
// Free a model the TEST loaded (not one already resident) so a smoke-test stays
// VRAM-neutral — the point of keeping the grounding model opt-in.
function unloadIfFresh(model: string): void {
    if (!loadedBefore || loadedBefore.has(model)) return;
    chrome.runtime.sendMessage({ type: "OLLAMA_UNLOAD", payload: { model } }, () => { /* best-effort */ });
}

// Test one model. Text models get a trivial ping; OCR transcribes a code image
// (with the allowed alphabet in the prompt); grounding must point at a red dot
// (normalized coords, quadrant-checked); the utility model runs through its own
// extend:"utility" profile. Records the model + a timestamp so a row invalidates
// on change and shows the outcome on hover.
function testOne(key: keyof MlConfig): void {
    const name = roleModel(key);
    if (!name) return;
    setTest(key, { status: "loading", model: name });
    const done = (s: Omit<TestState, "model" | "at">) => { setTest(key, { ...s, model: name, at: Date.now() }); unloadIfFresh(name); };

    // Vision-required roles (OCR, grounding): first check the model actually reports
    // vision — a clear "not a vision model" beats a confusing functional failure
    // downstream. Unknown caps (cloud/non-Ollama) pass through to the test.
    const role = MODEL_ROLES.find(r => r.key === key);
    const gate = role?.vision ? visionGate(name) : Promise.resolve(null);
    gate.then(capErr => {
        if (capErr) return done({ status: "err", error: capErr });

        const ping = { role: "user", content: "Reply with exactly: OK" };
        const img = key === "ocrModel" ? ocrTestImage() : null;
        const gimg = key === "groundingModel" ? groundingTestImage() : null;
        const gRange = config.value.groundingRange || DEFAULT_GROUNDING_RANGE;
        const shot = img?.dataUrl || gimg?.dataUrl;   // the test image, kept on the result so the row can show it
        // Cap the vision probes' num_ctx (like the real delegated sub-calls): a one-word
        // liveness check shouldn't fresh-load a vision model at its auto-sized default
        // window (128K on a big-VRAM box) and balloon KV cache. Text pings stay uncapped.
        const payload = img
            ? { messages: [{ role: "user", content: "Transcribe the single word shown in this image. Output ONLY that word — no punctuation or explanation.", images: [img.dataUrl] }], model: name, ocr: true, numCtx: VISION_NUM_CTX }
            : gimg
                ? { messages: [{ role: "user", content: `This image is white with ONE red dot. Reply with ONLY the dot's centre coordinates as \`x,y\` — each from 0 to ${gRange} (x: 0=left→${gRange}=right; y: 0=top→${gRange}=bottom). Example: ${Math.round(gRange * 0.25)},${Math.round(gRange * 0.75)}`, images: [gimg.dataUrl] }], model: name, numCtx: VISION_NUM_CTX }
                : key === "utilityModel"
                    ? { messages: [ping], extend: "utility" }
                    : { messages: [ping], model: name };

        chrome.runtime.sendMessage({ type: "FETCH_LLM", payload }, (resp: any) => {
            const err = chrome.runtime.lastError?.message || (resp && resp.error);
            if (err) return done({ status: "err", error: String(err), image: shot });
            if (img) {
                const got = String(resp.data || "").toLowerCase().replace(/[^a-z]/g, "");
                return done(got.includes(img.token)
                    ? { status: "ok", detail: `read "${img.token}" correctly`, image: shot }
                    : { status: "err", error: `read "${truncate(String(resp.data || ""), 40)}" — expected "${img.token}"`, image: shot });
            }
            if (gimg) {
                const dot = areaName(gimg.fx, gimg.fy);
                const dotCoord = `${Math.round(gimg.fx * gRange)},${Math.round(gimg.fy * gRange)}`;   // where the dot is, in the model's range
                const m = String(resp.data || "").match(/(\d+(?:\.\d+)?)\s*[,;xX× ]\s*(\d+(?:\.\d+)?)/);
                if (!m) return done({ status: "err", error: `no coordinates in reply: "${truncate(String(resp.data || ""), 40)}"`, image: shot });
                const gx = +m[1], gy = +m[2], mfx = gx / gRange, mfy = gy / gRange;   // model fractions
                const hit = (mfx > 0.5) === (gimg.fx > 0.5) && (mfy > 0.5) === (gimg.fy > 0.5);
                return done(hit
                    ? { status: "ok", detail: `dot was ${dot} (≈${dotCoord}); model said ${gx},${gy}`, image: shot }
                    : { status: "err", error: `model said ${gx},${gy} (${areaName(mfx, mfy)}) — dot was ${dot} (≈${dotCoord})`, image: shot });
            }
            done({ status: "ok" });
        });
    });
}
// Snapshot the resident models first (so unloadIfFresh only frees what THIS run
// loads), then test each. A failed/absent OLLAMA_PS → unknown → no auto-unload.
const testModels = () => {
    chrome.runtime.sendMessage({ type: "OLLAMA_PS", payload: {} }, (resp: any) => {
        loadedBefore = (resp && !resp.error && Array.isArray(resp.data))
            ? new Set(resp.data.map((m: LoadedModel) => m.model))
            : null;
        for (const { key } of MODEL_ROLES) testOne(key);
    });
};

const TestIcon = ({ state }: { state: "idle" | "unset" | "loading" | "ok" | "err" }) => (
    <span class={`test-ic ${state}`}>
        {state === "ok" ? <IconCheck /> : state === "err" ? "✕" : state === "loading" ? "…" : state === "unset" ? "—" : ""}
    </span>
);

// "Test models" button + a per-model status row (loading/ok/err/not-set), errors below.
function ModelTests() {
    const t = modelTests.value;
    return (
        <div class="set-test">
            <div class="set-test-title">Model status</div>
            <div class="test-grid">
                {MODEL_ROLES.map(({ key, label }) => {
                    const name = roleModel(key);
                    const st = t[key];
                    // A result only counts for the model it was run against — editing
                    // the field invalidates it back to "not tested".
                    const fresh = st && st.model === name;
                    // A configured model the whitelist excludes is un-callable — flag it RED
                    // up front (no test needed), like the vision-capability check does.
                    const excluded = !!name && !modelFilterAllows(name, config.value.modelFilter);
                    const state = !name ? "unset" : excluded ? "err" : fresh ? st!.status : "idle";
                    const title = !name ? "Not set"
                        : excluded ? "Excluded by the model access filter — this model can't be called."
                        : !fresh ? "Not tested yet"
                        : st!.status === "loading" ? "Testing…"
                        : st!.status === "ok" ? `Passed${st!.at ? ` at ${new Date(st!.at).toLocaleTimeString()}` : ""}${st!.detail ? ` · ${st!.detail}` : ""}`
                        : st!.error || "Failed";
                    return (
                        <div class="test-row" key={key}>
                            <TestIcon state={state} />
                            <span class="role">{label}</span>
                            <span class="name">{name || "not set"}</span>
                            <span class="tt-pop left" role="tooltip">{title}</span>
                        </div>
                    );
                })}
            </div>
            {MODEL_ROLES.map(({ key, label }) => {
                const st = t[key];
                if (!(st && st.status === "err" && st.model === roleModel(key))) return null;
                return (
                    <div class="test-err" key={key}>
                        {st.image ? <img class="test-thumb zoomable" src={st.image} alt={`${label} test image`}
                            title="Click to view full size — decide for yourself if it really failed"
                            onClick={() => window.parent.postMessage({ __mlLightbox: st.image }, "*")} /> : null}
                        <span><b>{label}:</b> {truncate(st.error!, 160)}</span>
                    </div>
                );
            })}
            <button class="test-btn" onClick={testModels}>Test models</button>
        </div>
    );
}

// Full settings view (mirrors the popup). Reads/writes chrome.storage.sync
// directly — safe because this runs in the extension-origin iframe, not the
// page DOM — so edits sync live with the popup. Text fields persist on change
// (blur) to avoid chatty storage writes; the signal updates on input for a
// responsive UI + the utility-field enable gating.
const SETTINGS_TABS = [
    { id: "connection", label: "Connection" },
    { id: "models", label: "Models" },
    { id: "appearance", label: "Appearance" },
    { id: "advanced", label: "Advanced" },
    { id: "permissions", label: "Permissions" },
] as const;
type SettingsTab = typeof SETTINGS_TABS[number]["id"];
const settingsTab = signal<SettingsTab>("connection");

// ── Permissions tab ──────────────────────────────────────────────────────────
// Two grants the USER manages here (the page never touches either): the per-domain
// approval whitelist (pageApprovalDomains — a site trusted to supply its OWN ml.agent
// approval gate; every other origin routes privileged tool calls through the extension's
// unforgeable approval card) and the Google Sheets host permission for python_exec.
const SHEETS_ORIGINS = ["https://docs.google.com/*", "https://accounts.google.com/*", "https://*.googleusercontent.com/*"];
const domainInput = signal("");
const domainSearch = signal("");

// Normalise a user-typed site to a bare hostname (strip scheme/path/port), or null if it isn't a valid
// hostname. Accepts "docs.google.com", "https://docs.google.com/…", "Example.COM" → "example.com".
function normDomain(input: string): string | null {
    let s = input.trim().toLowerCase();
    if (!s) return null;
    try { if (/^[a-z]+:\/\//.test(s)) s = new URL(s).hostname; } catch { /* not a URL — treat as a bare host */ }
    s = s.replace(/^\/+/, "").split("/")[0].split(/[?#:]/)[0];
    return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(s) ? s : null;
}
function setDomains(list: string[]): void {
    config.value = { ...config.value, pageApprovalDomains: list };
    chrome.storage.sync.set({ pageApprovalDomains: list });
}

// The Google Sheets host-permission grant (moved from the popup) — chrome.permissions, extension-origin.
function SheetsGrant() {
    const [granted, setGranted] = useState<boolean | null>(null);
    const [err, setErr] = useState("");
    useEffect(() => {
        try { chrome.permissions.contains({ origins: SHEETS_ORIGINS }, (g) => setGranted(!!g)); }
        catch { setGranted(false); }
    }, []);
    const enable = () => {
        setErr("");
        try {
            chrome.permissions.request({ origins: SHEETS_ORIGINS }, (g) => {
                setGranted(!!g);
                if (!g) setErr("Not granted — you can also allow it via the browser's Extensions manager (Site access → On all sites).");
            });
        } catch (e: any) { setErr(`Couldn't request access: ${e?.message || e}. Allow it manually via the Extensions manager (Site access → On all sites).`); }
    };
    if (granted === null) return null;   // still probing / API unavailable
    return (
        <details class="set-section" open={!granted}>
            <summary class="set-group">Google Sheets access{granted ? <span class="perm-ok"> ✓</span> : null}</summary>
            <div class="set-note">Lets <code>python_exec</code> load a Google Sheet (the <code>tables</code> arg / a Sheets URL) as a pandas DataFrame — the background CSV fetch needs host access to <code>docs.google.com</code>, which “On click” site access withholds. A narrower grant than “On all sites”.</div>
            {granted
                ? <div class="set-hint"><span class="perm-ok">Granted.</span> The extension can fetch Google Sheets you're signed into.</div>
                : <div class="free-row"><button class="test-btn" onClick={enable}>Enable Google Sheets access</button></div>}
            {err ? <div class="set-err">{err}</div> : null}
        </details>
    );
}

// The Incognito-access DEEP-LINK (private rendered fetch). Unlike a host permission, "Allow in Incognito" can't
// be requested via any API (it's a user-only toggle) — so we only READ it (isAllowedIncognitoAccess) and open
// the extension's details page (via the background, which reliably opens a chrome:// tab — the embedded settings
// iframe can't). Mirrors the popup's "Incognito rendering" row.
function IncognitoGrant() {
    const [allowed, setAllowed] = useState<boolean | null>(null);
    const [err, setErr] = useState("");
    useEffect(() => {
        try {
            if (!chrome.extension?.isAllowedIncognitoAccess) { setAllowed(null); return; }
            chrome.extension.isAllowedIncognitoAccess((a: boolean) => setAllowed(!!a));
        } catch { setAllowed(null); }
    }, []);
    const openSettings = () => {
        setErr("");
        try { chrome.runtime.sendMessage({ type: "OPEN_EXTENSIONS_PAGE" }, (r: any) => { if (r?.error) setErr("Couldn't open the extensions page — open it from the browser menu (Extensions → Manage) and enable Incognito for window.ml."); }); }
        catch { setErr("Couldn't open the extensions page — open it from the browser menu."); }
    };
    if (allowed === null) return null;   // API unavailable → hide the row
    return (
        <details class="set-section" open={!allowed}>
            <summary class="set-group">Incognito rendering{allowed ? <span class="perm-ok"> ✓</span> : null}</summary>
            <div class="set-note">Lets a <code>fetch_url</code> / <code>ml.fetch</code> with <code>rendered:true</code> load a page's JavaScript <b>privately</b> — in an incognito tab with no session — so a client-rendered page renders without your cookies. (With <code>credentials:true</code> it uses your normal session and needs no Incognito.) The browser only lets <b>you</b> turn this on.</div>
            {allowed
                ? <div class="set-hint"><span class="perm-ok">Incognito access on.</span> A private (no-session) <code>rendered</code> fetch works.</div>
                : <div class="free-row"><button class="test-btn" onClick={openSettings}>Open settings to enable</button></div>}
            {err ? <div class="set-err">{err}</div> : null}
        </details>
    );
}

// ── Per-site host access (agent fetch_url) ───────────────────────────────────
// The background's fetch_url reads a URL via the SW fetch, which "On click" site access WITHHOLDS for
// third-party hosts. The approval card grants a host in-gesture when you approve a fetch to a new site;
// THIS is the management view (mirrors the popup's "Site access" block) — see which sites are granted and
// revoke any. Excludes the Sheets origins (their own row above) and <all_urls> (shown as a note, not a chip).
function hostPatternFrom(input: string): string | null {
    const d = normDomain(input);
    return d ? `https://${d}/*` : null;
}
function hostLabelOf(origin: string): string {
    return origin.replace(/^https?:\/\//, "").replace(/\/\*?$/, "");
}
function HostAccess() {
    const [origins, setOrigins] = useState<string[] | null>(null);
    const [query, setQuery] = useState("");   // ONE box: filters the list as you type, and adds when it's a full hostname
    const [err, setErr] = useState("");
    const refresh = () => {
        try { chrome.permissions.getAll((all: any) => setOrigins((all.origins || []).filter((o: string) => !SHEETS_ORIGINS.includes(o)))); }
        catch { setOrigins(null); }   // API unavailable → the block hides itself
    };
    useEffect(() => {
        refresh();
        // A grant made in-gesture from the approval card (or a revoke from the popup) should show up here
        // without reopening Settings — mirror the browser's own permission events.
        const onChange = () => refresh();
        try { chrome.permissions.onAdded?.addListener(onChange); chrome.permissions.onRemoved?.addListener(onChange); } catch { /* events absent on old Chrome */ }
        return () => { try { chrome.permissions.onAdded?.removeListener(onChange); chrome.permissions.onRemoved?.removeListener(onChange); } catch { /* ignore */ } };
    }, []);
    if (origins === null) return null;   // still probing / API unavailable
    // The one input doubles as filter + add: a partial word ("github") just filters the granted list; a full
    // hostname resolves to a pattern → Add is enabled and grants it. The list gets spammed fast (an agent
    // fetching around a topic adds dozens), so live-filtering the same box beats a second search field.
    const pat = hostPatternFrom(query);
    const add = () => {
        if (!pat) return;
        setErr("");
        try {
            chrome.permissions.request({ origins: [pat] }, (granted: boolean) => {
                if (granted) { setQuery(""); refresh(); }
                else setErr("Not granted — you can also allow it via the browser's Extensions manager (Site access).");
            });
        } catch (e: any) { setErr(`Couldn't request access: ${e?.message || e}.`); }
    };
    const revoke = (origin: string) => { try { chrome.permissions.remove({ origins: [origin] }, () => refresh()); } catch { /* ignore */ } };
    const all = origins.includes("<all_urls>");
    const hosts = origins.filter(o => o !== "<all_urls>");
    const q = query.trim().toLowerCase();
    const shown = q ? hosts.filter(o => hostLabelOf(o).toLowerCase().includes(q)) : hosts;
    return (
        <Section id="hostaccess" title="Site access (agent fetches)">
            <div class="set-note">The <code>fetch_url</code> tool reads a URL through the background, which “On click” site access withholds for third-party hosts. Approving a fetch (or a cross-site navigate) grants that host in the same gesture; the granted sites are listed here so you can add or revoke them yourself. A narrower grant than “On all sites”.</div>
            {all
                ? <div class="set-hint">Access to <b>all sites</b> is granted (browser Site access → “On all sites”), so every fetch is allowed.</div>
                : <>
                    <div class="perm-add">
                        <input class="perm-input" type="text" placeholder="Filter sites, or type a hostname to add…" value={query}
                            onInput={(e: any) => setQuery(e.target.value)}
                            onKeyDown={(e: any) => { if (e.key === "Enter" && pat) { e.preventDefault(); add(); } }} />
                        <button class="test-btn" disabled={!pat} onClick={add}>Add</button>
                    </div>
                    {hosts.length
                        ? <div class="perm-list">
                            {shown.map(o => (
                                <span class="perm-chip" key={o}>
                                    <span class="perm-host">{hostLabelOf(o)}</span>
                                    <button class="perm-x" aria-label={`Revoke ${hostLabelOf(o)}`} title={`Revoke ${hostLabelOf(o)}`} onClick={() => revoke(o)}>✕</button>
                                </span>
                            ))}
                            {/* Nothing matches: if the text is a full hostname, nudge to Add it; else it's just a dead filter. */}
                            {q && !shown.length ? <div class="set-hint">{pat ? <>Not granted yet — press <b>Add</b> to allow <code>{hostLabelOf(pat)}</code>.</> : <>No granted sites match “{query}”.</>}</div> : null}
                          </div>
                        : <div class="set-hint">No sites granted yet — the agent asks the first time it fetches each new one.</div>}
                  </>}
            {err ? <div class="set-err">{err}</div> : null}
        </Section>
    );
}

// The CDP master toggle. `debugger` is declared at INSTALL time (Chrome accepts a runtime
// `chrome.permissions.request` for it unreliably — it returns denied from the embedded settings iframe — so
// on-demand requesting isn't dependable; the install-time grant is). This toggle just gates USAGE; the API
// stays unused until it's on AND the model actually hits a reserved surface. If the permission is somehow
// inactive (an update pending re-approval), point the user at a reload rather than a dead-end.
function CdpToggle() {
    const on = config.value.cdp;
    const [granted, setGranted] = useState<boolean | null>(null);
    useEffect(() => { try { chrome.permissions.contains({ permissions: ["debugger"] }, (g: boolean) => setGranted(!!g)); } catch { setGranted(null); } }, [on]);
    return (
        <>
            <label class="set-check">
                <input type="checkbox" checked={on} onChange={(e: any) => setField("cdp", e.target.checked)} />
                <Lbl tip={TIP.cdp}>Enable debugger-based actions (CDP)</Lbl>
            </label>
            {on && granted === false
                ? <div class="set-hint"><span class="perm-warn">The debugger permission isn't active</span> — reload the extension (chrome://extensions) and accept its permissions, then CDP actions work.</div>
                : on && granted ? <div class="set-hint"><span class="perm-ok">Ready.</span> A reserved click / strict-page exec will use the debugger (with the banner).</div>
                : null}
        </>
    );
}

function PermissionsView() {
    const c = config.value;
    const domains = c.pageApprovalDomains || [];
    const parsed = normDomain(domainInput.value);
    const invalid = !!domainInput.value.trim() && !parsed;
    const add = () => {
        if (!parsed) return;
        if (!domains.includes(parsed)) setDomains([...domains, parsed].sort());
        domainInput.value = "";
    };
    const remove = (d: string) => setDomains(domains.filter(x => x !== d));
    const q = domainSearch.value.trim().toLowerCase();
    const shown = q ? domains.filter(d => d.includes(q)) : domains;
    return (
        <>
            <Section id="whitelist" title="Self-approval whitelist">
                <div class="set-note">Sites here are trusted to supply their <b>own</b> <code>ml.agent</code> approval gate (the page's <code>approve()</code> / <code>confirm</code>). <b>Every other site</b> routes a privileged tool call (click, type, exec, python_exec) through the extension's own approval — the corner card — so a page can never silently approve itself. Add a domain only if you fully trust the code on it.</div>
                <div class="perm-add">
                    <input class={`perm-input${invalid ? " err" : ""}`} type="text" placeholder="example.com" value={domainInput.value}
                        onInput={(e: any) => (domainInput.value = e.target.value)}
                        onKeyDown={(e: any) => { if (e.key === "Enter") { e.preventDefault(); add(); } }} />
                    <button class="test-btn" disabled={!parsed} onClick={add}>Add</button>
                </div>
                {invalid ? <div class="set-err">Enter a valid hostname, e.g. <code>docs.google.com</code>.</div> : null}
                {domains.length > 6
                    ? <input class="perm-search" type="search" placeholder="Filter domains…" value={domainSearch.value} onInput={(e: any) => (domainSearch.value = e.target.value)} />
                    : null}
                {domains.length
                    ? <div class="perm-list">
                        {shown.map(d => (
                            <span class="perm-chip" key={d}>
                                <span class="perm-host">{d}</span>
                                <button class="perm-x" aria-label={`Remove ${d}`} title={`Remove ${d}`} onClick={() => remove(d)}>✕</button>
                            </span>
                        ))}
                        {q && !shown.length ? <div class="set-hint">No domains match “{domainSearch.value}”.</div> : null}
                      </div>
                    : <div class="set-hint">No trusted domains — every site's privileged agent calls go through the extension's approval card.</div>}
            </Section>
            <HostAccess />
            <SheetsGrant />
            <IncognitoGrant />
        </>
    );
}

// A model COMBOBOX: free-type any id (cloud models needn't be in the list) + a caret that drops the full
// server model list, filtered by what's typed. Replaces the native <datalist>, whose popup only showed
// options MATCHING the typed text (so a non-matching entry looked like a broken/empty dropdown) and closed
// on any re-render. Clicking the caret always shows the whole list; picking an option fills + persists it.
function ModelPicker({ fieldKey, options, placeholder, cls = "", disabled = false }: {
    fieldKey: keyof MlConfig; options: string[]; placeholder?: string; cls?: string; disabled?: boolean;
}) {
    const val = (config.value[fieldKey] as string) || "";
    const [open, setOpen] = useState(false);
    const wrap = useRef<HTMLDivElement>(null);
    // Close when the click lands outside the widget (mousedown, so it beats an option's own mousedown).
    useEffect(() => {
        if (!open) return;
        const onDoc = (e: MouseEvent) => { if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false); };
        document.addEventListener("mousedown", onDoc);
        return () => document.removeEventListener("mousedown", onDoc);
    }, [open]);
    const q = val.trim().toLowerCase();
    const shown = (q ? options.filter(m => m.toLowerCase().includes(q)) : options).slice(0, 60);
    const pick = (m: string) => { setField(fieldKey, m); setOpen(false); };
    return (
        <div class="model-pick" ref={wrap}>
            <input type="text" class={cls} value={val} placeholder={placeholder} disabled={disabled}
                onInput={(e: any) => { setField(fieldKey, e.target.value, false); setOpen(true); }}
                onChange={(e: any) => setField(fieldKey, e.target.value)}
                onFocus={() => setOpen(true)}
                onKeyDown={(e: any) => { if (e.key === "Escape") { e.stopPropagation(); setOpen(false); } }} />
            <button type="button" class="model-pick-caret" tabIndex={-1} disabled={disabled} aria-label="Browse models"
                onClick={() => { if (!disabled) setOpen(o => !o); }}>▾</button>
            {open && !disabled && options.length ? (
                <div class="model-pick-menu" role="listbox">
                    {shown.length
                        ? shown.map(m => (
                            <button type="button" key={m} role="option" aria-selected={m === val}
                                class={`model-pick-opt${m === val ? " on" : ""}`}
                                onClick={() => pick(m)}>{m}</button>))
                        : <div class="model-pick-none">No model matches “{val.trim()}” — it'll be used as typed (fine for a cloud model that isn't listed).</div>}
                </div>
            ) : null}
        </div>
    );
}

// Debounced Ollama /api/show vision probe for a model id. Returns `true`/`false` when KNOWN, `null` while
// loading or undeterminable (cloud / non-Ollama / old Ollama / empty). Debounced so a per-keystroke async
// setState doesn't re-render mid-typing (that dismissed the picker menu). Shared by every vision role.
function useVisionProbe(model: string): boolean | null {
    const [sees, setSees] = useState<boolean | null>(null);
    useEffect(() => {
        const m = model.trim();
        if (!m) { setSees(null); return; }
        let live = true;
        const id = setTimeout(() => {
            chrome.runtime.sendMessage({ type: "MODEL_CAPS", payload: { model: m } }, (resp: any) => {
                if (!live) return;
                setSees(!chrome.runtime.lastError && resp && !resp.error && Array.isArray(resp.data) ? resp.data.includes("vision") : null);
            });
        }, 400);
        return () => { live = false; clearTimeout(id); };
    }, [model]);
    return sees;
}

export function Settings() {
    const c = config.value;
    const tab = settingsTab.value;
    const utilOn = !!c.utilityModel.trim();
    // Probe each role's real vision capability (Ollama /api/show), debounced. `null` = undeterminable
    // (cloud / non-Ollama / old Ollama / no model) → never flagged; `false` = a KNOWN local text-only model.
    const defModelSees = useVisionProbe(c.model);       // powers the vision-override "moot" flag
    const ocrSees = useVisionProbe(c.ocrModel);         // OCR is a vision role → flag a known non-vision pick
    const groundingSees = useVisionProbe(c.groundingModel);   // same for the grounding model
    // The override is redundant when we KNOW the answer (Ollama): detection wins, so a manual Yes/No is ignored.
    // When we can probe it (defModelSees !== null → an Ollama-backed model), the control is DISABLED and pinned
    // to Auto — there's nothing for the human to override, so a live select would just be a lie.
    const defVisionAutoDetected = defModelSees !== null;
    const visionOverrideMoot = c.defaultModelVision !== "" && defVisionAutoDetected;
    // Refresh the server model list whenever Settings opens — the initial fetch (App mount / gear click) may
    // have raced or failed while the server was waking up, leaving the datalists empty with no way to retry.
    useEffect(() => {
        chrome.runtime.sendMessage({ type: "LIST_MODELS", payload: {} }, (resp: any) => {
            if (!chrome.runtime.lastError && resp && !resp.error && Array.isArray(resp.data)) models.value = resp.data;
        });
    }, []);
    // Datalist entries after the access filter; plus the empty/unlisted states so the UI explains itself.
    const listed = models.value.filter(m => modelFilterAllows(m, c.modelFilter));
    const notListed = (v: string) => !!v.trim() && models.value.length > 0 && !models.value.includes(v.trim());
    const filterValid = (() => { if (!c.modelFilter.trim()) return true; try { new RegExp(c.modelFilter); return true; } catch { return false; } })();
    // A configured model id the current filter excludes (non-empty + no match) → flag it (ModelPicker cls).
    const excl = (v: string) => !!v.trim() && !modelFilterAllows(v, c.modelFilter);
    const pct = Math.round(fontScale.value * 100);
    const setScale = (s: number) => {
        fontScale.value = Math.min(MAX_FS, Math.max(MIN_FS, Math.round(s * 20) / 20));
        applyFont();
        chrome.storage.local.set({ [FONT_KEY]: fontScale.value });
    };
    const text = (key: keyof MlConfig, extra?: Record<string, unknown>) => ({
        type: "text", value: c[key] as string,
        onInput: (e: any) => setField(key, e.target.value, false),
        onChange: (e: any) => setField(key, e.target.value),
        ...extra,
    });
    return (
        <div class="settings">
            <div class="set-tabs" role="tablist">
                {SETTINGS_TABS.map(t => (
                    <button key={t.id} role="tab" aria-selected={tab === t.id}
                        class={`set-tab${tab === t.id ? " on" : ""}`}
                        onClick={() => { settingsTab.value = t.id; }}>{t.label}</button>
                ))}
            </div>

            <div class="set-body">
            {tab === "connection" ? <>
                <div class="set-note">Point this at <b>OpenWebUI</b> for the full feature set — server-side (Python) tools, RAG, and web search all route through it. A direct <b>Ollama</b> URL works but only gives the plain text-chat subset.</div>
                <label class="set-field"><span>Chat completions URL</span>
                    <input {...text("chatUrl")} class={c.chatUrl.trim() ? "" : "err"} />
                    <div class="set-hint">OpenWebUI: /api/chat/completions · Ollama passthrough: /ollama/api/chat</div>
                    {c.chatUrl.trim() ? null : <div class="set-err">Required — the extension won't work without this.</div>}
                </label>
                <label class="set-field"><span>API key</span>
                    <input {...text("apiKey")} type="password" placeholder="OpenWebUI → Settings → Account" />
                    <div class="set-hint">Generate one in OpenWebUI → Settings → Account → API keys.</div>
                </label>
                <label class="set-field"><Lbl tip={TIP.apiFormat}>API format</Lbl>
                    <select value={c.apiFormat} onChange={(e: any) => setField("apiFormat", e.target.value as ApiFormat)}>
                        <option value="openai">OpenAI (…/chat/completions)</option>
                        <option value="ollama">Ollama native (…/api/chat)</option>
                    </select></label>
            </> : null}

            {tab === "models" ? <>
                <div class="set-note">These are the defaults <code>ml.chat</code> / <code>ml.createChat</code> use when you don't pass a <code>model</code>. With no default <b>Model</b> set, you must specify one on every call.</div>

                <Section id="defaults" title="Defaults">
                <label class="set-field"><Lbl tip={TIP.model}>Default model</Lbl>
                    <ModelPicker fieldKey="model" options={listed} placeholder="e.g. qwen3:14b" cls={excl(c.model) ? "err" : ""} />
                    {models.value.length === 0
                        ? <div class="set-warn">No models loaded from the server — check the Server URL / API key on the Connection tab (the list + autocomplete populate once it's reachable).</div>
                        : notListed(c.model)
                            ? <div class="set-warn">"{c.model.trim()}" isn't in the server's model list — fine for a cloud model that isn't listed, but check the spelling for a local one.</div>
                            : null}
                </label>
                <label class="set-field"><Lbl tip={TIP.ocrModel}>Vision model (optional)</Lbl>
                    <ModelPicker fieldKey="ocrModel" options={listed} placeholder="e.g. qwen2.5vl" cls={(excl(c.ocrModel) || ocrSees === false) ? "err" : ""} />
                    {ocrSees === false ? <div class="set-err">"{c.ocrModel.trim()}" doesn't report vision capability — this is a vision role; pick a vision model (e.g. qwen2.5vl, gemma3, llava).</div> : null}</label>
                <label class="set-field"><Lbl tip={TIP.defaultModelVision}>Default model is vision capable?</Lbl>
                    <select value={defVisionAutoDetected ? "" : c.defaultModelVision} disabled={defVisionAutoDetected}
                        onChange={(e: any) => setField("defaultModelVision", e.target.value as VisionSupport)}>
                        <option value="">Auto-detect</option>
                        <option value="yes">Yes — native vision</option>
                        <option value="no">No</option>
                    </select>
                    <div class="set-hint">For a cloud model the extension can't probe (e.g. GPT-4o) — declaring <b>Yes</b> lets the agent see with its own model in the HUD instead of delegating to the OCR model. Ollama models are auto-detected.</div>
                    {defVisionAutoDetected ? <div class="set-moot">Ollama model — vision is auto-detected ({defModelSees ? "yes" : "no"}); this override is locked to Auto.</div> : null}
                </label>
                </Section>

                <Section id="modelFilter" title="Model access filter">
                <label class="set-field"><Lbl tip={TIP.modelFilter}>Allowed models (regex whitelist)</Lbl>
                    <input {...text("modelFilter", { placeholder: "blank = all models · e.g. ^(qwen|gemma)" })} class={filterValid ? "" : "err"} />
                    <div class="set-hint">Only matching model ids are callable via <code>window.ml</code> and shown to pages. Blank = no restriction. The rows below flag any configured model this excludes.</div>
                    {filterValid ? null : <div class="set-err">Invalid regex — the filter is inactive (all models allowed).</div>}
                </label>
                </Section>

                <Section id="utility" title="Utility model">
                <div class="set-note">A small, cheap model for side tasks and HUD summaries. If set, use it via the shorthand: <code>ml.chat("...", &#123; extend: "utility" &#125;)</code>.</div>
                <label class="set-field"><Lbl tip={TIP.utilityModel}>Utility model (optional)</Lbl>
                    <ModelPicker fieldKey="utilityModel" options={listed} placeholder="blank = use main model" cls={excl(c.utilityModel) ? "err" : ""} /></label>
                <label class="set-field"><Lbl tip={TIP.utilityNumCtx}>Utility model context size</Lbl>
                    <input type="number" min="512" step="512" value={c.utilityNumCtx} disabled={!utilOn}
                        onChange={(e: any) => setField("utilityNumCtx", parseInt(e.target.value, 10) || DEFAULT_CONFIG.utilityNumCtx)} /></label>
                <label class={`set-check${utilOn ? "" : " off"}`}>
                    <input type="checkbox" checked={c.utilityForceCpu} disabled={!utilOn}
                        onChange={(e: any) => setField("utilityForceCpu", e.target.checked)} />
                    <Lbl tip={TIP.utilityForceCpu}>Force utility onto CPU</Lbl>
                </label>
                <label class={`set-check${utilOn ? "" : " off"}`}>
                    <input type="checkbox" checked={c.autoTitles} disabled={!utilOn}
                        onChange={(e: any) => setField("autoTitles", e.target.checked)} />
                    <Lbl tip={TIP.autoTitles}>Auto-summarise with the utility model</Lbl>
                </label>
                </Section>

                <Section id="grounding" title="Visual grounding">
                <div class="set-note">Optional coordinate model for the agent's <code>locate</code> tool. <b>Loads an extra model into VRAM</b> — leave off if memory is tight. Off = <code>locate</code> still works via the Set-of-Marks screenshot tool (no extra model). Recommended: <code>qwen2.5vl:7b</code> (or <code>:3b</code>); accuracy is unproven.</div>
                <label class="set-check">
                    <input type="checkbox" checked={c.groundingEnabled}
                        onChange={(e: any) => setField("groundingEnabled", e.target.checked)} />
                    <Lbl tip={TIP.groundingEnabled}>Enable visual grounding model</Lbl>
                </label>
                <label class="set-field"><Lbl tip={TIP.groundingModel}>Grounding model</Lbl>
                    <ModelPicker fieldKey="groundingModel" options={listed} disabled={!c.groundingEnabled} cls={(excl(c.groundingModel) || groundingSees === false) ? "err" : ""}
                        placeholder={detectGroundingModel(models.value) ? `${detectGroundingModel(models.value)} (auto-detected)` : "e.g. qwen2.5vl:7b — none detected"} />
                    {groundingSees === false ? <div class="set-err">"{c.groundingModel.trim()}" doesn't report vision capability — grounding needs a coordinate-capable vision model (e.g. qwen2.5vl:7b).</div> : null}</label>
                <label class="set-field"><Lbl tip={TIP.groundingRange}>Coordinate range</Lbl>
                    <input type="number" min="1" step="1" value={c.groundingRange} disabled={!c.groundingEnabled}
                        onChange={(e: any) => setField("groundingRange", parseInt(e.target.value, 10) || DEFAULT_GROUNDING_RANGE)} /></label>
                </Section>
                <ModelTests />
            </> : null}

            {tab === "appearance" ? <>
                <Section id="general" title="General">
                <div class="set-field"><span>Font size</span>
                    <div class="stepper">
                        <button title="Smaller" onClick={() => setScale(fontScale.value - 0.1)}>−</button>
                        <span class="set-val">{pct}%</span>
                        <button title="Larger" onClick={() => setScale(fontScale.value + 0.1)}>+</button>
                        <button class="reset" title="Reset to 100%" onClick={() => setScale(1)}>reset</button>
                    </div>
                </div>
                <label class="set-field"><span>Theme</span>
                    <select value={c.theme} onChange={(e: any) => setField("theme", e.target.value as Theme)}>
                        <option value="auto">Auto (system)</option>
                        <option value="dark">Dark</option>
                        <option value="light">Light</option>
                    </select></label>
                </Section>

                <Section id="devtools" title="DevTools">
                <label class="set-field"><span>Debug panel</span>
                    <select value={c.debugMode} onChange={(e: any) => setField("debugMode", e.target.value as DebugMode)}>
                        <option value="off">Off</option>
                        <option value="overlay">In-page sidebar</option>
                        <option value="devtools">DevTools panel</option>
                    </select>
                    <div class="set-hint">Where this debug log renders. <b>In-page</b> = a slide-out on every page. <b>DevTools</b> = the “window.ml” tab, no on-page overlay. (Same setting as the toolbar popup.)</div>
                </label>
                </Section>

                <Section id="agenthud" title="Agent HUD">
                <div class="set-note">The in-page overlay — the corner card / working pill for off-mode agent runs.</div>
                <label class="set-field"><span>Card corner</span>
                    <select value={c.cardCorner} onChange={(e: any) => setField("cardCorner", e.target.value as CardCorner)}>
                        <option value="bottom-right">Bottom right</option>
                        <option value="bottom-left">Bottom left</option>
                        <option value="top-right">Top right</option>
                        <option value="top-left">Top left</option>
                    </select>
                    <div class="set-hint">Which corner the off-mode agent card / working pill anchors to. You can also <b>right-click</b> the card to move it.</div>
                </label>
                <label class="set-field"><span>Agent HUD progress indicator visibility</span>
                    <select value={c.agentHud} onChange={(e: any) => setField("agentHud", e.target.value as AgentHud)}>
                        <option value="progress">Progress (pill while running)</option>
                        <option value="quiet">Quiet (only when it needs you)</option>
                    </select>
                    <div class="set-hint"><b>Progress</b> shows a small pill in the corner while an agent runs (off mode). <b>Quiet</b> hides it — the card still appears for an approval or the final answer.</div>
                </label>
                <label class="set-check">
                    <input type="checkbox" checked={c.agentHudInDevtools}
                        onChange={(e: any) => setField("agentHudInDevtools", e.target.checked)} />
                    <span>Also show the HUD alongside the DevTools panel</span>
                </label>
                </Section>

                <Section id="codeblocks" title="Code blocks">
                <label class="set-field"><span>Long lines</span>
                    <select value={codeWrap.value ? "wrap" : "scroll"}
                        onChange={(e: any) => { codeWrap.value = e.target.value === "wrap"; applyCodePrefs(); chrome.storage.local.set({ [WRAP_KEY]: codeWrap.value }); }}>
                        <option value="wrap">Wrap (break line)</option>
                        <option value="scroll">Scroll horizontally</option>
                    </select></label>
                <label class="set-field"><span>Tool output height</span>
                    <select value={String(outMaxH.value)}
                        onChange={(e: any) => { outMaxH.value = Number(e.target.value); chrome.storage.local.set({ [OUTMAX_KEY]: outMaxH.value }); }}>
                        <option value="160">Short (160px)</option>
                        <option value={String(OUTMAX_DEFAULT)}>Default ({OUTMAX_DEFAULT}px)</option>
                        <option value="420">Tall (420px)</option>
                        <option value="0">Uncapped</option>
                    </select></label>
                <div class="set-note">How tall ANY tool's output grows before it scrolls (python_exec, exec, a big fetch_url page — every tool's output uses the same cell) — Jupyter-style, so a chatty run can't bury the transcript. Drag the grip under any cell to resize just that one, and Ctrl+F inside one to search it. While you're scrolled to the bottom it follows new streamed output; scroll up and it holds still.</div>
                <label class="set-check">
                    <input type="checkbox" checked={codeLineNumbers.value}
                        onChange={(e: any) => { codeLineNumbers.value = e.target.checked; applyCodePrefs(); chrome.storage.local.set({ [LINES_KEY]: codeLineNumbers.value }); }} />
                    <span>Show line numbers</span>
                </label>
                </Section>

                <Section id="runstats" title="Run stats">
                <label class="set-check">
                    <input type="checkbox" checked={showStatsTokens.value}
                        onChange={(e: any) => { showStatsTokens.value = e.target.checked; chrome.storage.local.set({ [STATS_TOKENS_KEY]: showStatsTokens.value }); }} />
                    <span>Show cumulative tokens (in / out)</span>
                </label>
                <label class="set-check">
                    <input type="checkbox" checked={showStatsTps.value}
                        onChange={(e: any) => { showStatsTps.value = e.target.checked; chrome.storage.local.set({ [STATS_TPS_KEY]: showStatsTps.value }); }} />
                    <span>Show generation speed (tokens/sec)</span>
                </label>
                <div class="set-note">A readout below a run's message box: total input + output tokens billed across the run, and the generation rate. Hover it for the rate's provenance — Ollama's native generation time when available (excludes network), else wall-clock per call (includes network/queue). Both figures are also in the <code>chat_metadata</code> tool and the run exports.</div>
                </Section>

                <Section id="export" title="Export">
                <label class="set-check">
                    <input type="checkbox" checked={c.exportToolDefs}
                        onChange={(e: any) => setField("exportToolDefs", e.target.checked)} />
                    <span>Include tool definitions in run exports</span>
                </label>
                <div class="set-note">Dumps the FULL tool definitions (pretty JSON — names, descriptions, parameter schemas; not the implementation) below the system prompt in a run's Markdown/PDF export, annotated with their character + approximate token cost. Off by default — it's several thousand tokens of schema.</div>
                </Section>
            </> : null}

            {tab === "advanced" ? <>
                <Section id="javascript" title="JavaScript">
                <div class="set-note">Auto-approve <b>read-only</b> <code>exec</code> surveys (querySelectorAll → filter → map, no mutation). They run through a mediated interpreter that never touches <code>window</code>/<code>fetch</code> and never <code>eval</code>s a string (so it also works on Trusted-Types pages). Anything mutating or unrecognised still asks for approval.</div>
                <label class="set-check">
                    <input type="checkbox" checked={c.autoApproveReadonly}
                        onChange={(e: any) => setField("autoApproveReadonly", e.target.checked)} />
                    <Lbl tip={TIP.autoApproveReadonly}>Auto-approve read-only exec calls</Lbl>
                </label>
                </Section>

                <Section id="python" title="Sandboxed Python">

                <div class="set-field"><span>Environment</span>
                    <div class="set-hint">Bundled packages: {PY_PACKAGES.map(p => p.load).join(", ")}, + the Python stdlib.</div>
                    <div class="py-env">
                        <span class="tt">
                            <button class="test-btn" disabled={pyEnv.value.state === "probing"} onClick={probePython}>
                                {pyEnv.value.state === "probing" ? "probing…" : "Probe sandbox"}
                            </button>
                            <span class="tt-pop left" role="tooltip">Runs a tiny script in the sandbox to report the actual Python + package versions (first run loads Pyodide, ~1–2s).</span>
                        </span>
                        {pyEnv.value.state === "ok" ? <span class="py-env-ok">{pyEnv.value.text}</span> : null}
                        {pyEnv.value.state === "err" ? <span class="py-env-err">{pyEnv.value.text}</span> : null}
                    </div>
                </div>

                <div class="set-note">Auto-approve <b>readonly-mode</b> <code>python_exec</code> calls. The Python runs in a WASM sandbox that is <b>isolated by construction</b> — no DOM, no filesystem, and in readonly mode no network or JS/extension scope — so it's a pure function over the injected image/data and can't touch the page or exfiltrate. A <code>mode:'full'</code> run (network) always asks; code with hidden/bidi characters always asks.</div>
                <label class="set-check">
                    <input type="checkbox" checked={c.autoApprovePython}
                        onChange={(e: any) => setField("autoApprovePython", e.target.checked)} />
                    <Lbl tip={TIP.autoApprovePython}>Auto-approve readonly python_exec calls</Lbl>
                </label>
                </Section>

                <Section id="fetch" title="Fetching (fetch_url / ml.fetch)">
                <div class="set-note">Auto-approve a <b>same-origin</b> fetch that spends your <b>session</b> — a <code>fetch_url</code> with <code>credentials:true</code>, or a <code>rendered:true</code> load in a normal (non-incognito) tab — on the page you're already on. OFF (default) means those always ask, so you stay in charge of when your cookies are used. <b>Never</b> affects cross-origin fetches (always ask) or the already-free uncredentialed same-origin reads.</div>
                <label class="set-check">
                    <input type="checkbox" checked={c.autoApproveSameOriginAuth}
                        onChange={(e: any) => setField("autoApproveSameOriginAuth", e.target.checked)} />
                    <Lbl tip={TIP.autoApproveSameOriginAuth}>Auto-approve same-origin fetches that use your session</Lbl>
                </label>
                <div class="set-note">Let the agent read <b>its own repo source</b> without an approval prompt — an <b>uncredentialed</b> GET of committed files (<code>raw.githubusercontent.com</code>) or structural/code API endpoints (<code>api.github.com/repos/…</code>), locked to this build's repo. <b>Never</b> auto-approves <b>issues, PRs, comments, discussions, or releases</b> (user-generated prose is a prompt-injection surface), a credentialed fetch, or a rendered load — those still ask. Public + read-only, so near-zero risk. <b>On by default.</b></div>
                <label class="set-check">
                    <input type="checkbox" checked={c.autoApproveSelfSource}
                        onChange={(e: any) => setField("autoApproveSelfSource", e.target.checked)} />
                    <Lbl tip={TIP.autoApproveSelfSource}>Auto-approve reading the agent's own repo source</Lbl>
                </label>
                </Section>

                <Section id="shadow" title="Shadow DOM">
                <div class="set-note">Let the DOM tools reach inside <b>closed</b> shadow roots (normally invisible to selectors). A tiny script captures each closed root as the page builds it, so the tools treat it like an open one (same <code>host &gt;&gt;&gt; inner</code> syntax). Closed shadow DOM is encapsulation, not a security boundary — this crosses no origin. <b>On by default</b>: the capture script wraps <code>attachShadow</code> on every page regardless of this toggle (capture only; page behaviour unchanged), so this just gates whether the tools use it. Declarative/native closed roots still fall back to visual <code>locate</code>/@pt.</div>
                <label class="set-check">
                    <input type="checkbox" checked={c.pierceClosedShadow}
                        onChange={(e: any) => setField("pierceClosedShadow", e.target.checked)} />
                    <Lbl tip={TIP.pierceClosedShadow}>Pierce closed shadow roots</Lbl>
                </label>
                </Section>

                <Section id="cdp" title="Debugger-based actions (experimental)">
                <div class="set-note">Use <code>chrome.debugger</code> (CDP) for what a normal page context can't: <b>click</b> cross-origin iframes / declarative-closed shadow roots, and run imperative <code>exec</code> on <b>strict-CSP / Trusted-Types</b> pages (GitHub, Google apps) where main-world eval is blocked. The debugger is exempt from the page's CSP/TT — the only mechanism that works. Still gated by the per-action approval. Attaching flashes Chrome's <b>“is debugging this browser” banner</b> — only for these reserved actions, so the flash marks the risk.</div>
                <CdpToggle />
                </Section>

            </> : null}

            {tab === "permissions" ? <PermissionsView /> : null}
            </div>
        </div>
    );
}
