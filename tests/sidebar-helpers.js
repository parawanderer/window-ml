// sidebar-helpers.js — the fixtures the sidebar test files share: __mlDebug event builders, and the two
// ways to reach the panel's own chrome (its settings tabs, its cursor tooltip).
//
// These were the helpers defined at the top of tests/sidebar.test.js before that file was split into
// tests/sidebar-*.test.js. A helper only ONE of those files uses stays in that file; this module is what
// more than one of them needs, so that a builder's shape is defined once and every file agrees on it.

const assert = require("node:assert");

// Build __mlDebug events like injected.js emits them (see contract.ts).
const chatStart = (hash, turn, user, opts = {}) => ({
    kind: "chat", id: `${hash}-${turn}`, ts: Date.now() + turn, save: !!opts.save,
    session: { hash, turn }, streaming: false,
    request: {
        // Explicit null passes through (caller didn't name a model → default/utility).
        model: "model" in opts ? opts.model : "m",
        extend: opts.extend ?? null,
        messages: [...(opts.system ? [{ role: "system", content: opts.system }] : []), { role: "user", content: user }],
        images: opts.images || null, toolIds: null, schema: false, think: null, maxTokens: null
    },
    config: {
        system: opts.system || null, model: opts.model || "m", think: opts.think ?? null,
        schema: false, toolIds: null, maxTokens: null, save: !!opts.save
    }
});

const chatResult = (hash, turn, content, opts = {}) => ({
    kind: "chat-result", id: `${hash}-${turn}`, ts: Date.now() + turn, save: !!opts.save,
    session: { hash, turn }, content, sources: opts.sources || null, structured: !!opts.structured,
    model: opts.model ?? null, extend: opts.extend ?? null, reasoning: opts.reasoning ?? null,
    usage: opts.usage ?? null
});

// ml.agent run events (see contract.ts DebugAgent*).
const agentStart = (hash, task, model = "m", maxSteps = 10, config = null) => ({ kind: "agent", id: hash, ts: Date.now(), save: false, session: { hash, turn: 0 }, task, model, maxSteps, config });

const agentStep = (hash, step, fields) => ({ kind: "agent-step", id: hash, ts: Date.now() + step, save: false, session: { hash, turn: step }, step, ...fields });

const agentResult = (hash, summary, steps, hitCap = false) => ({ kind: "agent-result", id: hash, ts: Date.now() + 100, save: false, session: { hash, turn: steps }, summary, steps, hitCap });

// Open the settings panel and optionally switch to a category tab (Connection /
// Models / Appearance / Advanced). Controls are grouped under tabs, so a test that
// touches e.g. the model fields must select the "Models" tab first.
const openSettings = async (w, tab) => {
    w.shadow.querySelector('[aria-label="Settings"]').click();
    await w.tick();
    if (tab) {
        [...w.shadow.querySelectorAll(".set-tab")].find(b => b.textContent.trim() === tab).click();
        await w.tick();
    }
};

// The panel's tooltip is not an attribute — it follows the cursor and is read into one shared layer (see
// the tooltip RULE in AGENTS.md), so a test hovers for it instead of reading `title`.
const hoverTip = async (w, el) => {
    el.dispatchEvent(new w.window.PointerEvent("pointermove", { bubbles: true, clientX: 40, clientY: 60 }));
    await w.flush();
    return w.shadow.querySelector(".cursor-tip")?.textContent ?? "";
};

// The "seen" indicator: a mid-run steer is LETTERBOXED (queued, delivered only at the agent's next step
// boundary), so a bubble alone doesn't tell you whether the agent got it. agent-say shows it QUEUED;
// agent-say-seen (fanned when the loop drains it) flips it to SEEN. Cross-UI + order-independent.
const agentSay = (hash, text, sayId, ts = Date.now()) => ({ kind: "agent-say", id: hash, ts, save: false, session: { hash, turn: 0 }, text, sayId });

const agentSaySeen = (hash, sayId, ts = Date.now()) => ({ kind: "agent-say-seen", id: hash, ts, save: false, session: { hash, turn: 0 }, sayId });

const streamConfig = (over = {}) => ({ system: "s", customSystem: false, tools: [], maxSteps: 20, think: null, env: true, vision: null, systemAppend: null, ...over });

// Helper: build a locate render descriptor from an array of substeps + the final pick.
const locateRender = (mode, model, substeps, extra = {}) => ({ type: "locate", mode, model, substeps, ...extra });

const openRun = async (w) => { w.shadow.querySelector(".row").click(); await w.tick(); };

// The resource tracks: a real ceiling, per-model stacking, and gaps left as gaps. The arithmetic is unit
// tested in resource-model.test.mjs; these cover what only the rendering does.
// The stacked per-pool view. The DEFAULT is now Overview (one compact overlaid track), so a test about
// per-model BANDS must choose the view that has them — seeded through storage, which also exercises restore.
const STACKED_LAYOUT = { local: { ml_res_layout: { presetId: "memory", tracks: [
    { id: "dev-0", series: ["vram.0"], mode: "stack", heightPx: 96 },
    { id: "dev-1", series: ["vram.1"], mode: "stack", heightPx: 96 },
    { id: "ram", series: ["ram"], mode: "stack", heightPx: 96 },
] } } };

const INFO_2CARD = { compute: {
    system_compute: { cpu_cores: 32, total_memory: 130142785536, free_memory: 12330946560 },
    supported_gpus: [
        { gpu_id: "0", name: "CUDA0", total_memory: 101972967424, physical_memory: 102641958912, free_memory: 80 * 1024 ** 3, runner: "CUDA" },
        { gpu_id: "1", name: "CUDA1", total_memory: 101972967424, physical_memory: 102641958912, free_memory: 94 * 1024 ** 3, runner: "CUDA" },
    ],
} };

/** The stylesheet as text. jsdom applies no stylesheet, so a layout rule can only be checked by reading it. */
const sidebarCss = () => require("node:fs").readFileSync(require("node:path").join(__dirname, "..", "src", "sidebar", "sidebar.css"), "utf8");

/** The body of the rule whose selector is exactly `selector`, ASSERTING that it exists. Slicing from a bare
 *  `indexOf` returned an empty string for a renamed selector, and every `doesNotMatch` against that passed. */
function cssRule(selector) {
    const css = sidebarCss();
    const at = css.indexOf(selector + " {");
    assert.ok(at !== -1, `no CSS rule for ${selector}`);
    return css.slice(at, css.indexOf("}", at));
}

module.exports = { chatStart, chatResult, agentStart, agentStep, agentResult, openSettings, hoverTip, agentSay, agentSaySeen, streamConfig, locateRender, openRun, STACKED_LAYOUT, INFO_2CARD, sidebarCss, cssRule };
