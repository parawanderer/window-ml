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

// `bootMs`/`runMs` come from the WORKER, which is the executor — anything measured downstream of it is
// measuring the message bus as well. See python-worker.ts.
type PyEnv = { python: string; pyodide: string; packages: { name: string; version?: string }[] };
type PyResult = { ok: boolean; env?: PyEnv; completions?: { name: string; type: string; complete: string }[]; bench?: { id: string; vars: { name: string; type: string }[] }; value?: unknown; stdout: string; error?: string; table?: { columns: string[]; rows: (string | number | null)[][] }; render?: "latex" | "img"; bootMs?: number; runMs?: number };

// The worker is same-origin (extension page → chrome-extension:// worker), so it needs no
// web_accessible_resources entry; it inherits this page's 'wasm-unsafe-eval' CSP.
let worker: Worker | null = null;
let nextId = 1;
const pending = new Map<number, { resolve: (r: PyResult) => void; timer: ReturnType<typeof setTimeout>; streamId?: string }>();

// Terminate the worker and fail every still-pending run with `reason`. Used on a worker crash and
// on a timeout kill (after the timed-out run itself has been resolved + removed from `pending`).
function killWorker(reason: string): void {
    if (worker) { try { worker.terminate(); } catch { /* already gone */ } worker = null; }
    for (const { resolve, timer } of pending.values()) { clearTimeout(timer); resolve({ ok: false, stdout: "", error: `Python worker stopped (${reason}).` }); }
    pending.clear();
}

function ensureWorker(): Worker {
    if (worker) return worker;
    const w = new Worker(chrome.runtime.getURL("python-worker.js"));
    w.onmessage = (e: MessageEvent) => {
        // A `partial` message is a LIVE stdout chunk (opt-in streaming) — forward it to the background keyed by
        // this run's streamId (the page requestId), which relays it to the page; DON'T resolve the run.
        if (e.data?.partial) {
            const entry = pending.get(e.data.id);
            if (entry?.streamId) chrome.runtime.sendMessage({ type: "PY_STDOUT", streamId: entry.streamId, chunk: String(e.data.chunk ?? ""), ts: e.data.ts }).catch(() => { /* no receiver → drop */ });
            return;
        }
        const { id, ...result } = e.data as { id: number } & PyResult;
        const entry = pending.get(id);
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
function runInWorker(code: string, image: string | null, hardened: boolean, tables: unknown, stream?: boolean, streamId?: string, env?: boolean, noTimeout?: boolean, complete?: { line: number; column: number; bench?: string }, bench?: { persist?: boolean; reset?: boolean }): Promise<PyResult> {
    const w = ensureWorker();
    const id = nextId++;
    return new Promise((resolve) => {
        // A COMPLETION NEVER ARMS THE WATCHDOG. The timer starts when a message is POSTED, not when it runs,
        // and a completion asked for while a long script is running waits behind it in the worker's queue —
        // so its timer would fire mid-run and KILL THE WORKER, taking the script you were running with it,
        // because you typed. The editor already gives up on a slow answer by itself, and a completion that
        // somehow hung is still cleared by the next run's own watchdog, which kills whatever is ahead of it.
        // A bench RESET is instant but may likewise queue behind a run, so the same reasoning keeps it unarmed.
        const timer = noTimeout || complete || bench?.reset ? (0 as unknown as ReturnType<typeof setTimeout>) : setTimeout(() => {
            const entry = pending.get(id);
            if (!entry) return;   // already resolved
            pending.delete(id);
            entry.resolve({ ok: false, stdout: "", error: `Python run exceeded ${PY_TIMEOUT_MS / 1000}s and was terminated — simplify the computation or reduce the input size.` });
            killWorker("timeout");   // nuke the (still-busy) instance + fail any others queued behind it
        }, PY_TIMEOUT_MS);
        pending.set(id, { resolve, timer, streamId });   // streamId → the background can key live stdout chunks
        w.postMessage({ id, code, image, hardened, tables, stream, ...(env ? { env: true } : {}), ...(complete ? { complete } : {}), ...(bench?.persist ? { persist: true } : {}), ...(bench?.reset ? { benchReset: true } : {}) });
    });
}

chrome.runtime.onMessage.addListener((msg: any, _sender, sendResponse) => {
    if (msg?.type !== "PY_RUN") return;
    // The worker serializes runs internally (single Pyodide instance + harden/unharden swap),
    // so we can forward straight through — no need to chain here.
    runInWorker(msg.code, msg.image ?? null, msg.hardened !== false, msg.tables ?? null, msg.stream, msg.streamId, msg.env, msg.noTimeout, msg.complete, { persist: msg.persist, reset: msg.benchReset })
        .then(sendResponse, e => sendResponse({ ok: false, stdout: "", error: String(e) }));
    return true;   // keep the channel open for the async result
});
