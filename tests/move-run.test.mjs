// move-run.test.mjs — moving a run to another tab (docs/spec/MOVE_RUN.md), and the tab-id change it shares a cause with.
//
// Each test is a run in the real bundle (`dist/background.js` in node:vm, tests/helpers.js `loadBackground`), the page
// played by `onTabMessage`. A test written as `todo` shows a gap: it asserts the correct behaviour, and fails until the
// gap is fixed.
import { test } from "node:test";
import assert from "node:assert";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { jsonResponse, loadBackground } = require("./helpers");

const SITE_URL = "https://site.example/page";
const HUD_URL = "chrome-extension://test/sidebar.html";
const T = { timeout: 30000 };
const tick = () => new Promise((r) => setTimeout(r, 0));
/** Not read-only, so it goes to the gate and then to the page's main world. */
const PAGE_JS = "document.body.remove()";

/**
 * One worker-built run on tab 7, whose model calls `exec` `execs` times and then answers. The page answers `exec` through
 * `onExec(bg, msg)` (default "ran"); every other delegated message is answered empty. `onAsk(event, bg)` sees the gate's
 * awaiting-approval event instead of the test approving it from tab 7. A tab in `gone` refuses a delegated tool call, as
 * Chrome refuses a message to a tab id it no longer has.
 * @returns the worker, the run id, `ended()` (the terminal event, once out) and `results()` (what the model read)
 */
async function start({ onAsk, onExec, execs = 1, gone = new Set() } = {}) {
    let n = 0, bg;
    const steps = Array.from({ length: execs }, () => ({ name: "exec", args: { js: PAGE_JS } }));
    bg = loadBackground({
        config: { chatUrl: "http://host/api/chat/completions", apiKey: "k", model: "m", apiFormat: "openai", debugMode: "off" },
        openTabs: [{ id: 7, windowId: 3, active: true, url: SITE_URL, title: "Site" }],
        onFetch: async (call) => {
            if (call.url.endsWith("/api/models")) return jsonResponse({ data: [{ id: "m" }] });
            if (!call.url.includes("/chat/completions")) return jsonResponse({});
            const step = steps[n++];
            if (!step) return jsonResponse({ choices: [{ message: { content: "done" } }] });
            return jsonResponse({ choices: [{ message: { content: null, tool_calls: [{ id: `c${n}`, type: "function", function: { name: step.name, arguments: JSON.stringify(step.args) } }] } }] });
        },
        onTabMessage: async (t, msg) => {
            if (gone.has(t) && msg.type === "RUN_TOOL_IN_PAGE") throw new Error("Could not establish connection. Receiving end does not exist.");
            if (msg.type === "ADOPT_RUN_NOW") return { pageInfo: "" };
            if (msg.type === "ML_DEBUG_TO_PAGE" && msg.event?.awaitingApproval) {
                if (onAsk) onAsk(msg.event, bg);
                else void bg.send({ type: "SET_APPROVAL", payload: { runId: msg.event.id, seq: msg.event.seq, decision: true } }, shellOn(7));
            }
            if (msg.type !== "RUN_TOOL_IN_PAGE") return undefined;
            if (msg.payload.finish || msg.payload.renderOnly || msg.payload.precheck || msg.payload.readonlyTry) return {};
            return msg.payload.name === "exec" && onExec ? onExec(bg, msg) : { result: "ran" };
        },
    });
    bg.commit?.(7, { documentId: "doc-1", url: SITE_URL });
    const { hash } = await bg.context.__mlStartUserRunForTest(7, { task: "probe", surface: "hud", maxSteps: 5 });
    const ended = () => bg.tabMessages.map((a) => a[1]).find((m) => m?.type === "ML_DEBUG_TO_PAGE" && m.event?.kind === "agent-result" && m.event.id === hash)?.event;
    const results = () => (bg.calls.filter((c) => c.url.includes("/chat/completions")).at(-1)?.body.messages ?? []).filter((m) => m.role === "tool").map((m) => String(m.content));
    return { bg, hash, ended, results };
}
/** The content-script shell on a tab, forwarding the card's answer (what SET_APPROVAL arrives as). */
const shellOn = (tabId) => ({ tab: { id: tabId, url: SITE_URL }, url: SITE_URL, origin: "https://site.example", frameId: 0 });
/** The extension's own HUD frame on a tab (what INJECT_MESSAGE from the composer arrives as). */
const hudOn = (tabId) => ({ tab: { id: tabId, url: SITE_URL }, url: HUD_URL, frameId: 1 });
/** Waits until `done()` holds, for at most `cap` macrotasks. */
async function until(done, cap = 4000) { for (let i = 0; i < cap && !done(); i++) await tick(); return done(); }

// --- onReplaced during a live turn: what the person sends from the restored tab (MOVE_RUN.md, "Known gap") ---
// `retabRuns` (sw-runs.ts) re-files the live turn's `runInboxes` entry with the tab's maps and the run's snapshot: the
// person's answer (SET_APPROVAL) and steer (INJECT_MESSAGE) are checked against its `tabId`. The turn's own page sends
// are NOT redirected: `hostRun` closed over the old id, and following the tab mid-turn is MOVE_RUN.md shape (b), open.

test("control: the person's answer to a gate from the run's own tab reaches the gate", T, async () => {
    const r = await start({ onAsk: (ev, bg) => void bg.send({ type: "SET_APPROVAL", payload: { runId: ev.id, seq: ev.seq, decision: true } }, shellOn(7)) });
    assert.ok(await until(r.ended), "the run ends");
    assert.deepEqual(r.results(), ["ran"], "the approved exec ran and the model read it");
});

test("the person's answer to a gate from the tab after it was REPLACED under a new id reaches the gate", T, async () => {
    // A DENY, so what the model reads is the gate's own answer: an approve would pass the gate and then meet the turn's
    // send to the old id, refused (the last test here).
    const r = await start({ onAsk: (ev, bg) => { bg.replaceTab(7, 70); void bg.send({ type: "SET_APPROVAL", payload: { runId: ev.id, seq: ev.seq, decision: false } }, shellOn(70)); } });
    assert.ok(await until(r.ended), "the run ends: the gate was answered, not left waiting");
    assert.match(r.results()[0] ?? "", /^Denied by the user/, "the model read the person's answer");
});

test("control: a steer from the HUD on the run's own tab, while a page call is out, is queued", T, async () => {
    let release, steered;
    const held = new Promise((res) => { release = res; });
    const r = await start({ onExec: async (bg, msg) => { steered = await bg.send({ type: "INJECT_MESSAGE", payload: { runId: msg.payload.runId, text: "also check the footer", sayId: "s1" } }, hudOn(7)); await held; return { result: "ran" }; } });
    assert.ok(await until(() => steered !== undefined), "the steer was answered");
    assert.deepEqual(steered, { data: true });
    release();
    assert.ok(await until(r.ended));
});

test("a steer from the HUD on the tab after it was REPLACED under a new id, while a page call is out, is queued", T, async () => {
    let release, steered;
    const held = new Promise((res) => { release = res; });
    const r = await start({ onExec: async (bg, msg) => { bg.replaceTab(7, 70); steered = await bg.send({ type: "INJECT_MESSAGE", payload: { runId: msg.payload.runId, text: "also check the footer", sayId: "s1" } }, hudOn(70)); await held; return { result: "ran" }; } });
    assert.ok(await until(() => steered !== undefined), "the steer was answered");
    assert.deepEqual(steered, { data: true }, "queued for the run, which is still the restored tab's");
    release();
    assert.ok(await until(r.ended));
});

test("a live turn's page call after the replace goes to the old id and is refused, never to the new tab (shape (b) is open)", T, async () => {
    const gone = new Set();
    let replaced = false;
    const r = await start({
        execs: 2, gone,
        onAsk: (ev, bg) => void bg.send({ type: "SET_APPROVAL", payload: { runId: ev.id, seq: ev.seq, decision: true } }, shellOn(replaced ? 70 : 7)),
        onExec: async (bg) => { if (!replaced) { bg.replaceTab(7, 70); gone.add(7); replaced = true; } return { result: "ran" }; },
    });
    assert.ok(await until(r.ended), "the run ends");
    const res = r.results();
    assert.equal(res.length, 2, "both calls reached the model");
    assert.equal(res[0], "ran", "the call before the replace ran");
    assert.match(res[1], /^Error: /, "the call after it was refused, not run anywhere");
    const toNew = r.bg.tabMessages.filter(([t, m]) => t === 70 && m?.type === "RUN_TOOL_IN_PAGE");
    assert.equal(toNew.length, 0, "nothing of the turn was sent to the replacement tab");
});
