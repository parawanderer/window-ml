// devtools-port-senders.test.mjs — the DevTools feed's port (`serveDevtoolsPort`, src/sw/sw-debug.ts): WHO may read a
// tab's debug stream. A port named `ml-devtools` and the first init message's `tabId` are all it takes today, so any
// context that can open a runtime port reads another tab's run — its prompts, its tool results — by naming its id.
// SITE_PRESENCE gaps (6): the sender decides, not the tab id.
//
// No reachable hostile path exists TODAY: a Port needs `chrome.runtime`, which a page's main world does not have, and the
// content script relays only page-relay.ts's HANDLE_MAP types — none of which opens one. These rows are the property a
// fix must hold so that the next relay, or a content script's mistake, cannot turn into a read of another tab's run.
//
// The rule the fix serves by, measured before the rows were written: a devtools page's port carries `tab: null` (the
// security lane logged `port.sender` from the worker against a real DevTools window, one port per tab), so "an extension
// page with no tab" covers the product's own panel; the e2e watcher's page-in-a-tab is covered by "its tab's top document
// is ours"; and our own frame inside a page — a tab whose URL is the page's — is the shape that stays refused.
//
// Failing-first, the node:test way: the rows a fix must turn are `{ todo: true }` until it lands (they fail on main at
// the assertion each one carries), and the flip is MY OWN COMMIT on the fix's branch (#1369), its file only, before the
// fix merges: the fix's own CI run then proves the defended assertions, rather than main carrying an unproven fix.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { loadBackground } = require("./helpers");

const TODO = "gaps (6) is open on main: the fix lands behind this row";
const CONFIG = { chatUrl: "http://host/api/chat/completions", apiKey: "sk-test", model: "default-model", apiFormat: "openai", ocrModel: "" };
const RUN_TAB = 1;   // the tab whose run is live, and whose stream the buffer holds
const SNEAK_TAB = 2; // the tab a hostile context runs in, naming RUN_TAB's id
const SECRETS = [
    { kind: "agent", session: { hash: "s1" }, task: "pay the invoice" },
    { kind: "tool", step: 1, call: { name: "fetch_url", args: { url: "https://bank.test/statement" } } },
];

/** The DevTools panel's shape: one of the extension's own pages, and no tab of its own. */
const PANEL = { url: "chrome-extension://test/devtools.html" };
/** A content script's shape: the page's URL and the tab it runs in (Chrome sets both). */
const tabSender = (id, url = `https://page-${id}.test/`) => ({ url, tab: { id, url }, frameId: 0 });

const settle = () => new Promise((r) => setTimeout(r, 0));

/** Put a live run's events in the tab's replay ring, the way the shell forwards them (ML_DEBUG_EVENT). */
async function seed(bg) {
    for (const event of SECRETS) await bg.send({ type: "ML_DEBUG_EVENT", event }, tabSender(RUN_TAB));
}

/** A live event after the port is connected: what a panel sees as the run goes on. */
const live = (bg) => bg.send({ type: "ML_DEBUG_EVENT", event: { kind: "agent", session: { hash: "s1" }, task: "and the second one" } }, tabSender(RUN_TAB));

/** Open a `ml-devtools` port naming `tabId`, as devtools.ts does. */
function openPort(bg, tabId, sender) {
    const port = bg.connect("ml-devtools", sender);
    port.send({ type: "ml-devtools-init", tabId });
    return port;
}

/** What a port read of the run's stream: the kinds in its replay, and how many live events followed. */
const read = (port) => {
    const replay = port.messages.find((m) => Array.isArray(m.replay));
    return { replayKinds: replay ? [...replay.replay].map((e) => e.kind) : null, live: port.messages.filter((m) => m.__mlDebug).length };
};

// --- the DevTools feed's port: which senders may read a tab's stream ---

test("a content script's port reads nothing of another tab's run", { todo: TODO }, async () => {
    const bg = loadBackground({ config: CONFIG });
    await seed(bg);
    const port = openPort(bg, RUN_TAB, tabSender(SNEAK_TAB));
    await settle();
    // Today: `[{ replay: [the run's start, its fetch of bank.test] }]` — the whole buffer, to a page's content script.
    assert.deepEqual(port.messages, [], `the replay was handed to a page's content script: ${JSON.stringify(port.messages)}`);
    await live(bg);
    await settle();
    assert.deepEqual(port.messages, [], "and the run went on into it");
    assert.equal(port.wasDisconnected(), true, "the worker closes the port it refuses");
});

test("a port from a web URL with no tab reads nothing", { todo: TODO }, async () => {
    const bg = loadBackground({ config: CONFIG });
    await seed(bg);
    const port = openPort(bg, RUN_TAB, { url: "https://evil.example/" });
    await settle();
    assert.deepEqual(port.messages, [], `any url at all is served today: ${JSON.stringify(port.messages)}`);
    assert.equal(port.wasDisconnected(), true);
});

test("an extension URL FRAMED INTO A PAGE is refused (its sender.url is ours, its tab's is the page's)", { todo: TODO }, async () => {
    const bg = loadBackground({ config: CONFIG });
    await seed(bg);
    // The shape is reachable: our card/overlay iframe runs on any page. Only our code runs in it, so this is not a
    // hole today — it is the edge of the rule the fix serves by: an extension page with NO tab (a devtools page,
    // measured: its port carries `tab: null`) or with its own page as the tab's top document. A frame inside a
    // page has a tab, and that tab is the page's.
    const port = openPort(bg, RUN_TAB, { url: "chrome-extension://test/card.html", tab: { id: SNEAK_TAB, url: `https://page-${SNEAK_TAB}.test/` }, frameId: 0 });
    await settle();
    assert.deepEqual(port.messages, [], `the sender is never read today: ${JSON.stringify(port.messages)}`);
    assert.equal(port.wasDisconnected(), true);
});

// --- what both sides already hold: the floor, the panel's control, and the entry a refusal must leave ---

test("a port whose sender names no url and no tab reads nothing", { todo: TODO }, async () => {
    // The sender that exists but identifies nothing: `{}` is truthy, so a rule tempted to fall back to "the panel shape"
    // when the sender is falsy still has to refuse it. On main nothing is read, so the buffer comes back as to any port.
    const bg = loadBackground({ config: CONFIG });
    await seed(bg);
    const port = openPort(bg, RUN_TAB, {});
    await settle();
    assert.deepEqual(port.messages, [], `a sender naming nothing was served: ${JSON.stringify(port.messages)}`);
    assert.equal(port.wasDisconnected(), true, "the worker closes the port it refuses");
});

test("a port connected with NO sender at all reads nothing", { todo: TODO }, async () => {
    // The other side of the falsy-sender edge: #1369's helper makes a falsy sender into the panel shape, so a port that
    // brings no sender must be refused rather than served as the panel. Chrome always fills a sender in, so this is the
    // close on that helper's default, not a shape a page can reach.
    const bg = loadBackground({ config: CONFIG });
    await seed(bg);
    for (const sender of [undefined, null]) {
        const port = bg.connect("ml-devtools", sender);
        port.send({ type: "ml-devtools-init", tabId: RUN_TAB });
        await settle();
        assert.deepEqual(port.messages, [], `a port with no sender was served: ${JSON.stringify(port.messages)}`);
    }
});

test("a port that names no tab reads nothing, from any sender", async () => {
    const bg = loadBackground({ config: CONFIG });
    await seed(bg);
    for (const sender of [PANEL, tabSender(SNEAK_TAB), { url: "https://evil.example/" }]) {
        const port = bg.connect("ml-devtools", sender);
        port.send({ type: "ml-devtools-init" });
        await settle();
        assert.deepEqual(port.messages, [], `a port with no tab read something: ${JSON.stringify(port.messages)}`);
    }
});

test("an extension page as a tab's own top document reads the stream (the e2e watcher's shape)", async () => {
    const bg = loadBackground({ config: CONFIG });
    await seed(bg);
    // harness.mjs `watchRunEvents` opens popup.html in a window of its own, so the port's sender is our page AND
    // carries that tab, whose `url` is the same extension page. The fix serves it; on main nothing is checked and
    // it is served too, so the row is a control on both sides — and what a rule built on `sender.tab` alone must
    // not break.
    const own = { url: "chrome-extension://test/popup.html", tab: { id: RUN_TAB, url: "chrome-extension://test/popup.html" }, frameId: 0 };
    const port = openPort(bg, RUN_TAB, own);
    await settle();
    assert.deepEqual(read(port).replayKinds, SECRETS.map((e) => e.kind), "the whole buffer, in order");
    await live(bg);
    await settle();
    assert.equal(read(port).live, 1, "and the live event after it");
    assert.equal(port.wasDisconnected(), false);
});

test("the DevTools panel's own port reads the buffered replay, then each live event (the control)", async () => {
    const bg = loadBackground({ config: CONFIG });
    await seed(bg);
    const port = openPort(bg, RUN_TAB, PANEL);
    await settle();
    assert.deepEqual(read(port).replayKinds, SECRETS.map((e) => e.kind), "the whole buffer, in order");
    await live(bg);
    await settle();
    assert.equal(read(port).live, 1, "and the live event after it");
    assert.equal(port.wasDisconnected(), false);
});

test("a refused port leaves no entry: the panel that opens next still gets the full replay", { todo: TODO }, async () => {
    const bg = loadBackground({ config: CONFIG });
    await seed(bg);
    const hostile = openPort(bg, RUN_TAB, tabSender(SNEAK_TAB));
    await settle();
    const panel = openPort(bg, RUN_TAB, PANEL);
    await settle();
    assert.deepEqual(read(panel).replayKinds, SECRETS.map((e) => e.kind), "the panel behind a refused port still gets the whole buffer");
    assert.deepEqual(hostile.messages, [], "the refused port read nothing");
});
