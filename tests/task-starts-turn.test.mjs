// task-starts-turn.test.mjs — rule 4b slice C in the real bundle (`dist/background.js` in node:vm, tests/helpers.js
// `loadBackground`): a finished detached task starts the run's next turn through the person's "Continue" path, the
// completions that arrive while it starts coalesce into it, a person's message sent meanwhile reaches it, and the
// settings (notify-only, the chain cap) hold. The decision's own cases (reasons, storage, upgrade) are in task-turn.test.mjs.
import { test } from "node:test";
import assert from "node:assert";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { jsonResponse, loadBackground } = require("./helpers");

const SITE_URL = "https://site.example/page";
const T = { timeout: 30000 };
const tick = () => new Promise((r) => setTimeout(r, 0));
async function until(done, cap = 4000) { for (let i = 0; i < cap && !(await done()); i++) await tick(); return done(); }

/** A worker-built run on tab 7 whose first turn has ended. `hold.adopt` (a promise) holds the page's answer to an adopt;
 *  `hold.model` holds the model's next answer. */
async function settled(config = {}, more = {}) {
    const hold = { adopt: null, model: null };
    const openTabs = [{ id: 7, windowId: 3, active: true, url: SITE_URL, title: "Site" }];
    const bg = loadBackground({
        config: { chatUrl: "http://host/api/chat/completions", apiKey: "k", model: "m", apiFormat: "openai", debugMode: "off", ...config },
        openTabs, ...more,
        onFetch: async (call) => {
            if (call.url.endsWith("/api/models")) return jsonResponse({ data: [{ id: "m" }] });
            if (!call.url.includes("/chat/completions")) return jsonResponse({});
            if (hold.model) await hold.model;
            return jsonResponse({ choices: [{ message: { content: "done" } }] });
        },
        onTabMessage: async (t, msg) => {
            if (msg.type === "ADOPT_RUN_NOW") { if (hold.adopt) await hold.adopt; return { pageInfo: "" }; }
            return undefined;
        },
    });
    bg.commit?.(7, { documentId: "doc-7", url: SITE_URL });
    const { hash } = await bg.context.__mlStartUserRunForTest(7, { task: "probe", surface: "hud", maxSteps: 5 });
    const events = () => bg.tabMessages.filter(([t, m]) => t === 7 && m?.type === "ML_DEBUG_TO_PAGE").map(([, m]) => m.event);
    const turns = () => events().filter((e) => e?.kind === "agent-result" && e.id === hash).length;
    const completions = () => bg.calls.filter((c) => c.url.includes("/chat/completions"));
    const lastBody = () => completions().at(-1)?.body;
    const live = () => bg.context.__mlRunStateForTest().controllers.includes(hash);
    const starting = () => bg.context.__mlRunStateForTest().starting.includes(hash);
    const idle = (n) => () => turns() >= n && !live() && !starting();
    assert.ok(await until(idle(1)), "the first turn settles");
    const logOf = async () => (await bg.context.__mlRunLog.all()).filter((e) => e.run === hash);
    const notes = () => events().filter((e) => e?.kind === "agent-note").map((e) => e.text);
    const detach = () => bg.context.__mlDetachTaskForTest(hash, "ml.sh");
    return { bg, hash, hold, openTabs, events, turns, completions, lastBody, live, starting, idle, logOf, notes, detach };
}
const userTexts = (body) => (body?.messages ?? []).filter((m) => m.role === "user").map((m) => String(m.content));

test("a task that finishes between turns starts exactly one turn on the run's tab; the model's first step reads the result and the transcript says why", T, async () => {
    const r = await settled();
    const t = r.detach();
    t.finish({ text: "built 3 files" });
    assert.ok(await until(r.idle(2)), "a second turn ran");
    assert.equal(r.completions().length, 2, "one model call per turn, no third turn");
    assert.ok(userTexts(r.lastBody()).some((x) => new RegExp(`^\\[task ${t.id} done after \\d+ s: built 3 files\\]`).test(x)), "the first step read the inbox");
    assert.ok(!userTexts(r.lastBody()).includes(""), "no empty user turn");
    assert.ok(r.notes().some((x) => new RegExp(`^Turn started by task ${t.id} \\(done after`).test(x)), "the person sees why the model spoke");
    assert.equal(r.bg.sessionStore[`ml_task_chain:${r.hash}`], 1, "the chain count is stored beside the table");
    assert.ok((await r.logOf()).some((e) => e.kind === "turn-started"));
});

test("two results that finish before the started turn's first step start one turn, and both reach it", T, async () => {
    const r = await settled();
    const a = r.detach(), b = r.detach();
    a.finish({ text: "first" }); b.finish({ text: "second" });
    assert.ok(await until(r.idle(2)));
    await new Promise((res) => setTimeout(res, 100));
    assert.equal(r.completions().length, 2, "one started turn for two completions");
    const read = userTexts(r.lastBody()).join("\n");
    assert.match(read, new RegExp(`\\[task ${a.id} done after \\d+ s: first\\]`));
    assert.match(read, new RegExp(`\\[task ${b.id} done after \\d+ s: second\\]`));
    assert.equal(r.bg.sessionStore[`ml_task_chain:${r.hash}`], 1, "counted once");
});

test("a person's message sent while the started turn is starting is steered into that turn, not refused", T, async () => {
    const r = await settled();
    let release;
    r.hold.adopt = new Promise((res) => { release = res; });
    const t = r.detach();
    t.finish({ text: "built" });
    assert.ok(await until(r.starting), "the turn is starting (the page's adopt is held)");
    const outcome = await r.bg.context.__mlUserRunActionForTest(r.hash, "send", { text: "also check the footer", surface: "hud" });
    assert.equal(outcome, "steer", "held for the turn, said as sent");
    assert.equal(r.completions().length, 1, "nothing started a second turn");
    release();
    assert.ok(await until(r.idle(2)));
    assert.equal(r.completions().length, 2, "one started turn");
    const read = userTexts(r.lastBody());
    assert.ok(read.includes("also check the footer"), "the message reached the turn");
    assert.ok(read.some((x) => x.startsWith(`[task ${t.id} done`)), "and so did the result");
    assert.equal(r.bg.sessionStore[`ml_task_chain:${r.hash}`], undefined, "the person's message reset the chain");
});

test("a message held for a turn that never hosts is said not to have been sent", T, async () => {
    const r = await settled();
    let release;
    r.hold.adopt = new Promise((res) => { release = res; });
    r.detach().finish({ text: "built" });
    assert.ok(await until(r.starting));
    assert.equal(await r.bg.context.__mlUserRunActionForTest(r.hash, "send", { text: "lost?", surface: "hud" }), "steer");
    // The page cannot host the run now: the start gives up.
    r.hold.adopt = null;
    r.bg.context.__mlCancelAllRunsForTest();
    release();
    assert.ok(await until(() => !r.starting()));
    assert.ok(await until(() => r.notes().some((x) => /^Your message was not sent: the run's turn did not start/.test(x))), r.notes().join(" | "));
});

test("a message WITH a file held for a turn that never hosts is taken back whole: no payload, no run.files, no shelf after an eviction", T, async () => {
    const { IDBFactory } = require("fake-indexeddb");
    const r = await settled({}, { indexedDB: new IDBFactory() });
    const NOTES = { name: "notes.txt", type: "text/plain", text: "alpha\nbeta" };
    const EXT = { id: "ext", url: "chrome-extension://ext/sidebar.html", origin: "chrome-extension://ext" };
    const payloads = () => JSON.parse(JSON.stringify(r.bg.context.__mlRunPayloadsForTest(r.hash)));
    const shelf = async () => JSON.parse(JSON.stringify((await r.bg.send({ type: "DUMP_RUN_STATE", payload: { run: r.hash } }, EXT)).data.entries.find((e) => e.id === "run.files")?.value ?? null));
    const before = payloads();
    assert.ok(before.length > 0, "the run carries a payload");
    let release;
    r.hold.adopt = new Promise((res) => { release = res; });
    r.detach().finish({ text: "built" });
    assert.ok(await until(r.starting));
    assert.equal(await r.bg.context.__mlUserRunActionForTest(r.hash, "send", { text: "see this", files: [NOTES], surface: "hud" }), "steer");
    assert.ok(payloads().some((p) => p.files.length === 1), "held: recorded while the turn starts");
    r.hold.adopt = null;
    r.bg.context.__mlCancelAllRunsForTest();
    release();
    assert.ok(await until(() => !r.starting()));
    assert.ok(await until(() => r.notes().some((x) => /^Your message was not sent: the run's turn did not start/.test(x))), r.notes().join(" | "));
    assert.deepEqual(payloads(), before, "no payload lists the file, and sends is what it was");
    assert.equal(await shelf(), null, "run.files does not list it");
    await r.bg.context.__mlEvictForTest();
    assert.deepEqual(payloads().flatMap((p) => p.files), [], "still none after the worker was evicted");
    assert.equal(await shelf(), null, "the rebuilt shelf does not hold it");
});

test("notify-only: the result parks, the person sees the line, and the next message's turn reads it", T, async () => {
    const r = await settled({ taskNotifyOnly: true });
    const t = r.detach();
    t.finish({ text: "built" });
    assert.ok(await until(() => r.notes().some((x) => x.startsWith(`task ${t.id} done; its result is read at your next message`))));
    await new Promise((res) => setTimeout(res, 100));
    assert.equal(r.completions().length, 1, "no turn started");
    assert.equal(r.bg.sessionStore[`ml_task_chain:${r.hash}`], undefined);
    await r.bg.context.__mlUserRunActionForTest(r.hash, "send", { text: "go on", surface: "hud" });
    assert.ok(await until(r.idle(2)));
    assert.ok(userTexts(r.lastBody()).some((x) => x.startsWith(`[task ${t.id} done`)), "the parked result was read at the person's message");
});

test("the chain: the cap stops started turns, and the person's next message starts the count again", T, async () => {
    const r = await settled({ taskTurnChainMax: 2 });
    for (let i = 1; i <= 2; i++) {
        r.detach().finish({ text: `r${i}` });
        assert.ok(await until(r.idle(1 + i)), `started turn ${i}`);
    }
    assert.equal(r.bg.sessionStore[`ml_task_chain:${r.hash}`], 2);
    const third = r.detach();
    third.finish({ text: "r3" });
    assert.ok(await until(() => r.notes().some((x) => x.startsWith(`task ${third.id} done; 2 turns in a row`))), r.notes().join(" | "));
    await new Promise((res) => setTimeout(res, 100));
    assert.equal(r.completions().length, 3, "no fourth turn");
    await r.bg.context.__mlUserRunActionForTest(r.hash, "send", { text: "carry on", surface: "hud" });
    assert.ok(await until(r.idle(4)));
    assert.equal(r.bg.sessionStore[`ml_task_chain:${r.hash}`], undefined, "reset");
    r.detach().finish({ text: "r4" });
    assert.ok(await until(r.idle(5)), "the count started again: a task starts a turn");
});

test("a run whose tab is gone: the result parks with a run-log record and no turn starts", T, async () => {
    const r = await settled();
    r.openTabs.splice(0, 1);
    r.detach().finish({ text: "built" });
    assert.ok(await until(async () => (await r.logOf()).some((e) => e.kind === "not-started" && e.reason === "no-tab")));
    assert.equal(r.completions().length, 1);
});

// The person's word reaches a LIVE started turn three ways, and each breaks the chain: a steer from the chat page
// (`session.send`, steerRun), a steer from an extension frame (INJECT_MESSAGE), and a message that starts a turn (above).
async function liveStartedTurn() {
    const r = await settled();
    let release;
    r.hold.model = new Promise((res) => { release = res; });
    r.detach().finish({ text: "built" });
    assert.ok(await until(() => r.live() && r.completions().length === 2), "the started turn is live, at its model call");
    assert.equal(r.bg.sessionStore[`ml_task_chain:${r.hash}`], 1);
    return { r, release };
}

test("a steer from the chat page into the live started turn breaks the chain", T, async () => {
    const { r, release } = await liveStartedTurn();
    const port = r.bg.connect("ml-sessions", { url: "chrome-extension://test/chat.html" });
    port.send({ type: "sessions" });
    const rowStatus = () => { let st; for (const m of port.messages) if (m.type === "index") { const u = m.update; if (u.type === "snapshot") st = u.sessions.find((x) => x.id.hash === r.hash)?.status ?? st; else if (u.type === "upsert" && u.session.id.hash === r.hash) st = u.session.status; } return st; };
    assert.ok(await until(() => rowStatus() === "running"), `the index shows the started turn running (${rowStatus()})`);
    port.send({ type: "cmd", id: 9, command: { type: "session.send", session: { runtime: "local", hash: r.hash }, text: "from the phone" } });
    assert.ok(await until(() => port.messages.some((m) => m.type === "result" && m.id === 9)));
    const res = port.messages.find((m) => m.type === "result" && m.id === 9).result;
    assert.deepEqual(res, { ok: true, data: { mode: "steer" } }, JSON.stringify(res));
    assert.equal(r.bg.sessionStore[`ml_task_chain:${r.hash}`], undefined);
    release();
    assert.ok(await until(r.idle(2)));
});

test("a steer from an extension frame (INJECT_MESSAGE) into the live started turn breaks the chain", T, async () => {
    const { r, release } = await liveStartedTurn();
    const hud = { tab: { id: 7, url: SITE_URL }, url: "chrome-extension://test/sidebar.html", frameId: 1 };
    assert.deepEqual(await r.bg.send({ type: "INJECT_MESSAGE", payload: { runId: r.hash, text: "also this", sayId: "s1" } }, hud), { data: true });
    assert.equal(r.bg.sessionStore[`ml_task_chain:${r.hash}`], undefined);
    release();
    assert.ok(await until(r.idle(2)));
});

test("a turn started for a task never runs on an empty inbox: the result read elsewhere while the page was adopted starts nothing and gives the count back", T, async () => {
    const r = await settled();
    let release;
    r.hold.adopt = new Promise((res) => { release = res; });
    const t = r.detach();
    t.finish({ text: "built" });
    assert.ok(await until(r.starting), "the turn is starting");
    await t.read();   // an await takes the result: nothing is left for the turn to read
    release();
    assert.ok(await until(() => !r.starting()));
    await new Promise((res) => setTimeout(res, 100));
    assert.equal(r.completions().length, 1, "no model call");
    assert.equal(r.turns(), 1);
    assert.ok(!r.notes().some((x) => x.startsWith("Turn started by task")), "no start line is left standing");
    assert.ok((await r.logOf()).some((e) => e.kind === "not-started" && e.reason === "empty-inbox"));
    assert.equal(r.bg.sessionStore[`ml_task_chain:${r.hash}`], 0, "the count was given back");
});
