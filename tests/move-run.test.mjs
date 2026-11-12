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
 * One worker-built run on tab 7, whose model calls `exec` once and then answers. The page answers `exec` through
 * `onExec(bg, msg)` (default "ran"); every other delegated message is answered empty. `onAsk(event, bg)` sees the gate's
 * awaiting-approval event instead of the test approving it from tab 7.
 * @returns the worker, the run id, `ended()` (the terminal event, once out) and `results()` (what the model read)
 */
async function start({ onAsk, onExec } = {}) {
    let n = 0, bg;
    const steps = [{ name: "exec", args: { js: PAGE_JS } }];
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
        onTabMessage: async (_t, msg) => {
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
// `retabRuns` (sw-runs.ts) re-files the tab's maps and the run's snapshot under the new id, but not the live turn's
// `runInboxes` entry, whose `tabId` the person's answer (SET_APPROVAL) and steer (INJECT_MESSAGE) are checked against.

test("control: the person's answer to a gate from the run's own tab reaches the gate", T, async () => {
    const r = await start({ onAsk: (ev, bg) => void bg.send({ type: "SET_APPROVAL", payload: { runId: ev.id, seq: ev.seq, decision: true } }, shellOn(7)) });
    assert.ok(await until(r.ended), "the run ends");
    assert.ok(r.results().some((t) => t.includes("ran")), "the approved exec ran and the model read it");
});

test("the person's answer to a gate from the tab after it was REPLACED under a new id reaches the gate", { ...T, todo: "retabRuns does not re-key runInboxes[run].tabId; background.ts SET_APPROVAL drops the answer" }, async () => {
    const r = await start({ onAsk: (ev, bg) => { bg.replaceTab(7, 70); void bg.send({ type: "SET_APPROVAL", payload: { runId: ev.id, seq: ev.seq, decision: true } }, shellOn(70)); } });
    assert.ok(await until(r.ended), "the run ends: the gate was answered, not left waiting");
    assert.ok(r.results().some((t) => t.includes("ran")), "the approved exec ran and the model read it");
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

test("a steer from the HUD on the tab after it was REPLACED under a new id, while a page call is out, is queued", { ...T, todo: "retabRuns does not re-key runInboxes[run].tabId; background.ts INJECT_MESSAGE drops the steer" }, async () => {
    let release, steered;
    const held = new Promise((res) => { release = res; });
    const r = await start({ onExec: async (bg, msg) => { bg.replaceTab(7, 70); steered = await bg.send({ type: "INJECT_MESSAGE", payload: { runId: msg.payload.runId, text: "also check the footer", sayId: "s1" } }, hudOn(70)); await held; return { result: "ran" }; } });
    assert.ok(await until(() => steered !== undefined), "the steer was answered");
    assert.deepEqual(steered, { data: true }, "queued for the run, which is still the restored tab's");
    release();
    assert.ok(await until(r.ended));
});
