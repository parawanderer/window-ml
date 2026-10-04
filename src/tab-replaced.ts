// tab-replaced.ts — a tab the browser hands a NEW id, and what has to move with it.
//
// A background tab Chrome DISCARDS keeps its place on the strip and reloads when you next look at it, but it can
// come back under a DIFFERENT tab id, and `chrome.tabs.onReplaced` is the only notice of that. It is not a
// navigation, so `webNavigation.onCommitted` never fires for the tab that went away and the nav barrier never
// rises; it is not a close, so `tabs.onRemoved` never fires either. Everything the worker keys by tab — which runs
// a tab hosts, its replay ring, its grant ledgers, its debug buffer — is then filed under an id nothing will ever
// send again. The restored page's CONTENT_READY arrives from the NEW id, finds no runs to re-adopt, boots with an
// empty toolset, and the run still hosting on it answers every delegated tool with "no active agent run on this
// page (it may have ended)". It had not ended.
//
// Moving the keys is the whole of it and it is the same operation for every map, which is why it is one function
// here rather than a line per map at the listener. Pure, so it unit-tests without a browser.

/**
 * Re-file everything stored under `from` as `to`, across every map given. A map with no entry for `from` is left
 * alone; an entry already under `to` is overwritten, because the id has been REUSED and the older tenant is by
 * definition gone.
 *
 * @param maps every map keyed by tab id that should follow the tab
 * @param from the id the browser has retired
 * @param to the id the same tab now answers to
 * @returns how many maps actually held something — 0 means this was not a tab we were tracking
 */
export function moveTabKey(maps: Array<Map<number, unknown>>, from: number, to: number): number {
    if (from === to) return 0;
    let moved = 0;
    for (const m of maps) {
        if (!m.has(from)) continue;
        m.set(to, m.get(from));
        m.delete(from);
        moved++;
    }
    return moved;
}
