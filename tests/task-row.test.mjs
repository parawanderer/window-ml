// task-row.test.mjs — rule 4b slice E, the state half, in the real bundle (`dist/background.js` in node:vm, tests/helpers.js
// `loadBackground`): a run's detached tasks are counted on its session's index row (`SessionSummary.background`), read from
// the durable task table, with `noTab` once the run has no open tab. The row's own cases are in session-index.test.mjs.
import { test } from "node:test";
import assert from "node:assert";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { jsonResponse, loadBackground } = require("./helpers");

const SITE_URL = "https://site.example/page";
const T = { timeout: 30000 };
const tick = () => new Promise((r) => setTimeout(r, 0));
async function until(done, cap = 4000) { for (let i = 0; i < cap && !(await done()); i++) await tick(); return done(); }

/** A worker-built run on tab 7 whose first turn has ended, and a subscriber to the session index. `config` is laid over the
 *  stored config (`taskNotifyOnly: true` parks a finished task instead of starting a turn). */
async function settled(config = {}) {
    const openTabs = [{ id: 7, windowId: 3, active: true, url: SITE_URL, title: "Site" }];
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
    bg.commit?.(7, { documentId: "doc-7", url: SITE_URL });
    const { hash } = await bg.context.__mlStartUserRunForTest(7, { task: "probe", surface: "hud", maxSteps: 5 });
    const events = () => bg.tabMessages.filter(([t, m]) => t === 7 && m?.type === "ML_DEBUG_TO_PAGE").map(([, m]) => m.event);
    const turns = () => events().filter((e) => e?.kind === "agent-result" && e.id === hash).length;
    const idle = (n) => () => turns() >= n && !bg.context.__mlRunStateForTest().controllers.includes(hash) && !bg.context.__mlRunStateForTest().starting.includes(hash);
    assert.ok(await until(idle(1)), "the first turn settles");
    const port = bg.connect("ml-sessions", { url: "chrome-extension://test/chat.html" });
    port.send({ type: "sessions" });
    /** The row as the chat page's index holds it: the snapshot, then each upsert, in order. */
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
    const bgOf = () => row()?.background;
    return { bg, hash, openTabs, idle, row, bgOf, detach: () => bg.context.__mlDetachTaskForTest(hash, "ml.sh") };
}

// --- the row carries the run's background tasks (rule 4b, "A session with no tab shows it") ---

test("a detached task puts running: 1 on the run's row; it carries no field before and none for a run with no tasks", T, async () => {
    const r = await settled();
    assert.equal(r.row().background, undefined, "a run with no tasks carries no field");
    r.detach();
    assert.ok(await until(() => r.bgOf()), "the row was marked");
    assert.deepEqual(r.bgOf(), { running: 1, waiting: 0 });
});

test("a task that ends between turns under notify-only is waiting: 1, and the person's next turn reading it clears the field", T, async () => {
    const r = await settled({ taskNotifyOnly: true });
    const t = r.detach();
    assert.ok(await until(() => r.bgOf()?.running === 1));
    t.finish({ text: "built" });
    assert.ok(await until(() => r.bgOf()?.waiting === 1), JSON.stringify(r.bgOf()));
    assert.deepEqual(r.bgOf(), { running: 0, waiting: 1 });
    await r.bg.context.__mlUserRunActionForTest(r.hash, "send", { text: "go on", surface: "hud" });
    assert.ok(await until(r.idle(2)), "the person's next turn ran");
    assert.ok(await until(() => r.bgOf() === undefined), `the read result cleared the field: ${JSON.stringify(r.bgOf())}`);
});

test("by default a task that ends between turns starts a turn, and that turn reading it clears the field", T, async () => {
    const r = await settled();
    const t = r.detach();
    assert.ok(await until(() => r.bgOf()?.running === 1));
    t.finish({ text: "built" });
    assert.ok(await until(r.idle(2)), "the task's turn ran");
    assert.ok(await until(() => r.bgOf() === undefined), `the read result cleared the field: ${JSON.stringify(r.bgOf())}`);
});

test("closing the run's tab sets noTab: true, and not a moment before", T, async () => {
    const r = await settled();
    r.detach();
    assert.ok(await until(() => r.bgOf()));
    assert.equal(r.bgOf().noTab, undefined, "the run has its tab");
    r.openTabs.length = 0;
    r.bg.closeTab(7);
    assert.ok(await until(() => r.bgOf()?.noTab === true), JSON.stringify(r.bgOf()));
    assert.deepEqual(r.bgOf(), { running: 1, waiting: 0, noTab: true });
});

test("after an eviction the row is rebuilt from the stored table, whatever memory held", T, async () => {
    const r = await settled();
    r.detach();
    assert.ok(await until(() => r.bgOf()?.running === 1));
    await r.bg.context.__mlEvictForTest();
    // A running `ml.sh` row hydrates as orphaned (its connection died with the worker): a result waiting for the next turn.
    assert.ok(await until(() => r.bgOf()?.waiting === 1 && r.bgOf()?.running === 0), JSON.stringify(r.bgOf()));
});

// --- a run with no tasks: the readers the move-run lane and the release build will plug in ---

test("with no reader set, a run that never had tasks and whose tab closed carries no field", T, async () => {
    const r = await settled();
    // background.ts plugs in the release's reader (releaseAtOf): unplugged here, this is the hook's own default.
    r.bg.context.__mlTaskRowReadersForTest.setReleaseAtReader(null);
    r.openTabs.length = 0;
    r.bg.closeTab(7);
    await r.bg.context.__mlTaskRowReadersForTest.refreshTaskRow(r.hash);
    await tick();
    assert.equal(r.row().background, undefined);
});

test("a run that never had tasks and whose tab closed carries only the release deadline the closing set", T, async () => {
    const r = await settled();
    r.openTabs.length = 0;
    r.bg.closeTab(7);
    await r.bg.context.__mlTaskRowReadersForTest.refreshTaskRow(r.hash);
    assert.ok(await until(() => r.row()?.background?.releaseAt));
    assert.deepEqual(Object.keys(r.row().background).sort(), ["releaseAt", "running", "waiting"], "no noTab: that is the move-run lane's reader");
});

test("a noTab reader answering true gives {0,0,noTab}, none of it reaches the HUD, and unplugging clears it", T, async () => {
    const r = await settled();
    const k = r.bg.context.__mlTaskRowReadersForTest;
    k.setNoTabReader(async (h) => h === r.hash);
    await k.refreshTaskRow(r.hash);
    assert.ok(await until(() => r.bgOf()), "the row was marked");
    assert.deepEqual(r.bgOf(), { running: 0, waiting: 0, noTab: true });
    assert.equal(r.bg.tabMessages.some(([, m]) => m?.event?.kind === "agent-tasks" && m.event.background), false, "the HUD shows counts only");
    k.setNoTabReader(null);
    await k.refreshTaskRow(r.hash);
    assert.ok(await until(() => r.bgOf() === undefined));
});

test("a releaseAt reader puts the deadline on the row, with or without tasks", T, async () => {
    const r = await settled();
    const k = r.bg.context.__mlTaskRowReadersForTest;
    k.setReleaseAtReader(() => 123456);
    await k.refreshTaskRow(r.hash);
    assert.ok(await until(() => r.bgOf()));
    assert.deepEqual(r.bgOf(), { running: 0, waiting: 0, releaseAt: 123456 });
    r.detach();
    assert.ok(await until(() => r.bgOf()?.running === 1));
    assert.deepEqual(r.bgOf(), { running: 1, waiting: 0, releaseAt: 123456 });
    k.setReleaseAtReader(null);
    await k.refreshTaskRow(r.hash);
    assert.ok(await until(() => r.bgOf()?.releaseAt === undefined));
});

// --- the run's own tab is told (the HUD card's mark) ---

test("the run's tab receives agent-tasks with running: 1 after a detach, and null once the result is read", T, async () => {
    const r = await settled();
    const notices = () => r.bg.tabMessages.filter(([t, m]) => t === 7 && m?.type === "ML_DEBUG_TO_PAGE" && m.event?.kind === "agent-tasks" && m.event.id === r.hash).map(([, m]) => m.event);
    assert.equal(notices().length, 0, "a run with no tasks says nothing");
    const t = r.detach();
    assert.ok(await until(() => notices().some((e) => e.background?.running === 1)), JSON.stringify(notices()));
    assert.equal(notices().at(-1).save, false);
    assert.equal(notices().at(-1).background.noTab, undefined, "the HUD has its tab: no noTab");
    t.finish({ text: "built" });
    assert.ok(await until(r.idle(2)), "the task's turn ran");
    assert.ok(await until(() => notices().at(-1)?.background === null), JSON.stringify(notices()));
});

test("a card a navigation reloads gets the mark again from the tab's replay", T, async () => {
    const r = await settled();
    const notices = () => r.bg.tabMessages.filter(([t, m]) => t === 7 && m?.type === "ML_DEBUG_TO_PAGE" && m.event?.kind === "agent-tasks" && m.event.id === r.hash).map(([, m]) => m.event);
    r.detach();
    assert.ok(await until(() => notices().some((e) => e.background?.running === 1)));
    const before = notices().length;
    r.bg.commit?.(7, { documentId: "doc-8", url: SITE_URL });
    void r.bg.send({ type: "SHELL_LISTENING" }, { tab: { id: 7, url: SITE_URL }, url: SITE_URL, origin: new URL(SITE_URL).origin, frameId: 0, documentId: "doc-8" });
    assert.ok(await until(() => notices().length > before), "the new document was sent the mark");
    assert.deepEqual(notices().at(-1).background, { running: 1, waiting: 0 });
});
