// release.test.mjs — the release of a run whose tab closed (docs/spec/ASYNC_CALLS.md, "A run whose tab closed: the release"),
// in the real bundle (`dist/background.js` in node:vm, tests/helpers.js `loadBackground` with `alarms: true`): the deadline a
// closing tab sets, what keeps or cancels it, the alarm that fires it, the reason the hooks hear, and the results a release keeps.
import { test } from "node:test";
import assert from "node:assert";
import { createRequire } from "node:module";
import { DEFAULT_CONFIG } from "../src/contract/contract-config.ts";

const require = createRequire(import.meta.url);
const { jsonResponse, loadBackground } = require("./helpers");

const SITE_URL = "https://site.example/page";
const T = { timeout: 30000 };
const tick = () => new Promise((r) => setTimeout(r, 0));
async function until(done, cap = 4000) { for (let i = 0; i < cap && !(await done()); i++) await tick(); return done(); }

/** A worker-built run on tab 7 whose first turn has ended, an alarms mock, and a subscriber to the session index. `hold.model`
 *  (a promise) holds the model's next answer. */
async function settled(config = {}) {
    const hold = { model: null };
    const openTabs = [{ id: 7, windowId: 3, active: true, url: SITE_URL, title: "Site" }];
    const bg = loadBackground({
        config: { chatUrl: "http://host/api/chat/completions", apiKey: "k", model: "m", apiFormat: "openai", debugMode: "off", taskNotifyOnly: true, ...config },
        openTabs, alarms: true,
        onFetch: async (call) => {
            if (call.url.endsWith("/api/models")) return jsonResponse({ data: [{ id: "m" }] });
            if (!call.url.includes("/chat/completions")) return jsonResponse({});
            if (hold.model) await hold.model;
            return jsonResponse({ choices: [{ message: { content: "done" } }] });
        },
        onTabMessage: async (t, msg) => (msg.type === "ADOPT_RUN_NOW" ? { pageInfo: "" } : undefined),
    });
    bg.commit?.(7, { documentId: "doc-7", url: SITE_URL });
    const { hash } = await bg.context.__mlStartUserRunForTest(7, { task: "probe", surface: "hud", maxSteps: 5 });
    const events = () => bg.tabMessages.filter(([t, m]) => t === 7 && m?.type === "ML_DEBUG_TO_PAGE").map(([, m]) => m.event);
    const turns = () => events().filter((e) => e?.kind === "agent-result" && e.id === hash).length;
    const live = () => bg.context.__mlRunStateForTest().controllers.includes(hash);
    const starting = () => bg.context.__mlRunStateForTest().starting.includes(hash);
    const idle = (n) => () => turns() >= n && !live() && !starting();
    assert.ok(await until(idle(1)), "the first turn settles");
    const port = bg.connect("ml-sessions", { url: "chrome-extension://test/chat.html" });
    port.send({ type: "sessions" });
    const row = () => {
        let held;
        for (const m of port.messages) {
            if (m.type !== "index") continue;
            const u = m.update;
            if (u.type === "snapshot") held = u.sessions.find((s) => s.id.hash === hash);
            else if (u.type === "upsert" && u.session.id.hash === hash) held = structuredClone(u.session);
        }
        return held;
    };
    assert.ok(await until(() => row()), "the row is listed");
    let ids = 100;
    /** One session command over the extension port, and its answer. */
    const command = async (c) => {
        const id = ++ids;
        port.send({ type: "cmd", id, command: c });
        assert.ok(await until(() => port.messages.some((m) => m.id === id && m.type !== "index")), "the command is answered");
        return port.messages.find((m) => m.id === id && m.type !== "index");
    };
    const key = `ml_release_due:${hash}`;
    const entry = () => bg.sessionStore[key];
    const closeTab = () => { openTabs.length = 0; bg.closeTab(7); };
    return { bg, hash, hold, openTabs, idle, row, command, key, entry, closeTab, detach: () => bg.context.__mlDetachTaskForTest(hash, "ml.sh") };
}

// --- a turn that ends with the run on no tab sets a fresh deadline ---

test("a turn that ends with the run still on no tab and no running task sets a fresh deadline of now plus the grace", T, async () => {
    const r = await settled();
    let release; r.hold.model = new Promise((res) => { release = res; });
    await r.bg.context.__mlUserRunActionForTest(r.hash, "send", { text: "again", surface: "hud" });
    assert.ok(await until(() => r.bg.context.__mlRunStateForTest().controllers.includes(r.hash)), "the second turn runs");
    r.closeTab();
    await tick();
    assert.equal(r.entry(), undefined, "a turn is live: closing the tab sets no deadline yet");
    const before = Date.now();
    release();
    assert.ok(await until(r.idle(2)), "the second turn ended");
    assert.ok(await until(() => r.entry()), "the turn's end set the deadline");
    assert.ok(r.entry().due >= before + 10 * 60_000 && r.entry().due <= Date.now() + 10 * 60_000, `due is now + 10 min: ${JSON.stringify(r.entry())}`);
});

// --- the setting and the trigger ---

test("closedRunGraceMin defaults to 10 minutes", () => {
    assert.equal(DEFAULT_CONFIG.closedRunGraceMin, 10);
});

test("a closing tab gives each run on it a deadline of now plus the grace, stored for a worker that is evicted, with one alarm at it, and the row shows it", T, async () => {
    const r = await settled({ closedRunGraceMin: 3 });
    assert.equal(r.entry(), undefined, "a run with its tab has no deadline");
    const before = Date.now();
    r.closeTab();
    assert.ok(await until(() => r.entry()), "the deadline is stored");
    const e = r.entry();
    assert.ok(e.due >= before + 3 * 60_000 && e.due <= Date.now() + 3 * 60_000, JSON.stringify(e));
    assert.ok(e.closedAt >= before && e.closedAt <= Date.now());
    assert.equal(r.bg.alarms.set.get("ml-release")?.when, e.due, "one alarm, at the earliest deadline");
    assert.ok(await until(() => r.row()?.background?.releaseAt === e.due), JSON.stringify(r.row()?.background));
});

test("a grace of 0 releases at once", T, async () => {
    const r = await settled({ closedRunGraceMin: 0 });
    r.closeTab();
    assert.ok(await until(() => r.bg.pyDeletes.length === 1), "released");
    assert.equal(r.bg.pyDeletes[0].reason, "tab-closed");
    assert.equal(r.entry(), undefined);
});

test("a run with a running task gets no deadline until its last running task ends; a waiting result does not hold it", T, async () => {
    const r = await settled();
    const t = r.detach();
    assert.ok(await until(() => r.row()?.background?.running === 1));
    r.closeTab();
    assert.ok(await until(() => r.entry()), "the tab's closing is recorded");
    assert.equal(r.entry().due, null, "no deadline while the task runs");
    assert.equal(r.bg.alarms.set.has("ml-release"), false, "no alarm");
    assert.equal(r.row().background.releaseAt, undefined);
    t.finish({ text: "built" });
    assert.ok(await until(() => typeof r.entry()?.due === "number"), "the task's end set the deadline");
    assert.ok(await until(() => r.bg.alarms.set.has("ml-release")));
    assert.equal(r.row().background.waiting, 1, "its result waits, and the run is on its deadline all the same");
});

test("a worker that starts reads the stored task table before it releases: a Python cell still running holds the run", T, async () => {
    const r = await settled();
    r.closeTab();
    assert.ok(await until(() => r.entry()));
    await r.bg.context.__mlEvictForTest();
    await tick();
    // What a worker evicted while a detached cell ran left behind: the cell's row, still running, and a deadline now due.
    r.bg.sessionStore[`ml_tasks:${r.hash}`] = [{ v: 1, id: "t00ab01", tool: "python_exec", startedMs: Date.now() - 5_000, leaseMs: 15_000, expectMs: null, status: "running", result: null, text: null, delivered: false, code: null, ref: { kind: "py", cell: "cell-live" } }];
    r.bg.sessionStore[r.key] = { due: Date.now() - 1, closedAt: Date.now() - 1000 };
    r.bg.alarms.fire("ml-release");
    assert.ok(await until(() => r.entry()?.due === null), JSON.stringify(r.entry()));
    assert.equal(r.bg.pyDeletes.length, 0, "the cell read back from storage still runs: nothing is released");
});

test("a deadline that comes due while a task runs keeps the entry with no deadline, so the task's end sets one", T, async () => {
    const r = await settled();
    const t = r.detach();
    assert.ok(await until(() => r.row()?.background?.running === 1));
    r.closeTab();
    assert.ok(await until(() => r.entry()));
    r.bg.sessionStore[r.key] = { due: Date.now() - 1, closedAt: Date.now() - 1000 };
    r.bg.alarms.fire("ml-release");
    assert.ok(await until(() => r.entry()?.due === null), JSON.stringify(r.entry()));
    assert.equal(r.bg.pyDeletes.length, 0, "a run with a running task is not released");
    t.finish({ text: "built" });
    assert.ok(await until(() => typeof r.entry()?.due === "number"), "the task's end set the deadline");
});

// --- what cancels it ---

test("a person's message that starts a turn removes the deadline, the alarm and the row's releaseAt", T, async () => {
    const r = await settled();
    r.closeTab();
    assert.ok(await until(() => r.entry()));
    r.openTabs.push({ id: 7, windowId: 3, active: true, url: SITE_URL, title: "Site" });
    await r.bg.context.__mlUserRunActionForTest(r.hash, "send", { text: "back", surface: "hud" });
    assert.ok(await until(() => r.entry() === undefined), "the deadline is gone");
    assert.ok(await until(r.idle(2)));
    assert.equal(r.bg.alarms.set.has("ml-release"), false, "the alarm is cleared");
    assert.ok(await until(() => r.row()?.background?.releaseAt === undefined));
    assert.equal(r.bg.pyDeletes.length, 0, "nothing was released");
});

test("a move to another tab removes the deadline", T, async () => {
    const r = await settled();
    r.closeTab();
    assert.ok(await until(() => r.entry()));
    r.openTabs.push({ id: 8, windowId: 3, active: true, url: SITE_URL, title: "Other" });
    const answer = await r.bg.send({ type: "MOVE_RUN", payload: { runId: r.hash } }, { id: "test", url: "chrome-extension://test/hud.html", tab: { id: 8, url: SITE_URL } });
    assert.deepEqual(answer, { data: true });
    assert.ok(await until(() => r.entry() === undefined), "the deadline is gone");
});

// --- the release ---

test("the alarm releases a due run with the reason tab-closed, keeps its stored run, and sets the alarm again for the rest", T, async () => {
    const r = await settled();
    r.closeTab();
    assert.ok(await until(() => r.entry()));
    // Another run's deadline is not due yet: the alarm is set again for it.
    const later = Date.now() + 5 * 60_000;
    r.bg.sessionStore["ml_release_due:other"] = { due: later, closedAt: Date.now() };
    r.bg.sessionStore[r.key].due = Date.now() - 1;
    r.bg.alarms.fire("ml-release");
    assert.ok(await until(() => r.bg.pyDeletes.length === 1), "PY_DELETE_RUN was sent");
    assert.equal(r.bg.pyDeletes[0].run, r.hash);
    assert.equal(r.bg.pyDeletes[0].reason, "tab-closed");
    assert.ok(await until(() => r.entry() === undefined), "its entry is gone");
    assert.ok(await until(() => r.bg.alarms.set.get("ml-release")?.when === later), JSON.stringify([...r.bg.alarms.set]));
    assert.ok(r.bg.context.__mlRunStateForTest().bgRuns.includes(r.hash), "the stored run stays, so a later Continue rehydrates it");
});

test("a deadline that came due while no worker ran is released when the worker starts again", T, async () => {
    const r = await settled();
    r.closeTab();
    assert.ok(await until(() => r.entry()));
    r.bg.sessionStore[r.key].due = Date.now() - 1;
    await r.bg.context.__mlEvictForTest();
    assert.ok(await until(() => r.bg.pyDeletes.length === 1), "released at worker start");
    assert.equal(r.bg.pyDeletes[0].reason, "tab-closed");
});

test("at release time the run's tab is asked for again: an entry for a run that has a tab releases nothing", T, async () => {
    const r = await settled();
    // A forged or stale entry, the tab still open.
    r.bg.sessionStore[r.key] = { due: Date.now() - 1, closedAt: Date.now() - 1000 };
    r.bg.alarms.fire("ml-release");
    assert.ok(await until(() => r.entry() === undefined), "the entry is dropped");
    await tick();
    assert.equal(r.bg.pyDeletes.length, 0, "nothing alive was released");
});

test("a run whose turn is running is never released, and an entry that comes due then is dropped", T, async () => {
    const r = await settled();
    let release; r.hold.model = new Promise((res) => { release = res; });
    await r.bg.context.__mlUserRunActionForTest(r.hash, "send", { text: "again", surface: "hud" });
    assert.ok(await until(() => r.bg.context.__mlRunStateForTest().controllers.includes(r.hash)));
    r.closeTab();
    r.bg.sessionStore[r.key] = { due: Date.now() - 1, closedAt: Date.now() - 1000 };
    r.bg.alarms.fire("ml-release");
    assert.ok(await until(() => r.entry() === undefined));
    await tick();
    assert.equal(r.bg.pyDeletes.length, 0, "released nothing mid-turn");
    release();
    assert.ok(await until(r.idle(2)));
    assert.ok(await until(() => r.entry()), "its deadline moved to the turn's end");
});

// --- the reason ---

test("the person's Stop (session.release) releases at once with the reason person, and is refused while a turn runs", T, async () => {
    const r = await settled();
    let release; r.hold.model = new Promise((res) => { release = res; });
    await r.bg.context.__mlUserRunActionForTest(r.hash, "send", { text: "again", surface: "hud" });
    assert.ok(await until(() => r.bg.context.__mlRunStateForTest().controllers.includes(r.hash)));
    const refused = await r.command({ type: "session.release", session: { runtime: "local", hash: r.hash } });
    assert.equal(refused.result?.ok ?? refused.ok, false, JSON.stringify(refused));
    assert.equal(r.bg.pyDeletes.length, 0);
    release();
    assert.ok(await until(r.idle(2)));
    const ok = await r.command({ type: "session.release", session: { runtime: "local", hash: r.hash } });
    assert.equal(ok.result?.ok ?? ok.ok, true, JSON.stringify(ok));
    assert.ok(await until(() => r.bg.pyDeletes.length === 1));
    assert.equal(r.bg.pyDeletes[0].reason, "person");
});

test("a session's end passes no reason: deleting a session sends PY_DELETE_RUN without one", T, async () => {
    const r = await settled();
    const gone = await r.command({ type: "session.delete", session: { runtime: "local", hash: r.hash } });
    assert.equal(gone.result?.ok ?? gone.ok, true, JSON.stringify(gone));
    assert.ok(await until(() => r.bg.pyDeletes.length >= 1));
    assert.equal("reason" in r.bg.pyDeletes[0], false);
});

// --- a release keeps the results no turn has read ---

test("a release keeps the ended rows no turn has read, clears their pointer, stamps releasedAt, and the inbox says so when one is delivered", T, async () => {
    const r = await settled();
    const unread = r.detach(), read = r.detach(), running = r.detach();
    unread.finish({ text: "built 3 files", result: "@tool:abc123" });
    read.finish({ text: "already seen" });
    assert.ok(await until(() => r.row()?.background?.waiting === 2));
    // The model reads one of them.
    await read.read();
    assert.ok(await until(() => r.row()?.background?.waiting === 1));
    const ok = await r.command({ type: "session.release", session: { runtime: "local", hash: r.hash } });
    assert.equal(ok.result?.ok ?? ok.ok, true, JSON.stringify(ok));
    const stored = async () => r.bg.sessionStore[`ml_tasks:${r.hash}`];
    assert.ok(await until(async () => (await stored())?.length === 1), JSON.stringify(await stored()));
    const [row] = await stored();
    assert.equal(row.id, unread.id, "only the unread ended row is kept: the read one and the running one are gone");
    assert.equal(row.result, null, "the pointer to the dropped value is cleared");
    assert.equal(typeof row.releasedAt, "number");
    assert.equal(row.text, "built 3 files", "its text is kept");
    assert.notEqual(row.id, running.id);
    // The person's next message reads it, with the note.
    await r.bg.context.__mlUserRunActionForTest(r.hash, "send", { text: "what happened", surface: "hud" });
    assert.ok(await until(r.idle(2)));
    const bodies = r.bg.calls.filter((c) => c.url.includes("/chat/completions")).map((c) => JSON.stringify(c.body));
    const re = new RegExp(`\\[task ${unread.id} done after \\d+ s: built 3 files; its value was released at \\d{4}-\\d\\d-\\d\\dT[\\d:.]+Z\\]`);
    assert.ok(bodies.some((b) => re.test(b)), "the inbox text names the release");
    assert.ok(await until(async () => (await stored()) === undefined || (await stored()).every((x) => x.delivered)), "delivered as any other row");
});

test("archive and delete keep nothing: a delivered or undelivered row alike is removed with the session", T, async () => {
    const r = await settled();
    const t = r.detach();
    t.finish({ text: "x" });
    assert.ok(await until(() => r.row()?.background?.waiting === 1));
    await r.command({ type: "session.delete", session: { runtime: "local", hash: r.hash } });
    assert.ok(await until(() => r.bg.sessionStore[`ml_tasks:${r.hash}`] === undefined));
});
