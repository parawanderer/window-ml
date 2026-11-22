// redteam-ml-fs.test.mjs — what a hostile script or a hostile page must NOT get from `ml.fs`
// (docs/spec/FILE_ATTACHMENTS.md, "`ml.fs`"): another session's files, a path outside the run's own `/files` root, the
// bytes of a hidden file, a secret split across two reads, the offscreen document's own text, or a channel whose
// session it chose. The script is the model's, and the page steers the model, so every shape below is one an approved
// script can write; the positive control in each row shows the same shape working where it should.
//
// What the builder's own ml-fs.test.mjs pins and this file does not repeat: the enumerated argument shapes
// (`fsArgsOk`), the fs request count against the pointer reads' count, a key's session at `fsServer`, the relay's
// FS_CALL_FAILED, the channel's idle/LRU sweep, and the literal `ml.fs` route.
import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { fsOver } from "./ml-fs-harness.mjs";
import { isoServer, ISO_FS_ASK_MAX, ISO_REFUSED } from "../src/sw/iso-channel.ts";
import { fsCallFor, FS_CALL_FAILED } from "../src/sw/sw-fs-call.ts";
import { mlFs, ML_FS_READFILE_MAX } from "../src/ml/ml-fs.ts";
import { isolatedWrapper, isolatedMembers } from "../src/sw/sw-isolated-exec.ts";
import { execNames, routeExec } from "../src/sw/exec-routing.ts";
import { RangedReader } from "../src/session/ranged-reader.ts";
import { fsServer } from "../src/session/fs-serve.ts";
import { runOn } from "./isolated-harness.mjs";

const T = { timeout: 60000 };
const enc = new TextEncoder();

/** Why a call failed: its Node code, or an ISO refusal's whole message (which carries no code). */
async function failed(p) {
    try { await p; } catch (e) { return e; }
    assert.fail("the call resolved; the shape this row is about was allowed");
}

/** Run one script in the wrapper, in a fresh context, against `ask`. */
function inWorld(js, b, ask) {
    const ctx = vm.createContext({ __ask: ask, console, TextDecoder, TextEncoder, atob, btoa, Uint8Array, Promise, Error, Date, Symbol, Object, JSON });
    return vm.runInContext(isolatedWrapper(js, b, "N1", "", ask ? "__ask" : ""), ctx);
}

/**
 * A reader over one session's file, with the two knobs `fsOver` does not expose: a stat size that lies, and a hide
 * rule. Everything else is `fsOver`'s own stack, so a row here crosses the same layers an exec does.
 */
function readerOver({ name = "one.txt", bytes, size, hidden = () => false, forms = [] }) {
    const data = typeof bytes === "string" ? enc.encode(bytes) : bytes;
    const row = { handle: "h1", name, key: "s1:h1", bytes: size ?? data.length, sha256: "sha-1", attachedMs: 5000 };
    const source = { attached: async () => [row], blob: async () => new Blob([data]), secretForms: async () => forms };
    const reader = new RangedReader({ source, hidden, now: () => 1000 });
    const server = fsServer(() => reader.openChannel("files"));
    const relay = fsCallFor("s1", { send: async (m) => m.type === "FS_CALL" ? server.call(m.key, m.session, m.op, m.args) : (server.end(m.key), undefined) });
    const serve = isoServer("s1", [], { deref: () => undefined, holders: async () => null, columns: async () => ({ rowCount: 0, columns: {} }), fs: relay.fs });
    const fs = mlFs(async (op, args) => {
        const r = await serve({ op: "fs", call: op, args });
        if (typeof r.error === "string") { const e = new Error(r.error); if (typeof r.code === "string") e.code = r.code; throw e; }
        return r.ok;
    });
    return { fs, server };
}

// --- the member is bound by the literal name, and reaching for it any other way gains nothing ---

test("RED TEAM: `ml.fs` is bound by the literal name alone; a computed spelling is routed to the page's world, which has no fs", T, async () => {
    const SPELLING = {
        computed: 'return (await ml["fs"].readFile("/files/x")).length',
        concatenated: "return ml['f' + 's'] ? 1 : 0",
        destructured: "const { fs } = ml; return fs ? 1 : 0",
        optional: "return ml?.fs ? 1 : 0",
    };
    for (const [k, js] of Object.entries(SPELLING)) {
        assert.equal(execNames(js).fs, false, `${k}: the lexical reader saw a name it does not name`);
        assert.equal(routeExec(js, true, { userScripts: true, cdp: true }).reason, "plain", `${k}: a spelling the script does not name is routed as naming it`);
    }
    // The control both ways: the literal name is read, on one line or split across lines.
    assert.equal(execNames("return (await ml.fs.readFile('/files/x')).length").fs, true);
    assert.equal(execNames("return ml\n . fs ? 1 : 0").fs, true);

    // In the world the computed spelling is sent to (the page's main world), ml has no fs at all.
    const r = await runOn("readonly", [() => SPELLING.computed], {});
    assert.match(r.results[0] ?? "", /Cannot read properties of undefined \(reading 'readFile'\)/, `the page's world grew an ml.fs: ${JSON.stringify(r.results)}`);
    assert.deepEqual(r.log.filter((e) => e.kind.startsWith("exec-")).map((e) => e.kind), ["exec-main"], `the computed spelling was not routed as plain: ${JSON.stringify(r.log)}`);
    assert.deepEqual(r.bg.runtimeSent.filter((m) => m.type === "FS_CALL"), [], "a channel was opened for a script that never named ml.fs");
});

test("RED TEAM: the wrapper's member is the literal name's too, and the raw channel answers read ops only when the run named ml.fs", T, async () => {
    // A script that names none of it, against the channel the worker builds for a run that named none: no fs.
    const bare = isoServer("s1", [], { deref: () => undefined, holders: async () => null, columns: async () => ({ rowCount: 0, columns: {} }) });
    const raw = await inWorld("(async () => { try { return 'ANSWERED:' + JSON.stringify(await __chanAsk({ op: 'fs', call: 'stat', args: ['attached'] })); } catch (e) { return 'threw:' + e.message; } })()", { reads: [] }, bare);
    assert.equal(raw.v, "threw:" + ISO_REFUSED.noFs);
    const member = await inWorld("(async () => { try { ml['fs'].readFile('/files/x'); return 'GOT'; } catch (e) { return e.message; } })()", { reads: [] }, bare);
    assert.match(member.v, /ml\.fs is not available in this exec/, "the wrapper handed out ml.fs for a script that did not name it");
    assert.equal(isolatedMembers({ reads: [] }).includes("fs"), false);

    // The control: named, and the channel answers — through the member and, since the script named it, through the
    // channel directly too (the wrapper's identifiers are lexically reachable; the run's binding is the gate).
    const { serve } = fsOver({ sessions: { s1: [{ handle: "h1", name: "a.txt", bytes: "abc" }] } });
    const named = await inWorld("(async () => String((await ml['fs'].readFile('/files/attached/h1/a.txt', 'utf8')).length))()", { reads: [], fs: true }, serve);
    assert.equal(named.v, "3");
    const direct = await inWorld("(async () => String((await __chanAsk({ op: 'fs', call: 'stat', args: ['attached/h1/a.txt'] })).size))()", { reads: [], fs: true }, serve);
    assert.equal(direct.v, "3");
});

// --- the session is the worker's word, never the script's ---

test("RED TEAM: every FS_CALL an isolated exec makes names the run's own session, and the model reads a failure, not the offscreen document", T, async () => {
    const js = "return (await ml.fs.readFile('/files/attached/h1/env.txt','utf8')).length";
    const r = await runOn("userScripts", [() => js], {});
    const calls = r.bg.runtimeSent.filter((m) => m.type === "FS_CALL");
    assert.ok(calls.length > 0, "the named read opened no channel at all: the instrument cannot see the session it names");
    for (const m of calls) {
        assert.equal(m.session, r.hash, "an FS_CALL named a session other than the run's");
        assert.match(m.key, /^[0-9a-f-]{36}$/, `the channel's key is not the worker's own minted id: ${JSON.stringify(m.key)}`);
        assert.notEqual(m.key, r.hash, "the channel's key is the run id: a page that learned the run could name its channel");
        assert.deepEqual(Object.keys(m).sort(), ["args", "key", "op", "session", "type"], `an FS_CALL carries a field of the script's: ${JSON.stringify(m)}`);
    }
    // A session-looking name in the script's path changes nothing: there is no session field in an fs request.
    assert.deepEqual([...new Set(calls.map((m) => m.session))], [r.hash]);
    // What the model reads is Node's own error for the path its script wrote: the offscreen document's text is replaced
    // by the relay's constant, and the facade replaces that with the Node error.
    assert.match(r.results[0] ?? "", /EIO: i\/o error, open '\/files\/attached\/h1\/env\.txt'/, `the model read something other than a Node error for its own path: ${JSON.stringify(r.results[0])}`);
    // The replacement holds even when the offscreen document's answer carries a secret of its own.
    const leak = "sk-live-0123456789abcdef at /Users/sb/shelf";
    const relay = fsCallFor("s1", { send: async () => ({ error: leak, code: "ENOENT" }) });
    const leaking = mlFs(async (op, args) => {
        const r = await relay.fs(op, args);
        if (typeof r.error === "string") { const e = new Error(r.error); if (typeof r.code === "string") e.code = r.code; throw e; }
        return r.ok;
    });
    const e = await failed(leaking.readFile("/files/attached/h1/env.txt"));
    assert.equal(e.code, "ENOENT");
    assert.equal(String(e.message).includes("sk-live"), false, `the offscreen document's text reached the error: ${e.message}`);
    assert.match(e.message, /open '\/files\/attached\/h1\/env\.txt'/, "the error does not name the path the script wrote");
    const ends = r.bg.runtimeSent.filter((m) => m.type === "FS_END");
    assert.deepEqual(ends.map((m) => m.key), [...new Set(calls.map((m) => m.key))], "the exec's channel was not closed at its end");
});

// --- one root, and no traversal out of it ---

test("RED TEAM: no path spelling reaches another session's file or leaves `/files`: traversal, encoding and URI forms all fail closed", T, async () => {
    const { fs, ask } = fsOver({
        sessions: {
            s1: [{ handle: "h1", name: "env.txt", bytes: "KEY=mine\n" }],
            s2: [{ handle: "h9", name: "theirs.txt", bytes: "another session" }],
        },
    });
    // Every spelling that names something else: the facade's code, as Node would give it.
    const REFUSED = {
        "../s2/h9/theirs.txt": "ENOENT",
        "attached/../attached/h1/../../s2/env.txt": "ENOENT",
        "/files/attached/h1/../../../s2/h9/theirs.txt": "ENOENT",
        "attached%2F..%2F..%2Fs2%2Fh9%2Ftheirs.txt": "ENOENT",
        "attached\\h1\\..\\..\\s2\\h9\\theirs.txt": "ENOENT",
        "file:///files/attached/h1/env.txt": "ENOENT",
        "FILE:///etc/passwd": "ENOENT",
        "/etc/passwd": "ENOENT",
        "․․/s2/h9/theirs.txt": "ENOENT",
        "agent/../../s2/h9/theirs.txt": "ENOENT",
        "attached/h9/theirs.txt": "ENOENT",
        "attached/h1/env.txt/": "ENOTDIR",
        "attached/h1/env.txt\u0000": "ERR_INVALID_ARG_VALUE",
    };
    for (const [p, code] of Object.entries(REFUSED)) {
        const e = await failed(fs.stat(p));
        assert.equal(e.code, code, `${JSON.stringify(p)} answered with ${e.code}: ${e.message}`);
        assert.equal(/mine|another session/.test(e.message), false, `${JSON.stringify(p)} put file content in the error`);
        // The raw channel resolves nothing on the script's behalf: it takes the canonical relative path and no other.
        const raw = await failed(ask({ op: "fs", call: "stat", args: [p] }));
        assert.equal(raw.code, "ENOENT", `the raw channel answered ${JSON.stringify(p)} with ${raw.code}`);
        assert.equal(raw.message, FS_CALL_FAILED, "the raw channel carried the reader's text");
    }
    // Spellings the facade normalises: each lands on the same file, so none of them escapes either.
    const SAME = ["/files/attached/h1/env.txt", "/attached/h1/env.txt", "attached/h1/env.txt", "./attached/h1/env.txt", "//files/attached/h1/env.txt", "/files//attached/h1/env.txt", "attached/./h1/./env.txt", "/files/attached/h1/./env.txt"];
    for (const p of SAME) assert.equal(await fs.readFile(p, "utf8"), "KEY=mine\n", `${JSON.stringify(p)} is a spelling of the same file and it did not read`);
    // A path this run holds nothing under is indistinguishable from one whose handle exists in another session.
    const missing = await failed(fs.readFile("/files/attached/h9/theirs.txt"));
    const absent = await failed(fs.readFile("/files/attached/hq/nothing.txt"));
    const neutral = (e, p) => e.message.split(p).join("<path>");
    assert.equal(neutral(missing, "attached/h9/theirs.txt"), neutral(absent, "attached/hq/nothing.txt"), "another session's handle answered with a different message than a missing one");
});

// --- a hidden file is listed, and its bytes are never read ---

test("RED TEAM: a hidden file's bytes are refused at every read front end, not only at readFile", T, async () => {
    // The hide rule is the reader's dependency (ranged-reader.ts `HideRule`); offscreen.ts passes none yet
    // (docs/spec/POLICIES.md, ruling 34), so this row pins the layer a future wiring must not bypass.
    const { fs } = readerOver({ name: "hidden.txt", bytes: "KEY=secret\n", hidden: (_s, p) => p.endsWith("hidden.txt") });
    assert.deepEqual((await fs.readdir("/files/attached/h1")).map(String), ["hidden.txt"], "the hidden file is not listed (it is listed: only its bytes are hidden)");
    for (const [what, call] of [
        ["readFile", () => fs.readFile("/files/attached/h1/hidden.txt")],
        ["readFile via promises", () => fs.promises.readFile("/files/attached/h1/hidden.txt", "utf8")],
        ["open", () => fs.open("/files/attached/h1/hidden.txt")],
        ["createReadStream", async () => { for await (const c of fs.createReadStream("/files/attached/h1/hidden.txt")) return c; }],
    ]) {
        const e = await failed(call());
        assert.equal(e.code, "EACCES", `${what} answered a hidden file with ${e.code}: ${e.message}`);
    }
    // The control: the same file with no hide rule reads.
    const open = readerOver({ name: "hidden.txt", bytes: "KEY=secret\n" });
    assert.equal(await open.fs.readFile("/files/attached/h1/hidden.txt", "utf8"), "KEY=secret\n");
});

// --- a secret is masked as one, across the chunk boundary ---

test("RED TEAM: a secret is never returned split across two reads, at any offset or in a stream", T, async () => {
    const SECRET = "sk-live-0123456789abcdef";
    const body = "A".repeat(512 * 1024 - 5) + SECRET + "B".repeat(4096);
    const { fs, ask } = fsOver({ forms: [{ find: SECRET }], sessions: { s1: [{ handle: "h1", name: "big.txt", bytes: body }] } });
    const masked = "*".repeat(SECRET.length);

    const whole = await fs.readFile("/files/attached/h1/big.txt", "utf8");
    assert.equal(whole.includes(SECRET), false, "readFile returned the secret");
    assert.equal(whole.length, body.length, "masking changed the length: a read's size must still be the file's");
    assert.ok(whole.includes(masked), "the secret was not masked where it starts");

    const h = await fs.open("/files/attached/h1/big.txt");
    const buf = new Uint8Array(24);
    const r = await h.read(buf, 0, 24, 512 * 1024 - 5);
    const got = Buffer.from(buf.subarray(0, r.bytesRead)).toString();
    assert.equal(got.includes(SECRET), false, `an explicit-position read returned the secret: ${JSON.stringify(got)}`);
    assert.ok(got.startsWith(masked), "the read starting at the secret's first byte did not mask it");

    const chunks = [];
    for await (const c of fs.createReadStream("/files/attached/h1/big.txt", { highWaterMark: 64 * 1024 })) chunks.push(Buffer.from(c).toString());
    assert.equal(chunks.some((c) => c.includes(SECRET)), false, "a stream chunk returned the secret");
    assert.equal(chunks.join("").length, body.length, "the stream's chunks do not add up to the file");

    const bytes = await fs.readFile("/files/attached/h1/big.txt");
    assert.equal(Buffer.from(bytes).toString().includes(SECRET), false, "a byte read returned the secret");
    // The raw channel answers through the same masking: there is no unmasksed read op.
    const raw = await ask({ op: "fs", call: "read", args: [(await fs.open("/files/attached/h1/big.txt")).fd, 512 * 1024 - 5, 4096] });
    assert.equal(Buffer.from(raw.b64, "base64").toString().includes(SECRET), false, "the channel returned the secret unmasked");
});

// --- bounds: a lying size, an endless listing, an endless walk ---

test("RED TEAM: readFile stops at its cap even when the stat lied, and an endless listing stops at the entry cap", T, async () => {
    const { fs } = readerOver({ bytes: "A".repeat(ML_FS_READFILE_MAX + 4096), size: 10 });
    const e = await failed(fs.readFile("/files/attached/h1/one.txt"));
    assert.equal(e.code, "ERR_FS_FILE_TOO_LARGE", `a stat that lied about the size let the whole file through: ${e.message}`);

    // A listing that never ends: `readdir` pages it until its own cap and refuses, rather than growing without bound.
    let pages = 0;
    const endless = mlFs(async (op) => {
        if (op === "stat") return { kind: "dir", size: 0, mtimeMs: 1, birthtimeMs: 1 };
        if (op !== "opendir") throw Object.assign(new Error("EINVAL"), { code: "EINVAL" });
        pages++;
        return { entries: Array.from({ length: 500 }, (_, i) => ({ name: `f${i}`, kind: "file", size: 0, mtimeMs: 1, birthtimeMs: 1 })), next: `c${pages}` };
    });
    const tooMany = await failed(endless.readdir("/files/attached"));
    assert.equal(tooMany.code, "ERR_ML_FS_TOO_MANY", `an endless listing ended with ${tooMany.code}`);
    assert.ok(pages < 210, `the listing ran to ${pages} pages: more than the cap needs`);
});

test("RED TEAM: a recursive readdir into an endless tree halts at the exec's own fs budget", T, async () => {
    const serve = isoServer("r1", [], {
        deref: () => undefined, holders: async () => null, columns: async () => ({ rowCount: 0, columns: {} }),
        fs: async (op) => ({ ok: op === "stat"
            ? { kind: "dir", size: 0, mtimeMs: 1, birthtimeMs: 1 }
            : { entries: [{ name: "d", kind: "dir", size: 0, mtimeMs: 1, birthtimeMs: 1 }] } }),
    });
    let asks = 0;
    const fs = mlFs(async (op, args) => {
        asks++;
        const r = await serve({ op: "fs", call: op, args });
        if (typeof r.error === "string") { const e = new Error(r.error); if (typeof r.code === "string") e.code = r.code; throw e; }
        return r.ok;
    });
    const e = await failed(fs.readdir("/", { recursive: true }));
    assert.equal(e.message, ISO_REFUSED.fsBudget, `an endless walk ended with ${JSON.stringify(e.message)}`);
    assert.equal(asks, ISO_FS_ASK_MAX + 1, "the walk did not end at the budget: something else stopped it");
    // A second exec's channel starts its own count.
    const next = mlFs(async (op, args) => {
        const r = await isoServer("r2", [], { deref: () => undefined, holders: async () => null, columns: async () => ({ rowCount: 0, columns: {} }), fs: async () => ({ ok: { kind: "dir", size: 0, mtimeMs: 1, birthtimeMs: 1 } }) })({ op: "fs", call: op, args });
        if (typeof r.error === "string") throw new Error(r.error);
        return r.ok;
    });
    assert.equal((await next.stat("/files")).isDirectory(), true);
});

// --- the offscreen document answers the worker's word only ---

test("RED TEAM: a tab's FS_CALL is not answered and opens no channel, so it cannot bind a session of its choosing", T, async () => {
    // src/offscreen.ts imported for real under a mocked `chrome` and a fake `Worker` (the scaffolding of
    // pkg-install-offscreen.test.mjs).
    const listeners = [];
    class FakeWorker { constructor() { this.posts = []; } postMessage(m) { this.posts.push(m); } terminate() {} }
    globalThis.Worker = FakeWorker;
    const realSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = (fn, ms, ...rest) => { const t = realSetTimeout(fn, ms, ...rest); if (ms >= 60_000) t.unref(); return t; };
    const sessionStore = {};
    globalThis.chrome = {
        runtime: {
            id: "test",
            getURL: (p) => `chrome-extension://test/${p}`,
            onMessage: { addListener: (fn) => listeners.push(fn) },
            sendMessage: () => Promise.resolve(undefined),
        },
        storage: {
            session: { get: async (k) => (k in sessionStore ? { [k]: sessionStore[k] } : {}) },
            onChanged: { addListener: () => {} },
        },
    };
    await import("../src/offscreen.ts");
    const send = (msg, sender) => new Promise((resolve) => {
        let handled = false;
        for (const fn of listeners) { if (fn(msg, sender, resolve) === true) { handled = true; break; } }
        if (!handled) resolve(undefined);
    });
    const sendOrHang = (msg, sender) => Promise.race([send(msg, sender), new Promise((r) => realSetTimeout(() => r("hung"), 300))]);
    const TAB = { id: "test", tab: { id: 4 }, url: "https://evil.example/" };
    const OTHER = { id: "other-extension" };
    const attempt = { type: "FS_CALL", key: "k-fs", session: "another-run", op: "stat", args: ["attached"] };
    assert.equal(await sendOrHang(attempt, TAB), undefined, "the offscreen document answered a tab");
    assert.equal(await sendOrHang(attempt, OTHER), undefined, "the offscreen document answered another extension");
    const answered = await sendOrHang({ ...attempt, session: "run-1" }, { id: "test" });
    assert.ok(answered && typeof answered === "object", `the worker's own FS_CALL was not answered: ${JSON.stringify(answered)}`);
    assert.notEqual(answered.code, "EBADF", "a tab's attempt opened the channel under a session of its own");
});
