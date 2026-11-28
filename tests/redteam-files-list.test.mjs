// redteam-files-list.test.mjs — RED TEAM for the file browser's worker half (#2183): FILES_COMMITTED and the
// `files-changed` hint it can make, and the FILES_* asks the offscreen reader makes of the worker.
//
// The property: nothing a page can send may make the worker tell anyone that a session's files changed, and a hint,
// when it is real, names only the session it came for and names no directories the sender chose. The offscreen
// document is the one sender whose word makes a hint (isOffscreenSender, sw-offscreen.ts); every other sender — a
// content script, the person's own extension page, another extension, a sender that merely looks like the offscreen
// document's URL — is a message that must leave no trace. The sibling asks (FILES_ATTACHED, FILES_SECRET_FORMS,
// FILES_QUOTA, FILES_HIDE_LIST) hold the same gate and answer a benign empty instead of the truth.
//
// Against the built bundle (`dist/background.js` in node:vm, tests/helpers.js `loadBackground`), like
// background-sessions.test.js. The offscreen document's own listener gate is redteam-offscreen-files-list.test.mjs.
import { test } from "node:test";
// Loose assert on purpose: the bundle's answers are built in the vm sandbox, so their objects are another realm's and
// `deepStrictEqual` would fail on the prototype alone (as background-sessions.test.js does it).
import assert from "node:assert";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { loadBackground } = require("./helpers");

const T = { timeout: 10000 };
const SITE = "https://news.example/article";
const OFFSCREEN = "chrome-extension://test/offscreen.html";
const PAGE = { url: "chrome-extension://test/sidebar/chat.html" };
const config = { chatUrl: "http://host/api/chat/completions", apiKey: "sk-test", model: "default-model", apiFormat: "openai", ocrModel: "" };
const flush = async (n = 8) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)); };

const A = "aaaa0001";
const B = "bbbb0002";
const startEvent = (hash) => ({ kind: "agent", id: hash, ts: 1, save: false, session: { hash, turn: 0 }, task: "look it up", model: "m", maxSteps: 5, config: null });

/**
 * A worker holding two sessions (A and B), a page subscribed to each, and a sender that IS the offscreen document.
 * @returns the worker, `send(msg, sender)` for the background, both ports, and `hints()` (every `files-changed` each
 *  subscription heard, keyed by sub)
 */
async function setup() {
    const bg = loadBackground({ config });
    const evSender = { tab: { id: 7, url: SITE, title: "Site" }, url: SITE, frameId: 0 };
    for (const h of [A, B]) await bg.send({ type: "ML_SESSION_EVENT", event: startEvent(h) }, evSender);
    await flush();
    const portA = bg.connect("ml-sessions", PAGE);
    const portB = bg.connect("ml-sessions", PAGE);
    portA.send({ type: "events", sub: 1, hash: A });
    portB.send({ type: "events", sub: 2, hash: B });
    await flush();
    const hints = (port, sub) => port.messages.filter((m) => m.type === "stream" && m.sub === sub && m.message?.type === "files-changed");
    const all = () => [...hints(portA, 1), ...hints(portB, 2)];
    return { bg, portA, portB, hints, all };
}

const offscreen = () => ({ id: "test", url: OFFSCREEN });
/** Every sender that must never be able to make a hint, each a shape something other than the offscreen document has. */
const NOT_THE_OFFSCREEN = [
    ["a content script on the page the run is about", { id: "test", url: SITE, tab: { id: 7, url: SITE }, frameId: 0 }],
    ["the person's own extension page (the sidebar, which a web page may frame)", { id: "test", url: "chrome-extension://test/sidebar.html" }],
    ["another extension, with the offscreen document's own path", { id: "evil", url: "chrome-extension://evil/offscreen.html" }],
    ["the offscreen document's URL but with a tab, a shape the document never has", { id: "test", url: OFFSCREEN, tab: { id: 7, url: SITE } }],
    ["the offscreen document's URL one character off", { id: "test", url: "chrome-extension://test/offscreen.html " }],
    ["the offscreen document's URL in another case", { id: "test", url: "chrome-extension://test/Offscreen.html" }],
    ["our id with no URL at all", { id: "test" }],
];

// --- FILES_COMMITTED: the offscreen document's word only ---

test("RED TEAM: a FILES_COMMITTED has to be the offscreen document's word; from a page, the sidebar, another extension or a look-alike URL it makes no files-changed at all", T, async () => {
    const { bg, all } = await setup();
    for (const [what, sender] of [...NOT_THE_OFFSCREEN, ["a sender Chrome never delivers: none at all", {}]]) {
        void bg.send({ type: "FILES_COMMITTED", session: A }, sender);
        await flush();
        assert.deepEqual(all(), [], `${what} made the worker tell a page the session's files changed`);
    }
    // The positive control: the same message from the offscreen document is the one that does, so the zeros above are
    // the gate and not a hint that never fires.
    void bg.send({ type: "FILES_COMMITTED", session: A }, offscreen());
    await flush();
    assert.equal(all().length, 1);
});

test("RED TEAM: a real FILES_COMMITTED names the session it came for and nothing else: no directories the sender chose, and a subscriber to another session hears nothing", T, async () => {
    const { bg, portA, portB, all } = await setup();
    // A forged fan-out: the largest dirs list a message can carry, and fields the worker never reads.
    const dirs = Array.from({ length: 1000 }, (_, i) => `attached/h${i}`);
    void bg.send({ type: "FILES_COMMITTED", session: A, dirs, scope: "global", session_extra: { hash: B } }, offscreen());
    await flush();
    const heard = all();
    assert.equal(heard.length, 1, "one commit, one hint, to one session's subscriber");
    const m = heard[0].message;
    assert.deepEqual(Object.keys(m).sort(), ["session", "type"], "the wire message carries nothing but its type and session");
    assert.deepEqual(m.session, { runtime: "local", hash: A });
    assert.deepEqual(portB.messages.filter((x) => x.message?.type === "files-changed"), []);
});

test("RED TEAM: a FILES_COMMITTED that names no session, a non-string session or a session the index does not hold makes no hint, even from the offscreen document", T, async () => {
    const { bg, all } = await setup();
    for (const session of [undefined, null, 5, "", {}, [], "__proto__", "deadbeef"]) {
        void bg.send({ type: "FILES_COMMITTED", session }, offscreen());
        await flush();
        assert.deepEqual(all(), [], `session ${JSON.stringify(session)} made a hint`);
    }
    void bg.send({ type: "FILES_COMMITTED" }, offscreen());
    await flush();
    assert.deepEqual(all(), []);
});

test("RED TEAM: files-changed is a live hint, not an event: it is never an index row, never replayed to a subscriber who joins after it", T, async () => {
    const { bg, portA, portB } = await setup();
    void bg.send({ type: "FILES_COMMITTED", session: A }, offscreen());
    await flush();
    assert.equal(portA.messages.filter((m) => m.message?.type === "files-changed").length, 1, "positive control: it was sent");
    // Not in the index: the only index updates a page sees are the two sessions it started with.
    const indexRows = portA.messages.filter((m) => m.type === "index").length;
    portA.send({ type: "sessions" });
    await flush();
    const indexAgain = portA.messages.filter((m) => m.type === "index").length;
    assert.ok(indexAgain >= indexRows, "the page re-asked the index; the hint added no row to it");
    // A subscriber that joins after the commit is not told of it: no backfill, no cursor.
    const late = bg.connect("ml-sessions", PAGE);
    late.send({ type: "events", sub: 9, hash: A });
    await flush();
    assert.deepEqual(late.messages.filter((m) => m.message?.type === "files-changed"), []);
    // And session B's page still heard nothing at any point.
    assert.deepEqual(portB.messages.filter((m) => m.message?.type === "files-changed"), []);
});

// --- the sibling asks hold the same gate ---

test("RED TEAM: FILES_ATTACHED, FILES_SECRET_FORMS, FILES_QUOTA and FILES_HIDE_LIST answer a page, an extension page or a look-alike the benign empty, never the session's truth", T, async () => {
    const { bg } = await setup();
    for (const [what, sender] of NOT_THE_OFFSCREEN) {
        assert.deepEqual(await bg.send({ type: "FILES_ATTACHED", session: A }, sender), { files: [] }, `FILES_ATTACHED to ${what}`);
        assert.deepEqual(await bg.send({ type: "FILES_SECRET_FORMS" }, sender), { forms: null }, `FILES_SECRET_FORMS to ${what}`);
        assert.deepEqual(await bg.send({ type: "FILES_QUOTA" }, sender), { bytes: null }, `FILES_QUOTA to ${what}`);
        assert.deepEqual(await bg.send({ type: "FILES_HIDE_LIST", session: A }, sender), { entries: null }, `FILES_HIDE_LIST to ${what}`);
    }
    // Positive control: the offscreen document is answered as something other than the empty (a hide list always is:
    // an empty array is the truth "nothing is hidden", the null above is the refusal).
    assert.notDeepEqual(await bg.send({ type: "FILES_HIDE_LIST", session: A }, offscreen()), { entries: null });
});

// --- the page's own route to all of it ---

test("RED TEAM: a content script cannot open the sessions port, so files.list and every files-changed are the extension pages' alone", T, async () => {
    const bg = loadBackground({ config });
    const page = bg.connect("ml-sessions", { url: SITE, tab: { id: 7, url: SITE } });
    page.send({ type: "sessions" });
    await flush();
    assert.equal(page.wasDisconnected(), true);
    assert.deepEqual(page.messages, [], "a page that opens the index port hears nothing, not even an error");
    // The person's HUD page is the one that may, and it is the only one: the same connection from an extension page stays.
    const hud = bg.connect("ml-sessions", PAGE);
    assert.equal(hud.wasDisconnected(), false);
});
