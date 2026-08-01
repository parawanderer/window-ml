// Offscreen document for the `python_exec` tool. The service worker can't run WASM, so
// Pyodide (CPython→WASM) lives at this extension-origin page (whose CSP allows
// 'wasm-unsafe-eval'). But Pyodide itself now runs in a DEDICATED WORKER (python-worker.ts),
// NOT this page's main thread: this page shares a renderer process with the extension-origin
// sidebar iframe, so a compute-bound run on the main thread would freeze the sidebar's UI
// (clicks dead, scroll — on the compositor thread — still working). Off-main-thread keeps it
// responsive. This file is now just an id-matched relay: background PY_RUN ⇄ worker message.

// The worker is same-origin (extension page → chrome-extension:// worker), so it needs no
// web_accessible_resources entry; it inherits this page's 'wasm-unsafe-eval' CSP.
let worker: Worker | null = null;
let nextId = 1;
const pending = new Map<number, (r: { ok: boolean; value?: unknown; stdout: string; error?: string }) => void>();

function ensureWorker(): Worker {
    if (worker) return worker;
    const w = new Worker(chrome.runtime.getURL("python-worker.js"));
    w.onmessage = (e: MessageEvent) => {
        const { id, ...result } = e.data as { id: number; ok: boolean; value?: unknown; stdout: string; error?: string };
        const resolve = pending.get(id);
        if (resolve) { pending.delete(id); resolve(result); }
    };
    // A worker-level failure (load error, uncaught throw) would otherwise strand every pending
    // run. Fail them all with the error and drop the worker so the next call respawns it.
    w.onerror = (ev: ErrorEvent) => {
        const err = ev.message || "python worker crashed";
        for (const [, resolve] of pending) resolve({ ok: false, stdout: "", error: String(err) });
        pending.clear();
        if (worker === w) worker = null;
    };
    worker = w;
    return w;
}

function runInWorker(code: string, image: string | null, hardened: boolean, tables: unknown): Promise<{ ok: boolean; value?: unknown; stdout: string; error?: string }> {
    const w = ensureWorker();
    const id = nextId++;
    return new Promise((resolve) => {
        pending.set(id, resolve);
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
