// page-channel.ts — the private line between the main-world script and the content scripts, in place of the page's window.
//
// docs/spec/SITE_PRESENCE.md, step 2b. Every message between injected.js and content.js or the sidebar shell used to be a
// window.postMessage, which any listener the page added reads, and which the page can post too. Now injected.js opens a
// MessageChannel and hands one port to the isolated world with a synchronous event on window; after that, nothing of
// ours crosses the page's window. On a page whose origin is allowed before it loads, injected.js runs at document_start,
// before any page script, so no page listener exists to see the hand-off. On a page given injected.js later (a person's
// run on a hidden page, an origin allowed while it is open) the page ran first and can see the hand-off and take the
// port: there it hides nothing, which is no worse than the window was. The page still shares the main world, so this
// hides a run's traffic from page code that listens, not from page code that rewrites the builtins injected.js calls.
//
// The isolated side accepts the FIRST port handed to it and ignores every later one, so a page cannot swap in its own
// port on a page whose port is already taken. Its state lives on the isolated world's global (content.js and the shell
// are separate bundles in one world), where no page script reaches it.

/** The event type of the hand-off. A page that knows it learns nothing: the event fires before it runs, or not at all. */
export const PORT_EVENT = "ml-page-port";

/** A message as either side's listeners receive it: `{ data }`, the shape a window message's handlers already read. */
export interface ChannelMessage { data: any }   // eslint-disable-line @typescript-eslint/no-explicit-any
type Listener = (e: ChannelMessage) => void;

const QUEUE_CAP = 256;

interface Side { port: MessagePort | null; listeners: Listener[]; queue: unknown[] }

/**
 * Wire a port to a side: deliver what it hears to the listeners, and flush what was sent before it existed.
 * @param side the side
 * @param port its port
 */
function attach(side: Side, port: MessagePort): void {
    side.port = port;
    port.onmessage = (e: MessageEvent) => { for (const f of [...side.listeners]) { try { f({ data: e.data }); } catch { /* one listener must not stop the rest */ } } };
    for (const m of side.queue.splice(0)) { try { port.postMessage(m); } catch { /* not cloneable: dropped, as a direct send throws */ } }
}

/**
 * Send on a side, or hold the message until its port exists.
 * @param side the side
 * @param data the message
 */
function send(side: Side, data: unknown): void {
    if (side.port) side.port.postMessage(data);
    else if (side.queue.length < QUEUE_CAP) side.queue.push(data);
}

// --- the main world (injected.js and what it bundles) ---

let main: Side | null = null;   // state: plumbing

/** The main world's side, opened on first use: the channel is made and its far port handed to the isolated world. */
function mainSide(): Side {
    if (main) return main;
    main = { port: null, listeners: [], queue: [] };
    const ch = new MessageChannel();
    attach(main, ch.port1);
    // A window that refuses the event leaves this side unconnected, its messages held: a test's DOM without the real
    // MessageEvent (loadDomWorld), never a browser.
    try { window.dispatchEvent(new MessageEvent(PORT_EVENT, { ports: [ch.port2] })); } catch { /* unconnected */ }
    return main;
}

/**
 * Send to the content scripts (content.js and the shell).
 * @param data the message, structured-cloneable
 */
export function toIsolated(data: unknown): void { send(mainSide(), data); }

/**
 * Hear the content scripts.
 * @param f called with `{ data }` for each message
 */
export function onIsolated(f: Listener): void { mainSide().listeners.push(f); }

/**
 * Stop hearing them.
 * @param f a listener passed to {@link onIsolated}
 */
export function offIsolated(f: Listener): void {
    const l = mainSide().listeners, i = l.indexOf(f);
    if (i >= 0) l.splice(i, 1);
}

// --- the isolated world (content.js and the sidebar shell) ---

const KEY = "__mlPageChannel";   // a property of the isolated world's global, which no page script reaches

/** The isolated world's side, shared by both content scripts; listening for the hand-off from its first use. */
function isoSide(): Side {
    const g = globalThis as unknown as Record<string, Side | undefined>;
    let s = g[KEY];
    if (s) return s;
    s = g[KEY] = { port: null, listeners: [], queue: [] };   // state: plumbing
    const side = s;
    window.addEventListener(PORT_EVENT, (e: Event) => {
        const port = (e as MessageEvent).ports?.[0];
        if (!side.port && port) attach(side, port);   // the first port only
    }, true);
    return s;
}

/**
 * Start listening for the main-world script's port. content.js calls this at document_start, before injected.js runs.
 */
export function listenForPage(): void { isoSide(); }

/**
 * Send to injected.js. Held until its port arrives (a page whose script is put in later), up to a cap.
 * @param data the message, structured-cloneable
 */
export function toPage(data: unknown): void { send(isoSide(), data); }

/**
 * Hear injected.js.
 * @param f called with `{ data }` for each message
 */
export function onPage(f: Listener): void { isoSide().listeners.push(f); }

/**
 * Stop hearing it.
 * @param f a listener passed to {@link onPage}
 */
export function offPage(f: Listener): void {
    const l = isoSide().listeners, i = l.indexOf(f);
    if (i >= 0) l.splice(i, 1);
}

/** Whether injected.js has handed its port over in this document. */
export function pageConnected(): boolean { return !!isoSide().port; }
