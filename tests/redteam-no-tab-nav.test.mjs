// redteam-no-tab-nav.test.mjs — what a `navigate` from a run with NO tab (docs/spec/TABLESS_RUN.md, "`navigate` from the
// detached state"; src/sw/no-tab-nav.ts) must not give a page or the model: a tab at a site the card did not name, a tab
// opened before the person answered, a message of the run's to the new tab before the run moved onto it, or a site other
// than the one it approved. Every row is a worker-built run with no tab in the real bundle (`dist/background.js` in
// node:vm, tests/helpers.js `loadBackground`), the chat page by the `ml-sessions` port, the model by `script`.
//
// The hazard throughout is the two-step shape: the card is drawn from one string and the tab is opened from another, and
// the run then takes whatever page the tab lands on. Every row below turns one of those three into a claim. The last row
// is # open: it asserts the defect, so this file fails until the redirect case is decided (see its comment).

import { test } from "node:test";
import assert from "node:assert";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { jsonResponse, loadBackground } = require("./helpers");

const NEWS = "https://news.example/today";
const PAGE = { url: "chrome-extension://test/sidebar/chat.html" };
const T = { timeout: 30000 };
const tick = () => new Promise((r) => setTimeout(r, 0));
/** Waits until `done()` holds, for at most `cap` macrotasks. */
async function until(done, cap = 4000) { for (let i = 0; i < cap && !done(); i++) await tick(); return done(); }
const exec = { name: "exec", args: { js: "document.body.remove()" } };
const nav = (url) => ({ name: "navigate", args: { url } });

/**
 * A worker-built run that STARTS with no tab, its model played by `script`. `redirectTo` makes the first tab the browser
 * opens report `redirectTo` as its URL and title once it is loaded: a server redirect after the card was answered, as
 * chrome.tabs.get reports it (the tab holds the last document the browser committed).
 * @returns the worker, the run id, its session port, and readers for the cards, the model requests and the run's log
 */
async function run({ first = [], redirectTo, maxSteps = 6 } = {}) {
    const script = [...first];
    let bg;
    bg = loadBackground({
        openCreated: true,
        config: { chatUrl: "http://host/api/chat/completions", apiKey: "k", model: "m", apiFormat: "openai", debugMode: "off" },
        onFetch: async (call) => {
            if (call.url.endsWith("/api/models")) return jsonResponse({ data: [{ id: "m" }] });
            if (!call.url.includes("/chat/completions")) return jsonResponse({});
            const step = script.shift();
            if (!step) return jsonResponse({ choices: [{ message: { content: "done" } }] });
            return jsonResponse({ choices: [{ message: { content: null, tool_calls: [{ id: `c${Math.random()}`, type: "function", function: { name: step.name, arguments: JSON.stringify(step.args) } }] } }] });
        },
        onTabMessage: async (t, msg) => {
            // The exec's card, answered the way the overlay answers one: every card but the navigate's, which the row answers.
            if (msg.type === "ML_DEBUG_TO_PAGE" && msg.event?.awaitingApproval && msg.event.tool !== "navigate") {
                void bg.send({ type: "SET_APPROVAL", payload: { runId: msg.event.id, seq: msg.event.seq, decision: true } }, { tab: { id: t, url: "https://news.example/x" }, url: "chrome-extension://test/sidebar.html", frameId: 1 });
            }
            if (msg.type === "ADOPT_RUN_NOW") return { pageInfo: "" };
            if (msg.type !== "RUN_TOOL_IN_PAGE") return undefined;
            if (msg.payload.finish || msg.payload.renderOnly || msg.payload.precheck || msg.payload.readonlyTry) return {};
            return { result: `ran on ${t}` };
        },
        ...(redirectTo ? { onTabsGet: (id, answer) => { if (id === 4243) { answer.url = redirectTo; answer.title = new URL(redirectTo).host; } } } : {}),
    });
    const port = bg.connect("ml-sessions", PAGE);
    port.send({ type: "sessions" });
    port.send({ type: "cmd", id: 900, command: { type: "agent.start", runtime: "local", task: "probe", maxSteps, target: { kind: "detached" } } });
    assert.ok(await until(() => port.messages.some((m) => m.type === "result" && m.id === 900)), "agent.start with no tab starts");
    const answer = port.messages.find((m) => m.type === "result" && m.id === 900).result;
    assert.equal(answer.ok, true, `a detached run starts: ${JSON.stringify(answer)}`);
    const hash = answer.data.session.hash;
    const cards = (tool = "navigate") => port.messages.filter((m) => m.type === "stream" && m.message?.type === "event").map((m) => m.message.event)
        .filter((e) => e?.awaitingApproval && e.tool === tool);
    const live = () => bg.context.__mlRunStateForTest().controllers.includes(hash);
    const bodies = () => bg.calls.filter((c) => c.url.includes("/chat/completions")).map((c) => c.body);
    const tabLog = async () => (await bg.context.__mlRunLog.all()).filter((e) => e.run === hash && e.subsystem === "tab");
    const rows = () => {
        const map = new Map();
        for (const m of port.messages) {
            if (m.type !== "index") continue;
            const u = m.update;
            if (u.type === "snapshot") { map.clear(); for (const s of u.sessions) map.set(s.id.hash, s); }
            else if (u.type === "upsert") map.set(u.session.id.hash, u.session);
            else if (u.type === "remove") map.delete(u.id.hash);
        }
        return map;
    };
    return { bg, hash, port, script, cards, live, bodies, tabLog, rows };
}
/** Waits for the run's card and answers it the chat page's way; returns the card. */
async function answerCard(r, decision, id = 50) {
    if (!r.port.messages.some((m) => m.type === "stream")) r.port.send({ type: "events", sub: 1, hash: r.hash });
    assert.ok(await until(() => r.cards().length > 0), "the navigate card is shown");
    const card = r.cards().at(-1);
    r.port.send({ type: "cmd", id, command: { type: "approval.answer", session: { runtime: "local", hash: r.hash }, seq: card.seq, decision } });
    assert.ok(await until(() => r.port.messages.some((m) => m.type === "result" && m.id === id)), "the answer is taken");
    return card;
}
/** What the model read back for each tool call, oldest first. */
const toolResults = (body) => (body?.messages ?? []).filter((m) => m.role === "tool").map((m) => String(m.content));
/** Everything the model read in one request, as one text: its notes included. */
const readText = (body) => (body?.messages ?? []).map((m) => String(m.content ?? "")).join("\n");

// --- the string the card names is the string the browser opens ---

test("RED TEAM: a navigate from no tab opens the URL the card named, as the browser reads it, for every spelling that is accepted", T, async () => {
    // Each spelling is its own run: once a navigate succeeds the run has a tab, and a later navigate is not this branch.
    const cases = [
        "https://news.example/x",
        "HTTPS://News.Example/x",                    // scheme and host fold
        "  https://news.example/  ",                  // trimmed, as the card's URL is
        "https://news.example\\@evil.example/",        // a backslash reads as a path, not an authority
        "https://news.example%2F@evil.example/",       // the authority is evil.example, and the card must say so
        "https://news.example\n.evil.example/",        // the newline is dropped: another host, named on the card
        "https://news.example./x",                    // a trailing dot stays in the host
        "https://user:pass@news.example/",            // userinfo kept, host named
        "https://news.example:443/x",                 // the default port folds
    ];
    for (const spelled of cases) {
        const r = await run({ first: [nav(spelled), exec] });
        const card = await answerCard(r, "approve");
        const expected = new URL(spelled.trim()).href;
        assert.equal(card.renderIn?.target, expected, `the card names what the browser reads for ${JSON.stringify(spelled)}`);
        assert.ok(await until(() => !r.live()), `the turn ends for ${JSON.stringify(spelled)}`);
        assert.deepEqual(r.bg.tabsCreated.map((t) => t.url), [expected], `the tab opens at the card's string, not the model's: ${JSON.stringify(spelled)}`);
        // The run's own note names the page it is on: the model's view of where its navigate took it.
        const note = readText(r.bodies().at(-1));
        assert.ok(note.includes(`(${expected}), and the run is on it now`), `the run's page is the card's URL: ${JSON.stringify(spelled)} — note: ${note.slice(-400)}`);
        const moved = (await r.tabLog()).find((e) => e.kind === "moved");
        assert.deepEqual([moved?.reason, moved?.detail?.from, moved?.detail?.to], ["navigate", -1, 4243], `the move is the navigate's, from no tab: ${JSON.stringify(moved)}`);
    }
});

test("RED TEAM: every spelling that is not an absolute http(s) URL is refused before any card, and opens nothing", T, async () => {
    const refused = ["", "/inbox", "news.example/x", "//news.example/x", "https:/news.example/x", "https:news.example/x",
        "https:\\\\news.example/x", "http://", "javascript:alert(1)", "file:///etc/passwd", "chrome://settings/",
        "chrome-extension://test/sidebar.html", "data:text/html,<b>x", "about:blank", "view-source:https://news.example/",
        "ftp://news.example/x", "blob:https://news.example/uuid", "ws://news.example/x"];
    const r = await run({ first: refused.map((u) => nav(u)), maxSteps: refused.length + 2 });
    if (!r.port.messages.some((m) => m.type === "stream")) r.port.send({ type: "events", sub: 1, hash: r.hash });
    assert.ok(await until(() => !r.live(), 8000), "the turn ends");
    assert.ok(r.bodies().length >= refused.length + 1, `every call was made: ${r.bodies().length} of ${refused.length + 1} model requests`);
    assert.equal(r.cards().length, 0, "a refused spelling drew a card");
    assert.equal(r.bg.tabsCreated.length, 0, "a refused spelling opened a tab");
    const read = toolResults(r.bodies().at(-1));
    const refusals = read.filter((t) => /^Error: this run has no tab, so navigate needs an absolute http\(s\) URL/.test(t));
    assert.equal(refusals.length, refused.length, `every refusal is the no-tab one: ${read.join("\n---\n")}`);
    assert.equal(r.rows().get(r.hash)?.background?.noTab, true, "the run still has no tab");
});

// --- nothing opens before the person answers ---

test("RED TEAM: the tab opens only once the person approves: the card comes first, and a refusal opens nothing", T, async () => {
    const approved = await run({ first: [nav(NEWS)] });
    if (!approved.port.messages.some((m) => m.type === "stream")) approved.port.send({ type: "events", sub: 1, hash: approved.hash });
    assert.ok(await until(() => approved.cards().length > 0), "the navigate card is shown");
    assert.equal(approved.bg.tabsCreated.length, 0, "a tab was opened before the person answered");
    assert.deepEqual(approved.bg.tabMessages, [], "a page was told something before the person answered");
    await answerCard(approved, "approve");
    assert.ok(await until(() => approved.bg.tabsCreated.length === 1), "positive control: the approval opens the tab");

    const denied = await run({ first: [nav(NEWS), exec] });
    await answerCard(denied, "deny");
    assert.ok(await until(() => !denied.live()), "the turn ends");
    assert.equal(denied.bg.tabsCreated.length, 0, "a refused navigate opened a tab");
    assert.equal(denied.rows().get(denied.hash)?.background?.noTab, true, "a refused navigate gave the run a tab");

    // And a card nobody answers, ended by Stop: the tab never opened.
    const stopped = await run({ first: [nav(NEWS)] });
    if (!stopped.port.messages.some((m) => m.type === "stream")) stopped.port.send({ type: "events", sub: 1, hash: stopped.hash });
    assert.ok(await until(() => stopped.cards().length > 0), "the navigate card is shown");
    stopped.port.send({ type: "cmd", id: 91, command: { type: "session.cancel", session: { runtime: "local", hash: stopped.hash } } });
    assert.ok(await until(() => !stopped.live(), 8000), "the person's Stop ends the run");
    assert.equal(stopped.bg.tabsCreated.length, 0, "a cancelled navigate opened a tab");
});

test("RED TEAM: the tab the navigate opens is told nothing of the run until the moment the run moves onto it", T, async () => {
    const r = await run({ first: [nav(NEWS), exec] });
    await answerCard(r, "approve");
    assert.ok(await until(() => !r.live()), "the turn ends");
    const opened = 4243;
    const toIt = r.bg.tabMessages.filter(([t]) => t === opened).map(([, m]) => m);
    assert.ok(toIt.length > 0, "positive control: the run's tools reached the opened tab");
    assert.equal(toIt[0]?.type, "ADOPT_RUN_NOW", `the first message of ours to the new tab is not its adoption: ${toIt.map((m) => m?.type ?? m?.event?.kind ?? m?.payload?.name).join(", ")}`);
    // Nothing of the run before that: no replay, no event, no page tool named on it.
    assert.ok(!toIt.slice(0, toIt.findIndex((m) => m?.type === "ADOPT_RUN_NOW")).some((m) => m?.type !== "ADOPT_RUN_NOW"));
});

// --- a tab that lands on a site the card did not name ---

// (RED TEAM, open: measured 2026-11-26 on e92cb94e — the run's note read "its navigate opened tab "other.example"
// (https://other.example/landing), and the run is on it now", and its exec ran there. The move takes the tab's URL after
// the load, grants that origin (move-run.ts `applyLiveMove`), and no arrival judge was watching: `passArrival` and
// `navStalled` are skipped for a run with no tab, and a tab run's redirect is judged and held
// (tests/nav-arrival-host.test.mjs, "the named page's pass is for that page only"). Deciding it: drop the move with the
// model told (as `navDroppedNote` already does for a tab that will not take the run), or judge the arrived page first,
// as a tab run's arrival is.)
test("RED TEAM: a navigate from no tab whose tab lands on another site than the card named is not moved there before the person is asked", T, async () => {
    // The card is answered for news.example, and the tab the browser reports holds other.example: what chrome.tabs.get
    // answers after the server redirected, or the page sent itself on (nav-arrival.ts's first sentence). A tab run's
    // redirect is judged and held on arrival (tests/nav-arrival-host.test.mjs, "the named page's pass is for that page
    // only"); this branch of the same tool must not be the way round it.
    const OTHER = "https://other.example/landing";
    const r = await run({ first: [nav(NEWS), exec], redirectTo: OTHER });
    const card = await answerCard(r, "approve");
    assert.equal(card.renderIn?.target, NEWS, "the card named one site");
    assert.ok(await until(() => !r.live()), "the turn ends");
    assert.equal(r.bg.tabsCreated.map((t) => t.url)[0], NEWS, "the tab was opened at the card's URL");
    const moved = (await r.tabLog()).find((e) => e.kind === "moved" || e.kind === "move-dropped");
    const note = readText(r.bodies().at(-1));
    assert.match(note, /other\.example/, "control: the run's own note says where the tab landed");
    // Every card the person was shown, and every ask the run raised: a site the card never named must appear in one of
    // them before the run acts there. None does today: the run is simply on other.example from its next step.
    const approvals = r.port.messages.filter((m) => m.type === "stream" && m.message?.type === "event" && m.message.event?.awaitingApproval).map((m) => m.message.event);
    const askedOthers = approvals.filter((e) => /other\.example/.test(JSON.stringify(e)));
    assert.ok(moved?.kind !== "moved" || askedOthers.length > 0,
        `the run moved onto ${OTHER}, a site the card never named, without a card or an ask about it (cards: ${approvals.map((e) => e.tool).join(", ") || "none"})`);
});
