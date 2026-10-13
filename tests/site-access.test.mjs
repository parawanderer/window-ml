// site-access.test.mjs — the pure rules of which sites may use window.ml (src/site-access.ts,
// docs/spec/SITE_ACCESS.md): what an origin is, which senders can ever be granted, how the lists decide, and how an
// edit changes them. The gate that applies them at the router is tested in redteam.test.js, against the real bundle.
import { test } from "node:test";
import assert from "node:assert/strict";

const { originOf, grantableOrigin, decide, applyEdit, originFromInput, selfApprovalOrigin, selfApproves } = await import("../src/site-access.ts");

const empty = { always: [], session: [], denied: [] };

// --- what an origin is ---

test("an origin is scheme, host and port, as the browser writes it; anything not http(s) is no origin", () => {
    assert.equal(originOf("https://Example.com/a?b#c"), "https://example.com");
    assert.equal(originOf("https://example.com:443/"), "https://example.com", "the default port is dropped");
    assert.equal(originOf("http://example.com:8080/x"), "http://example.com:8080");
    for (const bad of ["file:///etc/passwd", "data:text/html,hi", "about:blank", "chrome://newtab", "javascript:alert(1)", "null", "", undefined, "not a url"])
        assert.equal(originOf(bad), null, String(bad));
});

test("http and https are different decisions for the same host, as they are for the camera", () => {
    const lists = { ...empty, always: ["https://example.com"] };
    assert.equal(decide(lists, "https://example.com"), "always");
    assert.equal(decide(lists, "http://example.com"), "unknown");
    assert.equal(decide(lists, "https://example.com:8443"), "unknown", "another port is another origin");
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
    assert.equal(decide({ always: ["https://a.example"], session: [], denied: ["https://a.example"] }, "https://a.example"), "denied");
    assert.equal(decide({ always: [], session: ["https://a.example"], denied: [] }, "https://a.example"), "session");
    assert.equal(decide(empty, "https://a.example"), "unknown");
});

test("a site trusted to self-gate (pageApprovalDomains) is approved over https only; a denial still wins", () => {
    assert.equal(decide(empty, "https://docs.example", ["docs.example"]), "always");
    assert.equal(decide(empty, "https://docs.example:8443", ["docs.example"]), "unknown", "a bare host is its https origin on the default port");
    assert.equal(decide(empty, "http://docs.example", ["docs.example"]), "unknown", "never plain http: anyone on the wire could be it");
    assert.equal(decide(empty, "https://sub.docs.example", ["docs.example"]), "unknown", "a host, not a domain suffix");
    assert.equal(decide({ ...empty, denied: ["https://docs.example"] }, "https://docs.example", ["docs.example"]), "denied");
});

// --- the self-approval whitelist: one origin per entry ---

test("a whitelist entry trusts exactly one origin: a bare host is https on the default port, an origin is itself", () => {
    assert.equal(selfApprovalOrigin("docs.example"), "https://docs.example");
    assert.equal(selfApprovalOrigin("Docs.Example"), "https://docs.example", "a host is case-insensitive");
    assert.equal(selfApprovalOrigin("127.0.0.1"), "https://127.0.0.1");
    assert.equal(selfApprovalOrigin("intranet"), "https://intranet", "a dotless host a person stored before still counts");
    assert.equal(selfApprovalOrigin("http://127.0.0.1:5123"), "http://127.0.0.1:5123", "an entry written as an origin keeps its scheme and port");
    assert.equal(selfApprovalOrigin("https://docs.example/"), "https://docs.example");
    // Never widened: an entry the host match never honoured (a port or a path on a bare host, another scheme) trusts nothing.
    for (const bad of ["docs.example:8443", "docs.example/path", "ftp://docs.example", "file:///etc", "", "  ", null, 42, {}, "https://docs.example/a/b"])
        assert.equal(selfApprovalOrigin(bad), null, JSON.stringify(bad));
});

/** Sender shapes against a whitelist of `["trusted.example"]`, each with whether it may self-approve. Every shape a
 *  host match would have confused with the trusted origin is here, beside the one positive control. */
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

test("self-approval: only the whitelisted https origin itself, never http, another port, a subdomain or a sub-frame", () => {
    for (const [label, sender, want] of SELF_APPROVAL_SENDERS)
        assert.equal(selfApproves(empty, sender, ["trusted.example"]), want, label);
});

test("self-approval follows the site gate: a denied origin never self-approves, and what self-approves the gate allows", () => {
    for (const [label, sender] of SELF_APPROVAL_SENDERS) {
        const lists = { ...empty, always: ["http://trusted.example", "https://trusted.example:8443", "https://sub.trusted.example"] };
        const yes = selfApproves(lists, sender, ["trusted.example"]);
        const g = grantableOrigin(sender);
        if (yes) assert.equal(decide(lists, g.origin, ["trusted.example"]), "always", `${label}: self-approves but the gate would refuse it`);
    }
    const denied = { ...empty, denied: ["https://trusted.example"] };
    assert.equal(selfApproves(denied, { url: "https://trusted.example/" }, ["trusted.example"]), false, "a denial wins over the whitelist");
    // Being approved for window.ml over http does not make the http origin self-approving.
    assert.equal(selfApproves({ ...empty, always: ["http://trusted.example"] }, { url: "http://trusted.example/" }, ["trusted.example"]), false);
    // An entry written as an http origin is the person's explicit choice for that one origin, and the gate agrees.
    assert.equal(selfApproves(empty, { url: "http://127.0.0.1:5123/" }, ["http://127.0.0.1:5123"]), true);
    assert.equal(decide(empty, "http://127.0.0.1:5123", ["http://127.0.0.1:5123"]), "always");
    assert.equal(selfApproves(empty, { url: "http://127.0.0.1:5124/" }, ["http://127.0.0.1:5123"]), false, "another port");
});

test("UPGRADE: a stored whitelist of bare hosts, as the settings wrote it, keeps working for https senders", () => {
    // What every earlier build stored: normalised bare hostnames (settings.tsx / popup.ts `normDomain`), in sync.
    const stored = ["docs.google.com", "example.org", "127.0.0.1"];
    for (const host of stored) {
        assert.equal(selfApproves(empty, { url: `https://${host}/any/page` }, stored), true, host);
        assert.equal(decide(empty, `https://${host}`, stored), "always", host);
        assert.equal(selfApproves(empty, { url: `http://${host}/any/page` }, stored), false, `${host} over http`);
    }
});

// --- how an edit changes them ---

test("allowing moves an origin to one scope and lifts a denial; revoking leaves it unknown; un-denying leaves approvals alone", () => {
    const o = "https://a.example";
    let l = applyEdit({ ...empty, denied: [o] }, { op: "allow", origin: o, scope: "session" });
    assert.deepEqual(l, { always: [], session: [o], denied: [] });
    l = applyEdit(l, { op: "allow", origin: o, scope: "always" });
    assert.deepEqual(l, { always: [o], session: [], denied: [] }, "one scope at a time");
    l = applyEdit(l, { op: "deny", origin: o });
    assert.deepEqual(l, { always: [], session: [], denied: [o] }, "a denial removes every approval");
    l = applyEdit(l, { op: "undeny", origin: o });
    assert.deepEqual(l, empty);
    l = applyEdit({ always: [o, "https://b.example"], session: [o], denied: [] }, { op: "revoke", origin: o });
    assert.deepEqual(l, { always: ["https://b.example"], session: [], denied: [] }, "other origins untouched");
});

test("an edit never changes the lists it was given, and adding twice keeps one entry", () => {
    const before = { always: ["https://a.example"], session: [], denied: [] };
    const after = applyEdit(before, { op: "allow", origin: "https://a.example", scope: "always" });
    assert.deepEqual(after.always, ["https://a.example"]);
    assert.deepEqual(before, { always: ["https://a.example"], session: [], denied: [] });
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
