// propose-policy-multi-redteam.test.mjs — the red team's pin on `propose_policy`'s SEVERAL-RULES form (#1332): what a
// proposal of n rows must never do (src/sw/policy-proposal.ts, src/sw/sw-policies.ts, src/sw/sw-run-host.ts, the tool
// in src/tools/propose-policy-tool.ts; docs/spec/POLICIES.md, "Worked example and acceptance test").
//
// Four things a hostile or careless proposal must not get, one section each:
//   (a) a row dropped, or reordered behind an allow, by the order the model sent them in;
//   (b) a row smuggled past PROPOSAL_ROWS_MAX;
//   (c) a repeated row rewriting the label a stored policy is shown under;
//   (d) a card that approves more than it shows (or tells the model it added more than it did).
// The properties are asserted as invariants over ENUMERATED inputs (every order of a 3-row set, every non-list shape),
// not sampled: a rule that validates another rule's output is checked against the inputs the decision is about.
//
// A run the worker built on tab 7 with a scripted model; the page is played by `onTabMessage`. The merged
// tests/propose-policy.test.mjs covers the feature's own acceptance; this file covers what it must refuse.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { jsonResponse, loadBackground } = require("./helpers");
const PP = await import("../src/sw/policy-proposal.ts");

const T = { timeout: 15000 };
const config = { chatUrl: "http://host/api/chat/completions", apiKey: "sk-test", model: "default-model", apiFormat: "openai", ocrModel: "", debugMode: "off", autoApproveReadonly: true };
const SITE = { id: 7, url: "https://site.example/page", title: "Site" };
/** The Settings panel, as the browser describes an extension page sending a message. */
const EXT_PAGE = { url: "chrome-extension://test/sidebar.html" };
const BODY = "<h1>OTHER SITE</h1>";
const MAX = PP.PROPOSAL_ROWS_MAX;

/** An allow that matches EVERY url of the site the run reads: broad enough to cover the deny's URLs too. */
const ALLOW_SITE = { effect: "allow", when: '(c) => c.url.startsWith("https://other.example/")', label: "Read other.example" };
/** A deny under it: the one row a broader allow must never be able to swallow. */
const DENY_ADMIN = { effect: "deny", when: '(c) => c.url.startsWith("https://other.example/admin/")', label: "Never read other.example/admin" };
/** A row that matches nothing this run does: stored all the same — the person approved a rule, not its usefulness. */
const INERT = { effect: "deny", when: '(c) => c.host === "never-used.example"', label: "Never read never-used.example" };
/** An ask over the same URLs the allow below covers: an ask beats an allow, whichever came first. */
const ASK_SITE = { effect: "ask", when: '(c) => c.url.startsWith("https://other.example/")', label: "Check with me about other.example" };

/** Every run policy the worker holds, as the policy page lists them. Through JSON: the arrays come from the
 *  background's `node:vm` context, whose Array.prototype is not this file's, so `deepEqual` would fail on equal contents. */
async function runPolicies(bg) {
    const r = await bg.send({ type: "POLICIES", payload: {} }, EXT_PAGE);
    return JSON.parse(JSON.stringify(r.data.runs.flatMap((x) => x.policies)));
}

/**
 * A run the worker built on tab 7 whose model calls `calls` in turn, then answers. Each card is answered by
 * `answer(tool)` (true approves). `local` seeds the extension's own storage (a stored global policy, for (a)).
 * @returns the card shown per call, the model's tool results, and what was fetched
 */
async function workerRun(calls, { answer = () => true, local = {} } = {}) {
    let turns = 0, bg;
    const cards = [];
    const seen = [];
    bg = loadBackground({
        config, openTabs: [SITE], siteGate: true, local,
        onFetch: (call) => {
            if (call.url.startsWith("https://other.example/")) return { ok: true, status: 200, url: call.url, headers: { get: (h) => (/content-type/i.test(h) ? "text/plain; charset=utf-8" : null) }, text: async () => BODY, arrayBuffer: async () => new TextEncoder().encode(BODY).buffer, body: null };
            if (!call.url.includes("/chat/completions")) return jsonResponse({});
            seen.push(call.body.messages);
            const next = calls[turns++];
            return next
                ? jsonResponse({ choices: [{ message: { content: null, tool_calls: [{ id: `c${turns}`, type: "function", function: { name: next.name, arguments: JSON.stringify(next.args) } }] } }] })
                : jsonResponse({ choices: [{ message: { content: "done" } }] });
        },
        onTabMessage: async (_t, msg) => {
            if (msg.type === "ADOPT_RUN_NOW") return { pageInfo: "" };
            if (msg.type === "ML_DEBUG_TO_PAGE" && msg.event?.awaitingApproval) {
                cards.push({ tool: msg.event.tool, renderIn: JSON.parse(JSON.stringify(msg.event.renderIn ?? null)) });
                void bg.send({ type: "SET_APPROVAL", payload: { runId: msg.event.id, seq: msg.event.seq, decision: !!answer(msg.event.tool) } });
            }
            if (msg.type === "RUN_TOOL_IN_PAGE") return msg.payload.finish ? { result: "" } : {};
            return undefined;
        },
    });
    await bg.context.__mlStartUserRunForTest(7, { task: "read the other site", surface: "hud" });
    for (let i = 0; i < 400 && turns <= calls.length; i++) await new Promise((r) => setTimeout(r, 0));
    for (let i = 0; i < 30; i++) await new Promise((r) => setTimeout(r, 0));
    const results = (seen.at(-1) ?? []).filter((m) => m.role === "tool").map((m) => m.content);
    const fetched = bg.calls.filter((c) => c.url.startsWith("https://other.example/")).map((c) => c.url);
    return { bg, cards, results, fetched };
}

/** A proposal's rows as the checked list names them: `effect|source`, which is what the store and the card both use. */
const ids = (rows) => rows.map((q) => `${q.effect}|${q.source}`);
/** The same ids for rows as the MODEL wrote them, whose code is `when` rather than the stored `source`. */
const sent = (rules) => rules.map((r) => `${r.effect}|${r.when}`);
/** Every order of `xs`, enumerated rather than sampled: the invariants below are over the WHOLE set of orders, so a
 *  hand-written list of four is the wrong shape for the claim (a review found exactly that). */
const permutations = (xs) => (xs.length <= 1 ? [xs] : xs.flatMap((x, i) => permutations([...xs.slice(0, i), ...xs.slice(i + 1)]).map((rest) => [x, ...rest])));

// --- (a) no row is dropped, or reordered behind an allow, by the order the model sent them ---

test("(a) checkProposals returns every row, in the order sent, for every order of a deny, an inert row and an ask", () => {
    const rows = [ALLOW_SITE, INERT, DENY_ADMIN];
    const orders = permutations([0, 1, 2]);
    assert.equal(orders.length, 6, "the enumeration itself: a 3-row set has six orders");
    for (const order of orders) {
        const c = PP.checkProposals({ rules: order.map((i) => rows[i]) });
        assert.ok("proposals" in c, `order ${order} refused: ${JSON.stringify(c).slice(0, 120)}`);
        assert.deepEqual(ids(c.proposals), order.map((i) => `${rows[i].effect}|${rows[i].when}`), `order ${order} was not kept as sent`);
        assert.equal(c.proposals.length, 3, `a row was dropped in order ${order}`);
    }
});

test("(a) the store holds every row of an approved proposal, in send order, including one that matches nothing", T, async () => {
    // Both orders, because precedence that depends on position is exactly what a reader cannot see on the card.
    for (const rules of [[ALLOW_SITE, INERT, DENY_ADMIN], [DENY_ADMIN, INERT, ALLOW_SITE]]) {
        const { bg } = await workerRun([{ name: "propose_policy", args: { rules } }]);
        const pols = await runPolicies(bg);
        assert.deepEqual(ids(pols), rules.map((r) => `${r.effect}|${r.when}`), `stored rows (${rules[0].effect} first) are not the rows sent, in order`);
        assert.ok(pols.every((p) => p.origin === "proposed"), "every row is stored as the proposal's");
    }
});

test("(a) an ask row beats a broader allow over the same URLs in either order: the call asks, it is not auto-approved", T, async () => {
    // The allow ALONE auto-approves the same call — measured, and the control the row needs: without it, a fetch card
    // that appears with no policy stored at all (the default) reads exactly like the ask winning.
    const alone = await workerRun([
        { name: "propose_policy", args: { rules: [ALLOW_SITE] } },
        { name: "fetch_url", args: { url: "https://other.example/x" } },
    ]);
    assert.deepEqual(alone.cards.map((c) => c.tool), ["propose_policy"], "the control: the stored allow auto-approves the call, so the fetch shows no card");
    assert.equal(alone.fetched.length, 1, "the control: and the call was made");
    for (const rules of [[ALLOW_SITE, ASK_SITE], [ASK_SITE, ALLOW_SITE]]) {
        const { bg, cards, fetched } = await workerRun([
            { name: "propose_policy", args: { rules } },
            { name: "fetch_url", args: { url: "https://other.example/x" } },
        ]);
        assert.deepEqual(ids(await runPolicies(bg)), sent(rules), `the store holds both rows (${rules[0].effect} first)`);
        assert.equal(fetched.length, 1, `the call was made with ${rules[0].effect} first`);
        assert.deepEqual(cards.map((c) => c.tool), ["propose_policy", "fetch_url"], `an allow overrode the ask (${rules[0].effect} first) — the ask is the person's question and nothing beats it`);
    }
});

test("(a) a row identical to a stored GLOBAL policy is still stored on the run: a proposal is never dropped as redundant", T, async () => {
    const GLOBAL = { id: "pol-g", scope: "global", consumer: "fetch", effect: "allow", source: ALLOW_SITE.when, label: "Read other.example (saved in Settings)", origin: "person", created: 1 };
    const { bg, results } = await workerRun([{ name: "propose_policy", args: { rules: [ALLOW_SITE] } }], { local: { ml_policies_global: [GLOBAL] } });
    const pols = await runPolicies(bg);
    assert.equal(pols.length, 1, "the run's own row exists beside the global one");
    assert.equal(pols[0].label, ALLOW_SITE.label, "and it is the label the person just approved on the card, not the global row's");
    assert.match(String(results[0]), /^Added for this run: "Read other\.example"/);
});

// --- (b) no row smuggled past PROPOSAL_ROWS_MAX ---

test("(b) every non-list shape and every list over the cap is refused whole, and exactly MAX rows is not", T, async () => {
    const row = (i) => ({ ...ALLOW_SITE, when: `(c) => c.url.startsWith("https://other.example/p${i}/")`, label: `Read p${i}` });
    const over = [
        ["MAX+1 distinct rows", Array.from({ length: MAX + 1 }, (_, i) => row(i))],
        ["MAX+1 copies of one row", Array(MAX + 1).fill(ALLOW_SITE)],
        ["a sparse array of MAX+1", Array(MAX + 1)],
        ["an array-like object of 2", { length: 2, 0: ALLOW_SITE, 1: ALLOW_SITE }],
        ["a string", "x"],
        ["null", null],
        ["an empty list", []],
        ["a list of lists", [[ALLOW_SITE]]],
        ["a list holding a null", [ALLOW_SITE, null]],
        ["one row beside the one-rule fields", { rules: [ALLOW_SITE], label: "x", when: ALLOW_SITE.when, effect: "allow" }],
    ];
    for (const [what, rules] of over) assert.ok("error" in PP.checkProposals({ rules }), `${what} was accepted`);
    // The boundary's other side: MAX distinct rows is a whole proposal, each row kept.
    const ok = PP.checkProposals({ rules: Array.from({ length: MAX }, (_, i) => row(i)) });
    assert.ok("proposals" in ok, "MAX rows was refused");
    assert.deepEqual(ids(ok.proposals), Array.from({ length: MAX }, (_, i) => `allow|${row(i).when}`), "MAX rows, in order");
    // The number the model is TOLD and the number the worker ENFORCES are one number: a disagreement is a row's
    // easiest way past the cap (the model is refused where the schema says it is fine, or the schema invites more).
    const { proposePolicyTool } = await import("../src/tools/propose-policy-tool.ts");
    assert.equal(proposePolicyTool((d) => d).parameters.properties.rules.maxItems, MAX);
});

test("(b) a MAX+1 proposal in a run shows no card, adds nothing, and tells the model the cap", T, async () => {
    const rules = Array.from({ length: MAX + 1 }, (_, i) => ({ ...ALLOW_SITE, when: `(c) => c.url.startsWith("https://other.example/p${i}/")`, label: `Read p${i}` }));
    const { bg, cards, results } = await workerRun([{ name: "propose_policy", args: { rules } }]);
    assert.deepEqual(cards, [], "a card was shown for an over-cap proposal");
    assert.match(String(results[0]), new RegExp(`^Error: "rules" holds ${MAX + 1} rules; at most ${MAX}`), `the model read ${JSON.stringify(results[0]).slice(0, 120)}`);
    assert.equal((await runPolicies(bg)).length, 0, "rows got in without a card");
});

// --- (c) a repeated row keeps the label it was stored under ---

test("(c) repeating a stored rule with a new label changes no stored label, adds no second row, and says so", T, async () => {
    const { bg, cards, results } = await workerRun([
        { name: "propose_policy", args: { rules: [ALLOW_SITE] } },
        { name: "propose_policy", args: { rules: [{ ...ALLOW_SITE, label: "Everything, always" }] } },
    ]);
    assert.deepEqual(cards.map((c) => c.tool), ["propose_policy", "propose_policy"], "positive control: both proposals were put to the person");
    const pols = await runPolicies(bg);
    assert.equal(pols.length, 1, "the repeated rule was stored twice");
    assert.equal(pols[0].label, ALLOW_SITE.label, "the stored label was rewritten by the repeat");
    assert.match(String(results[1]), /the run already held the rule "Read other\.example", so "Everything, always" was not kept/, `the model was not told: ${JSON.stringify(results[1]).slice(0, 200)}`);
});

test("(c) the same source with another EFFECT is a second row, not a rewrite: the earlier label survives and the deny wins", T, async () => {
    // ONE source across the two effects: with the deny on its own narrower source, `ids` already differs on `source`
    // alone and the row would hold whether or not the store keys by effect (a review measured the pair, not the key).
    const DENY_SAME = { effect: "deny", when: ALLOW_SITE.when, label: "Never auto-read other.example" };
    const { bg, results } = await workerRun([
        { name: "propose_policy", args: { rules: [ALLOW_SITE] } },
        { name: "propose_policy", args: { rules: [DENY_SAME] } },
        { name: "fetch_url", args: { url: "https://other.example/x" } },
    ]);
    const pols = await runPolicies(bg);
    assert.deepEqual(pols.map((p) => [p.effect, p.source]), [["allow", ALLOW_SITE.when], ["deny", ALLOW_SITE.when]], "the store did not key the two rows by effect as well as by source");
    assert.equal(pols[0].label, ALLOW_SITE.label, "the allow keeps its own label");
    assert.equal(pols[1].label, DENY_SAME.label, "the deny keeps its own");
    assert.match(String(results[2]), /^(Denied|Refused) by/, "the deny did not beat the allow on a URL both rows match");
});

test("(c) a narrow deny under a broader allow is stored beside it and wins on the URLs it names alone", T, async () => {
    const { bg, results, fetched } = await workerRun([
        { name: "propose_policy", args: { rules: [ALLOW_SITE, DENY_ADMIN] } },
        { name: "fetch_url", args: { url: "https://other.example/admin/x" } },
        { name: "fetch_url", args: { url: "https://other.example/x" } },
    ]);
    assert.deepEqual(ids(await runPolicies(bg)), sent([ALLOW_SITE, DENY_ADMIN]), "the narrow deny was swallowed by the broader allow at store time");
    assert.match(String(results[1]), /^(Denied|Refused) by/, "the broader allow beat the narrow deny");
    assert.deepEqual(fetched, ["https://other.example/x"], "the denied URL was fetched anyway");
});

test("(c) the same source for another CONSUMER is a second row: an act rule never stands in for a fetch rule", T, async () => {
    const ACT_SAME = { consumer: "act", effect: "allow", when: ALLOW_SITE.when, label: "Click on other.example" };
    const { bg } = await workerRun([{ name: "propose_policy", args: { rules: [ALLOW_SITE, ACT_SAME] } }]);
    const pols = await runPolicies(bg);
    assert.equal(pols.length, 2, "two consumers' rows collapsed into one");
    assert.deepEqual(pols.map((p) => p.consumer), ["fetch", "act"], "the consumers are kept apart");
});

// --- (d) a card approves exactly what it shows, and the report claims no more ---

test("(d) the card marks every row with its own effect, in order, and the store receives exactly the rows shown", T, async () => {
    const ASK_USER = { effect: "ask", when: '(c) => c.url.startsWith("https://other.example/user/")', label: "Check with me about other.example/user" };
    const rules = [ALLOW_SITE, DENY_ADMIN, ASK_USER];
    const { bg, cards } = await workerRun([{ name: "propose_policy", args: { rules } }]);
    assert.equal(cards.length, 1, "one card for the proposal");
    const card = cards[0].renderIn;
    const markers = [...String(card.text).matchAll(/^\/\/ Rule (\d+) of (\d+): (allow|deny|ask)$/gm)].map((m) => [Number(m[1]), Number(m[2]), m[3]]);
    assert.deepEqual(markers.map(([i, n, e]) => [i, n, e]), [[1, 3, "allow"], [2, 3, "deny"], [3, 3, "ask"]], "the card's own markers do not name each row's effect, in order");
    for (const r of rules) assert.ok(String(card.text).includes(r.when), `the card does not show the code of a row it will add: ${r.label}`);
    assert.equal((String(card.note).match(/Rule \d+ of 3\./g) ?? []).length, 3, "one measured note per row");
    const pols = await runPolicies(bg);
    assert.deepEqual(ids(pols), rules.map((r) => `${r.effect}|${r.when}`), "the store holds rows the card did not show, or not all of them");
    assert.equal(new Set(pols.map((p) => p.proposal)).size, 1, "one proposal id for the rows of one card");
});

test("(d) a row repeated INSIDE one proposal is stored once, and the model is told which row it was", T, async () => {
    const { bg, results } = await workerRun([{ name: "propose_policy", args: { rules: [ALLOW_SITE, { ...ALLOW_SITE, label: "Read other.example again" }] } }]);
    const pols = await runPolicies(bg);
    assert.equal(pols.length, 1, "the same rule twice in one proposal was stored twice");
    assert.equal(pols[0].label, ALLOW_SITE.label, "the second copy's label won");
    assert.match(String(results[0]), /the run already held the rule "Read other\.example", so "Read other\.example again" was not kept/, `the model was not told the second row added nothing: ${JSON.stringify(results[0]).slice(0, 240)}`);
});

test("(d) a card that was shown is the only thing that can add rows: a refused proposal adds none of its rows", T, async () => {
    const { bg, cards, results } = await workerRun([{ name: "propose_policy", args: { rules: [ALLOW_SITE, DENY_ADMIN] } }], { answer: () => false });
    assert.equal(cards.length, 1, "positive control: the card was shown");
    assert.equal((await runPolicies(bg)).length, 0, "rows were added without the person's answer");
    assert.match(String(results[0]), /^Denied by/);
});
