// redteam-tabless-run.test.mjs — what a run with NO tab (docs/spec/TABLESS_RUN.md, the build at 18723108) must not give a page, and must not lose, once its tab closes: an answer to its gate, a page tool on any tab, a session row or a page send naming the sentinel, a sender with no tab treated as its owner, or another tab's runs dragged along with it. Every row is a worker-built run in the real bundle (`director/background.js` in node:vm, tests/helpers.js `loadBackground`), its page played by `onTabMessage`, its model by `script`, and the chat page by the `ml-sessions` port.
//
// The hazard throughout is the sentinel: a tab that closed is filed under chrome.tabs.TAB_ID_NONE (-1) instead of ending the run, so every place that compares a message's sender tab, a run's owner, or a session row's page with the run's tab now compares with -1 as well. A page is never -1; a sender with NO tab is `undefined` where a default is easy to write, and `!sender.tab` is the shortcut several checks take.

import { test } from "node:test";
import assert from "node:assert";

const { createRequire } = await import("node:module");
const require = createRequire(import.meta.url);
const { jsonResponse, loadBackground } = require("./helpers");
const { builtinTool } = await import("../src/tools/tool-registry.ts");

const SITE_URL = "https://site.example/page";
const OTHER_URL = "https://other.example/doc";
const CHAT = { url: "chrome-extension://test/sidebar/chat.html" };
const EXT = { url: "chrome-extension://test/sidebar.html" };
const T = { timeout: 30000 };
const tick = () => new Promise((r) => setTimeout(r, 0));
/** Waits until `done()` holds, for at most `cap` macrotasks. */
async function until(done, cap = 4000) { for (let i = 0; i < cap && !done(); i++) await tick(); return done(); }
const pageSender = (tabId, url) => ({ tab: { id: tabId, url }, url, frameId: 0, origin: new URL(url).origin });
const exec = { name: "exec", args: { js: "document.body.remove()" } };

/**
 * A worker-built run on tab 7, with tab 8 open; `script` is the model's replies. The chat page (an extension page)
 * is connected and subscribed to the run's events. `onExec(tab, msg)` answers a page exec (default "ran on <tab>").
 * @returns the worker, the run id, and readers for the rows, the run's streamed events and the model requests
 */
async function run({ first = [], onExec, approve } = {}) {
    const script = [...first];
    let bg;
    bg = loadBackground({
        config: { chatUrl: "http://host/api/chat/completions", apiKey: "k", model: "m", apiFormat: "openai", debugMode: "off" },
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
            if (msg.type === "ML_DEBUG_TO_PAGE" && approve && msg.event?.awaitingApproval) {
                void bg.send({ type: "SET_APPROVAL", payload: { runId: msg.event.id, seq: msg.event.seq, decision: true } }, EXT);
                return undefined;
            }
            if (msg.type === "ADOPT_RUN_NOW") return { pageInfo: "" };
            if (msg.type !== "RUN_TOOL_IN_PAGE" || msg.payload?.finish || msg.payload?.renderOnly || msg.payload?.precheck || msg.payload?.readonlyTry) return undefined;
            return onExec ? onExec(t, msg) : { result: `ran on ${t}` };
        },
    });
    bg.commit(7, { documentId: "doc-7", url: SITE_URL });
    bg.commit(8, { documentId: "doc-8", url: OTHER_URL });
    const port = bg.connect("ml-sessions", CHAT);
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
    const events = () => port.messages.filter((m) => m.type === "stream" && m.message?.type === "event").map((m) => m.message.event);
    const bodies = () => bg.calls.filter((c) => c.url.includes("/chat/completions")).map((c) => c.body);
    const live = (h) => bg.context.__mlRunStateForTest().controllers.includes(h);
    const state = () => bg.context.__mlRunStateForTest();
    return { bg, port, rows, events, bodies, live, state, script, port2: (h) => port.send({ type: "events", sub: 1, hash: h }) };
}
/** Sends a message to a session the way the chat page does and waits for the turn it starts to end. */
async function send(r, hash, text, id = 1) {
    r.port.send({ type: "cmd", id, command: { type: "session.send", session: { runtime: "local", hash }, text } });
    assert.ok(await until(() => r.port.messages.some((m) => m.type === "result" && m.id === id)), "the send is answered");
    const answer = r.port.messages.find((m) => m.type === "result" && m.id === id).result;
    if (answer.ok) assert.ok(await until(() => !r.live(hash), 8000), "the turn it started ends");
    return answer;
}
/** The tool results the model read back, oldest first. */
const toolResults = (body) => (body?.messages ?? []).filter((m) => m.role === "tool").map((m) => String(m.content));

// --- a page cannot answer or steer a run with no tab ---

test("RED TEAM: neither a page on another tab nor a page on the closed tab's reused id can answer a no-tab run's gate, and the person's chat page can", T, async () => {
    const r = await run();
    const { hash } = await r.bg.context.__mlStartUserRunForTest(7, { task: "probe", surface: "hud", maxSteps: 6 });
    await until(() => !r.live(hash));
    r.port2(hash);
    r.bg.closeTab(7);
    assert.ok(await until(() => r.rows().get(hash)?.background?.noTab === true), "the run is held with no tab");
    // A worker tool still gates (a page tool would be answered before the gate): python_exec asks unless auto-approved.
    r.script.push({ name: "python_exec", args: { code: "1+1" } });
    r.port.send({ type: "cmd", id: 1, command: { type: "session.send", session: { runtime: "local", hash }, text: "compute" } });
    assert.ok(await until(() => r.port.messages.some((m) => m.type === "result" && m.id === 1)), "the send is answered");
    assert.ok(await until(() => r.events().some((e) => e?.awaitingApproval)), "the gate is streamed to the chat page (a surface that can see and answer it)");
    const gate = r.events().filter((e) => e?.awaitingApproval).at(-1);
    assert.equal(gate.tool, "python_exec", "positive control: the gate is the worker tool that asks");
    const pending = () => r.rows().get(hash)?.pendingApprovals;
    assert.equal(pending(), 1, "positive control: the row shows the ask");
    // Both refused shapes: another tab's page, and the page of a NEW document on the id the closed tab used.
    void r.bg.send({ type: "SET_APPROVAL", payload: { runId: hash, seq: gate.seq, decision: true } }, pageSender(8, OTHER_URL));
    void r.bg.send({ type: "SET_APPROVAL", payload: { runId: hash, seq: gate.seq, decision: true } }, pageSender(7, SITE_URL));
    await until(() => false, 20);
    assert.ok(r.live(hash), "a page's approval ended the turn: it answered for a run with no tab");
    assert.equal(pending(), 1, "a page's approval resolved the gate: it answered for a run with no tab");
    // The person's own surface answers over the session channel, by the run's hash and the seq it was shown.
    r.port.send({ type: "cmd", id: 2, command: { type: "approval.answer", session: { runtime: "local", hash }, seq: gate.seq, decision: "approve" } });
    assert.ok(await until(() => r.port.messages.some((m) => m.type === "result" && m.id === 2)));
    assert.deepEqual(r.port.messages.find((m) => m.type === "result" && m.id === 2).result, { ok: true, data: { resolved: true } }, "positive control: the person's answer resolves the gate");
    assert.ok(await until(() => !r.live(hash), 8000), "the approved call ran and the turn ended");
    assert.ok(!toolResults(r.bodies().at(-1)).some((t) => /^Error: the arguments|not approved|denied/.test(t)), "the approved call was not answered as denied");
});

test("RED TEAM: a page cannot start, resume, steer, cancel or move a no-tab run, while it is live", T, async () => {
    const r = await run();
    const { hash } = await r.bg.context.__mlStartUserRunForTest(7, { task: "probe", surface: "hud", maxSteps: 6 });
    await until(() => !r.live(hash));
    r.port2(hash);
    r.bg.closeTab(7);
    assert.ok(await until(() => r.rows().get(hash)?.background?.noTab === true));
    r.script.push({ name: "python_exec", args: { code: "1+1" } });
    r.port.send({ type: "cmd", id: 1, command: { type: "session.send", session: { runtime: "local", hash }, text: "compute" } });
    assert.ok(await until(() => r.events().some((e) => e?.awaitingApproval)), "a live turn holds a gate");
    const before = r.bodies().length;
    const refusals = await Promise.all([
        r.bg.send({ type: "START_RUN", payload: { runId: hash, task: "again", systemPrompt: "S", tools: [], model: "m", think: null, maxSteps: 3, autoApprovePython: false, autoApproveReadonly: false, surface: "off" } }, pageSender(7, SITE_URL)),
        r.bg.send({ type: "RESUME_RUN", payload: { runId: hash, task: "" } }, pageSender(7, SITE_URL)),
        r.bg.send({ type: "INJECT_MESSAGE", payload: { runId: hash, text: "steer" } }, pageSender(7, SITE_URL)),
        r.bg.send({ type: "MOVE_RUN", payload: { runId: hash } }, pageSender(8, OTHER_URL)),
    ]);
    void r.bg.send({ type: "PAGE_CANCEL_RUN", payload: { runId: hash } }, pageSender(7, SITE_URL));
    await until(() => false, 20);
    for (const [i, answer] of refusals.entries()) assert.ok(answer?.error || answer?.data === false, `a page's message ${i} was not refused: ${JSON.stringify(answer)}`);
    assert.ok(r.live(hash), "a page stopped the run");
    assert.equal(r.rows().get(hash)?.pendingApprovals, 1, "a page changed the gate");
    assert.equal(r.bodies().length, before, "a page caused a model call");
    // The person can still stop it, so the refusals are the page's and not a run nobody can reach.
    r.port.send({ type: "cmd", id: 9, command: { type: "session.cancel", session: { runtime: "local", hash } } });
    assert.ok(await until(() => r.port.messages.some((m) => m.type === "result" && m.id === 9)));
    assert.ok(await until(() => !r.live(hash), 8000), "positive control: the person's Stop ends the run");
});

test("RED TEAM: a page cannot write its events into a no-tab run's session, on any tab id", T, async () => {
    const r = await run();
    const { hash } = await r.bg.context.__mlStartUserRunForTest(7, { task: "probe", surface: "hud", maxSteps: 4 });
    await until(() => !r.live(hash));
    r.port2(hash);
    r.bg.closeTab(7);
    assert.ok(await until(() => r.rows().get(hash)?.background?.noTab === true));
    const seen = r.events().length;
    const forged = (kind, over) => ({ kind, id: hash, ts: 1, save: false, session: { hash, turn: 0 }, ...over });
    for (const tabId of [7, 8]) {
        void r.bg.send({ type: "ML_DEBUG_EVENT", event: forged("agent-step", { step: 99, tool: "forged" }) }, pageSender(tabId, tabId === 7 ? SITE_URL : OTHER_URL));
        void r.bg.send({ type: "ML_SESSION_EVENT", event: forged("agent-result", { summary: "forged", steps: 1, hitCap: false }) }, pageSender(tabId, tabId === 7 ? SITE_URL : OTHER_URL));
    }
    const status = r.rows().get(hash)?.status;
    await until(() => false, 20);
    assert.deepEqual(r.events().slice(seen), [], "a page wrote an event into a run the worker owns");
    assert.equal(r.rows().get(hash)?.status, status, "a forged result changed the run's status");
});

// --- a page tool of a run with no tab reaches no tab ---

test("RED TEAM: every page-realm tool the run offers is answered with how the run gets a page, and not one message reaches any tab", T, async () => {
    const r = await run();
    const { hash } = await r.bg.context.__mlStartUserRunForTest(7, { task: "probe", surface: "hud", maxSteps: 40 });
    await until(() => r.bodies().length >= 1);
    await until(() => !r.live(hash));
    const offered = (r.bodies()[0].tools ?? []).map((t) => t.function?.name ?? t.name);
    // Enumerate, never sample: every tool whose realm is the page. The loop's own tools (chat_metadata) are not a page
    // tool even though their realm says so, and are asserted on their own below.
    const caps = (r.bodies()[0].tools ?? []).filter((t) => builtinTool(t.function?.name ?? t.name)?.realm === "page" && !t.function?.capabilities?.includes("meta")).map((t) => t.function?.name ?? t.name);
    assert.ok(caps.length > 8, `only ${caps.length} page tools offered (${caps.join(", ")}), too few to be the run's page set`);
    r.bg.closeTab(7);
    assert.ok(await until(() => r.rows().get(hash)?.background?.noTab === true));
    const since = r.bg.tabMessages.length;
    for (const name of caps) r.script.push({ name, args: {} });
    await send(r, hash, "try them all", 3);
    assert.deepEqual(r.bg.tabMessages.slice(since), [], "a page tool of a run with no tab reached a tab");
    const read = toolResults(r.bodies().at(-1));
    for (const name of caps) {
        assert.ok(read.some((t) => t.includes(`"${name}" needs a page`)), `"${name}" was not answered with how the run gets a page: ${read.find((t) => t.includes(name)) ?? "no result"}`);
    }
    assert.equal(read.filter((t) => /needs a page, and this run has no tab/.test(t)).length, caps.length, "a page tool ran instead of being answered");
    assert.equal(r.state().activeRuns.length, 0, "the detached run registered on a tab");
});

// --- the sentinel reaches no session row and no page ---

test("RED TEAM: no session row names the no-tab sentinel as the run's page, and the sentinel never crosses the session boundary", T, async () => {
    const r = await run();
    const { hash } = await r.bg.context.__mlStartUserRunForTest(7, { task: "probe", surface: "hud", maxSteps: 4 });
    await until(() => !r.live(hash));
    r.bg.closeTab(7);
    assert.ok(await until(() => r.rows().get(hash)?.background?.noTab === true));
    r.script.push({ name: "agent_api_docs", args: {} });
    await send(r, hash, "again", 2);
    const row = r.rows().get(hash);
    assert.equal(row.page?.tabId, undefined, "the row names the sentinel as its tab");
    assert.equal(row.page?.url, SITE_URL, "the page it worked on is kept");
    for (const [h, s] of r.rows()) assert.notEqual(s.page?.tabId, -1, `${h} carries the sentinel as its tab`);
    assert.ok(!JSON.stringify([...r.rows().values()]).includes('"tabId":-1'), "a session row carries the sentinel");
});

test("RED TEAM: the sentinel is never handed to a tab-keyed browser call: a no-tab session's highlight and screenshot address no tab", { todo: "open: `tabOf` (session-commands.ts:272) now resolves a no-tab run to the sentinel, and `page.highlight` (:748) passes it to `deps.highlight` → `chrome.tabs.sendMessage(-1, ML_HL_REMOTE)` — measured: one tab message to -1. Chrome refuses an unknown tab id, so no page receives it, but the worker addresses a tab it knows does not exist and answers ok. Guard with isNoTab in `tabOf`/`highlight` (fail `unavailable` as for a closed tab), and give `tab.screenshot`'s session branch the same refusal" }, T, async () => {
    const r = await run();
    const { hash } = await r.bg.context.__mlStartUserRunForTest(7, { task: "probe", surface: "hud", maxSteps: 4 });
    await until(() => !r.live(hash));
    r.bg.closeTab(7);
    assert.ok(await until(() => r.rows().get(hash)?.background?.noTab === true));
    const since = r.bg.tabMessages.length;
    r.port.send({ type: "cmd", id: 1, command: { type: "page.highlight", session: { runtime: "local", hash }, ref: { selector: "h1" } } });
    r.port.send({ type: "cmd", id: 2, command: { type: "tab.screenshot", target: { session: { runtime: "local", hash } } } });
    await until(() => r.port.messages.filter((m) => m.type === "result" && (m.id === 1 || m.id === 2)).length === 2, 400);
    assert.deepEqual(r.bg.tabMessages.slice(since).filter(([t]) => t === -1), [], "the sentinel was handed to a tab-keyed send");
});

// --- a sender with no tab is not the owner of a run with no tab ---

test("RED TEAM: a sender with NO tab owns a no-tab run only when it is this extension's own surface", { todo: "open: `senderOwnsRun` (sw-runs.ts:730) trusts `!sender.tab` as an extension page, so a no-tab sender with a WEB url resolves the gate — measured: the python_exec ask closed and the turn ended. No web page can send a runtime message, so the shape is unreachable in Chrome today, but the check rests on the browser rather than on the message: it should be `!sender.tab && isExtensionSender(sender)`, as MOVE_RUN already is" }, T, async () => {
    const r = await run();
    const { hash } = await r.bg.context.__mlStartUserRunForTest(7, { task: "probe", surface: "hud", maxSteps: 6 });
    await until(() => !r.live(hash));
    r.port2(hash);
    r.bg.closeTab(7);
    assert.ok(await until(() => r.rows().get(hash)?.background?.noTab === true));
    r.script.push({ name: "python_exec", args: { code: "1+1" } });
    r.port.send({ type: "cmd", id: 1, command: { type: "session.send", session: { runtime: "local", hash }, text: "compute" } });
    assert.ok(await until(() => r.events().some((e) => e?.awaitingApproval)));
    const gate = r.events().filter((e) => e?.awaitingApproval).at(-1);
    // A sender with NO tab and a web origin. Its steer and move are refused; its approval must be too.
    const web = { url: "https://evil.example/x", frameId: 0, origin: "https://evil.example" };
    assert.deepEqual(await r.bg.send({ type: "INJECT_MESSAGE", payload: { runId: hash, text: "steer" } }, web), { data: false }, "a no-tab web sender steered the run");
    assert.ok((await r.bg.send({ type: "MOVE_RUN", payload: { runId: hash } }, web))?.error, "a no-tab web sender moved the run");
    void r.bg.send({ type: "SET_APPROVAL", payload: { runId: hash, seq: gate.seq, decision: true } }, web);
    await until(() => false, 20);
    assert.ok(r.live(hash), "a sender with no tab that is not this extension answered the run's gate");
    assert.equal(r.rows().get(hash)?.pendingApprovals, 1, "a sender with no tab that is not this extension resolved the gate");
    // Positive control: the extension's own page (also no tab) does answer it.
    void r.bg.send({ type: "SET_APPROVAL", payload: { runId: hash, seq: gate.seq, decision: true } }, EXT);
    assert.ok(await until(() => !r.live(hash), 8000), "positive control: the extension page's answer resolves the gate");
});

// --- one tab's close moves only its own worker runs ---

test("RED TEAM: closing a tab detaches only the worker runs on it: another tab's run keeps its tab and its page tools, and a page-hosted session there is interrupted and never marked no-tab", T, async () => {
    const r = await run({ approve: true });
    const { hash } = await r.bg.context.__mlStartUserRunForTest(7, { task: "probe", surface: "hud", maxSteps: 6 });
    await until(() => !r.live(hash));
    r.port2(hash);
    const other = await r.bg.context.__mlStartUserRunForTest(8, { task: "other", surface: "hud", maxSteps: 6 });
    await until(() => !r.live(other.hash));
    r.port2(other.hash);
    // A session a PAGE hosts on tab 7 (its loop is the page's): closing the tab ends it, as before.
    void r.bg.send({ type: "ML_SESSION_EVENT", event: { kind: "agent", id: "cafe0001", ts: 1, save: false, session: { hash: "cafe0001", turn: 0 }, task: "page run", model: "m", maxSteps: 3, config: null } }, pageSender(7, SITE_URL));
    assert.ok(await until(() => r.rows().get("cafe0001")?.status === "running" && r.rows().get("cafe0001")?.page?.tabId === 7));
    r.bg.closeTab(7);
    assert.ok(await until(() => r.rows().get(hash)?.background?.noTab === true), "the run on the closed tab is held with no tab");
    const swept = r.rows().get(other.hash);
    assert.equal(swept?.page?.tabId, 8, "the other tab's run lost its tab with a different tab's close");
    assert.equal(swept?.background, undefined, "the other tab's run was marked with a background field");
    assert.ok(r.state().bgRuns.includes(other.hash), "the other tab's run was dropped from the worker's runs with a different tab's close");
    const page = r.rows().get("cafe0001");
    assert.equal(page?.status, "interrupted", "the page-hosted session on the closed tab was not interrupted");
    assert.equal(page?.background, undefined, "a page-hosted session was marked held with no tab");
    assert.equal(page?.page?.tabId, undefined, "the page-hosted session kept the closed tab");
    // The survivor still reaches its page.
    const since = r.bg.tabMessages.length;
    r.script.push({ name: "pageInfo", args: {} });
    await send(r, other.hash, "on the other page", 7);
    const went = r.bg.tabMessages.slice(since).filter(([, m]) => m?.type === "RUN_TOOL_IN_PAGE" && m.payload?.name === "pageInfo" && !m.payload?.precheck && !m.payload?.readonlyTry && !m.payload?.renderOnly);
    assert.deepEqual(went.map(([t]) => t), [8], "the surviving run's page tool did not go to its own tab and only there");
    assert.ok(toolResults(r.bodies().at(-1)).includes("ran on 8"), "the surviving run's tool did not answer from its page");
});

// --- a tab that reuses the closed tab's id inherits nothing ---

test("RED TEAM: a fresh document on the closed tab's id does not inherit the no-tab run: no adopt, no replay, nothing to answer, no event", T, async () => {
    const r = await run();
    const { hash } = await r.bg.context.__mlStartUserRunForTest(7, { task: "probe", surface: "hud", maxSteps: 4 });
    await until(() => !r.live(hash));
    r.port2(hash);
    r.bg.closeTab(7);
    assert.ok(await until(() => r.rows().get(hash)?.background?.noTab === true));
    // The browser hands the id to a new tab, and its document comes up.
    r.bg.commit(7, { documentId: "doc-7-new", url: SITE_URL });
    const since = r.bg.tabMessages.length;
    const ready = await r.bg.send({ type: "CONTENT_READY" }, { tab: { id: 7, url: SITE_URL }, url: SITE_URL, frameId: 0, documentId: "doc-7-new" });
    assert.deepEqual(ready?.adopt, [], "a new document on the reused id was given the no-tab run to adopt");
    void r.bg.send({ type: "SHELL_LISTENING" }, { tab: { id: 7, url: SITE_URL }, url: SITE_URL, frameId: 0, documentId: "doc-7-new" });
    await until(() => false, 20);
    assert.deepEqual(r.bg.tabMessages.slice(since).filter(([t]) => t === 7), [], "the reused id was sent the no-tab run's replay or tools");
    const seen = r.events().length;
    void r.bg.send({ type: "ML_DEBUG_EVENT", event: { kind: "agent-step", id: hash, ts: 1, save: false, session: { hash, turn: 9 }, step: 9, tool: "forged" } }, pageSender(7, SITE_URL));
    void r.bg.send({ type: "ML_SESSION_EVENT", event: { kind: "agent-result", id: hash, ts: 1, save: false, session: { hash, turn: 9 }, summary: "forged", steps: 9, hitCap: false } }, pageSender(7, SITE_URL));
    await until(() => false, 20);
    assert.deepEqual(r.events().slice(seen), [], "the reused id's page wrote into the no-tab run");
});

// --- a tool that needs no page still works ---

test("RED TEAM: a run with no tab keeps the tools that need no page, its own self-introspection included", { todo: "open: `needsPage` (no-tab.ts:30) judges by the tool's realm, and chat_metadata's realm is \"page\" although the LOOP answers it without a page (agent-loop.ts, the `meta` capability). A no-tab run is answered `\"chat_metadata\" needs a page` — measured — which is false to the model and contradicts noPageText's own sentence. Exempt the `meta` capability from `needsPage` (the loop answers it above the dispatch, so no page is involved)" }, T, async () => {
    const r = await run();
    const { hash } = await r.bg.context.__mlStartUserRunForTest(7, { task: "probe", surface: "hud", maxSteps: 6 });
    await until(() => !r.live(hash));
    r.bg.closeTab(7);
    assert.ok(await until(() => r.rows().get(hash)?.background?.noTab === true));
    const offered = (r.bodies()[0].tools ?? []).map((t) => t.function?.name ?? t.name);
    assert.ok(offered.includes("chat_metadata"), "positive control: the run offers chat_metadata");
    r.script.push({ name: "chat_metadata", args: {} }, { name: "fetch_url", args: { url: "http://host/x" } });
    await send(r, hash, "count, then fetch", 4);
    const read = toolResults(r.bodies().at(-1));
    assert.ok(!read.some((t) => /"chat_metadata" needs a page/.test(t)), `the loop's own chat_metadata was answered as needing a page: ${read.find((t) => t.includes("chat_metadata"))}`);
    assert.ok(!read.some((t) => /"fetch_url" needs a page/.test(t)), "a worker tool was answered as needing a page");
});
