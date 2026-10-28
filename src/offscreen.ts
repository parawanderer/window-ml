// Offscreen document for the `python_exec` tool. The service worker can't run WASM, so
// Pyodide (CPython→WASM) lives at this extension-origin page (whose CSP allows
// 'wasm-unsafe-eval'). But Pyodide itself now runs in a DEDICATED WORKER (python-worker.ts),
// NOT this page's main thread: this page shares a renderer process with the extension-origin
// sidebar iframe, so a compute-bound run on the main thread would freeze the sidebar's UI
// (clicks dead, scroll — on the compositor thread — still working). Off-main-thread keeps it
// responsive. This file is now just an id-matched relay: background PY_RUN ⇄ worker message.

// Hard wall-clock cap. A runaway SYNCHRONOUS run (an infinite loop, an accidental O(n³) over a
// big image) can't be interrupted cooperatively — a tight Python/WASM loop never yields to a
// message. The worker migration makes the kill trivial and total: terminate() nukes the whole
// WASM instance, then the next call respawns a fresh one. Rare enough that paying re-init on the
// next run is fine.
const PY_TIMEOUT_MS = 15000;
// The bound on everything BEFORE a script runs: waiting behind the runs ahead of it, and the cold start (loading
// the runtime and its packages, several seconds and far more on a loaded machine). The 15s cap is the script's,
// so it is armed only once the worker says the script has started; this one exists so something hung AHEAD of a
// run (an unarmed completion, a boot that never finishes) is still cleared.
const PY_START_TIMEOUT_MS = 120000;

import { ValueStore } from "./pointers/value-store";
import { htmlToMarkdown } from "./dom/html-to-md";
import { PNG_DATA_URL } from "./session/image-compact";
import { defineState } from "./state-registry";
import { reapDelay } from "./python/py-reap";
import { createPdfHost } from "./pdf/pdf-host";
import { b64ToBytes, bytesToB64, type PdfMessage, type PdfReadReply, type PdfRenderReply } from "./pdf/pdf-wire";

// The value store, reached here rather than in the worker: stored bytes are TRANSFERRED to the worker (no copy), and the
// one copy is the worker's, into Pyodide's memory. A returned frame's IPC comes back the same way and is written here,
// under the budget the service worker sent with the run (this document cannot read the settings).
let values: ValueStore | null = null;
let writeBudget = 0;
const store = (): ValueStore => values ??= new ValueStore({
    budgetBytes: () => writeBudget,
    onEvict: (e) => reportHousekeeping({ subsystem: "value-store", kind: "evict", reason: e.reason, key: e.key, bytes: e.shared ? 0 : e.bytes, ...(e.source || e.shared ? { detail: { ...(e.source ? { source: e.source } : {}), ...(e.shared ? { shared: true } : {}) } } : {}) }),
});

/**
 * A returned DataFrame larger than its preview → the value store, named on the result as `valueKey` (POINTER_VALUES
 * slice 6). The IPC bytes never go further: an ArrayBuffer does not survive the message to the service worker. A
 * frame the budget cannot hold is reported and left unstored; the run still succeeds with its preview.
 */
async function storeReturnedTable(r: PyResult & { ipc?: ArrayBuffer; valueKey?: string }, budget: unknown): Promise<PyResult> {
    const { ipc, ...rest } = r;
    if (!ipc || !(typeof budget === "number" && budget > 0)) return rest;
    writeBudget = budget;
    try { return { ...rest, valueKey: (await store().put(new Blob([ipc]), { format: "arrow-file", source: "python_exec" })).key } as PyResult; }
    catch (e) {
        reportHousekeeping({ subsystem: "value-store", kind: "refuse", reason: (e as Error)?.name === "ValueTooLarge" ? "budget" : "error", bytes: ipc.byteLength, detail: { source: "python_exec" } });
        return rest;
    }
}

/**
 * Swap each `tables` entry that names a STORED value (`data.kind === "value"`) for one carrying its bytes and format, and
 * list the buffers to transfer. A value that is gone fails the whole run with the store's reason: a table that was
 * asked for and silently left out would run the script against nothing.
 */
async function withStoredTables(tables: unknown): Promise<{ tables: unknown; transfer: ArrayBuffer[] } | { error: string }> {
    if (!Array.isArray(tables) || !tables.some((t) => t?.data?.kind === "value")) return { tables, transfer: [] };
    const transfer: ArrayBuffer[] = [];
    const out: unknown[] = [];
    for (const t of tables) {
        if (t?.data?.kind !== "value") { out.push(t); continue; }
        try {
            const { row, blob } = await store().get(String(t.data.key));
            const buffer = await blob.arrayBuffer();
            transfer.push(buffer);
            out.push({ ...t, data: { ...t.data, format: row.format, buffer } });
        } catch (e) {
            return { error: `python_exec could not load \`${t.name}\` from ${t.data.label ?? "its pointer"}: ${(e as Error)?.message ?? e}` };
        }
    }
    return { tables: out, transfer };
}

// `bootMs`/`runMs` come from the WORKER, which is the executor — anything measured downstream of it is
// measuring the message bus as well. See python-worker.ts.
type PyEnv = { python: string; pyodide: string; packages: { name: string; version?: string }[] };
type PyResult = { prewarm?: "started" | "already" | "warm" | "starting"; ok: boolean; env?: PyEnv; completions?: { name: string; type: string; complete: string }[]; bench?: { id: string; vars: { name: string; type: string }[] }; value?: unknown; stdout: string; error?: string; table?: { columns: string[]; rows: (string | number | null)[][] }; render?: "latex" | "img" | "figure"; bootMs?: number; runMs?: number; nsReset?: string; dropped?: { count: number; afterCell: number } };

// One worker per PRINCIPAL (PYODIDE_LOCKDOWN.md step 1): a worker-hosted run, a page, `full`. A principal
// change is a new worker, never a reused one — a patch one principal left in module state must not reach
// the next. The workers are same-origin (extension page → chrome-extension:// worker), so they need no
// web_accessible_resources entry; they inherit this page's 'wasm-unsafe-eval' CSP.
type PyWorkerEntry = { w: Worker; readonly: boolean };
const workers = new Map<string, PyWorkerEntry>();   // state: plumbing — one Python worker per principal
// Principals whose worker was killed and whose next spawn is a RESPAWN: the kept bench namespace died with
// the old worker, and the new one starts from empty. The respawn writes the housekeeping record that the
// bench's "sandbox restarted" banner is the human face of (docs/dev/housekeeping.md).
const respawned = new Set<string>();   // state: plumbing — principals awaiting a respawn housekeeping record
// ROOT C (docs/spec/PYTHON_DIALECT.md, "The namespace"): a run's kept namespace and what it holds, from the
// last cell's scope manifest (`bench.vars`, PERSISTENT_RUNTIME_SPEC.md). The live dict is the worker's; this is
// the copy the state inspector and `ml.current.env` read. Dropped with the run (`PY_DELETE_RUN`) or its worker.
const runNsVars = new Map<string, { id: string; vars: { name: string; type: string }[] }>();   // state: python.run-namespace
// Which workers hold a dict for a run: `run:<id>` for its readonly cells, and the SHARED `full` worker for its full
// ones. A delete must reach every one of them, and a kill of one (the `full` worker included) is a loss for every run it
// held. Recorded when a cell of the run is posted to a worker, since the worker creates the dict before the cell runs:
// this is the ONE record of "has a dict", and nothing reads a returned manifest as a proxy for it.
const runPrincipals = new Map<string, Set<string>>();   // state: plumbing — run id → principals holding its dict
// A run whose kept namespace a kill or cold start WIPED, waiting to tell the next cell. Keyed by the run.
const nsLoss = new Map<string, { at: number; reason: string }>();   // state: plumbing — one loss note per wiped run
defineState({
    id: "python.run-namespace", scope: "run", realm: "offscreen", audience: "model", lostOn: ["turn-end", "idle", "offscreen-close", "browser-restart"],
    describe: "The run's kept Python namespace: the live names and their types, shared across the run's cells until the run ends or its worker dies.",
    read: ({ runId }) => runId ? runNsVars.get(runId) : undefined,
});
// The principals whose worker was handed a tier 3 library (an inside run's `libraries`, or a library op): the ones a
// removal restarts, since nothing unloads a module (READONLY_LIBRARY_MANIFEST.md, ruling D). Cleared with the worker.
const libraryPrincipals = new Set<string>();   // state: plumbing — which live workers may hold a library module
// THE IDLE REAP (py-reap.ts): a principal's worker is shut once it has sat idle long enough, unless its live turn asked
// to keep it. One timer per idle worker, cleared when the principal posts again.
const reapTimers = new Map<string, ReturnType<typeof setTimeout>>();   // state: plumbing — one idle clock per worker
const keptPrincipals = new Set<string>();   // state: plumbing — `run:<id>` workers whose live turn asked to keep them
let nextId = 1;
type WireStamp = { client: string; run: string | null };
const pending = new Map<number, { resolve: (r: PyResult) => void; timer: ReturnType<typeof setTimeout>; streamId?: string; armOnStart?: boolean; principal: string; wire?: WireStamp; spending?: boolean }>();   // state: plumbing
// THE `ml` WIRE (ML_WIRE.md): which worker a client handle's answers go back to. The handle is this
// document's to stamp — the worker never sees it (LANE_1_PR2_DESIGN.md "Who stamps the handle"). An
// `ask` first answer is NOT relayed down: the cell's `send` stays pending until the later `ML_ANSWER`
// push, matched by `client`, arrives here.
const wireByClient = new Map<string, { post: (m: unknown) => void; runMsgId: number }>();   // state: plumbing — one in-flight cell each

/** The kill's error when it lands during the cancel's spend (the worker's `spending` mark). */
export const SPEND_KILLED = `A task this cell left kept running after it was cancelled and would not stop (most likely inside a C function), so the Python sandbox was terminated after ${PY_TIMEOUT_MS / 1000}s and the cell's result is refused.`;

/** Whether a worker's own error says it ran out of memory: wasm memory that could not grow, or a JS allocation that failed. */
export const MEMORY_DEATH = /out of memory|\bOOM\b|allocation failed|Maximum memory size|Memory\.grow/i;

/** The error a run gets when its worker died of memory (`reason` is the worker's own message): the cause named, and
 *  during the cancel's spend, what the spend was doing (pin 3's shape: the kill names the leftover, not the cell). */
export function memoryKilled(reason: string, spending: boolean): string {
    return spending
        ? `The Python sandbox ran out of memory while the cancel was spending what this cell left (tasks or callbacks it queued), so it was stopped and the cell's result is refused (${reason}).`
        : `The Python sandbox ran out of memory, so it was stopped and the cell's result is refused (${reason}).`;
}

/** Arm a kill for run `id`: when it fires, that run fails with `error` and its worker is terminated,
 *  failing anything queued behind it on that principal. */
function killAfter(id: number, ms: number, error: string, reason: "timeout" | "start-timeout"): ReturnType<typeof setTimeout> {
    return setTimeout(() => {
        const entry = pending.get(id);
        if (!entry) return;   // already resolved
        pending.delete(id);
        // Past the cell's own code: the cancel was spending a task the cell left, which would not stop (a loop inside a
        // C function is beyond the spend's bound, python-runtime.ts). Not the cell's computation, so not "simplify".
        entry.resolve({ ok: false, stdout: "", error: entry.spending && reason === "timeout" ? SPEND_KILLED : error });
        killWorker(entry.principal, reason);   // nuke the (still-busy) instance + fail any others queued behind it
    }, ms);
}

/** Tells the worker's housekeeping log what this document decided (docs/dev/housekeeping.md). The worker stamps
 *  it `offscreen` from the sender. Fire-and-forget: a log is never worth failing a run over. */
function reportHousekeeping(report: { subsystem: string; kind: string; reason?: string; key?: string; bytes?: number; ms?: number; detail?: Record<string, string | number | boolean> }): void {
    try { chrome.runtime.sendMessage({ type: "HOUSEKEEPING_REPORT", payload: report }).catch(() => { /* no worker listening */ }); } catch { /* context gone */ }
}

// Terminate one principal's worker and fail its still-pending runs with `reason`. Used on a worker crash and
// on a timeout kill (after the timed-out run itself has been resolved + removed from `pending`). A principal
// respawn (the next run of the same principal) writes the housekeeping record the persistent namespace's
// loss message reads (docs/dev/housekeeping.md): the kept bench namespace died with the worker.
function killWorker(principal: string, reason: string): void {
    const entry = workers.get(principal);
    // ROOT C: a kill wipes every run dict this worker held: its own run's for `run:<id>`, every full-mode run's for the
    // shared `full` one. Each such run's next cell opens with the loss line (PYTHON_DIALECT.md, "Lifetime and loss").
    const killedRuns = [...runPrincipals].filter(([, ps]) => ps.has(principal)).map(([runId]) => runId);
    const named = reason === "timeout" || reason === "start-timeout" || reason === "library-removed";
    const lossReason = named ? reason : "crashed";
    if (entry) {
        try { entry.w.terminate(); } catch { /* already gone */ }
        workers.delete(principal);
        libraryPrincipals.delete(principal);
        clearReap(principal);
        keptPrincipals.delete(principal);
        respawned.add(principal);   // the next spawn for this principal is a respawn: its kept namespace died
        for (const runId of killedRuns) {
            runPrincipals.get(runId)?.delete(principal);
            nsLoss.set(runId, { at: Date.now(), reason: lossReason });
            runNsVars.delete(runId);
        }
        // A timeout names itself; anything else is the worker's own error message, kept as detail under "crashed".
        reportHousekeeping({ subsystem: "pyodide", kind: "kill", reason: lossReason, key: principal, detail: { queuedRuns: [...pending.values()].filter((p) => p.principal === principal).length, ...(named ? {} : { message: reason }) } });
    }
    for (const [id, p] of [...pending.entries()]) {
        if (p.principal !== principal) continue;
        clearTimeout(p.timer);
        p.resolve({ ok: false, stdout: "", error: MEMORY_DEATH.test(reason) ? memoryKilled(reason, !!p.spending) : `Python worker stopped (${reason}).` });
        pending.delete(id);
    }
}

/** Terminate every principal's worker (the offscreen document is going away). */
function killAllWorkers(reason: string): void {
    for (const principal of [...workers.keys()]) killWorker(principal, reason);
}

/** Stop a principal's idle clock: something is about to be posted to its worker, or the worker is gone. */
function clearReap(principal: string): void {
    const t = reapTimers.get(principal);
    if (t !== undefined) { clearTimeout(t); reapTimers.delete(principal); }
}

/** The run whose live namespace a `run:<id>` worker holds, or null (a settled turn, another principal). */
function heldRun(principal: string): string | null {
    if (!principal.startsWith("run:")) return null;
    const run = principal.slice(4);
    return runPrincipals.get(run)?.has(principal) ? run : null;
}

/** Start a principal's idle clock if its worker is idle and may be reaped (py-reap.ts). */
function armReap(principal: string): void {
    clearReap(principal);
    if (!workers.has(principal) || [...pending.values()].some((p) => p.principal === principal)) return;
    const ms = reapDelay(principal, heldRun(principal) !== null, keptPrincipals.has(principal));
    if (ms === null) return;
    reapTimers.set(principal, setTimeout(() => { reapTimers.delete(principal); void reapWorker(principal, ms); }, ms));
}

/** How long a reaped worker gets to hand over its late drops before it is terminated anyway. */
const REAP_ANSWER_MS = 2000;

/**
 * Shut an idle worker (py-reap.ts). It is asked first for the callables its last cell handed to JavaScript that fired
 * since (cell-gate.ts), which no cell will report now; a live turn's namespace is lost and told on its next cell.
 * @param principal whose worker
 * @param idleMs how long it sat idle
 */
async function reapWorker(principal: string, idleMs: number): Promise<void> {
    const entry = workers.get(principal);
    if (!entry || [...pending.values()].some((p) => p.principal === principal)) return;
    const run = heldRun(principal);
    const id = nextId++;
    const dropped = await new Promise<PyResult["dropped"] | undefined>((resolve) => {
        const timer = setTimeout(() => { pending.delete(id); resolve(undefined); }, REAP_ANSWER_MS);
        pending.set(id, { resolve: (r) => { clearTimeout(timer); resolve(r?.dropped); }, timer, principal });
        try { entry.w.postMessage({ id, takeDropped: true }); }
        catch { clearTimeout(timer); pending.delete(id); resolve(undefined); }
    });
    // A cell posted while the worker answered: it is not idle any more, and its own answer restarts the clock.
    if (workers.get(principal) !== entry || [...pending.values()].some((p) => p.principal === principal)) return;
    try { entry.w.terminate(); } catch { /* already gone */ }
    workers.delete(principal);
    libraryPrincipals.delete(principal);
    keptPrincipals.delete(principal);
    clearReap(principal);   // the answer above re-armed it
    if (run) {
        runPrincipals.get(run)?.delete(principal);
        nsLoss.set(run, { at: Date.now(), reason: "idle" });
        runNsVars.delete(run);
    }
    reportHousekeeping({ subsystem: "pyodide", kind: "reap", key: principal, ms: idleMs, detail: { live: run !== null } });
    const ofRun = principal.startsWith("run:") ? principal.slice(4) : null;
    if (ofRun && (run || dropped)) {
        try { chrome.runtime.sendMessage({ type: "PY_REAPED", run: ofRun, live: run !== null, ...(dropped ? { dropped } : {}) }).catch(() => { /* no worker listening */ }); } catch { /* context gone */ }
    }
}

function ensureWorker(principal: string, readonly: boolean): Worker {
    clearReap(principal);
    const existing = workers.get(principal);
    if (existing) return existing.w;
    // `name` is how the worker knows which sandbox it is: a readonly worker boots locked down (`lockdownReadonly`),
    // a full worker is never locked. One Worker per principal is one REALM per principal — a second Pyodide
    // cannot boot in a realm `lockdown()` froze.
    const w = new Worker(chrome.runtime.getURL("python-worker.js"), { name: readonly ? "readonly" : "full" });
    // A respawn after a kill: the old worker's kept bench namespace died with it, and this one starts empty.
    // The record is the log's account of the loss the bench's "sandbox restarted" banner shows the person.
    if (respawned.delete(principal)) {
        reportHousekeeping({ subsystem: "pyodide", kind: "respawn", key: principal, detail: { mode: readonly ? "readonly" : "full" } });
    }
    w.onmessage = (e: MessageEvent) => {
        // The runtime finished starting (not a reply to anything): what started it and how long it took.
        if (e.data?.booted) {
            reportHousekeeping({ subsystem: "pyodide", kind: "cold-start", reason: e.data.by === "prewarm" ? "prewarm" : "run", ms: e.data.ms, key: principal });
            return;
        }
        // A `partial` message is a LIVE stdout chunk (opt-in streaming) — forward it to the background keyed by
        // this run's streamId (the page requestId), which relays it to the page; DON'T resolve the run.
        if (e.data?.partial) {
            const entry = pending.get(e.data.id);
            if (entry?.streamId) chrome.runtime.sendMessage({ type: "PY_STDOUT", streamId: entry.streamId, chunk: String(e.data.chunk ?? ""), ts: e.data.ts }).catch(() => { /* no receiver → drop */ });
            return;
        }
        // The cell's own code is done and its cancel is spending the tasks it left: a kill from here on is named for it.
        if (e.data?.spending) {
            const entry = pending.get(e.data.id);
            if (entry) entry.spending = true;
            return;
        }
        // The USER'S CELL is starting (runtime up, prelude done, this run's turn): its own 15s begins now.
        if (e.data?.started) {
            const entry = pending.get(e.data.id);
            if (entry?.armOnStart) {
                clearTimeout(entry.timer);
                entry.timer = killAfter(e.data.id, PY_TIMEOUT_MS, `Python run exceeded ${PY_TIMEOUT_MS / 1000}s and was terminated — simplify the computation or reduce the input size.`, "timeout");
            }
            return;
        }
        // THE `ml` WIRE CALL (ML_WIRE.md): the cell's request, stamped HERE with the client handle and the run
        // this document is executing for it. The worker never sees either — it posts `{ seq, call, args }` only.
        if (e.data?.mlCall && typeof e.data.id === "number") {
            const entry = pending.get(e.data.id);
            const wire = entry?.wire;
            const { seq, call, args } = e.data.mlCall as { seq: number; call: string; args: unknown[] };
            if (!wire) {
                w.postMessage({ id: e.data.id, mlAnswer: { seq, answer: { seq, error: { code: "Refused", message: "this cell has no ml wire" } } } });
                return;
            }
            chrome.runtime.sendMessage({ type: "ML_CALL", client: wire.client, run: wire.run, seq, call, args: args ?? [] })
                .then((answer: { seq?: number; ask?: unknown } | undefined) => {
                    // An `ask` first answer is NOT final: the cell suspends, and the later `ML_ANSWER` push
                    // (matched by client) is what resolves it. Hold here; do not post `mlAnswer` yet.
                    if (answer && typeof answer === "object" && "ask" in answer) return;
                    w.postMessage({ id: e.data.id, mlAnswer: { seq, answer: answer ?? { seq, error: { code: "Failed", message: "the wire returned no answer" } } } });
                })
                .catch((err: unknown) => {
                    w.postMessage({ id: e.data.id, mlAnswer: { seq, answer: { seq, error: { code: "Failed", message: String((err as Error)?.message || err) } } } });
                });
            return;
        }
        const { id, ...result } = e.data as { id: number } & PyResult;
        const entry = pending.get(id);
        // The first run after a pre-warm: did it find the runtime warm, and how long did it still wait?
        if (result.prewarm === "warm" || result.prewarm === "starting") reportHousekeeping({ subsystem: "pyodide", kind: "prewarm-used", ms: result.bootMs ?? 0, detail: { warm: result.prewarm === "warm" } });
        // ROOT C: keep the run's scope manifest (`bench.vars`, PERSISTENT_RUNTIME_SPEC.md) and open the result
        // with the loss line when this is the first cell after its namespace was wiped (docs/spec/PYTHON_DIALECT.md).
        if (entry?.wire?.run) {
            const runId = entry.wire.run;
            if (result.bench) {
                runNsVars.set(runId, { id: result.bench.id, vars: result.bench.vars });
                if (entry.principal) (runPrincipals.get(runId) ?? runPrincipals.set(runId, new Set()).get(runId)!).add(entry.principal);
            }
            const loss = nsLoss.get(runId);
            if (loss) {
                nsLoss.delete(runId);
                const line = `namespace reset at ${new Date(loss.at).toISOString()}: ${loss.reason === "idle" ? "idle (python_exec keep: true holds it through long waits)" : loss.reason}`;
                Object.assign(result, { stdout: result.stdout ? `${line}\n${result.stdout}` : line, nsReset: line });
            }
        }
        if (entry) { pending.delete(id); clearTimeout(entry.timer); entry.resolve(result); armReap(entry.principal); }
    };
    // A worker-level failure (load error, uncaught throw) would otherwise strand every pending run.
    w.onerror = (ev: ErrorEvent) => { if (workers.get(principal)?.w === w) killWorker(principal, ev.message || "crashed"); };
    workers.set(principal, { w, readonly });
    return w;
}

/**
 * @param noTimeout Run WITHOUT the watchdog. Only the workbench asks for this, and only the background lets
 *   it through (see the PYTHON_EXEC handler): a page-invoked tool keeps the cap, because a run that never
 *   ends there wedges the single Pyodide instance for every later call with nobody watching. In the bench a
 *   person is sitting in front of it, chose this, and can close the panel.
 */
function runInWorker(code: string, image: string | null, hardened: boolean, tables: unknown, stream?: boolean, streamId?: string, env?: boolean, noTimeout?: boolean, complete?: { line: number; column: number; bench?: string }, bench?: { persist?: boolean; reset?: boolean }, transfer: ArrayBuffer[] = [], principal = hardened ? "own" : "full", wire?: WireStamp, inside = false, libraries?: { libraries?: unknown; library?: unknown }, bridges = false): Promise<PyResult> {
    // `hardened` is the mode (true = readonly, the locked-down sandbox); `principal` is WHOSE sandbox.
    // A readonly run gets one worker per principal so a patch one principal left cannot reach the next;
    // `full` is its own worker and is never locked.
    const w = ensureWorker(principal, hardened);
    const id = nextId++;
    return new Promise((resolve) => {
        // A COMPLETION NEVER ARMS THE WATCHDOG. The timer starts when a message is POSTED, not when it runs,
        // and a completion asked for while a long script is running waits behind it in the worker's queue —
        // so its timer would fire mid-run and KILL THE WORKER, taking the script you were running with it,
        // because you typed. The editor already gives up on a slow answer by itself, and a completion that
        // somehow hung is still cleared by the next run's own watchdog, which kills whatever is ahead of it.
        // A bench RESET is instant but may likewise queue behind a run, so the same reasoning keeps it unarmed.
        //
        // And the 15s is the SCRIPT's. It used to run from the post, so a cold start (and any queue ahead) was
        // charged to it: under load a first `time.sleep(4)` was killed with "simplify the computation", and a
        // run queued behind a 10s one could expire 5s into its own work. So the post arms only the generous
        // START bound, and the worker's `started` (the user's cell is about to run) swaps in the script's cap.
        const timer = noTimeout || complete || bench?.reset ? (0 as unknown as ReturnType<typeof setTimeout>)
            : killAfter(id, PY_START_TIMEOUT_MS, `The Python sandbox did not start within ${PY_START_TIMEOUT_MS / 1000}s and was terminated.`, "start-timeout");
        pending.set(id, { resolve, timer, streamId, armOnStart: !(noTimeout || complete || bench?.reset), principal, wire });   // streamId → the background can key live stdout chunks
        // The worker creates the run's dict BEFORE the cell runs, so the principal is recorded at the post, not only from
        // a returned manifest: a cell that throws or is killed still leaves a dict the delete must reach.
        if (wire?.run) (runPrincipals.get(wire.run) ?? runPrincipals.set(wire.run, new Set()).get(wire.run)!).add(principal);
        // THE `ml` WIRE: the handle stays HERE. The worker is told only that this run has a wire and which
        // run's namespace it is — never `client` (LANE_1_PR2_DESIGN.md, "Who stamps the handle").
        if ((inside && Array.isArray(libraries?.libraries) && libraries.libraries.length) || libraries?.library) libraryPrincipals.add(principal);
        if (wire) wireByClient.set(wire.client, { post: (m) => { try { w.postMessage(m); } catch { /* worker gone */ } }, runMsgId: id });
        w.postMessage({ id, code, image, hardened, tables, stream, ...(wire ? { wire: true, run: wire.run } : {}), ...(env ? { env: true } : {}), ...(complete ? { complete } : {}), ...(bench?.persist ? { persist: true } : {}), ...(bench?.reset ? { benchReset: true } : {}), ...(inside ? { inside: true } : {}),
            // The person's approved tier 3 libraries ride an inside run; a library op (its card's shape, its load after
            // approval) is its own message. Only the service worker sends either (PY_RUN is not in HANDLE_MAP).
            ...(inside && Array.isArray(libraries?.libraries) ? { libraries: libraries.libraries } : {}),
            // The JavaScript-bridge lift for this one cell (bridge-names.ts); readonly only, a full worker has no refusal.
            ...(bridges && hardened && !inside ? { bridges: true } : {}),
            ...(libraries?.library ? { library: libraries.library } : {}) }, transfer);
    });
}

// ---- The session archive's worker (archive-worker.ts) ----
// Started on the first ARCHIVE_OP and kept: it holds the archive's one SQLite connection. Its replies are matched by
// id, and it answers in order, so this only relays.
let archiveWorker: Worker | null = null;
let archiveSeq = 0;
const archivePending = new Map<number, (r: { ok: boolean; result?: unknown; error?: string }) => void>();

function ensureArchiveWorker(): Worker {
    if (archiveWorker) return archiveWorker;
    const w = new Worker(chrome.runtime.getURL("archive-worker.js"));
    w.onmessage = (e: MessageEvent) => {
        const { id, ...reply } = e.data ?? {};
        // No worker can pick a folder, so the archive worker says "none" where this browser could never pick one
        // (Brave with its flag off). This document is a page and can tell.
        const r = reply.result as { state?: string } | undefined;
        if (r?.state === "none" && typeof (globalThis as { showDirectoryPicker?: unknown }).showDirectoryPicker !== "function") r.state = "unsupported";
        archivePending.get(id)?.(reply);
        archivePending.delete(id);
    };
    w.onerror = (e) => {
        // A worker that died answers nobody: fail what waits, and start a fresh one next time.
        for (const done of archivePending.values()) done({ ok: false, error: `archive worker stopped: ${e.message || "error"}` });
        archivePending.clear();
        archiveWorker = null;
    };
    archiveWorker = w;
    return w;
}

// ---- The image worker (image-worker.ts): saved screenshots re-encoded as lossless WebP ----
// Started on the first IMAGE_COMPACT and stopped once idle: libwebp's memory is worth nothing between batches.
let imageWorker: Worker | null = null;   // state: plumbing
let imageSeq = 0;   // state: plumbing
const imagePending = new Map<number, (r: { url: string | null; error?: string }) => void>();   // state: plumbing
let imageIdle: ReturnType<typeof setTimeout> | null = null;   // state: plumbing
/** How long the image worker is kept after its last answer. */
const IMAGE_IDLE_MS = 60_000;

function ensureImageWorker(): Worker {
    if (imageIdle) { clearTimeout(imageIdle); imageIdle = null; }
    if (imageWorker) return imageWorker;
    const w = new Worker(chrome.runtime.getURL("image-worker.js"));
    w.onmessage = (e: MessageEvent) => {
        const { id, ...reply } = e.data ?? {};
        imagePending.get(id)?.(reply);
        imagePending.delete(id);
        if (!imagePending.size && imageWorker === w) imageIdle = setTimeout(() => { if (imagePending.size) return; w.terminate(); imageWorker = null; imageIdle = null; }, IMAGE_IDLE_MS);
    };
    w.onerror = (e) => {
        for (const done of imagePending.values()) done({ url: null, error: `image worker stopped: ${e.message || "error"}` });
        imagePending.clear();
        imageWorker = null;
    };
    imageWorker = w;
    return w;
}

chrome.runtime.onMessage.addListener((msg: any, sender, sendResponse) => {
    // Only the service worker asks (sw-image-compact.ts), and only ever about a PNG data URL: the worker FETCHES the
    // URL to decode it, so anything else would make it a fetcher.
    if (msg?.type === "IMAGE_COMPACT" && !sender.tab && typeof msg.url === "string" && PNG_DATA_URL.test(msg.url)) {
        const id = ++imageSeq;
        imagePending.set(id, sendResponse);
        ensureImageWorker().postMessage({ id, url: msg.url });
        return true;
    }
    return undefined;
});

chrome.runtime.onMessage.addListener((msg: any, _sender, sendResponse) => {
    if (msg?.type === "ARCHIVE_OP") {
        const id = ++archiveSeq;
        archivePending.set(id, sendResponse);
        ensureArchiveWorker().postMessage({ id, op: msg.op, args: msg.args });
        return true;
    }
    return undefined;
});

chrome.runtime.onMessage.addListener((msg: any, sender, sendResponse) => {
    // Start the runtime ahead of a run that is likely to need it (see the background's PYTHON_PREWARM). No
    // watchdog: nothing waits on it, and a run that later waits on a start that hangs arms its own. Prewarm
    // carries the same principal + mode as the run it is warming for, so it warms THAT principal's worker.
    if (msg?.type === "PY_PREWARM") {
        const principal = String(msg.principal ?? "own");
        const w = ensureWorker(principal, msg.hardened !== false);
        const id = nextId++;
        pending.set(id, { resolve: (r) => sendResponse({ ok: r.ok, prewarm: r.prewarm }), timer: 0 as unknown as ReturnType<typeof setTimeout>, principal });
        w.postMessage({ id, prewarm: true });
        return true;
    }
    if (msg?.type !== "PY_RUN") return;
    // The bench's "reset both modes" spans every principal's worker now: one Worker per principal means
    // the kept readonly namespace and the kept full namespace live in different realms. Broadcast the
    // reset to every worker, then let the normal path answer on the primary. Each worker's `benchReset`
    // clears its own kept namespace (or no-ops if it has none).
    if (msg.benchReset) {
        const primaryPrincipal = String(msg.principal ?? (msg.hardened !== false ? "own" : "full"));
        for (const [p, entry] of workers) {
            if (p === primaryPrincipal) continue;
            try { entry.w.postMessage({ id: nextId++, code: "", image: null, hardened: entry.readonly, tables: null, benchReset: true }); } catch { /* a dead worker is killed on its next use */ }
        }
    }
    // The worker serializes runs internally (one Pyodide instance per worker = one per principal),
    // so we can forward straight through — no need to chain here.
    // THE `ml` WIRE: `msg.wire` is `{ client, run }` from the service worker. It is kept HERE and stamped
    // on each `ML_CALL`; the worker is told only `wire: true` + the run id (LANE_1_PR2_DESIGN.md).
    const wireStamp: WireStamp | undefined = msg.wire && typeof msg.wire.client === "string"
        ? { client: String(msg.wire.client), run: msg.wire.run ?? null }
        : undefined;
    // A KEEP (py-reap.ts) is a live turn's, on its own worker: only a cell of a worker-hosted run carries one.
    if (msg.keep === true && wireStamp?.run && msg.principal === `run:${wireStamp.run}`) keptPrincipals.add(msg.principal);
    withStoredTables(msg.tables ?? null)
        .then((t) => "error" in t
            ? { ok: false, stdout: "", error: t.error }
            : runInWorker(msg.code, msg.image ?? null, msg.hardened !== false, t.tables, msg.stream, msg.streamId, msg.env, msg.noTimeout, msg.complete, { persist: msg.persist, reset: msg.benchReset }, t.transfer, String(msg.principal ?? (msg.hardened !== false ? "own" : "full")), wireStamp, msg.inside === true, { libraries: msg.libraries, library: msg.library },
                // Only the service worker may lift a cell's bridge refusal: a content script is an extension context too.
                msg.bridges === true && !sender.tab)
                .then((r) => storeReturnedTable(r, msg.valueBudget)))
        .then(sendResponse, e => sendResponse({ ok: false, stdout: "", error: String(e) }));
    return true;   // keep the channel open for the async result
});

// THE `ml` WIRE'S LATER ANSWER (ML_WIRE.md): a call that answered `ask` first is resolved here when the
// person decides. Matched by the client handle this document stamped; the worker is told only `seq` +
// the answer. Not in HANDLE_MAP — only the worker's `deliverLater` push reaches this listener.
chrome.runtime.onMessage.addListener((msg: any, _sender, sendResponse) => {
    if (msg?.type !== "ML_ANSWER" || typeof msg.client !== "string") return undefined;
    const entry = wireByClient.get(msg.client);
    if (!entry) return undefined;
    entry.post({ id: entry.runMsgId, mlAnswer: { seq: msg.answer?.seq, answer: msg.answer } });
    sendResponse({ ok: true });
    return undefined;
});

// ROOT C: drop a run's kept namespace when the run closes or is archived. The service worker sends this
// from the run-end path; it is forwarded as `deleteRun` to EVERY worker holding a dict for the run (`runPrincipals`):
// the run's own `run:<id>` and, for its full-mode cells, the shared `full` worker, where a dict left behind is readable
// from another full-mode run's cell. The principal the message names is asked too.
chrome.runtime.onMessage.addListener((msg: any, _sender, sendResponse) => {
    if (msg?.type !== "PY_DELETE_RUN" || typeof msg.run !== "string" || !msg.run) return undefined;
    const run = String(msg.run);
    const principals = new Set(runPrincipals.get(run) ?? []);
    principals.add(String(msg.principal ?? `run:${run}`));
    keptPrincipals.delete(`run:${run}`);   // the turn ended, and its keep with it (py-reap.ts)
    runPrincipals.delete(run);
    runNsVars.delete(run);
    nsLoss.delete(run);
    // A worker's answer can carry callables the run's last cell handed to JavaScript that fired after its result
    // (cell-gate.ts): only the run's own locked-down worker has the gate, so at most one answer does.
    const asks: Promise<PyResult["dropped"] | undefined>[] = [];
    for (const principal of principals) {
        const entry = workers.get(principal);
        if (!entry) continue;
        const id = nextId++;
        asks.push(new Promise((resolve) => {
            pending.set(id, { resolve: (r) => resolve(r?.dropped), timer: 0 as unknown as ReturnType<typeof setTimeout>, principal });
            try { entry.w.postMessage({ id, deleteRun: run }); }
            catch { pending.delete(id); resolve(undefined); }
        }));
    }
    if (!asks.length) { sendResponse({ ok: true }); return undefined; }
    void Promise.all(asks).then((answers) => {
        const dropped = answers.find((d) => d && d.count > 0);
        sendResponse({ ok: true, ...(dropped ? { dropped } : {}) });
    });
    return true;
});

// A tier 3 library was removed (READONLY_LIBRARY_MANIFEST.md, ruling D): restart every worker that was handed one, since
// a loaded module stays importable until its realm dies. Each such run's next cell opens with the loss line. Only the
// worker sends it.
chrome.runtime.onMessage.addListener((msg: any, sender, sendResponse) => {
    if (msg?.type !== "PY_DROP_LIBRARIES") return undefined;
    if (sender.id !== chrome.runtime.id || sender.tab) return undefined;
    const principals = [...libraryPrincipals];
    for (const principal of principals) killWorker(principal, "library-removed");
    sendResponse({ ok: true, restarted: principals.length });
    return undefined;
});

// HTML→Markdown for a fetch the WORKER made (sw-offscreen.ts `htmlToMarkdownOffscreen`): the converter needs a DOM. Only
// the worker asks: a message from a tab (a content script) is not answered.
chrome.runtime.onMessage.addListener((msg: any, sender, sendResponse) => {
    if (msg?.type !== "HTML_TO_MD") return undefined;
    if (sender.id !== chrome.runtime.id || sender.tab) return undefined;
    let markdown: string | undefined;
    try { markdown = htmlToMarkdown(String(msg.html ?? "")); } catch { /* answered as undefined: the caller keeps the text */ }
    sendResponse({ markdown });
    return undefined;
});

// ---- The PDF worker (pdf/pdf-worker.ts): a PDF read page by page, or one page drawn ----
// Started on the first request, one request at a time, terminated on a wall-clock cap and when idle (pdf/pdf-host.ts).
const pdfHost = createPdfHost({ spawn: () => new Worker(chrome.runtime.getURL("pdf-worker.js")) as never });   // state: plumbing

// PDF_READ and PDF_RENDER: only the service worker asks; a message from a tab (a content script) is not answered. The
// bytes cross as base64 (this channel is JSON) and go on to the worker transferred.
chrome.runtime.onMessage.addListener((msg: PdfMessage, sender, sendResponse) => {
    if (msg?.type !== "PDF_READ" && msg?.type !== "PDF_RENDER") return undefined;
    if (sender.id !== chrome.runtime.id || sender.tab) return undefined;
    const bytes = typeof msg.b64 === "string" ? b64ToBytes(msg.b64) : null;
    if (!bytes) { sendResponse({ ok: false, code: "unreadable", refusal: "The PDF's bytes did not arrive intact." }); return undefined; }
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    if (msg.type === "PDF_READ") {
        void pdfHost.call({ op: "read", bytes: buffer, pageCap: msg.pageCap, pageTextCap: msg.pageTextCap, budgetMs: msg.budgetMs })
            .then((r) => sendResponse(r as PdfReadReply));
    } else {
        void pdfHost.call({ op: "render", bytes: buffer, n: Number(msg.n), scale: Number(msg.scale) })
            .then((r): PdfRenderReply => { if (!r.ok || !("png" in r)) return r as PdfRenderReply; const { png, ...rest } = r; return { ...rest, pngB64: bytesToB64(png) }; })
            .then(sendResponse);
    }
    return true;
});
