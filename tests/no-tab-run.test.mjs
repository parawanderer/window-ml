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
async function run({ first = [exec], onExec, indexedDB, keep = false, detached = false, openCreated = false, deniedOrigins = [], holdFirst, onAdopt, req = {}, local, redirectTo, ask } = {}) {
    const script = [...first];
    let bg;
    let modelCalls = 0;
    bg = loadBackground({
        openCreated, deniedOrigins,
        ...(local ? { local } : {}),
        // `redirectTo`: the tab a navigate opens (4243) reports that page once loaded, as after a server redirect.
        // A function is read at each answer, so a row can move the tab on.
        ...(redirectTo ? { onTabsGet: (id, answer) => { const to = typeof redirectTo === "function" ? redirectTo() : redirectTo; if (id === 4243 && to) { answer.url = to; answer.title = new URL(to).host; } } } : {}),
        config: { chatUrl: "http://host/api/chat/completions", apiKey: "k", model: "m", apiFormat: "openai", debugMode: "off" },
        ...(indexedDB ? { indexedDB } : {}),
        openTabs: [
            { id: 7, windowId: 3, active: false, url: SITE_URL, title: "Site" },
            { id: 8, windowId: 3, active: true, url: OTHER_URL, title: "Other" },
        ],
        onFetch: async (call) => {
            if (call.url.endsWith("/api/models")) return jsonResponse({ data: [{ id: "m" }] });
            if (!call.url.includes("/chat/completions")) return jsonResponse({});
            if (modelCalls++ === 0 && holdFirst) await holdFirst;
            const step = script.shift();
            if (!step) return jsonResponse({ choices: [{ message: { content: "done" } }] });
            return jsonResponse({ choices: [{ message: { content: null, tool_calls: [{ id: `c${Math.random()}`, type: "function", function: { name: step.name, arguments: JSON.stringify(step.args) } }] } }] });
        },
        onTabMessage: async (t, msg) => {
            if (msg.type === "ADOPT_RUN_NOW") return onAdopt ? onAdopt(t) : { pageInfo: "" };
            if (msg.type === "ML_DEBUG_TO_PAGE" && msg.event?.awaitingApproval) void bg.send({ type: "SET_APPROVAL", payload: { runId: msg.event.id, seq: msg.event.seq, decision: true } }, shellOn(t));
            // `ask(kind)`: a nested ask (an arrival's) answered as the card answers it; true approves.
            if (ask && msg.type === "ML_DEBUG_TO_PAGE") for (const a of msg.event?.asks ?? []) void bg.send({ type: "SET_APPROVAL", payload: { runId: msg.event.id, seq: msg.event.seq, ask: a.id, decision: ask(a.kind) === true } }, shellOn(t));
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
    // `detached`: started the chat page's way with "No tab" (`agent.start`, a `detached` target), not on tab 7.
    const { hash } = detached ? await startDetached(port) : await bg.context.__mlStartUserRunForTest(7, { task: "probe", surface: "hud", maxSteps: 6, ...req }, keep ? { keep: true } : undefined);
    const turns = () => bg.tabMessages.map((a) => a[1]).filter((m) => m?.type === "ML_DEBUG_TO_PAGE" && m.event?.kind === "agent-result" && m.event.id === hash).length
        + port.messages.filter((m) => m.type === "event" && m.event?.kind === "agent-result" && m.event.id === hash).length;
    const pageCalls = () => bg.tabMessages.filter(([, m]) => m?.type === "RUN_TOOL_IN_PAGE" && m.payload?.name && !m.payload.precheck && !m.payload.readonlyTry && !m.payload.renderOnly && !m.payload.finish);
    const bodies = () => bg.calls.filter((c) => c.url.includes("/chat/completions")).map((c) => c.body);
    const live = () => bg.context.__mlRunStateForTest().controllers.includes(hash);
    return { bg, hash, script, turns, pageCalls, bodies, rows, live, port };
}
/** Starts a run with no tab over the session channel, as the start form's "No tab" does; returns its hash. */
async function startDetached(port, id = 900) {
    port.send({ type: "cmd", id, command: { type: "agent.start", runtime: "local", task: "probe", maxSteps: 6, target: { kind: "detached" } } });
    assert.ok(await until(() => port.messages.some((m) => m.type === "result" && m.id === id)), "agent.start is answered");
    const answer = port.messages.find((m) => m.type === "result" && m.id === id).result;
    assert.equal(answer.ok, true, `agent.start with no tab starts: ${JSON.stringify(answer)}`);
    return { hash: answer.data.session.hash };
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
    // The closing also set the release's deadline (sw-release.ts), which the same row carries.
    const { releaseAt, ...rest } = row.background;
    assert.deepEqual(rest, { running: 0, waiting: 0, noTab: true });
    assert.equal(typeof releaseAt, "number", "the release deadline is on the row too");
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

// --- a run that STARTS with no tab: agent.start with a detached target ("No tab" in the start form) ---

test("the runtime says it can start a run with no tab (capabilities.detached)", T, async () => {
    const r = await run();
    r.port.send({ type: "cmd", id: 1, command: { type: "runtime.info", runtime: "local" } });
    assert.ok(await until(() => r.port.messages.some((m) => m.type === "result" && m.id === 1)));
    const info = r.port.messages.find((m) => m.type === "result" && m.id === 1).result;
    assert.equal(info.data?.capabilities?.detached, true);
});

test("agent.start with no tab opens and adopts nothing, tells the model it has no page, answers its page tools, and runs its worker tools", T, async () => {
    const r = await run({ detached: true, first: [exec, { name: "agent_api_docs", args: {} }] });
    // Its result goes to no tab's surfaces: the turn is seen to end by the worker, with the model's last reply read.
    assert.ok(await until(() => !r.live() && r.bodies().length >= 3), "the turn ends");
    assert.equal(r.bg.tabsCreated.length, 0, "no tab was opened");
    assert.equal(r.bg.tabMessages.filter(([, m]) => m?.type === "ADOPT_RUN_NOW").length, 0, "no page was adopted");
    assert.equal(r.pageCalls().length, 0, "nothing went to any tab");
    const first = JSON.stringify(r.bodies()[0].messages);
    assert.match(first, /This run has no tab: it started with no page/, "the model is told it has no page");
    const read = toolResults(r.bodies().at(-1));
    assert.ok(read.some((t) => /"exec" needs a page, and this run has no tab/.test(t)), "a page tool is answered with how the run gets a page");
    assert.ok(!read.at(-1).includes("needs a page"), "a worker tool ran");
    const row = r.rows().get(r.hash);
    assert.equal(row?.kind, "agent");
    assert.equal(row.page, undefined, "a run that started with no page names none");
    assert.equal(row.background?.noTab, true, "and is held with no tab");
    assert.notEqual(row.status, "interrupted");
});

test("a run started with no tab takes its next message as a turn with no page, and bring a session here gives it a tab", T, async () => {
    const r = await run({ detached: true, first: [] });
    assert.ok(await until(() => !r.live() && r.bodies().length >= 1));
    r.script.push(exec);
    assert.deepEqual(await send(r, "go on"), { ok: true, data: { mode: "turn" } });
    assert.equal(r.pageCalls().length, 0, "the second turn had no page either");
    assert.deepEqual(await r.bg.send({ type: "MOVE_RUN", payload: { runId: r.hash } }, hudOn(8)), { data: true });
    r.script.push(exec);
    const before = r.bg.tabMessages.length;
    assert.deepEqual(await send(r, "now here", 2), { ok: true, data: { mode: "turn" } });
    // other.example may not use window.ml, so the exec runs in an isolated world: its precheck is the page message.
    assert.ok(r.bg.tabMessages.slice(before).some(([t, m]) => t === 8 && m?.type === "RUN_TOOL_IN_PAGE" && m.payload?.name === "exec"), "the next turn's exec went to the tab it was brought to");
    assert.ok(!/needs a page/.test(toolResults(r.bodies().at(-1)).at(-1)), "and was not answered as having no page");
    assert.ok(await until(() => r.rows().get(r.hash)?.background === undefined), "the row no longer says no tab");
});

test("session.resume with no tab is refused as unsupported until it is built", T, async () => {
    // A resume is of a SAVED session, so this one is stored.
    const { IDBFactory } = require("fake-indexeddb");
    const r = await run({ detached: true, first: [], indexedDB: new IDBFactory() });
    assert.ok(await until(() => !r.live() && r.bodies().length >= 1));
    r.port.send({ type: "cmd", id: 5, command: { type: "session.resume", session: { runtime: "local", hash: r.hash }, target: { kind: "detached" } } });
    assert.ok(await until(() => r.port.messages.some((m) => m.type === "result" && m.id === 5)));
    assert.equal(r.port.messages.find((m) => m.type === "result" && m.id === 5).result.error?.code, "unsupported");
});

// --- navigate from no tab: the worker opens the tab, and the run moves onto it at its next step ---

const NEWS = "https://news.example/today";
const nav = (url = NEWS) => ({ name: "navigate", args: { url } });
/** The approval cards the session channel showed for the run, by tool. */
const cards = (r, tool) => r.port.messages.filter((m) => m.type === "stream" && m.message?.type === "event").map((m) => m.message.event)
    .filter((e) => e?.awaitingApproval && e.tool === tool);
/** Waits for the run's card for `tool` and answers it the chat page's way. */
async function answerCard(r, tool, decision, id = 50) {
    // The session's events reach a chat page only once it subscribes to that session.
    if (!r.port.messages.some((m) => m.type === "stream")) r.port.send({ type: "events", sub: 1, hash: r.hash });
    assert.ok(await until(() => cards(r, tool).length > 0), `the ${tool} card is shown`);
    const card = cards(r, tool).at(-1);
    r.port.send({ type: "cmd", id, command: { type: "approval.answer", session: { runtime: "local", hash: r.hash }, seq: card.seq, decision } });
    assert.ok(await until(() => r.port.messages.some((m) => m.type === "result" && m.id === id)), "the answer is taken");
    return card;
}
/** Every message of a model request, as the text the model read. */
const readText = (body) => (body?.messages ?? []).map((m) => String(m.content ?? "")).join("\n");
/** The run's `tab` records in the execution log. */
const tabLog = async (r) => (await r.bg.context.__mlRunLog.all()).filter((e) => e.run === r.hash && e.subsystem === "tab");

test("navigate from no tab asks, opens the tab once approved, and the next step runs on it: the model is told it is there", T, async () => {
    const r = await run({ detached: true, first: [nav(), exec], openCreated: true });
    const card = await answerCard(r, "navigate", "approve");
    assert.equal(card.renderIn?.target, NEWS, "the card names where the tab opens");
    assert.equal(card.renderIn?.note, undefined, "and says nothing of site access the browser grants");
    assert.ok(await until(() => !r.live()), "the turn ends");
    assert.deepEqual(r.bg.tabsCreated.map((t) => t.url), [NEWS], "one tab was opened, at the URL");
    const opened = 4243;
    assert.ok(r.bg.tabMessages.some(([t, m]) => t === opened && m?.type === "ADOPT_RUN_NOW"), "the opened tab was given the run's tools");
    // news.example may not use window.ml, so the exec runs in an isolated world: its precheck is the page message.
    assert.ok(r.bg.tabMessages.some(([t, m]) => t === opened && m?.type === "RUN_TOOL_IN_PAGE" && m.payload?.name === "exec"), "the next step's exec went to the opened tab");
    assert.match(readText(r.bodies().at(-1)), /this run had no tab; its navigate opened tab "news\.example" \(https:\/\/news\.example\/today\), and the run is on it now/);
    assert.ok(!toolResults(r.bodies().at(-1)).some((t) => /needs a page/.test(t)), "the exec was not answered as having no page");
    const moved = (await tabLog(r)).filter((e) => e.kind === "moved");
    assert.deepEqual(moved.map((e) => [e.detail.from, e.detail.to, e.reason]), [[-1, opened, "navigate"]]);
    assert.ok(await until(() => r.rows().get(r.hash)?.background === undefined), "the row no longer says no tab");
});

test("navigate from no tab with a relative or malformed URL is refused before any card, and opens nothing", T, async () => {
    const r = await run({ detached: true, first: [nav("/inbox"), nav("https:news.example"), nav("https:\\\\news.example"), nav("chrome-extension://test/sidebar.html"), nav("javascript:alert(1)")], openCreated: true });
    assert.ok(await until(() => !r.live() && r.bodies().length >= 6), "the turn ends");
    r.port.send({ type: "events", sub: 1, hash: r.hash });
    assert.ok(await until(() => r.port.messages.some((m) => m.type === "stream")));
    assert.equal(cards(r, "navigate").length, 0, "no card was shown on the chat page");
    assert.equal(r.bg.tabMessages.filter(([, m]) => m?.event?.awaitingApproval).length, 0, "nor on any tab");
    assert.equal(r.bg.tabMessages.filter(([, m]) => m?.type === "RUN_TOOL_IN_PAGE" && m.payload?.name === "navigate").length, 0, "and no page was asked to draw one");
    assert.equal(r.bg.tabsCreated.length, 0, "no tab was opened");
    const read = toolResults(r.bodies().at(-1));
    assert.equal(read.filter((t) => /^Error: this run has no tab, so navigate needs an absolute http\(s\) URL: there is no page to resolve this one against\.(\n|$)/.test(t)).length, 5, read.join("\n"));
    assert.equal(r.rows().get(r.hash)?.background?.noTab, true, "the run still has no tab");
});

test("a navigate from no tab the person refuses opens no tab", T, async () => {
    const r = await run({ detached: true, first: [nav()], openCreated: true });
    await answerCard(r, "navigate", "deny");
    assert.ok(await until(() => !r.live()), "the turn ends");
    assert.equal(r.bg.tabsCreated.length, 0, "no tab was opened");
    assert.equal((await tabLog(r)).filter((e) => e.kind === "moved" || e.kind === "nav-opened").length, 0);
    assert.equal(r.rows().get(r.hash)?.background?.noTab, true, "the run still has no tab");
});

test("navigate from no tab asks even where a same-site navigate would not: the closed tab's site is not the run's", T, async () => {
    // A run on site.example whose tab closed: a navigate back to site.example has no site to be the same as.
    const r = await run({ first: [], openCreated: true });
    assert.ok(await until(() => r.turns() >= 1 && !r.live()));
    r.bg.closeTab(7);
    assert.ok(await until(() => r.rows().get(r.hash)?.background?.noTab === true));
    r.script.push(nav(SITE_URL));
    r.port.send({ type: "cmd", id: 3, command: { type: "session.send", session: { runtime: "local", hash: r.hash }, text: "back" } });
    await answerCard(r, "navigate", "deny");
    assert.ok(await until(() => !r.live()), "the turn ends");
    assert.equal(r.bg.tabsCreated.length, 0, "refused, so nothing opened");
});

test("navigate from no tab to a site this browser keeps the extension off: the card says so, and approving opens nothing", T, async () => {
    const r = await run({ detached: true, first: [nav()], openCreated: true, deniedOrigins: ["https://news.example/*"] });
    const card = await answerCard(r, "navigate", "approve");
    assert.match(card.renderIn?.note ?? "", /does not let window\.ml run on https:\/\/news\.example/);
    assert.ok(await until(() => !r.live()), "the turn ends");
    assert.equal(r.bg.tabsCreated.length, 0, "no tab was opened");
    assert.ok(toolResults(r.bodies().at(-1)).some((t) => /No tab was opened/.test(t)));
    assert.equal(r.rows().get(r.hash)?.background?.noTab, true);
});

test("a tab the navigate opened that does not load: the model is told, and the run keeps no tab", T, async () => {
    // Not `openCreated`: the browser answers no such tab, as for one closed before it loaded.
    const r = await run({ detached: true, first: [nav(), exec] });
    await answerCard(r, "navigate", "approve");
    assert.ok(await until(() => !r.live()), "the turn ends");
    assert.equal(r.bg.tabsCreated.length, 1);
    const read = toolResults(r.bodies().at(-1));
    assert.ok(read.some((t) => /did not finish loading\. The run still has no tab/.test(t)), read.join("\n"));
    assert.ok(read.some((t) => /"exec" needs a page, and this run has no tab/.test(t)), "and its next page tool still needs one");
    assert.ok((await tabLog(r)).some((e) => e.kind === "nav-open-failed"));
});

test("a tab the navigate opened that will not take the run's tools: the model is told the move did not happen", T, async () => {
    const r = await run({ detached: true, first: [nav(), exec], openCreated: true, onAdopt: (t) => (t === 4243 ? { error: "no tools here" } : { pageInfo: "" }) });
    await answerCard(r, "navigate", "approve");
    assert.ok(await until(() => !r.live()), "the turn ends");
    assert.match(readText(r.bodies().at(-1)), /the tab your navigate opened could not take this run \(no-adopt\); the run still has no tab/);
    assert.ok(toolResults(r.bodies().at(-1)).some((t) => /"exec" needs a page/.test(t)), "its next page tool went to no tab");
    assert.equal(r.rows().get(r.hash)?.background?.noTab, true);
});

test("navigate as the turn's last step: the run moves onto the opened tab after the turn, and its next turn is told", T, async () => {
    const r = await run({ detached: true, first: [nav()], openCreated: true });
    await answerCard(r, "navigate", "approve");
    assert.ok(await until(() => !r.live()), "the turn ends");
    assert.ok(await until(() => r.rows().get(r.hash)?.background === undefined), "moved after the turn: the row no longer says no tab");
    r.script.push(exec);
    assert.deepEqual(await send(r, "go on", 2), { ok: true, data: { mode: "turn" } });
    assert.ok(r.bg.tabMessages.some(([t, m]) => t === 4243 && m?.type === "RUN_TOOL_IN_PAGE" && m.payload?.name === "exec"), "the next turn runs on the opened tab");
    assert.match(readText(r.bodies().at(-1)), /its navigate opened tab "news\.example"/);
});

// --- navigate from no tab: the page its tab lands on is judged before the move, and granted only what the judge grants ---

const LANDED = "https://landed.example/home";
/** A saved global policy over fetch, as the policy page stores one. */
const policy = (id, effect, source, label) => ({ id, scope: "global", consumer: "fetch", effect, source, label, origin: "person", created: 1760000000000 });
const credFetch = (url) => ({ name: "fetch_url", args: { url, credentials: true } });
/** Every card the run raised, on the session channel or on a tab, once each (a moved run's replay shows a card again),
 *  as [tool, text of the event]; a nested ask is [its kind, its text]. */
function allCards(r) {
    const seen = new Map();
    const events = [
        ...r.port.messages.filter((m) => m.type === "stream" && m.message?.type === "event").map((m) => m.message.event),
        ...r.bg.tabMessages.filter(([, m]) => m?.type === "ML_DEBUG_TO_PAGE").map(([, m]) => m.event),
    ];
    for (const e of events) {
        if (e?.awaitingApproval && !seen.has(`card:${e.seq}`)) seen.set(`card:${e.seq}`, [e.tool, JSON.stringify(e)]);
        for (const a of e?.asks ?? []) if (!seen.has(`ask:${a.id}`)) seen.set(`ask:${a.id}`, [a.kind, JSON.stringify(a)]);
    }
    return [...seen.values()];
}
const adopted = (r) => r.bg.tabMessages.some(([t, m]) => t === 4243 && m?.type === "ADOPT_RUN_NOW");

test("a navigate from no tab whose tab lands on another site no policy covers: the run moves, and the landed site gets no as-you grant", T, async () => {
    // A tab run's arrival no policy covers passes as it is (tests/nav-arrival-host.test.mjs): so does this one. What the
    // card granted is the page it named; a credentialed read of the landed site still asks, of the named one does not.
    // The reads are made once the tab has gone on to a third page: a read of the page the tab is ON is free, whatever got it there.
    let landed = LANDED;
    const r = await run({ detached: true, first: [nav(), exec], openCreated: true, redirectTo: () => landed });
    await answerCard(r, "navigate", "approve");
    assert.ok(await until(() => !r.live()), "the turn ends");
    assert.ok(adopted(r), "control: no policy holds it, so the run moved onto the tab");
    assert.match(readText(r.bodies().at(-1)), /its navigate opened tab "landed\.example" \(https:\/\/landed\.example\/home\)/);
    landed = "https://third.example/";
    r.bg.commit?.(4243, { documentId: "doc-third", url: landed });
    r.script.push(credFetch("https://landed.example/data"), credFetch("https://news.example/data"));
    await send(r, "go on", 2);
    const fetchCards = allCards(r).filter(([tool]) => tool === "fetch_url").map(([, e]) => e);
    assert.equal(fetchCards.filter((e) => /landed\.example\/data/.test(e)).length, 1, "a credentialed read of the landed site asks");
    assert.equal(fetchCards.filter((e) => /news\.example\/data/.test(e)).length, 0, "control: the site the card named was granted");
});

test("a navigate from no tab whose tab lands on a page a policy asks about: held, unadopted, until the person answers the arrival card", T, async () => {
    const ASK = policy("p-ask", "ask", '(c) => c.host === "landed.example"', "Check with me on landed.example");
    // An ungated tool, as tests/nav-arrival-host.test.mjs uses: a gated one's card answers the arrival first.
    const r = await run({ detached: true, first: [nav(), { name: "scroll", args: {} }], openCreated: true, redirectTo: LANDED, local: { ml_policies_global: [ASK] }, ask: () => true });
    await answerCard(r, "navigate", "approve");
    assert.ok(await until(() => !r.live()), "the turn ends");
    // A nested ask rides on the step's event (`asks`), not as a card of its own.
    const arrival = r.bg.tabMessages.findIndex(([t, m]) => t === 4243 && m?.type === "ML_DEBUG_TO_PAGE" && (m.event?.asks ?? []).some((a) => a.kind === "arrival" && /Check with me on landed\.example/.test(JSON.stringify(a))));
    const adopt = r.bg.tabMessages.findIndex(([t, m]) => t === 4243 && m?.type === "ADOPT_RUN_NOW");
    assert.ok(arrival >= 0, "the arrival card names the policy that asks");
    assert.ok(adopt > arrival, `nothing of the run reached the page before the person answered (card at ${arrival}, adopt at ${adopt})`);
    assert.ok(toolResults(r.bodies().at(-1)).some((t) => /^The tab moved to https:\/\/landed\.example, a page the run did not open by name, which the policy "Check with me on landed\.example" asks about\. The person approved the run acting on it\./.test(t)), "the model reads the tab run's own answer");
    assert.ok(r.bg.tabMessages.some(([t, m]) => t === 4243 && m?.type === "RUN_TOOL_IN_PAGE" && m.payload?.name === "scroll"), "approved, the scroll runs there");
});

test("a navigate from no tab whose tab lands on a page a policy denies: held, never adopted, and no tool runs there", T, async () => {
    const DENY = policy("p-deny", "deny", '(c) => c.host === "landed.example"', "Not landed.example");
    const r = await run({ detached: true, first: [nav(), exec], openCreated: true, redirectTo: LANDED, local: { ml_policies_global: [DENY] } });
    await answerCard(r, "navigate", "approve");
    assert.ok(await until(() => !r.live()), "the turn ends");
    assert.ok(!adopted(r), "the denied page was never given the run's tools");
    assert.ok(!r.bg.tabMessages.some(([t, m]) => t === 4243 && m?.type === "RUN_TOOL_IN_PAGE" && m.payload?.name === "exec"), "and the exec never reached it");
    assert.ok(toolResults(r.bodies().at(-1)).some((t) => /^The tab is now on https:\/\/landed\.example\/home, which the policy "Not landed\.example" denies: no tool runs on this page\./.test(t)), "the model reads the tab run's deny text");
});

test("a declined arrival on the tab a navigate from no tab opened: it has no page to go back to, so the run has no tab again and the tab is left as it is", T, async () => {
    const ASK = policy("p-ask", "ask", '(c) => c.host === "landed.example"', "Check with me on landed.example");
    const r = await run({ detached: true, first: [nav(), { name: "scroll", args: {} }, exec], openCreated: true, redirectTo: LANDED, local: { ml_policies_global: [ASK] }, ask: () => false });
    await answerCard(r, "navigate", "approve");
    assert.ok(await until(() => !r.live()), "the turn ends");
    const read = toolResults(r.bodies().at(-1));
    assert.ok(read.includes("The person declined. The run has no page again."), read.join("\n"));
    assert.ok(read.some((t) => t.startsWith('Error: "exec" needs a page, and this run has no tab.')), "the next page tool is answered with no tab");
    assert.ok(!adopted(r), "the page never took the run");
    assert.ok(!r.bg.tabMessages.some(([t, m]) => t === 4243 && m?.type === "RUN_TOOL_IN_PAGE" && m.payload?.name && !m.payload.finish), "no call reached the tab");
    assert.deepEqual(r.bg.tabsRemoved ?? [], [], "the tab is left open");
    assert.ok(await until(() => r.rows().get(r.hash)?.background?.noTab === true), "the row says no tab again");
    assert.ok((await tabLog(r)).some((e) => e.kind === "no-tab" && e.reason === "no-back"), "the log records why");
});

test("Go back on a deny card on the tab a navigate from no tab opened: the run has no tab again, and its next page tool says so", T, async () => {
    const DENY = policy("p-deny", "deny", '(c) => c.host === "landed.example"', "Not landed.example");
    const r = await run({ detached: true, first: [nav(), { name: "scroll", args: {} }, exec], openCreated: true, redirectTo: LANDED, local: { ml_policies_global: [DENY] }, ask: () => true });
    await answerCard(r, "navigate", "approve");
    assert.ok(await until(() => !r.live()), "the turn ends");
    assert.ok(toolResults(r.bodies().at(-1)).some((t) => t.startsWith('Error: "exec" needs a page, and this run has no tab.')), toolResults(r.bodies().at(-1)).join("\n"));
    assert.ok(!r.bg.tabMessages.some(([t, m]) => t === 4243 && m?.type === "RUN_TOOL_IN_PAGE" && m.payload?.name && !m.payload.finish), "no call reached the tab");
});

test("a navigate from no tab to a page a policy asks about: its card is the one ask, and its arrival on the named page is not asked about again", T, async () => {
    const ASK = policy("p-ask", "ask", '(c) => c.host === "news.example"', "Check with me on news.example");
    const r = await run({ detached: true, first: [nav(), exec], openCreated: true, local: { ml_policies_global: [ASK] } });
    await answerCard(r, "navigate", "approve");
    assert.ok(await until(() => !r.live()), "the turn ends");
    assert.deepEqual(allCards(r).filter(([tool]) => tool !== "exec").map(([tool]) => tool), ["navigate"], "no arrival card after the navigate's own");
    assert.ok(adopted(r), "the named page took the run");
});

test("navigate as the turn's last step onto a page a policy denies: the move after the turn holds the run, and its next turn runs nothing there", T, async () => {
    const DENY = policy("p-deny", "deny", '(c) => c.host === "landed.example"', "Not landed.example");
    const r = await run({ detached: true, first: [nav()], openCreated: true, redirectTo: LANDED, local: { ml_policies_global: [DENY] } });
    await answerCard(r, "navigate", "approve");
    assert.ok(await until(() => !r.live()), "the turn ends");
    assert.ok(await until(() => r.rows().get(r.hash)?.background === undefined), "moved after the turn");
    r.script.push(exec);
    await send(r, "go on", 2);
    assert.ok(!r.bg.tabMessages.some(([t, m]) => t === 4243 && m?.type === "RUN_TOOL_IN_PAGE" && m.payload?.name === "exec"), "the exec never reached the denied page");
    assert.ok(toolResults(r.bodies().at(-1)).some((t) => /"Not landed\.example" denies: no tool runs on this page/.test(t)), "the model reads why");
});

test("a run with no tab that has navigate is told how it gets a page: at its start, and when a page tool needs one", T, async () => {
    const r = await run({ detached: true, first: [exec] });
    assert.ok(await until(() => !r.live() && r.bodies().length >= 2), "the turn ends");
    assert.match(readText(r.bodies()[0]), /This run has no tab: it started with no page\. .* `navigate` to an absolute http\(s\) URL opens a tab there once the person approves, and the run goes on there\./);
    assert.ok(toolResults(r.bodies().at(-1)).includes('Error: "exec" needs a page, and this run has no tab. The tools that need no page still work. A `navigate` to an absolute http(s) URL opens a tab once the person approves, or the person can bring this session to a tab.'));
});

test("a run with no tab and no navigate keeps the page tool's answer as it was: only the person can bring it to a tab", T, async () => {
    // Every run the worker builds has navigate (run-assembly.ts `userRunOptions`), and a run a page built ends with its page,
    // so no such run reaches here today: the answer is held to its old text for when one does.
    const { noPageText } = await import("../src/sw/no-tab.ts");
    assert.equal(noPageText("exec"), 'Error: "exec" needs a page, and this run has no tab. The tools that need no page still work. The person can bring this session to a tab.');
    assert.equal(noPageText("exec", false), noPageText("exec"));
    assert.match(noPageText("exec", true), /A `navigate` to an absolute http\(s\) URL opens a tab once the person approves, or the person can bring this session to a tab\.$/);
});

// --- a FIRST turn moved while it runs: queued, not refused as a resume (bring-here.ts; a tab run's first turn too) ---

test("a tab run's first turn brought to another tab while it runs is queued and moves at its next step, not refused as still going", T, async () => {
    let release;
    const holdFirst = new Promise((res) => { release = res; });
    const r = await run({ first: [{ name: "agent_api_docs", args: {} }, exec], holdFirst });
    assert.ok(await until(() => r.live() && r.bodies().length === 1), "the first turn's first model call is out");
    const answer = await r.bg.send({ type: "MOVE_RUN", payload: { runId: r.hash } }, hudOn(8));
    assert.ok("queued" in (answer.data ?? {}), `queued: ${JSON.stringify(answer)}`);
    release();
    assert.ok(await until(() => !r.live()), "the turn ends");
    assert.ok(r.bg.tabMessages.some(([t, m]) => t === 8 && m?.type === "RUN_TOOL_IN_PAGE" && m.payload?.name === "exec"), "the exec after the move went to tab 8");
    const moved = (await tabLog(r)).filter((e) => e.kind === "moved");
    assert.deepEqual(moved.map((e) => [e.detail.from, e.detail.to, e.detail.live]), [[7, 8, true]]);
});

// --- a running turn with no tab, brought to a tab by the person (MOVE_RUN.md, shape (b) from no tab) ---

test("a running turn with no tab, brought to a tab: it moves at its next step, nothing is sent to no tab, and no tab it left is recorded", T, async () => {
    let release;
    const holdFirst = new Promise((res) => { release = res; });
    const r = await run({ detached: true, first: [{ name: "agent_api_docs", args: {} }, exec], holdFirst });
    assert.ok(await until(() => r.live() && r.bodies().length === 1), "the turn's first model call is out");
    assert.ok("queued" in ((await r.bg.send({ type: "MOVE_RUN", payload: { runId: r.hash } }, hudOn(8))).data ?? {}), "a first turn's move is queued, not refused as a resume");
    assert.ok((await tabLog(r)).some((e) => e.kind === "move-queued"), "queued for its next step");
    release();
    assert.ok(await until(() => !r.live()), "the turn ends");
    assert.ok(r.bg.tabMessages.some(([t, m]) => t === 8 && m?.type === "RUN_TOOL_IN_PAGE" && m.payload?.name === "exec"), "the exec after the move went to tab 8");
    assert.equal(r.bg.tabMessages.filter(([t]) => t === -1).length, 0, "nothing was sent to the sentinel: no leave note, no finish");
    const moved = (await tabLog(r)).filter((e) => e.kind === "moved");
    assert.deepEqual(moved.map((e) => [e.detail.from, e.detail.to, e.detail.live]), [[-1, 8, true]]);
    assert.match(readText(r.bodies().at(-1)), /the person moved this run from tab "unknown" to tab "Other"/);
    assert.ok(await until(() => r.rows().get(r.hash)?.background === undefined), "the row no longer says no tab");
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
