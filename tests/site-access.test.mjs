// site-access.test.mjs — the pure rules of which sites may use window.ml (src/site-access.ts,
// docs/spec/SITE_ACCESS.md): what an origin is, which senders can ever be granted, how the lists decide, and how an
// edit changes them. The gate that applies them at the router is tested in redteam.test.js, against the real bundle.
import { test } from "node:test";
import assert from "node:assert/strict";

const { originOf, grantableOrigin, decide, applyEdit, originFromInput, selfApprovalOrigin, selfApproves, uncoveredApprovals, whitelistEntryFromInput } = await import("../src/site-access.ts");

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

// --- the upgrade from a whitelist of hosts: an http or port origin it stopped covering is listed, with a fix ---

/** What an install before #628 held: `pageApprovalDomains` as bare hosts (loopback names, a LAN box, a public
 *  site), and, in the site gate, the http origins the person had allowed so that those pages could use window.ml at
 *  all (the gate never implied http). Each of these self-approved by HOST before. */
const OLD_INSTALL = {
    hosts: ["docs.google.com", "localhost", "127.0.0.1", "[::1]", "mlbox.lan"],
    lists: { always: ["http://localhost:3000", "http://127.0.0.1:8080", "http://[::1]:5173", "http://mlbox.lan:8080", "https://mlbox.lan:8443"], session: [], denied: [] },
};

test("UPGRADE: a bare entry, loopback or LAN, no longer self-approves its http or port origins; each is listed, and Add restores it", () => {
    const { hosts, lists } = OLD_INSTALL;
    const lost = ["http://127.0.0.1:8080", "http://[::1]:5173", "http://localhost:3000", "http://mlbox.lan:8080", "https://mlbox.lan:8443"];
    // A bare entry is https://host on the default port, loopback included: none of the old http or port origins acts
    // as the whitelisted site any more, and the https site still does.
    for (const o of lost) assert.equal(selfApproves(lists, { url: `${o}/` }, hosts), false, o);
    assert.equal(selfApproves(lists, { url: "https://docs.google.com/d" }, hosts), true);
    // The gate never implies those origins either: only the person's own approval lets them use window.ml.
    for (const o of ["http://localhost:9999", "https://localhost:8443"]) assert.equal(decide(lists, o, hosts), "unknown", o);
    // What the person is shown: exactly the approved origins a bare entry stopped covering, loopback and LAN alike.
    assert.deepEqual(uncoveredApprovals(lists, hosts), [...lost].sort());
    // The fix the notice offers: add the exact origin. It then self-approves, and the notice no longer lists it.
    let after = [...hosts];
    for (const o of ["http://localhost:3000", "http://mlbox.lan:8080"]) {
        after = [...after, whitelistEntryFromInput(o)];
        assert.equal(selfApproves(lists, { url: `${o}/app` }, after), true, o);
    }
    assert.deepEqual(uncoveredApprovals(lists, after), ["http://127.0.0.1:8080", "http://[::1]:5173", "https://mlbox.lan:8443"]);
    // An added origin is that origin only: not another port of the same host.
    assert.equal(selfApproves({ ...empty, always: ["http://localhost:3001"] }, { url: "http://localhost:3001/" }, after), false);
    // A denied origin, or an approval of an unrelated host, is never listed.
    assert.deepEqual(uncoveredApprovals({ always: ["http://mlbox.lan:8080", "http://other.lan"], session: [], denied: ["http://mlbox.lan:8080"] }, hosts), []);
    assert.deepEqual(uncoveredApprovals({ ...empty, session: ["http://mlbox.lan:9000"] }, hosts), ["http://mlbox.lan:9000"], "a session approval too");
});

test("an origin approved for this session self-approves when it is on the whitelist, as one approved always does", () => {
    // decide() answers "session" before it consults the whitelist, so a whitelisted origin also allowed for the session
    // must not lose its self-approval.
    assert.equal(selfApproves({ ...empty, session: ["https://trusted.example"] }, { url: "https://trusted.example/" }, ["trusted.example"]), true);
    assert.equal(selfApproves({ ...empty, session: ["http://localhost:3000"] }, { url: "http://localhost:3000/" }, ["http://localhost:3000"]), true);
});

test("a whitelist entry typed into Settings round-trips: https on the default port is a bare host, anything else its origin", () => {
    const cases = [
        ["docs.example", "docs.example"], ["https://Docs.Example/some/page", "docs.example"], ["https://docs.example:443/", "docs.example"],
        ["http://127.0.0.1:5123/", "http://127.0.0.1:5123"], ["http://mlbox.lan:8080", "http://mlbox.lan:8080"],
        ["https://docs.example:8443", "https://docs.example:8443"], ["http://localhost", "http://localhost"], ["localhost", "localhost"],
    ];
    for (const [typed, stored] of cases) {
        assert.equal(whitelistEntryFromInput(typed), stored, typed);
        // What is stored trusts the origin the person typed, and nothing else.
        assert.equal(selfApprovalOrigin(stored), originFromInput(typed), typed);
    }
    for (const bad of ["", "  ", "ftp://x.example", "intranet", "not a host", "file:///etc/passwd"]) assert.equal(whitelistEntryFromInput(bad), null, bad);
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
