// redteam-page-run-moved.test.mjs — what a PAGE must not get from a person's message to a run IT built, once its tab
// has navigated to another site that may use window.ml. One defect family, two halves (e3's second pass on #1492).
//
// A run a page built lives in the page: the worker's only way to deliver the person's message is the relay
// `ML_SESSION_TO_PAGE`, which it sends to whatever page the tab shows NOW (`chrome.tabs.sendMessage(tabId, …)`), chosen
// after `siteDecision(<the tab's current origin>)`. Both halves are that origin being consulted where the run's BUILDER
// origin (`stored.p.pageOrigin`, stamped by the browser at the start) is the one that matters:
//
//   - FILES: a text file goes to the page whole, so its body reaches a site that never built the run. Refused by name
//     (`pageRunMoved`, src/attached-files.ts) by #1520, which this branch carries: the two rows below are live (their
//     `{ todo }` flipped with the fix). The family has a THIRD shape with no navigation at all: the message is sent with
//     ANOTHER tab's id, the early-out refuses only a PDF (`fromTabId !== tabId`, src/sw/sw-run-start.ts), and both
//     callers then forward the files to the SENDING tab's page that built nothing (flaky-ci, review 6719096527). Its
//     text-only sibling still falls back to that page by ruling, since a page-built chat lives there and is in none of
//     `bgRuns`, so that shape gets the files row only. A FOURTH shape needs no navigation and no aim: a settled
//     page-built run leaves no snapshot (`tests/nav-handover.test.mjs` pins it), so after the worker is evicted it
//     holds no `tabId` and #1520's guard (`tabId != null`) cannot fire: the file goes to the tab's current page. That
//     row is measured and stays `{ todo }` after #1520's flip, which turns the two rows above.
//   - TEXT: the person's typed message is relayed the same way, and is what the run is then driven BY. The fix is the
//     hand-over the code already has for a site that may NOT use window.ml: the run becomes the worker's, the worker
//     starts the turn, and no page carries the message. Landing after #1316; my own commit on that branch flips these.
//
// The instrument is the worker's own behaviour, not a guess at the shell's: `ML_SESSION_TO_PAGE` is the relay (its
// payload is what the page would receive), and `USER_RUN_ACTION` answering `null` is the worker telling the SHELL to
// hand the message to the page — the tab channel's relay happens there, where the worker cannot see it. Every row
// therefore also asserts on the panel channel (ML_SESSION_REMOTE), which both trusts and exercises the worker alone.
//
// The controls are the two sides of each: a tab still on its builder's origin relays (so a row asserting "nothing
// reached the page" cannot pass by the relay being dead), and a tab on a site that may NOT use window.ml is already
// driven by the worker (the shape the text half must extend, not invent). The last control is the measurement the whole
// fix's reasoning rests on: a SUBFRAME cannot build a run at all (`only a page's top frame can use window.ml`,
// src/site-access.ts), so a page-built run's builder origin is always its tab's top-frame origin, and "the tab still
// shows the builder's origin" is a complete test.
import { test } from "node:test";
import assert from "node:assert/strict";
import { jsonResponse, loadBackground } from "./helpers.js";

const T = { timeout: 15000 };
const flush = async (n = 20) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)); };
const config = { chatUrl: "http://host/api/chat/completions", apiKey: "sk-test", model: "m", apiFormat: "openai", ocrModel: "", debugMode: "off" };

const A = "https://builder.example/";
const B = "https://other.example/";
const NOTES = { name: "notes.txt", type: "text/plain", text: "the person's file body, never a page's to read" };
const SECRET = "the person's words, typed to their own run";
/** The panel and the tab, as the browser stamps them: an extension page with no tab, and the run's tab. */
const EXT = { id: "ext", url: "chrome-extension://ext/panel.html", origin: "chrome-extension://ext" };
/** The sentence #1520 refuses a moved run's file with (src/attached-files.ts `pageRunMoved`). */
const moved = (name, origin) => `${name} would go to ${origin}, which did not build this run: start a run from the panel to attach it`;

/** The session events the worker fanned to the tab, of one kind. */
const fanned = (bg, kind) => bg.tabMessages.map(([, m]) => m).filter((m) => m.type === "ML_DEBUG_TO_PAGE" && m.event.kind === kind).map((m) => m.event);
/** Every message the worker sent to a page, in order. */
const toPage = (bg) => bg.tabMessages.map(([, m]) => m).filter((m) => m.type === "ML_SESSION_TO_PAGE");
/** The chat requests the worker made (a page's own run asks from the page, so a turn recorded here was the worker's). */
const chats = (bg) => bg.calls.filter((c) => c.url.includes("/chat/completions"));
/** What the model was last asked, as the user turn: the anchor that the message was DELIVERED, not swallowed. */
const lastUser = (bg) => String(chats(bg).at(-1)?.body?.messages?.filter((m) => m.role === "user").at(-1)?.content ?? "");

/**
 * A worker with one tab on `A`, `A` and `B` approved (`approvedB: false` leaves `B` off the list), and a page that
 * answers the toolset push and the adoption, so a run it starts really is stored as page-built. `restore` is a whole
 * `chrome.storage.local` a worker wakes up on, which is how an eviction is played.
 * @param {{approvedB?: boolean, restore?: Record<string, unknown>}} [o]
 */
function world({ approvedB = true, restore } = {}) {
    const tab = { id: 7, url: A, title: "Builder" };
    const bg = loadBackground({
        config, siteGate: true,
        local: { ml_site_always: ["https://builder.example", ...(approvedB ? ["https://other.example"] : [])], ...(restore ?? {}) },
        openTabs: [tab],
        onFetch: (call) => call.url.includes("/chat/completions") ? jsonResponse({ choices: [{ message: { content: "ok" } }] }) : jsonResponse({}),
        onTabMessage: async (_t, msg) => (msg.type === "ADOPT_RUN_NOW" ? { pageInfo: "" } : msg.type === "RUN_TOOL_IN_PAGE" && msg.payload.finish ? { result: "" } : undefined),
    });
    return { bg, tab };
}

/** The page's own START_RUN on tab 7, as nav-handover.test.mjs drives it: the page's build, stored as such. */
async function pageBuild(bg, runId) {
    const r = await bg.send({ type: "START_RUN", payload: {
        runId, task: "first", systemPrompt: "S", tools: [], model: "m", think: null, maxSteps: 2,
        autoApprovePython: false, autoApproveReadonly: false, surface: "off",
        rebuild: { toolNames: [], model: "m", driverSees: false, visionModel: null, groundingModel: null, groundingRange: 1000, pierceClosed: false, cdp: false, crossOrigin: true },
    } }, { tab: { id: 7, url: A }, url: A });
    await flush();
    return r;
}

/** The person's message, as the tab's own shell sends it (the address bar's surface in a tab the run is on). */
const fromTab = (id, url) => ({ tab: { id, url }, url });

// --- the controls: a tab still on its builder's origin relays, and a site that may not use window.ml never does ---

test("CONTROL: on its builder's origin a page-built run takes the person's text AND text file through its page", T, async () => {
    // Without this, "nothing reached the page" proves nothing: the relay has to be alive, and both halves of the
    // person's message have to be visible in it. The tab channel is the shell's relay (`null` = hand it to the page);
    // the panel channel is the worker's own (`ML_SESSION_TO_PAGE`).
    const { bg } = world();
    await pageBuild(bg, "pagebuilt1");
    const sent = await bg.send({ type: "USER_RUN_ACTION", payload: { hash: "pagebuilt1", action: "send", text: SECRET, files: [NOTES] } }, fromTab(7, A));
    assert.equal(sent.data, null, "the worker did not hand this to the page's own shell");
    void bg.send({ type: "ML_SESSION_REMOTE", tabId: 7, action: "send", hash: "pagebuilt1", text: SECRET, files: [NOTES], surface: "devtools" }, EXT);
    await flush();
    const relays = toPage(bg);
    assert.equal(relays.length, 1, "the panel's message did not reach the page at all");
    assert.equal(relays[0].text, SECRET, "the text did not reach the page on its builder's origin");
    assert.deepEqual(JSON.parse(JSON.stringify(relays[0].files)), [NOTES], "the text file did not reach the page on its builder's origin");
    assert.equal(chats(bg).length, 1, "a page route still had the worker call the model");
});

test("CONTROL: on a site that may not use window.ml the worker drives the run itself, and no page carries the text", T, async () => {
    // The hand-over the text fix extends: `makeWorkerRun`, then the turn is the worker's. Its shape is what the text
    // half of this family has to reach on an APPROVED site that is not the builder.
    const { bg, tab } = world({ approvedB: false });
    await pageBuild(bg, "pagebuilt2");
    tab.url = B;
    const r = await bg.send({ type: "USER_RUN_ACTION", payload: { hash: "pagebuilt2", action: "send", text: SECRET } }, fromTab(7, B));
    await flush();
    assert.notEqual(r.data, null, "the worker answered null, which tells the shell to hand the person's text to the page");
    assert.deepEqual(toPage(bg), [], "a message reached a page that may not use window.ml");
    assert.match(lastUser(bg), new RegExp(SECRET), "the person's message never reached the model: the turn was dropped, not moved");
    assert.equal(fanned(bg, "agent-say").at(-1)?.text, SECRET, "the run's own event does not show the person's message as sent");
});

test("CONTROL: a subframe cannot build a run, so a page-built run's builder origin is its tab's top frame origin", T, async () => {
    // What makes "the tab still shows the builder's origin" a complete test of "the right page gets the message": the
    // origin is stamped from the start's sender, and only frame 0 of a tab may start one. If that changed, a run could
    // be built by a frame whose origin its tab never shows, and the moved test would have to look at frames.
    const tab = { id: 7, url: "https://host.example/", title: "Host" };
    const bg = loadBackground({
        config, siteGate: true, local: { ml_site_always: ["https://host.example", "https://widget.example"] },
        openTabs: [tab], onFetch: () => jsonResponse({}),
        onTabMessage: async (_t, msg) => (msg.type === "ADOPT_RUN_NOW" ? { pageInfo: "" } : undefined),
    });
    const r = await bg.send({ type: "START_RUN", payload: { runId: "framebuilt1", task: "x", systemPrompt: "S", tools: [], model: "m", think: null, maxSteps: 2 } },
        { tab: { id: 7, url: tab.url }, url: "https://widget.example/embed", origin: "https://widget.example", frameId: 1 });
    await flush();
    assert.match(String(r.error), /top frame/i, `a subframe's run was accepted: ${JSON.stringify(r)}`);
});

// --- the files half: a file never goes to a page that did not build the run ---

test("RED TEAM: a run a page built, its tab now on ANOTHER approved site, sends no file to that page and refuses it by name", T, async () => {
    const { bg, tab } = world();
    await pageBuild(bg, "pagebuilt3");
    assert.equal(bg.tabMessages.filter(([, m]) => m.type === "ML_SESSION_TO_PAGE").length, 0, "the page's own start already relayed something");
    tab.url = B;
    // Both channels: the tab's shell (answered `null` + the reason, so it does not relay) and the panel (the worker's).
    const sent = await bg.send({ type: "USER_RUN_ACTION", payload: { hash: "pagebuilt3", action: "send", text: SECRET, files: [NOTES] } }, fromTab(7, B));
    assert.equal(sent.refused, moved("notes.txt", "https://other.example"), `the tab channel was not told the file is refused: ${JSON.stringify(sent)}`);
    void bg.send({ type: "ML_SESSION_REMOTE", tabId: 7, action: "send", hash: "pagebuilt3", text: SECRET, files: [NOTES], surface: "devtools" }, EXT);
    await flush();
    const relays = toPage(bg);
    for (const m of relays) {
        assert.equal(m.files, undefined, `a file went to the site that did not build the run: ${JSON.stringify(m.files)}`);
        assert.ok(!JSON.stringify(m).includes(NOTES.text), "the file's body reached that page inside another field");
    }
    // Both channels refused the one message, so the step list says so once per attempt; the last note is the panel's.
    const notes = fanned(bg, "agent-note").map((n) => n.text);
    assert.ok(notes.length > 0, "the person was not told, in the run's step list, that the file was not sent");
    assert.equal(notes.at(-1), `Your message was not sent: ${moved("notes.txt", "https://other.example")}`, `the step list does not name the file and where it would have gone: ${notes.at(-1)}`);
});

test("RED TEAM: a run's hash sent with ANOTHER tab's id sends no file to that tab's page", T, async () => {
    // The same defect with no navigation at all: the run's tab is untouched, and the message is AIMED at a tab that
    // built nothing. The text-only sibling still falls back to that page by ruling (page-built chats live there and
    // are not in `bgRuns`), so this row is the files only.
    const A2 = "https://builder.example/", C = "https://elsewhere.example/";
    const tab = { id: 7, url: A2, title: "Builder" };
    const other = { id: 9, url: C, title: "Elsewhere" };
    const bg = loadBackground({
        config, siteGate: true, local: { ml_site_always: ["https://builder.example", "https://elsewhere.example"] },
        openTabs: [tab, other],
        onFetch: (call) => call.url.includes("/chat/completions") ? jsonResponse({ choices: [{ message: { content: "ok" } }] }) : jsonResponse({}),
        onTabMessage: async (_t, msg) => (msg.type === "ADOPT_RUN_NOW" ? { pageInfo: "" } : msg.type === "RUN_TOOL_IN_PAGE" && msg.payload.finish ? { result: "" } : undefined),
    });
    await bg.send({ type: "START_RUN", payload: {
        runId: "pagebuilt5", task: "first", systemPrompt: "S", tools: [], model: "m", think: null, maxSteps: 2,
        autoApprovePython: false, autoApproveReadonly: false, surface: "off",
        rebuild: { toolNames: [], model: "m", driverSees: false, visionModel: null, groundingModel: null, groundingRange: 1000, pierceClosed: false, cdp: false, crossOrigin: true },
    } }, { tab: { id: 7, url: A2 }, url: A2 });
    await flush();
    const sent = await bg.send({ type: "USER_RUN_ACTION", payload: { hash: "pagebuilt5", action: "send", text: SECRET, files: [NOTES] } }, fromTab(9, C));
    assert.equal(sent.refused, moved("notes.txt", "https://elsewhere.example"), `the tab channel was not told the file is refused: ${JSON.stringify(sent)}`);
    void bg.send({ type: "ML_SESSION_REMOTE", tabId: 9, action: "send", hash: "pagebuilt5", text: SECRET, files: [NOTES], surface: "devtools" }, EXT);
    await flush();
    for (const [tid, m] of bg.tabMessages.filter(([, m]) => m.type === "ML_SESSION_TO_PAGE")) {
        assert.equal(m.files, undefined, `a file went to tab ${tid}, which built nothing: ${JSON.stringify(m.files)}`);
        assert.ok(!JSON.stringify(m).includes(NOTES.text), `the file's body reached tab ${tid} inside another field`);
    }
    assert.ok(fanned(bg, "agent-note").some((n) => String(n.text).includes(moved("notes.txt", "https://elsewhere.example"))), "the person was not told, in the run's step list, that the file was not sent");
});

test("RED TEAM: after the worker is evicted, a page-built run's file still cannot reach a page that did not build it", { todo: "open: a settled page-built run leaves no `ml_bgrun_*` snapshot, so a worker that has since been evicted holds no `tabId` for it and #1520's guard (`tabId != null`, src/sw/sw-run-start.ts:257-266) cannot fire: the file falls back to whatever page the tab shows" }, T, async () => {
    // MV3 evicts an idle worker, and the run then lives only in the page that built it. The person's follow-up wakes a
    // worker that knows nothing of the hash, so the refusal that holds before the eviction (the row above) has nothing
    // to consult. The same tab, the same message: only the worker's memory differs.
    const first = world();
    await pageBuild(first.bg, "pagebuilt6");
    const saved = JSON.parse(JSON.stringify(first.bg.localStore));
    assert.equal(Object.keys(saved).filter((k) => k.startsWith("ml_bgrun_")).length, 0, "a settled page-built run left a snapshot, so this row's premise changed");
    const second = world({ restore: saved });
    second.tab.url = B;
    const sent = await second.bg.send({ type: "USER_RUN_ACTION", payload: { hash: "pagebuilt6", action: "send", text: SECRET, files: [NOTES] } }, fromTab(7, B));
    assert.equal(sent.refused, moved("notes.txt", "https://other.example"), `the tab channel was not told the file is refused: ${JSON.stringify(sent)}`);
    void second.bg.send({ type: "ML_SESSION_REMOTE", tabId: 7, action: "send", hash: "pagebuilt6", text: SECRET, files: [NOTES], surface: "devtools" }, EXT);
    await flush();
    for (const [tid, m] of second.bg.tabMessages.filter(([, m]) => m.type === "ML_SESSION_TO_PAGE")) {
        assert.equal(m.files, undefined, `a file went to tab ${tid}, which built nothing: ${JSON.stringify(m.files)}`);
        assert.ok(!JSON.stringify(m).includes(NOTES.text), `the file's body reached tab ${tid} inside another field`);
    }
});

// --- the text half: the person's message reaches the run, never the page that did not build it (after #1316) ---

test("RED TEAM: a run a page built, its tab now on ANOTHER approved site, is driven by the worker: the text never reaches that page", { todo: "open: the page branch relays the person's text to whatever page the tab shows (`siteDecision(here)` in src/sw/sw-run-start.ts:266-282), so an approved site that did not build the run is handed it and drives the turn; the fix is the hand-over the first CONTROL shows" }, T, async () => {
    const { bg, tab } = world();
    await pageBuild(bg, "pagebuilt4");
    tab.url = B;
    // The tab channel first: `null` IS the relay, since the shell hands the message to the page when the worker
    // answers null. Then the panel channel, where the worker has to make the call itself.
    const sent = await bg.send({ type: "USER_RUN_ACTION", payload: { hash: "pagebuilt4", action: "send", text: SECRET } }, fromTab(7, B));
    assert.notEqual(sent.data, null, "the worker answered null, which tells the shell to hand the person's text to the page that did not build the run");
    void bg.send({ type: "ML_SESSION_REMOTE", tabId: 7, action: "send", hash: "pagebuilt4", text: SECRET, surface: "devtools" }, EXT);
    await flush();
    assert.ok(!toPage(bg).some((m) => JSON.stringify(m).includes(SECRET)), `the person's text reached a page that did not build the run: ${JSON.stringify(toPage(bg).map((m) => m.text))}`);
    assert.match(lastUser(bg), new RegExp(SECRET), "the message never reached the model: it was dropped rather than moved to the worker");
});
