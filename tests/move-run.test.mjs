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

// --- moving a settled run to another tab: the HUD's "bring a session here" (MOVE_RUN.md, shape (a)) ---
// A worker-built run on tab 7 ("Site") finishes a turn; the person, on tab 8 ("Other"), brings it there. The model's
// replies come from `script`, one per model call, shifted as they are used, so a test lines up each turn's calls.

const OTHER_URL = "https://other.example/doc";
const exec = { name: "exec", args: { js: PAGE_JS } };

/**
 * A worker-built run on tab 7 whose first turn is `first` (tool calls, then "done"), with tabs 8 (another site) and 9 (a
 * browser page) open.
 * @returns the worker, the run id, `turns()` (how many turns have ended), `pageCalls(tab)`, `lastBody()`, `script`
 */
async function settled({ first = [exec], onExec, indexedDB } = {}) {
    const script = [...first, null];
    let bg;
    bg = loadBackground({
        config: { chatUrl: "http://host/api/chat/completions", apiKey: "k", model: "m", apiFormat: "openai", debugMode: "off" },
        ...(indexedDB ? { indexedDB } : {}),
        openTabs: [
            { id: 7, windowId: 3, active: false, url: SITE_URL, title: "Site" },
            { id: 8, windowId: 3, active: true, url: OTHER_URL, title: "Other" },
            { id: 9, windowId: 3, active: false, url: "chrome://newtab/", title: "New Tab" },
            { id: 10, windowId: 3, active: false, url: "https://third.example/page", title: "Third" },
        ],
        onFetch: async (call) => {
            if (call.url.endsWith("/api/models")) return jsonResponse({ data: [{ id: "m" }] });
            if (!call.url.includes("/chat/completions")) return jsonResponse({});
            const step = script.shift();
            if (!step) return jsonResponse({ choices: [{ message: { content: "done" } }] });
            return jsonResponse({ choices: [{ message: { content: null, tool_calls: [{ id: `c${Math.random()}`, type: "function", function: { name: step.name, arguments: JSON.stringify(step.args) } }] } }] });
        },
        onTabMessage: async (t, msg) => {
            if (msg.type === "ADOPT_RUN_NOW") return { pageInfo: "" };
            if (msg.type === "ML_DEBUG_TO_PAGE" && msg.event?.awaitingApproval) void bg.send({ type: "SET_APPROVAL", payload: { runId: msg.event.id, seq: msg.event.seq, decision: true } }, shellOn(t));
            if (msg.type !== "RUN_TOOL_IN_PAGE") return undefined;
            if (msg.payload.finish || msg.payload.renderOnly || msg.payload.precheck || msg.payload.readonlyTry) return {};
            return onExec ? onExec(t, msg) : { result: `ran on ${t}` };
        },
    });
    bg.commit?.(7, { documentId: "doc-7", url: SITE_URL });
    bg.commit?.(8, { documentId: "doc-8", url: OTHER_URL });
    const { hash } = await bg.context.__mlStartUserRunForTest(7, { task: "probe", surface: "hud", maxSteps: 5 });
    const turns = () => bg.tabMessages.map((a) => a[1]).filter((m) => m?.type === "ML_DEBUG_TO_PAGE" && m.event?.kind === "agent-result" && m.event.id === hash).length;
    const pageCalls = (tab) => bg.tabMessages.filter(([t, m]) => t === tab && m?.type === "RUN_TOOL_IN_PAGE" && m.payload?.name === "exec" && !m.payload.precheck && !m.payload.readonlyTry && !m.payload.renderOnly).length;
    const lastBody = () => bg.calls.filter((c) => c.url.includes("/chat/completions")).at(-1)?.body;
    const settledNow = () => turns() >= 1 && !bg.context.__mlRunStateForTest().controllers.includes(hash);
    assert.ok(await until(settledNow), "the first turn settles");
    return { bg, hash, script, turns, pageCalls, lastBody };
}
/** The run-log records of one run. */
const runLogOf = async (bg, hash) => (await bg.context.__mlRunLog.all()).filter((e) => e.run === hash);
/** The system notes the model read that say the run was moved. */
const movedNotes = (body) => (body?.messages ?? []).filter((m) => m.role === "system" && /moved this run/.test(String(m.content)));
/** Starts the run's next turn as the HUD on its tab does, and waits for it to end. */
async function nextTurn(r, text = "go on") {
    const before = r.turns();
    await r.bg.context.__mlUserRunActionForTest(r.hash, "send", { text, surface: "hud" });
    assert.ok(await until(() => r.turns() > before && !r.bg.context.__mlRunStateForTest().controllers.includes(r.hash)), "the next turn ends");
}

test("bring a session here: the run's next turn is hosted on the tab the HUD sits in, and nothing of it goes to the old tab", T, async () => {
    const r = await settled();
    assert.equal(r.pageCalls(7), 1, "the first turn ran on its own tab");
    assert.deepEqual(await r.bg.send({ type: "MOVE_RUN", payload: { runId: r.hash } }, hudOn(8)), { data: true });
    const since = r.bg.tabMessages.length;
    r.script.unshift(exec);
    await nextTurn(r);
    const after = r.bg.tabMessages.slice(since);
    assert.ok(after.some(([t, m]) => t === 8 && m?.type === "RUN_TOOL_IN_PAGE" && m.payload?.name === "exec"), "the next turn's exec went to the new tab");
    assert.ok(after.some(([t, m]) => t === 8 && m?.type === "ML_DEBUG_TO_PAGE" && m.event?.kind === "agent-result"), "and its result to the new tab's surfaces");
    assert.deepEqual(after.filter(([t]) => t === 7).map(([, m]) => m?.type), [], "nothing of the turn went to the old tab");
});

test("a moved run's next turn tells the model, once, as a system note naming the tab it left and the one it is on", T, async () => {
    const r = await settled({ first: [] });
    await r.bg.send({ type: "MOVE_RUN", payload: { runId: r.hash } }, hudOn(8));
    await nextTurn(r);
    const notes = movedNotes(r.lastBody());
    assert.equal(notes.length, 1, "one note");
    assert.match(notes[0].content, /from tab "Site" \(https:\/\/site\.example\/page\) to tab "Other" \(https:\/\/other\.example\/doc\)/);
    await nextTurn(r, "and again");
    assert.equal(movedNotes(r.lastBody()).length, 1, "the note is in the history once, not told again on the turn after");
});

test("a move writes one tab record naming both tabs; a run never moved writes none", T, async () => {
    const r = await settled({ first: [] });
    assert.deepEqual((await runLogOf(r.bg, r.hash)).filter((e) => e.subsystem === "tab" && e.kind === "moved"), []);
    await r.bg.send({ type: "MOVE_RUN", payload: { runId: r.hash } }, hudOn(8));
    const moved = (await runLogOf(r.bg, r.hash)).filter((e) => e.subsystem === "tab" && e.kind === "moved");
    assert.equal(moved.length, 1);
    assert.deepEqual({ from: moved[0].detail.from, to: moved[0].detail.to }, { from: 7, to: 8 });
});

test("the run's replay goes with it: the new tab's ring holds the run's events and the old tab keeps none of them", T, async () => {
    const r = await settled();
    assert.ok(r.bg.context.__mlRunStateForTest().replayTabs.includes(7), "a settled run keeps its replay on its tab");
    await r.bg.send({ type: "MOVE_RUN", payload: { runId: r.hash } }, hudOn(8));
    const tabs = r.bg.context.__mlRunStateForTest().replayTabs;
    assert.ok(tabs.includes(8), "the new tab has it");
    assert.ok(!tabs.includes(7), "the old tab, holding no other run, has no ring left");
});

test("moving a run to the tab it is already on is a no-op: no record, no note", T, async () => {
    const r = await settled({ first: [] });
    assert.deepEqual(await r.bg.send({ type: "MOVE_RUN", payload: { runId: r.hash } }, hudOn(7)), { data: true });
    assert.equal((await runLogOf(r.bg, r.hash)).filter((e) => e.kind === "moved").length, 0);
    await nextTurn(r);
    assert.equal(movedNotes(r.lastBody()).length, 0);
});

test("a move is refused, and the run stays where it was, for: a running turn, a run this worker does not hold, a browser page", T, async () => {
    let release;
    const held = new Promise((res) => { release = res; });
    const r = await settled({ first: [], onExec: () => held.then(() => ({ result: "ran" })) });
    // A running turn: the next turn's exec is held open while the move is asked for.
    r.script.unshift(exec);
    const turn = r.bg.context.__mlUserRunActionForTest(r.hash, "send", { text: "go on", surface: "hud" });
    assert.ok(await until(() => r.pageCalls(7) === 1), "the turn's page call is out");
    const running = await r.bg.send({ type: "MOVE_RUN", payload: { runId: r.hash } }, hudOn(8));
    assert.match(running.error ?? "", /running/);
    release(); await turn;
    assert.ok(await until(() => !r.bg.context.__mlRunStateForTest().controllers.includes(r.hash)));
    const unknown = await r.bg.send({ type: "MOVE_RUN", payload: { runId: "nobody01" } }, hudOn(8));
    assert.ok(unknown.error, "a run nobody holds and nobody saved is refused");
    const browserPage = await r.bg.send({ type: "MOVE_RUN", payload: { runId: r.hash } }, { ...hudOn(9), tab: { id: 9, url: "chrome://newtab/" } });
    assert.match(browserPage.error ?? "", /ordinary web page/);
    assert.equal((await runLogOf(r.bg, r.hash)).filter((e) => e.kind === "moved").length, 0, "nothing moved");
});

test("MOVE_RUN from a page's own frame (the content script) moves nothing", T, async () => {
    const r = await settled({ first: [] });
    const res = await r.bg.send({ type: "MOVE_RUN", payload: { runId: r.hash } }, { tab: { id: 8, url: OTHER_URL }, url: OTHER_URL, origin: "https://other.example", frameId: 0 });
    assert.match(res.error ?? "", /^Refused/);
    assert.equal((await runLogOf(r.bg, r.hash)).filter((e) => e.kind === "moved").length, 0);
});

// --- the tab a run was moved off: its card and panel still show the session (janitor-2 on #1717) ---

/** The `agent-note`s of the run that went to one tab's surfaces since message `since`. */
const notesOn = (r, tab, since = 0) => r.bg.tabMessages.slice(since).filter(([t, m]) => t === tab && m?.type === "ML_DEBUG_TO_PAGE" && m.event?.kind === "agent-note" && m.event.id === r.hash).map(([, m]) => m.event.text);
/** How many model calls the run's worker has made: a turn makes at least one. (`turns()` also counts the earlier
 *  result a move replays to the destination.) */
const modelCalls = (r) => r.bg.calls.filter((c) => c.url.includes("/chat/completions")).length;
/** A follow-up typed in the HUD on `tab`, as the composer sends it. */
const followUp = (r, tab, text = "and now?") => r.bg.send({ type: "USER_RUN_ACTION", payload: { hash: r.hash, action: "send", text, surface: "hud" } }, hudOn(tab));

test("the tab a run was moved off is told, once, that it moved, naming no site; the new tab is not told", T, async () => {
    const r = await settled({ first: [] });
    const since = r.bg.tabMessages.length;
    await r.bg.send({ type: "MOVE_RUN", payload: { runId: r.hash } }, hudOn(8));
    const left = notesOn(r, 7, since);
    assert.equal(left.length, 1, "one note on the old tab");
    assert.match(left[0], /moved to another tab/);
    assert.doesNotMatch(left[0], /other\.example|Other/, "it does not name where it went: it is said on the old tab's page");
    assert.deepEqual(notesOn(r, 8, since), [], "the destination is not told it was left");
    assert.ok(!r.bg.context.__mlRunStateForTest().replayTabs.includes(7), "and the note is not kept in a ring the old page can read back");
});

test("a follow-up typed on the tab a run was moved off is refused with where it went, said there, and starts no turn", T, async () => {
    const r = await settled({ first: [] });
    await r.bg.send({ type: "MOVE_RUN", payload: { runId: r.hash } }, hudOn(8));
    const since = r.bg.tabMessages.length;
    const calls = modelCalls(r);
    const res = await followUp(r, 7);
    assert.match(res.refused ?? "", /moved to another tab/, "the refusal says the session moved");
    assert.doesNotMatch(res.refused, /no longer open/, "not that the page is gone: it is open");
    assert.ok(notesOn(r, 7, since).some((t) => /^Your message was not sent: .*moved to another tab/.test(t)), "said on the tab it was typed on");
    assert.deepEqual(notesOn(r, 8, since), [], "never into the run's own tab");
    await tick();
    assert.equal(modelCalls(r), calls, "no turn: no model call");
});

test("control: a follow-up on the tab a run was moved TO starts its turn there", T, async () => {
    const r = await settled({ first: [] });
    await r.bg.send({ type: "MOVE_RUN", payload: { runId: r.hash } }, hudOn(8));
    const calls = modelCalls(r);
    const res = await followUp(r, 8);
    assert.equal(res.refused, undefined);
    assert.ok(await until(() => modelCalls(r) > calls), "the turn ran");
});

test("a run brought back to a tab it left is that tab's again; the tab it then left refuses with where it went", T, async () => {
    const r = await settled({ first: [] });
    await r.bg.send({ type: "MOVE_RUN", payload: { runId: r.hash } }, hudOn(8));
    await r.bg.send({ type: "MOVE_RUN", payload: { runId: r.hash } }, hudOn(7));
    assert.match((await followUp(r, 8)).refused ?? "", /moved to another tab/, "tab 8 was left");
    const calls = modelCalls(r);
    assert.equal((await followUp(r, 7)).refused, undefined, "tab 7 is the run's again");
    assert.ok(await until(() => modelCalls(r) > calls), "the turn ran");
});

test("control: a follow-up from a tab the run was never on keeps the old refusal", T, async () => {
    const r = await settled({ first: [] });
    assert.match((await followUp(r, 10)).refused ?? "", /no longer open/);
});

// --- the chat page's and the hub's session.resume of a run held on another tab is the same move (MOVE_RUN.md) ---

/** Sends one session command over the extension pages' `ml-sessions` port and waits for its answer. */
async function command(bg, command) {
    const port = bg.connect("ml-sessions", { url: "chrome-extension://test/chat.html" });
    port.send({ type: "cmd", id: 1, command });
    assert.ok(await until(() => port.messages.some((m) => m.id === 1 && m.type !== "index")), "the command is answered");
    return port.messages.find((m) => m.id === 1 && m.type !== "index");
}

test("session.resume of a run this worker holds on another tab moves it: one record, the note, the next turn on the new tab", T, async () => {
    const { IDBFactory } = await import("fake-indexeddb");
    const r = await settled({ first: [], indexedDB: new IDBFactory() });
    r.bg.context.__mlKeepSessionForTest(r.hash);
    await nextTurn(r, "first");   // a kept session's history is written when a turn ends: what session.resume reads
    await new Promise((res) => setTimeout(res, 100));
    const res = await command(r.bg, { type: "session.resume", session: { runtime: "local", hash: r.hash }, target: { kind: "tab", tabId: 8 } });
    if (process.env.DBG) console.log(JSON.stringify(res));
    assert.equal((await runLogOf(r.bg, r.hash)).filter((e) => e.subsystem === "tab" && e.kind === "moved").length, 1, "the same record the HUD's move writes");
    const since = r.bg.tabMessages.length;
    await nextTurn(r);
    assert.equal(movedNotes(r.lastBody()).length, 1, "the model is told");
    assert.deepEqual(r.bg.tabMessages.slice(since).filter(([t]) => t === 7).map(([, m]) => m?.type), [], "nothing of the turn went to the old tab");
    assert.deepEqual(r.bg.context.__mlRunStateForTest().bgRuns.filter((h) => h === r.hash), [r.hash], "one held run, not a second host");
});

test("a run resumed onto a tab and moved on before any turn there leaves that tab registered to nothing", T, async () => {
    const { IDBFactory } = await import("fake-indexeddb");
    const r = await settled({ first: [], indexedDB: new IDBFactory() });
    r.bg.context.__mlKeepSessionForTest(r.hash);
    await nextTurn(r, "first");
    await new Promise((res) => setTimeout(res, 100));
    await command(r.bg, { type: "session.resume", session: { runtime: "local", hash: r.hash }, target: { kind: "tab", tabId: 8 } });
    const onTab = (tab) => r.bg.context.__mlRunStateForTest().activeRuns.filter(([t, ids]) => t === tab && ids.includes(r.hash)).length;
    assert.equal(onTab(8), 1, "the resume registers it on its new tab, with no turn yet");
    assert.deepEqual(await r.bg.send({ type: "MOVE_RUN", payload: { runId: r.hash } }, hudOn(10)), { data: true });
    assert.equal(onTab(8), 0, "the tab it left holds nothing of it: no pin, no navigation sensor");
});

test("session.resume of a run on the tab it is already on is a resume as before: no move recorded, no note", T, async () => {
    const { IDBFactory } = await import("fake-indexeddb");
    const r = await settled({ first: [], indexedDB: new IDBFactory() });
    r.bg.context.__mlKeepSessionForTest(r.hash);
    await nextTurn(r, "first");   // a kept session's history is written when a turn ends: what session.resume reads
    await new Promise((res) => setTimeout(res, 100));
    await command(r.bg, { type: "session.resume", session: { runtime: "local", hash: r.hash }, target: { kind: "tab", tabId: 7 } });
    assert.equal((await runLogOf(r.bg, r.hash)).filter((e) => e.kind === "moved").length, 0);
    await nextTurn(r);
    assert.equal(movedNotes(r.lastBody()).length, 0);
});

// --- what "bring a session here" lists (bring-here.ts) ---

test("the HUD's list offers a settled run held on another tab, never one already on this tab, and never to a page's frame", T, async () => {
    const r = await settled({ first: [] });
    const onOther = await r.bg.send({ type: "LIST_BRINGABLE" }, hudOn(8));
    assert.deepEqual(onOther.data.map((s) => [s.hash, s.held, s.url]), [[r.hash, true, SITE_URL]]);
    assert.deepEqual((await r.bg.send({ type: "LIST_BRINGABLE" }, hudOn(7))).data, [], "not offered on the tab it is on");
    const page = await r.bg.send({ type: "LIST_BRINGABLE" }, { tab: { id: 8, url: OTHER_URL }, url: OTHER_URL, origin: "https://other.example", frameId: 0 });
    assert.match(page.error ?? "", /^Refused/);
});

test("BRING_HERE_ORDER: this tab's site first, then the most recent", async () => {
    const { BRING_HERE_ORDER } = await import("../src/sw/bring-order.ts");
    const rows = [
        { hash: "a", title: "a", url: "https://x.example/1", lastTs: 3, held: true },
        { hash: "b", title: "b", url: "https://here.example/1", lastTs: 1, held: true },
        { hash: "c", title: "c", url: "https://y.example/1", lastTs: 5, held: false },
        { hash: "d", title: "d", url: "https://here.example/2", lastTs: 2, held: false },
        { hash: "e", title: "e", url: "not a url", lastTs: 4, held: true },
    ];
    assert.deepEqual(rows.sort(BRING_HERE_ORDER("https://here.example")).map((r) => r.hash), ["d", "b", "c", "e", "a"]);
});

// --- a move carries the start origin (MOVE_RUN.md step 4) ---
// An uncredentialed `fetch_url` of the run's START origin is free (no card); any other origin cards. A move rewrites the
// stored `pageOrigin` to the destination's and grants it (`grantRunOrigin`), so the free origin follows the run.

/** The `fetch_url` cards the person was shown (the gate's awaiting-approval events), as `[url, why cause]`. */
const fetchCards = (bg) => bg.tabMessages.map((a) => a[1])
    .filter((m) => m?.type === "ML_DEBUG_TO_PAGE" && m.event?.awaitingApproval && m.event.tool === "fetch_url")
    .map((m) => [m.event.arguments?.url, m.event.askWhy?.cause ?? null]);
/** Runs an uncredentialed `fetch_url` of `url` as the run's next turn; returns the cards it raised. */
async function readOnce(r, url) {
    const before = fetchCards(r.bg).length;
    r.script.unshift({ name: "fetch_url", args: { url } });
    await nextTurn(r);
    return fetchCards(r.bg).slice(before);
}
const OLD_API = "https://site.example/api", NEW_API = "https://other.example/api";

test("control, no move: a read of the start origin is free and a read of the other site cards", T, async () => {
    const r = await settled({ first: [] });
    assert.deepStrictEqual(await readOnce(r, OLD_API), [], "the start origin is free");
    assert.deepStrictEqual(await readOnce(r, NEW_API), [[NEW_API, null]], "another site asks");
});

test("after a move, a read of the destination's origin is the start origin's read: free, no card", T, async () => {
    const r = await settled({ first: [] });
    await r.bg.send({ type: "MOVE_RUN", payload: { runId: r.hash } }, hudOn(8));
    assert.deepStrictEqual(await readOnce(r, NEW_API), []);
});

test("after a move, the origin the run left is no longer the start origin: a read of it cards", T, async () => {
    const r = await settled({ first: [] });
    await r.bg.send({ type: "MOVE_RUN", payload: { runId: r.hash } }, hudOn(8));
    assert.deepStrictEqual(await readOnce(r, OLD_API), [[OLD_API, null]], "asked like any other site, not free and not the start-left line");
});

test("after a move, the destination's origin stays the run's own once its tab leaves it: a read of it is free, not the start-left card", T, async () => {
    const r = await settled({ first: [] });
    await r.bg.send({ type: "MOVE_RUN", payload: { runId: r.hash } }, hudOn(8));
    r.bg.commit(8, { documentId: "doc-8b", url: "https://third.example/x" });
    assert.deepStrictEqual(await readOnce(r, NEW_API), []);
});

test("control, no move: once the run's tab leaves its start origin, a read of it cards with the start-left line", T, async () => {
    const r = await settled({ first: [] });
    r.bg.commit(7, { documentId: "doc-7b", url: "https://third.example/x" });
    assert.deepStrictEqual(await readOnce(r, OLD_API), [[OLD_API, "start-left"]]);
});
