// redteam-signin-chain.test.mjs — RED TEAM for the sign-in redirect chain: a `navigate` from a run with no tab whose
// tab is sent on by the site, as an OAuth login is (login → identity provider → callback with its `code`).
//
// The property these rows pin is what the MODEL and the run get from the landing, not a defence of their own: the
// arrival note carries the landed URL exactly as the browser reports it (query and fragment, so an authorization code
// or an implicit flow's access token), an arrival no policy covers passes as the 2026-10-24 rule has it, and the
// landing grants the origin the CARD named, never another. The rule question the code and state raise (whether an
// authorization URL should reach the model at all) is docs/plan/repl/SIGNIN_CHAIN_RESULT.md, for Shane.
//
// Each test is a run in the real bundle (`dist/background.js` in node:vm, tests/helpers.js `loadBackground`), the page
// played by `onTabMessage` and the model by `script`, one reply per model call.
import { test } from "node:test";
import assert from "node:assert";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { jsonResponse, loadBackground } = require("./helpers");

const PAGE = { url: "chrome-extension://test/sidebar/chat.html" };
const T = { timeout: 30000 };
const tick = () => new Promise((r) => setTimeout(r, 0));
async function until(done, cap = 4000) { for (let i = 0; i < cap && !done(); i++) await tick(); return done(); }
const nav = (url) => ({ name: "navigate", args: { url } });
const credFetch = (url) => ({ name: "fetch_url", args: { url, credentials: true } });

/**
 * A worker-built run with NO tab (`agent.start`, a `detached` target), whose `navigate` opens tab 4243 with `redirectTo`
 * reporting where the site sent it, as after a server redirect. `script` is the model's replies.
 * @returns the worker, the run, `bodies()` (every model request), `cards()` (every approval event raised, by seq),
 *  `adoptions()` (ADOPT_RUN_NOW to the opened tab), `pageCalls()` (page tool calls that are not previews),
 *  `runLog()` (the run's execution-log records)
 */
async function run({ first = [], redirectTo } = {}) {
    const script = [...first];
    const bg = loadBackground({
        openCreated: true,
        ...(redirectTo ? { onTabsGet: (id, answer) => { if (id === 4243) { answer.url = redirectTo; answer.title = new URL(redirectTo).host; } } } : {}),
        config: { chatUrl: "http://host/api/chat/completions", apiKey: "k", model: "m", apiFormat: "openai", debugMode: "off" },
        onFetch: async (call) => {
            if (call.url.endsWith("/api/models")) return jsonResponse({ data: [{ id: "m" }] });
            if (!call.url.includes("/chat/completions")) return jsonResponse({});
            const step = script.shift();
            if (!step) return jsonResponse({ choices: [{ message: { content: "done" } }] });
            return jsonResponse({ choices: [{ message: { content: null, tool_calls: [{ id: `c${Math.random()}`, type: "function", function: { name: step.name, arguments: JSON.stringify(step.args) } }] } }] });
        },
        onTabMessage: async (_tab, msg) => {
            if (msg.type === "ADOPT_RUN_NOW") return { pageInfo: "" };
            if (msg.type !== "RUN_TOOL_IN_PAGE") return undefined;
            if (msg.payload.finish || msg.payload.renderOnly || msg.payload.precheck || msg.payload.readonlyTry) return {};
            return { result: `ran on the opened tab` };
        },
    });
    const port = bg.connect("ml-sessions", PAGE);
    port.send({ type: "sessions" });
    port.send({ type: "cmd", id: 900, command: { type: "agent.start", runtime: "local", task: "sign-in", maxSteps: 6, target: { kind: "detached" } } });
    assert.ok(await until(() => port.messages.some((m) => m.type === "result" && m.id === 900)), "agent.start with no tab starts");
    const hash = port.messages.find((m) => m.type === "result" && m.id === 900).result.data.session.hash;
    port.send({ type: "events", sub: 1, hash });
    /** Every approval event raised, once each: on the session channel or drawn on the opened tab. */
    const cards = () => {
        const seen = new Map();
        const events = [
            ...port.messages.filter((m) => m.type === "stream" && m.message?.type === "event").map((m) => m.message.event),
            ...bg.tabMessages.filter(([, m]) => m?.type === "ML_DEBUG_TO_PAGE").map(([, m]) => m.event),
        ];
        for (const e of events) if (e?.awaitingApproval && !seen.has(e.seq)) seen.set(e.seq, e);
        return [...seen.values()];
    };
    return {
        bg, hash, port,
        cards,
        bodies: () => bg.calls.filter((c) => c.url.includes("/chat/completions")).map((c) => c.body),
        adoptions: () => bg.tabMessages.filter(([t, m]) => t === 4243 && m?.type === "ADOPT_RUN_NOW").length,
        pageCalls: () => bg.tabMessages.filter(([t, m]) => t === 4243 && m?.type === "RUN_TOOL_IN_PAGE" && m.payload?.name && !m.payload.finish && !m.payload.renderOnly && !m.payload.precheck && !m.payload.readonlyTry),
        live: () => bg.context.__mlRunStateForTest().controllers.includes(hash),
        runLog: async () => (await bg.context.__mlRunLog.all()).filter((e) => e.run === hash),
    };
}
/** Every message of a model request, as the text the model read. */
const readText = (body) => (body?.messages ?? []).map((m) => String(m.content ?? "")).join("\n");

async function answerCard(r, { decision = "approve", id = 50 } = {}) {
    assert.ok(await until(() => r.cards().some((e) => e.tool === "navigate")), "the navigate card is shown");
    const card = r.cards().filter((e) => e.tool === "navigate").at(-1);
    r.port.send({ type: "cmd", id, command: { type: "approval.answer", session: { runtime: "local", hash: r.hash }, seq: card.seq, decision } });
    assert.ok(await until(() => r.port.messages.some((m) => m.type === "result" && m.id === id)), "the answer is taken");
    return card;
}

const LOGIN = "https://app.example/login";

// --- the landing the model is told about: the URL as the browser reports it ---

test("RED TEAM: an authorization callback's URL reaches the model whole — the bounced run is told the `code` and `state` in it", T, async () => {
    const CALLBACK = "https://app.example/callback?code=CODE123&state=st456";
    const r = await run({ first: [nav(LOGIN), { name: "read", args: {} }], redirectTo: CALLBACK });
    await answerCard(r);
    assert.ok(await until(() => !r.live()), "the turn ends");
    assert.equal(r.adoptions(), 1, "the uncovered arrival passes: the run moved onto the tab");
    const last = readText(r.bodies().at(-1));
    assert.match(last, /this run had no tab; its navigate opened tab "app\.example" \((https:\/\/app\.example\/callback\?code=CODE123&state=st456)\), and the run is on it now/,
        "MEASURED, for Shane: the note carries the landed URL with its query, so an authorization code is sent to the model");
    // What the card named, and nothing more: the person approved app.example/login.
    const card = r.cards().find((e) => e.tool === "navigate");
    assert.match(JSON.stringify(card.renderIn ?? {}), /app\.example\/login/);
});

test("RED TEAM: a fragment is not withheld either — an implicit flow's access token in the landed URL is sent to the model", T, async () => {
    const LANDING = "https://app.example/start#access_token=TOK123&token_type=bearer&state=st456";
    const r = await run({ first: [nav("https://app.example/start"), { name: "read", args: {} }], redirectTo: LANDING });
    await answerCard(r);
    assert.ok(await until(() => !r.live()), "the turn ends");
    const last = readText(r.bodies().at(-1));
    assert.match(last, /\(https:\/\/app\.example\/start#access_token=TOK123&token_type=bearer&state=st456\)/,
        "MEASURED, for Shane: navigatedNote takes the tab's URL whole, fragment included (the arrival judge unfragments it first)");
});

// --- an identity-provider landing: uncovered, and the run acts there ---

test("RED TEAM: an identity-provider landing is an uncovered arrival — the run moves onto it, and a read of the page it is on runs without a card", T, async () => {
    const IDP = "https://idp.example/auth?client_id=c1&redirect_uri=https%3A%2F%2Fapp.example%2Fcallback";
    const r = await run({ first: [nav(LOGIN), { name: "scroll", args: { y: 100 } }], redirectTo: IDP });
    await answerCard(r);
    assert.ok(await until(() => !r.live()), "the turn ends");
    assert.equal(r.adoptions(), 1, "no policy covers idp.example, so the arrival passes (TABLESS_RUN.md, part 3)");
    assert.ok(r.pageCalls().some(([, m]) => m.payload.name === "scroll"), "the read ran on the page the tab landed on");
    assert.equal(r.cards().filter((e) => e.tool !== "navigate").length, 0, "and it was asked of nobody: an uncovered arrival raises no card, and a read-only call none of its own");
    assert.match(readText(r.bodies().at(-1)), /its navigate opened tab "idp\.example" \(https:\/\/idp\.example\/auth\?client_id=c1&redirect_uri=/,
        "the model is told it is on the identity provider, by its full URL");
    const arrival = (await r.runLog()).filter((e) => e.subsystem === "policy");
    assert.equal(arrival.length, 0, "no policy record: an uncovered arrival writes none");
});

test("RED TEAM: a landing on the identity provider makes a CREDENTIALED read of the run's own page free — the bounce hands it a read the card never asked about", T, async () => {
    const IDP = "https://idp.example/auth?client_id=c1";
    const r = await run({ first: [nav(LOGIN), credFetch("https://idp.example/session")], redirectTo: IDP });
    await answerCard(r);
    assert.ok(await until(() => !r.live()), "the turn ends");
    assert.equal(r.adoptions(), 1, "the uncovered arrival passed");
    const fetchCards = r.cards().filter((e) => e.tool === "fetch_url");
    assert.equal(fetchCards.length, 0, "MEASURED, for Shane: the page the run is ON is free in every fetch mode, so the credential-bearing read of idp.example asks nobody");
    assert.match(readText(r.bodies().at(-1)), /idp\.example/, "control: the run really is on the identity provider");
});

// --- the landing grants what the card named, never another origin ---

test("RED TEAM: after the bounce, a credentialed read asks at the site the tab went on to, and not at the origin the card named", T, async () => {
    const CALLBACK = "https://app.example/callback?code=CODE123&state=st456";
    const r = await run({ first: [nav(LOGIN), credFetch("https://app.example/data"), credFetch("https://idp.example/data")], redirectTo: CALLBACK });
    await answerCard(r);
    // Answer each fetch card as it comes, so the next step runs and the turn ends.
    const answered = new Set();
    for (let i = 0; i < 6000 && r.live(); i++) {
        for (const e of r.cards().filter((e) => e.tool === "fetch_url" && !answered.has(e.seq))) {
            answered.add(e.seq);
            r.port.send({ type: "cmd", id: 500 + answered.size, command: { type: "approval.answer", session: { runtime: "local", hash: r.hash }, seq: e.seq, decision: "deny" } });
        }
        await tick();
    }
    const fetchCards = r.cards().filter((e) => e.tool === "fetch_url").map((e) => JSON.stringify(e));
    assert.equal(fetchCards.filter((t) => /idp\.example\/data/.test(t)).length, 1, "a credentialed read of the site the tab was sent on to asks");
    assert.equal(fetchCards.filter((t) => /app\.example\/data/.test(t)).length, 0, "the origin the card named keeps its as-you grant, and the run is on app.example besides");
});
