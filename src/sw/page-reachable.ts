// page-reachable.ts — a delegated tool that gets no answer AT ALL, and what to do about it.
//
// A background-hosted run delegates every page tool by `chrome.tabs.sendMessage`, and that call has exactly two
// documented outcomes: an answer, or a rejection when there is no receiver. It has a third in practice, and it is
// the one that hurts. A tab the browser has put to sleep in the background still HAS a receiver — the content
// script is registered, the renderer is simply not running it — so the send neither answers nor rejects. It sits.
// Measured on a real run: a `pageInfo` call, normally single-digit milliseconds, took 13 minutes 57 seconds, and
// what ended it was the person opening the tab. Nothing anywhere said why, because from the loop's point of view
// nothing had gone wrong yet.
//
// So the wait is watched rather than merely bounded. While a delegated call is outstanding we ask the browser
// about the tab; a tab reported `discarded` is one whose document is gone and will not come back until something
// touches it, and that is a fact we can act on immediately instead of sitting out a timeout. The cap behind it is
// a backstop for the cases the browser does not label — a frozen tab reports nothing unusual — and it is
// deliberately generous, because a legitimate `look` on this repo's own runs has taken 56 seconds and a tool that
// is merely slow must never be killed for it.
//
// Pure (no chrome, no timers of its own beyond an injectable one) so it unit-tests against a scripted sequence.

/** How long a delegated call may go unanswered before we stop waiting. Generous on purpose: the slowest honest
 *  page tool here is a `look`, which pays for a screenshot plus a vision model's reply. */
export const PAGE_SILENCE_CAP_MS = 240_000;
/** How often we ask the browser about the tab while a call is outstanding. */
export const TAB_PROBE_MS = 4_000;

/** What the browser says about the tab a delegated call is waiting on. `asleep` is a tab Chrome discarded: still
 *  on the strip, no document behind it. `gone` is one `chrome.tabs.get` no longer knows at all. */
export type TabState = "awake" | "asleep" | "gone";

/** How patiently to watch a delegated call: the backstop before a silent page is given up on, how often the tab
 *  is asked about while we wait, and an injectable sleep so a test can run a four-minute cap in microseconds. */
export interface WatchOpts {
    capMs?: number;
    probeMs?: number;
    /** injectable for tests; defaults to the host's setTimeout */
    sleep?: (ms: number) => Promise<void>;
}

/** Raised instead of letting a delegated call hang. The loop turns it into the tool's result, so the model is
 *  told the page stopped answering rather than the run stopping dead. */
export class PageUnreachable extends Error {
    readonly state: TabState | "silent";
    readonly waitedMs: number;
    constructor(state: TabState | "silent", waitedMs: number) {
        super(reachabilityNote(state, waitedMs));
        this.name = "PageUnreachable";
        this.state = state;
        this.waitedMs = waitedMs;
    }
}

/** The one sentence that reaches both the model and the person reading the step. Terse, because the model pays
 *  for every word of it, and specific, because "could not reach the page" is what we said before and it sent
 *  people looking for a crash that had not happened. */
export function reachabilityNote(state: TabState | "silent", waitedMs: number): string {
    const s = Math.round(waitedMs / 1000);
    if (state === "gone") return "the tab this run is on was closed";
    if (state === "asleep") return "the browser discarded this run's tab while it was in the background, and its page is gone";
    return `the page did not answer for ${s}s — its tab is most likely asleep in the background`;
}

/**
 * Wait for a delegated call, watching the tab it is waiting on. Resolves with the call's own answer. Rejects with
 * {@link PageUnreachable} as soon as the tab is reported discarded or closed, or once nothing has answered for
 * `capMs`. A send that answers normally pays one probe at most, and a short call pays none.
 *
 * @param send the in-flight `chrome.tabs.sendMessage`
 * @param probe asks the browser about the tab — called repeatedly while the send is outstanding
 */
export async function watchWhileWaiting<T>(send: Promise<T>, probe: () => Promise<TabState>, opts: WatchOpts = {}): Promise<T> {
    const capMs = opts.capMs ?? PAGE_SILENCE_CAP_MS;
    const probeMs = opts.probeMs ?? TAB_PROBE_MS;
    const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    let settled = false;
    // Whatever the send does, it wins: a tool that answered is never second-guessed by a probe that was already
    // in flight when it did.
    const answer = send.then((v) => { settled = true; return v; }, (e) => { settled = true; throw e; });
    const watch = (async (): Promise<never> => {
        for (let waited = 0; waited < capMs; waited += probeMs) {
            await sleep(Math.min(probeMs, capMs - waited));
            if (settled) await new Promise<never>(() => { /* the send won; never resolve this side of the race */ });
            const state = await probe().catch((): TabState => "gone");
            if (state !== "awake") throw new PageUnreachable(state, waited + probeMs);
        }
        throw new PageUnreachable("silent", capMs);
    })();
    return Promise.race([answer, watch]);
}
