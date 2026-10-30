// redteam-act-consumer.test.mjs — the red team's pin on the `act` consumer (#1347, piece (b) of the worked example): what
// a click or a type must never get past the judge that stands in front of it (src/sw/sw-run-host.ts `judgeAct`,
// src/tools/builtin-tools.ts `clickPrecheck`/`actElement`, src/sw/sw-policies.ts `actFacts`; docs/spec/POLICIES.md,
// "Acting on a page is a consumer" and the fourth row).
//
// Four properties, none of them the lane's own acceptance rows (tests/nav-arrival-host.test.mjs) restated:
//   (a) a call the precheck dooms is refused BEFORE the act judge: a box token is a region, not something to act on, so
//       no policy is consulted, no card is shown, nothing reaches the page, and the model reads the precheck's reason;
//   (b) a point token carries no element of its own, so what the judge reads for it is what the PAGE resolved under it —
//       the element when there is one, null when there is not, and a deny written on the name fires in the second case;
//   (c) an unresolved element is UNKNOWN, not a nameless button: `name: ""` is a fact about a button, `null` is the
//       absence of one, and a row written on `""` must not decide for `null` (or it would rule on what it cannot see);
//   (d) the args cannot supply what the judge reads: an `element` or an `href` the model puts in the click's args changes
//       nothing, so the judge stays the worker's reading of the page.
//
// A run the worker built on tab 7 with a scripted model; the page is played by `onTabMessage` and answers the precheck
// the way the delegated runner does (`{ result, precheckFailed, element?, href? }`), then runs what it is told to.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { jsonResponse, loadBackground } = require("./helpers");

const T = { timeout: 30000 };
const plain = (x) => JSON.parse(JSON.stringify(x ?? null));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const START = "https://site.example/page";
const config = { chatUrl: "http://host/api/chat/completions", apiKey: "sk-test", model: "default-model", apiFormat: "openai", ocrModel: "", debugMode: "off", autoApproveReadonly: true };

/** A saved global policy of the `act` consumer, as the policy page stores one. */
const actPolicy = (id, effect, source, label) => ({ id, scope: "global", consumer: "act", effect, source, label, origin: "person", created: 1760000000000 });
const DENY_CLICKS = actPolicy("a-deny", "deny", '(c) => c.action === "click"', "No clicks here");
/** An allow over the run's own page, so a click no deny covers runs with no card: the control beside DENY_NOT_APPROVE. */
const ALLOW_CLICKS = actPolicy("a-allow", "allow", '(c) => c.action === "click" && c.url.startsWith("https://site.example/")', "Click on site.example");
/** The fourth rule's shape: everything on the page but the one named button. It is also true of `null`, so it decides
 *  for an element nobody resolved — which is exactly what the unresolved-point row below asserts, and why the row about
 *  a RESOLVED element carries a rule of its own. */
const DENY_NOT_APPROVE = actPolicy("a-fourth", "deny", '(c) => c.action === "click" && c.element.name !== "Approve This Draft"', "Only Approve This Draft");
/** A deny that can only fire for an element the page RESOLVED: `null` is not equal to a name, so a judge that never
 *  read the resolved element cannot green the row that uses this one. */
const DENY_DELETE = actPolicy("a-deny-delete", "deny", '(c) => c.action === "click" && c.element.name === "Delete"', "Never Delete");
/** Rows written on a NAMELESS button — the fact `""` — which must never decide for an element nobody resolved. */
const ALLOW_NAMELESS = actPolicy("a-allow-empty", "allow", '(c) => c.action === "click" && c.element.name === ""', "Click nameless buttons");
const DENY_NAMELESS = actPolicy("a-deny-empty", "deny", '(c) => c.action === "click" && c.element.name === ""', "Never a nameless button");
const DENY_ADMIN_FETCH = { id: "f-deny", scope: "global", consumer: "fetch", effect: "deny", source: '(c) => c.kind === "fetch" && c.url.startsWith("https://b.example/admin/")', label: "No admin pages", origin: "person", created: 1760000000000 };

/**
 * A run the worker built on tab 7 whose model makes `calls` in turn, then answers "done". The page answers each
 * precheck with `precheck(name, args)` (the delegated runner's envelope), runs what reaches it, and every card is
 * answered by `card(tool)` (true approves).
 * @returns what the model read, the calls the page ran, and the cards shown
 */
async function actRun(calls, { policies = [], precheck = () => undefined, card = () => true } = {}) {
    let turns = 0, bg;
    const seen = [], cards = [], toPage = [];
    bg = loadBackground({
        config, openTabs: [{ id: 7, windowId: 3, active: true, url: START, title: "Site" }], siteGate: true,
        local: { ml_policies_global: policies, ml_site_always: ["https://site.example"] },
        onFetch: async (call) => {
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
                const e = msg.event;
                cards.push(e.tool);
                void bg.send({ type: "SET_APPROVAL", payload: { runId: e.id, seq: e.seq, decision: !!card(e.tool) } });
                return undefined;
            }
            if (msg.type !== "RUN_TOOL_IN_PAGE") return undefined;
            const p = plain(msg.payload);
            if (p.finish) return { result: "" };
            if (p.precheck) return precheck(p.name, p.args) ?? { result: "", precheckFailed: false };
            if (p.renderOnly || p.readonlyTry || p.geometry) return { result: "" };
            toPage.push({ name: p.name, args: p.args });
            return { result: `ran ${p.name}` };
        },
    });
    await bg.context.__mlStartUserRunForTest(7, { task: "act on the site", surface: "hud" });
    for (let i = 0; i < 600 && turns <= calls.length; i++) await sleep(1);
    await sleep(40);
    const results = (seen.at(-1) ?? []).filter((m) => m.role === "tool").map((m) => String(m.content));
    const log = async () => (await bg.context.__mlRunLog.all()).filter((r) => r.subsystem === "policy").map((r) => plain(r));
    return { bg, cards, toPage, results, log };
}

/** The page's precheck for a selector it can resolve an element for. */
const resolving = (map) => (name, args) => (map[args.selector] ? { result: "", precheckFailed: false, element: map[args.selector], ...(map[args.selector].href ? { href: map[args.selector].href } : {}) } : undefined);
const BUTTONS = {
    "#approve": { tag: "button", href: null, name: "Approve This Draft" },
    "#delete": { tag: "button", href: null, name: "Delete" },
    "#nameless": { tag: "button", href: null, name: "" },
};

// --- (a) the precheck dooms it, so the judge never sees it ---

test("RED TEAM: a box token is refused by the precheck before the act judge: no policy consulted, no card, nothing run", async () => {
    // A region is a container, not something to act on; `locate` returns a `@pt:` for a control. The refusal is the
    // precheck's, so the model reads how to get a real target instead of a policy it cannot satisfy.
    for (const name of ["click", "type"]) {
        const box = "@box:10:10:200:40";
        const r = await actRun([{ name, args: name === "click" ? { selector: box } : { selector: box, text: "x" } }], {
            policies: [DENY_CLICKS],
            precheck: (_n, a) => (a.selector === box ? { result: `"${box}" is an @box ${name === "click" ? "container region, not a clickable point" : "region, not a field"}.`, precheckFailed: true } : undefined),
        });
        assert.match(r.results[0], /@box/, `the model did not read the precheck's reason for ${name}: ${JSON.stringify(r.results[0])}`);
        assert.doesNotMatch(r.results[0], /policy/i, `the judge was consulted for a box ${name}`);
        assert.deepEqual(r.cards, [], `a card was shown for a box ${name}`);
        assert.deepEqual(r.toPage, [], `a box ${name} reached the page`);
        assert.equal((await r.log()).length, 0, `the run log carries a policy decision for a box ${name}`);
    }
});

// --- (b) a point is judged on what the page resolved under it ---

test("RED TEAM: a point token is judged on the element the page resolved under it, and on nothing the token itself says", async () => {
    // The point names no element: the page hit-tests it (the act precheck, #1360) and the worker judges THAT element.
    // The deny speaks only of the resolved name ("Delete"), so a judge that never read the element lets the point run:
    // `toPage` would then hold the point as well as `#approve`.
    const pt = "@pt:120:340:abc";
    const r = await actRun([{ name: "click", args: { selector: pt } }, { name: "click", args: { selector: "#approve" } }], {
        policies: [ALLOW_CLICKS, DENY_DELETE],
        precheck: (n, a) => (a.selector === pt ? { result: "", precheckFailed: false, element: { tag: "button", href: null, name: "Delete" } } : resolving(BUTTONS)(n, a)),
    });
    assert.match(r.results[0], /Never Delete/, "a point over the Delete button was not judged by the rule on its name");
    assert.deepEqual(r.toPage.map((x) => x.args.selector), ["#approve"], "the point the rule refuses reached the page, or the button it allows did not");
    assert.equal(r.cards.length, 0, "no card: the rule decided both");
});

test("RED TEAM: a point the page resolved nothing under is judged with a null name, and a deny on the name fires", async () => {
    const r = await actRun([{ name: "click", args: { selector: "@pt:5:5:zzz" } }], { policies: [DENY_NOT_APPROVE] });
    assert.match(r.results[0], /Only Approve This Draft/, `an unresolved point was let through: ${JSON.stringify(r.results[0])}`);
    assert.deepEqual(r.toPage, []);
});

// --- (c) unresolved is unknown, not a nameless button ---

test("RED TEAM: an element nobody resolved is unknown, so a row written on the nameless fact ('') does not decide", async () => {
    // A page built before the `element` field answers the precheck with no element at all: the call still runs, and the
    // judge must be told null. A rule over `name === ""` describes a button without a name; it cannot speak for an
    // element nobody looked at, in either direction.
    const empty = { result: "", precheckFailed: false };   // the pre-field envelope
    const asked = await actRun([{ name: "click", args: { selector: "#whatever" } }], { policies: [ALLOW_NAMELESS], precheck: () => empty });
    assert.deepEqual(asked.cards, ["click"], "an allow on the nameless fact skipped the card for an unresolved element");
    const denied = await actRun([{ name: "click", args: { selector: "#whatever" } }], { policies: [DENY_NAMELESS], precheck: () => empty });
    assert.deepEqual(denied.cards, ["click"], "a deny on the nameless fact refused an element it never saw");
    assert.doesNotMatch(denied.results[0], /Never a nameless button/, "the deny on '' fired for an unresolved element");
});

test("RED TEAM: control — the nameless fact is a fact: the same rows DO decide for a button whose name is ''", async () => {
    const asked = await actRun([{ name: "click", args: { selector: "#nameless" } }], { policies: [ALLOW_NAMELESS], precheck: resolving(BUTTONS) });
    assert.deepEqual(asked.cards, [], "an allow on '' did not cover a nameless button");
    const denied = await actRun([{ name: "click", args: { selector: "#nameless" } }], { policies: [DENY_NAMELESS], precheck: resolving(BUTTONS) });
    assert.match(denied.results[0], /Never a nameless button/, "a deny on '' did not refuse a nameless button");
    assert.deepEqual(denied.toPage, []);
});

// --- (d) the args are not the judge's source ---

test("RED TEAM: an element or an href in the click's args steers nothing: the judge reads the page's element", async () => {
    const r = await actRun([{ name: "click", args: { selector: "#delete", element: { tag: "button", href: null, name: "Approve This Draft" }, href: "https://site.example/harmless" } }], {
        policies: [DENY_NOT_APPROVE],
        precheck: resolving(BUTTONS),
    });
    assert.match(r.results[0], /Only Approve This Draft/, "an element in the args dodged the rule on the real one");
    assert.deepEqual(r.toPage, [], "the click ran");
});

test("RED TEAM: an href in the args does not dodge the fetch deny on the link the page resolved", async () => {
    const ADMIN = "https://b.example/admin/users";
    const r = await actRun([{ name: "click", args: { selector: "#admin", href: START } }], {
        policies: [DENY_ADMIN_FETCH],
        precheck: () => ({ result: "", precheckFailed: false, href: ADMIN, element: { tag: "a", href: ADMIN, name: "Admin" } }),
    });
    assert.match(r.results[0], /No admin pages/, `an href in the args dodged the fetch deny: ${JSON.stringify(r.results[0])}`);
    assert.deepEqual(r.toPage, [], "the click reached the page");
});
