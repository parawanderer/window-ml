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
// Two unhealthy pages are told apart before the cap (tests/e2e/page-health.spec.mjs). A CRASHED renderer reads
// `status: "unloaded"` without `discarded`, and fails at once. A page whose main thread SPINS reads awake, so the
// probe also asks the content script a question it answers synchronously (it shares the page's thread): a tab the
// browser says is NOT frozen that misses BUSY_STRIKES of those in a row is busy, not slow, since a slow tool waits
// asynchronously and leaves the thread free to answer. A frozen tab, or a browser that does not report `frozen`,
// is never pinged and keeps to the cap.
//
// Pure (no chrome, no timers of its own beyond an injectable one) so it unit-tests against a scripted sequence.

/** How long a delegated call may go unanswered before we stop waiting. Generous on purpose: the slowest honest
 *  page tool here is a `look`, which pays for a screenshot plus a vision model's reply. */
export const PAGE_SILENCE_CAP_MS = 240_000;
/** How often we ask the browser about the tab while a call is outstanding. */
export const TAB_PROBE_MS = 4_000;
/** How long the content script has to answer a liveness ping. It answers synchronously, so only a blocked main
 *  thread misses this. */
export const PING_TIMEOUT_MS = 2_000;
/** Missed pings in a row before an awake, unfrozen page is called busy: about 18 s of a thread that never yields. */
export const BUSY_STRIKES = 3;

/** What the browser says about the tab a delegated call is waiting on. `asleep` is a tab Chrome discarded: still
 *  on the strip, no document behind it. `gone` is one `chrome.tabs.get` no longer knows at all. `crashed` is a tab
 *  whose renderer died (`unloaded`, not discarded). `unresponsive` is an awake, unfrozen tab whose content script
 *  missed one liveness ping: a strike toward `busy`, never a verdict by itself. */
export type TabState = "awake" | "asleep" | "gone" | "crashed" | "unresponsive";

/** Why a delegated call was given up on: a verdict of the probe, `busy` after {@link BUSY_STRIKES} missed pings,
 *  `silent` at the cap, or `unadopted` (delegate-send.ts). */
export type PageUnreachableState = Exclude<TabState, "awake" | "unresponsive"> | "busy" | "silent" | "unadopted";

/** How patiently to watch a delegated call: the backstop before a silent page is given up on, how often the tab
 *  is asked about while we wait, and an injectable sleep so a test can run a four-minute cap in microseconds. */
export interface WatchOpts {
    capMs?: number;
    probeMs?: number;
    /** missed liveness pings in a row before the page is called busy (default {@link BUSY_STRIKES}) */
    busyStrikes?: number;
    /** injectable for tests; defaults to the host's setTimeout, unref'd (see {@link defaultSleep}) */
    sleep?: (ms: number) => Promise<void>;
}

/**
 * The host's timer, marked so it does not keep a Node process alive. The watch outlives its caller whenever the
 * caller stops waiting first: `ask()` races the send against the pageRead bound and abandons the race when the
 * bound fires, and `delegateSend`'s `send().catch(() => {})` swallows the late rejection without stopping the
 * loop. In a browser that is free (the SW is evicted on its own terms). In the test suite it was not: every
 * abandoned watch kept its 4s probe timer ref'd for the full four-minute cap, and the two files that leave a
 * page unanswered sat on the event loop for 225s AFTER their last test had passed (run-start 4.7s of tests,
 * 242s of wall clock). `unref` says the watch is no longer work the process is waiting on — it is the same
 * distinction the jsdom helpers make when they leave timeouts alone and compress intervals. A caller that is
 * still awaiting the watch keeps the process alive through its own `await` and the runner's pending test; the
 * timers still fire as long as anything else is holding the loop.
 */
function defaultSleep(ms: number): Promise<void> {
    return new Promise<void>((r) => {
        const t = setTimeout(r, ms) as unknown as { unref?: () => void };
        t.unref?.();
    });
}

/** Raised instead of letting a delegated call hang. The loop turns it into the tool's result, so the model is
 *  told the page stopped answering rather than the run stopping dead. */
export class PageUnreachable extends Error {
    readonly state: PageUnreachableState;
    readonly waitedMs: number;
    constructor(state: PageUnreachableState, waitedMs: number) {
        super(reachabilityNote(state, waitedMs));
        this.name = "PageUnreachable";
        this.state = state;
        this.waitedMs = waitedMs;
    }
}

/** The one sentence that reaches both the model and the person reading the step. Terse, because the model pays
 *  for every word of it, and specific, because "could not reach the page" is what we said before and it sent
 *  people looking for a crash that had not happened. */
export function reachabilityNote(state: PageUnreachableState, waitedMs: number): string {
    const s = Math.round(waitedMs / 1000);
    if (state === "crashed") return "the page in this run's tab crashed: its renderer died, so its tools cannot run there until the tab is reloaded";
    if (state === "busy") return `the page stopped responding: a script on it has kept its main thread busy for over ${s}s, so its tools cannot run until it recovers`;
    if (state === "unadopted") return `the page this run is on loaded but did not take the run back within ${s}s, so its tools cannot run there; navigate to another page`;
    if (state === "gone") return "the tab this run is on was closed";
    if (state === "asleep") return "the browser discarded this run's tab while it was in the background, and its page is gone";
    return `the page did not answer for ${s}s — its tab is most likely asleep in the background`;
}

/**
 * Wait for a delegated call, watching the tab it is waiting on. Resolves with the call's own answer. Rejects with
 * {@link PageUnreachable} as soon as the tab is reported discarded, closed or crashed, once it has missed
 * `busyStrikes` liveness pings in a row, or once nothing has answered for `capMs`. A send that answers normally pays
 * one probe at most, and a short call pays none.
 *
 * @param send the in-flight `chrome.tabs.sendMessage`
 * @param probe asks the browser about the tab — called repeatedly while the send is outstanding
 */
export async function watchWhileWaiting<T>(send: Promise<T>, probe: () => Promise<TabState>, opts: WatchOpts = {}): Promise<T> {
    const capMs = opts.capMs ?? PAGE_SILENCE_CAP_MS;
    const probeMs = opts.probeMs ?? TAB_PROBE_MS;
    const sleep = opts.sleep ?? defaultSleep;
    const busyStrikes = opts.busyStrikes ?? BUSY_STRIKES;
    let settled = false;
    // Whatever the send does, it wins: a tool that answered is never second-guessed by a probe that was already
    // in flight when it did.
    const answer = send.then((v) => { settled = true; return v; }, (e) => { settled = true; throw e; });
    const watch = (async (): Promise<never> => {
        let strikes = 0;
        for (let waited = 0; waited < capMs; waited += probeMs) {
            await sleep(Math.min(probeMs, capMs - waited));
            if (settled) await new Promise<never>(() => { /* the send won; never resolve this side of the race */ });
            const state = await probe().catch((): TabState => "gone");
            if (settled) await new Promise<never>(() => { /* answered while the probe was out: the answer stands */ });
            if (state === "unresponsive") {
                if (++strikes >= busyStrikes) throw new PageUnreachable("busy", waited + probeMs);
                continue;
            }
            strikes = 0;
            if (state !== "awake") throw new PageUnreachable(state, waited + probeMs);
        }
        throw new PageUnreachable("silent", capMs);
    })();
    return Promise.race([answer, watch]);
}
