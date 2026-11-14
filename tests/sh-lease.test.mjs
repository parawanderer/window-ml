// sh-lease.test.mjs — mode 1 of docs/spec/ASYNC_CALLS.md on ml.sh: a call that outruns its lease detaches into a task
// (sw-shell-call.ts), the task table, the `task` tool's actions, the turn's end and `ml.current.tasks` (sw-tasks.ts),
// driven against the fake native host with the worker's modules imported directly.

import { test } from "node:test";
import assert from "node:assert/strict";
import { fakeNativeHost } from "./fake-native-host.mjs";

const T = { timeout: 20000 };

// The worker's chrome, as much of it as sw-shell.ts, sw-shell-call.ts and sw-runs.ts use.
const sync = { shellEnabled: true, shellRoots: ["/w/p0"], shellSandbox: true, shellPath: [], chatUrl: "http://host/api/chat/completions", apiKey: "sk-test" };
let native = null;
let syncDelayMs = 0;
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
        // `syncDelayMs` holds the read open, as a slow storage does: the scrub (sw-scrub.ts) reads the config's secrets.
        sync: { get: async (d) => { if (syncDelayMs) await new Promise((r) => setTimeout(r, syncDelayMs)); return { ...(d ?? {}), ...sync }; }, set: async () => {} },
        // In memory, so the execution log (sw-run-log.ts) can be read back.
        session: {
            get: async (k) => { const keys = typeof k === "string" ? [k] : Array.isArray(k) ? k : Object.keys(k ?? sessionStore); return Object.fromEntries(keys.filter((x) => x in sessionStore).map((x) => [x, sessionStore[x]])); },
            set: async (o) => { Object.assign(sessionStore, JSON.parse(JSON.stringify(o))); }, remove: async (k) => { for (const x of [k].flat()) delete sessionStore[x]; },
        },
        onChanged: { addListener() {} },
    },
};
const { shRun, detachedText, SH_TAIL_ABSENT } = await import("../src/sw/sw-shell-call.ts");
const { SH_LEASE_MS, SH_HOST_TIMEOUT_MS } = await import("../src/shell/sh-call.ts");
const { taskAction, endTasks, closeTurnTasks, withTasks, openTasks, taskDrained, detachTask, cancelPageTasks, hydrateTasks, dropAllTaskMemory } = await import("../src/sw/sw-tasks.ts");
const { runInboxes, rekeyRunInbox, senderOwnsRun, releaseSessionTokens } = await import("../src/sw/sw-runs.ts");
const { runLog } = await import("../src/sw/sw-run-log.ts");
const { TokenStore } = await import("../src/pointers/token-pipe.ts");
const { builtinTool } = await import("../src/tools/tool-registry.ts");

let rootN = 0;
/**
 * A fresh host whose `done` is held until the test releases it, as a long call's is: `cancel` is answered
 * `signalled` and sends the held `done` as cancelled, which is what the real host does (SIGTERM, then the event).
 * @param opts the fake host's options
 */
function slowHost(opts = {}) {
    const host = fakeNativeHost(opts);
    const held = [];
    let end;
    host.onNative = ((inner) => (name, e) => {
        end = e;
        const recv = inner(name, { send: (m) => { if (m?.event === "done") { held.push(m); return; } e.send(m); }, close: e.close });
        return recv && ((m) => {
            if (m.call === "cancel") {
                host.calls.push(m);
                const d = held.findIndex((x) => x.id === m.args.id);
                if (d < 0) { end.send({ seq: m.seq, error: { code: "UnknownId", message: "no such call" } }); return; }
                end.send({ seq: m.seq, value: { signalled: true } });
                const [x] = held.splice(d, 1);
                end.send({ ...x, cancelled: true, ok: false, code: null, signal: "SIGTERM" });
                return;
            }
            recv(m);
        });
    })(host.onNative);
    host.finish = () => { for (const m of held.splice(0)) end.send(m); };
    native = host.onNative;
    sync.shellRoots = [`/w/p${++rootN}`];
    return host;
}

const ctxFor = (runId, extra = {}) => ({ runId, seq: 3, local: { step: 1, seq: 3 }, signal: new AbortController().signal, tokens: new TokenStore(), ...extra });
/** A run whose turn is live: its inbox is open and its task table announces through `fanned`. */
function liveRun(runId) {
    runInboxes.set(runId, { tabId: 7, queue: [] });
    const fanned = [];
    openTasks(runId, (text, task) => fanned.push({ text, task }));
    return { inbox: () => runInboxes.get(runId).queue, fanned };
}
const until = async (f, ms = 3000) => { const t0 = Date.now(); while (!f()) { if (Date.now() - t0 > ms) throw new Error("timed out waiting"); await new Promise((r) => setTimeout(r, 10)); } };
const TASK_ID = /^t[0-9a-f]{6}$/;

// --- the lease: inside it a call is a value; past it the call detaches and runs on ---

test("a call that ends inside its lease is a value, with no task and nothing in the inbox", T, async () => {
    fakeNativeHost();
    const host = fakeNativeHost();
    native = host.onNative; sync.shellRoots = [`/w/p${++rootN}`];
    const run = liveRun("run-fast");
    const r = await shRun(ctxFor("run-fast"), [["ls"], { expectMs: 5000 }]);
    assert.ok("ok" in r, JSON.stringify(r).slice(0, 300));
    assert.equal(r.ok.code, 0);
    assert.deepEqual(run.inbox(), []);
    assert.match(await taskAction("run-fast", { op: "await", id: "t000000" }), /^UnknownTask/);
    await endTasks("run-fast");
});

test("a call past its expectMs detaches: the script's await answers Detached with the task id, the process is not cancelled, and its result arrives through the inbox labelled with the id", T, async () => {
    const host = slowHost();
    const run = liveRun("run-slow");
    const r = await shRun(ctxFor("run-slow"), [["ls"], { expectMs: 60 }]);
    assert.equal(r.code, "Detached", JSON.stringify(r));
    assert.match(r.task, TASK_ID);
    assert.match(r.error, /you expected ~0 s/, "the predicted case, in its own words");
    assert.match(r.error, new RegExp(`task ${r.task}`));
    assert.match(r.error, /keeps running after your answer/);
    assert.match(r.error, /read at the start of the next turn/);
    assert.doesNotMatch(r.error, /turn ends/, "the turn no longer ends the task");
    assert.ok(!host.names().includes("cancel"), "a detach must never cancel the call");
    assert.deepEqual(run.inbox(), [], "nothing is in the inbox while it runs");
    host.finish();
    await until(() => run.inbox().length > 0);
    const [item] = run.inbox();
    assert.equal(item.task, r.task, "the inbox item names its task, which only sw-tasks sets");
    assert.equal(item.origin, undefined, "a task's result claims no person's surface");
    assert.match(item.text, new RegExp(`^\\[task ${r.task} done after \\d+ s: ml\\.sh exit 0, ok; stdout @tool:[0-9a-f]{7} \\(4 B\\): "out\\\\n"; stderr empty\\]$`));
    assert.deepEqual(run.fanned, [], "a queued result was drawn before the model read it");
    taskDrained("run-slow", item.task, item.text);   // the loop drains it at its next step (sw-run-host.ts drainInbox)
    assert.deepEqual(run.fanned.map((f) => [f.task, f.text]), [[r.task, item.text]], "the surfaces are told, as the task's, once the model reads it");
    await endTasks("run-slow");
});

test("a result that settles during the turn's last model call is never drawn by that turn: the loop never drained it, and it waits for the next", T, async () => {
    const host = slowHost();
    const run = liveRun("run-last-call");
    const r = await shRun(ctxFor("run-last-call"), [["ls"], { expectMs: 30 }]);
    host.finish();   // settles while the model writes its answer: no step boundary follows
    await until(() => run.inbox().length > 0);
    assert.equal(run.inbox()[0].task, r.task, "positive control: it was queued");
    runInboxes.delete("run-last-call");   // the turn ends: the run host closes the inbox, then settles
    closeTurnTasks("run-last-call");
    assert.deepEqual(run.fanned, [], "the transcript would show a result the model never read");
    const next = liveRun("run-last-call");   // the next turn
    assert.equal(next.inbox().length, 1, "the undrained result is queued again");
    await endTasks("run-last-call");
});

test("the Detached text says which case it was: the script's own estimate, or the default, and the host's time limit", () => {
    assert.match(detachedText("t1", 13 * 60_000, { expectMs: 13 * 60_000 }), /you expected ~780 s and it is still running: investigate the stall/);
    const d = detachedText("t1", SH_LEASE_MS, {});
    assert.match(d, new RegExp(`no expectMs was given, so the ${SH_LEASE_MS / 1000} s default applied`));
    assert.doesNotMatch(d, /you expected/, "the two phrasings are never merged");
    assert.match(d, new RegExp(`host kills it at ${SH_HOST_TIMEOUT_MS / 1000} s`));
    assert.match(detachedText("t1", 1000, { timeoutMs: 600_000 }), /host kills it at 600 s/);
    assert.ok(SH_LEASE_MS >= 1000 && SH_LEASE_MS < 60_000, "the placeholder is seconds, not minutes");
});

test("what the model reads about ml.sh.run names no lease number, which a build's __SH_LEASE_MS__ would falsify, and the host's real limit", async () => {
    const { readFile } = await import("node:fs/promises");
    const src = await readFile(new URL("../src/contract.ts", import.meta.url), "utf8");
    const doc = src.slice(src.indexOf("export interface MlSh"), src.indexOf("read(token: string"));
    // The lease a build ships is a define (build.mjs), so the docs say where it is named instead: the Detached error.
    assert.ok(doc.includes("up to `expectMs` (default: a short lease, which the `Detached` error names)"), "the JSDoc's lease wording changed");
    assert.doesNotMatch(doc.slice(0, doc.indexOf("@param argv")), /\b\d+ s\b/, "the JSDoc states a lease in seconds");
    assert.ok(doc.includes(`default ${SH_HOST_TIMEOUT_MS / 1000} s`), "the JSDoc's host limit drifted from SH_HOST_TIMEOUT_MS");
});

test("what the model reads says ml.sh is a namespace called as ml.sh.run(argv), never ml.sh(...) with a shell string", async () => {
    // A bench canary (gemma4:e4b) wrote `await ml.sh('cat ~/.ssh/config')` from the text before this clause.
    const { ML_API_DOCS } = await import("../src/api-docs.gen.ts");
    const text = ML_API_DOCS;
    assert.match(text, /A namespace, not a function: `await ml\.sh\.run\(\[/);
    assert.match(text, /takes an argv array,[\s*]*never a shell string/);
});

test("expectMs is checked like timeoutMs: a positive number, refused otherwise before the host is reached", T, async () => {
    const host = slowHost();
    for (const bad of [0, -5, "10", Infinity, NaN]) {
        const r = await shRun(ctxFor("run-bad-expect"), [["ls"], { expectMs: bad }]);
        assert.equal(r.code, "BadRequest", `${bad}: ${JSON.stringify(r)}`);
    }
    assert.ok(!host.names().includes("spawn"), "a bad expectMs reached the host");
});

test("a call made with lease:false never detaches: the extension's own read waits for its value", T, async () => {
    const host = slowHost();
    liveRun("run-nolease");
    const p = shRun(ctxFor("run-nolease", { lease: false }), [["ls"], { expectMs: 30 }]);
    let settled = false;
    void p.then(() => { settled = true; });
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(settled, false, "it answered before the call ended");
    host.finish();
    const r = await p;
    assert.ok("ok" in r, JSON.stringify(r));
    await endTasks("run-nolease");
});

// --- the task tool: await, cancel and tail act only on this run's own tasks ---

test("task await answers with the result when the call ends inside its timeout, and the inbox does not carry it a second time", T, async () => {
    const host = slowHost();
    const run = liveRun("run-await");
    const r = await shRun(ctxFor("run-await"), [["ls"], { expectMs: 30 }]);
    const waiting = taskAction("run-await", { op: "await", id: r.task, timeout_ms: 5000 });
    setTimeout(() => host.finish(), 50);
    assert.match(await waiting, new RegExp(`^task ${r.task} done after \\d+ s: ml\\.sh exit 0`));
    await new Promise((res) => setTimeout(res, 50));
    assert.deepEqual(run.inbox(), [], "the awaited result was also queued for the inbox");
    assert.match(await taskAction("run-await", { op: "await", id: r.task }), /^task t[0-9a-f]{6} done: /, "a later await reads the same result");
    await endTasks("run-await");
});

test("an await that lands while a task's end is being scrubbed waits for the text, and the inbox does not carry it too", T, async () => {
    const host = slowHost();
    const run = liveRun("run-scrub-window");
    const r = await shRun(ctxFor("run-scrub-window"), [["ls"], { expectMs: 30 }]);
    syncDelayMs = 80;
    try {
        host.finish();
        await new Promise((res) => setTimeout(res, 20));   // inside the scrub
        const answer = await taskAction("run-scrub-window", { op: "await", id: r.task, timeout_ms: 5000 });
        assert.match(answer, new RegExp(`^task ${r.task} done after \\d+ s: ml\\.sh exit 0`), `an await in the scrub read an empty stub: ${answer}`);
        await new Promise((res) => setTimeout(res, 120));
        assert.deepEqual(run.inbox(), [], "the awaited result was also queued for the inbox");
    } finally { syncDelayMs = 0; }
    await endTasks("run-scrub-window");
});

test("a result queued for the inbox and then read by an await is dropped at the drain: the model never reads it twice", T, async () => {
    const host = slowHost();
    const run = liveRun("run-queued-then-awaited");
    const r = await shRun(ctxFor("run-queued-then-awaited"), [["ls"], { expectMs: 30 }]);
    host.finish();
    await until(() => run.inbox().length === 1);
    assert.match(await taskAction("run-queued-then-awaited", { op: "await", id: r.task }), new RegExp(`^task ${r.task} done: `));
    const [item] = run.inbox().splice(0);
    assert.equal(taskDrained("run-queued-then-awaited", item.task, item.text), false, "the drain would inject a result the model already read");
    assert.deepEqual(run.fanned, [], "a result the drain dropped was drawn");
    await endTasks("run-queued-then-awaited");
});

test("task await that runs out says so in the model's own case and leaves the call running", T, async () => {
    const host = slowHost();
    liveRun("run-await-out");
    const r = await shRun(ctxFor("run-await-out"), [["ls"], { expectMs: 30 }]);
    assert.match(await taskAction("run-await-out", { op: "await", id: r.task, timeout_ms: 40 }), /still running after \d+ s; you expected it within 0 s more\. Investigate the stall/);
    assert.ok(!host.names().includes("cancel"), "an await that runs out cancelled the call");
    const [row] = (await withTasks(snap(), "run-await-out")).tasks.rows;
    assert.equal(row[3], "running");
    host.finish();
    await endTasks("run-await-out");
});

test("task cancel cancels the process on the host, says what happened, and the cancelled result still arrives", T, async () => {
    const host = slowHost();
    const run = liveRun("run-cancel");
    const r = await shRun(ctxFor("run-cancel"), [["ls"], { expectMs: 30 }]);
    assert.match(await taskAction("run-cancel", { op: "cancel", id: r.task }), /cancelled: the host signalled its process group/);
    assert.equal(host.calls.filter((c) => c.call === "cancel").length, 1);
    await until(() => run.inbox().length > 0);
    assert.match(run.inbox()[0].text, new RegExp(`^\\[task ${r.task} cancelled after`));
    assert.match(await taskAction("run-cancel", { op: "cancel", id: r.task }), /already cancelled/);
    await endTasks("run-cancel");
});

test("task tail on a running ml.sh call says the host reports output at the end, never an empty tail", T, async () => {
    const host = slowHost();
    liveRun("run-tail");
    const r = await shRun(ctxFor("run-tail"), [["ls"], { expectMs: 30 }]);
    const t = await taskAction("run-tail", { op: "tail", id: r.task, lines: 5 });
    assert.ok(t.endsWith(SH_TAIL_ABSENT), t);
    host.finish();
    await endTasks("run-tail");
});

// Long enough for the scrub to treat it as a key (sw-scrub's MIN_KEY is 12); the config below is given it for these rows.
const PEEK_KEY = "sk-peek-0123456789abcdef";
const b64 = (s) => ({ $bytes: Buffer.from(s).toString("base64") });
const peekOf = (out, err = "") => ({ stdout: { size: Buffer.byteLength(out), truncated: false, data: b64(out) }, stderr: { size: Buffer.byteLength(err), truncated: false, data: b64(err) } });
/** A detached call on a host that answers `peek` with `answer(args)`. */
async function detachedPeeking(runId, answer, opts = {}) {
    const host = slowHost({ peek: true, peekAnswer: answer, ...opts });
    liveRun(runId);
    const r = await shRun(ctxFor(runId), [["ls"], { expectMs: 30 }]);
    return { host, task: r.task };
}

test("task tail on a host that answers peek returns the latest lines of each stream, asked for by the call's id", T, async () => {
    const seen = [];
    const { host, task } = await detachedPeeking("run-peek", (a) => { seen.push(a); return peekOf("one\ntwo\nthree\n", "warn\n"); });
    const t = await taskAction("run-peek", { op: "tail", id: task, lines: 2 });
    assert.match(t, /^stdout \(14 B so far, last 2 lines\):\ntwo\nthree\nstderr \(5 B so far\):\nwarn$/, t);
    assert.equal(seen.length, 1);
    assert.match(seen[0].id, /^c\d+$/);
    assert.equal(seen[0].bytes, 4096);
    assert.ok(!t.includes(SH_TAIL_ABSENT));
    host.finish();
    await endTasks("run-peek");
});

test("task tail on a host without hello.peek says SH_TAIL_ABSENT and never calls peek", T, async () => {
    const host = slowHost({ peekAnswer: () => peekOf("leak\n") });
    liveRun("run-nopeek");
    const r = await shRun(ctxFor("run-nopeek"), [["ls"], { expectMs: 30 }]);
    const t = await taskAction("run-nopeek", { op: "tail", id: r.task });
    assert.ok(t.endsWith(SH_TAIL_ABSENT), t);
    assert.ok(!t.includes("leak"));
    assert.ok(!host.names().includes("peek"), "peek was called on a host that did not say it has it");
    await withTasks(snap(), "run-nopeek");
    assert.ok(!host.names().includes("peek"), "ml.current.tasks probed peek on a host without it");
    host.finish();
    await endTasks("run-nopeek");
});

test("a secret in a running call's output (the API key, a bearer token) never reaches the model through tail or the tasks row", T, async () => {
    sync.apiKey = PEEK_KEY;
    const { host, task } = await detachedPeeking("run-peek-secret", () => peekOf(`starting\nkey=${PEEK_KEY}\nAuthorization: Bearer ${PEEK_KEY}\n`, `${PEEK_KEY}\n`));
    const t = await taskAction("run-peek-secret", { op: "tail", id: task, lines: 10 });
    assert.ok(t.includes("starting"), t);
    assert.ok(!t.includes(PEEK_KEY), t);
    const [row] = (await withTasks(snap(), "run-peek-secret")).tasks.rows;
    assert.ok(String(row[8]).includes("starting"), String(row[8]));
    assert.ok(!String(row[8]).includes(PEEK_KEY), String(row[8]));
    sync.apiKey = "sk-test";
    host.finish();
    await endTasks("run-peek-secret");
});

test("peek answering UnknownId (the call just ended) is a sentence, not an error or the absent line", T, async () => {
    const { host, task } = await detachedPeeking("run-peek-gone", () => undefined);
    const t = await taskAction("run-peek-gone", { op: "tail", id: task });
    assert.equal(t, "It has just ended; its result arrives on its own.");
    host.finish();
    await endTasks("run-peek-gone");
});

test("any other peek failure is one short sentence, and a secret in the host's message is scrubbed", T, async () => {
    sync.apiKey = PEEK_KEY;
    const { host, task } = await detachedPeeking("run-peek-bad", () => ({ error: { code: "Io", message: `${"x".repeat(100)}${PEEK_KEY} ${"x".repeat(400)}` } }));
    const t = await taskAction("run-peek-bad", { op: "tail", id: task });
    assert.match(t, /^The (?:host|\[server\]) could not read its output \(/);
    assert.ok(!t.includes(PEEK_KEY), t);
    assert.ok(t.length < 200, t.length);
    assert.ok(!t.includes("sk-peek"), "the cut to a short sentence must not leave the front of a key");
    assert.ok(!t.includes("\n"));
    sync.apiKey = "sk-test";
    host.finish();
    await endTasks("run-peek-bad");
});

// --- the two bounds: the tail nobody asked for is 500 characters, the tail asked for is lines first up to 8 KiB ---

test("the tail the model asks for is lines first: N whole lines under 8 KiB, even where a line is over 500 characters", T, async () => {
    const lines = Array.from({ length: 30 }, (_, i) => `L${i}:${"w".repeat(100)}`);
    const { host, task } = await detachedPeeking("run-peek-lines", () => peekOf(lines.join("\n") + "\n"));
    const t = await taskAction("run-peek-lines", { op: "tail", id: task, lines: 30 });
    assert.equal(typeof t, "string", "nothing was cut, so there is nothing to point at");
    const body = t.split("\nstderr")[0].split("\n").slice(1);
    assert.deepEqual(body, lines, "all 30 lines whole (3 KB, well past the 500-character bound of an unasked tail)");
    host.finish();
    await endTasks("run-peek-lines");
});

test("lines past 200 are clamped to 200, and the bytes asked leave room for them", T, async () => {
    const seen = [];
    const lines = Array.from({ length: 300 }, (_, i) => `n${i}`);
    const { host, task } = await detachedPeeking("run-peek-200", (a) => { seen.push(a); return peekOf(lines.join("\n") + "\n"); });
    const t = await taskAction("run-peek-200", { op: "tail", id: task, lines: 5000 });
    const body = t.split("\nstderr")[0].split("\n").slice(1);
    assert.equal(body.length, 200);
    assert.equal(body[0], "n100");
    assert.equal(body[199], "n299");
    assert.equal(seen[0].bytes, 201 * 240);
    host.finish();
    await endTasks("run-peek-200");
});

test("a stream over 8 KiB keeps its END and is cut to the ceiling", T, async () => {
    const { host, task } = await detachedPeeking("run-peek-cap", () => peekOf(`${"a".repeat(9000)}\n${"z".repeat(9000)}\n`));
    const t = await taskAction("run-peek-cap", { op: "tail", id: task, lines: 5 });
    const text = typeof t === "string" ? t : t.content;
    const body = text.split("\n")[1];
    assert.equal(body, `…${"z".repeat(8192)}`);
    assert.ok(!text.includes("a".repeat(10)));
    host.finish();
    await endTasks("run-peek-cap");
});

test("a tail cut by the ceiling names a stored value of the whole peeked stream; an uncut one names none", T, async () => {
    const { IDBFactory } = (await import("node:module")).createRequire(import.meta.url)("fake-indexeddb");
    globalThis.indexedDB = new IDBFactory();
    try {
        const { readStoredText, claimValue } = await import("../src/sw/sw-values.ts");
        const lines = Array.from({ length: 40 }, (_, i) => `row${i}:${"q".repeat(400)}`);
        const { host, task } = await detachedPeeking("run-peek-ptr", () => peekOf(lines.join("\n") + "\n"));
        const t = await taskAction("run-peek-ptr", { op: "tail", id: task, lines: 40 });
        assert.equal(typeof t, "object", "40 lines of 400 characters is 16 KB: cut to 8 KiB");
        assert.ok(t.content.length < 8192 + 200);
        assert.ok(!t.content.includes("row0:"), "the start was cut");
        await claimValue(t.textValue, "run-peek-ptr");
        const whole = await readStoredText(t.textValue, "run-peek-ptr");
        assert.equal(t.textChars, whole.length, "textChars is the stored whole's length, which the cut line names");
        for (const l of lines) assert.ok(whole.includes(l), "the stored whole holds every peeked line, including the cut ones");
        assert.ok(whole.startsWith("stdout ("));
        const small = await taskAction("run-peek-ptr", { op: "tail", id: task, lines: 2 });
        assert.equal(typeof small, "string", "2 lines of 400 characters fit the ceiling: no value to point at");
        host.finish();
        await endTasks("run-peek-ptr");
    } finally { delete globalThis.indexedDB; }
});

test("the task tool hands the stored value on as its result's textValue, which the loop turns into a pointer", async () => {
    const { taskTool } = await import("../src/tools/task-tool.ts");
    const { defineTool } = await import("../src/ml/ml-tool-factories.ts");
    const tool = taskTool(defineTool, { act: async () => ({ content: "tail text", textValue: "k1" }) });
    assert.deepEqual(await tool.run({ op: "tail", id: "t000000" }), { content: "tail text", textValue: "k1" });
});

test("the tail nobody asked for stays at 500 characters per stream and asks the host's default 4 KiB", T, async () => {
    const seen = [];
    const { host, task } = await detachedPeeking("run-peek-row500", (a) => { seen.push(a); return peekOf(`${"a".repeat(900)}\n${"z".repeat(900)}\n`, `${"e".repeat(900)}\n`); });
    const [row] = (await withTasks(snap(), "run-peek-row500")).tasks.rows;
    const cells = String(row[8]).split("\n");
    assert.equal(cells[1], `…${"z".repeat(500)}`);
    assert.equal(cells[3], `…${"e".repeat(500)}`);
    assert.equal(seen.length, 1, "one peek per running task per snapshot");
    assert.equal(seen[0].bytes, 4096);
    host.finish();
    await endTasks("run-peek-row500");
});

test("the Detached message and the inbox line stay at the 500-character bound and ask nothing of the host", T, async () => {
    const host = slowHost({ peek: true, peekAnswer: () => peekOf("x\n") });
    const run = liveRun("run-peek-unasked");
    const r = await shRun(ctxFor("run-peek-unasked"), [["ls"], { expectMs: 30 }]);
    assert.ok(r.error.length < 1500, r.error.length);
    assert.ok(!host.names().includes("peek"), "the Detached message does not read the host");
    host.finish();
    await until(() => run.inbox().length > 0);
    const line = run.inbox()[0].text;
    assert.ok(line.length < 2000, line.length);
    assert.ok(!host.names().includes("peek"), "the inbox line does not read the host");
    await endTasks("run-peek-unasked");
});

test("the tasks row carries the same peeked tail, and a failing peek leaves its cell null", T, async () => {
    const good = await detachedPeeking("run-peek-row", () => peekOf("row line\n"));
    const [row] = (await withTasks(snap(), "run-peek-row")).tasks.rows;
    assert.match(String(row[8]), /^stdout \(9 B so far\):\nrow line/);
    good.host.finish();
    await endTasks("run-peek-row");
    const bad = await detachedPeeking("run-peek-row2", () => ({ error: { code: "Io", message: "x" } }));
    const [row2] = (await withTasks(snap(), "run-peek-row2")).tasks.rows;
    assert.match(String(row2[8]), /^The (?:host|\[server\]) could not read/);
    bad.host.finish();
    await endTasks("run-peek-row2");
});

test("one ml.current.tasks read peeks each running task once, and the state inspector's read peeks never", T, async () => {
    let peeks = 0;
    const { host } = await detachedPeeking("run-peek-once", () => { peeks++; return peekOf("x\n"); });
    await withTasks(snap(), "run-peek-once");
    assert.equal(peeks, 1, "ml.current.tasks asked the host more than once for one running task");
    const { declaredState } = await import("../src/state-registry.ts");
    const decl = declaredState().find((d) => d.id === "run.tasks");
    assert.ok(decl?.read, "run.tasks has no read");
    await decl.read({ runId: "run-peek-once" });
    assert.equal(peeks, 1, "the state inspector's read of run.tasks asked the host");
    host.finish();
    await endTasks("run-peek-once");
});

test("another run's task id and a made-up one read the same UnknownTask, and no action reaches the host", T, async () => {
    const host = slowHost();
    liveRun("run-own");
    liveRun("run-other");
    const r = await shRun(ctxFor("run-own"), [["ls"], { expectMs: 30 }]);
    const before = host.calls.length;
    for (const op of ["await", "cancel", "tail"]) {
        const foreign = await taskAction("run-other", { op, id: r.task, timeout_ms: 20 });
        const madeUp = await taskAction("run-other", { op, id: "tffffff", timeout_ms: 20 });
        assert.equal(foreign.replace(r.task, "X"), madeUp.replace("tffffff", "X"), `${op}: a foreign id is distinguishable from a made-up one`);
        assert.match(foreign, /^UnknownTask/);
    }
    for (const id of [undefined, 7, { id: r.task }, [r.task]]) assert.match(await taskAction("run-other", { op: "cancel", id }), /^UnknownTask/);
    assert.equal(host.calls.length, before, "an action for another run reached the host");
    assert.equal((await withTasks(snap(), "run-other")).tasks, undefined, "another run's task is in this run's table");
    host.finish();
    await endTasks("run-own");
    await endTasks("run-other");
});

test("task is a builtin the worker runs, offered nothing outside the run: not gated, not citable, no start-card line", () => {
    const t = builtinTool("task");
    assert.ok(t, "not in the registry");
    assert.deepEqual({ gated: t.gated, citable: t.citable, realm: t.realm, cardLine: t.cardLine }, { gated: false, citable: false, realm: "worker", cardLine: null });
});

// --- the turn's end leaves a task running; session release and archive end it (rule 4b) ---

/** Settle a turn as the run host does: close the inbox, then `closeTurnTasks`. */
const settleTurn = (runId) => { runInboxes.delete(runId); closeTurnTasks(runId); };

test("the turn's end leaves a running task running: the host is not asked to cancel, and the task is still addressable", T, async () => {
    const host = slowHost();
    const run = liveRun("run-end");
    const r = await shRun(ctxFor("run-end"), [["ls"], { expectMs: 30 }]);
    settleTurn("run-end");
    await new Promise((res) => setTimeout(res, 50));
    assert.equal(host.calls.filter((c) => c.call === "cancel" && c.args.id).length, 0, "the turn's end cancelled the call");
    assert.match(await taskAction("run-end", { op: "tail", id: r.task }), /^(?!UnknownTask)/, "the task left the table at the turn's end");
    assert.deepEqual(run.fanned, []);
    host.finish();
    await endTasks("run-end");
});

test("a result that arrives between turns is parked, not queued, and logged; the next turn queues it once, with its true elapsed time, and it is delivered once", T, async () => {
    const host = slowHost();
    const run = liveRun("run-park");
    const r = await shRun(ctxFor("run-park"), [["ls"], { expectMs: 30 }]);
    settleTurn("run-park");
    host.finish();
    await until(async () => true);
    await new Promise((res) => setTimeout(res, 150));
    assert.equal(runInboxes.has("run-park"), false, "an inbox was kept between turns");
    assert.deepEqual(run.fanned, [], "a closed turn's surfaces were told");
    const recs = (await runLog.forRun("run-park")).filter((e) => e.subsystem === "task" && e.kind === "parked");
    assert.equal(recs.length, 1, "the parked result is a run-log record");
    await new Promise((res) => setTimeout(res, 1200));   // time passes between turns; the text keeps the end time, not the read time
    const next = liveRun("run-park");
    assert.equal(next.inbox().length, 1);
    assert.equal(next.inbox()[0].task, r.task);
    assert.match(next.inbox()[0].text, /^\[task t[0-9a-f]{6} done after 0 s: /, "the elapsed time is the task's, not the wait for the next turn");
    assert.equal(taskDrained("run-park", r.task, next.inbox()[0].text), true);
    assert.equal(taskDrained("run-park", r.task, "again"), false, "delivered twice");
    assert.equal(next.fanned.length, 1);
    const third = liveRun("run-park");
    assert.deepEqual(third.inbox(), [], "a delivered result was queued again");
    await endTasks("run-park");
});

test("a parked result an await already took is not queued into the next turn", T, async () => {
    const host = slowHost();
    liveRun("run-park-awaited");
    const r = await shRun(ctxFor("run-park-awaited"), [["ls"], { expectMs: 30 }]);
    settleTurn("run-park-awaited");
    host.finish();
    await new Promise((res) => setTimeout(res, 150));
    liveRun("run-park-awaited");   // turn two opens: the result is queued
    runInboxes.get("run-park-awaited").queue.length = 0;
    settleTurn("run-park-awaited");
    assert.match(await taskAction("run-park-awaited", { op: "await", id: r.task }), /done:/);
    const third = liveRun("run-park-awaited");
    assert.deepEqual(third.inbox(), [], "an await took it, and it was queued again");
    await endTasks("run-park-awaited");
});

test("session release cancels a running task on the host with reason session-release; its late result is dropped, never parked or queued", T, async () => {
    const host = slowHost();
    liveRun("run-release");
    await shRun(ctxFor("run-release"), [["ls"], { expectMs: 30 }]);
    settleTurn("run-release");
    await endTasks("run-release");   // what onSessionRelease runs
    assert.equal(host.calls.filter((c) => c.call === "cancel" && c.args.id).length, 1, "release left the call running");
    await new Promise((res) => setTimeout(res, 150));
    const recs = (await runLog.forRun("run-release")).filter((e) => e.subsystem === "task");
    assert.deepEqual(recs.map((e) => [e.kind, e.reason]), [["cancelled", "session-release"]], "no parked record, and the reason is the release's");
    const next = liveRun("run-release");
    assert.deepEqual(next.inbox(), [], "a result of an ended session reached a later turn");
    await endTasks("run-release");
});

test("archive ends a running task with reason archived, and the releaseSessionTokens hook ends it too", T, async () => {
    const host = slowHost();
    liveRun("run-archive");
    await shRun(ctxFor("run-archive"), [["ls"], { expectMs: 30 }]);
    settleTurn("run-archive");
    await endTasks("run-archive", "archived");
    assert.equal(host.calls.filter((c) => c.call === "cancel" && c.args.id).length, 1);
    const recs = (await runLog.forRun("run-archive")).filter((e) => e.subsystem === "task");
    assert.deepEqual(recs.map((e) => [e.kind, e.reason]), [["cancelled", "archived"]]);
    const host2 = slowHost();
    liveRun("run-hook");
    await shRun(ctxFor("run-hook"), [["ls"], { expectMs: 30 }]);
    settleTurn("run-hook");
    releaseSessionTokens("run-hook");
    await until(() => host2.calls.some((c) => c.call === "cancel" && c.args.id));
    assert.match(await taskAction("run-hook", { op: "await", id: "t000000" }), /^UnknownTask/);
});

test("a Stop after the call detached does not cancel it; a Stop before it detaches does", T, async () => {
    const host = slowHost();
    liveRun("run-stop-late");
    const ctl = new AbortController();
    const r = await shRun(ctxFor("run-stop-late", { signal: ctl.signal }), [["ls"], { expectMs: 30 }]);
    assert.equal(r.code, "Detached");
    ctl.abort();
    await new Promise((res) => setTimeout(res, 80));
    assert.equal(host.calls.filter((c) => c.call === "cancel" && c.args.id).length, 0, "a Stop cancelled a detached call");
    host.finish();
    await endTasks("run-stop-late");

    const host2 = slowHost();
    liveRun("run-stop-early");
    const ctl2 = new AbortController();
    const p = shRun(ctxFor("run-stop-early", { signal: ctl2.signal }), [["ls"], { expectMs: 60_000 }]);
    await until(() => host2.calls.some((c) => c.call === "start"));
    ctl2.abort();
    await until(() => host2.calls.some((c) => c.call === "cancel" && c.args.id));
    await p;
    await endTasks("run-stop-early");
});

test("a task whose cancel cannot reach the host is reported as an orphan, not as cancelled", T, async () => {
    const host = slowHost();
    liveRun("run-orphan");
    await shRun(ctxFor("run-orphan"), [["ls"], { expectMs: 30 }]);
    host.exit("host exited");   // the port closes: the cancel has nowhere to go
    const { runLog } = await import("../src/sw/sw-run-log.ts");
    await endTasks("run-orphan");
    const recs = (await runLog.forRun("run-orphan")).filter((e) => e.subsystem === "task");
    assert.deepEqual(recs.map((e) => [e.kind, e.reason, e.level]), [["orphaned", "session-release", "warn"]], "a cancel that never reached the host was reported as one");
});

// --- ml.current.tasks: the run's own rows, read at the snapshot's instant ---

/** A snapshot as the host makes one, with nothing in it. */
const snap = () => ({ run: { id: "h", model: null, step: 1, maxSteps: 8, startedTs: 0 }, messages: [], meta: [], log: Object.assign([], { text: "" }) });

test("ml.current.tasks is absent with no task, and one row per task with the ruled columns once there is one", T, async () => {
    const host = slowHost();
    liveRun("run-rows");
    assert.equal((await withTasks(snap(), "run-rows")).tasks, undefined);
    const t0 = Date.now();
    const r = await shRun(ctxFor("run-rows"), [["ls"], { expectMs: 40 }]);
    const { tasks } = await withTasks(snap(), "run-rows");
    assert.deepEqual(tasks.columns, ["id", "kind", "tool", "status", "started", "elapsed_ms", "lease_ms", "expect_ms", "tail", "result"]);
    assert.deepEqual(tasks.shape, [1, 10]);
    const [row] = tasks.rows;
    const col = (c) => row[tasks.columns.indexOf(c)];
    assert.deepEqual([col("id"), col("kind"), col("tool"), col("status"), col("lease_ms"), col("expect_ms"), col("tail"), col("result")], [r.task, "call", "ml.sh", "running", 40, 40, null, null]);
    // A timer may fire a millisecond before Date.now() reaches its delay (CI read 39 for a 40 ms lease): about the
    // lease, never exactly at least it.
    assert.ok(col("started") >= t0 && col("elapsed_ms") >= 35, JSON.stringify(row));
    host.finish();
    await until(() => runInboxes.get("run-rows").queue.length > 0);
    const done = (await withTasks(snap(), "run-rows")).tasks.rows[0];
    assert.equal(done[3], "done");
    assert.match(done[9], /^@tool:[0-9a-f]{7}$/, "a done task's result is its pointer");
    await endTasks("run-rows");
    assert.equal((await withTasks(snap(), "run-rows")).tasks, undefined, "the rows outlived the turn");
});

// --- the bench varies the lease per cell: a build-time define, the shipped 15 s otherwise ---

test("__SH_LEASE_MS__ sets the lease a build ships, as the bench's cells define it; absent, the 15 s placeholder", async () => {
    const esbuild = await import("esbuild");
    const vm = await import("node:vm");
    const entry = new URL("../src/shell/sh-call.ts", import.meta.url).pathname;
    const leaseOf = async (define) => {
        const out = await esbuild.build({ entryPoints: [entry], bundle: true, write: false, format: "cjs", platform: "neutral", logLevel: "silent", ...(define ? { define } : {}) });
        const mod = { exports: {} };
        vm.runInNewContext(out.outputFiles[0].text, { module: mod, exports: mod.exports, crypto: globalThis.crypto, TextEncoder, TextDecoder });
        return mod.exports.SH_LEASE_MS;
    };
    assert.equal(await leaseOf({ __SH_LEASE_MS__: "5000" }), 5000);
    assert.equal(await leaseOf({ __SH_LEASE_MS__: "60000" }), 60000);
    assert.equal(await leaseOf(), 15000, "undefined: the shipped placeholder");
});

test("build.mjs refuses an __SH_LEASE_MS__ that is not a positive integer, before it builds anything", async () => {
    const { spawnSync } = await import("node:child_process");
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const root = new URL("..", import.meta.url).pathname;
    for (const bad of ["0", "-5", "15s", "1.5", ""]) {
        const out = mkdtempSync(join(tmpdir(), "wml-lease-"));
        try {
            const r = spawnSync(process.execPath, ["build.mjs", "--outdir", join(out, "d"), "--define", `__SH_LEASE_MS__=${bad}`], { cwd: root, encoding: "utf8", timeout: 20000 });
            assert.notEqual(r.status, 0, `${JSON.stringify(bad)} built`);
            assert.match(r.stderr, /__SH_LEASE_MS__ must be a positive integer of milliseconds/);
        } finally { rmSync(out, { recursive: true, force: true }); }
    }
});

test("the task line reads under a second as \"<1 s\", never \"0 s\"", async () => {
    const { taskLineText } = await import("../src/sidebar/transcript/task-line.tsx");
    assert.equal(taskLineText("t1", { status: "done", ms: 300, code: 0 }), "✓ task t1 finished · <1 s · exit 0");
    assert.equal(taskLineText("t1", { status: "done", ms: 1600, code: 0 }), "✓ task t1 finished · 2 s · exit 0");
});

// --- a page change ends the page's tasks, not the run's (ASYNC_CALLS.md rule 4a) ---

/** A task whose executor the test owns and which declares where it runs: `pageBound` true is a detached exec's kind. */
function ownedTask(runId, pageBound, confirmed = true) {
    let end;
    const settled = new Promise((r) => { end = r; });
    const seen = { cancel: 0 };
    const id = detachTask(runId, { tool: pageBound ? "exec" : "ml.sh", startedMs: Date.now(), leaseMs: 15_000, expectMs: null,
        exec: { pageBound, cancel: async () => { seen.cancel++; return { confirmed, text: "cancelled by the test" }; }, tail: () => null, tailAbsent: "no tail", settled } });
    return { id, seen, end: (text) => end({ status: "done", text, result: null }) };
}

test("a page change cancels a page-bound task by its executor's cancel, tells the model the fact, and records it", T, async () => {
    const run = liveRun("run-pg-cancel");
    const t = ownedTask("run-pg-cancel", true);
    await cancelPageTasks("run-pg-cancel");
    assert.equal(t.seen.cancel, 1);
    assert.deepEqual(run.inbox().map((m) => ({ text: m.text, task: m.task })), [{ text: `[task ${t.id} cancelled: it ran in the page this run left]`, task: t.id }]);
    const rec = (await runLog.forRun("run-pg-cancel")).filter((e) => e.subsystem === "task" && e.kind === "cancelled");
    assert.equal(rec.length, 1);
    assert.equal(rec[0].reason, "page-change");
    assert.equal(rec[0].detail.id, t.id);
    assert.match(await taskAction("run-pg-cancel", { op: "await", id: t.id }), /cancelled/);
    await endTasks("run-pg-cancel");
});

test("a page change leaves a runtime-bound ml.sh task running, and its late result still reaches the inbox", T, async () => {
    const host = slowHost();
    const run = liveRun("run-pg-sh");
    const r = await shRun(ctxFor("run-pg-sh"), [["ls"], { expectMs: 60 }]);
    assert.equal(r.code, "Detached", JSON.stringify(r).slice(0, 300));
    await cancelPageTasks("run-pg-sh");
    assert.equal(host.calls.filter((c) => c.call === "cancel").length, 0, "the host was asked to cancel a runtime-bound call");
    assert.deepEqual(run.inbox(), [], "a fact was told about a task that kept running");
    host.finish();
    await until(() => run.inbox().length > 0);
    assert.match(run.inbox()[0].text, new RegExp(`^\\[task ${r.task} done after`));
    await endTasks("run-pg-sh");
});

test("a cancelled page-bound task never resolves later: its late result is dropped, not queued against the new page", T, async () => {
    const run = liveRun("run-pg-late");
    const t = ownedTask("run-pg-late", true);
    await cancelPageTasks("run-pg-late");
    t.end("the OLD page's answer");
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(run.inbox().length, 1, "only the cancel fact is queued");
    assert.doesNotMatch(run.inbox()[0].text, /OLD page/);
    const rows = (await withTasks({ run: { id: "h", model: null, step: 1, maxSteps: 8, startedTs: 0 }, messages: [], meta: [], log: Object.assign([], { text: "" }) }, "run-pg-late")).tasks.rows;
    assert.equal(rows[0][3], "cancelled");
    assert.equal(rows[0][9], null);
    await endTasks("run-pg-late");
});

test("an await on a page-bound task is answered with the cancel fact when the page changes, and nothing is also queued", T, async () => {
    const run = liveRun("run-pg-await");
    const t = ownedTask("run-pg-await", true);
    const waiting = taskAction("run-pg-await", { op: "await", id: t.id, timeout_ms: 5000 });
    await new Promise((r) => setTimeout(r, 20));
    await cancelPageTasks("run-pg-await");
    assert.match(await waiting, new RegExp(`^task ${t.id} cancelled after \\d+ s: it ran in the page this run left$`));
    assert.deepEqual(run.inbox(), []);
    await endTasks("run-pg-await");
});

test("a page-bound cancel the executor does not confirm leaves the task orphaned: the line, the record and a waiting await all say so", T, async () => {
    const run = liveRun("run-pg-orphan");
    const t = ownedTask("run-pg-orphan", true, false);
    await cancelPageTasks("run-pg-orphan");
    assert.deepEqual(run.inbox().map((m) => m.text), [`[task ${t.id} orphaned: it ran in the page this run left, and its cancel was not confirmed]`]);
    const rec = (await runLog.forRun("run-pg-orphan")).filter((e) => e.subsystem === "task");
    assert.deepEqual(rec.map((e) => [e.kind, e.reason]), [["orphaned", "page-change"]]);
    t.end("the OLD page's answer");
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(run.inbox().length, 1, "an orphaned page-bound task's late result reached the inbox");
    await endTasks("run-pg-orphan");

    liveRun("run-pg-orphan-await");
    const u = ownedTask("run-pg-orphan-await", true, false);
    const waiting = taskAction("run-pg-orphan-await", { op: "await", id: u.id, timeout_ms: 5000 });
    await new Promise((r) => setTimeout(r, 20));
    await cancelPageTasks("run-pg-orphan-await");
    const answer = await waiting;
    assert.match(answer, /orphaned/, answer);
    assert.doesNotMatch(answer, new RegExp(`^task ${u.id} cancelled`), "the await read cancelled while the table reads orphaned");
    await endTasks("run-pg-orphan-await");
});

// --- the inbox follows the run to a new tab ---

test("rekeyRunInbox moves a live run's inbox to the new tab: a late result lands under it, the sender check accepts the new tab and refuses the old", T, async () => {
    const host = slowHost();
    const run = liveRun("run-rekey");                  // on tab 7
    const r = await shRun(ctxFor("run-rekey"), [["ls"], { expectMs: 60 }]);
    assert.equal(r.code, "Detached");
    assert.equal(senderOwnsRun({ tab: { id: 7 } }, "run-rekey"), true);
    assert.equal(rekeyRunInbox("run-rekey", 9), true);
    assert.equal(runInboxes.get("run-rekey").tabId, 9);
    assert.equal(senderOwnsRun({ tab: { id: 9 } }, "run-rekey"), true);
    assert.equal(senderOwnsRun({ tab: { id: 7 } }, "run-rekey"), false, "the old tab still answers for the run");
    assert.equal(senderOwnsRun({}, "run-rekey"), true, "an extension page has no tab and is not refused");
    host.finish();
    await until(() => run.inbox().length > 0);
    assert.equal(runInboxes.get("run-rekey").queue, run.inbox(), "the result went to the re-keyed inbox itself");
    assert.match(run.inbox()[0].text, new RegExp(`^\\[task ${r.task} done`));
    assert.equal(rekeyRunInbox("no-such-run", 9), false);
    await endTasks("run-rekey");
});

// --- the cap (detachedTaskMaxMin) holds an ml.sh call's timeoutMs; the durable table files a call as a sh row (rule 4b, slice B) ---

const spawnTimeouts = (host) => host.calls.filter((c) => c.call === "spawn").map((c) => c.args.timeoutMs);

test("a call's timeoutMs is held to the person's cap; under the cap it is kept; none named is left to the host's own default", T, async () => {
    const host = slowHost();
    liveRun("run-cap-sh");
    try {
        sync.detachedTaskMaxMin = 5;
        for (const [named, sent] of [[3_600_000, 300_000], [600_000, 300_000], [120_000, 120_000], [undefined, undefined]]) {
            const before = spawnTimeouts(host).length;
            const r = await shRun(ctxFor("run-cap-sh"), [["ls"], { expectMs: 20, ...(named !== undefined ? { timeoutMs: named } : {}) }]);
            assert.equal(r.code, "Detached", JSON.stringify(r));
            assert.equal(spawnTimeouts(host).slice(before)[0], sent, `timeoutMs ${named} -> ${sent}`);
            if (named !== undefined) assert.match(r.error, new RegExp(`host kills it at ${sent / 1000} s`), "the text states the timeout applied");
            else assert.match(r.error, new RegExp(`host kills it at ${SH_HOST_TIMEOUT_MS / 1000} s`));
            host.finish();
        }
        sync.detachedTaskMaxMin = 0;   // invalid: the ceiling
        const before = spawnTimeouts(host).length;
        await shRun(ctxFor("run-cap-sh"), [["ls"], { expectMs: 20, timeoutMs: 3_600_000 }]);
        assert.equal(spawnTimeouts(host).slice(before)[0], 3_600_000);
        host.finish();
        delete sync.detachedTaskMaxMin;   // the default is 60 min
        const b2 = spawnTimeouts(host).length;
        await shRun(ctxFor("run-cap-sh"), [["ls"], { expectMs: 20, timeoutMs: 10_000_000 }]);
        assert.equal(spawnTimeouts(host).slice(b2)[0], 3_600_000, "SH_LIMITS.timeoutMs is the ceiling either way");
        host.finish();
    } finally { delete sync.detachedTaskMaxMin; await endTasks("run-cap-sh"); }
});

test("a call that cannot detach (lease:false) keeps its timeoutMs: the cap is for detached tasks", T, async () => {
    const host = slowHost();
    liveRun("run-cap-nolease");
    sync.detachedTaskMaxMin = 1;
    try {
        const p = shRun(ctxFor("run-cap-nolease", { lease: false }), [["ls"], { timeoutMs: 600_000 }]);
        await until(() => spawnTimeouts(host).length > 0);
        assert.equal(spawnTimeouts(host)[0], 600_000);
        host.finish();
        await p;
    } finally { delete sync.detachedTaskMaxMin; await endTasks("run-cap-nolease"); }
});

test("a detached call is written through as a sh row with no executor, and its end is written", T, async () => {
    const host = slowHost();
    const run = liveRun("run-sh-row");
    const r = await shRun(ctxFor("run-sh-row"), [["ls"], { expectMs: 40 }]);
    const key = "ml_tasks:run-sh-row";
    const row = sessionStore[key][0];
    assert.deepEqual({ v: row.v, id: row.id, tool: row.tool, status: row.status, ref: row.ref, expectMs: row.expectMs }, { v: 1, id: r.task, tool: "ml.sh", status: "running", ref: { kind: "sh" }, expectMs: 40 });
    host.finish();
    await until(() => run.inbox().length > 0);
    assert.equal(sessionStore[key][0].status, "done");
    assert.match(sessionStore[key][0].text, /ml\.sh exit 0/);
    await endTasks("run-sh-row");
    assert.equal(sessionStore[key], undefined, "session release removes the key");
});

test("hydrate: a running sh row is orphaned (its connection to the host died with the worker), told to the next turn, logged and persisted", T, async () => {
    const runId = "run-sh-orphan";
    dropAllTaskMemory();
    sessionStore[`ml_tasks:${runId}`] = [{ v: 1, id: "t00sh00", tool: "ml.sh", startedMs: Date.now() - 20_000, leaseMs: 15_000, expectMs: null, status: "running", result: null, text: null, delivered: false, code: null, ref: { kind: "sh" } }];
    runInboxes.set(runId, { tabId: 7, queue: [] });
    await hydrateTasks(runId);
    openTasks(runId, () => {});
    const q = runInboxes.get(runId).queue;
    assert.equal(q.length, 1);
    assert.match(q[0].text, /^\[task t00sh00 orphaned after \d+ s: the service worker restarted and this call's connection to the host was lost/);
    const recs = (await runLog.forRun(runId)).filter((e) => e.subsystem === "task" && e.kind === "orphaned");
    assert.equal(recs.length, 1);
    assert.equal(recs[0].reason, "worker-restart");
    assert.equal(sessionStore[`ml_tasks:${runId}`][0].status, "orphaned");
    assert.equal(taskDrained(runId, "t00sh00", q[0].text), true);
    // The model can still ask about it, and cancelling an orphan reads as already ended: nothing is sent to a host.
    assert.match(await taskAction(runId, { op: "cancel", id: "t00sh00" }), /already orphaned/);
    // Not again into the turn after.
    runInboxes.set(runId, { tabId: 7, queue: [] });
    dropAllTaskMemory();
    await hydrateTasks(runId);
    openTasks(runId, () => {});
    assert.deepEqual(runInboxes.get(runId).queue, []);
    runInboxes.delete(runId);
    await endTasks(runId);
});

test("hydrate: a sh row that ended is as it was, and a row naming no executor that can be found is orphaned rather than left running", T, async () => {
    const runId = "run-sh-mixed";
    dropAllTaskMemory();
    sessionStore[`ml_tasks:${runId}`] = [
        { v: 1, id: "t00end0", tool: "ml.sh", startedMs: 1000, leaseMs: 15_000, expectMs: null, status: "done", result: "@tool:abc1234", text: "ml.sh exit 0", delivered: true, endedMs: 4000, code: 0, ref: { kind: "sh" } },
        { v: 1, id: "t00ref0", tool: "ml.sh", startedMs: Date.now(), leaseMs: 15_000, expectMs: null, status: "running", result: null, text: null, delivered: false, code: null },
    ];
    runInboxes.set(runId, { tabId: 7, queue: [] });
    await hydrateTasks(runId);
    openTasks(runId, () => {});
    const q = runInboxes.get(runId).queue;
    assert.deepEqual(q.map((i) => i.task), ["t00ref0"], "the delivered one is not queued; the unreachable one is, as an orphan");
    assert.match(await taskAction(runId, { op: "await", id: "t00end0" }), /^task t00end0 done: ml\.sh exit 0/);
    runInboxes.delete(runId);
    await endTasks(runId);
});
