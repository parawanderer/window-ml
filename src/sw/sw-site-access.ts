// sw-site-access.ts — the background's half of "sites get window.ml only when someone said yes": the lists in
// storage, and the gate the router puts in front of every message a page starts.
//
// docs/spec/SITE_ACCESS.md, slice 1. The rules are pure (site-access.ts); this module reads the lists from storage on
// every call (so a revoke takes effect on the next message, with no reload) and answers one question for the router:
// may this sender start this message? The sender's origin comes from `sender`, which the browser sets. Nothing the
// page says is read.

import { type SiteEdit, type SiteLists, SITE_ACCESS_KEYS, applyEdit, decide, grantableOrigin } from "../site-access";
import { PAGE_STARTED_TYPES, RUN_TAB_TYPES } from "../page-relay";
import { isExtensionSender } from "./sw-consent";
import { getConfig } from "./sw-llm";
import { activeRuns } from "./sw-runs";

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
 * The router's gate. Null when the message may go on to its handler; otherwise the refusal to answer it with.
 *
 * Applies only to a type a page can start (`PAGE_STARTED_TYPES`) arriving from a tab that is not one of the
 * extension's own frames. While some of a background run's tools still run in the page (slice 2), a tab HOSTING one may
 * send what those tools send (`RUN_TAB_TYPES`), and nothing else: never run control, a model change, a session.
 * @param type the message type
 * @param sender the browser's facts about who sent it
 * @returns null to allow, or the refusal
 */
export async function pageRefusal(type: unknown, sender: chrome.runtime.MessageSender): Promise<string | null> {
    if (typeof type !== "string" || !PAGE_STARTED_TYPES.has(type)) return null;
    if (sender.tab == null || isExtensionSender(sender)) return null;
    // Before the origin is even read: a page a run is on (an unapproved site, or a local file the person started a run
    // on) runs that run's tools, and they send these. Its top frame only, and only what those tools send.
    if (RUN_TAB_TYPES.has(type) && (sender.frameId ?? 0) === 0 && sender.tab.id != null && activeRuns.has(sender.tab.id)) return null;
    const g = grantableOrigin({ origin: sender.origin, url: sender.url ?? sender.tab.url, frameId: sender.frameId });
    if ("refused" in g) return `Refused: ${g.refused}.`;
    const decision = await siteDecision(g.origin);
    if (decision === "always" || decision === "session") return null;
    return decision === "denied"
        ? `Refused: ${g.origin} is not allowed to use window.ml.`
        : `Refused: ${g.origin} is not approved to use window.ml. Allow it from the extension's toolbar button.`;
}
