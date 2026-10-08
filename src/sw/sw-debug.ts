// sw-debug.ts — the DevTools panel's copy of the page's debug stream: one ring buffer per inspected tab,
// fanned out to every panel connected to it. The in-page overlay is mounted the whole time and needs none of
// this; a panel opened mid-run does, which is what the buffer is for.

import { activeRuns, tabHasBgRun } from "./sw-runs";

// The in-page overlay receives __mlDebug via window-messages; a DevTools panel can't, so
// the content-script shell also forwards each event here (ML_DEBUG_EVENT). We buffer per
// inspected tab — a panel opened mid-run replays what it missed (the overlay never needs
// this, it's always mounted) — and fan out to any connected panel for that tab.
const devtoolsPorts = new Map<number, Set<chrome.runtime.Port>>();

/** Each inspected tab's replay ring: the debug events a DevTools panel would have missed by opening mid-run. */
export const debugBuffer = new Map<number, unknown[]>();

const DEBUG_BUFFER_CAP = 500;   // drop-oldest ring; screenshots are big, so keep it modest

/** Debug events that carry ACCUMULATED state for one step — the reducer REPLACES with each, never appends — so only the
 *  newest per session and step means anything in a replay. */
const COALESCED_DEBUG_KINDS = new Set(["agent-stream", "agent-turn"]);

/** Buffer one debug event for an inspected tab and push it to every DevTools panel connected to that tab. */
export function relayDebugEvent(tabId: number, event: unknown): void {
    let buf = debugBuffer.get(tabId);
    if (!buf) { buf = []; debugBuffer.set(tabId, buf); }
    // COALESCE the live deltas. A streamed turn sends one every ~100 ms, and in a 500-event ring they pushed out the
    // run's own `agent` start: a DevTools panel opened late had no session to put the steps in, and `ml.__events()`
    // dumped 450 stream deltas and no run. Each carries everything so far, so the newest replaces the last.
    const ev = event as { kind?: string; step?: number; session?: { hash?: string } } | null;
    if (ev?.kind && COALESCED_DEBUG_KINDS.has(ev.kind)) {
        for (let i = buf.length - 1; i >= 0; i--) {
            const o = buf[i] as { kind?: string; step?: number; session?: { hash?: string } };
            if (o?.kind === ev.kind && o.step === ev.step && o.session?.hash === ev.session?.hash) { buf.splice(i, 1); break; }
        }
    }
    buf.push(event);
    if (buf.length > DEBUG_BUFFER_CAP) buf.splice(0, buf.length - DEBUG_BUFFER_CAP);
    const ports = devtoolsPorts.get(tabId);
    if (ports) for (const p of ports) { try { p.postMessage({ __mlDebug: event }); } catch { /* port closing */ } }
}

// A fresh page mount (shell remount → ML_DEBUG_RESET) clears the buffer AND tells any
// connected panel to drop its stale sessions — the panel's app outlives a page reload, so
// without this it keeps the prior load's data while new events pile on under it.
export function resetDebug(tabId: number): void {
    // A cross-page run's shell remounts on the new page and fires ML_DEBUG_RESET — but the run may STILL be
    // live (activeRuns) OR resumable (bgRuns: completed-but-follow-up-able, or INTERRUPTED by an SW restart —
    // e.g. a mid-run site-access grant that cycled the worker). In any of those the session is on disk / in
    // bgRuns and about to recover, so keep its history: a late CS injection's reset must NOT drop the panel/HUD
    // session out from under a run that's coming back (the reported "the session vanished after I granted the
    // site" bug). Only a tab with NO run at all clears.
    if (activeRuns.has(tabId) || tabHasBgRun(tabId)) return;
    debugBuffer.delete(tabId);
    const ports = devtoolsPorts.get(tabId);
    if (ports) for (const p of ports) { try { p.postMessage({ reset: true }); } catch { /* port closing */ } }
}

/** Serve one `ml-devtools` port: register it against the tab it says it inspects, replay that tab's buffer so
 *  a panel opened mid-run catches up, and unregister on disconnect. A port that names no tab gets nothing. */
export function serveDevtoolsPort(port: chrome.runtime.Port): void {
    if (port.name !== "ml-devtools") return;
    let tabId: number | null = null;
    port.onMessage.addListener((msg: any) => {
        if (msg?.type === "ml-devtools-init" && typeof msg.tabId === "number") {
            const tid: number = msg.tabId;   // const local: TS narrows it (a captured `let` wouldn't)
            tabId = tid;
            let set = devtoolsPorts.get(tid);
            if (!set) { set = new Set(); devtoolsPorts.set(tid, set); }
            set.add(port);
            port.postMessage({ replay: debugBuffer.get(tid) || [] });   // catch a late-opened panel up
        }
    });
    port.onDisconnect.addListener(() => {
        const tid = tabId;
        if (tid == null) return;
        const set = devtoolsPorts.get(tid);
        if (set) { set.delete(port); if (!set.size) devtoolsPorts.delete(tid); }
    });
}
