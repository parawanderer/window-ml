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
// The isolated side accepts the FIRST port handed to it while it is ARMED and ignores every later one, so a page cannot
// swap in its own port on a page whose port is already taken. It is armed from document_start, and re-armed (any port it
// holds dropped) when the worker is about to put injected.js in late (`PAGE_PORT_ARM`, sw-presence.ts injectPageScripts):
// a port a page handed over before then is not the one a run talks on. A page that keeps handing ports over can still
// race the injection, and one that listens for the hand-off can still take injected.js's port; both are inherent while
// the page runs first. Nothing is sent to a hidden page's port while its gate is closed. Its state lives on the isolated world's
// global (content.js and the shell are separate bundles in one world), where no page script reaches it.
//
// In the isolated world's copy of the page-side bundle (injected-isolated.js, page-world.ts) both sides are in one world: the
// port goes to the content scripts' side directly, and nothing is dispatched on the page's window.
//
// The main side calls the builtins that touch its port through copies kept at module load. On a visible origin injected.js
// runs before any page script, so a page that wraps MessagePort.prototype.postMessage or the `onmessage` setter later is
// not handed the port as `this`; and its queue and listener lists use no Array method a page could wrap.

/** The event type of the hand-off. A page that knows it learns nothing: the event fires before it runs, or not at all. */
export const PORT_EVENT = "ml-page-port";

import { pageWorld } from "./page-world";

/** A message as either side's listeners receive it: `{ data }`, the shape a window message's handlers already read. */
export interface ChannelMessage { data: any }   // eslint-disable-line @typescript-eslint/no-explicit-any
type Listener = (e: ChannelMessage) => void;

const QUEUE_CAP = 256;

interface Side { port: MessagePort | null; listeners: Listener[]; queue: unknown[]; armed: boolean; native: boolean }

// The builtins the main side's port is used through, as they were when this module loaded (see the header). Used only for
// a port whose prototype is the one kept here, checked once as the channel is made (`Side.native`): a test's fake port,
// or Node's own MessagePort beside one, is called directly.
const apply = Reflect.apply;   // state: fixed
const protoOf = Object.getPrototypeOf;   // state: fixed
const portProto = typeof MessagePort === "function" ? MessagePort.prototype : null;   // state: fixed
const nativePost = portProto ? portProto.postMessage : null;   // state: fixed
const nativeOnMessage = portProto ? Object.getOwnPropertyDescriptor(portProto, "onmessage")?.set ?? null : null;   // state: fixed
const nativeData = typeof MessageEvent === "function" ? Object.getOwnPropertyDescriptor(MessageEvent.prototype, "data")?.get ?? null : null;   // state: fixed

/**
 * Post on a side's port, through the kept builtin when it is a native one.
 * @param side the side
 * @param port its port
 * @param data the message
 */
function post(side: Side, port: MessagePort, data: unknown): void {
    if (side.native && nativePost) apply(nativePost, port, [data]); else port.postMessage(data);
}

/**
 * Wire a port to a side: deliver what it hears to the listeners, and flush what was sent before it existed.
 * @param side the side
 * @param port its port
 */
function attach(side: Side, port: MessagePort): void {
    side.port = port;
    const onMessage = (e: MessageEvent): void => {
        const data = side.native && nativeData ? apply(nativeData, e, []) : e.data;
        const l = side.listeners, n = l.length, fs: Listener[] = [];
        for (let i = 0; i < n; i++) fs[i] = l[i];
        for (let i = 0; i < n; i++) { try { fs[i]({ data }); } catch { /* one listener must not stop the rest */ } }
    };
    if (side.native && nativeOnMessage) apply(nativeOnMessage, port, [onMessage]); else port.onmessage = onMessage;
    const q = side.queue, n = q.length;
    side.queue = [];
    for (let i = 0; i < n; i++) { try { post(side, port, q[i]); } catch { /* not cloneable: dropped, as a direct send throws */ } }
}

/**
 * Send on a side, or hold the message until its port exists.
 * @param side the side
 * @param data the message
 */
function send(side: Side, data: unknown): void {
    if (side.port) post(side, side.port, data);
    else if (side.queue.length < QUEUE_CAP) side.queue[side.queue.length] = data;
}

/**
 * Add a listener without an Array method.
 * @param side the side
 * @param f the listener
 */
function listen(side: Side, f: Listener): void { side.listeners[side.listeners.length] = f; }

/**
 * Remove a listener without an Array method.
 * @param side the side
 * @param f the listener
 */
function unlisten(side: Side, f: Listener): void {
    const l = side.listeners, kept: Listener[] = [];
    for (let i = 0; i < l.length; i++) if (l[i] !== f) kept[kept.length] = l[i];
    side.listeners = kept;
}

// --- the main world (injected.js and what it bundles) ---

let main: Side | null = null;   // state: plumbing

/** The main world's side, opened on first use: the channel is made and its far port handed to the isolated world. */
function mainSide(): Side {
    if (main) return main;
    main = { port: null, listeners: [], queue: [], armed: false, native: false };
    const ch = new MessageChannel();
    main.native = portProto !== null && protoOf(ch.port1) === portProto;
    attach(main, ch.port1);
    // A window that refuses the event leaves this side unconnected, its messages held: a test's DOM without the real
    // MessageEvent (loadDomWorld), never a browser.
    if (pageWorld.isolated) { const iso = isoSide(); dropPort(iso); iso.armed = false; attach(iso, ch.port2); return main; }
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
export function onIsolated(f: Listener): void { listen(mainSide(), f); }

/**
 * Stop hearing them.
 * @param f a listener passed to {@link onIsolated}
 */
export function offIsolated(f: Listener): void { unlisten(mainSide(), f); }

// --- the isolated world (content.js and the sidebar shell) ---

const KEY = "__mlPageChannel";   // a property of the isolated world's global, which no page script reaches

/** The isolated world's side, shared by both content scripts; listening for the hand-off from its first use. */
function isoSide(): Side {
    const g = globalThis as unknown as Record<string, Side | undefined>;
    let s = g[KEY];
    if (s) return s;
    s = g[KEY] = { port: null, listeners: [], queue: [], armed: true, native: false };   // state: plumbing
    const side = s;
    window.addEventListener(PORT_EVENT, (e: Event) => {
        const port = (e as MessageEvent).ports?.[0];
        if (!side.port && side.armed && port) { side.armed = false; attach(side, port); }   // the first port only
    }, true);
    return s;
}

/**
 * Forget the port this side holds, if any: what was sent to it is gone, and what is sent next is held.
 * @param side the side
 */
function dropPort(side: Side): void {
    const port = side.port;
    side.port = null;
    if (port) { try { port.onmessage = null; port.close(); } catch { /* already gone */ } }
}

/**
 * The worker is about to put injected.js into this document (`PAGE_PORT_ARM`): drop any port a page handed over before,
 * and take the next one.
 */
export function rearmForPage(): void { const s = isoSide(); dropPort(s); s.armed = true; }

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
export function onPage(f: Listener): void { listen(isoSide(), f); }

/**
 * Stop hearing it.
 * @param f a listener passed to {@link onPage}
 */
export function offPage(f: Listener): void { unlisten(isoSide(), f); }

/** Whether injected.js has handed its port over in this document. */
export function pageConnected(): boolean { return !!isoSide().port; }
