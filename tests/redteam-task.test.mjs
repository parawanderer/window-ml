// redteam-task.test.mjs — the red team's pass on ASYNC_CALLS.md mode 1 (the `task` tool, the `Detached` answer of
// `ml.sh.run`, the inbox's task origin and `ml.current.tasks`): what a PAGE, a SCRIPT and the MODEL must never get from
// it (src/sw/sw-tasks.ts, src/sw/sw-shell-call.ts, src/tools/task-tool.ts; docs/spec/ASYNC_CALLS.md, mode 1 and
// `ml.current.tasks`).
//
// What must not be reachable, each a row: another run's handle, under any id shape, answering differently from an id
// that never existed and never reaching the host; a result arriving after its run's turn ended, including into a later
// run that reuses the run's id; the server URL or the API key inside a detached call's tail, result or text; a write
// to `ml.current.tasks` changing the table, or a page reading it at all; a `[task …]` line claimed by text alone; and a
// second await stealing the first's answer.
//
// Every row has a plain control beside it (the same instrument on an honest task), so a fixture that cannot see a task
// at all fails rather than passing by refusing nothing.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { fakeNativeHost } from "./fake-native-host.mjs";

const T = { timeout: 20000 };

// The worker's chrome, as much of it as sw-shell.ts, sw-shell-call.ts, sw-tasks.ts and sw-runs.ts use. The key is long
// enough for `secret-scrub.ts` to consider it a secret (MIN_KEY), so a row that leaks it is measurable.
const KEY = "sk-redteam-0123456789";
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
            get: async (k) => { const keys = typeof k === "string" ? [k] : Array.isArray(k) ? k : Object.keys(k ?? {}); return Object.fromEntries(keys.filter((x) => x in sessionStore).map((x) => [x, sessionStore[x]])); },
            set: async (o) => { Object.assign(sessionStore, JSON.parse(JSON.stringify(o))); }, remove: async (k) => { for (const x of [k].flat()) delete sessionStore[x]; },
        },
        onChanged: { addListener() {} },
    },
};
const { shRun, detachedText } = await import("../src/sw/sw-shell-call.ts");
const { detachTask, taskAction, withTasks, endTasks, openTasks, TASK_TAIL_MAX_LINES } = await import("../src/sw/sw-tasks.ts");
const { runInboxes } = await import("../src/sw/sw-runs.ts");
const { pageMayWrite } = await import("../src/event-admission.ts");
const { TokenStore } = await import("../src/pointers/token-pipe.ts");
const { evalReadonly, NotInDialect } = await import("../src/readonly-exec.ts");

let rootN = 0;
/** A host whose `done` is held until the test releases it, as a long call's is; `cancel` answers `signalled`. */
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
/** A run whose turn is live: an inbox it drains at the step boundary and a fan for its surfaces. */
function liveRun(runId) {
    runInboxes.set(runId, { tabId: 7, queue: [] });
    const fanned = [];
    openTasks(runId, (text, task) => fanned.push({ text, task }));
    return { inbox: () => runInboxes.get(runId)?.queue ?? [], fanned };
}
const snap = () => ({ run: { id: "h", model: null, step: 1, maxSteps: 8, startedTs: 0 }, messages: [], meta: [], log: Object.assign([], { text: "" }) });
const until = async (f, ms = 3000) => { const t0 = Date.now(); while (!f()) { if (Date.now() - t0 > ms) throw new Error("timed out waiting"); await new Promise((r) => setTimeout(r, 10)); } };
const TASK_ID = /^t[0-9a-f]{6}$/;

/** A task whose executor the test owns: its tail, its ending, and how many times (and with what) `cancel`/`tail` ran. */
function fauxTask(runId, { tail = null, tailAbsent = "no tail", text = "ml.sh exit 0, ok; stdout empty; stderr empty", status = "done", tailN = [] } = {}) {
    let end;
    const settled = new Promise((r) => { end = r; });
    const seen = { cancel: 0 };
    const id = detachTask(runId, {
        tool: "ml.sh", startedMs: Date.now() - 1000, leaseMs: 15_000, expectMs: null,
        exec: { cancel: async () => { seen.cancel++; return { confirmed: true, text: "cancelled by the test" }; }, tail: (n) => { tailN.push(n); return tail; }, tailAbsent, settled },
    });
    return { id, end: (o = { status, text, result: null }) => end(o), seen, tailN };
}

// --- the handle answers only for its run ---

test("RED TEAM: a task is awaitable by its own run (the instrument: the fixture can see a task at all)", T, async () => {
    const run = liveRun("rt-own");
    const t = fauxTask("rt-own");
    const waiting = taskAction("rt-own", { op: "await", id: t.id, timeout_ms: 5000 });
    t.end();
    assert.match(await waiting, new RegExp(`^task ${t.id} done after \\d+ s: ml\\.sh exit 0`));
    assert.deepEqual(run.inbox(), [], "the awaited result was also queued for the inbox");
    await endTasks("rt-own");
});

test("RED TEAM: another run's task, a made-up id and hostile id shapes read the same UnknownTask, and no action reaches the executor", T, async () => {
    liveRun("rt-holder");
    liveRun("rt-attacker");
    const t = fauxTask("rt-holder", { tail: "out", text: "held" });
    const madeUp = "tffffff";
    for (const op of ["await", "cancel", "tail"]) {
        const foreign = await taskAction("rt-attacker", { op, id: t.id, timeout_ms: 20 });
        const ghost = await taskAction("rt-attacker", { op, id: madeUp, timeout_ms: 20 });
        assert.equal(foreign.replace(t.id, "X"), ghost.replace(madeUp, "X"), `${op}: an id the run does not hold answered differently from an id that never existed`);
        assert.match(foreign, /^UnknownTask/, `${op}: a foreign id was answered`);
    }
    // The id shapes a hostile model or a JSON body can send: none is a key into the holder's table.
    const shapes = ["__proto__", "constructor", "toString", "", "t", "T" + t.id.slice(1), t.id + " ", " " + t.id];
    for (const id of shapes) for (const op of ["await", "cancel", "tail"]) assert.match(await taskAction("rt-attacker", { op, id, timeout_ms: 10 }), /^UnknownTask/, `${op} ${JSON.stringify(id)}`);
    for (const id of [undefined, null, 7, [t.id], { id: t.id }]) assert.match(await taskAction("rt-attacker", { op: "cancel", id }), /^UnknownTask/, JSON.stringify(id));
    assert.equal(t.seen.cancel, 0, "an attacker's cancel reached the holder's executor");
    assert.deepEqual(t.tailN, [], "an attacker's tail read the holder's executor");
    assert.equal((await withTasks(snap(), "rt-attacker")).tasks, undefined, "the holder's task appears in the attacker's rows");
    assert.equal((await taskAction("rt-attacker", { op: "bogus", id: t.id })), `UnknownTask: this run has no task ${JSON.stringify(t.id)}.`, "an unknown id answering about its own op shape says the id exists");
    await endTasks("rt-holder");
    await endTasks("rt-attacker");
});

// --- a result never outlives its turn ---

test("RED TEAM: a task settling after its turn ended is not delivered to a later run that reuses the run's id", T, async () => {
    liveRun("rt-reuse");
    const old = fauxTask("rt-reuse", { text: "the OLD turn's result" });
    runInboxes.delete("rt-reuse");          // the run host closes the inbox first, then settles
    await endTasks("rt-reuse");
    // A later run with the same id string, as a resurrected session or a cross-page replay would give it.
    const next = liveRun("rt-reuse");
    const fresh = fauxTask("rt-reuse", { text: "the new turn's result" });
    old.end({ status: "done", text: "the OLD turn's result", result: null });
    await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(next.inbox(), [], "a dead turn's result entered the next run's inbox");
    assert.deepEqual(next.fanned, [], "a dead turn's result was drawn on the next run's surfaces");
    const rows = (await withTasks(snap(), "rt-reuse")).tasks.rows;
    assert.deepEqual(rows.map((r) => r[0]), [fresh.id], "a dead turn's task kept a row in the next turn");
    await endTasks("rt-reuse");
});

// --- what the model reads is scrubbed ---

test("RED TEAM: a finished call's output reaches the model with the server URL and the key scrubbed, through the inbox", T, async () => {
    const host = slowHost({ done: () => ({ out: "ok\n", err: `boom at ${sync.chatUrl} with key ${KEY}`, code: 1 }) });
    const run = liveRun("rt-scrub-result");
    const r = await shRun(ctxFor("rt-scrub-result"), [["ls"], { expectMs: 30 }]);
    assert.equal(r.code, "Detached", JSON.stringify(r));
    host.finish();
    await until(() => run.inbox().length > 0);
    const text = run.inbox()[0].text;
    assert.ok(!text.includes(KEY), `the API key reached the model: ${text}`);
    assert.ok(!text.includes(sync.chatUrl), `the server URL reached the model: ${text}`);
    assert.match(text, /\[server\]/, "the URL was not scrubbed to its placeholder (an empty scrub would pass the assertions above)");
    assert.equal(run.inbox()[0].task, r.task, "the item is the task's");
    await endTasks("rt-scrub-result");
});

test("RED TEAM: a task's tail is scrubbed where the model reads it, in `task tail` and in `ml.current.tasks`, and the lines ask is capped", T, async () => {
    liveRun("rt-scrub-tail");
    const hostile = `leak ${KEY} from ${sync.chatUrl}`;
    const t = fauxTask("rt-scrub-tail", { tail: hostile });
    const viaTool = await taskAction("rt-scrub-tail", { op: "tail", id: t.id, lines: 100000 });
    assert.ok(!viaTool.includes(KEY) && !viaTool.includes(sync.chatUrl), `task tail gave the model the secret: ${viaTool}`);
    const row = (await withTasks(snap(), "rt-scrub-tail")).tasks.rows[0];
    assert.ok(!String(row[8]).includes(KEY) && !String(row[8]).includes(sync.chatUrl), `ml.current.tasks gave the model the secret: ${row[8]}`);
    assert.deepEqual(t.tailN.slice(-2), [TASK_TAIL_MAX_LINES, 20], "the tail asks passed the row's cap or the tool's");
    await endTasks("rt-scrub-tail");
});

test("RED TEAM: the Detached text names no server, key or argv, so a script cannot read the config out of a detach", () => {
    const d = detachedText("t1a2b3", 15_000, { expectMs: undefined, timeoutMs: undefined });
    assert.ok(!d.includes(sync.chatUrl) && !d.includes(KEY), d);
    assert.ok(!d.includes("http"), d);
});

// --- ml.current.tasks: the run's own rows, and no one else's ---

test("RED TEAM: ml.current.tasks reads this run's rows; a script's write changes the table nothing; a page has no ml.current at all", T, async () => {
    liveRun("rt-dialect");
    liveRun("rt-other");
    const t = fauxTask("rt-dialect", { tail: "line" });
    const current = await withTasks(snap(), "rt-dialect");
    const read = async (js, runId) => evalReadonly(js, null, {}, undefined, { realm: "worker", current: await withTasks(snap(), runId) });
    const r = await read(`const x = ml.current.tasks; return [x.rows.length, x.rows[0][0], x.rows[0][3], x.columns.indexOf("tail")]`, "rt-dialect");
    assert.deepEqual([...r.value], [1, t.id, "running", 8], "the run's own row is not readable as ruled");
    const wrote = await read(`const x = ml.current.tasks; x.rows[0][3] = "done"; x.rows.push(["t000000", "call", "ml.sh", "done"]); return x.rows.length`, "rt-dialect");
    assert.equal(wrote.value, 2, "the script's copy refused its own write (the probe would not be seeing what it thinks)");
    assert.equal((await withTasks(snap(), "rt-dialect")).tasks.rows.length, 1, "a script's write reached the RUN's table");
    const other = await read(`return ml.current.tasks === undefined`, "rt-other");
    assert.equal(other.value, true, "another run reads a task it does not hold");
    // The page realm: `ml.current` is the run's context, and a survey on the page has none — the new member does not
    // open it (a page reaching for the tasks is refused, not answered with an empty table).
    const doc = new JSDOM("<!doctype html><body><p>hi</p></body>").window.document;
    await assert.rejects(evalReadonly(`return ml.current.tasks`, doc, { models: async () => [] }, undefined, {}), (e) => e instanceof NotInDialect, "a page read ml.current.tasks");
    await endTasks("rt-dialect");
    await endTasks("rt-other");
});

// --- a task line cannot be claimed by text ---

test("RED TEAM: only sw-tasks.ts sets the inbox's task mark, and a page cannot write a task line's event", async () => {
    // An inbox item's `task` field is what the transcript and the export draw as a task's, so the one writer is the
    // property: a page's steer (background.ts) and a page turn (sw-page-turn.ts) carry id/text/origin and never it.
    for (const f of ["src/background.ts", "src/sw/sw-run-start.ts", "src/sw/sw-page-turn.ts"]) {
        const src = readFileSync(new URL(`../${f}`, import.meta.url), "utf8");
        const pushes = src.split("\n").filter((l) => /queue\.push\(/.test(l));
        assert.ok(pushes.length > 0, `${f}: no inbox writer found, so this row checks nothing`);
        for (const p of pushes) assert.doesNotMatch(p, /\btask\s*:/, `${f} sets a task mark: ${p.trim()}`);
    }
    assert.match(readFileSync(new URL("../src/sw/sw-tasks.ts", import.meta.url), "utf8"), /queue\.push\(\{ text, task: t\.id \}\)/, "sw-tasks no longer writes the mark this row reads");
    for (const claim of ["hosts", "owns", "none"]) assert.equal(pageMayWrite("agent-task-say", claim), false, `a page wrote a task line (${claim})`);
});

// --- one await, one answer ---

test("RED TEAM: a second await neither steals nor replaces the first's answer, and says so", T, async () => {
    const run = liveRun("rt-two-awaits");
    const t = fauxTask("rt-two-awaits", { text: "the one result" });
    const first = taskAction("rt-two-awaits", { op: "await", id: t.id, timeout_ms: 5000 });
    const second = await taskAction("rt-two-awaits", { op: "await", id: t.id, timeout_ms: 5000 });
    assert.match(second, /another await is already waiting/, "a second await waited, or answered something else");
    t.end();
    assert.match(await first, /^task t[0-9a-f]{6} done after \d+ s: the one result$/, "the first await lost its answer to the second");
    assert.deepEqual(run.inbox(), [], "the race also queued the result");
    await endTasks("rt-two-awaits");
});
