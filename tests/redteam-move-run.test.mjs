// redteam-move-run.test.mjs — a page can never move a run to another tab (docs/spec/MOVE_RUN.md, "Security"; e3's row).
//
// The move between turns is built at this head (8c42870c): the type is `MOVE_RUN`, payload `{ runId }`, destination
// always the sender's OWN tab, `isExtensionSender` only, settled runs only (MOVE_RUN.md, shape (a); src/sw/move-run.ts).
// The rows that predate it are stated over the ENUMERATION rather than that type's handling, so each holds for every
// member of it and stays honest as the table grows:
//
//   A. the relay's tables (page-relay.ts) hold no move-shaped type, so no page can have one relayed — enumerated, not
//      a guessed name list; the day the type is added to HANDLE_MAP / PAGE_RELAYED_EXTRA, this row goes red;
//   B. every type a page CAN start, driven from a page that is approved to use window.ml, moves nothing: the run's next
//      turn is still hosted on its own tab and nothing is sent to the destination tab. This is the behavioural half, and
//      it is name-free: when the move's type lands it is in one of these sets and this row drives it;
//   C. nothing a page can CAUSE to be sent carries a move: a post on the page's own window relays nothing at all (the
//      page channel), and every move-shaped type injected.js could post — the surface `window.ml` members use — relays
//      nothing and answers nothing, while no `ml.*` member moves a run.
//
// D and E pin what the build made reachable: D is the worker's sender check on the real handler (`isExtensionSender`,
// per the spec) and the destination being the SENDER's tab; E is the second caller the spec admits, `session.resume`
// reaching `adoptSession` for a run the worker already holds on another tab — a BOOKKEPT move (one `bgRuns` entry, a
// run-log `tab`/`moved` record naming both ids, never a second host), with E2 pinning what a resume on the SAME tab does
// (a resume, no record) and that a plain RESUME_RUN from a frame in another tab is refused, which is why the second
// caller is the session-command layer. A page's half of E is B's: RESUME_RUN is one of the page-startable types B
// drives with a destination in its payload, and the run does not move.
//
// MUTATION PER ROW (notes, not committed changes — apply one, watch its row go red, revert; D and E measured at
// 8c42870c, each followed by a build, clean 6/6 before and after):
//   D measured: the handler's `!isExtensionSender(sender) ||` term removed, the rest of the condition kept → B and D red
//      (2.0 s each; the enumeration row drives the type too, so one removed check reds the behavioural half as well).
//   E measured: `adoptSession`'s `if (held && held.tabId !== tabId)` → `if (false)` → E red (138 ms), every other row and
//      E2 green.
//   A  `HANDLE_MAP.MOVE_RUN_REQUEST = { type: "MOVE_RUN", responseType: "MOVE_RUN_RESPONSE" }` → A red.
//   B  in background.ts's route(), `if (message.type === "MOVE_RUN") { bgRuns.get(p.runId).tabId = p.senderTabId; }` for
//      any sender, reached by a page-started type → B red (the continued turn is sent to the destination tab).
//   C  `window.ml.moveRun = (runId) => makeBackgroundTaskPromise("MOVE_RUN_REQUEST", "MOVE_RUN_RESPONSE", { runId })`
//      in injected.ts, with the HANDLE_MAP entry → C red (the page's own `ml` member posts a type the relay forwards).
//   D  the handler's sender check `if (!isExtensionSender(sender))` → `if (false)` → D red (a tab sender's MOVE_RUN moves
//      the run).
//   E  `adoptSession`'s held-elsewhere branch goes back to hosting the run on the resumed tab instead of calling
//      `moveRun` → E red (two hosts, and no `tab` record in the run log).
import { test } from "node:test";
import assert from "node:assert";
import { createRequire } from "node:module";
import { IDBFactory } from "fake-indexeddb";

const require = createRequire(import.meta.url);
const { jsonResponse, loadBackground, loadPageWorld } = require("./helpers");
const { HANDLE_MAP, PAGE_STARTED_TYPES, PAGE_RELAYED_EXTRA, PAGE_UNGATED_TYPES, RUN_CONTROL_TYPES } = require("../src/page-relay.ts");

const SITE_URL = "https://site.example/page";
const HOME = 7;          // where the run is
const ELSEWHERE = 8;     // the tab a hostile page would move it to
const T = { timeout: 30000 };
const tick = () => new Promise((r) => setTimeout(r, 0));
/** Waits until `done()` holds, for at most `cap` macrotasks. */
async function until(done, cap = 4000) { for (let i = 0; i < cap && !done(); i++) await tick(); return done(); }

/** The names a move would plausibly have, so a page's post of one is driven even before the type exists. */
const MOVE_WORDS = /MOVE|BRING|REHOME|TRANSFER|HANDOVER/i;
const GUESSES = ["MOVE_RUN", "MOVE_RUN_REQUEST", "MOVE_SESSION", "MOVE_SESSION_REQUEST", "BRING_SESSION", "BRING_SESSION_REQUEST", "SESSION_MOVE", "REHOME_RUN", "RUN_TO_TAB"];
/** Every type a page can cause the content script to send, the guessed move names beside them. */
const PAGE_TYPES = [...new Set([...Object.keys(HANDLE_MAP), ...Object.values(HANDLE_MAP).map((e) => e.type), ...PAGE_RELAYED_EXTRA, ...PAGE_UNGATED_TYPES])];

// --- A. the relay's tables hold no move-shaped type ---

test("no message type that moves a run exists in the relay's tables, under any name a careful lane would pick", () => {
    const all = [...new Set([...PAGE_TYPES, ...Object.values(HANDLE_MAP).map((e) => e.responseType), ...RUN_CONTROL_TYPES])];
    const shaped = all.filter((t) => MOVE_WORDS.test(t));
    assert.deepEqual(shaped, [], `a move-shaped type is page-reachable: ${shaped.join(", ")}. A move is started only by the person (MOVE_RUN.md, "Security").`);
    // Control: the enumeration is not empty and holds the types it should, so the filter above is not matching nothing
    // because the tables were read wrong.
    assert.ok(all.includes("CONFIG_REQUEST") && all.includes("START_RUN"), "the tables read as an unrelated set");
    assert.ok(PAGE_STARTED_TYPES.has("START_RUN") && PAGE_STARTED_TYPES.has("PAGE_CANCEL_RUN"), "PAGE_STARTED_TYPES is not the union it claims to be");
});

// --- C. a page's own post relays nothing, and no ml.* member moves a run ---

test("a page's post of a move-shaped request is answered with nothing and relays nothing, and window.ml has no member that moves a run", async () => {
    const world = loadPageWorld({ onRuntimeMessage: () => ({ data: null }) });
    const boot = world.runtimeCalls.length;
    const page = world.context.window;
    const RUN = "a".repeat(64);
    // (i) the page's own post. It speaks on `window`, which the page channel does not forward to either end, so this
    // half is the page-gate's property: nothing a page posts becomes a runtime message, move-shaped or not.
    page.postMessage({ type: "MOVE_RUN", requestId: "m1", payload: { runId: RUN, toTabId: ELSEWHERE } });
    page.postMessage({ type: "CONFIG_REQUEST", requestId: "m2", payload: { MOVE_RUN: RUN } });
    // (ii) what `window.ml` COULD post: injected.js's own end of the channel. This is the surface a page reaches by
    // calling a member, so a move-shaped type here is a move a page can cause, not a page's raw post.
    for (const type of [...GUESSES, "MOVE_RUN", "LIST_BRINGABLE"]) {
        world.asInjected({ type, requestId: `i-${type}`, payload: { runId: RUN, toTabId: ELSEWHERE } });
    }
    assert.deepEqual(world.runtimeCalls.slice(boot).map((c) => c.type), [], "a page's move-shaped message reached the worker");
    // No member moves a run. The global must exist first, or the check is about an absent object.
    assert.equal(typeof world.ml, "object", "window.ml was not defined, so no member check could mean anything");
    assert.equal(typeof world.ml.chat, "function", "positive control: window.ml has no member the enumeration can see");
    for (const name of ["moveRun", "move", "bringSession", "moveToTab", "rehomeRun", "moveSession"]) {
        assert.equal(name in world.ml, false, `window.ml.${name} exists: a page can start a move`);
    }
    // Control: the SAME injected end relays an honest request, so the emptiness above is the relay refusing, not the
    // world dead. (`asInjected` is what a page calling `ml.fetch`/`ml.chat` posts.)
    world.asInjected({ type: "CONFIG_REQUEST", requestId: "ok", payload: {} });
    assert.ok(await until(() => world.runtimeCalls.slice(boot).some((c) => c.type === "GET_CONFIG"), 200), "positive control: CONFIG_REQUEST relays");
});

// --- B. every type a page can start, driven from an APPROVED page, moves nothing ---

/**
 * A worker-built run on tab 7 whose model asks the page to `exec` on its first two calls and on every call after the
 * third, so the run is visible on its tab before and after a `continue` (the third call is the turn's ending). Every
 * `exec` is approved from the page's own tab, as a person at the HUD would. `bg.tabMessages` records `[tabId, message]`
 * for every delegated message, which is how a move shows: the turn after it would be hosted on the destination.
 */
async function harness({ keep = false } = {}) {
    let n = 0, bg;
    bg = loadBackground({
        config: { chatUrl: "http://host/api/chat/completions", apiKey: "sk-test-0123456789abcdef", model: "m", apiFormat: "openai", debugMode: "off" },
        ...(keep ? { indexedDB: new IDBFactory() } : {}),
        openTabs: [{ id: HOME, windowId: 3, active: true, url: SITE_URL, title: "Site" }, { id: ELSEWHERE, windowId: 3, active: false, url: SITE_URL, title: "Elsewhere" }],
        onFetch: async (call) => {
            if (call.url.endsWith("/api/models")) return jsonResponse({ data: [{ id: "m" }] });
            if (!call.url.includes("/chat/completions")) return jsonResponse({});
            const k = n++;
            const step = k === 2 ? null : { name: "exec", args: { js: "document.body.remove()" } };
            if (!step) return jsonResponse({ choices: [{ message: { content: "done" } }] });
            return jsonResponse({ choices: [{ message: { content: null, tool_calls: [{ id: `c${k}`, type: "function", function: { name: step.name, arguments: JSON.stringify(step.args) } }] } }] });
        },
        onTabMessage: async (t, msg) => {
            if (msg.type === "ADOPT_RUN_NOW") return { pageInfo: "" };
            if (msg.type === "ML_DEBUG_TO_PAGE" && msg.event?.awaitingApproval) void bg.send({ type: "SET_APPROVAL", payload: { runId: msg.event.id, seq: msg.event.seq, decision: true } }, { tab: { id: t, url: SITE_URL }, url: SITE_URL, origin: "https://site.example" });
            if (msg.type !== "RUN_TOOL_IN_PAGE") return undefined;
            if (msg.payload.finish || msg.payload.renderOnly || msg.payload.precheck || msg.payload.readonlyTry) return {};
            return { result: "ran" };
        },
    });
    bg.commit?.(HOME, { documentId: "doc-1", url: SITE_URL });
    const { hash } = await bg.context.__mlStartUserRunForTest(HOME, { task: "probe", surface: "hud", maxSteps: 5 });
    // A resume reads the session's HISTORY, which is written when a turn ends, so the session has to be kept while the
    // first turn is still running (as a person's saved session is).
    if (keep) bg.context.__mlKeepSessionForTest(hash);
    const ended = (id = hash) => bg.tabMessages.map((a) => a[1]).find((m) => m?.type === "ML_DEBUG_TO_PAGE" && m.event?.kind === "agent-result" && m.event.id === id)?.event;
    const toolsOn = (tab) => bg.tabMessages.filter(([t, m]) => t === tab && m?.type === "RUN_TOOL_IN_PAGE").length;
    const runLog = async () => await bg.context.__mlRunLog.all();
    return { bg, hash, ended, toolsOn, runLog };
}

/** `p`, or `{ pending: true }` after `ms`: one handler a move-shaped payload makes slow must not spend the row's timeout. */
const within = (p, ms = 2000) => Promise.race([p.then((r) => r, (e) => ({ error: String(e) })), new Promise((r) => setTimeout(() => r({ pending: true }), ms))]);

/** A session command as the sidebar, the chat page and a hub send it: the extension pages' `ml-sessions` port. */
async function command(bg, cmd) {
    const port = bg.connect("ml-sessions", { url: "chrome-extension://test/chat.html" });
    port.send({ type: "cmd", id: 1, command: cmd });
    assert.ok(await until(() => port.messages.some((m) => m.id === 1 && m.type !== "index"), 2000), "the command is answered");
    return port.messages.find((m) => m.id === 1 && m.type !== "index");
}

test("every type a page can start, sent from a page approved to use window.ml with a run id and a destination tab, moves the run nowhere", T, async () => {
    const { bg, hash, ended, toolsOn } = await harness();
    assert.ok(await until(() => ended(), 4000), "the first turn ends");
    // A page that may use window.ml: the gate admits it, so nothing here is refused by ORIGIN.
    const pageOn = { tab: { id: HOME, url: SITE_URL }, url: SITE_URL, origin: "https://site.example", frameId: 0 };
    const before = toolsOn(ELSEWHERE);
    // Every page-startable type and every guessed move name, with a move's payload and bare. Concurrently: each send is
    // an independent router entry, and a page-startable handler a move-shaped payload makes slow would otherwise sum.
    const payload = { runId: hash, toTabId: ELSEWHERE, tabId: ELSEWHERE, id: hash, task: "move", action: "move", reason: "move" };
    const answers = await Promise.all([...PAGE_TYPES, ...GUESSES].flatMap((type) => [
        within(bg.send({ type, payload }, pageOn)).then((r) => [type, r]),
        within(bg.send({ type }, pageOn)).then((r) => [type, r]),
    ]));
    // A moved run's NEXT turn is hosted on the destination; that is what a move between turns changes for the person.
    const atHome = toolsOn(HOME);
    await bg.context.__mlUserRunActionForTest(hash, "continue", { text: "carry on" });
    assert.ok(await until(() => toolsOn(HOME) > atHome, 4000), "control: the run's continued turn is hosted on its own tab");
    assert.equal(toolsOn(ELSEWHERE), before, `the run was moved: ${toolsOn(ELSEWHERE) - before} message(s) reached tab ${ELSEWHERE} after a page's message`);
    // Nothing a page sent was answered as a SUCCESS either: an answer carrying data is the worker saying a move landed.
    const moveish = answers.filter(([t]) => MOVE_WORDS.test(t));
    assert.deepEqual(moveish.filter(([, r]) => r && typeof r === "object" && "data" in r && r.data), [], "a page's move-shaped message was answered with data");
    // And the worker still holds the run where it was.
    const state = bg.context.__mlRunStateForTest();
    assert.ok(state.bgRuns.includes(hash) || state.inboxes.includes(hash) || state.activeRuns.some(([t, ids]) => t === HOME && ids.includes(hash)), `the run left tab ${HOME}: ${JSON.stringify(state.activeRuns)}`);
    assert.deepEqual(state.activeRuns.filter(([t]) => t === ELSEWHERE), [], "the run is tracked under the destination tab");
});

// --- D. the move's own sender check, once the type exists ---

test("the move type refuses a tab sender and admits only the person's extension surfaces, on a settled run (MOVE_RUN.md, \"Security\")", { timeout: 60000 }, async () => {
    const { bg, hash, ended, toolsOn } = await harness();
    // The move works on a SETTLED run (the lane's rule): a run mid-turn is refused for that reason, which is not this row.
    assert.ok(await until(() => ended(), 4000), "the run did not settle");
    const pageOn = { tab: { id: HOME, url: SITE_URL }, url: SITE_URL, origin: "https://site.example", frameId: 0 };
    const hudOn = { tab: { id: ELSEWHERE, url: SITE_URL }, url: "chrome-extension://test/sidebar.html", frameId: 1 };
    const types = [...new Set(["MOVE_RUN", ...PAGE_TYPES, ...GUESSES])].filter((t) => MOVE_WORDS.test(t));
    assert.ok(types.length > 0, "no move-shaped type exists in the worker's tables: nothing to judge");
    // `{ runId }` only: the destination is the SENDER's tab, never one the message names — so a payload that DOES name
    // one is sent too, and the page's half is driven with it.
    const payload = { runId: hash, toTabId: ELSEWHERE };
    // Every move-shaped name, from a page: none is admitted. A name the worker does not handle is not answered at all
    // (`pending`), which is a refusal like any other for this question — nothing a page sends moves the run.
    const answers = await Promise.all(types.map((type) => within(bg.send({ type, payload }, pageOn)).then((r) => [type, r])));
    for (const [type, r] of answers) {
        assert.notEqual(r?.data, true, `${type} admitted a tab sender: ${JSON.stringify(r)}`);
        if (!r?.pending) assert.match(String(r?.error ?? ""), /refus/i, `${type} answered a tab sender without refusing it: ${JSON.stringify(r)}`);
    }
    assert.equal(toolsOn(ELSEWHERE), 0, "a page's move-shaped message put the run on the destination tab");
    // Control, the other half: the type the spec DOES have, sent from the person's own surface, is admitted — and the run
    // lands on the HUD's own tab (ELSEWHERE), because the destination is the sender's tab and never the payload's.
    const fromHud = await within(bg.send({ type: "MOVE_RUN", payload }, hudOn), 8000);
    assert.equal(fromHud?.error, undefined, `the person's MOVE_RUN was refused: ${JSON.stringify(fromHud)}`);
    assert.equal(fromHud?.data, true, `the person's MOVE_RUN did not answer done: ${JSON.stringify(fromHud)}`);
    const atDest = toolsOn(ELSEWHERE);
    await bg.context.__mlUserRunActionForTest(hash, "continue", { text: "carry on" });
    assert.ok(await until(() => toolsOn(ELSEWHERE) > atDest, 4000), "the moved run's next turn is not hosted on the tab the HUD sent from");
    const state = bg.context.__mlRunStateForTest();
    assert.equal(state.bgRuns.filter((h) => h === hash).length, 1, `the moved run is ${state.bgRuns.filter((h) => h === hash).length} hosts: ${JSON.stringify(state.bgRuns)}`);
});

// --- E. the second caller: `session.resume` for a run the worker holds on ANOTHER tab is a bookkept move, and a resume
// on the tab it is already on stays a resume. The caller is reached only through the
// extension pages' `ml-sessions` port, never through `RESUME_RUN`: a plain RESUME_RUN from a frame in another tab is
// refused by `hostRun` ("belongs to another tab"), which E2 asserts as the boundary, since that refusal is the whole
// reason the move cannot be entered through it. A PAGE's half of this caller is row B's: RESUME_RUN is one of the types
// B drives from an approved page and the run does not move.

/** A settled run whose session was kept, so `session.resume` has a history to read (the history is written at tally). */
async function kept() {
    const r = await harness({ keep: true });
    assert.ok(await until(() => r.ended(), 4000), "the run did not settle");
    await new Promise((res) => setTimeout(res, 100));   // the turn's end writes the history the resume reads
    return r;
}
const movedRecords = async (r) => (await r.runLog()).filter((e) => e.run === r.hash && e.subsystem === "tab" && e.kind === "moved");

test("a resume of a run the worker holds on another tab is a bookkept move: one host, one `tab`/`moved` record naming both ids, the model told", { timeout: 60000 }, async () => {
    const r = await kept();
    const before = r.toolsOn(ELSEWHERE);
    const res = await command(r.bg, { type: "session.resume", session: { runtime: "local", hash: r.hash }, target: { kind: "tab", tabId: ELSEWHERE } });
    assert.equal(res?.result?.ok, true, `the resume was refused: ${JSON.stringify(res)}`);
    // One host: the run is ONE bgRuns entry, and it is no longer tracked under the tab it came from.
    const state = r.bg.context.__mlRunStateForTest();
    assert.equal(state.bgRuns.filter((h) => h === r.hash).length, 1, `${state.bgRuns.filter((h) => h === r.hash).length} hosts for one run`);
    assert.deepEqual(state.activeRuns.filter(([t]) => t === HOME), [], "the resumed run is still hosted on the tab it came from");
    // Bookkept: exactly one move record, naming the two ids.
    const moved = await movedRecords(r);
    assert.equal(moved.length, 1, `the move left ${moved.length} \`tab\`/\`moved\` records`);
    assert.deepEqual([moved[0].detail?.from, moved[0].detail?.to], [HOME, ELSEWHERE], `the record does not name the two tabs: ${JSON.stringify(moved[0])}`);
    // And the continued turn is the new tab's, with the model told it was moved (a system note, not the person's words).
    const since = r.bg.tabMessages.length;
    await r.bg.context.__mlUserRunActionForTest(r.hash, "continue", { text: "carry on" });
    assert.ok(await until(() => r.toolsOn(ELSEWHERE) > before, 4000), "the moved run's next turn is not hosted on the tab it was resumed on");
    const after = r.bg.tabMessages.slice(since);
    assert.deepEqual(after.filter(([t]) => t === HOME).map(([, m]) => m?.type), [], "something of the turn went to the old tab");
    const body = r.bg.calls.filter((c) => c.url.includes("/chat/completions")).at(-1)?.body;
    const notes = (body?.messages ?? []).filter((m) => m.role === "system" && /moved this run/.test(String(m.content)));
    assert.equal(notes.length, 1, `the model was told ${notes.length} times: ${JSON.stringify((body?.messages ?? []).map((m) => m.role))}`);
});

test("a resume of a held run on the tab it is already on stays a resume, and a plain RESUME_RUN from another tab is refused and moves nothing", { timeout: 60000 }, async () => {
    const r = await kept();
    // (i) The same tab: no move, no record — the coordinator's condition.
    const same = await command(r.bg, { type: "session.resume", session: { runtime: "local", hash: r.hash }, target: { kind: "tab", tabId: HOME } });
    assert.equal(same?.result?.ok, true, `the same-tab resume was refused: ${JSON.stringify(same)}`);
    assert.deepEqual(await movedRecords(r), [], "a resume on the tab the run was already on recorded a move");
    // (ii) The boundary of the second caller: a plain RESUME_RUN from a frame in another tab is refused, and the run
    // does not appear there. This is why the move needs the session-command layer rather than a message.
    const elsewhereHud = { tab: { id: ELSEWHERE, url: SITE_URL }, url: "chrome-extension://test/sidebar.html", frameId: 1 };
    const refused = await within(r.bg.send({ type: "RESUME_RUN", payload: { runId: r.hash, task: "" } }, elsewhereHud), 4000);
    assert.equal(refused?.data, undefined, `a RESUME_RUN from another tab was answered with data: ${JSON.stringify(refused)}`);
    assert.deepEqual(await movedRecords(r), [], "a plain RESUME_RUN from another tab recorded a move");
    assert.equal(r.toolsOn(ELSEWHERE), 0, "a plain RESUME_RUN from another tab hosted the run there");
});
