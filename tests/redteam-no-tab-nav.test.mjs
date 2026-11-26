// redteam-no-tab-nav.test.mjs — what a `navigate` from a run with NO tab (docs/spec/TABLESS_RUN.md, "`navigate` from the
// detached state"; src/sw/no-tab-nav.ts) must not give a page or the model: a tab at a site the card did not name, a tab
// opened before the person answered, a message of the run's to the new tab before the run moved onto it, or a site other
// than the one it approved. Every row is a worker-built run with no tab in the real bundle (`dist/background.js` in
// node:vm, tests/helpers.js `loadBackground`), the chat page by the `ml-sessions` port, the model by `script`.
//
// The hazard throughout is the two-step shape: the card is drawn from one string and the tab is opened from another, and
// the run then takes whatever page the tab lands on. Every row below turns one of those three into a claim. The last
// four rows are the arrival case (#2181): a tab that lands on a site the card did not name must not take the run there
// with a grant, an approval, or at all when a policy holds it, and a decline on a tab with no page behind it leaves the
// run with no tab again.

import { test } from "node:test";
import assert from "node:assert";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { jsonResponse, loadBackground } = require("./helpers");

const NEWS = "https://news.example/today";
const OTHER = "https://other.example/landing";
const THIRD = "https://third.example/page";
const PAGE = { url: "chrome-extension://test/sidebar/chat.html" };
const T = { timeout: 30000 };
const tick = () => new Promise((r) => setTimeout(r, 0));
/** Waits until `done()` holds, for at most `cap` macrotasks. */
async function until(done, cap = 4000) { for (let i = 0; i < cap && !done(); i++) await tick(); return done(); }
const exec = { name: "exec", args: { js: "document.body.remove()" } };
const nav = (url) => ({ name: "navigate", args: { url } });
/** A credentialed (fetch-as-the-user) read: the mode that must never be answered by a site nobody approved. */
const credFetch = (url) => ({ name: "fetch_url", args: { url, credentials: true } });
/** A saved global policy over fetch, as the policy settings store one. */
const policy = (id, effect, host, label) => ({ id, scope: "global", consumer: "fetch", effect, source: `(c) => c.host === ${JSON.stringify(host)}`, label, origin: "person", created: 1760000000000 });

/**
 * A worker-built run that STARTS with no tab, its model played by `script`. `redirectTo` makes the first tab the browser
 * opens report that page as its URL and title once it is loaded: a server redirect after the card was answered, as
 * chrome.tabs.get reports it (the tab holds the last document the browser committed). A function is read at each answer,
 * so a row can move the tab on, as a page that navigates itself does.
 * @returns the worker, the run id, its session port, and readers for the cards, the model requests and the run's log
 */
async function run({ first = [], redirectTo, maxSteps = 6, policies = [] } = {}) {
    const script = [...first];
    let bg;
    bg = loadBackground({
        openCreated: true,
        ...(policies.length ? { local: { ml_policies_global: policies } } : {}),
        config: { chatUrl: "http://host/api/chat/completions", apiKey: "k", model: "m", apiFormat: "openai", debugMode: "off" },
        onFetch: async (call) => {
            if (call.url.endsWith("/api/models")) return jsonResponse({ data: [{ id: "m" }] });
            if (!call.url.includes("/chat/completions")) return jsonResponse({});
            const step = script.shift();
            if (!step) return jsonResponse({ choices: [{ message: { content: "done" } }] });
            return jsonResponse({ choices: [{ message: { content: null, tool_calls: [{ id: `c${Math.random()}`, type: "function", function: { name: step.name, arguments: JSON.stringify(step.args) } }] } }] });
        },
        onTabMessage: async (t, msg) => {
            // The exec's card, answered the way the overlay answers one. The cards the rows answer themselves (the
            // navigate's, and a credentialed fetch's) are left alone.
            if (msg.type === "ML_DEBUG_TO_PAGE" && msg.event?.awaitingApproval && msg.event.tool !== "navigate" && msg.event.tool !== "fetch_url") {
                void bg.send({ type: "SET_APPROVAL", payload: { runId: msg.event.id, seq: msg.event.seq, decision: true } }, { tab: { id: t, url: NEWS }, url: "chrome-extension://test/sidebar.html", frameId: 1 });
            }
            if (msg.type === "ADOPT_RUN_NOW") return { pageInfo: "" };
            if (msg.type !== "RUN_TOOL_IN_PAGE") return undefined;
            if (msg.payload.finish || msg.payload.renderOnly || msg.payload.precheck || msg.payload.readonlyTry) return {};
            return { result: `ran on ${t}` };
        },
        ...(redirectTo ? { onTabsGet: (id, answer) => { const to = typeof redirectTo === "function" ? redirectTo() : redirectTo; if (id === 4243 && to) { answer.url = to; answer.title = new URL(to).host; } } } : {}),
    });
    const port = bg.connect("ml-sessions", PAGE);
    port.send({ type: "sessions" });
    port.send({ type: "cmd", id: 900, command: { type: "agent.start", runtime: "local", task: "probe", maxSteps, target: { kind: "detached" } } });
    assert.ok(await until(() => port.messages.some((m) => m.type === "result" && m.id === 900)), "agent.start with no tab starts");
    const answer = port.messages.find((m) => m.type === "result" && m.id === 900).result;
    assert.equal(answer.ok, true, `a detached run starts: ${JSON.stringify(answer)}`);
    const hash = answer.data.session.hash;
    port.send({ type: "events", sub: 1, hash });
    const portEvents = () => port.messages.filter((m) => m.type === "stream" && m.message?.type === "event").map((m) => m.message.event);
    const tabEvents = () => bg.tabMessages.filter(([, m]) => m?.type === "ML_DEBUG_TO_PAGE").map(([, m]) => m.event);
    /** Every card the run raised, on either surface, once each (a moved run's replay shows a card again). */
    const cardList = (tool) => {
        const seen = new Map();
        for (const e of [...portEvents(), ...tabEvents()]) if (e?.awaitingApproval && e.tool === tool && !seen.has(e.seq)) seen.set(e.seq, e);
        return [...seen.values()];
    };
    const cards = (tool = "navigate") => cardList(tool);
    /** A nested ask (an arrival's) on either surface: the step's seq, the ask, and the event it rode on. */
    const ask = (kind, re) => {
        for (const e of [...portEvents(), ...tabEvents()]) for (const a of e?.asks ?? []) if (a.kind === kind && (!re || re.test(JSON.stringify(a)))) return { seq: e.seq, ask: a, event: e };
        return undefined;
    };
    const live = () => bg.context.__mlRunStateForTest().controllers.includes(hash);
    const bodies = () => bg.calls.filter((c) => c.url.includes("/chat/completions")).map((c) => c.body);
    const tabLog = async () => (await bg.context.__mlRunLog.all()).filter((e) => e.run === hash && e.subsystem === "tab");
    /** How many times the tab the navigate opened was given the run's tools. */
    const adoptions = () => bg.tabMessages.filter(([t, m]) => t === 4243 && m?.type === "ADOPT_RUN_NOW").length;
    /** Every call of the run's that reached the opened tab (previews and finish markers excluded). */
    const pageCalls = () => bg.tabMessages.filter(([t, m]) => t === 4243 && m?.type === "RUN_TOOL_IN_PAGE" && m.payload?.name && !m.payload.finish && !m.payload.precheck && !m.payload.readonlyTry && !m.payload.renderOnly);
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
    return { bg, hash, port, script, cards, cardList, ask, live, bodies, tabLog, adoptions, pageCalls, rows };
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
/** Answers a nested ask (an arrival's) by its id beside the step's seq; asserts the gate actually took it. */
async function answerAsk(r, found, decision, id = 61) {
    r.port.send({ type: "cmd", id, command: { type: "approval.answer", session: { runtime: "local", hash: r.hash }, seq: found.seq, ask: found.ask.id, decision } });
    assert.ok(await until(() => r.port.messages.some((m) => m.type === "result" && m.id === id)), "the ask's answer is taken");
    const result = r.port.messages.find((m) => m.type === "result" && m.id === id).result;
    assert.equal(result.data?.resolved, true, `the ask's answer resolved its gate: ${JSON.stringify(result)}`);
}
/** Sends a turn as the chat page does, answers every credentialed fetch card with `decision`, and waits for it to end. */
async function turnAnsweringFetches(r, text, decision = "deny", id = 951) {
    r.port.send({ type: "cmd", id, command: { type: "session.send", session: { runtime: "local", hash: r.hash }, text } });
    assert.ok(await until(() => r.port.messages.some((m) => m.type === "result" && m.id === id)), "the turn is accepted");
    const answer = r.port.messages.find((m) => m.type === "result" && m.id === id).result;
    assert.equal(answer.ok, true, `a turn starts: ${JSON.stringify(answer)}`);
    const answered = new Set();
    for (let i = 0; i < 6000; i++) {
        for (const e of r.cards("fetch_url")) {
            if (answered.has(e.seq)) continue;
            answered.add(e.seq);
            r.port.send({ type: "cmd", id: 500 + answered.size, command: { type: "approval.answer", session: { runtime: "local", hash: r.hash }, seq: e.seq, decision } });
        }
        if (!r.live()) break;
        await tick();
    }
    assert.ok(!r.live(), "the turn ends");
}
/**
 * The first turn: a navigate the row approves (or a person's own policy answers) whose tab reports `OTHER` once loaded,
 * with the run moved onto it. Returns the run, and `moveTabOn`: the browser's tab going on by itself to another site,
 * as a page that navigates itself does — after which a read of the site it landed on is not "the page the run is on",
 * which is free whatever got it there, so the grant is what the read is judged on.
 */
async function startLanding({ first = [nav(NEWS)], policies = [] } = {}) {
    let at = OTHER;
    const r = await run({ first, policies, redirectTo: () => at });
    if (policies.length) {
        assert.equal(r.cards().length, 0, "the person's policy answered the navigate, with no card");
    } else {
        const card = await answerCard(r, "approve");
        assert.equal(card.renderIn?.target, NEWS, "the card named one site");
    }
    assert.ok(await until(() => !r.live()), "the first turn ends");
    assert.deepEqual(r.bg.tabsCreated.map((t) => t.url), [NEWS], "the tab was opened at the URL the person approved");
    assert.match(readText(r.bodies().at(-1)), /other\.example/, "control: the run's own note says where the tab landed");
    assert.ok(r.adoptions() >= 1, "control: no policy holds it, so the run moved onto the tab");
    return { r, moveTabOn: (url = THIRD) => { at = url; r.bg.commit(4243, { documentId: `doc-${url}`, url }); } };
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

test("RED TEAM: a navigate from no tab whose tab lands on another site gives the run no grant there: a credentialed read of it asks, and of the site the card named does not", T, async () => {
    // A tab run's arrival no policy covers passes as it is (tests/nav-arrival-host.test.mjs): so does this one. What the
    // card granted is the page it named; a credentialed read of the landed site still asks, of the named one does not.
    // The reads are made once the tab has gone on to a third page: a read of the page the tab is ON is free, whatever
    // got it there, so the grant is what the read is judged on.
    const { r, moveTabOn } = await startLanding();
    moveTabOn();
    r.script.push(credFetch("https://other.example/data"), credFetch("https://news.example/data"));
    await turnAnsweringFetches(r, "read the data");
    const asked = r.cards("fetch_url").map((e) => JSON.stringify(e));
    assert.equal(asked.filter((e) => /other\.example\/data/.test(e)).length, 1, `a credentialed read of ${OTHER}'s site, which no card named, was answered with no card: ${asked.join("\n")}`);
    assert.equal(asked.filter((e) => /news\.example\/data/.test(e)).length, 0, "control: the site the card named was granted");
    assert.match(JSON.stringify(r.bodies().at(-1)), /news\.example\/data/, "control: the read the card named was actually made");
});

test("RED TEAM: a navigate from no tab answered by a person's allow policy gives the run no grant for the site the tab lands on: a credentialed read of it asks", T, async () => {
    // The person's standing policy is their word for news.example alone; the tab lands on other.example. The policy
    // consents the navigate and grants nothing (src/agent/agent-host.ts: `policy` `allow` returns `consented`), so the
    // landed site has no as-you grant from any of it. The control is the tab's own page: an as-you read of the origin
    // the tab is ON is free, so the ask counted below is the landed site's and not a gate that asks everything.
    const allowNews = policy("p-allow-news", "allow", "news.example", "Allow news.example");
    const { r, moveTabOn } = await startLanding({ policies: [allowNews] });
    moveTabOn();
    r.script.push(credFetch("https://other.example/data"), credFetch(THIRD));
    await turnAnsweringFetches(r, "read the data");
    const asked = r.cards("fetch_url").map((e) => JSON.stringify(e));
    assert.equal(asked.filter((e) => /other\.example\/data/.test(e)).length, 1, `a credentialed read of ${OTHER}'s site, which no policy covered, was answered with no card: ${asked.join("\n")}`);
    assert.equal(asked.filter((e) => /third\.example\/page/.test(e)).length, 0, "control: the origin the tab is on now is free, so the gate is not asking everything");
    assert.match(JSON.stringify(r.bodies().at(-1)), /third\.example\/page/, "control: the read of the tab's own origin was actually made");
});

test("RED TEAM: a navigate from no tab whose tab lands on a site a policy asks about is held, unadopted and with nothing of the run sent, until the person answers the arrival card", T, async () => {
    const ASK = policy("p-ask-other", "ask", "other.example", "Check with me on other.example");
    // An ungated tool, as tests/nav-arrival-host.test.mjs uses: a gated one's card answers the arrival first.
    const r = await run({ first: [nav(NEWS), { name: "scroll", args: {} }], policies: [ASK], redirectTo: OTHER });
    const card = await answerCard(r, "approve");
    assert.equal(card.renderIn?.target, NEWS, "the card named one site");
    assert.ok(await until(() => r.ask("arrival", /other\.example/)), "the person is asked about the site the tab landed on");
    const found = r.ask("arrival", /other\.example/);
    assert.match(JSON.stringify(found.ask), /Check with me on other\.example/, "the ask names the policy that raises it");
    // Held means held: no adoption, and no call of the run's on the page, while the person has not answered.
    for (let i = 0; i < 25; i++) await tick();
    assert.equal(r.adoptions(), 0, "the run was adopted on the landed site before the person answered");
    assert.equal(r.pageCalls().length, 0, `a call of the run reached the landed site before the person answered: ${r.pageCalls().map(([, m]) => m.payload?.name).join(", ")}`);
    await answerAsk(r, found, "approve");
    assert.ok(await until(() => !r.live()), "the turn ends");
    assert.ok(r.adoptions() >= 1, "answered, the run is adopted on the page the person approved");
    assert.ok(r.bg.tabMessages.some(([t, m]) => t === 4243 && m?.type === "RUN_TOOL_IN_PAGE" && m.payload?.name === "scroll"), "and its next call runs there");
    assert.ok(toolResults(r.bodies().at(-1)).some((t) => /which the policy "Check with me on other\.example" asks about\. The person approved the run acting on it\./.test(t)), "the model reads the person's answer naming the policy");
});

test("RED TEAM: a navigate from no tab whose tab lands on a site a policy denies is never adopted there, and no call of the run reaches it", T, async () => {
    const DENY = policy("p-deny-other", "deny", "other.example", "Not other.example");
    const r = await run({ first: [nav(NEWS), exec], policies: [DENY], redirectTo: OTHER });
    const card = await answerCard(r, "approve");
    assert.equal(card.renderIn?.target, NEWS, "the card named one site");
    assert.ok(await until(() => !r.live()), "the turn ends");
    assert.equal(r.adoptions(), 0, "the denied site was given the run's tools");
    assert.equal(r.pageCalls().filter(([, m]) => m.payload?.name === "exec").length, 0, "the run's exec reached the denied page");
    assert.ok(toolResults(r.bodies().at(-1)).some((t) => /"Not other\.example" denies: no tool runs on this page/.test(t)), "the model is told which rule holds it");
});

test("RED TEAM: a declined arrival on the tab a navigate from no tab opened leaves the run with no tab, the tab left as it is, and nothing of the run sent there after", T, async () => {
    const ASK = policy("p-ask-other", "ask", "other.example", "Check with me on other.example");
    const r = await run({ first: [nav(NEWS), { name: "scroll", args: {} }, exec], policies: [ASK], redirectTo: OTHER });
    const card = await answerCard(r, "approve");
    assert.equal(card.renderIn?.target, NEWS, "the card named one site");
    assert.ok(await until(() => r.ask("arrival", /other\.example/)), "the person is asked about the site the tab landed on");
    assert.equal(r.adoptions(), 0, "control: the run waits on the landing, unadopted, for the answer");
    await answerAsk(r, r.ask("arrival", /other\.example/), "deny");
    assert.ok(await until(() => !r.live(), 8000), "the turn ends");
    const read = toolResults(r.bodies().at(-1));
    assert.ok(read.includes("The person declined. The run has no page again."), `the model reads the decline:\n${read.join("\n")}`);
    assert.ok(read.some((t) => t.startsWith('Error: "exec" needs a page, and this run has no tab.')), `the next page tool is answered with no tab:\n${read.join("\n")}`);
    assert.equal(r.adoptions(), 0, "the page never took the run");
    assert.equal(r.pageCalls().length, 0, `a call of the run reached the tab after the decline: ${r.pageCalls().map(([, m]) => m.payload?.name).join(", ")}`);
    assert.deepEqual(r.bg.tabsRemoved, [], "the tab is left open");
    assert.ok(await until(() => r.rows().get(r.hash)?.background?.noTab === true), "the row says no tab again");
    assert.ok((await r.tabLog()).some((e) => e.kind === "no-tab" && e.reason === "no-back"), "the log records why");
});
