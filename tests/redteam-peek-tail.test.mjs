// redteam-peek-tail.test.mjs — the red team's pass on a detached `ml.sh` call's live tail (window-ml#1586, mode 1 of
// docs/spec/ASYNC_CALLS.md): the host's `peek` answer turned into what the model reads (src/shell/sh-tail.ts), through
// the `task` tool and `ml.current.tasks` (src/sw/sw-tasks.ts, src/sw/sw-shell-call.ts).
//
// The lane's own rows already pin the shape of that answer — the scrubbed `task tail` and tasks row, the host without
// `hello.peek`, the two bounds, the error sentence, the value a cut tail points at. What they leave open, and what
// these three rows pin, is where the stored whole and the host's ask reach past the run that made the call:
//
//   1. the whole a cut tail stores for a pointer is SCRUBBED before it is kept, and a session that never claimed it reads
//      none of it (the claim gate, with the holders check beneath it);
//   2. the `lines` a model sends are clamped at the ASK: no value reaches the host as a byte count past the protocol's
//      ceiling, and none shows more than the 200-line ceiling however small the number is;
//   3. another run's task id reads nothing of it on a host that really answers `peek`: the UnknownTask answer and no
//      `peek` sent (the faux-executor half is tests/redteam-task.test.mjs's).
//
// Each row has a control: the same instrument on the run's own task, so a fixture that cannot see a peek at all fails
// rather than passing by refusing nothing.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fakeNativeHost } from "./fake-native-host.mjs";

const require = createRequire(import.meta.url);
const T = { timeout: 20000 };

// The worker's chrome, as much of it as sw-shell.ts, sw-shell-call.ts, sw-tasks.ts, sw-scrub.ts and sw-values.ts use.
const KEY = "sk-peektail-0123456789";
const sync = { shellEnabled: true, shellRoots: ["/w/p0"], shellSandbox: true, shellPath: [], chatUrl: "http://host/api/chat/completions", apiKey: KEY };
let native = null;
const sessionStore = {};
globalThis.chrome = {
    runtime: {
        id: "ext-id", lastError: undefined, onMessage: { addListener() {} }, getURL: (p) => p,
        connectNative: (name) => {
            const onMsg = [], onDisc = [];
            let closed = false;
            const close = (why) => { if (closed) return; closed = true; setTimeout(() => { globalThis.chrome.runtime.lastError = { message: why }; for (const f of onDisc) f(); globalThis.chrome.runtime.lastError = undefined; }, 0); };
            const end = { send: (m) => { if (!closed) setTimeout(() => { for (const f of onMsg) f(JSON.parse(JSON.stringify(m))); }, 0); }, close };
            const receive = native ? native(name, end) : null;
            if (!receive) close("Specified native messaging host not found.");
            return { name, postMessage: (m) => { if (closed) throw new Error("disconnected"); receive?.(JSON.parse(JSON.stringify(m))); }, disconnect: () => { closed = true; },
                onMessage: { addListener: (f) => onMsg.push(f) }, onDisconnect: { addListener: (f) => onDisc.push(f) } };
        },
    },
    storage: {
        local: { get: async () => ({}), set: async () => {}, remove: async () => {} },
        sync: { get: async (d) => ({ ...(d ?? {}), ...sync }), set: async () => {} },
        session: {
            get: async (k) => { const keys = typeof k === "string" ? [k] : Array.isArray(k) ? k : Object.keys(k ?? sessionStore); return Object.fromEntries(keys.filter((x) => x in sessionStore).map((x) => [x, sessionStore[x]])); },
            set: async (o) => { Object.assign(sessionStore, JSON.parse(JSON.stringify(o))); }, remove: async (k) => { for (const x of [k].flat()) delete sessionStore[x]; },
        },
        onChanged: { addListener() {} },
    },
};
const { shRun } = await import("../src/sw/sw-shell-call.ts");
const { taskAction, withTasks, endTasks, openTasks, TASK_TAIL_MAX_LINES } = await import("../src/sw/sw-tasks.ts");
const { runInboxes } = await import("../src/sw/sw-runs.ts");
const { TokenStore } = await import("../src/pointers/token-pipe.ts");
const { PEEK_MAX_BYTES, PEEK_DEFAULT_BYTES } = await import("../src/shell/sh-tail.ts");

let rootN = 0;
/** A host whose `done` is held until the test releases it, as a running call's is. */
function slowHost(opts = {}) {
    const host = fakeNativeHost(opts);
    const held = [];
    let end;
    host.onNative = ((inner) => (name, e) => {
        end = e;
        const recv = inner(name, { send: (m) => { if (m?.event === "done") { held.push(m); return; } e.send(m); }, close: e.close });
        return recv && ((m) => recv(m));
    })(host.onNative);
    host.finish = () => { for (const m of held.splice(0)) end.send(m); };
    native = host.onNative;
    sync.shellRoots = [`/w/p${++rootN}`];
    return host;
}
const ctxFor = (runId) => ({ runId, seq: 3, local: { step: 1, seq: 3 }, signal: new AbortController().signal, tokens: new TokenStore() });
/** A run whose turn is live: an inbox it drains at the step boundary and a fan for its surfaces. */
function liveRun(runId) {
    runInboxes.set(runId, { tabId: 7, queue: [] });
    openTasks(runId, () => {});
    return { inbox: () => runInboxes.get(runId)?.queue ?? [] };
}
const snap = () => ({ run: { id: "h", model: null, step: 1, maxSteps: 8, startedTs: 0 }, messages: [], meta: [], log: Object.assign([], { text: "" }) });

const b64 = (s) => ({ $bytes: Buffer.from(s).toString("base64") });
const peekOf = (out, err = "") => ({ stdout: { size: Buffer.byteLength(out), truncated: false, data: b64(out) }, stderr: { size: Buffer.byteLength(err), truncated: false, data: b64(err) } });
/** A detached call on a host that answers `peek` with `answer(args)`, and records what each ask said. */
async function detachedPeeking(runId, answer, opts = {}) {
    const seen = [];
    const host = slowHost({ peek: true, peekAnswer: (a) => { seen.push(a); return answer(a); }, ...opts });
    liveRun(runId);
    const r = await shRun(ctxFor(runId), [["ls"], { expectMs: 30 }]);
    assert.equal(r.code, "Detached", `control: the call detached: ${JSON.stringify(r)}`);
    return { host, task: r.task, seen };
}

// --- the stored whole is scrubbed, and only the run shown the cut can read it ---

test("RED TEAM: the whole a cut tail stores is scrubbed before it is kept, and another session that never saw it reads none of it", T, async () => {
    const { IDBFactory } = require("fake-indexeddb");
    globalThis.indexedDB = new IDBFactory();
    try {
        const { readStoredText, claimValue } = await import("../src/sw/sw-values.ts");
        const { ValueMissing } = await import("../src/pointers/value-store.ts");
        // 40 lines of 400 characters is 16 KB: the ceiling cuts it, so the answer is a value to point at.
        const lines = Array.from({ length: 40 }, (_, i) => `row${i}:${"q".repeat(392)}${i === 7 ? ` key=${KEY}` : ""}`);
        const { host, task } = await detachedPeeking("rt-peek-store", () => peekOf(lines.join("\n") + "\n"));
        const t = await taskAction("rt-peek-store", { op: "tail", id: task, lines: 40 });
        assert.equal(typeof t, "object", "control: 16 KB past the ceiling is cut, so a value is named");
        assert.ok(!t.content.includes(KEY), `the model's tail carried the key: ${t.content.slice(0, 200)}`);
        // The pointer the step mints is claimed for THIS run, then read back as the store keeps it.
        await claimValue(t.textValue, "rt-peek-store");
        const whole = await readStoredText(t.textValue, "rt-peek-store");
        assert.ok(whole.includes("row0:") && whole.includes("row39:"), "control: the stored whole holds the lines the cut hid");
        assert.ok(!whole.includes(KEY), `the stored whole carries the API key the cut removed: ${whole.slice(whole.indexOf("row7:"), whole.indexOf("row7:") + 480)}`);
        // Unclaimed for that session: the store and the holders check both say so, and neither is what scrubbed the text
        // above — removing that scrub alone reds this row on the line it prints.
        await assert.rejects(readStoredText(t.textValue, "rt-peek-other"), (e) => e instanceof ValueMissing || /not in the store|held/i.test(String(e?.message ?? e)),
            "a session that was never shown the tail read the whole a pointer stores");
        host.finish();
        await endTasks("rt-peek-store");
    } finally { delete globalThis.indexedDB; }
});

// --- the lines a model sends are clamped at the ask, whatever it sends ---

test("RED TEAM: no `lines` value makes the host read past its byte ceiling or the tail show past the 200-line ceiling", T, async () => {
    const many = Array.from({ length: 300 }, (_, i) => `n${i}`);
    const { host, task, seen } = await detachedPeeking("rt-peek-lines", () => peekOf(many.join("\n") + "\n"));
    // Every shape a JSON body can carry, decimal strings and non-numbers included.
    for (const lines of [Infinity, -Infinity, 1e9, 200, 201, 5000, -1, -5000, 0, 2.7, "7", "1e9", "", "many", null, undefined, {}, [5000], true]) {
        const t = await taskAction("rt-peek-lines", { op: "tail", id: task, lines });
        const text = typeof t === "string" ? t : t.content;
        const body = text.split("\n").slice(1).filter((l) => /^n\d+$/.test(l));
        assert.ok(body.length <= TASK_TAIL_MAX_LINES, `lines ${JSON.stringify(lines)}: the tail showed ${body.length} lines`);
        assert.equal(body.at(-1), "n299", `lines ${JSON.stringify(lines)}: the tail is not the END of the stream`);
    }
    for (const a of seen) {
        assert.ok(a.bytes !== undefined && a.bytes >= PEEK_DEFAULT_BYTES && a.bytes <= PEEK_MAX_BYTES, `an ask of ${a.bytes} B left the protocol's range`);
    }
    // The control: the shape that asks for the most still lands on the ceiled request, not on a number of its own.
    assert.ok(seen.some((a) => a.bytes === (TASK_TAIL_MAX_LINES + 1) * 240), "no ask reached the 200-line ceiling's own size");
    host.finish();
    await endTasks("rt-peek-lines");
});

// --- another run's task reads nothing of it, against a host that really answers peek ---

test("RED TEAM: another run's task id is UnknownTask and sends the host no peek, while the holder's own tail does", T, async () => {
    const { host, task, seen } = await detachedPeeking("rt-peek-holder", () => peekOf("the holder's output\n"));
    liveRun("rt-peek-other");
    const before = seen.length;
    for (const op of ["tail", "await", "cancel"]) {
        const a = await taskAction("rt-peek-other", { op, id: task, lines: 50, timeout_ms: 20 });
        assert.match(a, /^UnknownTask/, `${op}: ${a}`);
        assert.ok(!a.includes("the holder's output"), `${op}: the holder's output reached another run`);
    }
    const rows = (await withTasks(snap(), "rt-peek-other")).tasks;
    assert.equal(rows, undefined, "the holder's task appears in another run's rows");
    assert.equal(seen.length, before, "another run's read asked the host for the holder's output");
    // The control: the holder's own tail reads it, so the fixture can see a peek at all.
    const mine = await taskAction("rt-peek-holder", { op: "tail", id: task, lines: 5 });
    assert.match(typeof mine === "string" ? mine : mine.content, /the holder's output/);
    assert.equal(seen.length, before + 1, "the holder's own tail did not ask the host");
    host.finish();
    await endTasks("rt-peek-holder");
    await endTasks("rt-peek-other");
});
