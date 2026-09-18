// shell-session-relay.ts — a session command from the worker reaches THIS page, and this page answers it.
//
// One mechanism that was spread across two of shell.ts's listeners. The background sends a command that has to
// end at a page (`ML_SESSION_TO_PAGE` for steer/cancel/continue, `ML_START_AGENT` for a run started from an
// extension page); the shell relays it into the page as a window message; the page answers with
// `__mlSessionDone` carrying the request id it was given. The waiter map is what joins the two halves, and it
// is private to this module for that reason — nothing outside has any business resolving a request.
//
// What is deliberately NOT here, because it looks like this and is not: the `ML_HL_*` highlight messages
// (fire-and-forget, correlated by their own `seq`), the approval-card branches, and the debug-bus forwarding.
// Three of those read as acknowledgements; none of them is one.
//
// The page's answer is the page's CLAIM about its own session, so it decides nothing. A transcript still
// changes only through the session's events.
import { cleanImages } from "../contract";

/** Chat-page session actions waiting for the page to say what it did, by request id. */
const sessionDoneWaiters = new Map<string, (outcome: string, hash?: string) => void>();
/** How long a page gets to answer before the action is reported as unanswered. */
const SESSION_DONE_MS = 3000;
/** Starting a run gets longer: the page answers only once the loop has minted the hash, which is after its own
 *  setup (the config read, the toolset, a capability probe), and none of that is waiting on this shell. */
const START_DONE_MS = 10_000;

/** Relay the page's answer to one session action back to the background, or `no-answer` when the page never replies (a
 *  page whose `window.ml` has not loaded, or one that swallowed the message). What the page reports is its own claim
 *  about its own session, so it decides nothing: the transcript still changes only through the session's events. */
function awaitSessionDone(reqId: string, sendResponse: (r: unknown) => void, withinMs = SESSION_DONE_MS): void {
    const timer = setTimeout(() => finish("no-answer"), withinMs);
    const finish = (outcome: string, hash?: string): void => {
        if (!sessionDoneWaiters.delete(reqId)) return;
        clearTimeout(timer);
        try { sendResponse({ outcome, ...(hash ? { hash } : {}) }); } catch { /* the background stopped waiting */ }
    };
    sessionDoneWaiters.set(reqId, finish);
}

/**
 * The page's answer to a session action (a `__mlSessionDone` window message), matched to its waiter.
 *
 * @param data The window message's `data.__mlSessionDone`.
 * @returns `true` when this was an answer we were waiting for, so the caller stops looking at it.
 */
export function onSessionDone(data: unknown): boolean {
    const { reqId, outcome, hash } = (data || {}) as { reqId?: unknown; outcome?: unknown; hash?: unknown };
    const reply = typeof reqId === "string" ? sessionDoneWaiters.get(reqId) : undefined;
    if (reply) reply(typeof outcome === "string" ? outcome : "none", typeof hash === "string" ? hash : undefined);
    return true;
}

/**
 * DevTools session composer (panel → background → here): relay to the PAGE, which drives the handle
 * by hash (steer/run/cancel). Any mode — the page's handle registry is what acts, not this shell.
 *
 * @param msg The `ML_SESSION_TO_PAGE` message.
 * @param sendResponse The background's reply channel.
 * @returns `true` when the reply is asynchronous (the caller must keep the channel open), `false` when the
 *   action was not recognised and nothing was sent.
 */
export function relaySessionToPage(msg: Record<string, unknown>, sendResponse: (r: unknown) => void): boolean {
    // A `reqId` (the chat page's commands) asks for what the page did; the DevTools composer sends none.
    const reqId = typeof msg.reqId === "string" ? msg.reqId : undefined;
    const elementContext = msg.elementContext as { selector?: unknown } | undefined;
    const ec = elementContext && typeof elementContext.selector === "string" ? elementContext : undefined;
    if (msg.action === "send") window.postMessage({ __mlSessionSend: { hash: msg.hash, text: msg.text, images: cleanImages(msg.images as string[] | undefined), ...(ec ? { elementContext: ec } : {}), reqId } }, "*");
    else if (msg.action === "cancel") window.postMessage({ __mlCancelSession: { hash: msg.hash, reqId } }, "*");
    else if (msg.action === "continue") window.postMessage({ __mlContinueRun: { hash: msg.hash, reqId } }, "*");
    else return false;
    if (reqId) { awaitSessionDone(reqId, sendResponse); return true; }   // async: the page answers by window message
    return false;
}

/**
 * The chat page's `agent.start`: run it through the SAME page path the HUD composer uses, so a run started
 * from an extension page is a genuine session of this tab (hash, resumable, appendable) built by the page's
 * own toolset, rather than a second way of starting a run that would drift from it.
 *
 * @param msg The `ML_START_AGENT` message; its `reqId` is already known to be a string.
 * @param sendResponse The background's reply channel.
 * @param hud The shell's current `agentHud` setting, passed in rather than read here — this module relays
 *   commands and owns none of the shell's configuration.
 * @returns `true` always: the reply is asynchronous.
 */
export function relayStartAgent(msg: Record<string, unknown>, sendResponse: (r: unknown) => void, hud: string): boolean {
    window.postMessage({ __mlStartAgent: {
        task: msg.task,
        reqId: msg.reqId,
        maxSteps: typeof msg.maxSteps === "number" ? msg.maxSteps : undefined,
        model: typeof msg.model === "string" && msg.model.trim() ? msg.model.trim() : undefined,
        vision: msg.vision === true ? true : undefined,
        stream: msg.stream === true ? true : undefined,
        images: cleanImages(msg.images as string[] | undefined),
        hud,
    } }, "*");
    awaitSessionDone(msg.reqId as string, sendResponse, START_DONE_MS);
    return true;
}
