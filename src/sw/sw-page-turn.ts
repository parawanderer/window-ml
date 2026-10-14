// sw-page-turn.ts — a page's own turns of a run the worker hosts for it, outside the run's loop: its steer, and its wait for the person.

import { pageTurnText } from "../agent-start";
import type { InjectMessagePayload } from "../contract";
import { grantableOrigin } from "../site-access";
import { relayDebugEvent } from "./sw-debug";
import { getConfig } from "./sw-llm";
import { runInboxes, bgRuns, turnByRun } from "./sw-runs";
import { ingestSessionEvent } from "./sw-sessions";
import { approvalFor, stopForPerson, gatePageTurn } from "./sw-start-approval";

/**
 * A page's steer of its running agent, or its wait for the person (INJECT_MESSAGE from a page). A steer is a turn of the
 * site's own: the start card's gate decides it (the page turn budget, Q2), and the model reads it marked as the page's
 * (Q2a) unless it is the person's own message relayed by the page. Its `origin` (where a message was typed) is never
 * the page's to say. A wait for the person (Q2b) stops the run and shows the site's prompt, labelled, over the reply box.
 * @param p the page's payload
 * @param sender the browser's facts about the page
 * @returns `{ data: true }` when it was taken, `{ data: false }` when the run is not live here, or the refusal
 */
export async function pageInject(p: InjectMessagePayload, sender: chrome.runtime.MessageSender): Promise<{ data: boolean } | { error: string }> {
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
        if (live) stopForPerson(p.runId);
        const event = { kind: "agent-wait", id: p.runId, ts: Date.now(), save: false, session: { hash: p.runId, turn: 0 }, prompt: p.waitForPerson.slice(0, 4000), site: origin };
        chrome.tabs.sendMessage(tabId, { type: "ML_DEBUG_TO_PAGE", event }).catch(() => {});
        relayDebugEvent(tabId, event);
        return { data: true };
    }
    if (!live || live.tabId !== tabId || typeof p.text !== "string") return { data: false };
    const payload = stored?.p ?? turnByRun.get(p.runId)?.().payload;
    if (!payload) return { data: false };
    const cfg = await getConfig();
    const verdict = await gatePageTurn({ type: "INJECT_MESSAGE", runId: p.runId, tabId, origin, text: p.text, p: payload, model: payload.model || cfg.model || null, pageHistory: false, known: true });
    if ("error" in verdict) return { error: verdict.error };
    const inbox = runInboxes.get(p.runId);
    if (!inbox || inbox.tabId !== tabId) return { data: false };
    inbox.queue.push({ ...(p.sayId ? { id: String(p.sayId) } : {}), text: verdict.person ? p.text : pageTurnText(origin, p.text) });
    const event = verdict.person
        ? { kind: "agent-say", id: p.runId, ts: Date.now(), save: false, session: { hash: p.runId, turn: 0 }, text: p.text, ...(p.sayId ? { sayId: String(p.sayId) } : {}) }
        : { kind: "agent-site-say", id: p.runId, ts: Date.now(), save: false, session: { hash: p.runId, turn: 0 }, text: p.text, site: origin, ...(p.sayId ? { sayId: String(p.sayId) } : {}) };
    chrome.tabs.sendMessage(tabId, { type: "ML_DEBUG_TO_PAGE", event }).catch(() => {});
    relayDebugEvent(tabId, event);
    if (verdict.person) ingestSessionEvent(event, { tabId, trusted: true });
    return { data: true };
}
