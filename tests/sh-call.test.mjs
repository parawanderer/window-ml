// sh-call.test.mjs — one `ml.sh.run` call before and after the process host (src/shell/sh-call.ts) and the host
// protocol's call layer (src/shell/host-protocol.ts), with no host and no worker: the argument checks, the spawn the
// manifest shapes, the facts a policy and the card are given, the result, and the client's seq/done/close rules.

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseShRun, planSpawn, shFacts, shCardLines, headText, shOut, shResult, wireCodeOf, manifestFor, SHIPPED_MANIFESTS, ShRefused, SH_LIMITS, envelopeFor } from "../src/shell/sh-call.ts";
import { HostClient, HostError, hostTakesEnvelope, READ_CHUNK, bytesOf } from "../src/shell/host-protocol.ts";

const S = { cwd: "/w" };
const refused = (args, code, re) => assert.throws(() => parseShRun(args), (e) => e instanceof ShRefused && e.code === code && re.test(e.message), `${JSON.stringify(args)} → ${code}`);

// --- what a script may pass ---

test("argv is an array of strings with the program first; anything else is refused with the form that is right", () => {
    refused(["git status"], "BadRequest", /takes an argv array, not a command string: ml\.sh\.run\(\["git", "status"\]\)\. No shell/);
    refused([], "BadRequest", /first argument is an argv array/);
    refused([[]], "BadRequest", /first argument is an argv array/);
    refused([{ 0: "ls", length: 1 }], "BadRequest", /first argument is an argv array/);
    refused([["ls", 3]], "BadRequest", /argv\[1\] is a number; every argument is a string \(write String\(x\)/);
    refused([["ls", null]], "BadRequest", /argv\[1\] is a null/);
    refused([["ls", "a\0b"]], "BadRequest", /argv\[1\] contains a NUL/);
    refused([[""]], "BadRequest", /argv\[0\] is the program, and it is empty/);
    refused([Array(SH_LIMITS.argv + 1).fill("x")], "BadRequest", /longer than ml\.sh\.run takes/);
    refused([["echo", "x".repeat(SH_LIMITS.argChars + 1)]], "BadRequest", /longer than one argument may be/);
    refused([["echo", ...Array(3).fill("x".repeat(SH_LIMITS.argChars))]], "BadRequest", /longer than one call may carry/);
    assert.deepEqual(parseShRun([["git", "status"]]), { argv: ["git", "status"], env: {} }, "positive control");
    assert.deepEqual(parseShRun([["ls"], null]), { argv: ["ls"], env: {} }, "null options are no options");
});

test("the options are cwd, env and timeoutMs, each checked; an unknown one is refused by name, and shell says there is none", () => {
    refused([["ls"], { shell: true }], "BadRequest", /no option "shell"; its options are cwd, env, timeoutMs\. There is no shell: pass the argv/);
    refused([["ls"], { stdio: "inherit" }], "BadRequest", /no option "stdio"/);
    refused([["ls"], "x"], "BadRequest", /second argument is an options object/);
    refused([["ls"], { cwd: 3 }], "BadRequest", /cwd is a directory path/);
    refused([["ls"], { cwd: "" }], "BadRequest", /cwd is a directory path/);
    refused([["ls"], { env: ["A=1"] }], "BadRequest", /env is an object/);
    refused([["ls"], { env: { "A-B": "1" } }], "BadRequest", /env name "A-B" is not a variable name/);
    refused([["ls"], { env: { A: 1 } }], "BadRequest", /env\.A is a number; a value is a string/);
    refused([["ls"], { env: { A: "a\0" } }], "BadRequest", /env\.A contains a NUL/);
    refused([["ls"], { env: { GH_TOKEN: { $secret: "github" } } }], "SecretHandle", /env\.GH_TOKEN is a secret handle, and ml\.sh cannot inject secrets yet/);
    refused([["ls"], { env: Object.fromEntries(Array.from({ length: SH_LIMITS.env + 1 }, (_, i) => [`V${i}`, "1"])) }], "BadRequest", /sets 65 variables/);
    refused([["ls"], { timeoutMs: 0 }], "BadRequest", /timeoutMs is a positive number/);
    refused([["ls"], { timeoutMs: Infinity }], "BadRequest", /timeoutMs is a positive number/);
    assert.deepEqual(parseShRun([["ls"], { cwd: "src", env: { LC_ALL: "C" }, timeoutMs: 9e9 }]), { argv: ["ls"], cwd: "src", env: { LC_ALL: "C" }, timeoutMs: SH_LIMITS.timeoutMs }, "a long timeout is capped, not refused");
});

// --- what the host is asked ---

test("the manifests are found by the program's basename, and only the shipped ones", () => {
    assert.deepEqual(Object.keys(SHIPPED_MANIFESTS).sort(), ["cat", "find", "git", "head", "jq", "ls", "rg", "tail", "wc"]);
    assert.equal(manifestFor(["/usr/bin/git"])?.program, "git");
    assert.equal(manifestFor(["python3"]), undefined);
    assert.equal(manifestFor(["constructor"]), undefined, "a prototype name is not a manifest");
    assert.equal(manifestFor(["__proto__"]), undefined);
});

test("the spawn carries the HARDENED argv, and its path indices point into that argv, not the one the script wrote", () => {
    const p = planSpawn(parseShRun([["git", "-C", "sub", "log", "--output=o.txt"]]), S);
    assert.deepEqual(p.spawn.argv, ["git", "--no-pager", "-C", "sub", "log", "--no-ext-diff", "--no-textconv", "--output=o.txt"]);
    assert.deepEqual(p.spawn.pathArgs, [{ arg: 3 }, { arg: 7, split: "=" }]);
    assert.equal(p.spawn.argv[3], "sub");
    assert.equal(p.spawn.repoArg, 3, "git -C names the repository");
    assert.deepEqual(planSpawn(parseShRun([["git", "status"]]), S).spawn.argv, ["git", "--no-pager", "status"],
        "hardening applies to a call the manifest cannot describe yet (no version reported)");
    assert.deepEqual(planSpawn(parseShRun([["git", "--no-pager", "status"]]), S).spawn.argv, ["git", "--no-pager", "status"], "never twice");
});

test("a recursive reader's operand is walked, and with no operand its directory is", () => {
    assert.deepEqual(planSpawn(parseShRun([["rg", "-n", "TODO", "src"]]), S).spawn.pathArgs, [{ arg: 3, walk: true }]);
    assert.equal(planSpawn(parseShRun([["ls", "-R"]]), S).spawn.walkCwd, true);
    assert.equal(planSpawn(parseShRun([["ls"]]), S).spawn.walkCwd, undefined, "plain ls lists, it does not walk");
    assert.deepEqual(planSpawn(parseShRun([["cat", "a.txt"]]), S).spawn.pathArgs, [{ arg: 1 }]);
});

test("an unannotated program is spawned as written, with no path the host is asked to vouch for", () => {
    const p = planSpawn(parseShRun([["python3", "x.py"], { env: { LC_ALL: "C" }, timeoutMs: 5 }]), S);
    assert.deepEqual(p.spawn, { argv: ["python3", "x.py"], cwd: "/w", env: { LC_ALL: "C" }, mode: "host", timeoutMs: 5 });
    assert.equal(p.description, null);
});

test("cwd: the session's by default, a relative one under it, an absolute one as given (the host judges it against the roots)", () => {
    assert.equal(planSpawn(parseShRun([["ls"]]), S).spawn.cwd, "/w");
    assert.equal(planSpawn(parseShRun([["ls"], { cwd: "src/a" }]), { cwd: "/w/" }).spawn.cwd, "/w/src/a");
    assert.equal(planSpawn(parseShRun([["ls"], { cwd: "/etc" }]), S).spawn.cwd, "/etc");
});

// --- the facts a policy and the card are given ---

/** The host's answer to a spawn, with fields over it. */
const facts = (over = {}) => ({
    id: "c1", argv: ["cat", "a.txt"], program: { path: "/bin/cat", inRoot: false }, cwd: { path: "/w", inRoot: true },
    env: { set: [], secrets: [], free: true }, repo: null, repoConfigRunsCode: null,
    paths: [{ arg: 1, given: "a.txt", path: "/w/a.txt", inRoot: true, secret: false, exists: true }],
    effects: "unknown", mode: "host", sandboxed: true, placement: "host-sandbox", expiresInMs: 1, ...over,
});

test("the facts' effects are the manifest's over the HOST's resolution: inRoot and secret come from the host, never the script", () => {
    const f = shFacts(facts());
    assert.equal(f.described, true);
    assert.deepEqual(f.effects, [{ op: "read", res: { kind: "fs", path: "/w/a.txt", inRoot: true, secret: false, exists: true } }]);
    const out = shFacts(facts({ paths: [{ arg: 1, given: "../x/.env", path: "/x/.env", inRoot: false, secret: true, exists: true }], argv: ["cat", "../x/.env"] }));
    assert.deepEqual(out.effects, [{ op: "read", res: { kind: "fs", path: "/x/.env", inRoot: false, secret: true, exists: true } }]);
});

test("a walked directory with a secret beneath it, or one too large to tell, counts as a secret", () => {
    for (const containsSecret of [true, null]) {
        // find, not rg: rg's manifest needs the version the host does not report yet, so its effects are unknown anyway.
        const f = shFacts(facts({ argv: ["find", "src"], paths: [{ arg: 1, given: "src", path: "/w/src", inRoot: true, secret: false, exists: true, containsSecret }] }));
        assert.notEqual(f.effects, "unknown");
        assert.equal(f.effects.every((e) => e.res.secret === true), true, `containsSecret ${containsSecret}`);
    }
    const clean = shFacts(facts({ argv: ["find", "src"], paths: [{ arg: 1, given: "src", path: "/w/src", inRoot: true, secret: false, exists: true, containsSecret: false }] }));
    assert.equal(clean.effects[0].res.secret, false, "positive control");
    const cwd = shFacts(facts({ argv: ["ls", "-R"], paths: [], cwd: { path: "/w", inRoot: true, containsSecret: true } }));
    assert.equal(cwd.effects[0].res.secret, true, "the walked cwd too");
});

test("an unannotated program, a variable off the free list, or an argument the manifest does not know is unknown, with why", () => {
    const none = shFacts(facts({ argv: ["python3", "x.py"], paths: [] }));
    assert.equal(none.effects, "unknown");
    assert.deepEqual(none.why, ["python3 has no program manifest"]);
    const env = shFacts(facts({ env: { set: ["FOO"], secrets: [], free: false } }));
    assert.equal(env.effects, "unknown");
    assert.match(env.why.at(-1), /sets FOO, which is not on the free list/);
    assert.equal(shFacts(facts({ env: { set: ["LC_ALL"], secrets: [], free: true } })).described, true, "a free variable keeps it described");
    const flag = shFacts(facts({ argv: ["cat", "--made-up", "a.txt"] }));
    assert.equal(flag.effects, "unknown");
    assert.ok(flag.why.length > 0);
});

test("the facts are plain data: no reference into the host's answer survives", () => {
    const h = facts();
    const f = shFacts(h);
    assert.deepEqual(JSON.parse(JSON.stringify(f)), f);
    h.argv.push("x"); h.paths[0].inRoot = false; h.env.set.push("Y");
    assert.deepEqual(f.argv, ["cat", "a.txt"]);
    assert.equal(f.paths[0].inRoot, true);
    assert.deepEqual(f.env.set, []);
});

test("K3c: a call naming a top-level entry of a root asks under the OS sandbox; the same call one level down is free", async () => {
    // The red team's vector end to end: git diff --output=.envrc, described by the shipped manifest over the host's facts.
    const { free, boundFor } = await import("../src/effects.ts");
    const B = boundFor("host-sandbox");
    const at = (path, exists, argv) => shFacts(facts({ argv, cwd: { path: "/w", inRoot: true }, repo: { root: "/w", reasons: [] }, repoConfigRunsCode: false,
        paths: [{ arg: 2, given: argv[2].split("=")[1] ?? argv[2], path, inRoot: true, secret: false, exists }] }), "2.45.0", { roots: ["/w"] });
    const envrc = at("/w/.envrc", false, ["git", "diff", "--output=.envrc"]);
    assert.equal(envrc.described, true, envrc.why.join("; "));
    assert.equal(envrc.paths[0].topLevel, true, "the fact says the path's parent is a root");
    assert.equal(envrc.paths[0].isRoot, false);
    assert.deepEqual([envrc.cwd.topLevel, envrc.cwd.isRoot], [false, true], "a policy reading c.cwd sees the cwd is a root itself");
    assert.equal(free(envrc.effects, B), false, "creating .envrc at the top of a root is not free");
    const lines = shCardLines(envrc);
    const does = lines.find((l) => l.label === "Does");
    assert.match(does.value, /\/w\/\.envrc \(a name at the top of a workspace root\)/, "the card names the top-level entry");
    assert.equal(does.warn, true);
    assert.equal(free(at("/w/README.md", true, ["git", "diff", "--output=README.md"]).effects, B), true, "an in-place write to an existing top-level file stays free");
    const nested = at("/w/out/d.patch", false, ["git", "diff", "--output=out/d.patch"]);
    assert.equal(nested.paths[0].topLevel, false);
    assert.equal(free(nested.effects, B), true, "a new file below a top-level directory stays free");
    assert.equal(shFacts(facts({ argv: ["git", "diff", "--output=.envrc"], paths: [{ arg: 2, given: ".envrc", path: "/w/.envrc", inRoot: true, secret: false, exists: false }] }), "2.45.0").paths[0].topLevel,
        undefined, "without the roots there is no topLevel fact, never a guessed false");
});

test("K3c: find -delete is a names write, so deleting under a root itself or a top-level directory asks, and deeper does not", async () => {
    const { free, boundFor } = await import("../src/effects.ts");
    const B = boundFor("host-sandbox");
    const del = (argv, paths, cwd = "/w") => shFacts(facts({ argv, cwd: { path: cwd, inRoot: true }, paths }), null, { roots: ["/w"] });
    const dir = (arg, given, path) => ({ arg, given, path, inRoot: true, secret: false, exists: true });
    assert.equal(free(del(["find", "-delete"], []).effects, B), false, "no operand: the cwd, here the root itself, whose entries are the top level");
    const dot = del(["find", ".", "-delete"], [dir(1, ".", "/w")]);
    assert.equal(free(dot.effects, B), false, "find . -delete: the operand . resolves to the root itself, whose entries are the top level");
    assert.deepEqual([dot.paths[0].isRoot, dot.cwd.isRoot], [true, true], "isRoot is read off the resolved path, for an operand and for the cwd");
    assert.equal(free(del(["find", "src", "-delete"], [dir(1, "src", "/w/src")]).effects, B), false, "find src -delete removes the top-level src");
    assert.equal(free(del(["find", "src/gen", "-delete"], [dir(1, "src/gen", "/w/src/gen")]).effects, B), true, "two levels down is free");
    assert.match(shCardLines(del(["find", "src", "-delete"], [dir(1, "src", "/w/src")])).find((l) => l.label === "Does").value, /create, remove or rename \/w\/src/);
});

// --- place resolution: the markers follow the host's RESOLVED path, never the lexical `given` ---

test("a symlink's place is what it RESOLVED to: markers off `path`, never `given`, whatever the script typed", async () => {
    // The host resolves symlinks (realpath) and reports `path`; sh-call.ts builds topLevel/isRoot TEXTUALLY over that
    // path and its roots (placeAmongRoots), never over `given`. So a symlink that resolves OUT of the roots is not
    // top-level in-root (an in-place write to it asks, because inRoot is the host's realpath answer), and one that
    // resolves TO a root is a root (a names-write under it asks). The host's own symlink defect is #12's; this pins
    // the extension's half: the markers follow `path`.
    const { free, boundFor } = await import("../src/effects.ts");
    const B = boundFor("host-sandbox");
    const at = (paths, argv, cwd = { path: "/w", inRoot: true }) =>
        shFacts(facts({ argv, cwd, paths }), "2.45.0", { roots: ["/w"] });
    // a: .envrc is a symlink to /tmp/x. The host resolved it out of the roots: inRoot false, path /tmp/x.
    // An in-place write to an "existing top-level file" must NOT be free — the write lands at /tmp/x.
    const out = at([{ arg: 2, given: ".envrc", path: "/tmp/x", inRoot: false, secret: false, exists: true }],
        ["git", "diff", "--output=.envrc"]);
    assert.equal(out.described, true, out.why.join("; "));
    assert.equal(out.paths[0].path, "/tmp/x", "the fact carries the resolved target, not the typed name");
    assert.deepEqual([out.paths[0].topLevel, out.paths[0].isRoot], [false, false], "place markers off the resolved path: /tmp/x's parent is not a root");
    assert.equal(free(out.effects, B), false, "a write to a symlink whose target is outside the roots is covered by nothing");
    // b: src/link is a symlink to /w (the root). A names-write under it removes the root's top-level names.
    const via = at([{ arg: 1, given: "src/link", path: "/w", inRoot: true, secret: false, exists: true }],
        ["find", "src/link", "-delete"]);
    assert.deepEqual([via.paths[0].topLevel, via.paths[0].isRoot], [false, true], "markers off path: the symlink resolved to the root itself");
    assert.equal(free(via.effects, B), false, "a names-write under a symlink that resolves to a root asks");
    // c: src/link resolves to a secret-flagged path. The host's secret answer is the one that counts.
    const sec = at([{ arg: 1, given: "src/link", path: "/w/.env", inRoot: true, secret: true, exists: true }],
        ["cat", "src/link"]);
    assert.equal(sec.effects[0].res.secret, true, "a symlink to a secret path is a secret read");
    assert.equal(free(sec.effects, B), false);
    // Positive control: the same typed name resolving inside the roots at the top level is the ruled top-level claim.
    const real = at([{ arg: 2, given: ".envrc", path: "/w/.envrc", inRoot: true, secret: false, exists: false }],
        ["git", "diff", "--output=.envrc"]);
    assert.equal(real.described, true, real.why.join("; "));
    assert.deepEqual([real.paths[0].topLevel, real.paths[0].isRoot], [true, false]);
    assert.equal(free(real.effects, B), false, "the same claim as a real top-level entry asks");
});

test("a `..` operand from a nested cwd resolves to its target: find .. -delete under a root asks, one level down it does not", async () => {
    // cwd-relative operands, the `..` half. #788 pinned `find . -delete` with cwd = root and a bare `-delete` with no
    // operand. This pins `..` from a nested cwd: the operand `..` resolves to the parent, and the markers are read off
    // that resolved path — so `cd src && find .. -delete` is a names-write on the root itself and asks.
    const { free, boundFor } = await import("../src/effects.ts");
    const B = boundFor("host-sandbox");
    const del = (argv, paths, cwd) => shFacts(facts({ argv, cwd: { path: cwd, inRoot: true }, paths }), null, { roots: ["/w"] });
    const dir = (arg, given, path) => ({ arg, given, path, inRoot: true, secret: false, exists: true });
    // cd src && find .. -maxdepth 1 -delete: .. resolves to /w, the root. Its entries are the top level.
    const up = del(["find", "..", "-maxdepth", "1", "-delete"], [dir(1, "..", "/w")], "/w/src");
    assert.deepEqual([up.paths[0].topLevel, up.paths[0].isRoot], [false, true], "markers off the resolved ..: the root itself");
    assert.equal(free(up.effects, B), false, "find .. -delete from a nested cwd removes the root's top-level names");
    // cd src && find . -delete: . resolves to /w/src, a top-level entry. Removing it removes a top-level name.
    const dot = del(["find", ".", "-delete"], [dir(1, ".", "/w/src")], "/w/src");
    assert.deepEqual([dot.paths[0].topLevel, dot.paths[0].isRoot], [true, false]);
    assert.equal(free(dot.effects, B), false, "find . -delete from a nested cwd removes a top-level entry");
    // Positive control: cd src && find . -name '*.o' -delete under a deeper directory is free (nested removal).
    const deep = del(["find", ".", "-delete"], [dir(1, ".", "/w/src/gen")], "/w/src/gen");
    assert.deepEqual([deep.paths[0].topLevel, deep.paths[0].isRoot], [false, false]);
    assert.equal(free(deep.effects, B), true, "a removal two levels down is free");
});

// --- interpreted scripts: (program, entrypoint) pinned by sha256 (PROGRAM_MANIFEST.md, rulings of 2026-10-19) ---

const PIN = "a".repeat(64);
/** A script manifest for `node scripts/tool.mjs`, reading the files it is given. */
const TOOL = { program: "node", entrypoint: { path: "scripts/tool.mjs", sha256: PIN }, command: { effects: ["read"], paths: "operands", flags: { "-n": {} } } };
const P = { cwd: "/w", roots: ["/w"], manifests: [TOOL] };
/** The host's facts for `node <script> ...args`, with the script resolved to `path` and hashed to `sha256`. */
const scriptFacts = ({ argv = ["node", "scripts/tool.mjs", "a.txt"], path = "/w/scripts/tool.mjs", sha256 = PIN, cwd = "/w", ...over } = {}) => facts({
    argv, cwd: { path: cwd, inRoot: true }, program: { path: "/usr/local/bin/node", inRoot: false },
    paths: [{ arg: 1, given: argv[1], path, inRoot: true, secret: false, exists: true, sha256 },
        { arg: 2, given: "a.txt", path: "/w/a.txt", inRoot: true, secret: false, exists: true }], ...over,
});
const placeOf = { roots: ["/w"], manifests: [TOOL] };

test("a script's manifest is chosen by argv[1] under a root, its options parse from argv[2], and the host is asked to hash it", () => {
    assert.equal(manifestFor(["node", "scripts/tool.mjs"], P, P.manifests), TOOL);
    assert.equal(manifestFor(["node", "./scripts/../scripts/tool.mjs"], P, P.manifests), TOOL, "normalised");
    assert.equal(manifestFor(["node", "tool.mjs"], { cwd: "/w/scripts", roots: ["/w"] }, P.manifests), TOOL, "a relative argv[1] is taken from the cwd");
    assert.equal(manifestFor(["node", "/w/scripts/tool.mjs"], P, P.manifests), TOOL, "an absolute one as given");
    assert.equal(manifestFor(["node", "scripts/other.mjs"], P, P.manifests), undefined);
    assert.equal(manifestFor(["node", "scripts/tool.mjs"], undefined, P.manifests), undefined, "with no roots, no script manifest");
    const p = planSpawn(parseShRun([["node", "scripts/tool.mjs", "-n", "a.txt"]]), P);
    assert.deepEqual(p.spawn.pathArgs, [{ arg: 1, hash: true }, { arg: 3 }]);
    assert.equal(p.description.described, true);
});

test("ruling 3: any interpreter flag before the entrypoint, -u, -X, -W, -- or --import, leaves the call undescribed", () => {
    for (const flags of [["-u"], ["-X", "dev"], ["-W", "error"], ["--"], ["--import", "./evil.mjs"], ["-e", "1"]]) {
        const argv = ["node", ...flags, "scripts/tool.mjs", "a.txt"];
        assert.equal(manifestFor(argv, P, P.manifests), undefined, flags.join(" "));
        const p = planSpawn(parseShRun([argv]), P);
        assert.equal(p.description, null, `${flags.join(" ")}: nothing to describe it by`);
        assert.equal(p.spawn.pathArgs, undefined);
        assert.equal(shFacts(scriptFacts({ argv, paths: [] }), null, placeOf).effects, "unknown", flags.join(" "));
    }
    // describeCall itself refuses a flag at argv[1] even if handed the manifest
    assert.equal(shFacts(scriptFacts(), null, placeOf).described, true, "positive control");
});

test("ruling 2: the pin is the RESOLVED file's hash, the path must resolve to the entrypoint itself, and the card names both paths", () => {
    const ok = shFacts(scriptFacts(), null, placeOf);
    assert.equal(ok.described, true);
    assert.deepEqual(ok.effects, [{ op: "read", res: { kind: "fs", path: "/w/a.txt", inRoot: true, secret: false, exists: true, topLevel: true, isRoot: false } }]);
    // a link to a file outside the scripts folder
    const moved = shFacts(scriptFacts({ path: "/w/tmp/evil.mjs" }), null, placeOf);
    assert.equal(moved.described, false);
    assert.match(moved.why.join(";"), /resolves to \/w\/tmp\/evil\.mjs, not scripts\/tool\.mjs in a workspace root/);
    const wrong = shFacts(scriptFacts({ sha256: "b".repeat(64) }), null, placeOf);
    assert.equal(wrong.effects, "unknown");
    assert.match(wrong.why.join(";"), /not the file its manifest was pinned to \(sha256 b{64}\)/);
    assert.equal(shFacts(scriptFacts({ sha256: null }), null, placeOf).described, false, "an unreadable file has no hash to match");
    const card = shCardLines(shFacts(scriptFacts({ argv: ["node", "scripts/t.mjs", "a.txt"], path: "/w/scripts/tool.mjs" }), null, placeOf));
    const script = card.find((l) => l.label === "Script");
    assert.equal(script.value, `scripts/t.mjs → /w/scripts/tool.mjs (sha256 ${PIN.slice(0, 12)})`);
});

test("intended, not a gap: a symlinked entrypoint FILE is undescribed even when its target has the pinned content (a pin names a path AND a hash)", () => {
    // scripts/tool.mjs is a link to lib/impl.mjs in the same root, whose bytes hash to the pin: still another file
    const link = shFacts(scriptFacts({ path: "/w/lib/impl.mjs", sha256: PIN }), null, placeOf);
    assert.equal(link.described, false);
    assert.equal(link.effects, "unknown");
    assert.match(link.why.join(";"), /resolves to \/w\/lib\/impl\.mjs, not scripts\/tool\.mjs in a workspace root/);
});

test("intended, not a gap: argv[1] outside every root that resolves to the entrypoint is not pre-selected, so it is undescribed", () => {
    const argv = ["node", "/tmp/link.mjs", "a.txt"];
    assert.equal(manifestFor(argv, P, P.manifests), undefined);
    assert.equal(planSpawn(parseShRun([argv]), P).description, null);
    const f = shFacts(scriptFacts({ argv, path: "/w/scripts/tool.mjs" }), null, placeOf);
    assert.equal(f.described, false, "the host's resolution reaching the pinned file does not make it described");
    assert.equal(f.effects, "unknown");
});

test("the pin counts only under the OS sandbox: on the plain host a pinned script is undescribed", () => {
    const f = shFacts(scriptFacts({ sandboxed: false, placement: "host-plain" }), null, placeOf);
    assert.equal(f.described, false);
    assert.match(f.why.join(";"), /described only under the OS sandbox/);
});

test("K1 ships no script manifest: node with a script in the workspace is unknown and asks, as before", () => {
    assert.equal(manifestFor(["node", "scripts/index.mjs"], { cwd: "/w", roots: ["/w"] }), undefined);
    const p = planSpawn(parseShRun([["node", "scripts/index.mjs"]]), { cwd: "/w", roots: ["/w"] });
    assert.deepEqual(p.spawn, { argv: ["node", "scripts/index.mjs"], cwd: "/w", mode: "host" }, "nothing hashed, nothing marked");
    const f = shFacts(facts({ argv: ["node", "scripts/index.mjs"], paths: [] }), null, { roots: ["/w"] });
    assert.equal(f.effects, "unknown");
    assert.deepEqual(f.why, ["node has no program manifest"]);
});

// --- the card ---

test("the card shows what runs, where, under what sandbox, and what it does; it flags each thing worth a second look", () => {
    const lines = shCardLines(shFacts(facts()));
    assert.deepEqual(lines.map((l) => l.label), ["Runs", "Program", "In", "Sandbox", "Path 1", "Does"]);
    assert.equal(lines.find((l) => l.label === "Runs").value, "cat a.txt");
    assert.ok(lines.every((l) => !l.warn), "a plain read in the roots under the sandbox warns about nothing");
    const bad = shCardLines(shFacts(facts({
        sandboxed: false, placement: "host-plain", cwd: { path: "/", inRoot: false }, env: { set: ["PAGER"], secrets: [], free: false },
        paths: [{ arg: 1, given: "a.txt", path: "/etc/a.txt", inRoot: false, secret: true, exists: true }],
        repo: { root: "/w", reasons: ["core.fsmonitor"] }, repoConfigRunsCode: true,
    })));
    const warned = bad.filter((l) => l.warn).map((l) => l.label);
    assert.deepEqual(warned, ["In", "Sandbox", "Sets", "Path 1", "Repository", "Does"]);
    assert.match(bad.find((l) => l.label === "Repository").value, /core\.fsmonitor/);
});

test("the card quotes an argument that could hide where it ends, so one argument never reads as two", () => {
    const lines = shCardLines(shFacts(facts({ argv: ["cat", "a b.txt", "x\"; rm -rf ~"], paths: [] })));
    assert.equal(lines[0].value, `cat "a b.txt" "x\\"; rm -rf ~"`);
});

test("a runner is called out: the card does not show the program it starts", () => {
    const f = shFacts(facts({ argv: ["find", ".", "-exec", "rm", "{}", ";"], paths: [{ arg: 1, given: ".", path: "/w", inRoot: true, secret: false, exists: true, containsSecret: false }] }));
    assert.equal(f.runner, true);
    assert.ok(shCardLines(f).some((l) => l.label === "Starts" && l.warn));
});

// --- the result ---

test("a stream's head is text when it is text, a note when it is binary, and says where it was cut", () => {
    const enc = new TextEncoder();
    assert.deepEqual(headText(enc.encode("hello\n"), 6), { text: "hello\n", complete: true });
    assert.deepEqual(headText(enc.encode("hel"), 600), { text: "hel… [first 3 of 600 bytes]", complete: false });
    const bin = headText(new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 0, 0, 1]), 7);
    assert.equal(bin.complete, false);
    assert.match(bin.text, /^\[binary output: .*, 7 bytes\]$/);
});

test("a stream the host could not keep is an error, and a truncated one is never complete", () => {
    assert.deepEqual(shOut({ error: "disk full" }, null, new Uint8Array()), { token: null, size: 0, truncated: false, sha256: "", text: "", complete: false, error: "disk full" });
    const t = shOut({ ptr: "out:1", size: 2, sha256: "ab", truncated: true }, "@tool:abc1234", new TextEncoder().encode("hi"));
    assert.equal(t.complete, false);
    assert.equal(t.token, "@tool:abc1234");
});

// --- the sandbox envelope (K3): what the worker asks the host to apply, derived from the approved facts alone ---

/** ShFacts with `effects` over them, for the envelope's rule. `runner` and `effects` are the only inputs it reads. */
const envFacts = (effects, runner = false) => ({ effects, runner });

/** One fs resource as the host resolves it. `over` can set exists/topLevel/isRoot/secret/names. */
const fsRes = (path, over = {}) => ({ kind: "fs", path, inRoot: true, secret: false, exists: false, topLevel: false, isRoot: false, ...over });
const W = (res, names = false) => ({ op: "write", res: names ? { ...res, names: true } : res });
const R = (res) => ({ op: "read", res });
const ALLOC = (res) => ({ op: "alloc", res });

test("K3: write none when there is no write effect at all, and alloc on fs counts as a write", () => {
    assert.deepEqual(envelopeFor(envFacts([])), { write: "none", exec: "program-only" }, "no effects at all");
    assert.deepEqual(envelopeFor(envFacts([R(fsRes("/w/a.txt"))])), { write: "none", exec: "program-only" }, "read only");
    assert.deepEqual(envelopeFor(envFacts([R(fsRes("/w/a.txt")), { op: "read", res: { kind: "net", host: "x" } }])), { write: "none", exec: "program-only" }, "reads of net are not writes");
    assert.deepEqual(envelopeFor(envFacts([{ op: "write", res: { kind: "heap", of: "owned" } }])) === undefined, true, "a heap write is a write effect with no path: no envelope");
    assert.deepEqual(envelopeFor(envFacts([ALLOC(fsRes("/w/src/gen/out", { exists: true }))])), { write: "roots", exec: "program-only" }, "alloc on fs is a write where it allocates");
    assert.deepEqual(envelopeFor(envFacts([{ op: "use", res: { kind: "secret", name: "s" } }])), { write: "none", exec: "program-only" }, "using a secret is not a write");
});

test("K3: write roots only when EVERY write is a resolved, non-secret, non-root path that claims no top-level name", () => {
    const nested = fsRes("/w/src/gen/out.txt", { exists: true });
    const nestedNew = fsRes("/w/src/gen/out.txt", { exists: false });
    const topNew = fsRes("/w/.envrc", { exists: false, topLevel: true });
    const topInPlace = fsRes("/w/README.md", { exists: true, topLevel: true });
    const root = fsRes("/w", { exists: true, isRoot: true });
    const noPath = { kind: "fs", path: "x" };
    const secret = fsRes("/w/src/gen/.env", { exists: true, secret: true });
    const wantRoots = { write: "roots", exec: "program-only" };
    assert.deepEqual(envelopeFor(envFacts([W(nested)])), wantRoots, "a nested write");
    assert.deepEqual(envelopeFor(envFacts([W(nestedNew)])), wantRoots, "a nested write to a new file");
    assert.deepEqual(envelopeFor(envFacts([W(nested), W(nestedNew)])), wantRoots, "every write nested");
    assert.deepEqual(envelopeFor(envFacts([W(topInPlace)])), wantRoots, "an in-place write to an existing top-level file is not a name claim");
    assert.equal(envelopeFor(envFacts([W(topNew)])), undefined, "creating a top-level name is the floor's gap: no envelope");
    assert.equal(envelopeFor(envFacts([W(nested), W(topNew)])), undefined, "one top-level claim withholds it for the whole call");
    assert.equal(envelopeFor(envFacts([W(root)])), undefined, "a write whose path IS a root acts on the top level");
    assert.equal(envelopeFor(envFacts([W(noPath)])), undefined, "a write with no path argument cannot be judged");
    assert.equal(envelopeFor(envFacts([W(secret)])), undefined, "a secret path is outside every bound");
    assert.equal(envelopeFor(envFacts([W(nested), W(noPath)])), undefined, "one path-less write withholds it");
});

test("K3: write-names claims a top-level name whenever its place is not known to be below one", () => {
    const nested = fsRes("/w/src/gen/x", { exists: true });
    const top = fsRes("/w/src", { exists: true, topLevel: true });
    const root = fsRes("/w", { exists: true, isRoot: true });
    const unresolved = { kind: "fs", path: "x" };
    assert.deepEqual(envelopeFor(envFacts([W(nested, true)])), { write: "roots", exec: "program-only" }, "a names write below the top level");
    assert.equal(envelopeFor(envFacts([W(top, true)])), undefined, "a names write at the top level");
    assert.equal(envelopeFor(envFacts([W(root, true)])), undefined, "a names write on a root");
    assert.equal(envelopeFor(envFacts([W(unresolved, true)])), undefined, "a names write whose place was not resolved counts as a top-level claim");
});

test("K3: any claim of exec(process) means no envelope; every envelope this function returns is exec program-only", () => {
    const nested = fsRes("/w/src/gen/out.txt", { exists: true });
    assert.deepEqual(envelopeFor(envFacts([W(nested)])), { write: "roots", exec: "program-only" }, "no exec claim: program-only");
    assert.equal(envelopeFor(envFacts([W(nested), { op: "exec", res: { kind: "process" } }])), undefined, "runs-code: no envelope, runner or not");
    assert.equal(envelopeFor(envFacts([{ op: "exec", res: { kind: "process" } }])), undefined, "runs-code with no write");
    assert.equal(envelopeFor(envFacts([W(nested)], true)), undefined, "a runner starts programs no manifest describes: no envelope");
    assert.equal(envelopeFor(envFacts([], true)), undefined, "find -exec rm claims no write of its own; write none would fail rm as ok:false");
    assert.deepEqual(envelopeFor(envFacts([{ op: "exec", res: { kind: "heap", of: "unowned" } }])), { write: "none", exec: "program-only" }, "an exec that is not exec(process) does not by itself withhold");
    // `exec: "any"` is unreachable: the floor is no envelope at all, so exec is never narrowed on its own.
    for (const effects of [[], [R(fsRes("/w/a.txt"))], [W(fsRes("/w/src/gen/x", { exists: true }))], [ALLOC(fsRes("/w/src/gen/x", { exists: true }))], [{ op: "exec", res: { kind: "heap", of: "owned" } }]]) {
        for (const runner of [false, true]) {
            const env = envelopeFor(envFacts(effects, runner));
            if (env !== undefined) assert.equal(env.exec, "program-only", `exec: "any" is unreachable (${JSON.stringify(effects)}, runner ${runner})`);
        }
    }
});

test("K3: effects unknown means no envelope at all, even for a call the person approved", () => {
    assert.equal(envelopeFor(envFacts("unknown")), undefined);
    assert.equal(envelopeFor(envFacts("unknown", true)), undefined);
});

test("K3: a network write has no path to vouch for, so it withholds the envelope; a network read does not", () => {
    const nested = fsRes("/w/src/gen/out.txt", { exists: true });
    assert.equal(envelopeFor(envFacts([W(nested), { op: "write", res: { kind: "net", host: "example.com" } }])), undefined, "write to the network");
    assert.deepEqual(envelopeFor(envFacts([W(nested), { op: "read", res: { kind: "net", host: "example.com" } }])), { write: "roots", exec: "program-only" }, "read from the network");
    assert.equal(envelopeFor(envFacts([{ op: "write", res: { kind: "net", host: "*" } }])), undefined, "write to any host");
});

test("K3: the script cannot set or widen the envelope — there is no option for it", () => {
    refused([["ls"], { envelope: { write: "roots", exec: "any" } }], "BadRequest", /no option "envelope"/);
    refused([["ls"], { sandbox: "none" }], "BadRequest", /no option "sandbox"/);
    assert.deepEqual(parseShRun([["ls"]]), { argv: ["ls"], env: {} }, "positive control: the ordinary options still parse");
});

test("K3: the same facts derive the same envelope whoever approved them", () => {
    const f = shFacts(facts({ argv: ["cat", "a.txt"] }));
    const a = envelopeFor(f);
    const b = envelopeFor({ ...f, why: [...f.why] });
    assert.deepEqual(a, b);
    assert.deepEqual(a, { write: "none", exec: "program-only" });
});

test("K3: every shipped manifest vector gets an envelope only when it claims no top-level name", async () => {
    const { free, boundFor } = await import("../src/effects.ts");
    const B = boundFor("host-sandbox");
    const { readdirSync, readFileSync } = await import("node:fs");
    const dir = new URL("./fixtures/program-calls/", import.meta.url);
    const place = { roots: ["/w"] };
    for (const file of readdirSync(dir).filter((f) => f.endsWith(".json"))) {
        const fx = JSON.parse(readFileSync(new URL(file, dir), "utf8"));
        for (const c of fx.calls) {
            const paths = (c.pathArgs ?? []).map((arg, i) => {
                const given = c.argv[arg.arg] ?? ".";
                // A nested target: the envelope's job is the top level of the ROOTS, and these are below them.
                const path = given.startsWith("/") ? given : `/w/src/${given.replace(/^\.\//, "")}`;
                return { arg: arg.arg, given, path, inRoot: true, secret: false, exists: true };
            });
            const f = shFacts(facts({ argv: c.argv, paths, cwd: { path: "/w", inRoot: true }, repo: { root: "/w", reasons: [] }, repoConfigRunsCode: false }), null, place);
            const env = envelopeFor(f);
            const claimsTop = f.effects !== "unknown" && f.effects.some((e) => e.op === "write" && e.res.kind === "fs" && (e.res.topLevel === true && e.res.exists !== true || (e.res.names && (e.res.topLevel !== false || e.res.isRoot !== false))));
            if (claimsTop) assert.notEqual(env?.write, "roots", `${c.argv.join(" ")} claims a top-level name and must not get write: "roots"`);
            if (env?.write === "roots") {
                assert.equal(f.effects !== "unknown" && f.effects.some((e) => e.op === "write" || e.op === "alloc"), true, `${c.argv.join(" ")} has a write`);
                assert.equal(f.effects !== "unknown" && f.effects.every((e) => e.op !== "write" && e.op !== "alloc" || (e.res.kind === "fs" && e.res.inRoot === true && e.res.secret !== true && e.res.isRoot !== true && !(e.res.topLevel === true && e.res.exists !== true))), true,
                    `${c.argv.join(" ")} → roots only when every write is resolved and claims no top-level name`);
            }
        }
    }
});

test("K3: an older host is not sent an envelope; a K3 host is, only when it can hold one", () => {
    assert.equal(hostTakesEnvelope({ sandbox: { kind: "bwrap", available: true } }), false, "pre-K3: the key is absent");
    assert.equal(hostTakesEnvelope({ sandbox: { kind: "seatbelt", available: true } }), false, "pre-K3 on macOS too");
    assert.equal(hostTakesEnvelope({ sandbox: { kind: "seatbelt", available: true, landlockAbi: null } }), true, "K3 on macOS: seatbelt can hold any bound");
    assert.equal(hostTakesEnvelope({ sandbox: { kind: "bwrap", available: true, landlockAbi: 4 } }), true, "K3 on Linux with Landlock: a number");
    assert.equal(hostTakesEnvelope({ sandbox: { kind: "bwrap", available: true, landlockAbi: null } }), false, "Linux without Landlock reports the same null as macOS, and cannot hold program-only");
    assert.equal(hostTakesEnvelope({ sandbox: { kind: null, available: false, reason: "no", landlockAbi: null } }), false, "no sandbox kind: nothing to hold a bound");
});

test("K3: done.envelope is the only truth; an absent one is unknown, never narrow", () => {
    const out = { stdout: shOut({ ptr: "o", size: 0, sha256: "", truncated: false }, null, new Uint8Array()), stderr: shOut({ ptr: "e", size: 0, sha256: "", truncated: false }, null, new Uint8Array()) };
    const done = (over) => ({ event: "done", id: "c1", code: 0, signal: null, ok: true, timedOut: false, cancelled: false, durationMs: 3, stdout: {}, stderr: {}, ...over });
    const r = shResult(done({}), { placement: "host-sandbox" }, null, out);
    assert.equal(r.envelope, null, "an older host reported nothing: null, not a narrow claim");
    assert.equal(r.asked, undefined, "and nothing was asked");
    const applied = { write: "roots", exec: "program-only" };
    const asked = { write: "roots", exec: "program-only" };
    const r2 = shResult(done({ envelope: applied }), { placement: "host-sandbox" }, null, out, asked);
    assert.deepEqual(r2.envelope, applied);
    assert.deepEqual(r2.asked, asked);
    const r3 = shResult(done({ envelope: { write: "today", exec: "any" } }), { placement: "host-sandbox" }, null, out);
    assert.deepEqual(r3.envelope, { write: "today", exec: "any" }, "the floor has its own report name");
    assert.equal(r3.asked, undefined);
});

test("K3: the card's Sandbox applied line is the host's report, and a mismatch with what was asked for says so", () => {
    const f = shFacts(facts({ argv: ["cat", "a.txt"] }));
    const lines = shCardLines(f);
    assert.equal(lines.find((l) => l.label === "Sandbox applied"), undefined, "the approval card is shown before anything is applied");
    const unknown = shCardLines(f, null);
    const u = unknown.find((l) => l.label === "Sandbox applied");
    assert.deepEqual(u, { label: "Sandbox applied", value: "unknown (the host did not report it)" }, "an older host: unknown, without warn");
    const match = shCardLines(f, { write: "none", exec: "program-only" }, { write: "none", exec: "program-only" });
    assert.deepEqual(match.find((l) => l.label === "Sandbox applied"), { label: "Sandbox applied", value: "write none, exec program-only" });
    const floor = shCardLines(f, { write: "today", exec: "any" });
    assert.deepEqual(floor.find((l) => l.label === "Sandbox applied"), { label: "Sandbox applied", value: "write today, exec any" }, "nothing asked, floor applied: not a mismatch");
    const mismatch = shCardLines(f, { write: "today", exec: "any" }, { write: "roots", exec: "program-only" });
    const m = mismatch.find((l) => l.label === "Sandbox applied");
    assert.equal(m.warn, true, "asked for roots, got the floor: look twice");
    assert.match(m.value, /not the write roots, exec program-only that was asked for/);
});

test("ok is the manifest's answer codes, and a kill, a timeout, a cancel or a sandbox failure is never ok", () => {
    const out = { stdout: shOut({ ptr: "o", size: 0, sha256: "", truncated: false }, null, new Uint8Array()), stderr: shOut({ ptr: "e", size: 0, sha256: "", truncated: false }, null, new Uint8Array()) };
    const done = (over) => ({ event: "done", id: "c1", code: 0, signal: null, ok: true, timedOut: false, cancelled: false, durationMs: 3, stdout: {}, stderr: {}, ...over });
    const rg = planSpawn(parseShRun([["rg", "x"]]), S).description;
    assert.equal(shResult(done({ code: 1, ok: false }), { placement: "host-sandbox" }, rg, out).ok, true, "rg's 1 is an answer (no match)");
    assert.equal(shResult(done({ code: 1, ok: false }), { placement: "host-sandbox" }, null, out).ok, false, "unannotated: only 0");
    assert.equal(shResult(done({ code: 2 }), { placement: "host-sandbox" }, rg, out).ok, false);
    assert.equal(shResult(done({ code: null, signal: "SIGKILL" }), { placement: "host-sandbox" }, rg, out).ok, false);
    assert.equal(shResult(done({ timedOut: true }), { placement: "host-sandbox" }, rg, out).ok, false);
    assert.equal(shResult(done({ cancelled: true }), { placement: "host-sandbox" }, rg, out).ok, false);
    const sf = shResult(done({ code: null, error: { code: "SandboxFailed", message: "denied" } }), { placement: "host-sandbox" }, rg, out);
    assert.equal(sf.ok, false);
    assert.equal(sf.error, "SandboxFailed: denied");
    assert.equal(shResult(done({}), { placement: "host-plain" }, null, out).ran, "host-plain", "the result says where it ran");
});

test("every host error code maps to a wire code: enforcement is Refused, the caller's mistake is BadRequest, the rest Failed", () => {
    const want = {
        BadRequest: "BadRequest", NotConfigured: "Refused", BadRoot: "Refused", ProgramNotFound: "Refused", CwdOutsideRoots: "Refused",
        EnvRefused: "Refused", SecretUnavailable: "SecretHandle", Unsupported: "Refused", UnknownId: "Failed", UnknownPtr: "Failed",
        SandboxFailed: "Failed", SpawnFailed: "Failed", Busy: "Failed", Failed: "Failed", TooLarge: "TooLarge", Disconnected: "Failed",
    };
    for (const [h, w] of Object.entries(want)) assert.equal(wireCodeOf(h), w, h);
    assert.equal(wireCodeOf("SomethingNew"), "Failed", "a code from a newer host fails, never passes");
});

// --- the host client: seq, done, close ---

/** A port whose other end the test plays. */
function fakePort() {
    const sent = [];
    let onMsg, onClose;
    return {
        sent, port: { send: (m) => sent.push(m), onMessage: (cb) => { onMsg = cb; }, onClose: (cb) => { onClose = cb; } },
        reply: (m) => onMsg(m), close: (why) => onClose(why),
    };
}

test("answers are matched by seq in any order, and an error answer is a HostError with the host's code", async () => {
    const f = fakePort();
    const c = new HostClient(f.port);
    const a = c.hello(), b = c.spawn({ argv: ["ls"], cwd: "/w" });
    assert.deepEqual(f.sent.map((m) => m.call), ["hello", "spawn"]);
    f.reply({ seq: f.sent[1].seq, error: { code: "CwdOutsideRoots", message: "no" } });
    f.reply({ seq: f.sent[0].seq, value: { protocol: 1 } });
    f.reply({ seq: 999, value: "stray" });
    assert.deepEqual(await a, { protocol: 1 });
    await assert.rejects(b, (e) => e instanceof HostError && e.code === "CwdOutsideRoots");
});

test("start sends the envelope as `envelope`, and omits the key entirely when there is none", async () => {
    const f = fakePort();
    const c = new HostClient(f.port);
    void c.start("c1");
    void c.start("c2", { write: "roots", exec: "program-only" });
    void c.start("c3", { write: "none", exec: "any" });
    assert.deepEqual(f.sent.map((m) => m.args), [
        { id: "c1" },
        { id: "c2", envelope: { write: "roots", exec: "program-only" } },
        { id: "c3", envelope: { write: "none", exec: "any" } },
    ], "absent is the floor: no envelope key at all, never `envelope: null` (the host refuses null as malformed)");
});

test("a done event that arrives before anyone waits is kept and claimed once", async () => {
    const f = fakePort();
    const c = new HostClient(f.port);
    f.reply({ event: "done", id: "c1", code: 0 });
    assert.equal((await c.waitDone("c1")).code, 0);
    const again = c.waitDone("c1");
    f.reply({ event: "done", id: "c1", code: 7 });
    assert.equal((await again).code, 7, "the second wait gets the next event, not the stale one");
});

test("when the port closes every pending call and waiter fails Disconnected, and so does every later call", async () => {
    const f = fakePort();
    const c = new HostClient(f.port);
    const pending = c.start("c1"), waiting = c.waitDone("c1");
    f.close("host exited");
    for (const p of [pending, waiting, c.hello(), c.waitDone("c2")]) await assert.rejects(p, (e) => e.code === "Disconnected" && /host exited/.test(e.message));
    assert.equal(c.isClosed, true);
    const g = fakePort();
    g.port.send = () => { throw new Error("Attempting to use a disconnected port object"); };
    await assert.rejects(new HostClient(g.port).hello(), (e) => e.code === "Disconnected");
});

test("a read asks for at most one chunk, from a non-negative whole offset; bytes come back from base64", () => {
    const f = fakePort();
    const c = new HostClient(f.port);
    void c.read("out:1", -5.5, 10 * READ_CHUNK);
    assert.deepEqual(f.sent[0].args, { ptr: "out:1", offset: 0, length: READ_CHUNK });
    assert.deepEqual([...bytesOf({ $bytes: "aGk=" })], [104, 105]);
});
