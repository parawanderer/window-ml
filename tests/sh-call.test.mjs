// sh-call.test.mjs — one `ml.sh.run` call before and after the process host (src/shell/sh-call.ts) and the host
// protocol's call layer (src/shell/host-protocol.ts), with no host and no worker: the argument checks, the spawn the
// manifest shapes, the facts a policy and the card are given, the result, and the client's seq/done/close rules.

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseShRun, planSpawn, shFacts, shCardLines, headText, shOut, shResult, wireCodeOf, manifestFor, SHIPPED_MANIFESTS, ShRefused, SH_LIMITS } from "../src/shell/sh-call.ts";
import { HostClient, HostError, READ_CHUNK, bytesOf } from "../src/shell/host-protocol.ts";

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
    assert.equal(manifestFor("/usr/bin/git")?.program, "git");
    assert.equal(manifestFor("python3"), undefined);
    assert.equal(manifestFor("constructor"), undefined, "a prototype name is not a manifest");
    assert.equal(manifestFor("__proto__"), undefined);
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
    assert.deepEqual(f.effects, [{ op: "read", res: { kind: "fs", path: "/w/a.txt", inRoot: true, secret: false } }]);
    const out = shFacts(facts({ paths: [{ arg: 1, given: "../x/.env", path: "/x/.env", inRoot: false, secret: true, exists: true }], argv: ["cat", "../x/.env"] }));
    assert.deepEqual(out.effects, [{ op: "read", res: { kind: "fs", path: "/x/.env", inRoot: false, secret: true } }]);
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
