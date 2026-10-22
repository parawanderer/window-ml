// page-gate.ts — whether this document may hear from us: the content script's and the sidebar shell's shared gate.
//
// docs/spec/SITE_PRESENCE.md, step 2. A HIDDEN page gets nothing from the extension: no window message, no answer to
// what it posts. The gate opens only on the worker's word, never on anything the page can post: when the worker says
// the origin is visible (the CONTENT_READY reply), or when it has just put the page script into this document for a
// run the person started. `alive` is separate and only says the page script has run (its hello), which a page can
// forge; it decides how long to wait, never whether to speak. Both content scripts share one isolated world, so the
// state lives on that world's global, where the page cannot see it.

/** The gate's state. `pending` until the worker has answered, so an early message is held rather than refused. */
export type GateState = "pending" | "open" | "closed";

interface PageGate { state: GateState; alive: boolean; waiting: (() => void)[] }

const KEY = "__mlPageGate";   // a property of the isolated world's global, which no page script reaches

/** The one gate of this document, made on first use. */
function gate(): PageGate {
    const g = globalThis as unknown as Record<string, PageGate | undefined>;
    return (g[KEY] ??= { state: "pending", alive: false, waiting: [] });   // state: plumbing
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
    const held = g.waiting.splice(0);
    if (open) for (const f of held) f();
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

/** Note that the page script said hello (forgeable: it only bounds a wait). */
export function markAlive(): void { gate().alive = true; }

/** Whether the page script has said hello in this document. */
export function pageAlive(): boolean { return gate().alive; }
