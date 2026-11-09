// redteam-page-run-moved.test.mjs — what a PAGE must not get from a person's message to a run IT built, once its tab
// has navigated to another site that may use window.ml. One defect family, two halves (e3's second pass on #1492),
// fixed by the page route (#1555): the tab and site that built the session are recorded when it starts, from what the
// browser stamped (`sender.tab`, never the payload), and kept in chrome.storage.session, so the worker can say who the
// page is even after an eviction.
//
// A run a page built lives in the page: the worker's only way to deliver the person's message is the relay
// `ML_SESSION_TO_PAGE`, which goes to whatever page the tab shows NOW (`chrome.tabs.sendMessage(tabId, …)`). Before the
// route, the page it was sent to was chosen from the tab's CURRENT origin (`siteDecision(here)`), where the run's
// BUILDER origin is the one that matters. `pageRouteFor` (src/sw/page-route.ts) now answers one question both channels
// ask — may THIS tab's page frame it? — and the four shapes the family had are all rows below:
//
//   - FILES, navigated: a text file went to the page whole, so its body reached a site that never built the run. Now the
//     worker takes the run over and keeps the file itself; the row asserts the message was DELIVERED by the worker (the
//     model saw it), so a fix that dropped it cannot pass.
//   - FILES, aimed: the message came with ANOTHER tab's id, so no page built the session (flaky-ci, review 6719096527).
//     Now no page may frame it and the worker holds no run for the hash, so the whole message is refused with PAGE_GONE;
//     the text-only sibling of this shape is covered by the same refusal.
//   - FILES, evicted: a settled page-built run leaves no `ml_bgrun_*` snapshot (`tests/nav-handover.test.mjs` pins it), so
//     an evicted worker knows no tabId for it. It does know the builder, from storage.session, and refuses the same way.
//     The row restores the session store beside the local one, which is what an eviction leaves behind.
//   - TEXT: the person's typed message was relayed the same way, and is what the run is then driven BY. Now the worker
//     drives the turn and no page carries it.
//
// Every row was measured against a weakened guard. The four message rows against `pageRouteFor` answering "page" for
// anything: all four go red and the controls stay green. The builder-record row against the site check removed from
// `gatePageTurn` (sw-start-approval.ts): the moved tab's start then succeeds and the other site's text is delivered to
// the turn the builder site started.
//
// The instrument is the worker's own behaviour, not a guess at the shell's: `ML_SESSION_TO_PAGE` is the relay (its
// payload is what the page would receive), and `USER_RUN_ACTION` answering `null` is the worker telling the SHELL to
// hand the message to the page — the tab channel's relay happens there, where the worker cannot see it. Every row
// therefore also asserts on the panel channel (ML_SESSION_REMOTE), which both trusts and exercises the worker alone.
//
// The controls are the two sides of each: a tab still on its builder's origin relays (so a row asserting "nothing
// reached the page" cannot pass by the relay being dead), and a tab on a site that may NOT use window.ml is already
// driven by the worker (the shape the fix extends to an approved site that did not build the run). The last control is
// the measurement the whole fix's reasoning rests on: a SUBFRAME cannot build a run at all (`only a page's top frame can use window.ml`,
// src/site-access.ts), so a page-built run's builder origin is always its tab's top-frame origin, and "the tab still
// shows the builder's origin" is a complete test.
import { test } from "node:test";
import assert from "node:assert/strict";
import { IDBFactory } from "fake-indexeddb";
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
/** The sentence a message is refused with when no page may frame it and the worker does not hold the session
 *  (`PAGE_GONE`, src/sw/page-route.ts). It names no site, so it is the same wherever the message came from. */
const GONE = "The page that started this conversation is no longer open in this tab, so this message was not sent.";

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
 * `chrome.storage.local` a worker wakes up on, which is how an eviction is played; `session` the same for
 * `chrome.storage.session`, where the builder record lives. `store` gives the worker a real value store, so a message
 * the worker took over can keep its file instead of refusing it for want of one.
 * @param {{approvedB?: boolean, restore?: Record<string, unknown>, session?: Record<string, unknown>, store?: unknown}} [o]
 */
function world({ approvedB = true, restore, session, store } = {}) {
    const tab = { id: 7, url: A, title: "Builder" };
    const bg = loadBackground({
        config, siteGate: true, session: session ?? {},
        local: { ml_site_always: ["https://builder.example", ...(approvedB ? ["https://other.example"] : [])], ...(restore ?? {}) },
        ...(store ? { indexedDB: store } : {}),
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

test("RED TEAM: a run a page built, its tab now on ANOTHER approved site, sends no file to that page and the worker keeps it", T, async () => {
    // The worker has a value store here, as it does in production: the run is handed to the worker, which is where the
    // file goes. Without one the same routing refuses the file for want of a store (measured), which is a fact about
    // this harness and not about the page getting it.
    const { bg, tab } = world({ store: new IDBFactory() });
    await pageBuild(bg, "pagebuilt3");
    assert.equal(bg.tabMessages.filter(([, m]) => m.type === "ML_SESSION_TO_PAGE").length, 0, "the page's own start already relayed something");
    tab.url = B;
    // Both channels: the tab's shell (a non-null answer means the worker drove it, so it does not relay) and the panel.
    const sent = await bg.send({ type: "USER_RUN_ACTION", payload: { hash: "pagebuilt3", action: "send", text: SECRET, files: [NOTES] } }, fromTab(7, B));
    assert.notEqual(sent.data, null, `the worker handed the message to the page that did not build the run: ${JSON.stringify(sent)}`);
    assert.ok(!sent.refused, `the worker refused the file instead of taking it: ${JSON.stringify(sent)}`);
    void bg.send({ type: "ML_SESSION_REMOTE", tabId: 7, action: "send", hash: "pagebuilt3", text: SECRET, files: [NOTES], surface: "devtools" }, EXT);
    await flush();
    const relays = toPage(bg);
    for (const m of relays) {
        assert.equal(m.files, undefined, `a file went to the site that did not build the run: ${JSON.stringify(m.files)}`);
        assert.ok(!JSON.stringify(m).includes(NOTES.text), "the file's body reached that page inside another field");
    }
    // The message really was delivered, by the worker: a dropped message would satisfy every assertion above.
    assert.match(lastUser(bg), new RegExp(SECRET), "the person's message never reached the model: it was dropped, not moved to the worker");
    assert.equal(fanned(bg, "agent-note").filter((n) => /not sent/i.test(String(n.text))).length, 0, "the person was told the message was not sent, so the run was not taken over");
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
    // Aimed at a tab that built nothing: no page may frame it and the worker holds no run for the hash, so the whole
    // message is refused rather than handed to that tab's page (src/sw/sw-run-start.ts `userRunAction`).
    assert.equal(sent.refused, GONE, `the tab channel was not told the message is refused: ${JSON.stringify(sent)}`);
    void bg.send({ type: "ML_SESSION_REMOTE", tabId: 9, action: "send", hash: "pagebuilt5", text: SECRET, files: [NOTES], surface: "devtools" }, EXT);
    await flush();
    for (const [tid, m] of bg.tabMessages.filter(([, m]) => m.type === "ML_SESSION_TO_PAGE")) {
        assert.equal(m.files, undefined, `a file went to tab ${tid}, which built nothing: ${JSON.stringify(m.files)}`);
        assert.ok(!JSON.stringify(m).includes(NOTES.text), `the file's body reached tab ${tid} inside another field`);
    }
    assert.ok(fanned(bg, "agent-note").some((n) => String(n.text).includes(GONE)), `the person was not told, in the run's step list, that the message was not sent: ${JSON.stringify(fanned(bg, "agent-note").map((n) => n.text))}`);
});

test("RED TEAM: after the worker is evicted, a page-built run's file still cannot reach a page that did not build it", T, async () => {
    // MV3 evicts an idle worker, and the run then lives only in the page that built it. The person's follow-up wakes a
    // worker that knows nothing of the hash — but the builder record is in chrome.storage.session, which survives an
    // eviction (only a browser restart loses it), so the woken worker still knows who built the run and refuses.
    const first = world();
    await pageBuild(first.bg, "pagebuilt6");
    await flush();
    const saved = JSON.parse(JSON.stringify(first.bg.localStore));
    const savedSession = JSON.parse(JSON.stringify(first.bg.sessionStore));
    assert.equal(Object.keys(saved).filter((k) => k.startsWith("ml_bgrun_")).length, 0, "a settled page-built run left a snapshot, so this row's premise changed");
    assert.ok(Object.keys(savedSession.ml_pagebuilt ?? {}).includes("pagebuilt6"), `the builder record is not in session storage, so the woken worker could not know it: ${JSON.stringify(savedSession)}`);
    const second = world({ restore: saved, session: savedSession });
    second.tab.url = B;
    const sent = await second.bg.send({ type: "USER_RUN_ACTION", payload: { hash: "pagebuilt6", action: "send", text: SECRET, files: [NOTES] } }, fromTab(7, B));
    assert.equal(sent.refused, GONE, `the tab channel was not told the message is refused: ${JSON.stringify(sent)}`);
    void second.bg.send({ type: "ML_SESSION_REMOTE", tabId: 7, action: "send", hash: "pagebuilt6", text: SECRET, files: [NOTES], surface: "devtools" }, EXT);
    await flush();
    for (const [tid, m] of second.bg.tabMessages.filter(([, m]) => m.type === "ML_SESSION_TO_PAGE")) {
        assert.equal(m.files, undefined, `a file went to tab ${tid}, which built nothing: ${JSON.stringify(m.files)}`);
        assert.ok(!JSON.stringify(m).includes(NOTES.text), `the file's body reached tab ${tid} inside another field`);
    }
});

// --- the builder record: a page may start under a hash of its own, never another tab's or site's ---

test("RED TEAM: a hash another tab or another site started cannot be started again, so no page can repoint its builder", T, async () => {
    // A page NAMES the hash its run starts under (`p.runId`, sw-run-host.ts), so the record is only safe if a hash that
    // already belongs to a tab or a site is refused: the approval record carries both, and `gatePageTurn` refuses a
    // mismatch before anything is recorded. The control is a page's own fresh hash, which IS accepted and recorded
    // against that site, so the row cannot pass by every start being refused. Measured: with the site check removed,
    // the moved tab's start succeeds and the other site's message is the run's next turn.
    const tabA = { id: 7, url: A, title: "Builder" };
    const tabB = { id: 9, url: B, title: "Other" };
    const bg = loadBackground({
        config, siteGate: true,
        local: { ml_site_always: ["https://builder.example", "https://other.example"] },
        openTabs: [tabA, tabB],
        onFetch: (call) => call.url.includes("/chat/completions") ? jsonResponse({ choices: [{ message: { content: "ok" } }] }) : jsonResponse({}),
        onTabMessage: async (_t, msg) => (msg.type === "ADOPT_RUN_NOW" ? { pageInfo: "" } : msg.type === "RUN_TOOL_IN_PAGE" && msg.payload.finish ? { result: "" } : undefined),
    });
    /** A page's START_RUN asking for `runId`, sent from tab `tabId` while it shows `url`. */
    const startAs = (runId, tabId, url) => bg.send({ type: "START_RUN", payload: {
        runId, task: "second", systemPrompt: "S", tools: [], model: "m", think: null, maxSteps: 2,
        autoApprovePython: false, autoApproveReadonly: false, surface: "off",
        rebuild: { toolNames: [], model: "m", driverSees: false, visionModel: null, groundingModel: null, groundingRange: 1000, pierceClosed: false, cdp: false, crossOrigin: true },
    } }, fromTab(tabId, url));
    await pageBuild(bg, "pagebuilt7");
    await flush();
    const before = JSON.parse(JSON.stringify(bg.sessionStore.ml_pagebuilt ?? {}));
    assert.equal(before.pagebuilt7?.origin, "https://builder.example", `the page's own start recorded no builder: ${JSON.stringify(before)}`);
    // Another tab, on another approved site, asking for the recorded hash.
    const elsewhere = await startAs("pagebuilt7", 9, B);
    assert.match(String(elsewhere.error), /belongs to another tab/i, `another tab was allowed to start the run under its hash: ${JSON.stringify(elsewhere)}`);
    // The SAME tab, now on the other site (the moved tab), asking for the hash it built.
    const sameTab = await startAs("pagebuilt7", 7, B);
    assert.match(String(sameTab.error), /started by another site/i, `the moved tab was allowed to start the run under its hash: ${JSON.stringify(sameTab)}`);
    const after = JSON.parse(JSON.stringify(bg.sessionStore.ml_pagebuilt ?? {}));
    assert.deepEqual(after.pagebuilt7, before.pagebuilt7, `a page's start repointed the recorded builder: ${JSON.stringify(after.pagebuilt7)}`);
    // The control: a hash no one has started is the page's, and its builder is the site that started it.
    const own = await startAs("freshHash1", 9, B);
    assert.ok(!own.error, `a page could not start a run under a hash of its own, so nothing above proves a page's hash is refused: ${JSON.stringify(own)}`);
    const grown = JSON.parse(JSON.stringify(bg.sessionStore.ml_pagebuilt ?? {}));
    assert.equal(grown.freshHash1?.origin, "https://other.example", `a page's own start was not recorded against it: ${JSON.stringify(grown.freshHash1)}`);
    // Every other page-started type, with every field a handler might read a session out of, aimed at the recorded hash.
    // Enumerated from the module, not a copy of it; the record must not move.
    const { HANDLE_MAP } = await import("../src/page-relay.ts");
    // A few types answer on a Port or not at all; the row is about the record, so a non-answer is not waited on.
    const settles = (p) => Promise.race([p.then(() => undefined, () => undefined), new Promise((r) => setTimeout(r, 60))]);
    for (const type of Object.keys(HANDLE_MAP)) {
        await settles(bg.send({ type, payload: {
            hash: "pagebuilt7", runId: "pagebuilt7", id: "pagebuilt7", session: "pagebuilt7", tabId: 9, kind: "run",
            tab: { id: 9, url: B }, url: B, origin: "https://other.example", prompt: "x", task: "x", messages: [],
        } }, fromTab(9, B)));
        await flush(2);
    }
    await flush();
    const final = JSON.parse(JSON.stringify(bg.sessionStore.ml_pagebuilt ?? {}));
    assert.deepEqual(final.pagebuilt7, before.pagebuilt7, "a page-started message rewrote the recorded builder");
});

// --- the text half: the person's message reaches the run, never the page that did not build it (after #1316) ---

test("RED TEAM: a run a page built, its tab now on ANOTHER approved site, is driven by the worker: the text never reaches that page", T, async () => {
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
