// The full settings view (mirrors the popup): tabbed Connection / Models /
// Appearance / Advanced. Reads/writes chrome.storage.sync directly — safe because
// this runs in the extension-origin iframe, not the page DOM — so edits sync live
// with the popup. Text fields persist on change (blur) to avoid chatty writes; the
// signal updates on input for a responsive UI + the utility-field enable gating.
import { signal } from "@preact/signals";
import type { MlConfig, ApiFormat, Theme } from "../contract";
import { DEFAULT_CONFIG } from "../contract";
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
};

// Field label with an optional hover tooltip. Left-anchored (.left) so it opens
// rightward into the panel — far-left labels would clip a centered pop.
const Lbl = ({ children, tip }: { children: string; tip?: string }) =>
    tip
        ? <span class="tt">{children}<span class="tt-pop left" role="tooltip">{tip}</span></span>
        : <span>{children}</span>;

// --- model liveness test (per model) ---
type TestState = { status: "loading" | "ok" | "err"; error?: string };
const modelTests = signal<Record<string, TestState | undefined>>({});
const MODEL_ROLES: { key: keyof MlConfig; label: string }[] = [
    { key: "model", label: "Model" },
    { key: "ocrModel", label: "OCR" },
    { key: "utilityModel", label: "Utility" },
];

const setTest = (key: keyof MlConfig, state: TestState) => { modelTests.value = { ...modelTests.value, [key]: state }; };

// A generated PNG with a known short code — for genuinely testing OCR (a text
// ping would pass on ANY model without exercising vision). null if no canvas.
function ocrTestImage(): { dataUrl: string; token: string } | null {
    try {
        const alpha = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";   // no ambiguous 0/O/1/I/L
        let token = "";
        for (let i = 0; i < 4; i++) token += alpha[Math.floor(Math.random() * alpha.length)];
        const cv = document.createElement("canvas");
        cv.width = 240; cv.height = 96;
        const ctx = cv.getContext("2d");
        if (!ctx) return null;
        ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, cv.width, cv.height);
        ctx.fillStyle = "#000"; ctx.font = "bold 60px monospace"; ctx.textBaseline = "middle";
        ctx.fillText(token, 20, 50);
        return { dataUrl: cv.toDataURL("image/png"), token };
    } catch { return null; }
}

// Test one model via the background. Text models get a trivial ping; the OCR
// model actually transcribes a generated image and we verify the code returns.
function testOne(key: keyof MlConfig): void {
    const name = (config.value[key] as string).trim();
    if (!name) return;
    setTest(key, { status: "loading" });

    // The utility model is tested through its own profile (extend:"utility") so
    // the check exercises its real num_ctx + Force-CPU config, not just the name.
    const ping = { role: "user", content: "Reply with exactly: OK" };
    const img = key === "ocrModel" ? ocrTestImage() : null;
    const payload = img
        ? { messages: [{ role: "user", content: "Transcribe the characters in this image. Output only the characters.", images: [img.dataUrl] }], model: name, ocr: true }
        : key === "utilityModel"
            ? { messages: [ping], extend: "utility" }
            : { messages: [ping], model: name };

    chrome.runtime.sendMessage({ type: "FETCH_LLM", payload }, (resp: any) => {
        const err = chrome.runtime.lastError?.message || (resp && resp.error);
        if (err) return setTest(key, { status: "err", error: String(err) });
        if (img) {
            const got = String(resp.data || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
            return setTest(key, got.includes(img.token)
                ? { status: "ok" }
                : { status: "err", error: `read "${truncate(String(resp.data || ""), 40)}" — expected ${img.token}` });
        }
        setTest(key, { status: "ok" });
    });
}
const testModels = () => { for (const { key } of MODEL_ROLES) testOne(key); };

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
            <button class="test-btn" onClick={testModels}>Test models</button>
            {MODEL_ROLES.map(({ key, label }) => {
                const name = (config.value[key] as string).trim();
                const state = !name ? "unset" : (t[key]?.status ?? "idle");
                return (
                    <div class="test-row" key={key}>
                        <TestIcon state={state} />
                        <span class="role">{label}</span>
                        <span class="name">{name || "not set"}</span>
                    </div>
                );
            })}
            {MODEL_ROLES.map(({ key }) => t[key]?.error
                ? <div class="test-err" key={key}>{truncate(t[key]!.error!, 160)}</div> : null)}
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
                <div class="set-note">If you set a utility model, then you can use it by using the shorthand: <br/><code>ml.chat("...", &#123; extend: "utility" &#125;);</code>.</div>
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
