// shell-top-layer.ts — keeping the shell's shadow hosts in the browser's top layer, above every z-index on the page, and putting them back on top, within a budget, after the page acts.

// Each host is `popover="manual"` and shown, so it paints in the top layer, over anything the page stacks with
// z-index. Two things still reach above or into it, and each is answered here:
//
// - The page's own top-layer elements, opened AFTER ours (a modal dialog, an element in fullscreen, a popover): the
//   browser stacks the top layer by insertion order, so the newest sits on top. Answered by RAISING ours again
//   (hidePopover + showPopover moves an element to the end of the top layer). Noticed through the `toggle` event (a
//   dialog's and a popover's), a dialog's `open` attribute, and the fullscreen element changing. Under a modal dialog
//   or a fullscreen element the browser makes everything outside it inert, ours included, so a raised host is SEEN but
//   takes no clicks until the page closes it: no click on our UI can be steered while that lasts either.
// - The page acting on our host itself (it reaches the element: the root is open, and the host sits in its DOM):
//   `hidePopover()`, the attribute removed or changed, our show cancelled in `beforetoggle`. Answered by RESTORING it.
//   Noticed through the host's own toggle events, a MutationObserver on its attribute, and a poll of its state, which
//   is the one path a page cannot stop (it can cancel an event before it reaches us, never the read).
//
// Every raise and restore comes out of one budget (RAISE_BURST, one more per RAISE_REFILL_MS), and the requests of one
// task are served by one raise, so a page that reopens its modal or hides our host in a loop gets a bounded number of
// them and then waits for the refill. A host the page has kept OUT of the top layer is what shell-shot.ts refuses a
// capture for (`tampered`): the page acted on our UI and won. A page element kept ABOVE ours is not: the rects are right
// whichever is on top, so the shot is still clean.

/** How many raises and restores the shell may make in a burst, before it waits for the refill. */
export const RAISE_BURST = 10;
/** How long one spent raise takes to come back, in ms: past the burst, at most one raise per this. */
export const RAISE_REFILL_MS = 1000;
/** How often the hosts' own state and the fullscreen element are read, in ms: the path no stopped event hides. */
export const TOP_LAYER_POLL_MS = 1000;

/** The clock and timers the keeper runs on: the page's in the shell, fakes in a test. */
export interface TopLayerClock {
    now(): number;
    setTimeout(fn: () => void, ms: number): unknown;
    clearTimeout(h: unknown): void;
    setInterval(fn: () => void, ms: number): unknown;
    clearInterval(h: unknown): void;
}

/** What the keeper reads and hears of the document: the real one in the shell ({@link browserTopLayerDoc}), a fake in a test. */
export interface TopLayerDoc {
    /** Listen on the window in the capture phase; returns the remover. */
    listen(type: string, fn: (e: Event) => void): () => void;
    /** Watch `target` for changes to the attributes in `filter` (its subtree too when `subtree`); returns the remover. */
    observe(target: Node, filter: string[], subtree: boolean, fn: (targets: Node[]) => void): () => void;
    /** The document's fullscreen element, if any. */
    fullscreenElement(): Element | null;
    /** The document's root element, watched for a dialog opened anywhere under it. */
    root(): Node | null;
}

/** The keeper over the shell's hosts, from {@link topLayerKeeper}. */
export interface TopLayerKeeper {
    /** Put a host the shell just mounted in the top layer, and every host back in order. Free: a mount is ours. */
    promote(host: HTMLElement): void;
    /** Forget a host the shell removed (it leaves the top layer with the DOM). */
    release(host: HTMLElement): void;
    /** Whether the shell put this host in the top layer: if it is out of it now, the page took it out. */
    manages(host: Element | null | undefined): boolean;
    /** Ask for a raise (`foreign`: something of the page's entered the top layer) or a check of our own (`own`). */
    request(why: "foreign" | "own"): void;
    /** Stop every listener and timer, and forget every host. */
    stop(): void;
}

/**
 * Whether a host is in the top layer as the shell put it: `popover="manual"` and open.
 * @param host the shadow host
 * @returns false for anything else, a throw included
 */
export function onTopLayer(host: Element | null | undefined): boolean {
    if (!host) return false;
    try { return host.getAttribute("popover") === "manual" && host.matches(":popover-open"); } catch { return false; }
}

/**
 * Whether this browser has the popover API (jsdom has not: the hosts then stay where z-index puts them).
 * @param host any element
 * @returns true when it can be shown and hidden as a popover
 */
export function popoverSupported(host: Element): boolean {
    return typeof (host as HTMLElement).showPopover === "function" && typeof (host as HTMLElement).hidePopover === "function";
}

/** Move a host to the top of the top layer: `popover="manual"` set back if the page changed it, then shown, or hidden and shown. */
function raiseOne(host: HTMLElement): void {
    try {
        if (host.getAttribute("popover") !== "manual") host.setAttribute("popover", "manual");
        if (host.matches(":popover-open")) host.hidePopover();
        host.showPopover();
    } catch { /* the page changed it from its beforetoggle: the next check sees it */ }
}

/**
 * The keeper of the shell's hosts in the top layer.
 * @param order the hosts in the order they stack, lowest first (the highlight, the sidebar, the card)
 * @param doc the document's events and state ({@link browserTopLayerDoc})
 * @param clock timers ({@link browserClock})
 * @param budget the burst, the refill and the poll ({@link RAISE_BURST}, {@link RAISE_REFILL_MS}, {@link TOP_LAYER_POLL_MS})
 * @returns the keeper
 */
export function topLayerKeeper(order: () => (HTMLElement | null)[], doc: TopLayerDoc, clock: TopLayerClock, budget = { burst: RAISE_BURST, refillMs: RAISE_REFILL_MS, pollMs: TOP_LAYER_POLL_MS }): TopLayerKeeper {
    const managed = new Set<HTMLElement>();   // state: ui — the hosts the shell put in the top layer, each dropped as it is removed
    const hostWatch = new Map<HTMLElement, () => void>();   // state: ui — the attribute watch on each of them
    let tokens = budget.burst, refilledAt = clock.now();
    let need: "" | "own" | "foreign" = "";
    let queued = false, retry: unknown = null, poll: unknown = null, lastFs: Element | null = null;
    let unhook: (() => void)[] = [];

    const live = (): HTMLElement[] => order().filter((h): h is HTMLElement => !!h && managed.has(h) && h.isConnected);
    const restack = (): void => { for (const h of live()) raiseOne(h); };
    const refill = (): void => {
        const n = Math.floor((clock.now() - refilledAt) / budget.refillMs);
        if (n > 0) { tokens = Math.min(budget.burst, tokens + n); refilledAt += n * budget.refillMs; }
        if (tokens >= budget.burst) refilledAt = clock.now();
    };
    const flush = (): void => {
        queued = false;
        if (!need) return;
        // A check with every host still on top costs nothing: our own raises fire toggle events too.
        if (need === "own" && live().every(onTopLayer)) { need = ""; return; }
        refill();
        if (tokens < 1) {
            if (retry === null) retry = clock.setTimeout(() => { retry = null; flush(); }, Math.max(1, refilledAt + budget.refillMs - clock.now()));
            return;
        }
        tokens--;
        need = "";
        restack();
    };
    const request = (why: "foreign" | "own"): void => {
        if (!managed.size) return;
        if (why === "foreign" || !need) need = why;
        // While the budget is spent the retry timer serves every request in one raise.
        if (!queued && retry === null) { queued = true; queueMicrotask(flush); }
    };
    const ours = (t: EventTarget | null): boolean => !!t && managed.has(t as HTMLElement);
    const hook = (): void => {
        if (unhook.length) return;
        unhook = [
            doc.listen("toggle", (e) => {
                if (ours(e.target)) request("own");
                else if ((e as Event & { newState?: string }).newState === "open") request("foreign");
            }),
            doc.listen("beforetoggle", (e) => { if (ours(e.target)) request("own"); }),
            doc.listen("fullscreenchange", () => { if (doc.fullscreenElement()) request("foreign"); }),
        ];
        // A dialog's `open` set in the light DOM: the path for a page that stops the dialog's toggle event.
        const root = doc.root();
        if (root) unhook.push(doc.observe(root, ["open"], true, (targets) => {
            if (targets.some((t) => t.nodeName === "DIALOG" && (t as Element).hasAttribute("open"))) request("foreign");
        }));
        lastFs = doc.fullscreenElement();
        poll = clock.setInterval(() => {
            const fs = doc.fullscreenElement();
            if (fs !== lastFs) { lastFs = fs; if (fs) return request("foreign"); }
            request("own");
        }, budget.pollMs);
    };
    const unhookAll = (): void => {
        for (const u of unhook) u();
        unhook = [];
        if (poll !== null) clock.clearInterval(poll);
        if (retry !== null) clock.clearTimeout(retry);
        poll = retry = null;
        need = "";
    };
    return {
        promote(host) {
            if (!popoverSupported(host)) return;
            managed.add(host);
            if (!hostWatch.has(host)) hostWatch.set(host, doc.observe(host, ["popover"], false, () => request("own")));
            hook();
            restack();
        },
        release(host) {
            managed.delete(host);
            hostWatch.get(host)?.();
            hostWatch.delete(host);
            if (!managed.size) unhookAll();
        },
        manages: (host) => !!host && managed.has(host as HTMLElement),
        request,
        stop() {
            for (const u of hostWatch.values()) u();
            hostWatch.clear();
            managed.clear();
            unhookAll();
        },
    };
}

/** The keeper's view of the real document, for the shell. */
export function browserTopLayerDoc(): TopLayerDoc {
    return {
        listen(type, fn) {
            window.addEventListener(type, fn, true);
            return () => window.removeEventListener(type, fn, true);
        },
        observe(target, filter, subtree, fn) {
            const mo = new MutationObserver((records) => fn(records.map((r) => r.target)));
            mo.observe(target, { attributes: true, attributeFilter: filter, subtree });
            return () => mo.disconnect();
        },
        fullscreenElement: () => document.fullscreenElement,
        root: () => document.documentElement,
    };
}

/** The page's own clock, for the shell. */
export const browserClock: TopLayerClock = {
    now: () => performance.now(),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    setInterval: (fn, ms) => setInterval(fn, ms),
    clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>),
};
