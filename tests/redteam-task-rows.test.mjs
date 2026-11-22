// redteam-task-rows.test.mjs — the red-team pass on rule 4b slice E (#2082, ASYNC_CALLS.md "A session with no tab shows
// it"): the worker-only `agent-tasks` notice, `TaskBackground`, and `SessionSummary.background` — what a hostile page
// must NOT get from a run's background-task counts, or put into them.
//
// The builder's rows (tests/task-row.test.mjs, tests/session-index.test.mjs, tests/event-admission.test.mjs) hold the
// feature's own paths: a detach marks the row, a read clears it, `noTab` after the tab closes, the restore drops a saved
// field, the kind is in WORKER_ONLY_KINDS. These hold the routes they do not take: a page's forged notice at both
// receivers (the index and the DevTools feed), the page's window, what the notice carries besides counts, and one
// session's counts crossing into another's.

import { test } from "node:test";
import assert from "node:assert";
import { createRequire } from "node:module";
import { readFileSync, readdirSync } from "node:fs";

const require = createRequire(import.meta.url);
const { jsonResponse, loadBackground, loadPageWorld } = require("./helpers");
const { SessionIndex } = await import("../src/session/session-index.ts");

const SITE_URL = "https://site.example/page";
const TAB_A = 7, TAB_B = 9;
const T = { timeout: 30000 };
const tick = () => new Promise((r) => setTimeout(r, 0));
async function until(done, cap = 6000) { for (let i = 0; i < cap && !(await done()); i++) await tick(); return done(); }
const plain = (x) => JSON.parse(JSON.stringify(x ?? null));
const pageSender = (tabId) => ({ tab: { id: tabId, url: SITE_URL }, url: SITE_URL, origin: "https://site.example", frameId: 0 });

/**
 * A worker with one user-started run on each of `tabs`, each turn settled, a subscriber to the session index, and a
 * DevTools panel connected to the first tab. `config.taskNotifyOnly` parks a finished task instead of starting a turn.
 */
async function fleet({ tabs = [TAB_A], config = {} } = {}) {
    const openTabs = tabs.map((id) => ({ id, windowId: 3, active: id === tabs[0], url: SITE_URL, title: "Site" }));
    const bg = loadBackground({
        config: { chatUrl: "http://host/api/chat/completions", apiKey: "k", model: "m", apiFormat: "openai", debugMode: "off", ...config },
        openTabs,
        onFetch: async (call) => {
            if (call.url.endsWith("/api/models")) return jsonResponse({ data: [{ id: "m" }] });
            if (!call.url.includes("/chat/completions")) return jsonResponse({});
            return jsonResponse({ choices: [{ message: { content: "done" } }] });
        },
        onTabMessage: async (t, msg) => (msg.type === "ADOPT_RUN_NOW" ? { pageInfo: "" } : undefined),
    });
    for (const id of tabs) bg.commit?.(id, { documentId: `doc-${id}`, url: SITE_URL });
    const events = (tabId) => bg.tabMessages.filter(([t, m]) => t === tabId && m?.type === "ML_DEBUG_TO_PAGE").map(([, m]) => m.event);
    const turns = (tabId, hash) => events(tabId).filter((e) => e?.kind === "agent-result" && e.id === hash).length;
    const settledOff = (hash) => !bg.context.__mlRunStateForTest().controllers.includes(hash) && !bg.context.__mlRunStateForTest().starting.includes(hash);

    const port = bg.connect("ml-sessions", { url: "chrome-extension://test/chat.html" });
    port.send({ type: "sessions" });
    const panel = bg.connect("ml-devtools");
    panel.send({ type: "ml-devtools-init", tabId: tabs[0] });

    const hashes = {};
    for (const id of tabs) {
        const { hash } = await bg.context.__mlStartUserRunForTest(id, { task: "probe", surface: "hud", maxSteps: 5 });
        hashes[id] = hash;
        assert.ok(await until(() => turns(id, hash) >= 1 && settledOff(hash)), `the turn on tab ${id} settles`);
    }
    /** The row as the chat page's index holds it: the snapshot, then each upsert, in order. */
    const rows = (hash) => {
        let held;
        for (const m of port.messages) {
            if (m.type !== "index") continue;
            const u = m.update;
            if (u.type === "snapshot") held = u.sessions.find((s) => s.id.hash === hash);
            else if (u.type === "upsert" && u.session.id.hash === hash) held = structuredClone(u.session);
        }
        return held;
    };
    assert.ok(await until(() => tabs.every((id) => rows(hashes[id]))), "every run is listed");
    /** Every `agent-tasks` notice the worker sent to a tab, in order. */
    const notices = (tabId) => bg.tabMessages.filter(([t, m]) => t === tabId && m?.type === "ML_DEBUG_TO_PAGE" && m.event?.kind === "agent-tasks").map(([, m]) => m.event);
    const detach = (tabId, tool = "ml.sh") => bg.context.__mlDetachTaskForTest(hashes[tabId], tool);
    return { bg, hashes, rows, notices, detach, panel, port };
}

// --- the durable receivers: neither the index nor a panel can be handed the live kind ---

test("RED TEAM: the session index refuses agent-tasks trusted or not, so no worker path can persist a count", () => {
    // The notice is a LIVE one: `save: false`, no row, no export. The index's kind table is what keeps a worker bug from
    // making it durable, and what keeps a page-forwarded copy out of the transcript.
    const ix = new SessionIndex({ runtime: "local", spawn: "w1", now: () => 1000 });
    ix.ingest({ kind: "agent", id: "aaaa0001", ts: 1, save: false, session: { hash: "aaaa0001", turn: 0 }, task: "t", model: "m", maxSteps: 1, config: null }, { tabId: TAB_A, trusted: true });
    const ev = { kind: "agent-tasks", id: "aaaa0001", ts: 2, save: false, session: { hash: "aaaa0001", turn: 0 }, background: { running: 1, waiting: 0 } };
    for (const src of [{ tabId: TAB_A, trusted: true }, { tabId: TAB_A, trusted: false }, { tabId: TAB_B, trusted: false }])
        assert.deepEqual(ix.ingest(ev, src), { accepted: false, reason: "invalid" }, `the index took it from ${JSON.stringify(src)}`);
    // Positive control: the neighbouring worker-only kind does enter, trusted.
    assert.equal(ix.ingest({ ...ev, kind: "agent-task-say", text: "x", task: "tc-1", status: "done", ms: 1, code: null }, { tabId: TAB_A, trusted: true }).accepted, true);
    // And no export module knows the kind: both exports read the session object, never a live notice.
    const dir = new URL("../src/sidebar/export/", import.meta.url);
    const files = readdirSync(dir).filter((f) => /\.tsx?$/.test(f));
    assert.ok(files.length >= 2, "positive control: the export modules were found");
    for (const f of files) assert.ok(!readFileSync(new URL(f, dir), "utf8").includes("agent-tasks"), `${f} reads the live notice`);
});

test("RED TEAM: a page's forged agent-tasks reaches neither the run's row nor the DevTools feed, for its own session or another's", T, async () => {
    const f = await fleet();
    const forged = (hash) => ({ kind: "agent-tasks", id: hash, ts: Date.now(), save: false, session: { hash, turn: 0 }, background: { running: 9, waiting: 9 } });
    for (const type of ["ML_DEBUG_EVENT", "ML_SESSION_EVENT"]) {
        await f.bg.send({ type, event: forged(f.hashes[TAB_A]) }, pageSender(TAB_A));
        await f.bg.send({ type, event: forged("ffff0000") }, pageSender(TAB_A));
    }
    await tick();
    assert.equal(f.rows(f.hashes[TAB_A])?.background, undefined, "a page marked its own run's row");
    assert.ok(!plain(f.panel.messages).some((m) => m?.__mlDebug?.kind === "agent-tasks"), "the forged notice reached the panel feed");
    assert.ok(!f.notices(TAB_A).some((e) => e.background?.running === 9), "the forged counts were sent to the tab");
    // Positive control: the worker's own notice does both, so the assertions above are not passing against a dead path.
    f.detach(TAB_A);
    assert.ok(await until(() => f.rows(f.hashes[TAB_A])?.background?.running === 1), JSON.stringify(f.rows(f.hashes[TAB_A])?.background));
    assert.ok(await until(() => plain(f.panel.messages).some((m) => m?.__mlDebug?.kind === "agent-tasks" && m.__mlDebug.background?.running === 1)), "the panel never heard the real notice");
});

// --- the page's window ---

test("RED TEAM: the notice never reaches the page's window, even on the run's own tab", T, async () => {
    const f = await fleet();
    f.detach(TAB_A);
    assert.ok(await until(() => f.notices(TAB_A).some((e) => e.background?.running === 1)), "the worker told the tab");
    const w = loadPageWorld({ main: "injected.js", visible: true, onRuntimeMessage: () => ({ data: {} }) });
    const heard = [];
    w.fromContent((e) => heard.push(e.data));   // everything content.ts hands the page's script on the channel
    for (let i = 0; i < 10; i++) await tick();
    const postsBefore = plain(w.windowPosts), heardBefore = plain(heard);
    for (const [, m] of f.bg.tabMessages.filter(([t, m]) => t === TAB_A && m?.type === "ML_DEBUG_TO_PAGE" && m.event?.kind === "agent-tasks"))
        await w.fireRuntimeMessage(m);
    for (let i = 0; i < 5; i++) await tick();
    assert.deepEqual(plain(heard), heardBefore, "a background run's notice crossed to the page's script");
    assert.deepEqual(plain(w.windowPosts), postsBefore, "a background run's notice was posted on the page's window");
    // Positive control: content.ts DOES hand the page a message it is meant to see, so unchanged means dropped, not
    // that the harness cannot observe a crossing.
    await w.fireRuntimeMessage({ type: "SERVER_TOOL_STREAM", requestId: "r", frame: { type: "chunk" }, at: 1 });
    for (let i = 0; i < 5; i++) await tick();
    assert.ok(plain(heard).some((d) => d?.type === "SERVER_TOOL_STREAM"), "the harness sees no crossing, so the row above is vacuous");
});

// --- what the notice carries ---

test("RED TEAM: the notice and the row carry the run's own id and counts, never a task's id, tool or text", T, async () => {
    const MARK = "TASK-TEXT-MARKER-7f3a";
    const f = await fleet({ config: { taskNotifyOnly: true } });
    const one = f.detach(TAB_A, "ml.sh");
    const two = f.detach(TAB_A, "python_exec");
    assert.ok(await until(() => f.rows(f.hashes[TAB_A])?.background?.running === 2), JSON.stringify(f.rows(f.hashes[TAB_A])?.background));
    one.finish({ text: MARK });   // parks: the run is now 1 running, 1 waiting
    assert.ok(await until(() => f.rows(f.hashes[TAB_A])?.background?.waiting === 1), JSON.stringify(f.rows(f.hashes[TAB_A])?.background));
    const all = JSON.stringify(plain([...f.notices(TAB_A), f.rows(f.hashes[TAB_A])]));
    for (const bad of [MARK, one.id, two.id, "ml.sh", "python_exec"])
        assert.ok(!all.includes(bad), `the notice or the row carries ${bad}`);
    const ALLOWED = ["running", "waiting", "noTab", "releaseAt"];
    for (const e of f.notices(TAB_A)) {
        assert.deepEqual(Object.keys(e).sort(), ["background", "id", "kind", "save", "session", "ts"], JSON.stringify(e));
        assert.equal(e.save, false, "a load-bearing notice is marked saved");
        assert.equal(e.id, f.hashes[TAB_A], "a notice names another session");
        assert.deepEqual(e.session, { hash: f.hashes[TAB_A], turn: 0 });
        const b = e.background;
        assert.deepEqual(Object.keys(b).filter((k) => !ALLOWED.includes(k)), [], JSON.stringify(b));
        assert.equal(typeof b.running, "number");
        assert.equal(typeof b.waiting, "number");
        if ("noTab" in b) assert.equal(b.noTab, true, "noTab is not the boolean it says");
        if ("releaseAt" in b) assert.equal(typeof b.releaseAt, "number", "a deadline is not a number");
    }
    const row = f.rows(f.hashes[TAB_A]).background;
    assert.deepEqual(Object.keys(row).filter((k) => !ALLOWED.includes(k)), [], JSON.stringify(row));
});

// --- one run's counts never mark another ---

test("RED TEAM: a run's counts are its own: no notice or row for another session, whatever a page sends", T, async () => {
    const f = await fleet({ tabs: [TAB_A, TAB_B] });
    const hA = f.hashes[TAB_A], hB = f.hashes[TAB_B];
    f.detach(TAB_A);
    f.detach(TAB_A);
    f.detach(TAB_B);
    assert.ok(await until(() => f.rows(hA)?.background?.running === 2 && f.rows(hB)?.background?.running === 1), JSON.stringify([f.rows(hA)?.background, f.rows(hB)?.background]));
    for (const [tabId, mine, other] of [[TAB_A, hA, hB], [TAB_B, hB, hA]]) {
        assert.ok(f.notices(tabId).length > 0, `tab ${tabId} was told`);
        assert.ok(f.notices(tabId).every((e) => e.id === mine), `a notice sent to tab ${tabId} named ${other}`);
        assert.ok(!f.bg.tabMessages.some(([t, m]) => t === tabId && m?.event?.kind === "agent-tasks" && m.event.id === other), `tab ${tabId} was told another session's counts`);
    }
    // A page cannot read or rewrite another session's row through the event route.
    await f.bg.send({ type: "ML_DEBUG_EVENT", event: { kind: "agent-tasks", id: hB, session: { hash: hB, turn: 0 }, save: false, ts: 1, background: { running: 9, waiting: 0 } } }, pageSender(TAB_A));
    await tick();
    assert.equal(f.rows(hB)?.background?.running, 1, "a page changed another session's row");
    assert.equal(f.rows(hA)?.background?.running, 2, "a page changed its own run's row");
});
