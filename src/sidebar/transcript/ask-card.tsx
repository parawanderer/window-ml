// ask-card.tsx — a step's nested asks: the card for each one still waiting for the person, and a line for each answered.

// A nested ask (src/sw/sw-asks.ts) is a call made from INSIDE a running step that needs the person: an `ml.sh` from an
// approved exec. It rides the step's own event, so this draws wherever a step is drawn (the sidebar, the DevTools panel,
// the chat page, the phone). The card shows the call's resolved FACTS, never the script that computed them: approving a
// script is not approving every call it can build (docs/spec/SHELL.md, "Approval").

import type { AgentStep } from "../store";
import { rev } from "../store";
import type { StepAsk } from "../../contract";
import { ASK_ID } from "../../approval-key";
import { decidedSteps, sendApproval, askKey, cursorTipOn } from "../ui-kit";
import { ApprovalRow } from "./approval-row";
import { IconWarn } from "../icons";
import { shCardLines, type ShCardLine, type ShFacts } from "../../shell/sh-call";

/** What each kind of ask is, said as the card's question. A kind this build does not know is asked about plainly. */
const ASK_TITLE: Readonly<Record<string, string>> = {
    sh: "While it runs, this step wants to start a program:",
};

/** How an answered ask reads on its line, by state. */
const ASK_DONE: Record<StepAsk["state"], string> = {
    pending: "waiting", allowed: "allowed", denied: "denied", cancelled: "cancelled", timeout: "nobody answered in time",
    unattended: "refused: nobody to ask", ended: "the turn ended first", limit: "refused: asked too often",
};

/**
 * The lines a card shows for an ask's facts: a shell call's own (argv, program, cwd, sandbox, paths, effects), or for a
 * kind this build does not know, each fact as it is.
 * @param a the ask
 * @returns the lines
 */
export function askLines(a: StepAsk): ShCardLine[] {
    if (a.kind === "sh") {
        try { return shCardLines(a.facts as unknown as ShFacts); } catch { /* facts of another shape: drawn as they are */ }
    }
    return Object.entries(a.facts ?? {}).map(([label, v]) => ({ label, value: typeof v === "string" ? v : JSON.stringify(v) }));
}

/**
 * A step's nested asks, in the order they were raised.
 * @gallery {"st":{"step":3,"seq":3,"tool":"exec","pending":true,"asks":[{"id":"a0123456789abcdef01234567","kind":"sh","state":"pending","raisedAt":0,"facts":{"argv":["git","--no-pager","status"],"program":{"path":"/usr/bin/git","inRoot":false},"cwd":{"path":"/Users/me/src/proj","inRoot":true},"env":{"set":[],"free":true},"secrets":[],"paths":[],"repo":{"root":"/Users/me/src/proj","reasons":[]},"repoConfigRunsCode":false,"effects":"unknown","described":false,"why":["the program's version was not reported"],"runner":false,"mode":"host","sandboxed":true,"placement":"host-sandbox"}},{"id":"a0123456789abcdef01234568","kind":"sh","state":"denied","raisedAt":0,"answeredAt":4000,"note":"not that branch","facts":{"argv":["git","checkout","main"]}}]},"hash":"r1","live":true}
 * @group approval
 * @param st the step
 * @param hash the run, for answering; absent where the run cannot be answered from here
 * @param live whether the runtime still holds the run's gates
 */
export function AskList({ st, hash, live }: { st: AgentStep; hash?: string; live: boolean }) {
    const asks = st.asks;
    if (!asks?.length) return null;
    const seq = st.seq;
    return (
        <>
            {asks.map((a) => {
                const key = hash && seq != null ? askKey(hash, seq, a.id) : "";
                const waiting = a.state === "pending" && !(key && decidedSteps.has(key));
                if (!waiting) return <AskDone key={a.id} a={a} />;
                return (
                    <div key={a.id} class="astep-approve ask">
                        <span class="appr-ask">{Object.hasOwn(ASK_TITLE, a.kind) ? ASK_TITLE[a.kind] : <>While it runs, this step asks for <b>{String(a.kind)}</b>:</>}</span>
                        {a.why ? <div class="appr-note" {...cursorTipOn(a.why.detail)}><IconWarn /><span>{a.why.line}</span></div> : null}
                        <dl class="ask-facts">
                            {askLines(a).map((l, i) => (
                                <div key={i} class={l.warn ? "warn" : undefined}>
                                    <dt>{l.warn ? <IconWarn /> : null}{l.label}</dt><dd>{l.value}</dd>
                                </div>
                            ))}
                        </dl>
                        {!live
                            ? <span class="appr-dead">This run ended before anyone answered, so there is nothing left to approve.</span>
                            // An ask without a well-formed id has nothing to answer: its answer would name no ask,
                            // which the worker reads as the step's own gate.
                            : a.external || !hash || seq == null || typeof a.id !== "string" || !ASK_ID.test(a.id)
                                ? <span class="appr-dead">Waiting for the run's external approver.</span>
                                : <ApprovalRow grants={false} decide={(ok, _persist, feedback) => {
                                    decidedSteps.add(key);
                                    rev.value++;
                                    sendApproval(hash, seq, ok, false, feedback, a.id);
                                }} />}
                    </div>
                );
            })}
        </>
    );
}

/** One answered ask, as a line under its step. */
function AskDone({ a }: { a: StepAsk }) {
    const argv = Array.isArray(a.facts?.argv) ? (a.facts.argv as unknown[]).map(String).join(" ") : a.kind;
    const waited = a.answeredAt != null ? ` after ${Math.max(0, Math.round((a.answeredAt - a.raisedAt) / 1000))} s` : "";
    const outcome = a.state === "pending" ? "answered, waiting for the run" : Object.hasOwn(ASK_DONE, a.state) ? ASK_DONE[a.state] : String(a.state);
    return (
        <div class={`astep-ask-done ${a.state === "allowed" ? "ok" : "no"}`}>
            Asked to run <code>{argv}</code>: {outcome}{waited}{a.note ? <> — “{a.note}”</> : null}
        </div>
    );
}
