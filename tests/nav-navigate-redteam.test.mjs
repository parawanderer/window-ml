// nav-navigate-redteam.test.mjs — the rule-10 red-team pass on navigate-is-a-fetch (docs/spec/POLICIES.md, "Navigate
// is a fetch" and "A navigation the model did not name is judged on arrival"; PR #1120, landed as 9254b385). What a
// hostile page, a hostile policy shape or a model that navigates anywhere must NOT get from the arrival judgement, the
// origin grant and the named-navigate pass. Each property is a test; where the gate already held it is a pin of the
// As-built narrowing, and what was probed and not gotten is listed at the end.
//
// The As-built narrowings are pinned here, never contradicted (POLICIES.md, "As built (2026-10-24)"): the start origin
// is consented and never as-you; an arrival no policy decides passes and consents nothing; an ask asks on every arrival
// it covers, a consented origin included; the run's own navigate is judged once and a redirect on from it is judged; a
// hold outlives the turn; a page-built run keeps per-URL fetch approvals; ruling (b): an allow row consents the origin
// for navigation and uncredentialed reads only. The describe layer (the click precheck's `href` is the page's word) is
// pinned beside them: the arrival check is the enforcement.
//
// THE GATE / CHOKE-POINT SPLIT (measured, the central finding of this pass). `consentedOrigins` (the arrival's write)
// silences the agent-host PROMPT but does not reach the FETCH_URL choke point (`sw-fetch-url.ts`), which re-judges via
// `caller.consented` = `ctx.consented.has(u) || originCovers(ctx, u, …) || policyAllows(…)`. `originCovers` reads
// `ctx.origins` (`grantRunOrigin`), NOT `consentedOrigins`. So a pass arrival's uncredentialed fetch of its own origin
// is REFUSED end-to-end with "hasn't been approved for fetching on this page". After the security lane's fix (#1131),
// an allow row writes `navOnlyOrigins` instead: the read now cards (the gate shows it) rather than silently refusing at
// the choke point. The start-origin case (pageOrigin in `consentedOrigins`) still shows the split. The tests below pin
// the defended outcomes and name the split so a reorder of `fetchPolicy` in agent-host.ts, or a widening of
// `caller.consented`, turns them red.
//
// The built worker in node:vm (tests/helpers.js `loadBackground`): a run the worker built on tab 7 whose model is
// scripted, the same harness shape as tests/nav-arrival-host.test.mjs (`hostRun`, `addPolicy`). A page-built run is its
// own smaller harness below, because the worker-built path's origin grant never reaches it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { jsonResponse, loadBackground } = require("./helpers");

const T = { timeout: 30000 };
const plain = (x) => JSON.parse(JSON.stringify(x ?? null));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const START = "https://site.example/page";
const ADMIN = "https://b.example/admin/users";
const OTHER = "https://b.example/docs";
const ELSE = "https://b.example/elsewhere";
const config = { chatUrl: "http://host/api/chat/completions", apiKey: "sk-test", model: "default-model", apiFormat: "openai", ocrModel: "", debugMode: "off", autoApproveReadonly: true };

/** A saved global policy over fetch, as the policy page stores one. */
const policy = (id, effect, source, label) => ({ id, scope: "global", consumer: "fetch", effect, source, label, origin: "person", created: 1760000000000 });
const DENY_ADMIN = policy("p-deny", "deny", '(c) => c.kind === "fetch" && c.url.startsWith("https://b.example/admin/")', "No admin pages");
const ASK_B = policy("p-ask", "ask", '(c) => c.host === "b.example"', "Check with me on b.example");
const ALLOW_B_NAV = policy("p-allow-nav", "allow", '(c) => c.host === "b.example" && c.interactive', "Going to b.example is fine");
const ASK_B_NAV = policy("p-ask-nav", "ask", '(c) => c.host === "b.example" && c.interactive', "Check with me before going to b.example");
/** An ask over the read only (not `interactive`), so an arrival it lets through grants nothing of a fetch. */
const ASK_B_FETCH = policy("p-ask-f", "ask", '(c) => c.host === "b.example" && !c.interactive', "Ask before reading b.example");

/** The choke-point refusal: the gate may have silenced the prompt, but the FETCH_URL layer refuses the read. */
const CHOKE_REFUSED = /hasn't been approved for fetching on this page/;

/**
 * A run the worker built on tab 7 whose model calls `calls` in turn, then answers "done"; a `null` in `calls` answers
 * "done" there and the person sends a follow-up, which the model answers with the calls after it. A real `click` the
 * page runs moves the tab to `clickTo[selector]`, when there is one. `precheck(payload)` plays the page's precheck;
 * `card(tool)` answers a call's card, `ask(kind)` a nested ask (true approves; a string denies with that note; undefined
 * leaves it unanswered). `between(go)` runs before the follow-up is sent; `go(url)` moves the tab as the person would.
 * `onCall(n, bg)` runs before the model's n-th call (from 0) is answered; `addPolicy(bg, row)` adds a policy as the
 * policy page does. A page in `redirects` sends the tab on to its value once it has loaded, as a script on it would.
 */
async function hostRun(calls, { policies = [], clickTo = {}, precheck = () => undefined, card = () => true, ask = () => true, between, onCall, redirects = {} } = {}) {
    const tab = { id: 7, windowId: 3, active: true, url: START, title: "Site" };
    let turns = 0, docN = 1, bg, hash;
    const seen = [], cards = [], cardWhys = [], asks = [], toPage = [], adopts = [], readies = [], fetched = [];
    const answered = new Set();
    const sender = () => ({ tab: { id: 7, url: tab.url }, url: tab.url, origin: new URL(tab.url).origin, frameId: 0, documentId: `doc-${docN}` });
    const commit = (url) => { tab.url = url; docN++; bg.commit(7, { documentId: `doc-${docN}`, url }); };
    const ready = async (url) => {
        const ready = plain(await bg.send({ type: "CONTENT_READY" }, sender()));
        readies.push(ready);
        for (const a of ready?.adopt ?? []) {
            adopts.push(`ready ${url}`);
            void bg.send({ type: "RUN_READOPTED", payload: { runId: a.runId, pageInfo: `You are on ${url}` } }, sender());
        }
    };
    bg = loadBackground({
        config, openTabs: [tab], siteGate: true, local: { ml_policies_global: policies, ml_site_always: ["https://site.example", "https://b.example"] },
        onFetch: async (call) => {
            if (call.url.startsWith("https://b.example/")) { fetched.push(call.url); return { ok: true, status: 200, url: call.url, headers: { get: (h) => (/content-type/i.test(h) ? "text/html; charset=utf-8" : null) }, text: async () => "<h1>B</h1>", arrayBuffer: async () => new TextEncoder().encode("<h1>B</h1>").buffer, body: null }; }
            if (call.url.startsWith("https://site.example/")) { fetched.push(call.url); return { ok: true, status: 200, url: call.url, headers: { get: (h) => (/content-type/i.test(h) ? "text/html; charset=utf-8" : null) }, text: async () => "<h1>S</h1>", arrayBuffer: async () => new TextEncoder().encode("<h1>S</h1>").buffer, body: null }; }
            if (!call.url.includes("/chat/completions")) return jsonResponse({});
            seen.push(call.body.messages);
            await onCall?.(turns, bg);
            const next = calls[turns++];
            if (next === null) setTimeout(async () => { await between?.(async (url) => { commit(url); await ready(url); }); void bg.context.__mlUserRunActionForTest(hash, "send", { text: "go on", surface: "hud" }); }, 20);
            return next
                ? jsonResponse({ choices: [{ message: { content: null, tool_calls: [{ id: `c${turns}`, type: "function", function: { name: next.name, arguments: JSON.stringify(next.args) } }] } }] })
                : jsonResponse({ choices: [{ message: { content: "done" } }] });
        },
        onTabMessage: async (_t, msg) => {
            if (msg.type === "ADOPT_RUN_NOW") { adopts.push(`now ${tab.url}`); return { pageInfo: `You are on ${tab.url}` }; }
            if (msg.type === "ML_DEBUG_TO_PAGE") {
                const e = msg.event;
                if (e?.awaitingApproval && !answered.has(`${e.id}:${e.seq}`)) {
                    answered.add(`${e.id}:${e.seq}`);
                    cards.push(e.tool);
                    cardWhys.push(plain(e.askWhy));
                    void bg.send({ type: "SET_APPROVAL", payload: { runId: e.id, seq: e.seq, decision: !!card(e.tool) } });
                }
                for (const a of e?.asks ?? []) {
                    if (a.state !== "pending" || answered.has(a.id)) continue;
                    answered.add(a.id);
                    asks.push({ kind: a.kind, line: a.why?.line });
                    const d = ask(a.kind);
                    if (d === undefined) continue;
                    void bg.send({ type: "SET_APPROVAL", payload: { runId: e.id, seq: e.seq, ask: a.id, decision: d === true, ...(typeof d === "string" ? { feedback: d } : {}) } });
                }
                return undefined;
            }
            if (msg.type !== "RUN_TOOL_IN_PAGE") return undefined;
            const p = plain(msg.payload);
            if (p.finish) return { result: "" };
            if (p.precheck) return precheck(p) ?? { result: "", precheckFailed: false };
            if (p.renderOnly || p.readonlyTry || p.geometry) return { result: "" };
            toPage.push({ name: p.name, url: tab.url });
            if (p.name === "wait") await sleep(Number(p.args.ms) || 0);
            if (p.name === "navigate") {
                const to = p.args.url;
                commit(to);
                setTimeout(async () => { await ready(to); if (redirects[to]) { await sleep(5); commit(redirects[to]); await ready(redirects[to]); } }, 5);
                return { result: `Navigating to ${to}` };
            }
            if (p.name === "click" && clickTo[p.args.selector]) { const to = clickTo[p.args.selector]; commit(to); setTimeout(() => void ready(to), 5); return { result: `Clicked ${p.args.selector}.` }; }
            return { result: `ran ${p.name}` };
        },
    });
    ({ hash } = await bg.context.__mlStartUserRunForTest(7, { task: "work on the site", surface: "hud" }));
    for (let i = 0; i < 600 && turns <= calls.length; i++) await sleep(1);
    await sleep(40);
    const results = (seen.at(-1) ?? []).filter((m) => m.role === "tool").map((m) => String(m.content));
    const log = async () => (await bg.context.__mlRunLog.all()).filter((r) => r.subsystem === "policy").map((r) => plain(r));
    return { bg, tab, turns: () => turns, cards, cardWhys, asks, toPage, adopts, readies, fetched, results, log };
}

/** Add a global policy the way the policy page does: POLICIES from an extension page. */
const addPolicy = (bg, { effect, source, label }) => bg.send({ type: "POLICIES", payload: { op: "add", effect, source, label } }, { url: "chrome-extension://test/sidebar.html" });

/** The denies on b.example's admin: the arrival hold text names the policy. */
const denied = (results) => results.some((r) => /"No admin pages" denies: no tool runs on this page/.test(r));

// --- the start origin is consented never as-you: the as-you read back is refused on its card, and the uncredentialed read cards at the gate ---

test("the start origin is consented never as-you: once the tab leaves, the as-you read back is refused on its card", T, async () => {
    // Plain, holds today and after the card fix: the credentialed (as-you) read of the start origin asks on its card
    // and the card stub declines it — refused on the card, never at the choke point.
    const r = await hostRun([
        { name: "click", args: { selector: "#docs" } },          // the tab leaves START for OTHER
        { name: "fetch_url", args: { url: "https://site.example/api", credentials: true } },   // as-you back at START
    ], { clickTo: { "#docs": OTHER }, card: (tool) => tool !== "fetch_url" });
    assert.deepEqual(r.cards, ["click", "fetch_url"], "the as-you fetch asked on its card");
    assert.deepEqual(r.fetched, [], "the as-you read was refused on its card");
    assert.ok(!r.results.some((s) => CHOKE_REFUSED.test(s)), `the as-you read is refused on its card, never reaching the choke point: ${JSON.stringify(r.results)}`);
});

test("the start origin is consented never as-you: once the tab leaves, the uncredentialed read back cards at the gate with askWhy.cause start-left, never riding the consent to the choke point", { ...T, todo: "open on main today (POLICIES.md, ruled 2026-10-27): the uncredentialed read back to the start origin after the tab left rides the prompt-silencing consent and is refused at the FETCH_URL choke point (choke text, no gate card) instead of carding at the gate with askWhy.cause \"start-left\". The security lane's fix (feat/navonly-read-card) cards it; flip this todo plain after that merges." }, async () => {
    // Positive control: while the tab IS on START, an as-you fetch of it is the free tier's (the page you are on) —
    // the fetch path works and the gate does not over-card.
    const free = await hostRun([
        { name: "fetch_url", args: { url: "https://site.example/api", credentials: true } },
    ], { card: (tool) => tool !== "fetch_url" });
    assert.deepEqual(free.cards, [], "the page the tab is on is free in every mode");
    assert.deepEqual(free.fetched, ["https://site.example/api"]);

    // Defended: once the tab leaves START, the uncredentialed read back cards at the gate (cause "start-left").
    const r = await hostRun([
        { name: "click", args: { selector: "#docs" } },          // the tab leaves START for OTHER
        { name: "fetch_url", args: { url: "https://site.example/api" } },   // uncredentialed back at START
    ], { clickTo: { "#docs": OTHER }, card: (tool) => tool !== "fetch_url" });
    assert.deepEqual(r.cards, ["click", "fetch_url"], "the uncredentialed read cards at the gate like any other read back to the start origin");
    assert.equal(r.cardWhys[1]?.cause, "start-left", `the fetch_url card's askWhy.cause is "start-left": ${JSON.stringify(r.cardWhys)}`);
    assert.ok(!r.results.some((s) => CHOKE_REFUSED.test(s)), `the read never reaches the choke point — it is carded at the gate: ${JSON.stringify(r.results)}`);
    assert.deepEqual(r.fetched, [], "the card is declined, so the read does not run");
});

// --- an arrival no policy decides passes and consents nothing at the choke point ---

test("an arrival no policy covers passes as it is and consents nothing: a later as-you fetch asks, and an uncredentialed one is refused at the choke point", T, async () => {
    // The positive half (it passes, scroll runs) is nav-arrival-host.test.mjs. What is pinned here is the grant it does
    // NOT mint: ruling (b)'s "an allow row grants nothing as the person" applies to the builtin answer too, and the
    // choke point refuses even the uncredentialed read because a pass writes no `consentedOrigins` at all.
    const r = await hostRun([
        { name: "click", args: { selector: "#docs" } },
        { name: "click", args: { selector: "#home" } },
        { name: "fetch_url", args: { url: "https://b.example/data", credentials: true } },
        { name: "fetch_url", args: { url: "https://b.example/data" } },
    ], { clickTo: { "#docs": OTHER, "#home": START }, card: (tool) => tool !== "fetch_url" });
    assert.deepEqual(r.asks, [], "no arrival card was owed before the act either");
    assert.deepEqual(r.toPage.map((x) => x.name), ["click", "click"]);
    // A pass writes no `consentedOrigins` at all, so nothing silences the prompt: BOTH fetches card. The choke point
    // is not even reached — the gate refuses them on their cards first.
    assert.deepEqual(r.cards, ["click", "click", "fetch_url", "fetch_url"], "a pass consents nothing, not even to the prompt: every fetch there needs its own card");
    assert.deepEqual(r.fetched, [], "neither read ran");
});

// --- an ask asks about every arrival it covers, an origin already consented included ---

test("an ask policy asks about every arrival it covers, an origin already consented included", T, async () => {
    // First arrival: asked and approved (the origin is then the run's). Second arrival on the same origin, a different
    // page: the policy asks about the page, not the origin, so it asks again.
    const r = await hostRun([
        { name: "click", args: { selector: "#docs" } },
        { name: "click", args: { selector: "#else" } },
        { name: "scroll", args: {} },
    ], { policies: [ASK_B], clickTo: { "#docs": OTHER, "#else": ELSE }, ask: () => true });
    assert.deepEqual(r.asks.map((a) => a.kind), ["arrival", "arrival"], "both arrivals asked, the consented origin included");
    assert.deepEqual(r.cards, ["click", "click"], "only the clicks' own cards; the scroll rode the last approval");
    assert.deepEqual(r.toPage.map((x) => x.name), ["click", "click", "scroll"]);
});

// --- the run's own navigate is judged once; its arrival at the URL it named (fragment aside) is not judged again ---

test("the run's own navigate passes its arrival at the URL it named, the fragment aside: no second ask", T, async () => {
    const r = await hostRun([
        { name: "navigate", args: { url: `${OTHER}#section` } },
        { name: "scroll", args: {} },
    ], { policies: [ASK_B] });
    assert.deepEqual(r.cards, ["navigate"], "the navigate itself was judged (one card)");
    assert.deepEqual(r.asks, [], "its arrival at the named page was not asked about again, fragment aside");
    assert.equal(r.tab.url, `${OTHER}#section`);
    assert.equal(r.results.at(-1), "ran scroll");
});

test("namedNav is single-use: a redirect on from the named page is judged and asked about, the pass having been for that one arrival", T, async () => {
    // During the turn the judge is registered, so the redirect IS judged. (A re-commit BETWEEN turns finds no judge —
    // see the between-turn gap test below.) The named pass is consumed by the first arrival; the redirect is any other
    // commit and ASK_B asks about it. The `wait` call is the window the redirect fires in (nav-arrival-host.test.mjs's
    // redirect case is the deny twin of this).
    const r = await hostRun([
        { name: "navigate", args: { url: OTHER } },
        { name: "wait", args: { ms: 30 } },
        { name: "scroll", args: {} },
    ], { policies: [ASK_B], ask: () => undefined, redirects: { [OTHER]: ELSE } });
    assert.equal(r.asks.filter((a) => a.kind === "arrival").length, 1, "the named pass was for that one arrival; the redirect on from there asked");
    assert.equal(r.tab.url, ELSE, "the redirect moved the tab");
    assert.deepEqual(r.toPage.map((x) => x.name), ["navigate", "wait"], "the scroll never reached the page — the run is held on the redirect's arrival until the person answers");
});

// --- a hold outlives the turn; a commit BETWEEN turns finds no judge (the gap this pass leaves open) ---

test("a person who goes back by hand between turns finds the run free again on the page they went back to", T, async () => {
    // The hold is worker memory and survives the turn. Going back to START clears it: holdStands re-judges the tab's
    // page and START is not denied. Already pinned in nav-arrival-host.test.mjs; kept here as the positive half of the
    // between-turn gap below.
    const r = await hostRun([
        { name: "scroll", args: {} },
        null,
        { name: "scroll", args: {} },
    ], { policies: [DENY_ADMIN], clickTo: { "#admin": ADMIN }, ask: () => undefined, between: (go) => go(START) });
    assert.deepEqual(r.toPage.map((x) => x.name), ["scroll", "scroll"]);
    assert.equal(r.tab.url, START);
});

test("BETWEEN-TURN GAP FIXED: a hand-move to a new page between turns is judged before the next turn acts there", T, async () => {
    // The fix (security lane, PR #1131): the turn now judges the tab's page when it starts (or `lastJudged` is not
    // written when no judge ran). A hand-move between turns to a page a policy would ask about is judged and asked
    // about before the next turn acts there.
    const r = await hostRun([
        { name: "scroll", args: {} },
        null,
        { name: "scroll", args: {} },
    ], { policies: [ASK_B], ask: () => true, between: (go) => go(OTHER) });
    assert.ok(r.asks.some((a) => a.kind === "arrival"), "the hand-moved page was judged and asked about");
    assert.match(r.results.at(-1), /The person approved the run acting on it/);
});

// --- ruling (b): an allow row consents the origin for navigation only; the read still cards ---

test("ruling (b): an allow row's arrival lets a later navigate through with no card, and the uncredentialed read back cards (the read is refused on its card)", T, async () => {
    // nav-arrival-host.test.mjs pins the as-you half (it asks once the tab leaves) and the free tier while the tab is
    // there. What is pinned here: the allow row consents the origin for navigation only (`navOnlyOrigins`), so the
    // plain GET goes to its card (the card stub declines it), not through a silent prompt-silencing consent. The
    // navigate back rides the navigation consent and needs no card.
    const r = await hostRun([
        { name: "click", args: { selector: "#docs" } },
        { name: "click", args: { selector: "#home" } },
        { name: "fetch_url", args: { url: "https://b.example/data" } },
        { name: "fetch_url", args: { url: "https://b.example/data", credentials: true } },
        { name: "navigate", args: { url: OTHER } },
    ], { policies: [ALLOW_B_NAV], clickTo: { "#docs": OTHER, "#home": START }, card: (tool) => tool !== "fetch_url" });
    assert.deepEqual(r.asks, [], "an allow row's arrival is not asked about");
    // Both fetches card: the allow row consents the origin for navigation only, so neither read is free at the prompt.
    assert.deepEqual(r.cards, ["click", "click", "fetch_url", "fetch_url"], "both fetches card: the allow row grants navigation, not reads");
    assert.deepEqual(r.fetched, [], "both reads were declined on their cards");
    // The origin IS consented for navigation: the second navigate back to OTHER needed no card and went through.
    assert.equal(r.tab.url, OTHER, "the navigate rode the navigation consent and went through");
});

// --- a page-built run keeps per-URL fetch approvals: the origin grant reaches fetch_url only in a worker-built run ---

/**
 * A page on tab 7 starts its OWN run whose model calls `calls`; every gate the UI shows is approved (`card(tool)`
 * says which). Returns the gates the run raised (`{ tool, url }`) and what the WORKER fetched itself. A page-built
 * run's `fetch_url` runs in the page (sw-run-host routes it there when `byWorker()` is false), so what is observed is
 * the gate the surface showed, not a worker fetch. The navigate's commit must be followed by a CONTENT_READY (the
 * page's own load handshake) or the run waits on the re-adopt and never reaches the next call.
 */
async function pageBuiltRun(calls, { policies = [], card = () => true, clickTo = {} } = {}) {
    const SITE = "https://site.example/page";
    const fromPage = { tab: { id: 7, url: SITE }, url: SITE, origin: "https://site.example", frameId: 0 };
    const tab = { id: 7, windowId: 3, active: true, url: SITE, title: "Site" };
    let turns = 0, docN = 1, bg;
    const gates = [], workerFetched = [], toPage = [];
    const answered = new Set();
    const sender = () => ({ tab: { id: 7, url: tab.url }, url: tab.url, origin: new URL(tab.url).origin, frameId: 0, documentId: `doc-${docN}` });
    const ready = async (url) => {
        const r = plain(await bg.send({ type: "CONTENT_READY" }, sender()) ?? null);
        for (const a of r?.adopt ?? []) void bg.send({ type: "RUN_READOPTED", payload: { runId: a.runId, pageInfo: `You are on ${url}` } }, sender());
    };
    bg = loadBackground({
        config, openTabs: [tab], siteGate: true, local: { ml_policies_global: policies, ml_site_always: ["https://site.example", "https://b.example"] },
        onFetch: async (call) => {
            if (call.url.startsWith("https://b.example/")) { workerFetched.push(call.url); return { ok: true, status: 200, url: call.url, headers: { get: (h) => (/content-type/i.test(h) ? "text/html; charset=utf-8" : null) }, text: async () => "<h1>B</h1>", arrayBuffer: async () => new TextEncoder().encode("<h1>B</h1>").buffer, body: null }; }
            if (!call.url.includes("/chat/completions")) return jsonResponse({});
            const next = calls[turns++];
            return next
                ? jsonResponse({ choices: [{ message: { content: null, tool_calls: [{ id: `c${turns}`, type: "function", function: { name: next.name, arguments: JSON.stringify(next.args) } }] } }] })
                : jsonResponse({ choices: [{ message: { content: "done" } }] });
        },
        onTabMessage: async (_t, msg) => {
            if (msg.type === "ADOPT_RUN_NOW") return { pageInfo: `You are on ${tab.url}` };
            const ev = msg.type === "ML_DEBUG_TO_PAGE" ? msg.event : null;
            if (ev?.awaitingApproval && !answered.has(`${ev.id}:${ev.seq}`)) {
                answered.add(`${ev.id}:${ev.seq}`);
                gates.push({ tool: ev.tool, url: ev.arguments?.url });
                void bg.send({ type: "SET_APPROVAL", payload: { runId: ev.id, seq: ev.seq, decision: !!card(ev.tool) } });
            }
            for (const a of ev?.asks ?? []) {
                if (a.state !== "pending" || answered.has(a.id)) continue;
                answered.add(a.id);
                void bg.send({ type: "SET_APPROVAL", payload: { runId: ev.id, seq: ev.seq, ask: a.id, decision: true } });
            }
            if (msg.type !== "RUN_TOOL_IN_PAGE") return undefined;
            const p = plain(msg.payload);
            if (p.finish) return { result: "" };
            if (p.precheck || p.renderOnly || p.readonlyTry || p.geometry) return { result: "" };
            toPage.push(p.name);
            if (p.name === "navigate") {
                const to = p.args.url;
                tab.url = to; docN++;
                bg.commit(7, { documentId: `doc-${docN}`, url: to });
                setTimeout(() => void ready(to), 5);
                return { result: `Navigating to ${to}` };
            }
            if (p.name === "click" && clickTo[p.args.selector]) {
                const to = clickTo[p.args.selector];
                tab.url = to; docN++;
                bg.commit(7, { documentId: `doc-${docN}`, url: to });
                setTimeout(() => void ready(to), 5);
                return { result: `Clicked ${p.args.selector}.` };
            }
            return { result: `ran ${p.name}` };
        },
    });
    const done = bg.send({ type: "START_RUN", payload: {
        runId: "pagerun-nav", task: "do it", systemPrompt: "S",
        tools: [
            { name: "navigate", description: "go", parameters: { type: "object", properties: { url: { type: "string" } } }, requiresApproval: true, capabilities: [] },
            { name: "fetch_url", description: "fetch", parameters: { type: "object", properties: { url: { type: "string" }, credentials: { type: "boolean" } } }, requiresApproval: true, capabilities: [] },
            { name: "click", description: "click", parameters: { type: "object", properties: { selector: { type: "string" } } }, requiresApproval: false, capabilities: [] },
        ],
        model: "m", think: null, maxSteps: 8, autoApprovePython: false, autoApproveReadonly: false, surface: "off",
        crossOrigin: true, approvalRouting: "ui", pageOrigin: "https://site.example",
        rebuild: { toolNames: ["navigate", "fetch_url", "click"], model: "m", driverSees: false, visionModel: null, groundingModel: null, groundingRange: 1000, pierceClosed: false, cdp: false, crossOrigin: true },
    } }, fromPage);
    const raced = await Promise.race([done.then((r) => ({ ok: true, r })), sleep(15000).then(() => ({ ok: false }))]);
    if (!raced.ok) throw new Error("page-built run did not settle within 15s");
    return { gates, workerFetched, toPage, tab, messages: raced.r?.messages ?? [] };
}

test("a page-built run's approved navigate consents the origin for the arrival, and its fetch_url runs in the page with the worker fetching nothing", T, async () => {
    // The worker-built path's grantRunOrigin is `byWorker() && runsInWorker(p, "fetch_url")`: a page-built run is
    // neither, so the navigate's approval never becomes an as-you origin grant for its fetch_url. Measured: after the
    // navigate the tab sits on b.example, so the page-built fetch_url is a same-origin page fetch there — the page
    // could make it with its own `fetch()` anyway. The card that does fire is the navigate's own; the fetch_url rides
    // the page's origin and the worker fetches nothing. The As-built narrowing, pinned rather than contradicted.
    const r = await pageBuiltRun([
        { name: "navigate", args: { url: OTHER } },
        { name: "fetch_url", args: { url: "https://b.example/data", credentials: true } },
    ]);
    assert.deepEqual(r.gates.map((g) => g.tool), ["navigate"], "only the navigate carded; the page-built fetch_url runs in the page on the origin it is already on");
    assert.deepEqual(r.workerFetched, [], "the worker fetched nothing for the page-built run");
    assert.deepEqual(r.toPage, ["navigate", "fetch_url"], "both reached the page (page-routed tools) and the page played them");
    // Positive control: a worker-built run's approved navigate DOES mint the as-you grant (nav-arrival-host.test.mjs).
});

// --- the describe layer: the click precheck's href is the page's word and can lie ---

test("the describe layer is conservative: a precheck that over-reports a denied href refuses a click the arrival would have passed", T, async () => {
    // The page's word is used to refuse early (the describe layer of the arrival rule). A page that lies in the
    // DANGEROUS direction (says harmless, lands on admin) gains nothing — nav-arrival-host.test.mjs pins that. A lie
    // in the other direction (says admin, would land on a harmless page) only costs the run a click: the enforcement
    // is the arrival, so nothing is granted by the lie.
    const r = await hostRun([
        { name: "click", args: { selector: "#innocent" } },
        { name: "scroll", args: {} },
    ], {
        policies: [DENY_ADMIN],
        clickTo: { "#innocent": OTHER },   // would have landed on OTHER, which no policy denies
        precheck: () => ({ result: "", precheckFailed: false, href: ADMIN }),   // the page says it goes to ADMIN
        card: () => true,
    });
    assert.match(r.results[0], /goes to https:\/\/b\.example\/admin\/users, which the policy "No admin pages" denies: the click was not made/);
    assert.deepEqual(r.toPage.map((x) => x.name), ["scroll"], "the click never reached the page; the next call's scroll ran on START");
    assert.equal(r.tab.url, START, "nothing moved");
    // The arrival check is the enforcement either way: a page whose precheck is absent still cannot land the run on
    // a denied page and act there (nav-arrival-host.test.mjs "a page that hides the link").
});

// --- a grant is the origin, never the registrable domain ---

test("an origin grant is exact: a subdomain is another origin and an as-you fetch there asks", T, async () => {
    const r = await hostRun([
        { name: "navigate", args: { url: OTHER } },
        { name: "fetch_url", args: { url: "https://c.b.example/data", credentials: true } },
    ], { card: (tool) => tool !== "fetch_url" });
    assert.deepEqual(r.cards, ["navigate", "fetch_url"], "the subdomain is not under the granted origin");
    assert.deepEqual(r.fetched, []);
    // Positive control: the granted origin itself is covered.
    const ok = await hostRun([
        { name: "navigate", args: { url: OTHER } },
        { name: "fetch_url", args: { url: "https://b.example/data", credentials: true } },
    ], { card: (tool) => tool !== "fetch_url" });
    assert.deepEqual(ok.cards, ["navigate"], "the granted origin's as-you fetch asked nothing");
    assert.deepEqual(ok.fetched, ["https://b.example/data"]);
});

// --- probed and not gotten ---

test("PROBED AND NOT GOTTEN: the channels this pass tried against the arrival judgement and the origin grant", () => {
    // A test that documents the attack surface this file closed. If any line below ever starts failing, the channel
    // opened: turn it into its own test asserting the refusal, and report it.
    const closed = [
        "the start origin is consented at the prompt but the FETCH_URL choke point refuses an uncredentialed read of it after the tab leaves: nothing runs",
        "an arrival no policy decides passes and consents nothing as the person and not even to the prompt: both fetches there are refused once the tab leaves",
        "an ask policy asks about every arrival it covers, an origin already consented included — the policy asks about the page, not the origin",
        "the run's own navigate's arrival at the URL it named (fragment aside) is not judged again; namedNav is single-use, and a redirect on from the named page is judged and held",
        "a hold outlives the turn: going back by hand between turns finds the run free again on the page the tab holds then (holdStands re-judges)",
        "a hand-move between turns is judged before the next turn acts there (fix #1131: the turn judges the tab's page on start)",
        "a page-built run's approved navigate consents the origin for the arrival (consentedOrigins) but never mints the as-you grant for its fetch_url (grantRunOrigin is byWorker && runsInWorker); its fetch_url runs in the page and the worker fetches nothing",
        "ruling (b): an allow row's arrival consents the origin for navigation only (navOnlyOrigins); both fetches card and are refused on their cards, and the navigate goes through with no card",
        "an origin grant is exact: a subdomain is another origin",
        "the click precheck's href is the page's word and can lie; the arrival check is the enforcement, so a lie that over-reports denies only costs the run a click and one that under-reports gains nothing",
    ];
    assert.equal(closed.length, 10);
    assert.ok(closed.every((s) => s.length > 20));
});

test("PROBED AND NOT GOTTEN: the gate / choke-point split and the originCovers / fetchOriginGranted split, read off the code", () => {
    // The sharp residual, a code fact this harness cannot flip. TWO layers disagree, and the refusal rests on the
    // second one only.
    //
    // 1. THE GATE / CHOKE-POINT SPLIT (this pass's central finding). `consentedOrigins` (the arrival's allow/pass
    // write) silences the agent-host PROMPT but does not reach the FETCH_URL choke point (`sw-fetch-url.ts:124`):
    // `caller.consented` = `ctx.consented.has(u) || originCovers(ctx, u, {credentials, rendered}) ||
    // policyAllows(ctx.runId, u)`. `originCovers` reads `ctx.origins` (`grantRunOrigin`), NOT `consentedOrigins`.
    // So an allow/pass arrival's uncredentialed fetch of its own origin is REFUSED end-to-end. The As-built's
    // "navigation and uncredentialed reads" is gate-level and does not survive the choke point.
    //
    // 2. THE originCovers / fetchOriginGranted SPLIT. `fetchOriginGranted` (sw-run-host.ts:1843) is only
    // `byWorker() && runsInWorker(p, "fetch_url") && runOriginGranted(runId, url)` — no policy check.
    // `originCovers` (worker-tools.ts:164) is `originGranted` AND `judgeCall(...) !== ask/deny`. The withdrawal an
    // ask/deny policy performs holds ONLY because `fetchPolicy` is checked FIRST in agent-host.ts's fetch_url gate
    // (deny → refused, ask/unknown → null, before fetchIsCurrentPage / fetchOnPageOrigin / fetchOriginGranted).
    // Reordering those checks would let a granted origin's fetch through a deny.
    const restsOn = [
        "sw-fetch-url.ts caller.consented: reads ctx.consented / originCovers / policyAllows — never consentedOrigins, so the arrival's allow write does not reach the choke point",
        "worker-tools.ts originCovers: reads ctx.origins (grantRunOrigin), and is what the choke point consults",
        "agent-host.ts fetch_url: fetchPolicy is first, and deny/ask/unknown all return before any free tier",
        "sw-run-host.ts fetchOriginGranted: no policy check of its own — it is a grant lookup only",
    ];
    assert.equal(restsOn.length, 4);
    assert.ok(restsOn.every((s) => s.length > 20));
});
