// site-access.test.mjs — the pure rules of which sites may use window.ml (src/site-access.ts,
// docs/spec/SITE_ACCESS.md): what an origin is, which senders can ever be granted, how the lists decide, and how an
// edit changes them. The gate that applies them at the router is tested in redteam.test.js, against the real bundle.
import { test } from "node:test";
import assert from "node:assert/strict";

const { SITE_ACCESS_KEYS, originOf, grantableOrigin, levelsFor, applyEdit, originFromInput, selfApprovalOrigin, selfApproves, uncoveredApprovals, migrateSiteLists } = await import("../src/site-access.ts");

const empty = { always: [], session: [], denied: [], agents: {}, selfApprove: [] };
/** Lists with some fields set, the rest empty. */
const L = (o = {}) => ({ ...structuredClone(empty), ...o });
/** What the lists let an origin do for window.ml (`levelsFor(...).use`). */
const use = (lists, origin) => levelsFor(lists, origin).use;

// --- what an origin is ---

test("an origin is scheme, host and port, as the browser writes it; anything not http(s) is no origin", () => {
    assert.equal(originOf("https://Example.com/a?b#c"), "https://example.com");
    assert.equal(originOf("https://example.com:443/"), "https://example.com", "the default port is dropped");
    assert.equal(originOf("http://example.com:8080/x"), "http://example.com:8080");
    for (const bad of ["file:///etc/passwd", "data:text/html,hi", "about:blank", "chrome://newtab", "javascript:alert(1)", "null", "", undefined, "not a url"])
        assert.equal(originOf(bad), null, String(bad));
});

test("http and https are different decisions for the same host, as they are for the camera", () => {
    const lists = L({ always: ["https://example.com"] });
    assert.equal(use(lists, "https://example.com"), "always");
    assert.equal(use(lists, "http://example.com"), "unknown");
    assert.equal(use(lists, "https://example.com:8443"), "unknown", "another port is another origin");
});

// --- who can ever be granted ---

test("only a top frame on an http(s), non-opaque origin can be granted", () => {
    assert.deepEqual(grantableOrigin({ origin: "https://a.example", url: "https://a.example/x", frameId: 0 }), { origin: "https://a.example" });
    assert.deepEqual(grantableOrigin({ url: "https://a.example/x" }), { origin: "https://a.example" }, "no origin field: read from the URL");
    assert.match(grantableOrigin({ origin: "https://a.example", frameId: 2 }).refused, /top frame/);
    assert.match(grantableOrigin({ origin: "null", url: "https://a.example/" }).refused, /opaque/, "a sandboxed frame keeps its URL but has an opaque origin");
    assert.match(grantableOrigin({ url: "file:///tmp/a.html" }).refused, /http or https/);
    assert.match(grantableOrigin({ url: "about:blank" }).refused, /http or https/);
    assert.match(grantableOrigin({}).refused, /http or https/);
});

test("the sender's ORIGIN wins over its URL: a frame cannot claim a URL's origin it does not have", () => {
    assert.deepEqual(grantableOrigin({ origin: "https://evil.example", url: "https://ok.example/" }), { origin: "https://evil.example" });
});

// --- how the lists decide ---

test("a denial beats an approval, and an unknown origin is neither", () => {
    assert.equal(use(L({ always: ["https://a.example"], denied: ["https://a.example"] }), "https://a.example"), "denied");
    assert.equal(use(L({ session: ["https://a.example"] }), "https://a.example"), "session");
    assert.equal(use(empty, "https://a.example"), "unknown");
});

test("a site on the self-approval list (by origin) is allowed, starts agents always, and a denial still wins", () => {
    const lists = L({ selfApprove: ["https://docs.example"] });
    assert.deepEqual(levelsFor(lists, "https://docs.example"), { use: "always", agents: "always", selfApprove: true });
    for (const o of ["https://docs.example:8443", "http://docs.example", "https://sub.docs.example"])
        assert.deepEqual(levelsFor(lists, o), { use: "unknown", agents: "off", selfApprove: false }, o);
    assert.deepEqual(levelsFor(L({ selfApprove: ["https://docs.example"], denied: ["https://docs.example"] }), "https://docs.example"), { use: "denied", agents: "off", selfApprove: false });
});

// --- the three levels, over every combination (use x agents x selfApprove) ---

const O = "https://site.example";
const USES = ["none", "always", "session", "denied"];
const AGENTS = [undefined, "ask", "always", "denied"];
const SELF = [false, true];
/** Every stored state of one origin: [label, lists, the abstract state]. */
const STATES = USES.flatMap((u) => AGENTS.flatMap((a) => SELF.map((self) => {
    const lists = L({
        always: u === "always" ? [O] : [], session: u === "session" ? [O] : [], denied: u === "denied" ? [O] : [],
        agents: a ? { [O]: a } : {}, selfApprove: self ? [O] : [],
    });
    return [`use=${u} agents=${a ?? "none"} self=${self}`, lists, { u, a, self }];
})));

/** What a person sees for a state, written out independently of `levelsFor`. */
function expectLevels({ u, a, self }) {
    if (u === "denied") return { use: "denied", agents: "off", selfApprove: false };
    if (u === "none" && !self) return { use: "unknown", agents: "off", selfApprove: false };
    return { use: u === "none" ? "always" : u, agents: self ? "always" : (a ?? "off"), selfApprove: self };
}

test("levelsFor: every (use x agents x selfApprove) state answers what the person set; self-approval implies use and agents always; a denial wins", () => {
    assert.equal(STATES.length, 32);
    for (const [label, lists, st] of STATES) assert.deepEqual(levelsFor(lists, O), expectLevels(st), label);
    // Another origin's entries never answer for this one.
    for (const [label, lists] of STATES) assert.deepEqual(levelsFor(lists, "https://other.example"), { use: "unknown", agents: "off", selfApprove: false }, label);
});

/** Every edit, with what it does to the abstract state, written out independently of `applyEdit`. */
const EDITS = [
    [{ op: "allow", origin: O, scope: "always" }, (s) => ({ ...s, u: "always", a: s.u === "always" || s.u === "session" ? s.a : undefined })],
    [{ op: "allow", origin: O, scope: "session" }, (s) => ({ ...s, u: "session", a: s.u === "always" || s.u === "session" ? s.a : undefined })],
    // Deny and revoke take away every grant, self-approval included: "Stop denying" or a revoke leaves the site unknown.
    [{ op: "deny", origin: O }, (s) => ({ ...s, u: "denied", a: undefined, self: false })],
    [{ op: "revoke", origin: O }, (s) => ({ ...s, u: s.u === "denied" ? "denied" : "none", a: undefined, self: false })],
    [{ op: "undeny", origin: O }, (s) => ({ ...s, u: s.u === "denied" ? "none" : s.u })],
    ...["ask", "always", "denied", "off"].map((level) => [{ op: "agents", origin: O, level },
        (s) => (expectLevels(s).use === "always" || expectLevels(s).use === "session" ? { ...s, a: level === "off" ? undefined : level } : s)]),
    [{ op: "selfApprove", origin: O, on: true }, (s) => ({ ...s, self: true })],
    [{ op: "selfApprove", origin: O, on: false }, (s) => ({ ...s, self: false })],
];

test("applyEdit: every edit over every state lands where the person asked, and nothing else moves", () => {
    const bystander = { always: ["https://b.example"], session: ["https://c.example"], denied: ["https://d.example"], agents: { "https://b.example": "always", "https://c.example": "ask" }, selfApprove: ["https://e.example"] };
    for (const [edit, next] of EDITS) for (const [label, lists, st] of STATES) {
        const before = structuredClone(lists);
        const after = applyEdit(lists, edit);
        assert.deepEqual(lists, before, `${label} ${JSON.stringify(edit)}: the input was changed`);
        assert.deepEqual(levelsFor(after, O), expectLevels(next(st)), `${label} then ${JSON.stringify(edit)}`);
        // Other origins are untouched.
        const withOthers = {
            always: [...lists.always, ...bystander.always].sort(), session: [...lists.session, ...bystander.session].sort(), denied: [...lists.denied, ...bystander.denied].sort(),
            agents: { ...lists.agents, ...bystander.agents }, selfApprove: [...lists.selfApprove, ...bystander.selfApprove].sort(),
        };
        const others = applyEdit(withOthers, edit);
        for (const o of ["https://b.example", "https://c.example", "https://d.example", "https://e.example"])
            assert.deepEqual(levelsFor(others, o), levelsFor(withOthers, o), `${label} ${JSON.stringify(edit)} moved ${o}`);
    }
});

test("S1/S2: a self-approving site that is denied, then un-denied, is unknown; one revoked is unknown, not still allowed by self-approval", () => {
    const self = L({ always: [O], selfApprove: [O], agents: { [O]: "ask" } });
    const undenied = applyEdit(applyEdit(self, { op: "deny", origin: O }), { op: "undeny", origin: O });
    assert.deepEqual(levelsFor(undenied, O), { use: "unknown", agents: "off", selfApprove: false });
    assert.deepEqual(undenied.selfApprove, []);
    const revoked = applyEdit(self, { op: "revoke", origin: O });
    assert.deepEqual(levelsFor(revoked, O), { use: "unknown", agents: "off", selfApprove: false });
    assert.deepEqual(levelsFor(applyEdit(L({ selfApprove: [O] }), { op: "revoke", origin: O }), O).use, "unknown", "an implied approval is revoked too");
});

test("the upgrade notice's key is a site key, so every open editor refreshes when it changes", () => {
    assert.equal(SITE_ACCESS_KEYS.upgradeNotice, "ml_site_upgrade_notice");
});

test("migrateSiteLists names the entries it could not carry over", () => {
    assert.deepEqual(migrateSiteLists(empty, ["x.test", "*.y.test", "z.test:8443", 42, "bücher.de"]).dropped, ["*.y.test", "z.test:8443", "42", "bücher.de"]);
    assert.deepEqual(migrateSiteLists(empty, ["x.test"]).dropped, []);
});

test("applyEdit: a site allowed fresh starts with agents off; revoke and deny drop its agents level; a later allow does not bring it back", () => {
    let l = applyEdit(empty, { op: "allow", origin: O, scope: "always" });
    assert.equal(levelsFor(l, O).agents, "off");
    l = applyEdit(l, { op: "agents", origin: O, level: "always" });
    assert.equal(levelsFor(l, O).agents, "always");
    for (const drop of [{ op: "revoke", origin: O }, { op: "deny", origin: O }]) {
        const after = applyEdit(applyEdit(l, drop), { op: "allow", origin: O, scope: "always" });
        assert.deepEqual(after.agents, {}, drop.op);
        assert.equal(levelsFor(after, O).agents, "off", drop.op);
    }
    // Moving between scopes keeps the level the person set.
    assert.equal(levelsFor(applyEdit(l, { op: "allow", origin: O, scope: "session" }), O).agents, "always");
});

// --- the self-approval list: one origin per entry ---

test("a stored whitelist entry trusts exactly one origin: a bare host is https on the default port, an origin is itself", () => {
    assert.equal(selfApprovalOrigin("docs.example"), "https://docs.example");
    assert.equal(selfApprovalOrigin("Docs.Example"), "https://docs.example", "a host is case-insensitive");
    assert.equal(selfApprovalOrigin("127.0.0.1"), "https://127.0.0.1");
    assert.equal(selfApprovalOrigin("intranet"), "https://intranet", "a dotless host a person stored before still counts");
    assert.equal(selfApprovalOrigin("http://127.0.0.1:5123"), "http://127.0.0.1:5123", "an entry written as an origin keeps its scheme and port");
    assert.equal(selfApprovalOrigin("https://docs.example/"), "https://docs.example");
    for (const bad of ["docs.example:8443", "docs.example/path", "ftp://docs.example", "file:///etc", "", "  ", null, 42, {}, "https://docs.example/a/b"])
        assert.equal(selfApprovalOrigin(bad), null, JSON.stringify(bad));
});

/** Sender shapes against a self-approval list of `["https://trusted.example"]`, each with whether it may self-approve. */
const SELF_APPROVAL_SENDERS = [
    ["https top frame (positive control)", { origin: "https://trusted.example", url: "https://trusted.example/p", frameId: 0 }, true],
    ["https, URL only (a worker-built run's tab)", { url: "https://trusted.example/p" }, true],
    ["https, explicit default port", { url: "https://trusted.example:443/p" }, true],
    ["plain http, same host", { origin: "http://trusted.example", url: "http://trusted.example/p", frameId: 0 }, false],
    ["https, another port", { origin: "https://trusted.example:8443", url: "https://trusted.example:8443/p", frameId: 0 }, false],
    ["http, another port", { url: "http://trusted.example:8080/p" }, false],
    ["a subdomain", { origin: "https://sub.trusted.example", url: "https://sub.trusted.example/p", frameId: 0 }, false],
    ["a suffix lookalike", { url: "https://trusted.example.evil.test/p" }, false],
    ["a prefix lookalike", { url: "https://eviltrusted.example/p" }, false],
    ["a sub-frame of the trusted origin", { origin: "https://trusted.example", url: "https://trusted.example/f", frameId: 3 }, false],
    ["an opaque origin on the trusted URL", { origin: "null", url: "https://trusted.example/p", frameId: 0 }, false],
    ["a URL claiming the trusted origin from another origin", { origin: "https://evil.example", url: "https://trusted.example/p", frameId: 0 }, false],
    ["no URL at all", {}, false],
];

test("self-approval: only the listed origin itself, never http, another port, a subdomain or a sub-frame", () => {
    const lists = L({ selfApprove: ["https://trusted.example"] });
    for (const [label, sender, want] of SELF_APPROVAL_SENDERS) assert.equal(selfApproves(lists, sender), want, label);
});

test("self-approval follows the site gate: a denied origin never self-approves, and what self-approves the gate allows", () => {
    for (const [label, sender] of SELF_APPROVAL_SENDERS) {
        const lists = L({ always: ["http://trusted.example", "https://trusted.example:8443", "https://sub.trusted.example"], selfApprove: ["https://trusted.example"] });
        if (selfApproves(lists, sender)) assert.equal(use(lists, grantableOrigin(sender).origin), "always", `${label}: self-approves but the gate would refuse it`);
    }
    assert.equal(selfApproves(L({ denied: ["https://trusted.example"], selfApprove: ["https://trusted.example"] }), { url: "https://trusted.example/" }), false, "a denial wins");
    // Being approved for window.ml over http does not make the http origin self-approving.
    assert.equal(selfApproves(L({ always: ["http://trusted.example"], selfApprove: ["https://trusted.example"] }), { url: "http://trusted.example/" }), false);
    // An http origin the person put on the list is that origin only.
    assert.equal(selfApproves(L({ selfApprove: ["http://127.0.0.1:5123"] }), { url: "http://127.0.0.1:5123/" }), true);
    assert.equal(selfApproves(L({ selfApprove: ["http://127.0.0.1:5123"] }), { url: "http://127.0.0.1:5124/" }), false, "another port");
});

test("an origin approved for this session self-approves when it is on the list, as one approved always does", () => {
    assert.equal(selfApproves(L({ session: ["https://trusted.example"], selfApprove: ["https://trusted.example"] }), { url: "https://trusted.example/" }), true);
    assert.equal(levelsFor(L({ session: ["https://trusted.example"], selfApprove: ["https://trusted.example"] }), "https://trusted.example").agents, "always");
});

// --- the upgrade: the sync whitelist of hosts becomes local origins (migrateSiteLists) ---

/** [label, the sync whitelist as stored, the self-approval origins it becomes]. */
const MIGRATION_CASES = [
    ["a host", ["x.test"], ["https://x.test"]],
    ["a host with a port typed in (it trusted nothing before #628 either)", ["x.test:8443"], []],
    ["an IP", ["127.0.0.1"], ["https://127.0.0.1"]],
    ["localhost (no loopback special case: https on the default port)", ["localhost"], ["https://localhost"]],
    ["an entry stored as an origin", ["http://127.0.0.1:5123"], ["http://127.0.0.1:5123"]],
    ["an empty list", [], []],
    ["a non-string entry", [42, null, { host: "x.test" }, ["x.test"]], []],
    ["a mixed list, duplicates and case", ["X.test", "x.test", "https://x.test/", "", "  "], ["https://x.test"]],
    ["a trailing dot (the same DNS name)", ["x.test."], ["https://x.test"]],
    ["a wildcard (never a site)", ["*.x.test", "*"], []],
    ["a Unicode host the old editor never stored", ["bücher.de"], []],
];

test("UPGRADE: migrateSiteLists turns each stored host into the one origin it trusted, enumerated", () => {
    for (const [label, hosts, want] of MIGRATION_CASES) {
        const out = migrateSiteLists({ always: [], session: [], denied: [] }, hosts);
        assert.deepEqual(out.selfApprove, want, label);
        // Never a site decision made silently: no host lands on the approved list, and no http origin is inferred.
        assert.deepEqual(out.always, [], label);
    }
    assert.deepEqual(migrateSiteLists({ always: [], session: [], denied: [] }, undefined).selfApprove, [], "no sync setting at all");
    assert.deepEqual(migrateSiteLists({ always: [], session: [], denied: [] }, "x.test").selfApprove, [], "a setting that is not a list");
});

test("UPGRADE: every origin allowed before the upgrade keeps agents with start approval (ask); a denied one gets nothing", () => {
    const v1 = { always: ["https://a.test", "http://b.test"], session: ["https://s.test"], denied: ["https://c.test"] };
    const out = migrateSiteLists(v1, ["x.test"]);
    assert.deepEqual(out.agents, { "https://a.test": "ask", "http://b.test": "ask", "https://s.test": "ask" });
    assert.deepEqual([out.always, out.session, out.denied], [v1.always, v1.session, v1.denied], "the lists themselves are unchanged");
    assert.deepEqual(levelsFor(out, "https://a.test"), { use: "always", agents: "ask", selfApprove: false });
    assert.deepEqual(levelsFor(out, "https://c.test"), { use: "denied", agents: "off", selfApprove: false });
    assert.deepEqual(levelsFor(out, "https://x.test"), { use: "always", agents: "always", selfApprove: true });
    assert.deepEqual(levelsFor(out, "http://x.test"), { use: "unknown", agents: "off", selfApprove: false });
});

test("UPGRADE: migrating twice gives what migrating once gave, and keeps a level the person already set", () => {
    const v1 = { always: ["https://a.test"], session: [], denied: ["https://c.test"] };
    for (const [label, hosts] of MIGRATION_CASES) {
        const once = migrateSiteLists(v1, hosts);
        assert.deepEqual(migrateSiteLists(once, hosts), once, label);
    }
    const set = migrateSiteLists({ always: ["https://a.test"], session: [], denied: [], agents: { "https://a.test": "always" }, selfApprove: ["https://y.test"] }, ["x.test"]);
    assert.deepEqual(set.agents, { "https://a.test": "always" });
    assert.deepEqual(set.selfApprove, ["https://x.test", "https://y.test"]);
});

test("UPGRADE: an allowed http or port origin of a host whose https site self-approves is listed, loopback too, and adding it trusts that origin", () => {
    // What an install before #628 held: bare hosts, and the http origins allowed so those pages could use window.ml.
    const v1 = { always: ["http://localhost:3000", "http://127.0.0.1:8080", "http://[::1]:5173", "http://mlbox.lan:8080", "https://mlbox.lan:8443"], session: [], denied: [] };
    const lists = migrateSiteLists(v1, ["docs.google.com", "localhost", "127.0.0.1", "[::1]", "mlbox.lan"]);
    const lost = ["http://127.0.0.1:8080", "http://[::1]:5173", "http://localhost:3000", "http://mlbox.lan:8080", "https://mlbox.lan:8443"];
    for (const o of lost) assert.equal(selfApproves(lists, { url: `${o}/` }), false, o);
    assert.equal(selfApproves(lists, { url: "https://docs.google.com/d" }), true);
    assert.deepEqual(uncoveredApprovals(lists), [...lost].sort());
    let after = lists;
    for (const o of ["http://localhost:3000", "http://mlbox.lan:8080"]) {
        after = applyEdit(after, { op: "selfApprove", origin: o, on: true });
        assert.equal(selfApproves(after, { url: `${o}/app` }), true, o);
    }
    assert.deepEqual(uncoveredApprovals(after), ["http://127.0.0.1:8080", "http://[::1]:5173", "https://mlbox.lan:8443"]);
    // A denied origin, or an approval of an unrelated host, is never listed.
    assert.deepEqual(uncoveredApprovals(L({ always: ["http://mlbox.lan:8080", "http://other.lan"], denied: ["http://mlbox.lan:8080"], selfApprove: ["https://mlbox.lan"] })), []);
    assert.deepEqual(uncoveredApprovals(L({ session: ["http://mlbox.lan:9000"], selfApprove: ["https://mlbox.lan"] })), ["http://mlbox.lan:9000"], "a session approval too");
});

// --- how an edit changes them ---

test("allowing moves an origin to one scope and lifts a denial; revoking leaves it unknown; un-denying leaves approvals alone", () => {
    const o = "https://a.example";
    const strip = ({ always, session, denied }) => ({ always, session, denied });
    let l = applyEdit(L({ denied: [o] }), { op: "allow", origin: o, scope: "session" });
    assert.deepEqual(strip(l), { always: [], session: [o], denied: [] });
    l = applyEdit(l, { op: "allow", origin: o, scope: "always" });
    assert.deepEqual(strip(l), { always: [o], session: [], denied: [] }, "one scope at a time");
    l = applyEdit(l, { op: "deny", origin: o });
    assert.deepEqual(strip(l), { always: [], session: [], denied: [o] }, "a denial removes every approval");
    l = applyEdit(l, { op: "undeny", origin: o });
    assert.deepEqual(l, empty);
    l = applyEdit(L({ always: [o, "https://b.example"], session: [o] }), { op: "revoke", origin: o });
    assert.deepEqual(strip(l), { always: ["https://b.example"], session: [], denied: [] }, "other origins untouched");
});

test("an edit never changes the lists it was given, and adding twice keeps one entry", () => {
    const before = L({ always: ["https://a.example"] });
    const after = applyEdit(before, { op: "allow", origin: "https://a.example", scope: "always" });
    assert.deepEqual(after.always, ["https://a.example"]);
    assert.deepEqual(before, L({ always: ["https://a.example"] }));
    assert.deepEqual(applyEdit(applyEdit(before, { op: "selfApprove", origin: "https://a.example", on: true }), { op: "selfApprove", origin: "https://a.example", on: true }).selfApprove, ["https://a.example"]);
});

// --- what a person types into the settings ---

test("a bare host means https; a full URL keeps its scheme and port; a typo is refused", () => {
    assert.equal(originFromInput("example.com"), "https://example.com");
    assert.equal(originFromInput("  https://example.com/some/page?q=1 "), "https://example.com");
    assert.equal(originFromInput("http://localhost:3000"), "http://localhost:3000");
    assert.equal(originFromInput("localhost:3000"), "https://localhost:3000");
    for (const bad of ["", "   ", "examplecom", "file:///etc", "ftp://example.com", "chrome://extensions"])
        assert.equal(originFromInput(bad), null, JSON.stringify(bad));
});

test("an edit naming something that is not an origin, or an op or level the rules do not know, changes nothing", () => {
    const lists = L({ always: ["https://a.example"], agents: { "https://a.example": "ask" } });
    for (const bad of [
        { op: "agents", origin: "https://a.example", level: "sometimes" },
        { op: "allow", origin: "https://a.example", scope: "forever" },
        { op: "grant", origin: "https://a.example" },
    ]) assert.deepEqual(applyEdit(lists, bad), lists, JSON.stringify(bad));
});
