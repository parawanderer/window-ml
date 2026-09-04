// The service-worker half of the Ollama event stream: ONE connection to `/api/events`, fanned out to
// every open resource panel over a Port.
//
// It lives here rather than in the panel for the same reason every other privileged fetch does — the
// worker holds the host permission and the API key, and the panel is not trusted with either. It is also
// what makes ONE connection serve an overlay and a DevTools panel at once, instead of a stream per surface.
//
// MV3 evicts an idle worker, and an evicted worker takes the connection with it. That is survivable
// rather than fatal BECAUSE the server retains a ring: a reconnect asks `?since=<the gap>` and the
// backfill closes it, so an eviction costs latency and not history. `sinceFor` is where that is decided.
import { getConfig, authHeaders, findOllamaBase } from "./sw-llm";
import { readFrames, sinceFor, loadedFrom, type ResourceFrame } from "./resource-events";

/** What a subscriber receives. `at` is the frame's own wall clock, resolved from this connection's hello,
 *  so nothing downstream ever sees a relative offset. `loaded` is filled for a `sample` frame — the panel
 *  gets exactly what the polled route hands it, from the same parser. */
export interface ResourceStreamMessage {
    frame?: ResourceFrame;
    at?: number;
    loaded?: ReturnType<typeof loadedFrom>;
    info?: unknown;
    /** The server does not serve this route (a stock Ollama, or an OpenWebUI with no passthrough answering
     *  with its SPA's HTML). The panel falls back to polling — never to an empty chart. */
    unsupported?: string;
    /** The connection dropped and is being retried. The panel keeps what it has and marks nothing new. */
    interrupted?: string;
}

const RETRY_MS = [1000, 2000, 5000, 10_000, 30_000];
/** The server's retained ring. A first connection asks for all of it: on a fresh open that is history the
 *  panel would otherwise spend ten minutes re-measuring. */
export const RING_MS = 600_000;

const subs = new Set<chrome.runtime.Port>();
let abort: AbortController | null = null;
let running = false;
let lastFrameAt: number | null = null;
let attempt = 0;
let retryTimer: ReturnType<typeof setTimeout> | null = null;

function fan(msg: ResourceStreamMessage): void {
    for (const p of subs) { try { p.postMessage(msg); } catch { /* a port that went away is dropped below */ } }
}

/** True when the body is this route rather than a 200 of something else. OpenWebUI answers an unknown
 *  route with its SPA's HTML at status 200, so the status alone cannot tell "not served" from "served" —
 *  the same trap `/api/info` has. */
function servesNdjson(res: Response): boolean {
    const ct = (res.headers.get("content-type") || "").toLowerCase();
    return res.ok && (ct.includes("ndjson") || ct.includes("jsonl") || ct.includes("event-stream"));
}

async function connect(): Promise<void> {
    const config = await getConfig();
    // The same base discovery `/api/ps` uses — `<origin>/ollama` first (OpenWebUI's passthrough), then the
    // origin. A patched Ollama behind a stock OpenWebUI cannot answer this one: unlike `/ollama/*` fetches
    // generally, this route had to be added to OpenWebUI explicitly, so the fallback matters.
    const { base } = await findOllamaBase(config);
    const since = sinceFor(lastFrameAt, Date.now(), RING_MS);
    abort = new AbortController();
    const res = await fetch(`${base}/api/events?since=${since}`, {
        headers: authHeaders(config), signal: abort.signal,
    });
    if (!servesNdjson(res)) {
        // Not an error to retry: this server does not have the route. Say so once and stop, so the panel
        // can fall back to polling instead of sitting behind a connection that will never carry anything.
        throw Object.assign(new Error(`This server does not serve /api/events (HTTP ${res.status}).`),
                            { unsupported: true });
    }
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let helloAt: number | null = null;
    attempt = 0;   // a connection that produced a readable stream resets the backoff
    for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        const { frames, rest } = readFrames(buffer, decoder.decode(value, { stream: true }));
        buffer = rest;
        for (const frame of frames) {
            // Every offset is relative to THIS connection's hello, so the anchor is the instant it arrived.
            // A stream whose first frame is not a hello still works — the first frame we see is the anchor —
            // which matters because a reconnect can land mid-ring.
            if (helloAt == null) helloAt = Date.now() - Math.min(0, frame.t);
            const at = helloAt + frame.t;
            // Only advance the high-water mark on frames that HAPPENED at that time. A backfilled frame is
            // older than the connection, so letting it move the mark would shrink the next reconnect's
            // window to cover history we already hold and leave the actual gap unasked for.
            if (frame.t >= 0) lastFrameAt = Math.max(lastFrameAt ?? 0, at);
            fan({
                frame, at,
                ...(frame.kind === "sample" ? {
                    loaded: loadedFrom((frame.ps?.models as unknown[]) || []),
                    info: frame.info ?? null,
                } : {}),
            });
        }
    }
}

/** Keep one connection up for as long as anything is listening. A drop is retried with backoff; a server
 *  that does not serve the route is reported once and not retried, because retrying it forever would be a
 *  panel that never falls back to the transport that does work. */
async function pump(): Promise<void> {
    if (running) return;
    running = true;
    while (subs.size) {
        try {
            await connect();
            // A clean end of stream is still an end: the server restarted, or a proxy closed an idle
            // connection. Reconnect, and let the ring fill the gap.
            if (subs.size) fan({ interrupted: "stream ended" });
        } catch (e: any) {
            if (e?.name === "AbortError") break;              // we closed it on purpose
            if (e?.unsupported) { fan({ unsupported: String(e.message) }); break; }
            if (subs.size) fan({ interrupted: String(e?.message || e) });
        }
        if (!subs.size) break;
        const wait = RETRY_MS[Math.min(attempt++, RETRY_MS.length - 1)];
        await new Promise<void>((r) => { retryTimer = setTimeout(r, wait); });
    }
    running = false;
    abort = null;
}

/** Attach a panel. The first subscriber opens the connection; the last one to leave closes it, because a
 *  worker holding a stream open for a panel nobody has open is the background polling this design exists
 *  to avoid. */
export function subscribeResourceEvents(port: chrome.runtime.Port): void {
    subs.add(port);
    port.onDisconnect.addListener(() => {
        subs.delete(port);
        if (!subs.size) {
            abort?.abort();
            if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
        }
    });
    void pump();
}

/** Test seam: forget the connection state between cases. */
export function _resetResourceEvents(): void {
    abort?.abort();
    if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
    subs.clear(); abort = null; running = false; lastFrameAt = null; attempt = 0;
}
