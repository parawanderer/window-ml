// tab-ready.ts — WHY A TAB A RUN JUST OPENED NEVER BECAME ONE IT CAN RUN ON, said in the words of the actual cause.
//
// Opening a tab and waiting for `window.ml` has exactly two ways to fail, and from inside the wait loop they look
// identical: `chrome.scripting.executeScript` throws the same way whether the page never loaded or the browser will
// not let the extension run there. The loop therefore reported ONE of them — "the extension may not be allowed to run
// there" — for both, which is a confident wrong answer in the case where someone most needs a right one.
//
// `chrome.webNavigation.onErrorOccurred` is what tells them apart: it fires when the load itself failed. So the
// caller records any error for the tab's main frame and hands it here, and this decides what to say. Pure, so the
// wording is testable without a browser — which is the point, since the alternative is reading it off a 15-second
// timeout by hand.

/** A navigation error for the tab's own frame, as `chrome.webNavigation.onErrorOccurred` reports it (`net::ERR_…`). */
export type NetError = string | null | undefined;

/**
 * What to tell someone whose run could not start on `url`.
 *
 * `netError` present means the page never loaded — the host is down, there is no network, the address is wrong.
 * Absent means the page is there and the extension still could not run on it, which on a normal http(s) page is the
 * browser's own site-access setting for the extension.
 */
export function tabReadyFailure(url: string, netError: NetError): string {
    if (netError) return `the page could not be reached (${netError})`;
    return `this browser does not let the extension run on ${originOf(url)} — check the extension's site access`;
}

/** The origin to name in that message, falling back to the whole string when it is not a URL we can parse. */
function originOf(url: string): string {
    try { return new URL(url).origin; } catch { return url; }
}
