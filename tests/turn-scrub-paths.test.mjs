// turn-scrub-paths.test.mjs — what a person or a page SENDS is scrubbed by registered value where it becomes a turn
// (ruling 39, SECRET_HANDLES.md, "What the person sends is scrubbed too"), through each entry point that wires it: a run
// the worker builds, a later message to it (a steer, a resume), a page's START_RUN, a stored run from before the scrub,
// and the chat page's chat. Every row reads the model's request AND what was stored or emitted, and the raw value is in
// neither. The scrub itself (`forTurn`) is tests/turn-scrub.test.mjs.
//
// The run paths run in the real background bundle (node:vm, tests/helpers.js `loadBackground`, as tests/run-start.test.mjs
// does) with the page played by `onTabMessage`; the chat page's chat runs the source's sw-chat.ts (as tests/sw-chat.test.mjs).

import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { jsonResponse, loadBackground } = require("./helpers");
const { IDBFactory } = require("fake-indexeddb");

// The source modules (sw-chat.ts) read the registry and the config through `chrome`, mocked here as tests/turn-scrub.test.mjs does.
globalThis.chrome = {
    runtime: { id: "ext-id", lastError: undefined, onMessage: { addListener() {} }, getURL: (p) => p },
    storage: {
        local: { get: async (d) => ({ ...(d ?? {}) }), set: async () => {}, remove: async () => {} },
        sync: { get: async (d) => ({ ...(d ?? {}), apiKey: "sk-test" }), set: async () => {} },
        session: { get: async () => ({}), set: async () => {}, remove: async () => {} },
        onChanged: { addListener() {} },
    },
};
const { _setRegistryForTest, _coldRegistryForTest } = await import("../src/sw/sw-secret-registry.ts");
const { forTurn } = await import("../src/sw/sw-scrub.ts");
const { backgroundChats, configureBackgroundChats, forgetBackgroundChat, sendBackgroundChat, startBackgroundChat } = await import("../src/sw/sw-chat.ts");
_setRegistryForTest([{ name: "PLUG_PASSWORD", value: "REALSECRET-4b1d-77" }]);

const T = { timeout: 15000 };
const NAME = "PLUG_PASSWORD";
const VALUE = "REALSECRET-4b1d-77";
const MARK = `[REDACTED:${NAME}]`;
/** The note the model reads after a turn: the count is its own row (the note over-counts a value scrubbed twice). */
const NOTE = /\n\[\d+ secrets? redacted \(PLUG_PASSWORD\)\]$/;
const REG = { ml_secret_registry: [{ name: NAME, value: VALUE }] };
const config = { chatUrl: "http://host/api/chat/completions", apiKey: "sk-test", model: "default-model", apiFormat: "openai", ocrModel: "", debugMode: "off" };
const SITE = { id: 7, url: "https://site.example/page", title: "Site" };
const TAB = { tab: { id: 7, url: SITE.url }, url: SITE.url };
const EXT = { id: "ext", url: "chrome-extension://ext/sidebar.html", origin: "chrome-extension://ext" };
const flush = async (n = 8) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)); };
/** A model turn split into its words and the note line after them (null when it has none). */
const split = (t) => { const m = NOTE.exec(t); return { words: m ? t.slice(0, m.index) : t, note: m ? m[0] : null }; };
const plain = (v) => JSON.parse(JSON.stringify(v));

/** The session events the worker fanned to the tab, of one kind. */
const fanned = (bg, kind) => bg.tabMessages.map(([, m]) => m).filter((m) => m.type === "ML_DEBUG_TO_PAGE" && m.event.kind === kind).map((m) => plain(m.event));
/** Every user message of a model request body. */
const usersOf = (call) => call.body.messages.filter((m) => m.role === "user").map((m) => String(m.content));

/**
 * A worker with the registry set, a value store, a model that answers `replies` in turn (a name: a tool call to it;
 * absent: "done") each held until its gate is let go when `hold` is set, and the page on tab 7.
 */
function world({ local = REG, cfg = {}, hold = false, replies = [], extra = {} } = {}) {
    const gates = [];
    const idb = new IDBFactory();
    const bg = loadBackground({
        config: { ...config, ...cfg }, openTabs: [SITE], local, indexedDB: idb, ...extra,
        onFetch: async (call) => {
            if (!call.url.includes("/chat/completions")) return jsonResponse({});
            const n = bg.calls.filter((c) => c.url.includes("/chat/completions")).length - 1;
            if (hold) await new Promise((r) => gates.push(r));
            const reply = replies[n];
            return jsonResponse({ choices: [{ message: reply ? { content: null, tool_calls: [{ id: `c${n}`, type: "function", function: { name: reply, arguments: "{}" } }] } : { content: "done" } }] });
        },
        onTabMessage: async (_t, msg) => (msg.type === "ADOPT_RUN_NOW" ? { pageInfo: "" } : msg.type === "RUN_TOOL_IN_PAGE" && msg.payload.finish ? { result: "" } : msg.type === "RUN_TOOL_IN_PAGE" ? { result: "ok" } : undefined),
    });
    const chats = () => bg.calls.filter((c) => c.url.includes("/chat/completions"));
    const waitChats = async (n) => { for (let i = 0; i < 400 && chats().length < n; i++) await flush(2); assert.ok(chats().length >= n, `model call ${n} was made (${chats().length})`); };
    const state = async (hash, id) => plain((await bg.send({ type: "DUMP_RUN_STATE", payload: { run: hash } }, EXT)).data.entries.find((e) => e.id === id)?.value ?? null);
    /** Everything the worker emitted or stored that a person could read back: the events, the stored snapshots. */
    const everything = () => JSON.stringify([bg.tabMessages, { ...bg.localStore, ml_secret_registry: undefined }]);
    return { bg, gates, chats, waitChats, state, everything, idb };
}

/** Every blob of the value store as text: the stored copy of what was attached. */
async function storedBlobs(idb) {
    const db = await new Promise((res, rej) => { const r = idb.open("ml-values"); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
    const blobs = await new Promise((res, rej) => { const r = db.transaction("blobs").objectStore("blobs").getAll(); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
    db.close();
    return Promise.all(blobs.map((b) => b.text()));
}

// --- a run the worker builds (startUserRun) ---

test("a run's task holding a registered value: the model reads the marker and the note, the start event's bubble shows the marker without the note", T, async () => {
    const w = world();
    await w.bg.context.__mlStartUserRunForTest(7, { task: `log in with ${VALUE} please`, surface: "hud" });
    await flush(20);
    const [user] = usersOf(w.chats()[0]).slice(-1);
    assert.deepEqual([split(user).words.endsWith(`log in with ${MARK} please`), split(user).note !== null], [true, true], user);
    const [start] = fanned(w.bg, "agent");
    assert.deepEqual(plain(start.display), { typed: `log in with ${MARK} please`, context: [] }, "the bubble shows the scrubbed words, no note");
    assert.ok(!JSON.stringify(start.display).includes("redacted ("), "no note in the bubble");
    assert.ok(!w.chats().some((c) => JSON.stringify(c.body).includes(VALUE)), "the model's requests never carried the value");
    assert.ok(!w.everything().includes(VALUE), "no event or stored snapshot carries the value");
});

test("a right-clicked element holding the value is scrubbed in the model's turn and in the display's element", T, async () => {
    const w = world();
    const el = { selector: "#pw", role: "textbox", text: VALUE, media: [], links: [] };
    await w.bg.context.__mlStartUserRunForTest(7, { task: "what is this?", elementContext: el, surface: "hud" });
    await flush(20);
    const user = usersOf(w.chats()[0]).at(-1);
    assert.ok(user.includes(MARK) && split(user).note, user);
    assert.ok(!w.chats().some((c) => JSON.stringify(c.body).includes(VALUE)));
    assert.ok(!w.everything().includes(VALUE), "the start event's display carries no value either");
});

test("a text file attached to a run: the model's turn and the stored row hold the marker, never the value", T, async () => {
    const w = world();
    const file = { name: "notes.txt", type: "text/plain", text: `db password = ${VALUE}\nhost = db1\n` };
    await w.bg.context.__mlStartUserRunForTest(7, { task: "read the notes", files: [file], surface: "hud" });
    await flush(30);
    const user = usersOf(w.chats()[0]).at(-1);
    assert.ok(user.includes(`db password = ${MARK}`), user);
    assert.ok(split(user).note, "the note follows the file blocks");
    const blobs = await storedBlobs(w.idb);
    assert.ok(blobs.length >= 1, "the file was held in the value store");
    assert.ok(blobs.some((b) => b.includes(MARK)), `the stored copy holds the marker: ${JSON.stringify(blobs)}`);
    assert.ok(!blobs.some((b) => b.includes(VALUE)), "the stored blob never holds the value");
    assert.ok(!w.chats().some((c) => JSON.stringify(c.body).includes(VALUE)));
    assert.ok(!w.everything().includes(VALUE));
});

// --- a later message to that run (userRunAction) ---

test("a steer into a RUNNING run: the model reads the marker and the note, the agent-say bubble shows the marker without the note", T, async () => {
    const w = world({ hold: true, replies: ["chat_metadata"] });
    const { hash } = await w.bg.context.__mlStartUserRunForTest(7, { task: "watch the price", surface: "hud" });
    await w.waitChats(1);
    assert.equal(await w.bg.context.__mlUserRunActionForTest(hash, "send", { text: `the password is ${VALUE}` }, { surface: "hud" }), "steer");
    w.gates[0]();
    await w.waitChats(2);
    w.gates[1]?.();
    const steered = usersOf(w.chats()[1]).at(-1);
    assert.equal(split(steered).words, `the password is ${MARK}`, "what the model read");
    assert.ok(split(steered).note, steered);
    const say = fanned(w.bg, "agent-say").at(-1);
    assert.ok(say, "the steer was shown as an agent-say bubble");
    const shown = say.display?.typed ?? say.text;
    assert.ok(shown.includes(MARK) && !shown.includes("redacted ("), `the bubble: ${JSON.stringify(say)}`);
    await flush(20);
    assert.ok(!w.chats().some((c) => JSON.stringify(c.body).includes(VALUE)));
    assert.ok(!w.everything().includes(VALUE));
});

test("a message to a run that has SETTLED (a resume): the model reads the marker and the note, the bubble the marker alone", T, async () => {
    const w = world();
    const { hash } = await w.bg.context.__mlStartUserRunForTest(7, { task: "first", surface: "hud" });
    await flush(30);
    const r = await w.bg.send({ type: "USER_RUN_ACTION", payload: { hash, action: "send", text: `try ${VALUE} now`, surface: "hud" } }, TAB);
    assert.equal(r.data, "turn");
    await w.waitChats(2);
    await flush(20);
    const said = usersOf(w.chats()[1]).at(-1);
    assert.equal(split(said).words, `try ${MARK} now`);
    assert.ok(split(said).note, said);
    const say = fanned(w.bg, "agent-say").at(-1);
    const shown = say.display?.typed ?? say.text;
    assert.equal(shown, `try ${MARK} now`, `the bubble: ${JSON.stringify(say)}`);
    assert.ok(!w.chats().some((c) => JSON.stringify(c.body).includes(VALUE)));
    assert.ok(!w.everything().includes(VALUE));
});

test("a file sent with a later message is scrubbed at rest too", T, async () => {
    const w = world();
    const { hash } = await w.bg.context.__mlStartUserRunForTest(7, { task: "first", surface: "hud" });
    await flush(30);
    const file = { name: "env.txt", type: "text/plain", text: `PW=${VALUE}\n` };
    const r = await w.bg.send({ type: "USER_RUN_ACTION", payload: { hash, action: "send", text: "see file", files: [file], surface: "hud" } }, TAB);
    assert.equal(r.data, "turn");
    await w.waitChats(2);
    await flush(20);
    assert.ok(usersOf(w.chats()[1]).at(-1).includes(`PW=${MARK}`));
    const blobs = await storedBlobs(w.idb);
    assert.ok(blobs.some((b) => b.includes(MARK)) && !blobs.some((b) => b.includes(VALUE)), JSON.stringify(blobs));
    assert.ok(!w.everything().includes(VALUE));
});

// --- a page's own turn: bare, no name, no note, and nothing turns it off ---

const pageStart = (extra = {}) => ({ type: "START_RUN", payload: {
    runId: "pagerun1", task: `use ${VALUE} to sign in`, systemPrompt: "sys", tools: [], model: "m", think: null,
    maxSteps: 3, autoApprovePython: false, autoApproveReadonly: false, surface: "off", ...extra,
} });

for (const [what, extra] of [["a page's START_RUN", {}], ["a page's START_RUN that sends scrubInput: false", { scrubInput: false }]]) {
    test(`${what}: the model reads the bare [REDACTED], never the name, and no note`, T, async () => {
        const w = world();
        const r = await w.bg.send(pageStart(extra), TAB);
        assert.ok(!r.error, r.error);
        await flush(20);
        const user = usersOf(w.chats()[0]).at(-1);
        assert.match(user, /Message from the page \([^)]*\): use \[REDACTED\] to sign in$/, user);
        assert.ok(!user.includes(NAME) && !user.includes("redacted ("), "no name and no note for a page's turn");
        assert.ok(!w.chats().some((c) => JSON.stringify(c.body).includes(VALUE)));
        assert.ok(!w.everything().includes(VALUE));
    });
}

test("a page's steer into its running run is scrubbed bare as well", T, async () => {
    const w = world({ hold: true, replies: ["chat_metadata"] });
    const first = w.bg.send(pageStart({ task: "watch" }), TAB);
    await w.waitChats(1);
    const r = await w.bg.send({ type: "INJECT_MESSAGE", payload: { runId: "pagerun1", text: `now ${VALUE}`, sayId: "sy1" } }, TAB);
    assert.equal(r.data, true, JSON.stringify(r));
    w.gates[0]();
    await w.waitChats(2);
    w.gates[1]?.();
    await first;
    const steered = usersOf(w.chats()[1]).at(-1);
    assert.ok(steered.endsWith("now [REDACTED]"), steered);
    assert.ok(!steered.includes(NAME) && !steered.includes("redacted ("));
    assert.ok(!w.chats().some((c) => JSON.stringify(c.body).includes(VALUE)));
    assert.ok(!w.everything().includes(VALUE));
});

// --- the upgrade: a run stored by the code before the scrub ---

/** A run as the code before ruling 39 stored it: a person's (worker-built) run whose user turn holds the value, no `inputScrubbed`. */
const oldRun = (runId, over = {}, pOver = {}) => ({
    version: "9.9.9", ts: Date.now(), tabId: 7,
    messages: [
        { role: "system", content: "SYS" },
        { role: "user", content: `log in with ${VALUE}` },
        { role: "assistant", content: "done" },
    ],
    p: {
        runId, task: `log in with ${VALUE}`, tools: [], model: "m", think: null, maxSteps: 5, systemPrompt: "SYS", surface: "off",
        autoApprovePython: false, autoApproveReadonly: false, builtBy: "worker", crossPage: true,
        rebuild: { toolNames: [], model: "m", builtBy: "worker", driverSees: false, visionModel: null, groundingModel: null, groundingRange: 1000, pierceClosed: false, cdp: false, crossOrigin: true },
        ...pOver,
    },
    ...over,
});

test("UPGRADE: a stored run from before the scrub is resumed with the marker in its old user turn, once", T, async () => {
    const snap = oldRun("old1");
    const w = world({ local: { ...REG, ml_bgrun_old1: snap } });
    await w.bg.context.__mlEvictForTest();   // the worker comes back from storage, as it does after an eviction
    const r = await w.bg.send({ type: "USER_RUN_ACTION", payload: { hash: "old1", action: "send", text: "and then?", surface: "hud" } }, TAB);
    assert.equal(r.data, "turn", JSON.stringify(r));
    await w.waitChats(1);
    const sent = JSON.stringify(w.chats()[0].body.messages);
    assert.ok(!sent.includes(VALUE), `the model's history holds the old turn raw: ${sent}`);
    assert.ok(usersOf(w.chats()[0]).some((u) => u === `log in with ${MARK}`), sent);
    assert.equal(usersOf(w.chats()[0]).at(-1), "and then?", "the new message has nothing to take out, so no note");
    await flush(30);
    // What the resume leaves in the run's store: the old turn scrubbed once (the history is rewritten in place, and the
    // run marked `inputScrubbed`), so a later resume has nothing left to take out and adds no second pass.
    const kept = (await w.state("old1", "run.messages")).filter((m) => m.role === "user").map((m) => m.content);
    assert.deepEqual(kept, [`log in with ${MARK}`, "and then?"]);
    assert.ok(!w.everything().includes(VALUE), "no event carries the old turn raw");
    const again = await w.bg.send({ type: "USER_RUN_ACTION", payload: { hash: "old1", action: "send", text: "once more", surface: "hud" } }, TAB);
    assert.equal(again.data, "turn");
    await w.waitChats(2);
    assert.deepEqual(usersOf(w.chats()[1]), [`log in with ${MARK}`, "and then?", "once more"], "a second resume sends the same history, with no note added to it");
});

test("UPGRADE: a run marked inputScrubbed is not scrubbed again on resume: an old user turn is left as a scrubInput:false turn left it", T, async () => {
    const w = world({ local: { ...REG, ml_bgrun_new1: oldRun("new1", {}, { inputScrubbed: true }) } });
    await w.bg.context.__mlEvictForTest();
    const r = await w.bg.send({ type: "USER_RUN_ACTION", payload: { hash: "new1", action: "send", text: "and then?", surface: "hud" } }, TAB);
    assert.equal(r.data, "turn", JSON.stringify(r));
    await w.waitChats(1);
    assert.ok(usersOf(w.chats()[0]).includes(`log in with ${VALUE}`), "the turn the person sent unscrubbed stays as sent");
});

// --- the setting and the unreadable store ---

test("scrubPersonInput: false: the task reaches the model as typed", T, async () => {
    const w = world({ cfg: { scrubPersonInput: false } });
    await w.bg.context.__mlStartUserRunForTest(7, { task: `log in with ${VALUE} please`, surface: "hud" });
    await flush(20);
    assert.equal(usersOf(w.chats()[0]).at(-1), `log in with ${VALUE} please`);
});

test("a registry that cannot be read refuses the run with a TurnUnreadable naming scrubInput: false, and nothing reaches the model", T, async () => {
    // A value storage cannot clone makes every read of the registry throw.
    const w = world({ local: { ml_secret_registry: () => {} } });
    await assert.rejects(w.bg.context.__mlStartUserRunForTest(7, { task: `log in with ${VALUE}`, surface: "hud" }), (e) => {
        assert.match(e.message, /scrubInput: false/);
        assert.ok(!e.message.includes(VALUE));
        return true;
    });
    await flush(20);
    assert.equal(w.chats().length, 0, "nothing reached the model");
    assert.equal(fanned(w.bg, "agent").length, 0, "no run was announced");
});

// --- the count of the note ---

test("the note counts a value once, however many places the turn scrubs it", T, async () => {
    const w = world();
    await w.bg.context.__mlStartUserRunForTest(7, { task: `log in with ${VALUE} please`, surface: "hud" });
    await flush(20);
    assert.ok(usersOf(w.chats()[0]).at(-1).endsWith(`please\n[1 secret redacted (${NAME})]`), usersOf(w.chats()[0]).at(-1));
});

// --- the chat page's chat (sw-chat.ts) ---

/** The worker's chats with a model that answers `re: <last message>`; the events, the stored records and each request. */
function chatWorld() {
    const events = [], stored = new Map(), requests = [];
    configureBackgroundChats({
        emit: (e) => events.push(plain(e)),
        call: async (req) => { requests.push(plain(req)); return { content: "ok", model: "m1" }; },
        load: async (hash) => stored.get(hash) ?? null,
        save: async (hash, session) => { stored.set(hash, plain(session)); },
        now: () => 1000,
        images: async () => ({ route: "model" }),
        read: async () => "",
        hold: async () => ({ key: "row" }),
        release: () => {},
        scrub: () => forTurn(),   // the worker's own (sw-sessions.ts)
    });
    for (const hash of backgroundChats()) forgetBackgroundChat(hash);
    const done = async (n) => { for (let i = 0; i < 200 && events.filter((e) => e.kind === "chat-result").length < n; i++) await new Promise((r) => setTimeout(r, 5)); };
    return { events, stored, requests, done };
}

test("the chat page's chat: the request's user message is scrubbed with the note, the chat event and the stored chat hold no value", T, async () => {
    const c = chatWorld();
    const hash = await startBackgroundChat({ text: `my password is ${VALUE}` });
    await c.done(1);
    const sent = c.requests[0].messages.at(-1).content;
    assert.equal(split(sent).words, `my password is ${MARK}`);
    assert.ok(split(sent).note, sent);
    const start = c.events.find((e) => e.kind === "chat");
    assert.deepEqual(start.request.messages.at(-1).content, sent, "the chat event carries what the model was sent");
    assert.ok(!JSON.stringify(c.events).includes(VALUE), "no event holds the value");
    assert.ok(!JSON.stringify([...c.stored.values()]).includes(VALUE), "the stored chat holds no value");
    assert.ok(c.stored.has(hash));
});

test("a text file in the chat page's chat is scrubbed in the request and in the stored chat", T, async () => {
    const c = chatWorld();
    await startBackgroundChat({ text: "read this", files: [{ name: "env.txt", type: "text/plain", text: `PW=${VALUE}\n` }] });
    await c.done(1);
    assert.ok(c.requests[0].messages.at(-1).content.includes(`PW=${MARK}`), c.requests[0].messages.at(-1).content);
    const start = c.events.find((e) => e.kind === "chat");
    assert.ok(!JSON.stringify(start.display ?? null).includes(VALUE));
    assert.ok(!JSON.stringify(c.events).includes(VALUE));
    assert.ok(!JSON.stringify([...c.stored.values()]).includes(VALUE));
});

test("UPGRADE: a chat stored before the scrub has its earlier user turns scrubbed in what is sent, and left as stored", T, async () => {
    const c = chatWorld();
    const old = { hash: "oldchat9", messages: [{ role: "user", content: `pw ${VALUE}` }, { role: "assistant", content: "hi" }], model: null, extend: null, numCtx: null, numGpu: null, think: null, schema: null, toolIds: null, maxTokens: null, save: true };
    c.stored.set("oldchat9", structuredClone(old));
    assert.equal(await sendBackgroundChat("oldchat9", "and now?"), "turn");
    await c.done(1);
    const sent = c.requests[0].messages.map((m) => m.content);
    assert.deepEqual(sent.slice(0, 2), [`pw ${MARK}`, "hi"], "the old turn is scrubbed on its way to the model");
    assert.ok(!JSON.stringify(c.requests).includes(VALUE));
    const kept = c.stored.get("oldchat9").messages;
    assert.equal(kept[0].content, `pw ${VALUE}`, "the stored copy of the old turn is not rewritten");
    assert.ok(!kept.slice(2).some((m) => String(m.content).includes(VALUE)), "the new turn is stored scrubbed");
});

test("a chat whose registry cannot be read is refused before anything is sent", T, async () => {
    const c = chatWorld();
    const real = chrome.storage.local.get;
    chrome.storage.local.get = async () => { throw new Error("the store is gone"); };
    _coldRegistryForTest();
    try {
        await assert.rejects(startBackgroundChat({ text: `x ${VALUE}` }), (e) => e.name === "TurnUnreadable" || /scrubInput|secrets/.test(e.message));
        await new Promise((r) => setTimeout(r, 30));
        assert.equal(c.requests.length, 0, "nothing reached the model");
        assert.equal(c.events.length, 0, "nothing was emitted");
    } finally { chrome.storage.local.get = real; _setRegistryForTest([{ name: NAME, value: VALUE }]); }
});
