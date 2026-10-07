// shell-session-relay.ts — a session command from the worker reaches THIS page, and this page answers it.
//
// One mechanism that was spread across two of shell.ts's listeners. The background sends a command that has to
// end at a page (`ML_SESSION_TO_PAGE`: a message, cancel or continue for a run or chat the PAGE built); the shell
// relays it into the page as a window message; the page answers with
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
    // WHERE IT WAS TYPED, from the route rather than from a field a sender chose. The panel says so outright
    // (it is the one composer not in this document); anything arriving with a `reqId` came in as a session
    // COMMAND, which is the chat app. Neither can be forged by the page: both crossed the background first.
    const surface = typeof msg.surface === "string" ? msg.surface : reqId ? "chat" : undefined;
    if (msg.action === "send") window.postMessage({ __mlSessionSend: { hash: msg.hash, text: msg.text, images: cleanImages(msg.images as string[] | undefined), ...(ec ? { elementContext: ec } : {}), ...(surface ? { surface } : {}), reqId } }, "*");
    else if (msg.action === "cancel") window.postMessage({ __mlCancelSession: { hash: msg.hash, reqId } }, "*");
    else if (msg.action === "continue") {
        // STRICT, not coerced: the runtime refuses a `"50"` outright (session-commands.ts), so accepting one here
        // would mean the same value is taken on one route and rejected on the other.
        const steps = msg.maxSteps;
        window.postMessage({ __mlContinueRun: { hash: msg.hash, ...(typeof steps === "number" && Number.isInteger(steps) && steps > 0 ? { maxSteps: steps } : {}), reqId } }, "*");
    }
    else return false;
    if (reqId) { awaitSessionDone(reqId, sendResponse); return true; }   // async: the page answers by window message
    return false;
}
