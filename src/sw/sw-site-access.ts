// sw-site-access.ts — the background's half of "sites get window.ml only when someone said yes": the lists in
// storage, and the gate the router puts in front of every message a page starts.
//
// docs/spec/SITE_ACCESS.md, slice 1, and slice 3's levels (docs/spec/SITE_ACCESS_SLICE3.md, PR 1). The rules are pure (site-access.ts); this module reads the lists from storage on
// every call (so a revoke takes effect on the next message, with no reload) and answers one question for the router:
// may this sender start this message? The sender's origin comes from `sender`, which the browser sets. Nothing the
// page says is read.

import { type AgentLevel, type SenderFacts, type SiteEdit, type SiteLevels, type SiteLists, SITE_ACCESS_KEYS, SITE_SCHEMA, SITE_SCHEMA_KEY, applyEdit, grantableOrigin, levelsFor, migrateSiteLists, originOf, selfApproves } from "../site-access";
import { PAGE_STARTED_TYPES } from "../page-relay";
import { defineState } from "../state-registry";

const asList = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
const asLevels = (v: unknown): Record<string, AgentLevel> => {
    if (!v || typeof v !== "object" || Array.isArray(v)) return {};
    return Object.fromEntries(Object.entries(v as Record<string, unknown>).filter((e): e is [string, AgentLevel] => e[1] === "ask" || e[1] === "always" || e[1] === "denied"));
};
const none = (): Record<string, unknown> => ({});

/** The local key the migration leaves set when it moved a whitelist, so Settings shows its one-time notice until the
 *  person dismisses it. */
export const SITE_UPGRADE_NOTICE_KEY = "ml_site_upgrade_notice";

/** The lists as stored, without waiting for the migration: what the migration itself reads. */
async function readStored(): Promise<SiteLists> {
    const K = SITE_ACCESS_KEYS;
    const [local, session] = await Promise.all([
        chrome.storage.local.get([K.always, K.denied, K.agents, K.selfApprove]).catch(none),
        (chrome.storage.session?.get([K.session, K.agents]) ?? Promise.resolve({})).catch(none),
    ]);
    const s = session as Record<string, unknown>;
    return {
        always: asList(local[K.always]),
        denied: asList(local[K.denied]),
        session: asList(s[K.session]),
        // The session half is for origins allowed only this session; read over the local half.
        agents: { ...asLevels(local[K.agents]), ...asLevels(s[K.agents]) },
        selfApprove: asList(local[K.selfApprove]),
    };
}

/**
 * The agent levels split by where each is kept: an origin allowed only for this session keeps its level in session
 * storage, so the level goes with the approval at a browser restart; every other origin's is local.
 * @param lists the lists
 * @returns the two halves
 */
function agentHalves(lists: SiteLists): { local: Record<string, AgentLevel>; session: Record<string, AgentLevel> } {
    const local: Record<string, AgentLevel> = {}, session: Record<string, AgentLevel> = {};
    for (const [o, lv] of Object.entries(lists.agents)) (lists.session.includes(o) && !lists.always.includes(o) ? session : local)[o] = lv;
    return { local, session };
}

/**
 * Move an install's site lists to the slice 3 layout, once: the sync whitelist of hosts (`pageApprovalDomains`) becomes
 * local origins, and every origin allowed before gets the agent level "ask" (`migrateSiteLists`). Marked done by
 * `ml_site_schema: 2`, written in the same local write as the levels, so a worker that dies midway migrates again from
 * the same input. The sync setting is read and left in place, so another machine on an older build keeps working. The
 * gate's own three lists are not rewritten: they do not change, and an edit racing the migration must not be lost.
 * @returns whether this call migrated (false when the marker was already set)
 */
export async function migrateSiteAccess(): Promise<boolean> {
    const marker = await chrome.storage.local.get(SITE_SCHEMA_KEY).catch(none);
    if (typeof marker[SITE_SCHEMA_KEY] === "number" && (marker[SITE_SCHEMA_KEY] as number) >= SITE_SCHEMA) return false;
    const [stored, sync] = await Promise.all([readStored(), chrome.storage.sync.get({ pageApprovalDomains: [] }).catch(none)]);
    const syncHosts = (sync as Record<string, unknown>).pageApprovalDomains;
    const next = migrateSiteLists(stored, syncHosts);
    const halves = agentHalves(next);
    await chrome.storage.session?.set({ [SITE_ACCESS_KEYS.agents]: halves.session });
    const moved = Array.isArray(syncHosts) && syncHosts.length > 0;
    await chrome.storage.local.set({
        [SITE_ACCESS_KEYS.agents]: halves.local, [SITE_ACCESS_KEYS.selfApprove]: next.selfApprove,
        ...(moved ? { [SITE_UPGRADE_NOTICE_KEY]: true } : {}), [SITE_SCHEMA_KEY]: SITE_SCHEMA,
    });
    return true;
}

/** The migration of this worker's life, started by the first reader (and by background.ts at start). */
let schemaReady: Promise<unknown> | null = null;   // state: plumbing

/** Wait for the lists to be in this build's layout. A failed migration is tried again by the next reader; meanwhile the
 *  lists read as stored, which holds no self-approval and no agent level: the refusing side. */
export function siteSchemaReady(): Promise<unknown> {
    schemaReady ??= migrateSiteAccess().catch((e) => { schemaReady = null; return e; });
    return schemaReady;
}

/** The lists, as stored now, in this build's layout. A storage area that cannot be read counts as empty: refusing is
 *  the safe side. */
export async function readSiteLists(): Promise<SiteLists> {
    await siteSchemaReady();
    return readStored();
}

/**
 * Change the lists. Only the extension's own pages call this (the router checks), so a page can never approve itself.
 * An edit that names something other than an origin, as the browser writes one, is refused.
 * @param edit the change
 * @returns the lists after it
 */
export async function editSiteAccess(edit: SiteEdit): Promise<SiteLists> {
    if (!edit || typeof edit.origin !== "string" || originOf(edit.origin) !== edit.origin) throw new Error("not a site's origin");
    const next = applyEdit(await readSiteLists(), edit);
    const halves = agentHalves(next);
    await chrome.storage.local.set({
        [SITE_ACCESS_KEYS.always]: next.always, [SITE_ACCESS_KEYS.denied]: next.denied,
        [SITE_ACCESS_KEYS.agents]: halves.local, [SITE_ACCESS_KEYS.selfApprove]: next.selfApprove,
    });
    await chrome.storage.session?.set({ [SITE_ACCESS_KEYS.session]: next.session, [SITE_ACCESS_KEYS.agents]: halves.session });
    return next;
}

/** What the lists say about one origin: its three levels. */
export async function siteLevels(origin: string): Promise<SiteLevels> {
    return levelsFor(await readSiteLists(), origin);
}

/** What the lists say about one origin for window.ml (`levelsFor(...).use`), the self-approval list included. */
export async function siteDecision(origin: string): Promise<SiteLevels["use"]> {
    return (await siteLevels(origin)).use;
}

defineState({
    id: "site.levels", scope: "browser", realm: "worker", audience: "human", lostOn: ["browser-restart"],
    describe: "What the site in the run's tab may do: use window.ml (always, this session, denied), start agents, approve its own actions. Only a session approval and its agent level end with the browser; the rest persists.",
    read: async ({ tabId }) => {
        if (tabId == null) return undefined;
        const frame = await Promise.resolve(chrome.webNavigation?.getFrame?.({ tabId, frameId: 0 })).catch(() => null) as { url?: unknown } | null;
        const url = typeof frame?.url === "string" ? frame.url : (await Promise.resolve(chrome.tabs?.get?.(tabId)).catch(() => null))?.url;
        const origin = originOf(url);
        return origin ? { origin, ...levelsFor(await readSiteLists(), origin) } : undefined;
    },
});

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
 * Whether a sender may act as a site on the self-approval list (`ml_site_selfapprove`): `selfApproves` over the lists
 * as stored now. Every reader of the whitelist asks this: `senderTrust` for the privileged
 * handlers, and `pageApprovalAllowed` in the config a page or a run reads.
 * @param facts the sender's facts (`senderFacts`), or `{ url }` for a tab's top frame
 * @returns true when the sender self-approves
 */
export async function senderSelfApproves(facts: SenderFacts): Promise<boolean> {
    return selfApproves(await readSiteLists(), facts);
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
