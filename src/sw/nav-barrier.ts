// nav-barrier.ts — background-side navigation barrier for cross-page agent runs.
//
// A background-hosted ml.agent run (design A) delegates each DOM tool to the page's content script by
// tabId. When the page NAVIGATES (a link click, a form submit, an explicit navigate()), the old document —
// and the toolset it registered — is destroyed, and the new document loads a FRESH, EMPTY toolset. Firing
// the next delegated tool into that gap hits "no active agent run on this page". This barrier tracks, per
// tab, whether a navigation is in flight, so the delegation choke point can WAIT for the new page to
// re-adopt the run (rebuild + register its toolset) before proceeding.
//
// The release signal is deliberately RE-ADOPT-COMPLETE, not mere "content loaded": the new content script
// loads with an empty toolset, so releasing on load alone would still race the tool into a page that can't
// run it. `whenReady` resolves on `noteReadopted`, with a timeout fallback so a navigation that never
// completes (or a page the run can't re-adopt) can't hang the loop forever — it falls through and the
// caller gets the normal "no active run" error to handle.
//
// Pure/deterministic (no chrome, no timers of its own beyond an injectable one) so it unit-tests
// standalone against a scripted sequence of navigation events; see tests/nav-barrier.test.mjs.

/** How long `whenReady` waits for a re-adopt before giving up and letting the caller proceed (and fail
 *  normally). Long enough for a real full-page load + content-script boot, short enough not to wedge. */
export const READOPT_TIMEOUT_MS = 15000;

interface TabNav {
    navigating: boolean;
    waiters: Array<() => void>;   // resolvers of in-flight whenReady() promises
}

export interface NavBarrier {
    /** A main-frame navigation committed on this tab — the current document (and its toolset) is going away. */
    noteNavigating(tabId: number): void;
    /** The new document re-adopted the run (rebuilt + registered its toolset) — safe to delegate again. */
    noteReadopted(tabId: number): void;
    /** True while a navigation is in flight on this tab (for callers that want to branch, not wait). */
    isNavigating(tabId: number): boolean;
    /** Resolve immediately if the tab is idle, else when it re-adopts (or after `timeoutMs`, whichever first). */
    whenReady(tabId: number, timeoutMs?: number): Promise<void>;
    /** Drop all state for a tab — the run ended, or the tab closed. Pending waiters are released. */
    forget(tabId: number): void;
}

/** Build a barrier. `setTimer`/`clearTimer` are injectable so tests can drive the timeout deterministically;
 *  they default to the host's setTimeout/clearTimeout. */
export function createNavBarrier(
    setTimer: (fn: () => void, ms: number) => unknown = (fn, ms) => setTimeout(fn, ms),
    clearTimer: (h: unknown) => void = (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
): NavBarrier {
    const tabs = new Map<number, TabNav>();
    const get = (tabId: number): TabNav => {
        let t = tabs.get(tabId);
        if (!t) { t = { navigating: false, waiters: [] }; tabs.set(tabId, t); }
        return t;
    };
    const release = (t: TabNav): void => { const w = t.waiters; t.waiters = []; for (const fn of w) fn(); };

    return {
        noteNavigating(tabId) { get(tabId).navigating = true; },
        noteReadopted(tabId) {
            const t = tabs.get(tabId);
            if (!t) return;
            t.navigating = false;
            release(t);   // let any tool that was waiting for the new page proceed
        },
        isNavigating(tabId) { return !!tabs.get(tabId)?.navigating; },
        whenReady(tabId, timeoutMs = READOPT_TIMEOUT_MS) {
            const t = get(tabId);
            if (!t.navigating) return Promise.resolve();
            return new Promise<void>((resolve) => {
                let done = false;
                const finish = () => { if (done) return; done = true; clearTimer(timer); resolve(); };
                const timer = setTimer(finish, timeoutMs);   // fallback: never wedge the loop on a dead nav
                t.waiters.push(finish);
            });
        },
        forget(tabId) {
            const t = tabs.get(tabId);
            if (t) release(t);   // don't strand a waiter when the tab/run disappears
            tabs.delete(tabId);
        },
    };
}
