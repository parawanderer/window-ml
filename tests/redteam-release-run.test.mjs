// redteam-release-run.test.mjs — what the release of a run whose tab closed (docs/spec/ASYNC_CALLS.md, "A run whose tab
// closed: the release") must not be made to do, red-teamed at e09bff410c3dd4392ed1eb37ec201043f275f718, re-verified
// unchanged at 7733e9c95ee1e5545e85ae93c49bd4a57a9b35f3 (the branch moved by merging main), and both open rows verified
// fixed at b03323ae215afb302bf59e10bc57774816dcccb4; re-verified unchanged at 60d357349cf4608ad0c0e29372802d37c3d60570
// (the second main merge, bringing #2106: a released run's "no tab" is decided by runHasNoTab before chrome.tabs.get, and
// no row here depends on which of the two answers). Six properties, in the real bundle (`dist/background.js` in
// node:vm, tests/helpers.js `loadBackground` with `alarms: true`):
//
//   1. nothing a page sends releases a run: a content script's `ml-sessions` port is closed unheard, and its
//      `session.release` leaves no deadline, no PY_DELETE_RUN and no change to the run — while the same command from
//      an extension page DOES release (the positive control). The hub's `forbidden` is a unit row
//      (tests/session-commands.test.mjs:207), the port gate another (tests/redteam-host-install.test.mjs:128); this
//      file pins the bundle end of them.
//   2. one tab's close reaches only that tab's runs: the other tab's session gets no deadline, no `releaseAt`, and is
//      not released by the alarm.
//   3. no page-startable type can write a `ml_release_due:` key or set the `ml-release` alarm (enumerated, so the row
//      stays honest as the tables grow), and a forged entry of another shape, or one naming a run that does not exist,
//      releases nothing of a real run.
//   4. a worker that never saw the run reads its stored task table first: a row still running holds the release with no
//      deadline, and the run beside it, with no running row, is released in the same pass.
//   5. the model's `change_setting` cannot take `closedRunGraceMin` past the 1440 minutes the release clamps to (was
//      open: measured 99999 and 1441 written; fixed by the domain's `max: 1440` at b03323ae), and a settings change
//      releases no other run.
//   6. a kept undelivered row carries no value after a release: its `result`, `image`, `value` and `chars` all go (was
//      open: the image was still stored and delivered with the row at the next turn; fixed at b03323ae).
import { test } from "node:test";
import assert from "node:assert";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { jsonResponse, loadBackground } = require("./helpers");
const { PAGE_STARTED_TYPES, PAGE_UNGATED_TYPES } = require("../src/page-relay.ts");

const SITE_URL = "https://site.example/page";
const EXT = { url: "chrome-extension://test/chat.html" };
const T = { timeout: 30000 };
async function tick(n = 1) { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)); }
async function until(done, cap = 6000) { for (let i = 0; i < cap && !(await done()); i++) await tick(); return done(); }

/**
 * A worker with tabs 7 and 8 open, and settled worker-built runs on each. `script` is what the fake model answers a turn
 * with (shifted per request); empty, it says "done". A tool call that asks is approved, as the sidebar would.
 * @param opts.openTabs the tabs open at boot (both committed, so a run can start and re-adopt on each)
 * @param opts.session chrome.storage.session to start from, as a worker that was evicted left it
 * @param opts.config config overrides
 */
function boot({ openTabs = [7, 8], session = {}, config = {} } = {}) {
    const script = [];
    // The SAME array object the harness holds, so a closed tab is gone from `chrome.tabs.get` as it is in Chrome.
    const tabs = openTabs.map((id) => ({ id, windowId: 3, active: true, url: SITE_URL, title: `tab ${id}` }));
    const bg = loadBackground({
        config: { chatUrl: "http://host/api/chat/completions", apiKey: "k", model: "m", apiFormat: "openai", debugMode: "off", taskNotifyOnly: true, ...config },
        openTabs: tabs,
        session, alarms: true,
        onFetch: async (call) => {
            if (call.url.endsWith("/api/models")) return jsonResponse({ data: [{ id: "m" }] });
            if (!call.url.includes("/chat/completions")) return jsonResponse({});
            const step = script.shift();
            if (!step) return jsonResponse({ choices: [{ message: { content: "done" } }] });
            return jsonResponse({ choices: [{ message: { content: null, tool_calls: [{ id: `c${Math.random()}`, type: "function", function: { name: step.name, arguments: JSON.stringify(step.args) } }] } }] });
        },
        onTabMessage: async (t, msg) => {
            if (msg.type === "ML_DEBUG_TO_PAGE" && msg.event?.awaitingApproval) {
                void bg.send({ type: "SET_APPROVAL", payload: { runId: msg.event.id, seq: msg.event.seq, decision: true } }, { url: "chrome-extension://test/sidebar.html" });
            }
            return msg.type === "ADOPT_RUN_NOW" ? { pageInfo: "" } : undefined;
        },
    });
    for (const id of tabs) bg.commit?.(id, { documentId: `doc-${id}`, url: SITE_URL });
    const port = bg.connect("ml-sessions", EXT);
    port.send({ type: "sessions" });
    const state = () => bg.context.__mlRunStateForTest();
    const run = (tabId) => {
        let hash;
        const events = () => bg.tabMessages.filter(([t, m]) => t === tabId && m?.type === "ML_DEBUG_TO_PAGE").map(([, m]) => m.event).filter((e) => e?.id === hash);
        const turns = () => events().filter((e) => e?.kind === "agent-result").length;
        const live = () => state().controllers.includes(hash) || state().starting.includes(hash);
        const idle = (n) => () => turns() >= n && !live();
        const row = () => {
            let held;
            for (const m of port.messages) {
                if (m.type !== "index") continue;
                const u = m.update;
                if (u.type === "snapshot") held = u.sessions.find((s) => s.id.hash === hash) ?? held;
                else if (u.type === "upsert" && u.session.id.hash === hash) held = structuredClone(u.session);
            }
            return held;
        };
        let ids = 100 + tabId * 100;
        const command = async (c) => {
            const id = ++ids;
            port.send({ type: "cmd", id, command: c });
            assert.ok(await until(() => port.messages.some((m) => m.id === id && m.type !== "index")), `the command is answered: ${c.type}`);
            return port.messages.find((m) => m.id === id && m.type !== "index");
        };
        const start = async (task) => {
            ({ hash } = await bg.context.__mlStartUserRunForTest(tabId, { task, surface: "hud", maxSteps: 5 }));
            assert.ok(await until(idle(1)), "the first turn settles");
            assert.ok(await until(() => row()), "the row is listed");
            return { tabId, get hash() { return hash; }, events, turns, live, idle, row, command };
        };
        return start;
    };
    const closeTab = (id) => { const i = tabs.findIndex((t) => t.id === id); if (i >= 0) tabs.splice(i, 1); bg.closeTab(id); };
    const entry = (hash) => bg.sessionStore[`ml_release_due:${hash}`];
    const entries = () => Object.keys(bg.sessionStore).filter((k) => k.startsWith("ml_release_due:"));
    const bodies = () => bg.calls.filter((c) => c.url.includes("/chat/completions")).map((c) => JSON.stringify(c.body));
    return { bg, port, script, state, run, closeTab, entry, entries, bodies };
}

// --- a page cannot release a run, and this browser's own page can ---

test("a content script's port is closed unheard, so a page's session.release frees nothing; the same command from an extension page does", T, async () => {
    const w = boot();
    const a = await w.run(7)("first");
    const b = await w.run(8)("second");
    // The page's port: never served, and its release reaches no handler.
    const page = w.bg.connect("ml-sessions", { url: SITE_URL, tab: { id: 8, url: SITE_URL } });
    assert.equal(page.wasDisconnected(), true, "a content script's ml-sessions port was served");
    page.send({ type: "cmd", id: 1, command: { type: "session.release", session: { runtime: "local", hash: a.hash } } });
    await tick(); await tick();
    assert.deepEqual(page.messages, [], "a content script's port heard the runtime");
    assert.equal(w.bg.pyDeletes.length, 0, "a page's release freed a run");
    assert.deepEqual(w.entries(), [], "a page's release wrote a deadline");
    assert.equal(a.row()?.status, "done", "a page's release changed the run");
    // The positive control: this browser's own page releasing the OTHER run through the extension port.
    const ok = await b.command({ type: "session.release", session: { runtime: "local", hash: b.hash } });
    assert.equal(ok.result?.ok ?? ok.ok, true, JSON.stringify(ok));
    assert.ok(await until(() => w.bg.pyDeletes.length === 1), "the extension page's release freed the run");
    assert.equal(w.bg.pyDeletes[0].run, b.hash);
    assert.equal(w.bg.pyDeletes[0].reason, "person");
});

// --- one tab's close reaches only that tab's runs ---

test("closing one tab arms only its own run: the other tab's session gets no deadline, no releaseAt, and is not released by the alarm", T, async () => {
    const w = boot();
    const a = await w.run(7)("keep me");
    const b = await w.run(8)("close me");
    assert.deepEqual(w.entries(), [], "a settled run with its tab open has no deadline");
    w.closeTab(8);
    assert.ok(await until(() => w.entry(b.hash)), "the closed tab's run got its deadline");
    assert.equal(w.entry(a.hash), undefined, "the open tab's run got the other tab's deadline");
    assert.ok(await until(() => b.row()?.background?.releaseAt === w.entry(b.hash).due), JSON.stringify(b.row()?.background));
    assert.equal(a.row()?.background?.releaseAt, undefined, "the open tab's row shows a deadline");
    assert.equal(w.bg.alarms.set.get("ml-release")?.when, w.entry(b.hash).due, "one alarm, at the closed tab's deadline");
    // The deadline comes due now: the alarm fires what is due (the grace is ten minutes out).
    w.bg.sessionStore[`ml_release_due:${b.hash}`].due = Date.now() - 1;
    w.bg.alarms.fire("ml-release");
    assert.ok(await until(() => w.bg.pyDeletes.length >= 1), "the alarm released the closed tab's run");
    assert.deepEqual(w.bg.pyDeletes.map((d) => d.run), [b.hash], "the alarm released another session's run too");
    assert.equal(w.entry(a.hash), undefined, "the open tab's run got an entry from the alarm");
    assert.ok(w.state().bgRuns.includes(a.hash), "the open tab's run was dropped");
    assert.equal(a.row()?.status, "done", "the open tab's session moved");
});

// --- no page can forge a deadline, and a forged one releases nothing of a real run ---

test("no page-startable type writes a release deadline or sets the release alarm, enumerated over the tables", T, async () => {
    const w = boot();
    const a = await w.run(7)("probe");
    assert.deepEqual(w.entries(), []);
    assert.equal(w.bg.alarms.set.has("ml-release"), false);
    const types = [...new Set([...PAGE_STARTED_TYPES, ...PAGE_UNGATED_TYPES, "ARM_RELEASE", "RELEASE_RUN", "SESSION_RELEASE", "ML_RELEASE"])];
    assert.ok(types.length > 10, "the tables were read");
    for (const type of types) {
        // The payload a page would send to plant a deadline: the storage key and the entry, under every name it could guess.
        void w.bg.send({
            type,
            payload: {
                session: { runtime: "local", hash: a.hash }, runId: a.hash, id: a.hash,
                key: `ml_release_due:${a.hash}`, value: { due: 0, closedAt: 0 },
                release: { due: 0, closedAt: 0 }, due: 0,
            },
        }, { url: SITE_URL, tab: { id: 7, url: SITE_URL } });
    }
    await tick(20);
    assert.deepEqual(w.entries(), [], "a page-startable type wrote a release deadline");
    assert.equal(w.bg.alarms.set.has("ml-release"), false, "a page-startable type set the release alarm");
    assert.equal(w.bg.pyDeletes.length, 0, "a page-startable type released a run");
});

test("a forged entry of an unusable shape, or one naming a run no session holds, releases nothing of a real run", T, async () => {
    const w = boot({ openTabs: [7], session: {
        [`ml_release_due:${"A".repeat(8)}`]: { due: "soon", closedAt: 1 },
        [`ml_release_due:${"B".repeat(8)}`]: { due: 0 },
        [`ml_release_due:${"C".repeat(8)}`]: null,
        [`ml_release_due:${"D".repeat(8)}`]: { due: 0, closedAt: 0, extra: "x", reason: "person", tabId: 7 },
    } });
    const a = await w.run(7)("probe");
    // The run's own key, set the way a forged writer would: its tab is open, so the recheck must drop it.
    w.bg.sessionStore[`ml_release_due:${a.hash}`] = { due: Date.now() - 1, closedAt: Date.now() - 1000 };
    w.bg.alarms.fire("ml-release");
    assert.ok(await until(() => w.bg.pyDeletes.length >= 1), "the pass ran");
    assert.equal(w.bg.pyDeletes[0].run, "D".repeat(8), "a well-formed entry was not the one released");
    assert.ok(await until(() => w.entry(a.hash) === undefined), "the open tab's forged deadline survived the pass");
    assert.ok(!w.bg.pyDeletes.some((d) => d.run === a.hash), "the open tab's run was released");
    assert.ok(w.state().bgRuns.includes(a.hash));
    // The bad shapes are inert: they are never read as entries, so nothing is released or rewritten for them.
    const inert = {
        [`ml_release_due:${"A".repeat(8)}`]: { due: "soon", closedAt: 1 },
        [`ml_release_due:${"B".repeat(8)}`]: { due: 0 },
        [`ml_release_due:${"C".repeat(8)}`]: null,
    };
    for (const [k, v] of Object.entries(inert)) assert.deepEqual(w.bg.sessionStore[k], v, `${k} was rewritten by the pass`);
});

// --- a worker that never saw the run reads its table first ---

test("a stored table with a row still running holds its own run with no deadline, while the run beside it is released in the same pass", T, async () => {
    const held = "hold0001";
    const free = "free0001";
    const now = Date.now();
    const w = boot({ openTabs: [7], session: {
        [`ml_release_due:${held}`]: { due: now - 1, closedAt: now - 60_000 },
        [`ml_release_due:${free}`]: { due: now - 1, closedAt: now - 60_000 },
        [`ml_tasks:${held}`]: [{ v: 1, id: "t000001", tool: "python_exec", startedMs: now - 1000, leaseMs: 15_000, expectMs: null, status: "running", result: null, text: null, delivered: false, code: null, ref: { kind: "py", cell: "cell-live" } }],
    } });
    assert.ok(await until(() => w.bg.pyDeletes.length >= 1), "the pass ran at worker start");
    assert.deepEqual(w.bg.pyDeletes.map((d) => d.run), [free], "the run whose stored cell still runs was released");
    assert.ok(await until(() => w.entry(held) && w.entry(held).due === null), JSON.stringify(w.entry(held)));
    assert.equal(w.entry(free), undefined);
    assert.equal(w.bg.alarms.set.get("ml-release"), undefined, "an alarm was left for a deadline that is null");
});

// --- the model's own setting cannot go past the release's range, or release anything ---

test("the model's change_setting cannot take closedRunGraceMin past the 1440 minutes the release clamps to", { ...T }, async () => {
    const w = boot();
    const a = await w.run(7)("set it");
    const lastTool = () => (JSON.parse(w.bodies().at(-1) ?? "{}")?.messages ?? []).filter((m) => m.role === "tool").at(-1)?.content ?? "";
    // The control: the top of the documented range is accepted.
    w.script.push({ name: "change_setting", args: { key: "closedRunGraceMin", value: 1440, why: "red team" } });
    await w.bg.context.__mlUserRunActionForTest(a.hash, "send", { text: "set 1440", surface: "hud" });
    assert.ok(await until(a.idle(2)), "the control turn ended");
    assert.match(lastTool(), /Changed closedRunGraceMin/, "the control was refused");
    for (const value of [1441, 99999]) {
        const want = a.turns() + 1;
        w.script.push({ name: "change_setting", args: { key: "closedRunGraceMin", value, why: "red team" } });
        await w.bg.context.__mlUserRunActionForTest(a.hash, "send", { text: `set ${value}`, surface: "hud" });
        assert.ok(await until(a.idle(want)), "the turn ended");
        assert.doesNotMatch(lastTool(), /Changed closedRunGraceMin/, `${value} was written as a grace`);
    }
});

test("a settings change releases no other session's run and arms nothing", T, async () => {
    const w = boot();
    const a = await w.run(7)("set it");
    const b = await w.run(8)("untouched");
    w.script.push({ name: "change_setting", args: { key: "closedRunGraceMin", value: 0, why: "red team" } });
    await w.bg.context.__mlUserRunActionForTest(a.hash, "send", { text: "set zero", surface: "hud" });
    assert.ok(await until(a.idle(2)), "the turn ended");
    assert.match((JSON.parse(w.bodies().at(-1) ?? "{}")?.messages ?? []).filter((m) => m.role === "tool").at(-1)?.content ?? "", /Changed closedRunGraceMin/, "the setting was not written");
    await tick(10);
    assert.equal(w.bg.pyDeletes.length, 0, "a settings change released a run");
    assert.deepEqual(w.entries(), [], "a settings change armed a deadline");
    assert.ok(w.state().bgRuns.includes(b.hash));
    assert.equal(b.row()?.status, "done");
});

// --- a kept row carries no value after the release ---

test("a kept undelivered row carries no figure after a release: its result is cleared, but the image it drew is still stored and delivered with the row", { ...T }, async () => {
    const w = boot();
    const a = await w.run(7)("probe");
    const MARK = "U0VDUkVUTUFSS0VS";   // base64("SECRETMARKER"), a figure no delivery should carry after the release
    const t = w.bg.context.__mlDetachTaskForTest(a.hash, "ml.sh");
    t.finish({ text: "shot taken", image: `data:image/png;base64,${MARK}` });
    assert.ok(await until(() => a.row()?.background?.waiting === 1), JSON.stringify(a.row()?.background));
    const ok = await a.command({ type: "session.release", session: { runtime: "local", hash: a.hash } });
    assert.equal(ok.result?.ok ?? ok.ok, true, JSON.stringify(ok));
    const stored = async () => w.bg.sessionStore[`ml_tasks:${a.hash}`];
    assert.ok(await until(async () => (await stored())?.[0]?.releasedAt), JSON.stringify(await stored()));
    const [row] = await stored();
    assert.equal(row.result, null, "the pointer is cleared");
    assert.ok(!JSON.stringify(row).includes(MARK), `the kept row still carries the figure: ${JSON.stringify(row)}`);
    // And the next turn must not carry it either.
    const before = w.bodies().length;
    await w.bg.context.__mlUserRunActionForTest(a.hash, "send", { text: "what happened", surface: "hud" });
    assert.ok(await until(a.idle(2)), "the next turn ended");
    const after = w.bodies().slice(before).join("\n");
    assert.ok(after.length > 0, "the next turn made a request");
    assert.ok(!after.includes(MARK), "the released figure was delivered with the kept row");
});
