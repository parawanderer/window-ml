// sw-start-approval.ts — the worker's half of "a site may start agents": the start card's asks, the approvals they
// leave, the page turn budget, and the refusals that follow a revoke.
//
// docs/spec/SITE_ACCESS_SLICE3.md, PR 2 (section 3 is the threat analysis). The pure rules (the refusal texts, what an
// approval is bound to, the card's lines) are agent-start.ts. What this module holds:
//
// - `approvals`: one per run a site started, in session storage (`ml_start_approved`), written before the run starts, so
//   an eviction between two turns loses nothing (3.5). Bound to the run's tab, its origin, and what was approved (Q3).
// - `pending`: the asks waiting on a card, in memory only. An eviction loses them, which denies (Q5).
// - `denials`: per origin, in session storage; three quiet the origin until the browser restarts or its level changes.
// - What the navigation rule needs (Q17): which document each live run started on, and the documents a tab committed
//   while a run was live on it.
// - The person's own turns (`notePersonTurn`): what the person sent through the extension for a run a page built, so
//   the page's relay of it is the person's turn and not one of the page's (Q2).

import { type StartBinding, PAGE_TURN_BUDGET, DEFAULT_TURN_STEPS, START_ASKS_MAX, START_ASK_TIMEOUT_MS, START_DENIALS_QUIET, START_REFUSED, bindingOf, cardToolLines, toolTexts, widening, OPENED_BY_AGENT_NOTE, CANCELLED_NO_LEVEL } from "../agent-start";
import { siteInstructions, textDigest } from "../agent/site-instructions";
import type { StartRunPayload } from "../contract/contract-messages";
import type { StartAsk } from "../contract/contract-agent";
import { defineState } from "../state-registry";
import { relayDebugEvent } from "./sw-debug";
import { editSiteAccess, siteLevels } from "./sw-site-access";
import { runInboxes } from "./sw-runs";

/** The session-storage key of the approvals. */
export const APPROVALS_KEY = "ml_start_approved";

/** The session-storage key of the denial counts. */
export const DENIALS_KEY = "ml_start_denials";

/** The session-storage key of the documents a running agent opened (Q17), so the rule outlives an eviction. */
export const OPENED_KEY = "ml_agent_opened";

/** One approval: a run a site started, on one tab, and what the person allowed it. */
export interface StartApproval {
    runId: string;
    tabId: number;
    origin: string;
    /** `agent`: the person allowed it on a card. `always`: it rode on the site's "always" level and was never shown; a
     *  site turned back to "ask" is asked again for it. */
    scope: "agent" | "always";
    /** Steps a turn, as approved. */
    budget: number;
    /** The page turn budget: page-sent turns allowed and used. */
    pageTurns: { allowed: number; used: number };
    bound: StartBinding;
    ts: number;
}

const approvals = new Map<string, StartApproval>();   // state: declared below (run.startApproval)
const denials = new Map<string, { count: number; level: string }>();   // state: declared below (site.startDenials)

/** An ask waiting for the person. */
interface PendingStart {
    ask: StartAsk;
    runId: string;
    tabId: number;
    origin: string;
    since: number;
    /** The document that asked, when the browser named it. */
    docId?: string;
    settle: (d: StartDecision) => void;
}

/** What the person (or the clock) answered. `gone`: the document that asked, or its tab, went away first. */
export type StartDecision = "allow" | "always" | "deny" | "timeout" | "gone";

const pending = new Map<string, PendingStart>();   // state: declared below (run.startAsk)

/** Writes to the two session keys, one after another. */
let writes: Promise<unknown> = Promise.resolve();   // state: plumbing

const none = (): Record<string, unknown> => ({});

/** The top-frame documents each tab committed while a run was live on it, each with the run that opened it. */
const agentOpened = new Map<number, Map<string, string>>();   // state: declared below (site.agentOpened)

/** Load what an earlier life of this worker stored, then drop what a revoke made while it was gone left behind. */
export const approvalsReady: Promise<void> = (async () => {
    // A module some unit tests load outside an extension (through sw-fetch.ts): nothing to read there.
    if (typeof chrome === "undefined") return;
    const got = await (chrome.storage?.session?.get([APPROVALS_KEY, DENIALS_KEY, OPENED_KEY]) ?? Promise.resolve({})).catch(none) as Record<string, unknown>;
    const a = got[APPROVALS_KEY], d = got[DENIALS_KEY], o = got[OPENED_KEY];
    if (o && typeof o === "object") for (const [tab, docs] of Object.entries(o as Record<string, Record<string, unknown>>)) {
        if (!docs || typeof docs !== "object") continue;
        const m = new Map<string, string>();
        for (const [doc, run] of Object.entries(docs)) if (typeof run === "string") m.set(doc, run);
        // Merged under what this worker already saw, which is newer.
        const had = agentOpened.get(Number(tab));
        agentOpened.set(Number(tab), had ? new Map([...m, ...had]) : m);
    }
    if (a && typeof a === "object") for (const [k, v] of Object.entries(a as Record<string, StartApproval>)) if (isApproval(v) && v.runId === k) approvals.set(k, v);
    if (d && typeof d === "object") for (const [k, v] of Object.entries(d as Record<string, { count: number; level: string }>)) if (v && typeof v.count === "number") denials.set(k, { count: v.count, level: String(v.level) });
    await dropRevoked().catch(() => { /* the next change tries again */ });
})();

/** Whether a stored value is an approval this build wrote. */
function isApproval(v: unknown): v is StartApproval {
    const a = v as StartApproval | null;
    return !!a && typeof a.runId === "string" && typeof a.tabId === "number" && typeof a.origin === "string"
        && (a.scope === "agent" || a.scope === "always") && !!a.pageTurns && typeof a.pageTurns.allowed === "number"
        && typeof a.pageTurns.used === "number" && !!a.bound && Array.isArray(a.bound.gated) && !!a.bound.tools && typeof a.bound.tools === "object";
}

/** Store both maps as they are now. */
function save(): Promise<void> {
    const run = writes.catch(() => undefined).then(() => chrome.storage?.session?.set({
        [APPROVALS_KEY]: Object.fromEntries(approvals), [DENIALS_KEY]: Object.fromEntries(denials),
        [OPENED_KEY]: Object.fromEntries([...agentOpened].map(([tab, docs]) => [String(tab), Object.fromEntries(docs)])),
    }));
    writes = run.catch(() => undefined);
    return run.then(() => undefined, () => undefined);
}

/** The approval of a run, if a site's start of it was allowed in this browser session. */
export function approvalFor(runId: string): StartApproval | undefined {
    return approvals.get(runId);
}

// --- hooks the router gives this module ---

let cancelRun: (runId: string) => void = () => { /* set by background.ts */ };   // state: plumbing (the router's hook)

/** The reason a run was cancelled for, when it was this module that cancelled it (Q9): its result's summary. */
export const cancelReasons = new Map<string, string>();   // state: plumbing (read once, at the run's end)

/**
 * Give this module what it needs from the router.
 * @param hooks `cancelRun` aborts a live run and closes its gates
 */
export function configureStartApproval(hooks: { cancelRun: (runId: string) => void }): void {
    cancelRun = hooks.cancelRun;
}

// --- the navigation rule (Q17) ---

/** The document each live run started on, for telling the page it started on from one it reached. */
const startDocs = new Map<string, { tabId: number; documentId?: string }>();   // state: plumbing (live runs only)


/** The starts the navigation rule refused, for the badge (PR 3): newest last, at most 50. */
const notStarted: { tabId: number; origin: string; runId: string; ts: number }[] = [];   // state: declared below (site.notStarted)

/**
 * A run went live on a tab: remember the document it started on.
 * @param runId the run
 * @param tabId its tab
 * @param documentId the top-frame document it started on, when known
 */
export function noteRunStart(runId: string, tabId: number, documentId: string | undefined): void {
    startDocs.set(runId, { tabId, ...(documentId ? { documentId } : {}) });
}

/** Tabs whose run's end is still being recorded (`noteRunEnd`): the navigation rule waits for it. */
const ending = new Map<number, Promise<void>>();   // state: plumbing (a few milliseconds)

/** The tab's top-frame document now, as the browser reports it. */
async function currentDoc(tabId: number): Promise<string | undefined> {
    const f = await Promise.resolve(chrome.webNavigation?.getFrame?.({ tabId, frameId: 0 })).catch(() => null) as { documentId?: string } | null;
    return typeof f?.documentId === "string" ? f.documentId : undefined;
}

/** Remember that a run opened a document of a tab ("*" for the whole tab, one the run created). */
function markOpened(tabId: number, doc: string, runId: string): void {
    let docs = agentOpened.get(tabId);
    if (!docs) { docs = new Map(); agentOpened.set(tabId, docs); }
    docs.set(doc, runId);
    if (docs.size > 64) docs.delete(docs.keys().next().value as string);
    void save();
}

/**
 * A run's turn ended. The document its tab shows now, when it is not the one the run started on, was reached by the
 * run however it got there (a commit this worker heard, or a prerendered page it activated, which fires no top-frame
 * commit), and is recorded as such.
 * @param runId the run
 */
export function noteRunEnd(runId: string): void {
    const start = startDocs.get(runId);
    startDocs.delete(runId);
    if (!start) return;
    const work = currentDoc(start.tabId).then((doc) => {
        if (doc && doc !== start.documentId && start.documentId) markOpened(start.tabId, doc, runId);
    }).finally(() => { if (ending.get(start.tabId) === work) ending.delete(start.tabId); });
    ending.set(start.tabId, work);
}

/**
 * Wait until what the navigation rule reads about a tab is settled: what an earlier life of the worker stored, and a
 * run's end being recorded.
 * @param tabId the tab
 */
export async function navigationSettled(tabId: number): Promise<void> {
    await approvalsReady;
    await ending.get(tabId)?.catch(() => undefined);
}

/** The live runs on a tab. */
const liveRunsOn = (tabId: number): string[] => [...runInboxes].filter(([, v]) => v.tabId === tabId).map(([k]) => k);

/** A top-frame commit: on a tab with a run live on it, that document was opened by the run; and a start card the tab's
 *  previous document raised is answered "gone", so nothing it asked for starts on the page that replaced it. */
function onCommit(d: { tabId: number; frameId: number; documentId?: string }): void {
    if (d.frameId !== 0 || typeof d.documentId !== "string") return;
    for (const p of [...pending.values()]) if (p.tabId === d.tabId && p.docId !== d.documentId) p.settle("gone");
    const live = liveRunsOn(d.tabId);
    if (live.length) markOpened(d.tabId, d.documentId, live[0]);
}
globalThis.chrome?.webNavigation?.onCommitted?.addListener?.(onCommit);
/** A tab a running agent's tab opened (a link its click followed into a new tab, a `window.open`): the agent's. */
globalThis.chrome?.webNavigation?.onCreatedNavigationTarget?.addListener?.((d: { sourceTabId: number; tabId: number }) => {
    const live = liveRunsOn(d.sourceTabId);
    if (live.length) markOpened(d.tabId, "*", live[0]);
});
globalThis.chrome?.tabs?.onCreated?.addListener?.((t: chrome.tabs.Tab) => {
    const live = t.openerTabId != null && t.id != null ? liveRunsOn(t.openerTabId) : [];
    if (live.length && t.id != null) markOpened(t.id, "*", live[0]);
});
globalThis.chrome?.tabs?.onRemoved?.addListener?.((tabId: number) => {
    for (const p of [...pending.values()]) if (p.tabId === tabId) p.settle("gone");
    let dropped = agentOpened.delete(tabId);
    for (const [k, v] of approvals) if (v.tabId === tabId) { approvals.delete(k); dropped = true; }
    if (dropped) void save();
});

/**
 * A tab a run opened for itself (a `fetch_url` render): nothing in it may start an agent.
 * @param tabId the tab
 * @param runId the run, or "" when the caller does not know it
 */
export function noteAgentTab(tabId: number, runId: string): void {
    markOpened(tabId, "*", runId);
}

/**
 * The run whose navigation reached this document, if one did and it may not act here: while a run is live on the tab,
 * any document other than the one it started on (a run this worker did not see start, resumed after an eviction, has no
 * start page at all); and after, a document the run reached, for anything but that run's own next turn, which its
 * approval decides. A tab a run opened (a new tab its click opened, a render) is the run's whole. Null for a page that
 * was not reached that way. Call `navigationSettled` first.
 * @param tabId the sender's tab
 * @param documentId the sender's document, as the browser stamped it
 * @param runId the run the message names, if any
 * @returns the run, "" when the run that opened it has ended, or null
 */
export function openedByRun(tabId: number, documentId: string | undefined, runId?: unknown): string | null {
    const live = liveRunsOn(tabId);
    for (const r of live) {
        const start = startDocs.get(r);
        if (!start) return r;
        if (start.documentId && documentId && start.documentId !== documentId) return r;
    }
    const docs = agentOpened.get(tabId);
    const opener = (documentId ? docs?.get(documentId) : undefined) ?? docs?.get("*");
    if (opener === undefined) return null;
    if (!live.length && runId === opener && opener) return null;
    return live.includes(opener) ? opener : (live[0] ?? opener ?? "");
}

/**
 * Record a start a page reached by a running agent asked for, and show it in that run's step list as one quiet line.
 * Nothing reaches the driver model: the line is a session notice, never a message.
 * @param tabId the tab
 * @param runId the run whose navigation reached the page ("" when it has ended)
 * @param origin the asking page's origin
 */
export function recordNotStarted(tabId: number, runId: string, origin: string): void {
    const now = Date.now();
    // One line per site and run a minute: a page that floods its starts does not flood the driver's steps.
    const again = notStarted.some((n) => n.runId === runId && n.origin === origin && now - n.ts < 60_000);
    notStarted.push({ tabId, origin, runId, ts: now });
    if (notStarted.length > 50) notStarted.shift();
    if (!runId || again) return;
    fan(tabId, { kind: "agent-note", id: runId, ts: Date.now(), save: false, session: { hash: runId, turn: 0 }, text: OPENED_BY_AGENT_NOTE, site: origin });
}

/**
 * Stop a site's run the way the person's Stop does (its controller and its open gates), for a page that ended its turn
 * waiting for the person (Q2b).
 * @param runId the run
 */
export function stopForPerson(runId: string): void {
    cancelRun(runId);
}

// --- the person's own turns ---

/** What the person sent through the extension for a run a page built, waiting for the page to relay it. */
const personTurns = new Map<string, { text: string; images: string; budget?: number; ts: number }[]>();   // state: declared below (run.personTurn)

/** How long a person's message waits for the page to relay it. */
const PERSON_TURN_TTL_MS = 120_000;

/**
 * The person sent a message (or Continue, with empty text) through the extension for a run a page built. The page's
 * relay of exactly this text and these images is the person's turn: unlabelled, not drawn from the page turn budget,
 * and run at the step budget the person chose (their Continue's), never one the page names.
 * @param runId the run
 * @param text the text the page will relay, as the page frames it
 * @param images the images the person attached, which the page relays with it
 * @param budget the steps a turn the person chose, when they chose one
 */
export async function notePersonTurn(runId: string, text: string, images: readonly unknown[] = [], budget?: number): Promise<void> {
    const digest = await imagesDigest(images);
    const now = Date.now();
    const list = (personTurns.get(runId) ?? []).filter((t) => now - t.ts < PERSON_TURN_TTL_MS).slice(-4);
    list.push({ text, images: digest, ...(budget ? { budget } : {}), ts: now });
    personTurns.set(runId, list);
}

/**
 * One digest of a turn's images, so the person's turn is theirs only with the pictures they attached.
 * @param images the images (data URLs)
 * @returns the digest, empty for none
 */
export async function imagesDigest(images: readonly unknown[] | undefined): Promise<string> {
    return images?.length ? textDigest(images.map((x) => String(x)).join("\n")) : "";
}

/** The person's turn a page relayed: the step budget they chose, and the page's own text it was folded behind (a
 *  `say()` the page queued while idle is sent ahead of the next turn's text), which stays the page's. */
export interface PersonTurn { budget?: number; pagePrefix?: string }

/** Messages whose person's turn the router spent (the navigation rule), so the run host takes them as the person's. */
const claimedMessages = new WeakMap<object, PersonTurn>();   // state: plumbing (one message's life)

/**
 * At the router: spend the person's turn this message relays, once, and remember the message as theirs. A page that sends
 * the same text twice gets one person's turn and one refusal.
 * @param message the page's message
 * @returns true when it carried the person's turn
 */
export async function claimPersonTurn(message: { type?: unknown; payload?: { runId?: unknown; task?: unknown; text?: unknown; images?: unknown } }): Promise<boolean> {
    const p = message.payload;
    const text = message.type === "INJECT_MESSAGE" ? p?.text : p?.task;
    if (typeof p?.runId !== "string" || typeof text !== "string") return false;
    const turn = takePersonTurn(p.runId, text, await imagesDigest(Array.isArray(p.images) ? p.images : undefined));
    if (!turn) return false;
    claimedMessages.set(message as object, turn);
    return true;
}

/** The person's turn the router already spent for this message, if it did. */
export function personClaimed(message: object): PersonTurn | undefined {
    return claimedMessages.get(message);
}

/**
 * Spend the person's turn that matches what a page sent, if there is one: exactly their text, or their text after the
 * page's own folded ahead of it; and exactly their images.
 * @param runId the run
 * @param text what the page sent
 * @param images the digest of the images it sent with it (`imagesDigest`)
 * @returns the person's turn, or null when this is not one
 */
export function takePersonTurn(runId: string, text: string, images = ""): PersonTurn | null {
    const now = Date.now();
    const list = (personTurns.get(runId) ?? []).filter((t) => now - t.ts < PERSON_TURN_TTL_MS);
    const i = list.findIndex((t) => t.images === images && (t.text === text || (t.text !== "" && text.endsWith(`\n\n${t.text}`))));
    if (i < 0) { personTurns.set(runId, list); return null; }
    const t = list[i];
    list.splice(i, 1);
    if (list.length) personTurns.set(runId, list); else personTurns.delete(runId);
    const prefix = t.text === text ? "" : text.slice(0, text.length - t.text.length - 2);
    return { ...(t.budget ? { budget: t.budget } : {}), ...(prefix ? { pagePrefix: prefix } : {}) };
}

/**
 * Give back a person's turn a page relayed, when the turn it was spent on was refused after all (the run was busy).
 * @param runId the run
 * @param text the person's text
 * @param turn what was spent
 */
async function refundPersonTurn(runId: string, text: string, turn: PersonTurn, images: string): Promise<void> {
    const list = personTurns.get(runId) ?? [];
    const own = turn.pagePrefix ? text.slice(turn.pagePrefix.length + 2) : text;
    list.push({ text: own, images, ...(turn.budget ? { budget: turn.budget } : {}), ts: Date.now() });
    personTurns.set(runId, list);
}

// --- the gate ---

/** Fan a site-run notice to every surface showing the tab's runs: the card or overlay, and a DevTools panel. Never
 *  the session index or the replay buffer: an ask is live, and a page can read the replay back (`DUMP_EVENTS`). */
function fan(tabId: number, event: Record<string, unknown>): void {
    chrome.tabs.sendMessage(tabId, { type: "ML_DEBUG_TO_PAGE", event }).catch(() => { /* tab gone */ });
    relayDebugEvent(tabId, event);
}

/** A run of this tab a site started, as the gate needs to know it. */
export interface PageTurn {
    type: "START_RUN" | "RESUME_RUN" | "INJECT_MESSAGE";
    runId: string;
    tabId: number;
    /** The sender's origin, as the origin gate read it. */
    origin: string;
    /** The turn's text (the task, the follow-up, the steer). */
    text: string;
    /** The run's payload: this turn's for a START_RUN, the stored one otherwise. */
    p: Pick<StartRunPayload, "tools" | "model" | "systemPrompt" | "maxSteps" | "crossOrigin">;
    /** The model the worker resolves for it (the payload's, else the configured one). */
    model: string | null;
    /** The START_RUN carried a history of the page's. */
    pageHistory: boolean;
    /** The worker holds this run's history (it ran a turn of it before). */
    known: boolean;
    /** The images the turn attaches. */
    images?: readonly unknown[];
    /** The person's turn the router already spent for this very message (`claimPersonTurn`). */
    personClaimed?: PersonTurn;
    /** The document that sent the turn, when the browser named it: a card it raised is for it alone. */
    docId?: string;
    /** The site's own tools' texts (`ourToolTexts`), quoted on the card with its other instructions. */
    siteTools?: string;
    /** The resolved model passes the model filter; a start the filter would refuse is refused before any card. */
    modelRefusal?: string | null;
}

/** What the gate decided for a turn: refused, or allowed. `person`: it is the person's turn (unlabelled, not counted),
 *  with `budget` the steps it runs at and `pagePrefix` the page's own text folded ahead of it. `refund` gives back what
 *  the turn spent, for a caller that refuses it after all (the run turned out busy). */
export type TurnVerdict = { error: string } | { person: boolean; first: boolean; budget?: number; pagePrefix?: string; refund: () => Promise<void> };

/**
 * Decide one page-sent turn of a run a site starts or drives: START_RUN, RESUME_RUN or a steer (INJECT_MESSAGE). Reads
 * the site's agent level live; on "ask" raises the start card when the run has no approval, when the turn widens what
 * was approved (Q3), or when the page has used its page turn budget (Q2); writes the approval before answering.
 * @param t the turn
 * @returns the verdict
 */
export async function gatePageTurn(t: PageTurn): Promise<TurnVerdict> {
    await approvalsReady;
    const level = (await siteLevels(t.origin)).agents;
    const levelRefusal = (): string | null => level === "denied" ? START_REFUSED.denied(t.origin)
        : level === "off" ? (t.type === "START_RUN" ? START_REFUSED.noLevelStart(t.origin) : START_REFUSED.noLevel(t.origin)) : null;
    const refused = levelRefusal();
    if (refused) return { error: refused };
    let rec = approvals.get(t.runId);
    if (rec && rec.origin !== t.origin) return { error: START_REFUSED.otherSite(t.runId) };
    if (rec && rec.tabId !== t.tabId) return { error: `Run "${t.runId}" belongs to another tab.` };
    const first = t.type === "START_RUN" && !rec && !t.known;
    if (first && t.pageHistory) return { error: START_REFUSED.firstTurnHistory };
    if (t.modelRefusal) return { error: t.modelRefusal };
    const imageDigest = await imagesDigest(t.images);
    const personTurn = first ? null : (t.personClaimed ?? takePersonTurn(t.runId, t.text, imageDigest));
    const person = !!personTurn;
    const names = t.p.tools.map((x) => x.name);
    const asked = typeof t.p.maxSteps === "number" ? t.p.maxSteps : DEFAULT_TURN_STEPS;
    // The person's turn runs at the budget THEY chose (their Continue's), else the approved one: never the page's number.
    const budget = person && rec ? Math.max(rec.bound.budget, personTurn?.budget ?? 0) : asked;
    // What the site wrote that the model reads: its part of the system prompt, and its own tools' texts (S2, owner 2026-10-14).
    const written = [siteInstructions(t.p.systemPrompt, names), t.siteTools ?? ""].filter(Boolean).join("\n\n");
    const facts = { instructions: await textDigest(written), tools: await toolTexts(t.p.tools, textDigest), crossOrigin: !!t.p.crossOrigin, budget };
    // A START_RUN is a whole new payload; a RESUME_RUN or a steer carries only a step budget of its own.
    const bound = t.type === "START_RUN" || !rec ? bindingOf(t.p.tools, t.model, facts) : { ...rec.bound, budget };
    // The person's own budget is theirs to raise: only the rest of the turn is held to the approval.
    const compared = person && rec ? { ...bound, budget: rec.bound.budget } : bound;
    const pageTurn = !first && !person;
    const verdict = (): TurnVerdict => ({ person, first, ...(person ? { budget } : {}), ...(personTurn?.pagePrefix ? { pagePrefix: personTurn.pagePrefix } : {}),
        refund: async () => {
            if (personTurn) await refundPersonTurn(t.runId, t.text, personTurn, imageDigest);
            const a = approvals.get(t.runId);
            if (pageTurn && a && a.pageTurns.used > 0) { approvals.set(t.runId, { ...a, pageTurns: { ...a.pageTurns, used: a.pageTurns.used - 1 } }); await save(); }
        } });
    if (level === "always") {
        // An approval the person made on a card covers only what the card showed: a widening that rides on "always"
        // makes it one that rode on "always", so a site turned back to "ask" is asked again for it.
        const scope = rec && rec.scope === "agent" && widening(rec.bound, compared) ? "always" : rec?.scope ?? "always";
        approvals.set(t.runId, rec
            ? { ...rec, scope, bound, budget, pageTurns: { ...rec.pageTurns, used: rec.pageTurns.used + (pageTurn ? 1 : 0) } }
            : { runId: t.runId, tabId: t.tabId, origin: t.origin, scope: "always", budget, pageTurns: { allowed: PAGE_TURN_BUDGET, used: 0 }, bound, ts: Date.now() });
        await save();
        return verdict();
    }
    // "ask"
    const widened = rec ? widening(rec.bound, compared) : null;
    const kind: StartAsk["kind"] | null = !rec || rec.scope === "always" ? "start"
        : widened ? "change"
        : pageTurn && rec.pageTurns.used >= rec.pageTurns.allowed ? "more" : null;
    if (!kind) {
        if (rec) { rec = { ...rec, bound: person ? { ...rec.bound, budget } : rec.bound, pageTurns: { ...rec.pageTurns, used: rec.pageTurns.used + (pageTurn ? 1 : 0) } }; approvals.set(t.runId, rec); await save(); }
        return verdict();
    }
    if ((denials.get(t.origin)?.count ?? 0) >= START_DENIALS_QUIET) return { error: START_REFUSED.quieted };
    if ([...pending.values()].some((x) => x.origin === t.origin && x.tabId === t.tabId)) return { error: START_REFUSED.waiting };
    if (pending.size >= START_ASKS_MAX) return { error: START_REFUSED.tooMany };
    const ask: StartAsk = {
        requestId: crypto.randomUUID(), kind, origin: t.origin, task: t.text,
        ...(written ? { instructions: written, ...(widened?.instructions ? { instructionsNew: true } : {}) } : {}),
        lines: cardToolLines(t.p.tools, { crossOrigin: !!t.p.crossOrigin }, widened ? { gated: [...widened.gated, ...(widened.crossOrigin ? ["navigate"] : [])], server: widened.server } : {}),
        model: t.model, ...(widened?.model ? { modelNew: true } : {}), ...(widened?.budget ? { budgetNew: true } : {}), budget, pageTurns: PAGE_TURN_BUDGET,
        ...(kind === "more" && rec ? { used: rec.pageTurns.used, allowed: rec.pageTurns.allowed, asks: 1 } : {}),
        ...(t.images?.length ? { images: t.images.length } : {}),
        // Tools the page runs itself (every one that is not a server tool): only then does the card say the page decides
        // what they do.
        ...(t.p.tools.some((x) => !x.remote) ? { pageTools: true } : {}),
        since: Date.now(), expiresMs: START_ASK_TIMEOUT_MS,
    };
    const decision = await askPerson(ask, t);
    // The document that asked went away, or its tab closed: nothing it asked for starts. Not counted as a denial.
    if (decision === "gone") return { error: START_REFUSED.unanswered };
    if (decision === "deny" || decision === "timeout") {
        const lv = String(level);
        const d = denials.get(t.origin);
        denials.set(t.origin, { count: (d && d.level === lv ? d.count : 0) + 1, level: lv });
        await save();
        return { error: decision === "timeout" ? START_REFUSED.unanswered : kind === "more" ? START_REFUSED.moreDeclined(rec?.pageTurns.allowed ?? PAGE_TURN_BUDGET) : START_REFUSED.declined };
    }
    if (decision === "always") await editSiteAccess({ op: "agents", origin: t.origin, level: "always" }).catch(() => undefined);
    // Asked again after the wait: the tab must still show the document that asked (a navigation the worker did not hear
    // as a commit, a prerender activated); a revoke while the card was up wins.
    if (t.docId) {
        const doc = await currentDoc(t.tabId);
        if (doc && doc !== t.docId) return { error: START_REFUSED.unanswered };
    }
    const now = (await siteLevels(t.origin)).agents;
    if (now !== "ask" && now !== "always") return { error: now === "denied" ? START_REFUSED.denied(t.origin) : t.type === "START_RUN" ? START_REFUSED.noLevelStart(t.origin) : START_REFUSED.noLevel(t.origin) };
    const prev = approvals.get(t.runId);
    const turns = kind === "more" && prev ? { allowed: prev.pageTurns.allowed + PAGE_TURN_BUDGET, used: prev.pageTurns.used + 1 }
        : kind === "change" && prev ? { ...prev.pageTurns, used: prev.pageTurns.used + (pageTurn ? 1 : 0) }
        : { allowed: PAGE_TURN_BUDGET, used: 0 };
    approvals.set(t.runId, { runId: t.runId, tabId: t.tabId, origin: t.origin, scope: "agent", budget, pageTurns: turns, bound, ts: Date.now() });
    await save();
    return verdict();
}

/**
 * Raise a start card and wait for the person: their answer, or a timeout after `START_ASK_TIMEOUT_MS`. The card is the
 * worker's snapshot; a decision names its request id, which never reaches the page.
 * @param ask the card's content
 * @param t the turn it is for
 * @returns the decision
 */
function askPerson(ask: StartAsk, t: PageTurn): Promise<StartDecision> {
    return new Promise<StartDecision>((resolve) => {
        // TEST-ONLY: a vm test shortens the wait through a worker global no page can reach (like `__mlApprovals`).
        const wait = (globalThis as { __mlStartAskTimeoutMsForTest?: number }).__mlStartAskTimeoutMsForTest ?? START_ASK_TIMEOUT_MS;
        // Unref'd: this is a BACKSTOP (an unanswered card counts as Deny), not work the process is waiting on.
        // A test that raises a card and leaves it pending used to hold the Node process for the full three minutes
        // after its last assertion (redteam-agent-level: 1.8s of tests, 181s of wall clock, one uncleared timer).
        // Same distinction as page-reachable's `defaultSleep`. A caller still awaiting the decision keeps the
        // process alive through the runner's pending test; the timer still fires if anything else holds the loop.
        const timer = setTimeout(() => settle("timeout"), wait) as unknown as { unref?: () => void };
        timer.unref?.();
        const settle = (d: StartDecision): void => {
            if (!pending.has(ask.requestId)) return;
            pending.delete(ask.requestId);
            clearTimeout(timer as Parameters<typeof clearTimeout>[0]);
            fan(t.tabId, { kind: "agent-start-decided", id: t.runId, ts: Date.now(), save: false, session: { hash: t.runId, turn: 0 }, requestId: ask.requestId,
                outcome: d === "allow" || d === "always" ? "allowed" : d === "deny" ? "denied" : "expired" });
            resolve(d);
        };
        pending.set(ask.requestId, { ask, runId: t.runId, tabId: t.tabId, origin: t.origin, since: ask.since, ...(t.docId ? { docId: t.docId } : {}), settle });
        fan(t.tabId, { kind: "agent-start-ask", id: t.runId, ts: Date.now(), save: false, session: { hash: t.runId, turn: 0 }, ask });
    });
}

/**
 * The person's answer to a start card (SET_START_APPROVAL). Only the extension's own surfaces send it: the card's frame
 * through the shell's private port, or the DevTools panel. An answer for an ask this worker no longer holds changes
 * nothing.
 * @param requestId the ask
 * @param decision `allow` this agent, `always` allow the site's agents, or `deny`
 * @param fromTabId the tab the decision came from, when it came from a tab (the shell): it must be the ask's
 * @returns whether an ask was answered
 */
export function resolveStart(requestId: unknown, decision: unknown, fromTabId?: number): boolean {
    if (typeof requestId !== "string") return false;
    const p = pending.get(requestId);
    if (!p || (fromTabId != null && fromTabId !== p.tabId)) return false;
    if (decision !== "allow" && decision !== "always" && decision !== "deny") return false;
    p.settle(decision);
    return true;
}

/**
 * End every start card waiting on a run the person stopped (CANCEL_RUN, or a revoke that cancels it): the card
 * goes away as `gone` — what it asked for does not start, and it is not counted as a denial (the person stopped
 * the start, they did not refuse the site).
 * @param runId the run whose starts to end
 */
export function cancelStarts(runId: string): void {
    for (const [, p] of [...pending]) if (p.runId === runId) p.settle("gone");
}

/** End every start card still up (CANCEL_ALL_RUNS). Same as {@link cancelStarts}, for every run at once. */
export function cancelAllStarts(): void {
    for (const [, p] of [...pending]) p.settle("gone");
}

/** The asks waiting now, for a surface that opens after one was raised (the DevTools panel replays its buffer). */
export function pendingStarts(): StartAsk[] {
    return [...pending.values()].map((p) => p.ask);
}

// --- revokes (3.4, Q9) ---

/**
 * Drop every approval whose site lost the agent level or window.ml, and cancel the live runs of a site that may still
 * use window.ml but no longer start agents (Q9). A site revoked whole is handed to the worker instead (nav-handover.ts),
 * so only its approvals go. Denial counts of a site whose level changed are reset (Q8). Called on every change to the
 * lists and at worker start.
 */
export async function dropRevoked(): Promise<void> {
    let changed = false;
    for (const [runId, a] of [...approvals]) {
        const lv = await siteLevels(a.origin);
        const mayUse = lv.use === "always" || lv.use === "session";
        if (mayUse && (lv.agents === "ask" || lv.agents === "always")) continue;
        approvals.delete(runId);
        changed = true;
        if (mayUse && runInboxes.has(runId)) { cancelReasons.set(runId, CANCELLED_NO_LEVEL); cancelRun(runId); }
    }
    for (const [origin, d] of [...denials]) {
        if (String((await siteLevels(origin)).agents) !== d.level) { denials.delete(origin); changed = true; }
    }
    if (changed) await save();
}

// --- what the state inspector reads ---

defineState({
    id: "run.startAsk", scope: "run", realm: "worker", audience: "human", lostOn: ["worker-eviction"],
    describe: "A site's request to start, widen or keep driving this agent, waiting for your answer on the start card. A worker restart loses it, which counts as Deny.",
    read: ({ runId }) => {
        const p = [...pending.values()].find((x) => x.runId === runId);
        return p && { origin: p.origin, since: p.since, kind: p.ask.kind, budget: p.ask.budget, pageTurns: p.ask.pageTurns };
    },
});

defineState({
    id: "run.startApproval", scope: "session", realm: "worker", audience: "human", lostOn: ["browser-restart"],
    describe: "What you allowed a site's agent: its tab, its site, its step budget, the page turns it may still send, and the tools, model and instructions the approval covers.",
    read: ({ runId }) => {
        const a = runId ? approvals.get(runId) : undefined;
        return a && { origin: a.origin, scope: a.scope, budget: a.budget, pageTurns: { ...a.pageTurns }, bound: { ...a.bound, gated: [...a.bound.gated], server: [...a.bound.server] } };
    },
});

defineState({
    id: "site.startDenials", scope: "browser", realm: "worker", audience: "human", lostOn: ["browser-restart"],
    describe: "How many agent starts each site has had declined or left unanswered this browser session; at three its starts are refused without a card.",
    read: () => Object.fromEntries([...denials].map(([o, d]) => [o, d.count])),
});

defineState({
    id: "run.personTurn", scope: "run", realm: "worker", audience: "human", lostOn: ["worker-eviction"],
    describe: "Messages you sent this site's agent that its page has not passed on yet; the page's copy of one counts as yours.",
    read: ({ runId }) => { const l = runId ? personTurns.get(runId) : undefined; return l?.length ? l.map((x) => ({ text: x.text, ts: x.ts, ...(x.budget ? { budget: x.budget } : {}) })) : undefined; },
});

defineState({
    id: "site.agentOpened", scope: "tab", realm: "worker", audience: "human", lostOn: ["browser-restart"],
    describe: "The pages a running agent opened in this tab; none of them may start an agent.",
    read: ({ tabId }) => { const m = tabId != null ? agentOpened.get(tabId) : undefined; return m?.size ? m.size : undefined; },
});

defineState({
    id: "site.notStarted", scope: "tab", realm: "worker", audience: "human", lostOn: ["worker-eviction"],
    describe: "Agent starts refused because a running agent opened the page that asked.",
    read: ({ tabId }) => { const l = notStarted.filter((x) => x.tabId === tabId); return l.length ? l.map((x) => ({ origin: x.origin, ts: x.ts })) : undefined; },
});
