// no-tab-nav.ts — `navigate` from a run with no tab (docs/spec/TABLESS_RUN.md, "`navigate` from the detached state"): the
// worker opens the tab, waits for its load, and the run moves onto it at its next step boundary.

import type { RenderDescriptor } from "../contract";
import { queueNavMove } from "./move-run";
import { recordRunLog } from "./sw-run-log";

/** How long the opened tab may take to load before the navigate reports it did not. */
const NAV_LOAD_MS = 15000;

/** What the model reads for a URL a navigate from no tab cannot go to: a relative one, or any but an absolute http(s) one. */
export const NO_TAB_RELATIVE = "Error: this run has no tab, so navigate needs an absolute http(s) URL: there is no page to resolve this one against.";

/**
 * Where a navigate from no tab goes: an absolute http(s) URL only. A relative or scheme-relative one has no page to
 * resolve against (the closed tab's URL is not one), and any other scheme (the extension's own pages, `chrome:`, `file:`,
 * `data:`, `javascript:`) is not a page a run may be on.
 * @param url the URL as the model spelled it
 * @returns the URL, or undefined when a navigate from no tab may not go there
 */
export function noTabNavTarget(url: string): URL | undefined {
    const spelled = url.trim();
    // `new URL` with no base reads "https:\\host" and "https:host" as absolute: only a spelled "scheme://" is.
    if (!/^https?:\/\//i.test(spelled)) return undefined;
    try {
        const u = new URL(spelled);
        return u.protocol === "http:" || u.protocol === "https:" ? u : undefined;
    } catch { return undefined; }
}

/**
 * Whether this browser lets the extension run on an origin: without host access the opened tab could not take the run,
 * so the card says so and the navigate opens nothing (the start page's `blankStart` check, moved to when it is needed).
 * @param origin the destination's origin
 * @returns true when the extension may run there
 */
async function siteOpenable(origin: string): Promise<boolean> {
    if (typeof chrome.permissions?.contains !== "function") return true;
    return chrome.permissions.contains({ origins: [`${origin}/*`] }).catch(() => true);
}

/** What the card says when the extension may not run on the destination. */
const noAccessText = (origin: string): string => `This browser does not let window.ml run on ${origin}, so the run could not continue there.`;

/**
 * The approval card's In for a navigate from no tab: drawn by the worker, since there is no page to draw it. It names the
 * destination as the browser would read it, and whether the extension may run there, before any tab opens.
 * @param url the URL as the model spelled it
 * @returns the descriptor, or undefined for a URL the navigate refuses without a card
 */
export async function noTabNavRender(url: string): Promise<RenderDescriptor | undefined> {
    const dest = noTabNavTarget(url);
    if (!dest) return undefined;
    const open = await siteOpenable(dest.origin);
    return { type: "action", verb: "open a new tab at", target: dest.href, ...(open ? {} : { note: noAccessText(dest.origin) }) };
}

/**
 * Run an APPROVED navigate of a run with no tab: open the destination in a new tab, wait for its load, and queue the
 * run's move onto it (move-run.ts `queueNavMove`). Nothing of the run is on the tab until that move, at the next step
 * boundary, adopts it there.
 * @param runId the run
 * @param url the URL as the model spelled it
 * @returns the tool's result
 */
export async function navigateFromNoTab(runId: string, url: string): Promise<{ result: string }> {
    const dest = noTabNavTarget(url);
    if (!dest) return { result: NO_TAB_RELATIVE };
    if (!await siteOpenable(dest.origin)) return { result: `Error: ${noAccessText(dest.origin)} No tab was opened.` };
    const tab = await Promise.resolve(chrome.tabs.create({ url: dest.href, active: true })).catch((e) => ({ error: String((e as Error)?.message || e) }));
    if ("error" in tab || tab.id == null) return { result: "Error: the browser did not open a tab." };
    const loaded = await tabLoaded(tab.id);
    if (!loaded) {
        recordRunLog(runId, { level: "warn", subsystem: "tab", kind: "nav-open-failed", reason: "no-load", detail: { tab: tab.id } });
        return { result: `Error: the tab opened at ${dest.href} did not finish loading. The run still has no tab.` };
    }
    queueNavMove(runId, tab.id, dest.href);
    recordRunLog(runId, { subsystem: "tab", kind: "nav-opened", detail: { tab: tab.id, url: dest.href } });
    return { result: `Opened ${dest.href} in a new tab. The run moves onto it before your next step, and you are told what is on it then.` };
}

/** Whether a tab finished loading within {@link NAV_LOAD_MS}; false when it closed or did not. */
function tabLoaded(tabId: number): Promise<boolean> {
    return new Promise((resolve) => {
        let done = false;
        const finish = (ok: boolean): void => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            try { chrome.tabs.onUpdated?.removeListener(onUpd); } catch { /* not there */ }
            resolve(ok);
        };
        const onUpd = (id: number, info: { status?: string }): void => { if (id === tabId && info.status === "complete") finish(true); };
        const timer = setTimeout(() => finish(false), NAV_LOAD_MS);
        try { chrome.tabs.onUpdated?.addListener(onUpd); } catch { /* not there: the read below decides */ }
        Promise.resolve(chrome.tabs.get(tabId)).then((t) => { if (t?.status === "complete") finish(true); }, () => finish(false));
    });
}
