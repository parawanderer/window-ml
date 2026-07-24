// The full settings view (mirrors the popup): tabbed Connection / Models /
// Appearance / Advanced. Reads/writes chrome.storage.sync directly — safe because
// this runs in the extension-origin iframe, not the page DOM — so edits sync live
// with the popup. Text fields persist on change (blur) to avoid chatty writes; the
// signal updates on input for a responsive UI + the utility-field enable gating.
import { signal } from "@preact/signals";
import type { MlConfig, ApiFormat, Theme, LoadedModel } from "../contract";
import { DEFAULT_CONFIG, DEFAULT_GROUNDING_RANGE, VISION_NUM_CTX, detectGroundingModel } from "../contract";
import {
    config, models, fontScale, codeWrap, codeLineNumbers,
    MAX_FS, MIN_FS, FONT_KEY, WRAP_KEY, LINES_KEY,
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

// Clarification text — same wording as the popup's hints (keep in sync).
const TIP = {
    apiFormat: "Request and response shape — match it to the URL above.",
    model: "The model list loads automatically — start typing to pick one.",
    ocrModel: "Vision model ml.read() uses for OCR — kept separate from the chat model.",
    utilityModel: "A small, cheap model for side tasks like session-title summaries. Leave blank to reuse the main model. Suggestions: qwen3.5:0.8b for an average machine, a gemma4:e2b-class model for a beefier one.",
    utilityNumCtx: "Context window (num_ctx) for the utility model. Summarising needs little context — keep it small on modest hardware; larger just uses more KV-cache memory. Only used when a utility model is set.",
    utilityForceCpu: "Run the utility model on CPU (num_gpu: 0) so it never competes with your main model for VRAM. Only used when a utility model is set.",
    autoTitles: "Let the utility model generate a short title for each debug session. Off = sessions just show the first prompt. Only runs when a utility model is set and the panel is open.",
    autoApproveReadonly: "Experimental. Run read-only exec surveys (querySelectorAll → filter → map, no mutation) without an approval prompt, via a mediated interpreter that can't reach window/fetch and never eval()s a string. Anything that mutates or isn't recognised still asks. Also lets these surveys run on Trusted-Types pages where eval is blocked.",
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
                    const state = !name ? "unset" : fresh ? st!.status : "idle";
                    const title = !name ? "Not set"
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
] as const;
type SettingsTab = typeof SETTINGS_TABS[number]["id"];
const settingsTab = signal<SettingsTab>("connection");

export function Settings() {
    const c = config.value;
    const tab = settingsTab.value;
    const utilOn = !!c.utilityModel.trim();
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
            <datalist id="ml-models">{models.value.map(m => <option key={m} value={m} />)}</datalist>

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
                <label class="set-field"><Lbl tip={TIP.model}>Default model</Lbl>
                    <input {...text("model", { list: "ml-models", placeholder: "e.g. qwen3:14b" })} /></label>
                <label class="set-field"><Lbl tip={TIP.ocrModel}>OCR model (optional)</Lbl>
                    <input {...text("ocrModel", { list: "ml-models", placeholder: "e.g. qwen2.5vl" })} /></label>

                <div class="set-group">Utility model</div>
                <div class="set-note">A small, cheap model for side tasks. If set, use it via the shorthand: <code>ml.chat("...", &#123; extend: "utility" &#125;)</code>.</div>
                <label class="set-field"><Lbl tip={TIP.utilityModel}>Utility model (optional)</Lbl>
                    <input {...text("utilityModel", { list: "ml-models", placeholder: "blank = use main model" })} /></label>
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
                    <Lbl tip={TIP.autoTitles}>Summarise chat titles with the utility model</Lbl>
                </label>

                <div class="set-group">Visual grounding (experimental)</div>
                <div class="set-note">Optional coordinate model for the agent's <code>locate</code> tool. <b>Loads an extra model into VRAM</b> — leave off if memory is tight. Off = <code>locate</code> still works via the Set-of-Marks screenshot tool (no extra model). Recommended: <code>qwen2.5vl:7b</code> (or <code>:3b</code>); accuracy is unproven.</div>
                <label class="set-check">
                    <input type="checkbox" checked={c.groundingEnabled}
                        onChange={(e: any) => setField("groundingEnabled", e.target.checked)} />
                    <Lbl tip={TIP.groundingEnabled}>Enable visual grounding model</Lbl>
                </label>
                <label class="set-field"><Lbl tip={TIP.groundingModel}>Grounding model</Lbl>
                    <input {...text("groundingModel", { list: "ml-models", disabled: !c.groundingEnabled,
                        placeholder: detectGroundingModel(models.value) ? `${detectGroundingModel(models.value)} (auto-detected)` : "e.g. qwen2.5vl:7b — none detected" })} /></label>
                <label class="set-field"><Lbl tip={TIP.groundingRange}>Coordinate range</Lbl>
                    <input type="number" min="1" step="1" value={c.groundingRange} disabled={!c.groundingEnabled}
                        onChange={(e: any) => setField("groundingRange", parseInt(e.target.value, 10) || DEFAULT_GROUNDING_RANGE)} /></label>
                <ModelTests />
            </> : null}

            {tab === "appearance" ? <>
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

                <div class="set-group">Code blocks</div>
                <label class="set-field"><span>Long lines</span>
                    <select value={codeWrap.value ? "wrap" : "scroll"}
                        onChange={(e: any) => { codeWrap.value = e.target.value === "wrap"; applyCodePrefs(); chrome.storage.local.set({ [WRAP_KEY]: codeWrap.value }); }}>
                        <option value="wrap">Wrap (break line)</option>
                        <option value="scroll">Scroll horizontally</option>
                    </select></label>
                <label class="set-check">
                    <input type="checkbox" checked={codeLineNumbers.value}
                        onChange={(e: any) => { codeLineNumbers.value = e.target.checked; applyCodePrefs(); chrome.storage.local.set({ [LINES_KEY]: codeLineNumbers.value }); }} />
                    <span>Show line numbers</span>
                </label>
            </> : null}

            {tab === "advanced" ? <>
                <div class="set-note">Auto-approve <b>read-only</b> <code>exec</code> surveys (querySelectorAll → filter → map, no mutation). They run through a mediated interpreter that never touches <code>window</code>/<code>fetch</code> and never <code>eval</code>s a string (so it also works on Trusted-Types pages). Anything mutating or unrecognised still asks for approval.</div>
                <label class="set-check">
                    <input type="checkbox" checked={c.autoApproveReadonly}
                        onChange={(e: any) => setField("autoApproveReadonly", e.target.checked)} />
                    <Lbl tip={TIP.autoApproveReadonly}>Auto-approve read-only exec calls</Lbl>
                </label>
            </> : null}
            </div>
        </div>
    );
}
