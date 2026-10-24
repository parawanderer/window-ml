// nav-arrival-host.test.mjs — a run whose tab arrives on a page it did not name: the run host judges the commit and holds,
// asks about or lets the run on (src/sw/nav-arrival.ts, src/sw/sw-run-host.ts; docs/spec/POLICIES.md, "A navigation the
// model did not name is judged on arrival"), and a click on a link a policy denies is refused before it is made.
//
// The built worker in node:vm (tests/helpers.js `loadBackground`): a run the worker built on tab 7 whose model is
// scripted. A click the page answers by moving the tab is the browser's commit (`bg.commit`), then the destination's
// CONTENT_READY, as content.ts sends it. The person answers cards through SET_APPROVAL, as the surfaces do.
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
const config = { chatUrl: "http://host/api/chat/completions", apiKey: "sk-test", model: "default-model", apiFormat: "openai", ocrModel: "", debugMode: "off", autoApproveReadonly: true };

/** A saved global policy over fetch, as the policy page stores one. */
const policy = (id, effect, source, label) => ({ id, scope: "global", consumer: "fetch", effect, source, label, origin: "person", created: 1760000000000 });
const DENY_ADMIN = policy("p-deny", "deny", '(c) => c.kind === "fetch" && c.url.startsWith("https://b.example/admin/")', "No admin pages");
const ASK_B = policy("p-ask", "ask", '(c) => c.host === "b.example"', "Check with me on b.example");
const ALLOW_B = policy("p-allow", "allow", '(c) => c.host === "b.example"', "b.example is fine");
// Over the navigation only (`interactive`), so a later fetch_url there meets no policy, only what the arrival granted.
const ASK_B_NAV = policy("p-ask-nav", "ask", '(c) => c.host === "b.example" && c.interactive', "Check with me before going to b.example");
const ALLOW_B_NAV = policy("p-allow-nav", "allow", '(c) => c.host === "b.example" && c.interactive', "Going to b.example is fine");
/** The adopts on b.example: the run's own adopt on its start page is not one. */
const onB = (adopts) => adopts.filter((a) => a.includes("b.example"));

/**
 * A run the worker built on tab 7 whose model calls `calls` in turn, then answers "done"; a `null` in `calls` answers "done"
 * there and the person sends a follow-up, which the model answers with the calls after it. A real `click` the page runs moves
 * the tab to `clickTo[selector]`, when there is one. `precheck(payload)` plays the page's precheck; `card(tool)` answers a
 * call's card, `ask(kind)` a nested ask (true approves; a string denies with that note; undefined leaves it unanswered).
 * `between(go)` runs before the follow-up is sent; `go(url)` moves the tab as the person would.
 */
async function hostRun(calls, { policies = [], clickTo = {}, precheck = () => undefined, card = () => true, ask = () => true, between } = {}) {
    const tab = { id: 7, windowId: 3, active: true, url: START, title: "Site" };
    let turns = 0, docN = 1, bg, hash;
    const seen = [], cards = [], asks = [], toPage = [], adopts = [], readies = [], fetched = [];
    const answered = new Set();
    const sender = () => ({ tab: { id: 7, url: tab.url }, url: tab.url, origin: new URL(tab.url).origin, frameId: 0, documentId: `doc-${docN}` });
    // The browser commits the destination; `ready` is the new document's content script saying so, which must not be
    // awaited inside the call that navigated (CONTENT_READY waits on the run that call belongs to).
    const commit = (url) => { tab.url = url; docN++; bg.commit(7, { documentId: `doc-${docN}`, url }); };
    const ready = async (url) => {
        const ready = plain(await bg.send({ type: "CONTENT_READY" }, sender()));
        readies.push(ready);
        // The destination re-registers each run it was handed, then says so (content.ts), which releases the barrier.
        for (const a of ready?.adopt ?? []) {
            adopts.push(`ready ${url}`);
            await bg.send({ type: "RUN_READOPTED", payload: { runId: a.runId, pageInfo: `You are on ${url}` } }, sender());
        }
    };
    bg = loadBackground({
        config, openTabs: [tab], siteGate: true, local: { ml_policies_global: policies, ml_site_always: ["https://site.example", "https://b.example"] },
        onFetch: (call) => {
            if (call.url.startsWith("https://b.example/")) { fetched.push(call.url); return { ok: true, status: 200, url: call.url, headers: { get: (h) => (/content-type/i.test(h) ? "text/html; charset=utf-8" : null) }, text: async () => "<h1>B</h1>", arrayBuffer: async () => new TextEncoder().encode("<h1>B</h1>").buffer, body: null }; }
            if (!call.url.includes("/chat/completions")) return jsonResponse({});
            seen.push(call.body.messages);
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
                    void bg.send({ type: "SET_APPROVAL", payload: { runId: e.id, seq: e.seq, decision: !!card(e.tool) } });
                }
                for (const a of e?.asks ?? []) {
                    if (a.state !== "pending" || answered.has(a.id)) continue;
                    answered.add(a.id);
                    asks.push({ kind: a.kind, line: a.why?.line });
                    const d = ask(a.kind);
                    if (d === undefined) continue;   // left on screen, unanswered
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
            // A click on a link commits before its answer reaches the worker; the destination reports ready after.
            if (p.name === "navigate") { commit(p.args.url); setTimeout(() => void ready(p.args.url), 5); return { result: `Navigating to ${p.args.url}` }; }
            if (p.name === "click" && clickTo[p.args.selector]) { const to = clickTo[p.args.selector]; commit(to); setTimeout(() => void ready(to), 5); return { result: `Clicked ${p.args.selector}.` }; }
            return { result: `ran ${p.name}` };
        },
    });
    ({ hash } = await bg.context.__mlStartUserRunForTest(7, { task: "work on the site", surface: "hud" }));
    for (let i = 0; i < 600 && turns <= calls.length; i++) await sleep(1);
    await sleep(40);
    const results = (seen.at(-1) ?? []).filter((m) => m.role === "tool").map((m) => String(m.content));
    const log = async () => (await bg.context.__mlRunLog.all()).filter((r) => r.subsystem === "policy").map((r) => plain(r));
    return { bg, tab, turns: () => turns, cards, asks, toPage, adopts, readies, fetched, results, log };
}

// --- a deny: the run is held on the page, and the person is offered to go back or end the run ---

test("a click that lands on a page a policy denies holds the run there: its next call is refused with the policy named and reaches no page", T, async () => {
    const r = await hostRun([
        { name: "click", args: { selector: "#admin" } },
        { name: "scroll", args: { direction: "down" } },
        { name: "click", args: { selector: "#delete" } },
    ], { policies: [DENY_ADMIN], clickTo: { "#admin": ADMIN }, ask: () => undefined });
    assert.deepEqual(r.toPage, [{ name: "click", url: START }], "nothing of the run ran on the denied page");
    assert.match(r.results[1], /^The tab is now on https:\/\/b\.example\/admin\/users, which the policy "No admin pages" denies: no tool runs on this page\./);
    assert.match(r.results[2], /"No admin pages" denies/, "a gated call is refused the same way, before any card");
    assert.deepEqual(r.cards, ["click"], "only the first click asked; the refused one showed no card");
    assert.equal(r.asks.filter((a) => a.kind === "arrival-denied").length, 1, "one deny card, not one per call");
    assert.match(r.asks[0].line, /^The run arrived on https:\/\/b\.example\/admin\/users, which the policy "No admin pages" denies\./);
    assert.deepEqual(onB(r.adopts), [], "the run was not re-adopted on the denied page, not even once its turn ended");
    assert.deepEqual(r.readies.at(-1)?.adopt ?? [], [], "CONTENT_READY did not hand the page the run");
    assert.ok((await r.log()).some((x) => x.kind === "arrival-denied"), "the run log says why");
});

test("Go back on the deny card takes the tab back, and End run stops the run", T, async () => {
    const back = await hostRun([{ name: "click", args: { selector: "#admin" } }, { name: "scroll", args: {} }], { policies: [DENY_ADMIN], clickTo: { "#admin": ADMIN }, ask: () => true });
    await sleep(20);
    assert.deepEqual([...back.bg.tabsBack], [7], "Go back");
    const end = await hostRun([{ name: "click", args: { selector: "#admin" } }, { name: "scroll", args: {} }, { name: "scroll", args: {} }, { name: "scroll", args: {} }], { policies: [DENY_ADMIN], clickTo: { "#admin": ADMIN }, ask: () => false });
    assert.deepEqual([...end.bg.tabsBack], [], "End run does not go back");
    assert.ok(end.turns() < 5, `the run was stopped before its model answered (${end.turns()} model calls)`);
});

test("a turn that ends on a page a policy denies leaves the run held: the person's follow-up there runs nothing on the page", T, async () => {
    const r = await hostRun([
        { name: "click", args: { selector: "#admin" } },
        null,
        { name: "scroll", args: {} },
    ], { policies: [DENY_ADMIN], clickTo: { "#admin": ADMIN }, ask: () => undefined });
    assert.equal(r.turns(), 4, "the follow-up turn ran");
    assert.deepEqual(r.toPage, [{ name: "click", url: START }], "the follow-up's scroll never reached the denied page");
    assert.match(r.results.at(-1), /"No admin pages" denies: no tool runs on this page/);
    assert.deepEqual(onB(r.adopts), []);
});

test("a person who goes back by hand between turns finds the run free again on the page they went back to", T, async () => {
    const r = await hostRun([
        { name: "click", args: { selector: "#admin" } },
        null,
        { name: "scroll", args: {} },
    ], { policies: [DENY_ADMIN], clickTo: { "#admin": ADMIN }, ask: () => undefined, between: (go) => go(START) });
    assert.deepEqual(r.toPage, [{ name: "click", url: START }, { name: "scroll", url: START }]);
    assert.equal(r.results.at(-1), "ran scroll");
});

// --- an ask: the run waits for the person ---

test("an arrival a policy asks about waits for the person: Approve re-adopts the run there and the waiting call runs with the answer ahead of its result", T, async () => {
    const r = await hostRun([
        { name: "click", args: { selector: "#docs" } },
        { name: "scroll", args: {} },
    ], { policies: [ASK_B], clickTo: { "#docs": OTHER }, ask: () => true });
    assert.equal(r.asks.length, 1);
    assert.equal(r.asks[0].kind, "arrival");
    assert.match(r.asks[0].line, /^The run arrived on https:\/\/b\.example, a page it did not open by name\. Asking because the policy "Check with me on b\.example" asks about pages like this\.$/);
    assert.ok(onB(r.adopts).length >= 1, "approved: the run is adopted on the page");
    assert.deepEqual(r.toPage.map((x) => x.name), ["click", "scroll"]);
    assert.match(r.results[1], /^The tab moved to https:\/\/b\.example, .*The person approved the run acting on it\./);
    assert.match(r.results[1], /ran scroll$/);
});

test("Deny on an arrival ask takes the tab back, the waiting call does not reach the page, and the model reads the person's note", T, async () => {
    const r = await hostRun([
        { name: "click", args: { selector: "#docs" } },
        { name: "scroll", args: {} },
    ], { policies: [ASK_B], clickTo: { "#docs": OTHER }, ask: () => "not that site" });
    await sleep(20);
    assert.deepEqual([...r.bg.tabsBack], [7]);
    assert.deepEqual(r.toPage.map((x) => x.name), ["click"], "the scroll never ran on the asked page");
    assert.match(r.results[1], /The person declined, and the tab went back to the page before\. They said: not that site/);
    assert.deepEqual(onB(r.adopts), []);
});

test("an approved arrival is the person's grant of the origin: a later as-you fetch_url there asks nothing", T, async () => {
    const r = await hostRun([
        { name: "click", args: { selector: "#docs" } },
        { name: "fetch_url", args: { url: "https://b.example/data", credentials: true } },
    ], { policies: [ASK_B_NAV], clickTo: { "#docs": OTHER }, ask: () => true });
    assert.deepEqual(r.cards, ["click"], "the fetch rode the arrival's approval, with no card of its own");
    assert.deepEqual(r.fetched, ["https://b.example/data"]);
});

test("an origin the person approved a navigate to is theirs for the rest of the run: a later turn navigates back there with no card", T, async () => {
    const r = await hostRun([
        { name: "navigate", args: { url: OTHER } },
        { name: "navigate", args: { url: START } },
        null,
        { name: "navigate", args: { url: OTHER } },
    ], {});
    assert.equal(r.turns(), 5, "the follow-up turn ran");
    assert.deepEqual(r.cards, ["navigate"], "only the first navigate to b.example asked");
});

// --- an allow, and no policy at all ---

test("RED TEAM (ruling (b)): an allow row lets the arrival through with no card, but grants nothing as the person: once the tab leaves, an as-you fetch back there asks", T, async () => {
    // While the tab is ON b.example, an as-you fetch of it is the free tier's (the page you are on), whatever let the
    // tab get there. What (b) withholds is the grant: the origin is not the run's as-you origin after the tab leaves.
    const r = await hostRun([
        { name: "click", args: { selector: "#docs" } },
        { name: "scroll", args: {} },
        { name: "click", args: { selector: "#home" } },
        { name: "fetch_url", args: { url: "https://b.example/data", credentials: true } },
    ], { policies: [ALLOW_B_NAV], clickTo: { "#docs": OTHER, "#home": START }, card: (tool) => tool !== "fetch_url" });
    assert.deepEqual(r.asks, [], "no arrival card");
    assert.deepEqual(r.toPage.map((x) => x.name), ["click", "scroll", "click"]);
    assert.deepEqual(r.cards, ["click", "click", "fetch_url"], "the as-you fetch went to the person");
    assert.deepEqual(r.fetched, [], "refused on its card, it read nothing");
});

test("against it: an arrival the person approved IS the as-you grant, after the tab leaves too", T, async () => {
    const r = await hostRun([
        { name: "click", args: { selector: "#docs" } },
        { name: "click", args: { selector: "#home" } },
        { name: "fetch_url", args: { url: "https://b.example/data", credentials: true } },
    ], { policies: [ASK_B_NAV], clickTo: { "#docs": OTHER, "#home": START }, ask: () => true });
    assert.deepEqual(r.cards, ["click", "click"], "no card for the fetch");
    assert.deepEqual(r.fetched, ["https://b.example/data"]);
});

test("an arrival no policy covers passes as it is: no card, no hold", T, async () => {
    const r = await hostRun([{ name: "click", args: { selector: "#docs" } }, { name: "scroll", args: {} }], { clickTo: { "#docs": OTHER } });
    assert.deepEqual(r.asks, []);
    assert.deepEqual(r.toPage.map((x) => x.name), ["click", "scroll"]);
    assert.equal(r.results[1], "ran scroll");
});

// --- the describe layer: a link a policy denies is refused before the click ---

test("a click on a link a policy denies is refused before any card or click, the policy named; a link no policy denies goes to its card", T, async () => {
    const hrefs = { "#admin-link": ADMIN, "#docs-link": OTHER };
    const r = await hostRun([
        { name: "click", args: { selector: "#admin-link" } },
        { name: "click", args: { selector: "#docs-link" } },
    ], { policies: [DENY_ADMIN], precheck: (p) => (hrefs[p.args.selector] ? { result: "", precheckFailed: false, href: hrefs[p.args.selector] } : undefined) });
    assert.equal(r.results[0], 'The link this click follows goes to https://b.example/admin/users, which the policy "No admin pages" denies: the click was not made.');
    assert.deepEqual(r.cards, ["click"], "only the allowed link's click was carded");
    assert.deepEqual(r.toPage.map((x) => x.name), ["click"], "only the allowed link was clicked");
    assert.ok((await r.log()).some((x) => x.kind === "deny" && x.detail?.tool === "click"));
});

test("RED TEAM: a page that hides the link from the precheck gains nothing: the click lands and the arrival is held", T, async () => {
    const r = await hostRun([
        { name: "click", args: { selector: "#innocent" } },
        { name: "scroll", args: {} },
    ], { policies: [DENY_ADMIN], clickTo: { "#innocent": ADMIN }, precheck: () => ({ result: "", precheckFailed: false, href: "https://site.example/harmless" }), ask: () => undefined });
    assert.deepEqual(r.toPage.map((x) => x.name), ["click"]);
    assert.match(r.results[1], /"No admin pages" denies: no tool runs on this page/);
});
