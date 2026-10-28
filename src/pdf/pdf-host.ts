// pdf-host.ts — the offscreen document's side of the PDF worker: start it on demand, run one request at a time, kill it on the clock.
//
// A PDF that makes pdf.js loop inside one operator cannot be interrupted from inside, so the host holds the wall-clock
// cap: past `timeoutMs` the worker is terminated, the request in flight is refused with a sentence, and the next
// request starts a fresh worker. Requests are serialised, so a slow one never kills an innocent one beside it. An idle
// worker is stopped after `idleMs`: pdf.js's memory is worth nothing between files.
import type { Refusal } from "./pdf-read";
import type { PdfCall, PdfWorkerReply } from "./pdf-wire";

/** The hard cap on one request, in ms: past the reader's own 20 s budget (pdf-read.ts), so only a page that never ends reaches it. */
export const PDF_TIMEOUT_MS = 45_000;
/** How long the worker is kept after its last answer. */
export const PDF_IDLE_MS = 60_000;

/** The slice of `Worker` the host uses; tests pass a fake. */
export interface WorkerLike {
    postMessage(m: unknown, transfer?: Transferable[]): void;
    terminate(): void;
    onmessage: ((e: { data: PdfWorkerReply }) => void) | null;
    onerror: ((e: { message?: string }) => void) | null;
}

/** What `createPdfHost` needs: a worker factory, and the two clocks (defaults `PDF_TIMEOUT_MS` and `PDF_IDLE_MS`). */
export interface PdfHostOptions { spawn: () => WorkerLike; timeoutMs?: number; idleMs?: number }

/** The sentence when the clock ends a request. */
const TIMED_OUT = (ms: number): Refusal => ({ ok: false, code: "timeout", refusal: `Reading this PDF took longer than ${Math.round(ms / 1000)} seconds, so it was stopped.` });

/** A host over a worker factory. `call` resolves with the worker's result, or a refusal if it timed out or died. */
export function createPdfHost(opts: PdfHostOptions) {
    const timeoutMs = opts.timeoutMs ?? PDF_TIMEOUT_MS, idleMs = opts.idleMs ?? PDF_IDLE_MS;
    let worker: WorkerLike | null = null;   // state: plumbing, the live worker, if any
    let nextId = 1;   // state: plumbing
    let chain: Promise<unknown> = Promise.resolve();   // state: plumbing, requests run in order
    let idle: ReturnType<typeof setTimeout> | null = null;   // state: plumbing
    let current: ((r: PdfWorkerReply["result"]) => void) | null = null;   // state: plumbing, the request in flight

    const stop = () => { if (idle) { clearTimeout(idle); idle = null; } try { worker?.terminate(); } catch { /* already gone */ } worker = null; };

    const run = (req: PdfCall): Promise<PdfWorkerReply["result"]> => new Promise((resolve) => {
        if (idle) { clearTimeout(idle); idle = null; }
        const id = nextId++;
        let done = false;
        const finish = (r: PdfWorkerReply["result"]) => {
            if (done) return;
            done = true; clearTimeout(timer); current = null;
            if (worker) idle = setTimeout(stop, idleMs);
            resolve(r);
        };
        const timer = setTimeout(() => { stop(); finish(TIMED_OUT(timeoutMs)); }, timeoutMs);
        current = finish;
        try {
            if (!worker) {
                const w = opts.spawn();
                w.onmessage = (e) => { if (e.data?.id === id) finish(e.data.result); };
                w.onerror = (e) => { stop(); finish({ ok: false, code: "unreadable", refusal: "The PDF reader stopped unexpectedly.", detail: String(e?.message ?? "").slice(0, 200) }); };
                worker = w;
            } else worker.onmessage = (e) => { if (e.data?.id === id) finish(e.data.result); };
            worker.postMessage({ ...req, id }, [req.bytes]);
        } catch (e) { stop(); finish({ ok: false, code: "unreadable", refusal: "The PDF reader could not be started.", detail: String((e as Error)?.message ?? e).slice(0, 200) }); }
    });

    return {
        /** Run one request after those ahead of it. */
        call(req: PdfCall): Promise<PdfWorkerReply["result"]> {
            const next = chain.then(() => run(req), () => run(req));
            chain = next;
            return next;
        },
        /** Stop the worker now (the document is closing). */
        stop,
        /** Whether a worker is alive, for tests. */
        get alive() { return !!worker; },
        /** Whether a request is in flight, for tests. */
        get busy() { return !!current; },
    };
}
