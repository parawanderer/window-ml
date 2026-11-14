// ask-card.tsx — a step's nested asks: the card for each one still waiting for the person, and a line for each answered.

// A nested ask (src/sw/sw-asks.ts) is a call made from INSIDE a running step that needs the person: an `ml.sh` from an
// approved exec. It rides the step's own event, so this draws wherever a step is drawn (the sidebar, the DevTools panel,
// the chat page, the phone). The card shows the call's resolved FACTS, never the script that computed them: approving a
// script is not approving every call it can build (docs/spec/SHELL.md, "Approval").

import type { AgentStep } from "../store";
import { rev, focusMode } from "../store";
import { ARRIVAL_ASK, ARRIVAL_DENIED, type StepAsk } from "../../contract";
import { ASK_ID } from "../../approval-key";
import { decidedSteps, sendApproval, askKey, cursorTipOn } from "../ui-kit";
import { CopyableCode } from "../code-block";
import { ApprovalRow } from "./approval-row";
import { IconWarn } from "../icons";
import { shCardLines, type ShCardLine, type ShFacts } from "../../shell/sh-call";
import { isCallAsk } from "../../shell/sh-entries";
import { useEffect, useRef, useState } from "preact/hooks";
import { putCardLines, putSubject, type PutFacts } from "../../shell/sh-put";

/** What each kind of ask is, said as the card's question. A kind this build does not know is asked about plainly. */
const ASK_TITLE: Readonly<Record<string, string>> = {
    sh: "While it runs, this step wants to start a program:",
    put: "While it runs, this step wants to write a file you attached to this machine:",
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
    if (a.kind === "put") {
        try { return putCardLines(a.facts as unknown as PutFacts); } catch { /* facts of another shape: drawn as they are */ }
    }
    return Object.entries(a.facts ?? {}).map(([label, v]) => ({ label, value: typeof v === "string" ? v : JSON.stringify(v) }));
}

/** An ask's lines as the card's definition list. The COMMAND line is not a fact: it is drawn above them as the code it is
 *  (a script as the lines it was written in, with a copy button), and a line with a `tip` explains itself on hover.
 *  @param lines the lines
 *  @param cls the list's class, so a surface can size it its own way
 *  @param skipCommand leave the command out, where the caller has drawn it already */
export function FactList({ lines, cls = "ask-facts", skipCommand }: { lines: ShCardLine[]; cls?: string; skipCommand?: boolean }) {
    return (
        <>
            {skipCommand ? null : lines.filter((l) => l.command).map((l, i) => (
                <div key={`cmd${i}`} class="ask-cmd">
                    <CopyableCode text={l.script ?? l.value} block lang="bash" tip="copy the command" />
                    {l.script != null ? <div class="shc-via">run as <code>{l.value.match(/^\S+ -\w*c(?= )/)?.[0] ?? "a shell"} …</code></div> : null}
                </div>
            ))}
            <dl class={`ask-facts ${cls}`}>
                {lines.filter((l) => !l.command).map((l, i) => (
                    <div key={i} class={l.warn ? "warn" : undefined}>
                        <dt>{l.warn ? <IconWarn /> : null}{l.label}</dt>
                        <dd class={l.tip ? "has-tip" : undefined} {...(l.tip ? { tabIndex: 0, ...cursorTipOn(l.tip) } : {})}>{l.value}</dd>
                    </div>
                ))}
            </dl>
        </>
    );
}

/** How long a card that was just answered takes to leave, in the calm view: the footer's count has ticked by then. */
const LEAVE_MS = 260;

/**
 * A step's nested asks that need a person, each a card, in the order they were raised. An answered ask of a call
 * (`ml.sh`) is not drawn here: it joins the step's footer of calls (sh-calls.tsx), and in the calm view its card
 * eases away rather than vanishing, so what you just did visibly goes somewhere. An answered ask of another kind (an
 * arrival) stays the one line it was.
 * @gallery {"st":{"step":3,"seq":3,"tool":"exec","pending":true,"asks":[{"id":"a0123456789abcdef01234567","kind":"sh","state":"pending","raisedAt":0,"facts":{"argv":["git","--no-pager","status"],"program":{"path":"/usr/bin/git","inRoot":false},"cwd":{"path":"/Users/me/src/proj","inRoot":true},"env":{"set":[],"free":true},"secrets":[],"paths":[],"repo":{"root":"/Users/me/src/proj","reasons":[]},"repoConfigRunsCode":false,"effects":"unknown","described":false,"why":["the program's version was not reported"],"runner":false,"mode":"host","sandboxed":true,"placement":"host-sandbox"}}]},"hash":"r1","live":true}
 * @group approval
 * @param st the step
 * @param hash the run, for answering; absent where the run cannot be answered from here
 * @param live whether the runtime still holds the run's gates
 */
export function AskList({ st, hash, live }: { st: AgentStep; hash?: string; live: boolean }) {
    const asks = st.asks ?? [];
    const seq = st.seq;
    const isWaiting = (a: StepAsk): boolean => a.state === "pending" && !(hash && seq != null && decidedSteps.has(askKey(hash, seq, a.id)));
    const waitingNow = asks.filter(isWaiting);
    // The cards that WERE waiting a render ago and are not now, kept on screen for the length of their exit. Only a
    // call's ask, and only in the calm view: elsewhere a card answered is a card gone, as it always was.
    const was = useRef<Map<string, StepAsk>>(new Map());
    const [leaving, setLeaving] = useState<StepAsk[]>([]);
    const calm = focusMode.value;
    // SUBSCRIBED TO `rev` TOO, and the read is kept in the output. Reading `focusMode` makes @preact/signals memoize this
    // component on its props, which stops the parent's cascade reaching it, and that cascade is how an answer given here
    // (`decidedSteps`, a plain Set) takes the card away. Without this the card stayed until the worker's event landed.
    void rev.value;
    useEffect(() => {
        const gone = [...was.current.values()].filter((p) => !waitingNow.some((w) => w.id === p.id) && isCallAsk(p.kind));
        was.current = new Map(waitingNow.map((a) => [a.id, a]));
        if (!gone.length || !calm) return;
        setLeaving((l) => [...l, ...gone]);
        const t = setTimeout(() => setLeaving((l) => l.filter((x) => !gone.includes(x))), LEAVE_MS);
        return () => clearTimeout(t);
    });
    if (!asks.length && !leaving.length) return null;
    return (
        <>
            {leaving.filter((l) => !asks.some((a) => a.id === l.id && isWaiting(a))).map((a) => (
                <div key={`leave-${a.id}`} class="astep-approve ask leaving" aria-hidden="true">
                    <span class="appr-ask">{Object.hasOwn(ASK_TITLE, a.kind) ? ASK_TITLE[a.kind] : String(a.kind)}</span>
                    <FactList lines={askLines(a)} />
                </div>
            ))}
            {asks.map((a) => {
                const key = hash && seq != null ? askKey(hash, seq, a.id) : "";
                const waiting = isWaiting(a);
                const arrival = a.kind === ARRIVAL_ASK ? "ask" as const : a.kind === ARRIVAL_DENIED ? "deny" as const : undefined;
                if (!waiting) return isCallAsk(a.kind) ? null : <AskDone key={a.id} a={a} />;
                return (
                    <div key={a.id} class="astep-approve ask">
                        {arrival
                            // An arrival's card is its line: the page, and the policy that holds the run there.
                            ? <span class="appr-ask">{a.why?.line ?? String(a.facts?.url ?? "")}</span>
                            : <>
                                <span class="appr-ask">{Object.hasOwn(ASK_TITLE, a.kind) ? ASK_TITLE[a.kind] : <>While it runs, this step asks for <b>{String(a.kind)}</b>:</>}</span>
                                {a.why ? <div class="appr-note" {...cursorTipOn(a.why.detail)}><IconWarn /><span>{a.why.line}</span></div> : null}
                                <FactList lines={askLines(a)} />
                            </>}
                        {!live
                            ? <span class="appr-dead">This run ended before anyone answered, so there is nothing left to approve.</span>
                            // An ask without a well-formed id has nothing to answer: its answer would name no ask,
                            // which the worker reads as the step's own gate.
                            : a.external || !hash || seq == null || typeof a.id !== "string" || !ASK_ID.test(a.id)
                                ? <span class="appr-dead">Waiting for the run's external approver.</span>
                                : <ApprovalRow grants={false} arrival={arrival} decide={(ok, _persist, feedback) => {
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
    if (a.kind === ARRIVAL_ASK || a.kind === ARRIVAL_DENIED) {
        const outcome = a.kind === ARRIVAL_DENIED && a.state === "allowed" ? "went back" : a.kind === ARRIVAL_DENIED && a.state === "denied" ? "ended the run"
            : Object.hasOwn(ASK_DONE, a.state) ? ASK_DONE[a.state] : String(a.state);
        return <div class={`astep-ask-done ${a.state === "allowed" ? "ok" : "no"}`}>{a.why?.line ?? String(a.facts?.url ?? "")}: {outcome}</div>;
    }
    const argv = a.kind === "put" ? putSubject(a.facts) : Array.isArray(a.facts?.argv) ? (a.facts.argv as unknown[]).map(String).join(" ") : a.kind;
    const waited = a.answeredAt != null ? ` after ${Math.max(0, Math.round((a.answeredAt - a.raisedAt) / 1000))} s` : "";
    const outcome = a.state === "pending" ? "answered, waiting for the run" : Object.hasOwn(ASK_DONE, a.state) ? ASK_DONE[a.state] : String(a.state);
    return (
        <div class={`astep-ask-done ${a.state === "allowed" ? "ok" : "no"}`}>
            Asked to {a.kind === "put" ? "write" : "run"} <code>{argv}</code>: {outcome}{waited}{a.note ? <> — “{a.note}”</> : null}
        </div>
    );
}
