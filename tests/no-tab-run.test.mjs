// no-tab-run.test.mjs — a run with NO tab (docs/spec/TABLESS_RUN.md): a worker-built run whose tab closes goes on with
// none, its page tools answered with how it gets a page, its session row marked held with no tab, and a move onto a tab
// gives it one again.
//
// Each test is a run in the real bundle (`dist/background.js` in node:vm, tests/helpers.js `loadBackground`), the page
// played by `onTabMessage` and the model by `script`, one reply per model call.
import { test } from "node:test";
import assert from "node:assert";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { jsonResponse, loadBackground } = require("./helpers");

const SITE_URL = "https://site.example/page";
const OTHER_URL = "https://other.example/doc";
const HUD_URL = "chrome-extension://test/sidebar.html";
const PAGE = { url: "chrome-extension://test/sidebar/chat.html" };
const T = { timeout: 30000 };
const tick = () => new Promise((r) => setTimeout(r, 0));
/** Waits until `done()` holds, for at most `cap` macrotasks. */
async function until(done, cap = 4000) { for (let i = 0; i < cap && !done(); i++) await tick(); return done(); }
/** Not read-only, so it goes to the gate and then to the page. */
const exec = { name: "exec", args: { js: "document.body.remove()" } };
const hudOn = (tabId) => ({ tab: { id: tabId, url: OTHER_URL }, url: HUD_URL, frameId: 1 });
const shellOn = (tabId) => ({ tab: { id: tabId, url: SITE_URL }, url: SITE_URL, origin: "https://site.example", frameId: 0 });

/**
 * A worker-built run on tab 7 ("Site"), with tab 8 ("Other") open. `script` is the model's replies (tool calls, then
 * "done" once it runs out). `onExec(tab, msg)` answers a page exec (default "ran on <tab>").
 * @returns the worker, the run id, `script`, `turns()`, `pageCalls()` (every RUN_TOOL_IN_PAGE call that is not a
 *  preview), `bodies()` (every model request), `rows()` (the session list as a chat page sees it)
 */
async function run({ first = [exec], onExec, indexedDB, keep = false } = {}) {
    const script = [...first];
    let bg;
    bg = loadBackground({
        config: { chatUrl: "http://host/api/chat/completions", apiKey: "k", model: "m", apiFormat: "openai", debugMode: "off" },
        ...(indexedDB ? { indexedDB } : {}),
        openTabs: [
            { id: 7, windowId: 3, active: false, url: SITE_URL, title: "Site" },
            { id: 8, windowId: 3, active: true, url: OTHER_URL, title: "Other" },
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
    const port = bg.connect("ml-sessions", PAGE);
    port.send({ type: "sessions" });
    const rows = () => {
        const map = new Map();
        for (const m of port.messages) {
            if (m.type !== "index") continue;
            const u = m.update;
            if (u.type === "snapshot") { map.clear(); for (const s of u.sessions) map.set(s.id.hash, s); }
            else if (u.type === "upsert") map.set(u.session.id.hash, u.session);
            else if (u.type === "remove") map.delete(u.id.hash);
        }
        return map;
    };
    const { hash } = await bg.context.__mlStartUserRunForTest(7, { task: "probe", surface: "hud", maxSteps: 6 }, keep ? { keep: true } : undefined);
    const turns = () => bg.tabMessages.map((a) => a[1]).filter((m) => m?.type === "ML_DEBUG_TO_PAGE" && m.event?.kind === "agent-result" && m.event.id === hash).length
        + port.messages.filter((m) => m.type === "event" && m.event?.kind === "agent-result" && m.event.id === hash).length;
    const pageCalls = () => bg.tabMessages.filter(([, m]) => m?.type === "RUN_TOOL_IN_PAGE" && m.payload?.name && !m.payload.precheck && !m.payload.readonlyTry && !m.payload.renderOnly && !m.payload.finish);
    const bodies = () => bg.calls.filter((c) => c.url.includes("/chat/completions")).map((c) => c.body);
    const live = () => bg.context.__mlRunStateForTest().controllers.includes(hash);
    return { bg, hash, script, turns, pageCalls, bodies, rows, live, port };
}
/** What the model read back for each tool call, oldest first. */
const toolResults = (body) => (body?.messages ?? []).filter((m) => m.role === "tool").map((m) => String(m.content));
/** Sends a message to the session the way the chat page does, and waits for the turn it starts to end. */
async function send(r, text, id = 1) {
    r.port.send({ type: "cmd", id, command: { type: "session.send", session: { runtime: "local", hash: r.hash }, text } });
    assert.ok(await until(() => r.port.messages.some((m) => m.type === "result" && m.id === id)), "the send is answered");
    const answer = r.port.messages.find((m) => m.type === "result" && m.id === id).result;
    if (answer.ok) assert.ok(await until(() => !r.live()), "the turn it started ends");
    return answer;
}

// --- a worker-built run whose tab closes: it is held with no tab ---

test("a settled run whose tab closes is held with no tab: its row says so, keeps its page, and is not interrupted", T, async () => {
    const r = await run();
    assert.ok(await until(() => r.turns() >= 1 && !r.live()), "the first turn settles");
    r.bg.closeTab(7);
    assert.ok(await until(() => r.rows().get(r.hash)?.background?.noTab === true), "the row is marked held with no tab");
    const row = r.rows().get(r.hash);
    assert.deepEqual(row.background, { running: 0, waiting: 0, noTab: true });
    assert.equal(row.page?.tabId, undefined, "no tab is named");
    assert.equal(row.page?.url, SITE_URL, "the page it worked on still is");
    assert.notEqual(row.status, "interrupted", "a held run is not over");
    const log = (await r.bg.context.__mlRunLog.all()).filter((e) => e.run === r.hash && e.subsystem === "tab" && e.kind === "no-tab");
    assert.equal(log.length, 1, "the execution log says why");
    assert.equal(log[0].reason, "tab-closed");
});

test("the next message to a run with no tab is a turn with no page: a page tool is answered with how it gets one, the worker's tools still run", T, async () => {
    const r = await run();
    assert.ok(await until(() => r.turns() >= 1 && !r.live()));
    r.bg.closeTab(7);
    assert.ok(await until(() => r.rows().get(r.hash)?.background?.noTab === true));
    const sent = r.pageCalls().length;
    r.script.push(exec, { name: "agent_api_docs", args: {} });
    const answer = await send(r, "go on");
    assert.deepEqual(answer, { ok: true, data: { mode: "turn" } }, "the chat page's message is a turn, not 'the tab is closed'");
    assert.equal(r.pageCalls().length, sent, "nothing went to any tab");
    const read = toolResults(r.bodies().at(-1));
    assert.ok(read.some((t) => /"exec" needs a page, and this run has no tab/.test(t)), "the model is told the page tool needs a page");
    assert.ok(read.some((t) => /bring this session to a tab/.test(t)), "and how the run gets one");
    assert.ok(!read.at(-1).includes("needs a page"), "a worker tool after it ran");
    assert.equal(r.rows().get(r.hash)?.background?.noTab, true, "still held with no tab after the turn");
});

test("a RUNNING turn whose tab closes goes on with no tab: its next page tool is answered, the turn ends as itself, not interrupted", T, async () => {
    let release;
    const held = new Promise((res) => { release = res; });
    let n = 0;
    const r = await run({ first: [exec, exec], onExec: async (t) => { if (n++ === 0) { await held; return { error: "the tab closed" }; } return { result: `ran on ${t}` }; } });
    assert.ok(await until(() => r.pageCalls().length === 1), "the first exec is out");
    r.bg.closeTab(7);
    release();
    // Its result goes to no tab's surfaces, so the turn is seen to end by the worker: no loop, and the model's last reply read.
    assert.ok(await until(() => !r.live() && r.bodies().length >= 3), "the turn ends");
    assert.equal(r.pageCalls().length, 1, "the second exec went to no tab");
    assert.ok(toolResults(r.bodies().at(-1)).some((t) => /needs a page, and this run has no tab/.test(t)));
    const row = r.rows().get(r.hash);
    assert.notEqual(row.status, "interrupted", "it reported its own end");
    assert.equal(row.background?.noTab, true);
});

// --- a run with no tab gets one: the person brings it to a tab ---

test("bring a session here onto a run with no tab: the next turn runs on that tab, the card is rebuilt, the row drops noTab", T, async () => {
    const r = await run();
    assert.ok(await until(() => r.turns() >= 1 && !r.live()));
    r.bg.closeTab(7);
    assert.ok(await until(() => r.rows().get(r.hash)?.background?.noTab === true));
    const since = r.bg.tabMessages.length;
    assert.deepEqual(await r.bg.send({ type: "MOVE_RUN", payload: { runId: r.hash } }, hudOn(8)), { data: true });
    const replayed = r.bg.tabMessages.slice(since).filter(([t, m]) => t === 8 && m?.type === "ML_DEBUG_TO_PAGE" && m.event?.id === r.hash);
    assert.ok(replayed.some(([, m]) => m.event.kind === "agent"), "the destination's card gets the run's history, its start included");
    assert.ok(await until(() => r.rows().get(r.hash)?.background === undefined), "the row no longer says no tab");
    r.script.push(exec);
    const before = r.bg.tabMessages.length;
    assert.deepEqual(await send(r, "now here", 2), { ok: true, data: { mode: "turn" } });
    const turn = r.bg.tabMessages.slice(before);
    // other.example may not use window.ml, so the exec itself runs in an isolated world: its precheck is the page message.
    assert.ok(turn.some(([t, m]) => t === 8 && m?.type === "ADOPT_RUN_NOW"), "the tab it was brought to was given the run's tools");
    assert.ok(turn.some(([t, m]) => t === 8 && m?.type === "RUN_TOOL_IN_PAGE" && m.payload?.name === "exec"), "the next turn's exec went to that tab");
    assert.ok(!toolResults(r.bodies().at(-1)).some((t) => /needs a page/.test(t)), "and was not answered as having no page");
    const state = await r.bg.context.__mlRunLog.all();
    assert.ok(state.some((e) => e.run === r.hash && e.subsystem === "tab" && e.kind === "moved" && e.detail?.from === -1 && e.detail?.to === 8));
});

test("session.resume with a tab target gives a run with no tab that tab: the chat page's way, the same move", T, async () => {
    // A resume is of a SAVED session, so this one is kept.
    const { IDBFactory } = require("fake-indexeddb");
    const r = await run({ indexedDB: new IDBFactory(), keep: true });
    assert.ok(await until(() => r.turns() >= 1 && !r.live()));
    r.bg.closeTab(7);
    assert.ok(await until(() => r.rows().get(r.hash)?.background?.noTab === true));
    r.port.send({ type: "cmd", id: 5, command: { type: "session.resume", session: { runtime: "local", hash: r.hash }, target: { kind: "tab", tabId: 8 } } });
    assert.ok(await until(() => r.port.messages.some((m) => m.type === "result" && m.id === 5)));
    const answer = r.port.messages.find((m) => m.type === "result" && m.id === 5).result;
    assert.equal(answer.ok, true, JSON.stringify(answer));
    assert.ok(await until(() => r.rows().get(r.hash)?.background === undefined), "the row no longer says no tab");
    const moved = (await r.bg.context.__mlRunLog.all()).filter((e) => e.run === r.hash && e.subsystem === "tab" && e.kind === "moved");
    assert.deepEqual(moved.map((e) => [e.detail.from, e.detail.to]), [[-1, 8]], "moved from no tab, not hosted a second time");
});

// --- a run with no tab across a worker eviction ---

test("UPGRADE: a stored snapshot on a tab restores as before, and one with no tab restores held with no tab, on no tab", T, async () => {
    // What a turn's checkpoint writes (sw-runs.ts persistRun): the old form names a tab by its number; a run whose tab
    // closed mid-turn is checkpointed with the sentinel, which is a number too, so the restore keeps both.
    const snap = (runId, tabId) => ({ p: { runId, task: "t", tools: [], rebuild: { tools: [] } }, tabId, messages: [], version: "9.9.9", ts: Date.now() });
    const bg = loadBackground({
        config: { chatUrl: "http://host/api/chat/completions", apiKey: "k", model: "m", apiFormat: "openai", debugMode: "off" },
        local: { ml_bgrun_onatab01: snap("onatab01", 7), ml_bgrun_notab001: snap("notab001", -1) },
        openTabs: [{ id: 7, windowId: 3, active: true, url: SITE_URL, title: "Site" }],
    });
    const state = () => bg.context.__mlRunStateForTest();
    assert.ok(await until(() => state().bgRuns.includes("onatab01") && state().bgRuns.includes("notab001")), "both are restored");
    assert.deepEqual(state().activeRuns, [[7, ["onatab01"]]], "the run on a tab is registered on it, the one with no tab on none");
    assert.ok(state().rebuilds.includes("notab001"), "and the one with no tab keeps its rebuild, so a move onto a tab can adopt it");
});

// --- what does not change ---

test("a run that never lost its tab carries no background field, and its tab is named", T, async () => {
    const r = await run();
    assert.ok(await until(() => r.turns() >= 1 && !r.live()));
    await until(() => r.rows().get(r.hash)?.page?.tabId === 7, 200);
    const row = r.rows().get(r.hash);
    assert.equal(row.background, undefined);
    assert.equal(row.page?.tabId, 7);
});
