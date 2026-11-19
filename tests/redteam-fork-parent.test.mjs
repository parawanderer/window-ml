// redteam-fork-parent.test.mjs — what a hostile page gets from the two session-summary fields it can reach:
// `SessionSummary.forkedFrom` (a fork's `session.forkOf`, and START_RUN's `forkOf`) and `SessionSummary.currentPage`.
//
// The page's `forkOf` is its own claim. The property: a session is listed as a fork of a parent ONLY when the parent is a
// session the index holds on the SAME tab as the fork, so a page cannot make its session read as a fork of (or point the
// list's "forked from" link at) a session another tab owns, one the index does not hold, or one that does not exist. And
// `currentPage` is the browser's own navigation report: no event field, and no `session-resumed` a page posts, writes it.
// Run against the built bundle in node:vm behind the real origin gate; the list is read as the chat page reads it, from the
// `ml-sessions` port (src/session/session-index.ts `noteFork`/`pageMoved`, src/sw/sw-sessions.ts `sessionPageMoved`).
import { test } from "node:test";
import assert from "node:assert";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { jsonResponse, loadBackground } = require("./helpers");

const SITE = "https://site.example/page";
const EXT_PAGE = { url: "chrome-extension://test/chat.html" };
const T = { timeout: 20_000 };
const flush = async (n = 8) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)); };
const approvedOn = (tabId) => ({ tab: { id: tabId, url: SITE, title: `Site ${tabId}` }, url: SITE, origin: "https://site.example", frameId: 0, documentId: `doc-${tabId}` });
const ev = (hash, kind, over = {}) => ({ kind, id: hash, ts: 1, save: false, session: { hash, turn: 0 }, ...over });
const agentStart = (hash, session = {}, over = {}) => ev(hash, "agent", { task: "look it up", model: "m", maxSteps: 5, config: null, ...over, session: { hash, turn: 0, ...session } });
const chatStart = (hash, session = {}) => ev(hash, "chat", { request: { model: "m", messages: [{ role: "user", content: "hi" }] }, config: {}, session: { hash, turn: 0, ...session } });
const startPayload = (runId, over = {}) => ({
    runId, task: "do it", systemPrompt: "S", tools: [], model: "m", think: null, maxSteps: 3,
    autoApprovePython: false, autoApproveReadonly: false, surface: "off", ...over,
});

/** A worker with the site approved on tabs 7 and 8; the model call answers once `release()` is called (`hold` true) or at once. */
function world({ hold = false } = {}) {
    let release = () => {};
    const gate = new Promise((r) => { release = r; });
    const bg = loadBackground({
        config: { chatUrl: "http://host/api/chat/completions", apiKey: "sk-test", model: "default-model", apiFormat: "openai", ocrModel: "", debugMode: "off" },
        siteGate: true, local: { ml_site_always: ["https://site.example"] },
        openTabs: [{ id: 7, url: SITE, title: "Site 7" }, { id: 8, url: SITE, title: "Site 8" }],
        onFetch: async (call) => {
            if (!/\/chat\/completions/.test(call.url)) return jsonResponse({});
            if (hold) await gate;
            return jsonResponse({ choices: [{ message: { content: "done" } }] });
        },
        onTabMessage: async (_t, msg) => (msg.type === "ADOPT_RUN_NOW" ? { pageInfo: "" } : msg.type === "RUN_TOOL_IN_PAGE" ? { result: "ok" } : undefined),
    });
    const port = bg.connect("ml-sessions", EXT_PAGE);
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
    /** Every upsert/snapshot row for `hash` the port ever heard, so a field that flashed up and was removed still counts. */
    const everRow = (hash) => port.messages.filter((m) => m.type === "index").flatMap((m) => (m.update.type === "snapshot" ? m.update.sessions : m.update.type === "upsert" ? [m.update.session] : [])).filter((s) => s.id.hash === hash);
    /** A run the WORKER hosts on `tab` (the person started it), held at its first model call until release(). */
    const workerRun = (tab) => bg.context.__mlStartUserRunForTest(tab, { task: "look it up", surface: "hud" });
    const startRun = (tab, runId, over) => Promise.race([bg.send({ type: "START_RUN", payload: startPayload(runId, over) }, approvedOn(tab)), new Promise((r) => setTimeout(() => r({ timeout: true }), 3000))]);
    return { bg, port, rows, everRow, startRun, workerRun, release: () => release() };
}
const parentOnTab7 = async (w, hash = "parent01") => { await w.bg.send({ type: "ML_SESSION_EVENT", event: agentStart(hash) }, approvedOn(7)); };

// --- forkOf: a fork's parent is checked against the tab ---

test("positive control: a fork on the parent's own tab is listed with its parent", T, async () => {
    const w = world();
    await parentOnTab7(w);
    await w.bg.send({ type: "ML_SESSION_EVENT", event: agentStart("fork0001", { forkOf: "parent01" }) }, approvedOn(7));
    await w.bg.send({ type: "ML_DEBUG_EVENT", event: chatStart("fork0002", { forkOf: "parent01" }) }, approvedOn(7));
    assert.deepEqual(w.rows().get("fork0001")?.forkedFrom, { runtime: "local", hash: "parent01" });
    assert.deepEqual(w.rows().get("fork0002")?.forkedFrom, { runtime: "local", hash: "parent01" });
    assert.equal(w.rows().get("parent01").forkedFrom, undefined);
});

test("a page on tab 8 cannot list its session as a fork of a session running on tab 7, by an agent or a chat event, on either relay", T, async () => {
    const w = world();
    await parentOnTab7(w);
    assert.ok(w.rows().get("parent01"), "positive control: tab 7's session is listed");
    await w.bg.send({ type: "ML_SESSION_EVENT", event: agentStart("evil0001", { forkOf: "parent01" }) }, approvedOn(8));
    await w.bg.send({ type: "ML_DEBUG_EVENT", event: agentStart("evil0002", { forkOf: "parent01" }) }, approvedOn(8));
    await w.bg.send({ type: "ML_DEBUG_EVENT", event: chatStart("evil0003", { forkOf: "parent01" }) }, approvedOn(8));
    await w.bg.send({ type: "ML_SESSION_EVENT", event: chatStart("evil0004", { forkOf: "parent01" }) }, approvedOn(8));
    for (const h of ["evil0001", "evil0002", "evil0003", "evil0004"]) {
        assert.ok(w.rows().get(h), `${h}: positive control, the session itself is listed`);
        for (const row of w.everRow(h)) assert.equal(row.forkedFrom, undefined, `${h} listed as a fork of tab 7's session`);
    }
    // And the parent's row did not change by being named.
    assert.equal(w.rows().get("parent01").forkedFrom, undefined);
});

test("a later event of a tab-8 session cannot add a parent on tab 7 either, and tab 7 cannot re-point its own fork at a later event", T, async () => {
    const w = world();
    await parentOnTab7(w);
    await parentOnTab7(w, "parent02");
    await w.bg.send({ type: "ML_SESSION_EVENT", event: agentStart("evil0001") }, approvedOn(8));
    await w.bg.send({ type: "ML_SESSION_EVENT", event: ev("evil0001", "agent-step", { step: 1, seq: 1, tool: "exec", arguments: {}, result: "ok", session: { hash: "evil0001", turn: 0, forkOf: "parent01" } }) }, approvedOn(8));
    for (const row of w.everRow("evil0001")) assert.equal(row.forkedFrom, undefined);
    await w.bg.send({ type: "ML_SESSION_EVENT", event: agentStart("fork0001", { forkOf: "parent01" }) }, approvedOn(7));
    await w.bg.send({ type: "ML_SESSION_EVENT", event: ev("fork0001", "agent-step", { step: 1, seq: 1, tool: "exec", arguments: {}, result: "ok", session: { hash: "fork0001", turn: 0, forkOf: "parent02" } }) }, approvedOn(7));
    assert.deepEqual(w.rows().get("fork0001").forkedFrom, { runtime: "local", hash: "parent01" });
    for (const row of w.everRow("fork0001")) assert.equal(row.forkedFrom?.hash, "parent01");
});

test("START_RUN from tab 8 with forkOf naming tab 7's session starts a run listed with no parent; tab 7's own is listed with it", T, async () => {
    const w = world();
    await parentOnTab7(w);
    const own = await w.startRun(7, "fork0001", { forkOf: "parent01" });
    assert.equal(own?.data?.summary, "done", `positive control: the run ran (${JSON.stringify(own)?.slice(0, 160)})`);
    assert.deepEqual(w.rows().get("fork0001")?.forkedFrom, { runtime: "local", hash: "parent01" }, "positive control: the same tab's fork claim holds");
    const evil = await w.startRun(8, "evil0001", { forkOf: "parent01" });
    assert.equal(evil?.data?.summary, "done", `the hostile run itself ran (${JSON.stringify(evil)?.slice(0, 160)})`);
    assert.ok(w.rows().get("evil0001"), "listed");
    for (const row of w.everRow("evil0001")) assert.equal(row.forkedFrom, undefined, "a START_RUN claim across tabs");
});

test("a forkOf naming a hash the index does not hold, a malformed hash, or the session itself lists no parent, from an event and from START_RUN", T, async () => {
    const w = world();
    await parentOnTab7(w);
    const SELF = Symbol("itself");
    const claims = ["ghost001", "no:colon", "../x", "", SELF, "parent01 ", "PARENT01"];
    for (const [i, forkOf] of claims.entries()) {
        const h = `evil${String(i).padStart(4, "0")}`;
        await w.bg.send({ type: "ML_SESSION_EVENT", event: agentStart(h, { forkOf: forkOf === SELF ? h : forkOf }) }, approvedOn(7));
        assert.ok(w.rows().get(h), `${h}: positive control, listed`);
        for (const row of w.everRow(h)) assert.equal(row.forkedFrom, undefined, `${h} claimed ${String(forkOf.toString())}`);
    }
    for (const forkOf of [7, null, {}, [], true, "x".repeat(5000)]) {
        const h = "evilx001";
        await w.bg.send({ type: "ML_SESSION_EVENT", event: agentStart(h + String(typeof forkOf), { forkOf }) }, approvedOn(7)).catch(() => {});
    }
    for (const row of [...w.rows().values()]) if (row.id.hash !== "parent01") assert.equal(row.forkedFrom, undefined, row.id.hash);
    const ghost = await w.startRun(7, "evilrun1", { forkOf: "ghost001" });
    assert.equal(ghost?.data?.summary, "done", `a well-formed but unknown forkOf still runs (${JSON.stringify(ghost)?.slice(0, 160)})`);
    for (const row of w.everRow("evilrun1")) assert.equal(row.forkedFrom, undefined);
    // A malformed one is refused before it starts anything.
    const bad = await w.startRun(7, "evilrun2", { forkOf: { hash: "parent01" } });
    assert.match(bad?.error || "", /forkOf/, JSON.stringify(bad));
    assert.equal(w.rows().has("evilrun2"), false, "a refused run is not listed");
});

// --- currentPage: the browser's report only ---

test("positive control: a navigation of the tab sets currentPage on its running background session, and the start page clears it", T, async () => {
    const w = world({ hold: true });
    const { hash: run00001 } = await w.workerRun(7);
    await flush();
    assert.equal(w.rows().get(run00001)?.status, "running");
    w.bg.commit(7, { documentId: "doc-7b", url: "https://moved.example/a" });
    assert.deepEqual(w.rows().get(run00001).currentPage, { url: "https://moved.example/a" });
    w.bg.sameDocumentNav(7, { kind: "history", url: "https://moved.example/b" });
    assert.deepEqual(w.rows().get(run00001).currentPage, { url: "https://moved.example/b" });
    w.bg.commit(8, { documentId: "doc-8b", url: "https://elsewhere.example/" });
    assert.deepEqual(w.rows().get(run00001).currentPage, { url: "https://moved.example/b" }, "another tab's navigation does not move it");
    const startUrl = w.rows().get(run00001).page?.url;
    assert.ok(startUrl, "the run has a start page");
    w.bg.commit(7, { documentId: "doc-7d", url: startUrl });
    assert.equal(w.rows().get(run00001).currentPage, undefined, "back on the start page");
    w.release();
    await flush();
});

test("a page cannot set currentPage: not by an event field, a session-resumed note, or a forged summary on any event kind", T, async () => {
    const w = world({ hold: true });
    const { hash: run00001 } = await w.workerRun(7);
    await flush();
    await parentOnTab7(w, "page0001");
    const lie = { url: "https://phish.example/" };
    const forged = { currentPage: lie, summary: { currentPage: lie }, page: { url: "https://phish.example/" } };
    // Fields on the start, on later events, and on events for the background run's own hash, from its own tab and another.
    await w.bg.send({ type: "ML_SESSION_EVENT", event: agentStart("page0002", {}, forged) }, approvedOn(7));
    await w.bg.send({ type: "ML_DEBUG_EVENT", event: chatStart("page0003", { currentPage: lie }) }, approvedOn(7));
    for (const hash of [run00001, "page0001"]) {
        for (const tab of [7, 8]) {
            await w.bg.send({ type: "ML_SESSION_EVENT", event: ev(hash, "agent-step", { step: 1, seq: 1, tool: "exec", arguments: {}, result: "ok", ...forged, session: { hash, turn: 0, currentPage: lie } }) }, approvedOn(tab));
            await w.bg.send({ type: "ML_DEBUG_EVENT", event: ev(hash, "agent-say", { text: "hi", ...forged }) }, approvedOn(tab));
        }
    }
    // A session-resumed from the page, with a dropped list that passes the shape check.
    const note = (hash, id) => ev(hash, "session-resumed", { id, url: "https://phish.example/", fromUrl: SITE, afterMs: 1, dropped: ["state"] });
    for (const [hash, tab] of [[run00001, 7], [run00001, 8], ["page0001", 7], ["page0001", 8]]) {
        await w.bg.send({ type: "ML_SESSION_EVENT", event: note(hash, `n-${hash}-${tab}`) }, approvedOn(tab));
        await w.bg.send({ type: "ML_DEBUG_EVENT", event: note(hash, `d-${hash}-${tab}`) }, approvedOn(tab));
    }
    for (const hash of [run00001, "page0001", "page0002", "page0003"]) {
        assert.ok(w.rows().get(hash), `${hash}: positive control, listed`);
        for (const row of w.everRow(hash)) {
            assert.equal(row.currentPage, undefined, `${hash} gained a currentPage from a page: ${JSON.stringify(row.currentPage)}`);
            assert.ok(!JSON.stringify(row.page ?? {}).includes("phish"), `${hash}: the page claim reached the row's page: ${JSON.stringify(row.page)}`);
        }
    }
    // The control that the field still works for the browser's own report.
    w.bg.commit(7, { documentId: "doc-7c", url: "https://moved.example/" });
    assert.deepEqual(w.rows().get(run00001).currentPage, { url: "https://moved.example/" });
    assert.equal(w.rows().get("page0001").currentPage, undefined, "a page-hosted session is not moved by a navigation");
    w.release();
    await flush();
});
