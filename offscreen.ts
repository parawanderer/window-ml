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

type PyResult = { ok: boolean; value?: unknown; stdout: string; error?: string };

// The worker is same-origin (extension page → chrome-extension:// worker), so it needs no
// web_accessible_resources entry; it inherits this page's 'wasm-unsafe-eval' CSP.
let worker: Worker | null = null;
let nextId = 1;
const pending = new Map<number, { resolve: (r: PyResult) => void; timer: ReturnType<typeof setTimeout> }>();

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
        const { id, ...result } = e.data as { id: number } & PyResult;
        const entry = pending.get(id);
        if (entry) { pending.delete(id); clearTimeout(entry.timer); entry.resolve(result); }
    };
    // A worker-level failure (load error, uncaught throw) would otherwise strand every pending run.
    w.onerror = (ev: ErrorEvent) => { if (worker === w) killWorker(ev.message || "crashed"); };
    worker = w;
    return w;
}

function runInWorker(code: string, image: string | null, hardened: boolean, tables: unknown): Promise<PyResult> {
    const w = ensureWorker();
    const id = nextId++;
    return new Promise((resolve) => {
        const timer = setTimeout(() => {
            const entry = pending.get(id);
            if (!entry) return;   // already resolved
            pending.delete(id);
            entry.resolve({ ok: false, stdout: "", error: `Python run exceeded ${PY_TIMEOUT_MS / 1000}s and was terminated — simplify the computation or reduce the input size.` });
            killWorker("timeout");   // nuke the (still-busy) instance + fail any others queued behind it
        }, PY_TIMEOUT_MS);
        pending.set(id, { resolve, timer });
        w.postMessage({ id, code, image, hardened, tables });
    });
}

chrome.runtime.onMessage.addListener((msg: any, _sender, sendResponse) => {
    if (msg?.type !== "PY_RUN") return;
    // The worker serializes runs internally (single Pyodide instance + harden/unharden swap),
    // so we can forward straight through — no need to chain here.
    runInWorker(msg.code, msg.image ?? null, msg.hardened !== false, msg.tables ?? null)
        .then(sendResponse, e => sendResponse({ ok: false, stdout: "", error: String(e) }));
    return true;   // keep the channel open for the async result
});
