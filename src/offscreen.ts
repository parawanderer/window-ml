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

import { ValueStore } from "./value-store";

// The value store, reached here rather than in the worker: stored bytes are TRANSFERRED to the worker (no copy), and the
// one copy is the worker's, into Pyodide's memory. A returned frame's IPC comes back the same way and is written here,
// under the budget the service worker sent with the run (this document cannot read the settings).
let values: ValueStore | null = null;
let writeBudget = 0;
const store = (): ValueStore => values ??= new ValueStore({
    budgetBytes: () => writeBudget,
    onEvict: (e) => reportHousekeeping({ subsystem: "value-store", kind: "evict", reason: e.reason, key: e.key, bytes: e.bytes, ...(e.source ? { detail: { source: e.source } } : {}) }),
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
type PyResult = { prewarm?: "started" | "already" | "warm" | "starting"; ok: boolean; env?: PyEnv; completions?: { name: string; type: string; complete: string }[]; bench?: { id: string; vars: { name: string; type: string }[] }; value?: unknown; stdout: string; error?: string; table?: { columns: string[]; rows: (string | number | null)[][] }; render?: "latex" | "img"; bootMs?: number; runMs?: number };

// The worker is same-origin (extension page → chrome-extension:// worker), so it needs no
// web_accessible_resources entry; it inherits this page's 'wasm-unsafe-eval' CSP.
let worker: Worker | null = null;
let nextId = 1;
const pending = new Map<number, { resolve: (r: PyResult) => void; timer: ReturnType<typeof setTimeout>; streamId?: string; armOnStart?: boolean }>();

/** Arm a kill for run `id`: when it fires, that run fails with `error` and the (still-busy) worker is terminated,
 *  failing anything queued behind it. */
function killAfter(id: number, ms: number, error: string, reason: "timeout" | "start-timeout"): ReturnType<typeof setTimeout> {
    return setTimeout(() => {
        const entry = pending.get(id);
        if (!entry) return;   // already resolved
        pending.delete(id);
        entry.resolve({ ok: false, stdout: "", error });
        killWorker(reason);   // nuke the (still-busy) instance + fail any others queued behind it
    }, ms);
}

/** Tells the worker's housekeeping log what this document decided (docs/dev/housekeeping.md). The worker stamps
 *  it `offscreen` from the sender. Fire-and-forget: a log is never worth failing a run over. */
function reportHousekeeping(report: { subsystem: string; kind: string; reason?: string; key?: string; bytes?: number; ms?: number; detail?: Record<string, string | number | boolean> }): void {
    try { chrome.runtime.sendMessage({ type: "HOUSEKEEPING_REPORT", payload: report }).catch(() => { /* no worker listening */ }); } catch { /* context gone */ }
}

// Terminate the worker and fail every still-pending run with `reason`. Used on a worker crash and
// on a timeout kill (after the timed-out run itself has been resolved + removed from `pending`).
function killWorker(reason: string): void {
    if (worker) {
        try { worker.terminate(); } catch { /* already gone */ }
        worker = null;
        // A timeout names itself; anything else is the worker's own error message, kept as detail under "crashed".
        const named = reason === "timeout" || reason === "start-timeout";
        reportHousekeeping({ subsystem: "pyodide", kind: "kill", reason: named ? reason : "crashed", detail: { queuedRuns: pending.size, ...(named ? {} : { message: reason }) } });
    }
    for (const { resolve, timer } of pending.values()) { clearTimeout(timer); resolve({ ok: false, stdout: "", error: `Python worker stopped (${reason}).` }); }
    pending.clear();
}

function ensureWorker(): Worker {
    if (worker) return worker;
    const w = new Worker(chrome.runtime.getURL("python-worker.js"));
    w.onmessage = (e: MessageEvent) => {
        // The runtime finished starting (not a reply to anything): what started it and how long it took.
        if (e.data?.booted) {
            reportHousekeeping({ subsystem: "pyodide", kind: "cold-start", reason: e.data.by === "prewarm" ? "prewarm" : "run", ms: e.data.ms });
            return;
        }
        // A `partial` message is a LIVE stdout chunk (opt-in streaming) — forward it to the background keyed by
        // this run's streamId (the page requestId), which relays it to the page; DON'T resolve the run.
        if (e.data?.partial) {
            const entry = pending.get(e.data.id);
            if (entry?.streamId) chrome.runtime.sendMessage({ type: "PY_STDOUT", streamId: entry.streamId, chunk: String(e.data.chunk ?? ""), ts: e.data.ts }).catch(() => { /* no receiver → drop */ });
            return;
        }
        // The script is starting (the runtime is up and it is this run's turn): its own 15s begins now.
        if (e.data?.started) {
            const entry = pending.get(e.data.id);
            if (entry?.armOnStart) {
                clearTimeout(entry.timer);
                entry.timer = killAfter(e.data.id, PY_TIMEOUT_MS, `Python run exceeded ${PY_TIMEOUT_MS / 1000}s and was terminated — simplify the computation or reduce the input size.`, "timeout");
            }
            return;
        }
        const { id, ...result } = e.data as { id: number } & PyResult;
        const entry = pending.get(id);
        // The first run after a pre-warm: did it find the runtime warm, and how long did it still wait?
        if (result.prewarm === "warm" || result.prewarm === "starting") reportHousekeeping({ subsystem: "pyodide", kind: "prewarm-used", ms: result.bootMs ?? 0, detail: { warm: result.prewarm === "warm" } });
        if (entry) { pending.delete(id); clearTimeout(entry.timer); entry.resolve(result); }
    };
    // A worker-level failure (load error, uncaught throw) would otherwise strand every pending run.
    w.onerror = (ev: ErrorEvent) => { if (worker === w) killWorker(ev.message || "crashed"); };
    worker = w;
    return w;
}

/**
 * @param noTimeout Run WITHOUT the watchdog. Only the workbench asks for this, and only the background lets
 *   it through (see the PYTHON_EXEC handler): a page-invoked tool keeps the cap, because a run that never
 *   ends there wedges the single Pyodide instance for every later call with nobody watching. In the bench a
 *   person is sitting in front of it, chose this, and can close the panel.
 */
function runInWorker(code: string, image: string | null, hardened: boolean, tables: unknown, stream?: boolean, streamId?: string, env?: boolean, noTimeout?: boolean, complete?: { line: number; column: number; bench?: string }, bench?: { persist?: boolean; reset?: boolean }, transfer: ArrayBuffer[] = []): Promise<PyResult> {
    const w = ensureWorker();
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
        // START bound, and the worker's `started` (runtime up, script about to run) swaps in the script's cap.
        const timer = noTimeout || complete || bench?.reset ? (0 as unknown as ReturnType<typeof setTimeout>)
            : killAfter(id, PY_START_TIMEOUT_MS, `The Python sandbox did not start within ${PY_START_TIMEOUT_MS / 1000}s and was terminated.`, "start-timeout");
        pending.set(id, { resolve, timer, streamId, armOnStart: !(noTimeout || complete || bench?.reset) });   // streamId → the background can key live stdout chunks
        w.postMessage({ id, code, image, hardened, tables, stream, ...(env ? { env: true } : {}), ...(complete ? { complete } : {}), ...(bench?.persist ? { persist: true } : {}), ...(bench?.reset ? { benchReset: true } : {}) }, transfer);
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

chrome.runtime.onMessage.addListener((msg: any, _sender, sendResponse) => {
    if (msg?.type === "ARCHIVE_OP") {
        const id = ++archiveSeq;
        archivePending.set(id, sendResponse);
        ensureArchiveWorker().postMessage({ id, op: msg.op, args: msg.args });
        return true;
    }
    return undefined;
});

chrome.runtime.onMessage.addListener((msg: any, _sender, sendResponse) => {
    // Start the runtime ahead of a run that is likely to need it (see the background's PYTHON_PREWARM). No
    // watchdog: nothing waits on it, and a run that later waits on a start that hangs arms its own.
    if (msg?.type === "PY_PREWARM") {
        const w = ensureWorker();
        const id = nextId++;
        pending.set(id, { resolve: (r) => sendResponse({ ok: r.ok, prewarm: r.prewarm }), timer: 0 as unknown as ReturnType<typeof setTimeout> });
        w.postMessage({ id, prewarm: true });
        return true;
    }
    if (msg?.type !== "PY_RUN") return;
    // The worker serializes runs internally (single Pyodide instance + harden/unharden swap),
    // so we can forward straight through — no need to chain here.
    withStoredTables(msg.tables ?? null)
        .then((t) => "error" in t
            ? { ok: false, stdout: "", error: t.error }
            : runInWorker(msg.code, msg.image ?? null, msg.hardened !== false, t.tables, msg.stream, msg.streamId, msg.env, msg.noTimeout, msg.complete, { persist: msg.persist, reset: msg.benchReset }, t.transfer)
                .then((r) => storeReturnedTable(r, msg.valueBudget)))
        .then(sendResponse, e => sendResponse({ ok: false, stdout: "", error: String(e) }));
    return true;   // keep the channel open for the async result
});
