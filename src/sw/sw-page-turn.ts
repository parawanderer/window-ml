// sw-page-turn.ts — a page's own turns of a run the worker hosts for it, outside the run's loop: its steer, and its wait for the person.

import { pageTurnText } from "../agent-start";
import type { InjectMessagePayload } from "../contract";
import { grantableOrigin } from "../site-access";
import { relayDebugEvent } from "./sw-debug";
import { getConfig } from "./sw-llm";
import { runInboxes, bgRuns, turnByRun } from "./sw-runs";
import { ingestSessionEvent } from "./sw-sessions";
import { ourToolTexts } from "./builtin-texts";
import { approvalFor, stopForPerson, gatePageTurn, type PersonTurn } from "./sw-start-approval";
import { toPageUi } from "./sw-side-panel";

/** The shortest gap between two of a run's waits for the person (`waitForPerson`). */
export const WAIT_GAP_MS = 10_000;

/** When each run last waited for the person. */
const lastWait = new Map<string, number>();   // state: plumbing (a rate limit)

/**
 * A page's steer of its running agent, or its wait for the person (INJECT_MESSAGE from a page). A steer is a turn of the
 * site's own: the start card's gate decides it (the page turn budget, Q2), and the model reads it marked as the page's
 * (Q2a) unless it is the person's own message relayed by the page. Its `origin` (where a message was typed) is never
 * the page's to say. A wait for the person (Q2b) stops the run and shows the site's prompt, labelled, over the reply box.
 * @param p the page's payload
 * @param sender the browser's facts about the page
 * @param claimed the router already spent the person's turn for this message (the navigation rule)
 * @returns `{ data: true }` when it was taken, `{ data: false }` when the run is not live here, or the refusal
 */
export async function pageInject(p: InjectMessagePayload, sender: chrome.runtime.MessageSender, claimed?: PersonTurn): Promise<{ data: boolean } | { error: string }> {
    const tabId = sender.tab?.id;
    const g = grantableOrigin({ origin: sender.origin, url: sender.url ?? sender.tab?.url, frameId: sender.frameId });
    if (tabId == null || !("origin" in g) || !p || typeof p.runId !== "string") return { data: false };
    const origin = g.origin;
    const live = runInboxes.get(p.runId);
    const stored = bgRuns.get(p.runId);
    if (typeof p.waitForPerson === "string") {
        const a = approvalFor(p.runId);
        if (!a || a.tabId !== tabId) return { data: false };
        if (a.origin !== origin) return { error: `Refused: run "${p.runId}" was started by another site.` };
        // One wait a run every WAIT_GAP_MS: a page cannot put a stream of prompts in front of the person.
        const last = lastWait.get(p.runId) ?? 0;
        if (Date.now() - last < WAIT_GAP_MS) return { data: false };
        lastWait.set(p.runId, Date.now());
        if (live) stopForPerson(p.runId);
        const event = { kind: "agent-wait", id: p.runId, ts: Date.now(), save: false, session: { hash: p.runId, turn: 0 }, prompt: p.waitForPerson.slice(0, 4000), site: origin };
        toPageUi(tabId, { type: "ML_DEBUG_TO_PAGE", event });
        relayDebugEvent(tabId, event);
        return { data: true };
    }
    if (!live || live.tabId !== tabId || typeof p.text !== "string") return { data: false };
    const payload = stored?.p ?? turnByRun.get(p.runId)?.().payload;
    if (!payload) return { data: false };
    const cfg = await getConfig();
    const verdict = await gatePageTurn({ type: "INJECT_MESSAGE", runId: p.runId, tabId, origin, text: p.text, p: payload, model: payload.model || cfg.model || null, pageHistory: false, known: true, personClaimed: claimed, siteTools: ourToolTexts(payload, payload.pageUrl ?? "").siteTools });
    if ("error" in verdict) return { error: verdict.error };
    const inbox = runInboxes.get(p.runId);
    if (!inbox || inbox.tabId !== tabId) return { data: false };
    const own = verdict.pagePrefix ? p.text.slice(verdict.pagePrefix.length + 2) : p.text;
    inbox.queue.push({ ...(p.sayId ? { id: String(p.sayId) } : {}), text: !verdict.person ? pageTurnText(origin, p.text) : verdict.pagePrefix ? `${pageTurnText(origin, verdict.pagePrefix)}\n\n${own}` : p.text });
    const base = { id: p.runId, ts: Date.now(), save: false, session: { hash: p.runId, turn: 0 } };
    const say = p.sayId ? { sayId: String(p.sayId) } : {};
    // The page's text with its name, the person's as theirs: a page's own text folded ahead of the person's stays the page's.
    const events = !verdict.person ? [{ kind: "agent-site-say", ...base, text: p.text, site: origin, ...say }]
        : verdict.pagePrefix ? [{ kind: "agent-site-say", ...base, text: verdict.pagePrefix, site: origin }, { kind: "agent-say", ...base, text: own, ...say }]
            : [{ kind: "agent-say", ...base, text: p.text, ...say }];
    for (const event of events) {
        toPageUi(tabId, { type: "ML_DEBUG_TO_PAGE", event });
        relayDebugEvent(tabId, event);
        ingestSessionEvent(event, { tabId, trusted: true });
    }
    return { data: true };
}
