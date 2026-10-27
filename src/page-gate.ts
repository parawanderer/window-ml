// page-gate.ts — whether this document may hear from us: the content script's and the sidebar shell's shared gate.
//
// docs/spec/SITE_PRESENCE.md, step 2. A HIDDEN page gets nothing from the extension: no window message, no answer to
// what it posts. The gate opens only on the worker's word, never on anything the page can post: when the worker says
// the origin is visible (the CONTENT_READY reply), or when it has just put the page script into this document for a
// run the person started. `alive` is separate and only says the page script has run (its hello), which a page can
// forge; it decides how long to wait, never whether to speak. Both content scripts share one isolated world, so the
// state lives on that world's global, where the page cannot see it.
//
// A closed gate can still ASK (`gateAsks`): the worker said the page has the stub (ask.js, SITE_PRESENCE.md), so the one
// message the stub sends, its access request, is relayed and answered. Nothing else crosses: no run traffic, no shell.

/** The gate's state. `pending` until the worker has answered, so an early message is held rather than refused. */
export type GateState = "pending" | "open" | "closed";

interface PageGate { state: GateState; alive: boolean; ask: boolean; waiting: (() => void)[]; deciding: (() => void)[]; opening: (() => void)[] }

const KEY = "__mlPageGate";   // a property of the isolated world's global, which no page script reaches

/** The one gate of this document, made on first use. */
function gate(): PageGate {
    const g = globalThis as unknown as Record<string, PageGate | undefined>;
    return (g[KEY] ??= { state: "pending", alive: false, ask: false, waiting: [], deciding: [], opening: [] });   // state: plumbing
}

/** The gate's state now. */
export function gateState(): GateState { return gate().state; }

/** True once the worker has said this document may hear from us. */
export function gateOpen(): boolean { return gate().state === "open"; }

/**
 * Set the gate from the worker's word. Opening runs everything held while it was pending; closing drops it.
 * @param open whether the document may hear from us
 */
export function setGate(open: boolean): void {
    const g = gate();
    if (g.state === "open") return;   // once open, open for this document: a run's page script is in it
    g.state = open ? "open" : "closed";
    const held = g.waiting.splice(0), decided = g.deciding.splice(0), opening = open ? g.opening.splice(0) : [];
    if (open) for (const f of [...opening, ...held]) f();
    for (const f of decided) f();
}

/**
 * Run `f` once the worker has answered either way: now if it has, later if it is still pending. For what must be
 * answered whichever way it goes (a worker's request, which `f` then serves or refuses by `gateOpen()`).
 * @param f what to run
 */
export function whenDecided(f: () => void): void {
    const g = gate();
    if (g.state !== "pending") f();
    else g.deciding.push(f);   // only the worker's own requests come here, so no cap is needed
}

/**
 * Run `f` once the gate is open: now if it is, later if it is still pending, never if it closed.
 * @param f what to run
 */
export function whenOpen(f: () => void): void {
    const g = gate();
    if (g.state === "open") f();
    else if (g.state === "pending" && g.waiting.length < 256) g.waiting.push(f);
}

/**
 * Run `f` once the gate is open, even if it closed first: a closed page opens when its origin is allowed while it is
 * open, or when a run starts there. For the extension's own setup (the shell's handshake), never for what the page
 * posted, which a closed gate drops so a hidden page's posts are not replayed later.
 * @param f what to run
 */
export function whenEverOpen(f: () => void): void {
    const g = gate();
    if (g.state === "open") f();
    else if (g.opening.length < 16) g.opening.push(f);
}

/**
 * Set whether this document has the stub, on the worker's word only (the CONTENT_READY reply, or PRESENCE_ASK once the
 * worker has put ask.js in). Set before `setGate`, so what waited for the decision reads it.
 * @param on whether the page may ask for access
 */
export function setAsk(on: boolean): void { gate().ask = on; }

/** True when the worker said this document has the stub: its access request may cross a closed gate. */
export function gateAsks(): boolean { return gate().ask; }

/** Note that the page script said hello (forgeable: it only bounds a wait). */
export function markAlive(): void { gate().alive = true; }

/** Whether the page script has said hello in this document. */
export function pageAlive(): boolean { return gate().alive; }
