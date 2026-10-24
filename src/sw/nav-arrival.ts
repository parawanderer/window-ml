// nav-arrival.ts — judges every page a live run's tab commits, as the `fetch` consumer in its interactive mode, before the run re-adopts there.

// docs/spec/POLICIES.md, "A navigation the model did not name is judged on arrival" (ruled 2026-10-24). A click, a
// redirect or a timer can move the tab where no card before the act could see, so the rule is enforced where every
// cause meets: the browser's own report of the commit (`webNavigation.onCommitted`, which no page can stop or fake).
// Each live hosted run registers a judge for its tab (`watchArrivals`); the commit runs them, in order per tab, and a
// run left on a page it may not act on is HELD (`arrivalHold`). The run host reads the hold before anything of the run
// reaches the page: the re-adopt (CONTENT_READY), every send to the tab, every tool. Only the run host clears it.
//
// A hold is the SESSION's, not the turn's: a run that ends its turn on a page it is held on is not re-adopted there,
// and its next turn judges the tab's page again before anything of it runs. Held in worker memory, as the hand-over's
// decision is: an evicted worker forgets it, and a run resurrected after an eviction is judged again on the page it
// wakes on (sw-run-host.ts).

import { judgeCall, navigateFacts, policiesReady, speakable, type PolicyJudgement } from "./sw-policies";

/** Why a run may not act on the page its tab holds: a policy denies it, or asks about it and the person has not answered. */
export type ArrivalHold =
    | { kind: "deny"; url: string; label: string }
    | { kind: "ask"; url: string; origin: string; label?: string };

/** What a judged arrival comes to: held, let through with its origin consented, or let through as it is. */
export type ArrivalVerdict = ArrivalHold | { kind: "allow"; origin: string } | { kind: "pass" };

/** A run's judge for its tab's arrivals. */
type Judge = (url: string) => void | Promise<void>;

const judges = new Map<number, Map<string, Judge>>();   // state: plumbing — the live runs watching each tab, gone with each turn
const pending = new Map<number, Promise<void>>();   // state: plumbing — the arrival judgement in flight for each tab
const lastJudged = new Map<number, string>();   // state: plumbing — the URL each tab's last arrival was judged for, so a re-adopt does not judge it twice
const holds = new Map<string, ArrivalHold>();   // state: plumbing — the runs held on the page their tab holds, by run, until the session is released

/**
 * Judge each arrival of the run's tab while the run is live.
 * @param tabId the run's tab
 * @param runId the run
 * @param judge decides the arrival and holds or clears the run (`holdArrival`, `clearArrival`)
 * @returns stops watching; the run's hold stays, for its next turn
 */
export function watchArrivals(tabId: number, runId: string, judge: Judge): () => void {
    let m = judges.get(tabId);
    if (!m) { m = new Map(); judges.set(tabId, m); }
    m.set(runId, judge);
    return () => {
        const now = judges.get(tabId);
        if (now?.get(runId) === judge) { now.delete(runId); if (!now.size) judges.delete(tabId); }
    };
}

/**
 * The tab committed `url` in its top frame: judge it for every live run on the tab, queued behind any judgement already
 * in flight for the tab, so two never interleave.
 * @param tabId the tab
 * @param url the URL of the committed document, as the browser reported it
 * @param again judge it even when it is the URL this tab was last judged for (a commit is always new; a re-adopt is not)
 */
export function judgeArrival(tabId: number, url: string | undefined, again = true): Promise<void> {
    const prior = pending.get(tabId) ?? Promise.resolve();
    const next = prior.catch(() => {}).then(async () => {
        if (!again && lastJudged.get(tabId) === (url ?? "")) return;
        lastJudged.set(tabId, url ?? "");
        const runs = [...(judges.get(tabId)?.values() ?? [])];
        if (!runs.length) return;
        // A judgement before the person's policies are read would ask about every page: wait for the read.
        await policiesReady.catch(() => {});
        for (const judge of runs) await Promise.resolve().then(() => judge(url ?? "")).catch(() => {});   // a throw, sync or not, stops only its own run's judge
    });
    pending.set(tabId, next);
    void next.finally(() => { if (pending.get(tabId) === next) pending.delete(tabId); });
    return next;
}

/** Wait for the tab's arrival judgement in flight, if any. */
export async function arrivalSettled(tabId: number): Promise<void> { await pending.get(tabId)?.catch(() => {}); }

/** The hold on a run, if it may not act on the page its tab holds. */
export const arrivalHold = (runId: string): ArrivalHold | undefined => holds.get(runId);

/** Hold a run on the page its tab holds. */
export function holdArrival(runId: string, hold: ArrivalHold): void { holds.set(runId, hold); }

/** Let a run act on the page its tab holds again; also called when its session is released (`releaseSessionTokens`). */
export function clearArrival(runId: string): void { holds.delete(runId); }

/**
 * Whether a run's hold still stands on the page its tab holds now, judged again: for a turn the person starts after one
 * that ended held, when no judge watched the tab in between (they may have gone back by hand).
 * @param tabId the run's tab
 * @param runId the run
 * @returns true when the page would hold the run again; false when it is not held, or the page no longer holds it
 */
export async function holdStands(tabId: number, runId: string): Promise<boolean> {
    if (!holds.has(runId)) return false;
    await policiesReady.catch(() => {});
    const url = (await Promise.resolve(chrome.tabs.get(tabId)).catch(() => undefined))?.url ?? "";
    const v = arrivalVerdict(url, judgeCall(runId, "fetch", navigateFacts(url)));
    return v.kind === "deny" || v.kind === "ask";
}

/** Forget a closed tab. */
export function forgetArrivalTab(tabId: number): void { lastJudged.delete(tabId); }

/**
 * What an arrival comes to, from its judgement as the `fetch` consumer with `navigateFacts`. A `deny` holds the run. An
 * `ask` holds it until the person answers, a consented origin included: the policy asks about the page, not about the
 * origin. An `allow` row lets it through and consents the origin for navigation and uncredentialed reads (never as the
 * person: ruling (b)). Anything else, the builtin answer or none, lets it through as it is: no card before the act was
 * owed for it either, and it consents nothing.
 * @param url the committed URL
 * @param j its judgement
 * @returns the verdict
 */
export function arrivalVerdict(url: string, j: PolicyJudgement): ArrivalVerdict {
    let dest: URL;
    try { dest = new URL(url); } catch { return { kind: "pass" }; }
    // Only a page read over the network is a fetch: an error page, about:blank or a local file is no policy's to judge.
    if (dest.protocol !== "http:" && dest.protocol !== "https:") return { kind: "pass" };
    const by = j.by && j.by !== "builtin" ? j.by : undefined;
    if (j.decision === "deny" && by) return { kind: "deny", url: dest.href, label: speakable(by.label) };
    // An `ask` with no policy behind it is the store that could not be read: a saved `deny` may be missing.
    if (j.decision === "ask") return { kind: "ask", url: dest.href, origin: dest.origin, ...(by ? { label: speakable(by.label) } : {}) };
    if (j.decision === "allow" && by) return { kind: "allow", origin: dest.origin };
    return { kind: "pass" };
}

/** The card's line for a hold (approved strings, 2026-10-24). */
export function arrivalLine(h: ArrivalHold): string {
    if (h.kind === "deny") return `The run arrived on ${h.url}, which the policy "${h.label}" denies. Nothing of the run runs on this page.`;
    return h.label !== undefined
        ? `The run arrived on ${h.origin}, a page it did not open by name. Asking because the policy "${h.label}" asks about pages like this.`
        : `The run arrived on ${h.origin}, a page it did not open by name. Asking because the saved policies could not be read.`;
}

/** What the model reads of a deny hold, as every call's result while it lasts. */
export const arrivalDeniedText = (h: Extract<ArrivalHold, { kind: "deny" }>): string =>
    `The tab is now on ${h.url}, which the policy "${h.label}" denies: no tool runs on this page. The person was asked to go back or end the run.`;

/**
 * What the model reads once the person answered an ask hold.
 * @param h the hold
 * @param approved the person's answer
 * @param note what the person said with a denial
 */
export function arrivalAnsweredText(h: Extract<ArrivalHold, { kind: "ask" }>, approved: boolean, note?: string): string {
    const why = h.label !== undefined ? `, which the policy "${h.label}" asks about` : "";
    if (approved) return `The tab moved to ${h.origin}, a page the run did not open by name${why}. The person approved the run acting on it.`;
    return `The tab moved to ${h.origin}, a page the run did not open by name${why}. The person declined, and the tab went back to the page before.${note ? ` They said: ${note}` : ""}`;
}

/** What the model reads of a call that met an ask hold before the person answered it. */
export const arrivalWaitingText = (h: Extract<ArrivalHold, { kind: "ask" }>): string =>
    `The tab moved to ${h.origin}, a page the run did not open by name; the person is being asked whether the run may act on it. Call again once they have answered.`;

/** What the model reads of a click refused before it was made: the link it follows goes where a policy denies. */
export const clickDeniedText = (h: Extract<ArrivalHold, { kind: "deny" }>): string =>
    `The link this click follows goes to ${h.url}, which the policy "${h.label}" denies: the click was not made.`;
