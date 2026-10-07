// site-access.test.mjs — the pure rules of which sites may use window.ml (src/site-access.ts,
// docs/spec/SITE_ACCESS.md): what an origin is, which senders can ever be granted, how the lists decide, and how an
// edit changes them. The gate that applies them at the router is tested in redteam.test.js, against the real bundle.
import { test } from "node:test";
import assert from "node:assert/strict";

const { originOf, grantableOrigin, decide, applyEdit, originFromInput } = await import("../src/site-access.ts");

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
    assert.equal(decide(empty, "https://docs.example:8443", ["docs.example"]), "always", "any port: the list is keyed by host");
    assert.equal(decide(empty, "http://docs.example", ["docs.example"]), "unknown", "never plain http: anyone on the wire could be it");
    assert.equal(decide(empty, "https://sub.docs.example", ["docs.example"]), "unknown", "a host, not a domain suffix");
    assert.equal(decide({ ...empty, denied: ["https://docs.example"] }, "https://docs.example", ["docs.example"]), "denied");
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
