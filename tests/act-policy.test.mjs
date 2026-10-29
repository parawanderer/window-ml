// act-policy.test.mjs — the `act` consumer: a click or a type judged on the element the worker resolved
// (src/sw/sw-policies.ts `actFacts`, src/tools/builtin-tools.ts `actElement`, src/sw/policy-proposal.ts; docs/spec/POLICIES.md,
// "Acting on a page is a consumer" and the fourth row).
//
// The pure parts: the facts and the null-fact rule, the element a page resolves, the proposal of `act` rows and its breadth.
// The run host's use of them (the precheck, the gate) is tested in act-policy-host.test.mjs, and the whole in
// tests/e2e/policy-worked-example.spec.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

const { evalPolicy } = await import("../src/readonly-exec.ts");
const { actFacts } = await import("../src/sw/sw-policies.ts");
const { actElement } = await import("../src/tools/builtin-tools.ts");
const PP = await import("../src/sw/policy-proposal.ts");

const B = "https://example.com";
const APPROVALS = `${B}/user/approvals`;
const FOURTH = `(c) => c.action === "click" && c.url.startsWith("${APPROVALS}") && c.element.name !== "Approve This Draft"`;
const ALLOW_USER = `(c) => c.action === "click" && c.url.startsWith("${B}/user/")`;
const btn = (name, href = null) => ({ tag: "button", href, name });
const decide = (src, effect, facts) => evalPolicy(src, facts, effect).decision;

// --- the facts ---

test("actFacts carries the page, the action and the element as resolved, with effects unknown", () => {
    const f = actFacts(`${B}/user/x`, "click", btn("Go"));
    assert.deepEqual({ kind: f.kind, url: f.url, host: f.host, action: f.action, element: f.element, effects: f.effects },
        { kind: "act", url: `${B}/user/x`, host: "example.com", action: "click", element: { tag: "button", href: null, name: "Go" }, effects: "unknown" });
});

test("the fourth row refuses every button of the approvals page but the one named, whatever it is called", () => {
    for (const name of ["Delete", "Publish", "Approve this draft", "Approve This Draft ", "", "Something new"])
        assert.equal(decide(FOURTH, "deny", actFacts(APPROVALS, "click", btn(name))), "deny", `"${name}" is refused`);
    assert.notEqual(decide(FOURTH, "deny", actFacts(APPROVALS, "click", btn("Approve This Draft"))), "deny", "the one named falls through");
    assert.notEqual(decide(FOURTH, "deny", actFacts(`${B}/user/x`, "click", btn("Delete"))), "deny", "another page is not its business");
});

test("a null name (an element that could not be resolved) is read as the null-fact rule: a deny fires, an allow does not", () => {
    const f = actFacts(APPROVALS, "click", { tag: "", href: null, name: null });
    assert.equal(decide(FOURTH, "deny", f), "deny");
    assert.notEqual(decide(`(c) => c.element.name === "Approve This Draft"`, "allow", f), "allow");
});

test("a null href is unknown: an allow that read it and held never fires, a deny that read it does", () => {
    const f = actFacts(`${B}/user/x`, "click", btn("Go"));
    const notAdmin = `(c) => c.element.href !== "${B}/admin/"`;
    const r = evalPolicy(notAdmin, f, "allow");
    assert.equal(r.decision, undefined, "an allow over an unknown href has no opinion");
    assert.ok(r.unknown, "and says which fact it read");
    assert.equal(decide(notAdmin, "deny", f), "deny");
});

test("a type is not a click: the click allow does not cover it", () => {
    assert.equal(decide(ALLOW_USER, "allow", actFacts(`${B}/user/x`, "click", btn("Go"))), "allow");
    assert.notEqual(decide(ALLOW_USER, "allow", actFacts(`${B}/other`, "type", { tag: "input", href: null, name: "Search" })), "allow");
});

// --- the element a page resolves ---

function mount(html) {
    const dom = new JSDOM(`<!doctype html><body>${html}</body>`, { url: "https://a.example/dir/page" });
    globalThis.window = dom.window;
    globalThis.document = dom.window.document;
}

test("actElement is the tag, the nearest link's absolute href and the accessible name of the element the selector resolves", () => {
    mount(`<a id="rel" href="../admin/"><span id="inner">Admin</span></a><button id="b">Approve   This
        Draft</button><button id="n"></button><button id="al" aria-label="Delete"><svg></svg></button><input id="t" aria-label="Search">`);
    assert.deepEqual(actElement({ selector: "#rel" }), { tag: "a", href: "https://a.example/admin/", name: "Admin" });
    assert.deepEqual(actElement({ selector: "#inner" }), { tag: "span", href: "https://a.example/admin/", name: "Admin" });
    assert.deepEqual(actElement({ selector: "#b" }), { tag: "button", href: null, name: "Approve This Draft" });
    assert.deepEqual(actElement({ selector: "#n" }), { tag: "button", href: null, name: "" }, "a nameless button is a fact, not an unknown");
    assert.equal(actElement({ selector: "#al" }).name, "Delete");
    assert.deepEqual(actElement({ selector: "#t" }), { tag: "input", href: null, name: "Search" });
});

test("actElement is the name AT THE CALL: a button renamed by script is read under its new name", () => {
    mount(`<button id="b">Approve This Draft</button>`);
    assert.equal(actElement({ selector: "#b" }).name, "Approve This Draft");
    document.getElementById("b").textContent = "Delete";
    assert.equal(actElement({ selector: "#b" }).name, "Delete");
});

test("actElement resolves nothing for a missing element, a bad selector, a point or a box token", () => {
    mount(`<button id="b">Go</button>`);
    for (const selector of ["#missing", "[[bad", "@pt:1:2:abc", "@box:1:2:3:4"]) assert.equal(actElement({ selector }), undefined, selector);
});

// --- proposing act rows ---

test("a proposal may carry act rows: the spec's four rules are accepted, in the order sent", () => {
    const c = PP.checkProposals({ rules: [
        { effect: "allow", when: `(c) => c.url.startsWith("${B}/")`, label: "Go anywhere on example.com" },
        { effect: "allow", consumer: "act", when: ALLOW_USER, label: "Click on /user/" },
        { effect: "deny", when: `(c) => c.url.startsWith("${B}/admin/")`, label: "Never /admin/" },
        { effect: "deny", consumer: "act", when: FOURTH, label: "Only Approve This Draft on the approvals page" },
    ] });
    assert.ok("proposals" in c, JSON.stringify(c));
    assert.deepEqual(c.proposals.map((q) => [q.consumer, q.effect]), [["fetch", "allow"], ["act", "allow"], ["fetch", "deny"], ["act", "deny"]]);
});

test("a consumer that is not fetch or act is refused, and an act rule that reads a field a click lacks does not run", () => {
    const bad = PP.checkProposals({ rules: [{ effect: "allow", consumer: "sh", when: "(c) => true", label: "x" }] });
    assert.match(bad.error, /rule 1: .*"consumer"/);
    const lacks = PP.checkProposals({ effect: "allow", consumer: "act", when: "(c) => c.credentials", label: "x" });
    assert.ok("proposal" in lacks || /does not run/.test(lacks.error), "a missing field reads as unknown, not as a crash");
    const typo = PP.checkProposals({ effect: "allow", consumer: "act", when: "(c) => c.element.nmae === 'x'", label: "x" });
    assert.match(typo.error ?? "", /does not run/);
});

test("an act rule's breadth is over the run's recorded clicks, and says so when there are none", () => {
    const [q] = PP.checkProposals({ effect: "allow", consumer: "act", when: ALLOW_USER, label: "Click on /user/" }).proposals;
    const none = PP.actBreadthNote(q, PP.measureActBreadth(q, []));
    assert.match(none, /no click or type to measure/);
    const acts = [
        { url: `${B}/user/x`, action: "click", element: btn("Open admin") },
        { url: `${B}/other`, action: "type", element: { tag: "input", href: null, name: "Search" } },
    ];
    const b = PP.measureActBreadth(q, acts);
    assert.equal(b.recorded, 2);
    assert.deepEqual(b.matched.map((a) => a.element.name), ["Open admin"]);
    assert.match(PP.actBreadthNote(q, b), /matches 1 of this run's 2 clicks and types \(click "Open admin" on https:\/\/example.com\/user\/x\)/);
    assert.deepEqual(b.strays, [], "a rule over one origin matches no unrelated site");
});

test("an act rule that matches every page shows in the breadth as reaching past the run's sites", () => {
    const [q] = PP.checkProposals({ effect: "allow", consumer: "act", when: `(c) => c.action === "click"`, label: "Any click" }).proposals;
    const b = PP.measureActBreadth(q, [{ url: `${B}/user/x`, action: "click", element: btn("Go") }]);
    assert.ok(b.strays.length > 0);
    assert.match(PP.actBreadthNote(q, b), /ALSO matches a click on a nameless button of sites this run never used/);
});
