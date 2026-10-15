// effects.test.mjs — the effect algebra (src/effects.ts, docs/spec/EFFECTS.md): one test per row of the spec's projection
// table and of its placement table, the free tier enumerated over every operation and resource class at every placement,
// `unknown` inside no bound, and the helpers a policy reads.
import { test } from "node:test";
import assert from "node:assert/strict";

const { effectSet, union, effectKey, resolveHeap, fromLibraryEffect, fromProgramEffect, fromFetch, fromInstall, boundFor, covers, isReadInRoots, free, ANY_HOST } = await import("../src/effects.ts");

const keys = (data) => data === "unknown" ? "unknown" : data.map(effectKey).sort();
const fs = (path, inRoot, secret) => ({ kind: "fs", path, ...(inRoot === undefined ? {} : { inRoot }), ...(secret === undefined ? {} : { secret }) });
const net = (host) => ({ kind: "net", host });
const heapArg = (arg) => ({ kind: "heap", of: { arg } });

// --- the projection table, one test per row (EFFECTS.md, "Each vocabulary is a projection") ---

test("library `pure`: reads each argument and nothing else", () => {
    assert.deepEqual(fromLibraryEffect("pure", 3), [0, 1, 2].map((i) => ({ op: "read", res: heapArg(i) })));
    assert.deepEqual(fromLibraryEffect("pure", 0), [], "a pure call with no arguments affects nothing");
});

test("library `mutates(i)`: writes argument i, which the interpreter resolves to owned or unowned", () => {
    const e = fromLibraryEffect({ mutates: [0, 2] }, 3);
    assert.deepEqual(e, [{ op: "write", res: heapArg(0) }, { op: "write", res: heapArg(2) }]);
    const owned = resolveHeap(e, (i) => i === 0 ? "owned" : "unowned");
    assert.deepEqual(keys(owned), ["write:heap:owned", "write:heap:unowned"]);
    const py = boundFor("python-dialect");
    assert.equal(free(resolveHeap(e, () => "owned"), py), true, "mutating only what it owns is inside the dialect's bound");
    assert.equal(free(owned, py), false, "mutating an unowned value is not");
    assert.equal(free(e, py), false, "an unresolved `arg i` is inside no bound");
});

test("library `cache`: nothing observable", () => {
    assert.deepEqual(fromLibraryEffect("cache", 2), []);
});

test("library `reads-external`: read(entropy)", () => {
    assert.deepEqual(fromLibraryEffect("reads-external", 1), [{ op: "read", res: { kind: "entropy" } }]);
});

test("library `external`: unknown unless the manifest names the resource", () => {
    assert.equal(fromLibraryEffect("external", 1), "unknown");
    assert.equal(fromLibraryEffect({ external: [] }, 1), "unknown", "naming nothing is not naming a resource");
    const named = [{ op: "write", res: fs("/tmp/x") }];
    assert.deepEqual(fromLibraryEffect({ external: named }, 1), named);
});

test("library callback called outside the interpreter: exec(heap(unowned)), refused at every placement", () => {
    const e = fromLibraryEffect("callback-outside", 1);
    assert.deepEqual(e, [{ op: "exec", res: { kind: "heap", of: "unowned" } }]);
    for (const p of PLACEMENTS) assert.equal(free(e, boundFor(p, { entropy: true, netAllowlist: ["*"] })), false, p);
});

test("program `read`: read(fs(p)) for each path argument, nothing else", () => {
    const paths = [fs("/r/a", true, false), fs("/r/b", true, false)];
    assert.deepEqual(fromProgramEffect("read", { paths }), paths.map((res) => ({ op: "read", res })));
    assert.deepEqual(fromProgramEffect("read", {}), [], "no path arguments, no effect");
});

test("program `write`: write(fs(p)) for the paths it names", () => {
    const paths = [fs("/r/out", true, false)];
    assert.deepEqual(fromProgramEffect("write", { paths }), [{ op: "write", res: paths[0] }]);
});

test("program `runs-code`: exec(process)", () => {
    assert.deepEqual(fromProgramEffect("runs-code"), [{ op: "exec", res: { kind: "process" } }]);
});

test("program `network`: read and/or write net(host), host from the arguments, else any host; no direction is both", () => {
    assert.deepEqual(keys(fromProgramEffect({ network: {} }, { host: "github.com" })), ["read:net:github.com", "write:net:github.com"]);
    assert.deepEqual(keys(fromProgramEffect({ network: { direction: "read" } }, { host: "github.com" })), ["read:net:github.com"]);
    assert.deepEqual(keys(fromProgramEffect({ network: { direction: "write" } })), ["write:net:*"]);
    assert.deepEqual(keys(fromProgramEffect({ network: { direction: "both" } })), ["read:net:*", "write:net:*"]);
    assert.equal(fromProgramEffect("unknown"), "unknown", "a flag the manifest does not know");
});

test("ml.fetch, a cached read: nothing", () => {
    assert.deepEqual(fromFetch({ url: "https://example.com/a", cached: true }), []);
});

test("ml.fetch, a live GET: read(net(host))", () => {
    assert.deepEqual(fromFetch({ url: "https://Example.com:8443/a?b" }), [{ op: "read", res: net("example.com") }]);
    assert.deepEqual(fromFetch({ url: "https://example.com/", method: "head" }), [{ op: "read", res: net("example.com") }]);
    assert.deepEqual(keys(fromFetch({ url: "https://example.com/", method: "POST" })), ["read:net:example.com", "write:net:example.com"], "a method that sends is also a write");
    for (const bad of ["not a url", "", "file:///etc/passwd"]) assert.equal(fromFetch({ url: bad }), "unknown", bad);
});

test("ml.fetch with a handle: read(net(host)) + use(secret(name))", () => {
    const e = fromFetch({ url: "https://api.github.com/x", secret: "github" });
    assert.deepEqual(keys(e), ["read:net:api.github.com", "use:secret:github"]);
    assert.equal(effectSet(e).uses("github"), true);
    assert.equal(effectSet(e).uses("gitlab"), false);
});

test("package install: read(net(index)) + write(fs(site-packages)) + alloc", () => {
    const site = fs("/env/site-packages");
    assert.deepEqual(fromInstall({ indexHost: "PyPI.org", sitePackages: site }), [
        { op: "read", res: net("pypi.org") }, { op: "write", res: site }, { op: "alloc", res: site },
    ]);
});

test("no projection can produce read(secret(_)): a secret is only ever used", () => {
    const all = [
        ...["pure", "cache", "reads-external", "external", "callback-outside", { mutates: [0] }].map((t) => fromLibraryEffect(t, 2)),
        ...["read", "write", "runs-code", "unknown", { network: {} }].map((t) => fromProgramEffect(t, { paths: [fs("/a", true, true)], host: "h" })),
        fromFetch({ url: "https://h/", secret: "s" }), fromFetch({ url: "https://h/", method: "PUT", secret: "s" }),
        fromInstall({ indexHost: "h", sitePackages: fs("/s") }),
    ];
    for (const d of all) if (d !== "unknown") for (const e of d) if (e.res.kind === "secret") assert.equal(e.op, "use");
});

// --- the placement table, one test per row (EFFECTS.md, "What an enforcer bounds") ---

const PLACEMENTS = ["main-world", "worker-survey", "python-dialect", "container", "host-sandbox", "host-plain"];

test("the page's main world bounds nothing", () => assert.deepEqual(boundFor("main-world"), []));
test("a worker-side survey bounds nothing", () => assert.deepEqual(boundFor("worker-survey"), []));
test("plain host mode bounds nothing", () => assert.deepEqual(boundFor("host-plain", { netAllowlist: ["a.com"] }), [], "an allowlist means nothing without an enforcer"));

test("the Python dialect bounds read/write/alloc on owned heap, plus read(entropy) when allowed", () => {
    const heap = ["alloc:heap:owned", "read:heap:owned", "write:heap:owned"];
    assert.deepEqual(boundFor("python-dialect").map((b) => `${b.op}:${b.res.kind}:${b.res.of}`).sort(), heap);
    assert.deepEqual(boundFor("python-dialect", { entropy: true }).map((b) => b.op + ":" + b.res.kind).sort(), ["alloc:heap", "read:entropy", "read:heap", "write:heap"]);
});

for (const p of ["container", "host-sandbox"]) {
    test(`${p} bounds read/write inside its roots, exec(process) inside it, and the allowlisted hosts`, () => {
        const b = boundFor(p, { netAllowlist: ["PyPI.org"] });
        assert.deepEqual(b.map((x) => `${x.op}:${x.res.kind}:${x.res.within ?? x.res.host ?? ""}`).sort(),
            ["exec:process:", "read:fs:roots", "read:net:pypi.org", "write:fs:roots", "write:net:pypi.org"]);
        assert.equal(free([{ op: "write", res: fs("/r/a", true, false) }], b), true, "a write inside the roots is free under this enforcer");
        assert.equal(free([{ op: "write", res: fs("/etc/a", false, false) }], b), false, "a write outside is not");
        assert.equal(free([{ op: "read", res: net("other.org") }], b), false, "a host off the allowlist is not");
    });
}

// --- the free tier, enumerated over every operation and resource class at every placement ---

/** Every resource class the decision can turn on, by name. */
const RESOURCES = {
    heapOwned: { kind: "heap", of: "owned" }, heapUnowned: { kind: "heap", of: "unowned" }, heapArg: heapArg(0),
    fsInRoot: fs("/r/a", true, false), fsOutOfRoot: fs("/etc/a", false, false), fsSecretInRoot: fs("/r/.env", true, true),
    fsUnresolved: fs("/r/a"), netAllowed: net("pypi.org"), netOther: net("evil.example"), netAny: net(ANY_HOST),
    process: { kind: "process" }, entropy: { kind: "entropy" }, secret: { kind: "secret", name: "gh" }, unknown: { kind: "unknown" },
};
const OPS = ["read", "write", "exec", "use", "alloc"];
const SANDBOXED = ["read:fsInRoot", "write:fsInRoot", "exec:process", "read:netAllowed", "write:netAllowed"];
/** The pairs free at each placement, written out by hand: everything else asks. `read:fsInRoot` is ReadsInRoots. */
const FREE = {
    "main-world": ["read:fsInRoot"], "worker-survey": ["read:fsInRoot"], "host-plain": ["read:fsInRoot"],
    "python-dialect": ["read:fsInRoot", "read:heapOwned", "write:heapOwned", "alloc:heapOwned", "read:entropy"],
    container: SANDBOXED, "host-sandbox": SANDBOXED,
};

test("free tier: every (operation, resource class) at every placement, against a table written by hand", () => {
    let n = 0;
    for (const p of PLACEMENTS) {
        const bound = boundFor(p, { entropy: true, netAllowlist: ["pypi.org"] });
        for (const op of OPS) for (const [name, res] of Object.entries(RESOURCES)) {
            n++;
            assert.equal(free([{ op, res }], bound), FREE[p].includes(`${op}:${name}`), `${p} ${op}:${name}`);
        }
    }
    assert.equal(n, PLACEMENTS.length * OPS.length * Object.keys(RESOURCES).length);
});

test("ReadsInRoots excludes a secret-flagged path and a path the host did not resolve", () => {
    assert.equal(isReadInRoots({ op: "read", res: fs("/r/a", true, false) }), true);
    assert.equal(isReadInRoots({ op: "read", res: fs("/r/a", true) }), true, "secret unset is not secret");
    assert.equal(isReadInRoots({ op: "read", res: fs("/r/.env", true, true) }), false);
    assert.equal(isReadInRoots({ op: "read", res: fs("/r/a") }), false, "inRoot unset is not vouched for");
    assert.equal(isReadInRoots({ op: "write", res: fs("/r/a", true, false) }), false);
});

test("a net bound of any host covers every host; a named bound never covers an unnamed destination", () => {
    const any = { op: "read", res: { kind: "net", host: ANY_HOST } };
    const one = { op: "read", res: { kind: "net", host: "a.com" } };
    assert.equal(covers(any, { op: "read", res: net("b.com") }), true);
    assert.equal(covers(any, { op: "read", res: net(ANY_HOST) }), true);
    assert.equal(covers(one, { op: "read", res: net("A.com") }), true, "hosts compare case-insensitively");
    assert.equal(covers(one, { op: "read", res: net(ANY_HOST) }), false);
    assert.equal(covers(one, { op: "write", res: net("a.com") }), false, "the operation must match");
});

// --- unknown is the top element ---

test("`unknown` is inside no bound, the empty one included", () => {
    assert.equal(free("unknown", []), false);
    for (const p of PLACEMENTS) assert.equal(free("unknown", boundFor(p, { entropy: true, netAllowlist: [ANY_HOST] })), false, p);
});

test("the empty set is inside every bound, the empty one included", () => {
    assert.equal(free([], []), true);
    for (const p of PLACEMENTS) assert.equal(free([], boundFor(p)), true, p);
});

test("a union with `unknown` is `unknown`; otherwise the pairs, de-duplicated", () => {
    const a = [{ op: "read", res: net("a.com") }];
    assert.equal(union(a, "unknown"), "unknown");
    assert.deepEqual(keys(union(a, a, [{ op: "exec", res: { kind: "process" } }])), ["exec:process", "read:net:a.com"]);
});

// --- the set a policy reads (c.effects) ---

test("has, reads, writes and uses answer set questions over the pairs", () => {
    const s = effectSet([
        { op: "read", res: fs("/r/a", true, false) }, { op: "write", res: fs("/r/b", true, false) },
        { op: "write", res: fs("/r/b", true, false) }, { op: "use", res: { kind: "secret", name: "gh" } },
    ]);
    assert.equal(s.unknown, false);
    assert.equal(s.pairs.length, 3, "duplicates dropped");
    assert.equal(s.has("write"), true);
    assert.equal(s.has("write", "fs"), true);
    assert.equal(s.has("write", "net"), false);
    assert.equal(s.has("exec"), false);
    assert.deepEqual(s.reads.map((r) => r.path), ["/r/a"]);
    assert.deepEqual(s.writes.map((r) => r.path), ["/r/b"]);
    assert.equal(s.writes.every((r) => r.inRoot), true);
    assert.equal(s.uses("gh"), true);
});

test("on `unknown` every question answers in the direction that asks", () => {
    const s = effectSet("unknown");
    assert.equal(s.unknown, true);
    for (const op of OPS) assert.equal(s.has(op), true, op);
    assert.equal(s.uses("anything"), true);
    assert.equal(s.reads.every((r) => r.inRoot), false, "`every` over an unknown set is not vacuously true");
    assert.equal(s.writes.every((r) => r.inRoot && !r.secret), false);
});

test("the plain-host default, a universal over the set, agrees with `free` on every single pair", () => {
    // A universal, never an exclusion list: an operation nobody named (use, alloc) is out without being named.
    const policy = (e) => !e.unknown && e.pairs.every((p) => p.op === "read" && p.res.kind === "fs" && p.res.inRoot === true && p.res.secret !== true);
    for (const op of OPS) for (const [name, res] of Object.entries(RESOURCES)) {
        const pair = [{ op, res }];
        assert.equal(policy(effectSet(pair)), free(pair, boundFor("host-plain")), `${op}:${name}`);
    }
    assert.equal(policy(effectSet("unknown")), free("unknown", []));
});

test("an effect set is frozen all the way down", () => {
    const s = effectSet([{ op: "write", res: heapArg(1) }]);
    assert.equal(Object.isFrozen(s), true);
    assert.equal(Object.isFrozen(s.pairs[0]), true);
    assert.equal(Object.isFrozen(s.pairs[0].res), true);
    assert.equal(Object.isFrozen(s.pairs[0].res.of), true);
    assert.equal(Object.isFrozen(s.writes), true);
    assert.equal(Object.isFrozen(effectSet("unknown").reads), true);
});
