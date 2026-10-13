// sw-site-access.ts — the background's half of "sites get window.ml only when someone said yes": the lists in
// storage, and the gate the router puts in front of every message a page starts.
//
// docs/spec/SITE_ACCESS.md, slice 1. The rules are pure (site-access.ts); this module reads the lists from storage on
// every call (so a revoke takes effect on the next message, with no reload) and answers one question for the router:
// may this sender start this message? The sender's origin comes from `sender`, which the browser sets. Nothing the
// page says is read.

import { type SenderFacts, type SiteEdit, type SiteLists, SITE_ACCESS_KEYS, applyEdit, decide, grantableOrigin, selfApproves } from "../site-access";
import { PAGE_STARTED_TYPES } from "../page-relay";
import { getConfig } from "./sw-llm";

const asList = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

/** The three lists, as stored now. A storage area that cannot be read counts as empty: refusing is the safe side. */
export async function readSiteLists(): Promise<SiteLists> {
    const [local, session] = await Promise.all([
        chrome.storage.local.get([SITE_ACCESS_KEYS.always, SITE_ACCESS_KEYS.denied]).catch(() => ({} as Record<string, unknown>)),
        (chrome.storage.session?.get(SITE_ACCESS_KEYS.session) ?? Promise.resolve({})).catch(() => ({} as Record<string, unknown>)),
    ]);
    return {
        always: asList(local[SITE_ACCESS_KEYS.always]),
        denied: asList(local[SITE_ACCESS_KEYS.denied]),
        session: asList((session as Record<string, unknown>)[SITE_ACCESS_KEYS.session]),
    };
}

/**
 * Change the lists. Only the extension's own pages call this (the router checks), so a page can never approve itself.
 * @param edit the change
 * @returns the lists after it
 */
export async function editSiteAccess(edit: SiteEdit): Promise<SiteLists> {
    const next = applyEdit(await readSiteLists(), edit);
    await chrome.storage.local.set({ [SITE_ACCESS_KEYS.always]: next.always, [SITE_ACCESS_KEYS.denied]: next.denied });
    await chrome.storage.session?.set({ [SITE_ACCESS_KEYS.session]: next.session });
    return next;
}

/** What the lists say about one origin, with the `pageApprovalDomains` implication applied. */
export async function siteDecision(origin: string): Promise<ReturnType<typeof decide>> {
    const [lists, cfg] = await Promise.all([readSiteLists(), getConfig()]);
    return decide(lists, origin, cfg.pageApprovalDomains || []);
}

/**
 * The facts about a message's sender that the site gate and the self-approval whitelist read: the browser-stamped
 * origin, the frame's URL (the tab's when there is none) and the frame id. One derivation, so the two cannot disagree.
 * @param sender a `chrome.runtime.MessageSender`, or the `{ tab, url }` a worker-built run stands in for its tab with
 * @returns the facts
 */
export function senderFacts(sender: chrome.runtime.MessageSender): SenderFacts {
    return { origin: sender.origin, url: sender.url ?? sender.tab?.url, frameId: sender.frameId };
}

/**
 * The facts the self-approval whitelist judges a sender by. A web page's are its own (`senderFacts`). One of the
 * extension's own frames inside a tab (the overlay sidebar, its Python bench) speaks for the tab it sits in, so it is
 * judged by that tab's top-frame URL, as before the whitelist was read by origin.
 * @param sender the browser's facts about who sent the message
 * @returns the facts
 */
export function selfApprovalFacts(sender: chrome.runtime.MessageSender): SenderFacts {
    return isExtensionSender(sender) && sender.tab ? { url: sender.tab.url, frameId: 0 } : senderFacts(sender);
}

/**
 * Whether a sender may act as a site on the self-approval whitelist (`pageApprovalDomains`): `selfApproves` over the
 * lists and the setting as stored now. Every reader of the whitelist asks this: `senderTrust` for the privileged
 * handlers, and `pageApprovalAllowed` in the config a page or a run reads.
 * @param facts the sender's facts (`senderFacts`), or `{ url }` for a tab's top frame
 * @returns true when the sender self-approves
 */
export async function senderSelfApproves(facts: SenderFacts): Promise<boolean> {
    const [lists, cfg] = await Promise.all([readSiteLists(), getConfig()]);
    return selfApproves(lists, facts, cfg.pageApprovalDomains || []);
}

/**
 * The router's gate. Null when the message may go on to its handler; otherwise the refusal to answer it with.
 *
 * Applies only to a type a page can start (`PAGE_STARTED_TYPES`) arriving from a tab that is not one of the
 * extension's own frames. A tab hosting a run gets nothing more than any other: a run's tools send nothing from the page
 * they act on (site access part 5), so the page a run is on is judged by its own origin like every other.
 * @param type the message type
 * @param sender the browser's facts about who sent it
 * @returns null to allow, or the refusal
 */
export async function pageRefusal(type: unknown, sender: chrome.runtime.MessageSender): Promise<string | null> {
    if (typeof type !== "string" || !PAGE_STARTED_TYPES.has(type)) return null;
    if (sender.tab == null || isExtensionSender(sender)) return null;
    const g = grantableOrigin(senderFacts(sender));
    if ("refused" in g) return `Refused: ${g.refused}.`;
    const decision = await siteDecision(g.origin);
    if (decision === "always" || decision === "session") return null;
    return decision === "denied"
        ? `Refused: ${g.origin} is not allowed to use window.ml.`
        : `Refused: ${g.origin} is not approved to use window.ml. Allow it from the extension's toolbar button.`;
}

/** Whether a message or port comes from one of the extension's OWN pages or frames (the sidebar app, the popup, the
 *  chat page, a DevTools panel, the offscreen document), as opposed to a content script speaking for a web page. Read
 *  from the browser-stamped `sender.url`, which a page cannot set. The one test for "is this the extension", so the
 *  places that ask it cannot disagree. */
export function isExtensionSender(sender: chrome.runtime.MessageSender | undefined): boolean {
    return (sender?.url || "").startsWith(chrome.runtime.getURL(""));
}
