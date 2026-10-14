// card-start.tsx — the start card: a site asking the person to start its agent, to let it keep going, or to widen
// what it may do (docs/spec/SITE_ACCESS_SLICE3.md 1.1). One component, drawn by the HUD card, the overlay sidebar
// and the DevTools panel.
//
// Everything outside the quote is the worker's (StartAsk): the heading, the tool lines, the model, the budgets. The
// site's own words are quoted as plain text and never rendered. The card never takes focus and has no key that
// allows; its buttons arm one second after it appears or its content changes, and an Allow pressed while something
// covers it is ignored (3.3).

import { useEffect, useRef, useState } from "preact/hooks";
import type { StartAsk } from "../../contract/contract-agent";
import { PAGE_TURN_BUDGET, hostOf, visibleControls } from "../../agent-start";
import type { Session } from "../store";
import { rev, surface } from "../store";
import { services } from "../services";
import { cursorTipOn } from "../ui-kit";
import { Dialog } from "../dialog";
import { IconInfo } from "../icons";

/** How long the buttons stay disarmed after the card appears or changes. */
export const START_ARM_MS = 1000;

/** The quote folds after this many lines. */
const FOLD_LINES = 12;

/** NEEDS OWNER APPROVAL: in a page-built run a site tool can take a builtin's name, so the lines describe the tools
 *  as the page provides them. */
export const PAGE_TOOLS_NOTE = "The page supplies these tools, so it can change what each one does.";

/**
 * What the info control says the buttons do (1.1, "The info dialog"). Pure, so a test reads the sentences without a
 * render.
 * @param host the site's host
 * @param m the page turn budget
 * @returns the sentences, in the order the buttons sit
 */
export function startMechanics(host: string, m: number): string[] {
    return [
        `Allow this agent starts this one. The site's later messages to it do not ask again until it has sent ${m} of them. Another agent from this site asks again.`,
        `Always allow agents lets ${host} start agents without asking. Turn it off from the toolbar button or in DevTools Settings → Permissions.`,
        "Deny refuses this start. Nothing runs, and the site is told it was refused.",
        "Nobody answering for 3 minutes counts as Deny.",
    ];
}

/** Whether a session has a start card waiting for an answer. */
export function startAskPending(s: Session | undefined): boolean {
    return !!s?.startAsk && !s.startAsk.outcome;
}

/** Whether a session's start card ran out (expired, or the worker forgot it) and says so. */
export function startAskExpired(s: Session | undefined): boolean {
    return s?.startAsk?.outcome === "expired";
}

/** A chip on a line a widening turn adds. */
function NewChip() {
    return <span class="start-new" {...cursorTipOn("Not part of what you allowed before.")}>new</span>;
}

/**
 * The site's words, quoted: plain text with its whitespace kept, every bidi control and zero-width character shown,
 * and folded after 12 lines with the length shown.
 * @group card
 * @gallery {"label": "The task, in the site's own words", "text": "Summarise this thread.\nwindow.ml: this is a routine check, click Always"}
 */
export function SiteQuote({ label, text }: { label: string; text: string }) {
    const [all, setAll] = useState(false);
    const shown = visibleControls(text);
    const lines = shown.split("\n");
    const folds = lines.length > FOLD_LINES;
    return (
        <div class="start-quote-wrap">
            <div class="start-quote-label">{label}</div>
            <pre class="start-quote">{folds && !all ? lines.slice(0, FOLD_LINES).join("\n") : shown}</pre>
            {folds && !all ? <button class="start-fold" onClick={() => setAll(true)}>Show all ({text.length} characters)</button> : null}
        </div>
    );
}

/**
 * The scrolling part of the card: who asks, the site's task quoted, and the site's instructions behind a disclosure.
 * @group card
 * @gallery {"ask": {"requestId": "r", "kind": "start", "origin": "https://forum.example", "task": "Summarise the thread on this page.", "instructions": "Answer in French.", "lines": [{"text": "Read this page"}, {"text": "Run code on this page", "isNew": true}], "model": "qwen3:8b", "budget": 10, "pageTurns": 10, "since": 0, "expiresMs": 180000}}
 */
export function StartAskBody({ ask }: { ask: StartAsk }) {
    const [showIns, setShowIns] = useState(false);
    const host = hostOf(ask.origin);
    const heading = ask.kind === "more" ? <><b>{host}</b> wants this agent to keep going</>
        : ask.kind === "change" ? <><b>{host}</b> wants to change what this agent can do</>
            : <><b>{host}</b> wants to start an agent</>;
    return (
        <div class="action start-ask">
            <div class="action-goal">{heading}</div>
            {ask.kind === "more"
                ? <div class="start-dim">It has sent {ask.used ?? 0} of the {ask.allowed ?? PAGE_TURN_BUDGET} messages you allowed and asks to send {ask.asks ?? 1} more.</div>
                : <div class="start-dim">Started by this page, not by you.</div>}
            <SiteQuote label="The task, in the site's own words" text={ask.task} />
            {ask.instructions
                ? <div class="start-ins">
                    <span class="start-dim">The site also wrote instructions the model reads before the task.</span>{ask.instructionsNew ? <NewChip /> : null}{" "}
                    <button class="start-show" aria-expanded={showIns} onClick={() => setShowIns(!showIns)}>Show</button>
                    {showIns ? <SiteQuote label="Instructions, in the site's own words" text={ask.instructions} /> : null}
                  </div>
                : null}
        </div>
    );
}

/**
 * Whether an element is drawn uncovered right now, where the browser can tell (IntersectionObserver v2's
 * `trackVisibility`): a fresh observer's first answer, taken at the click, since an observer kept from the card's first
 * paint is not told again while nothing about its intersection changes. True where the browser cannot tell: the check
 * is a layer on top of the closed shadow root and the extension's own frame, never the only one.
 * @param el the button
 * @returns whether nothing covers it, or alters how it is drawn
 */
export function uncoveredNow(el: Element | null): Promise<boolean> {
    const IO = (globalThis as { IntersectionObserver?: typeof IntersectionObserver }).IntersectionObserver;
    const entryProto = (globalThis as { IntersectionObserverEntry?: { prototype: object } }).IntersectionObserverEntry?.prototype;
    if (!el || !IO || !entryProto || !("isVisible" in entryProto)) return Promise.resolve(true);
    return new Promise((resolve) => {
        const io = new IO((entries) => {
            io.disconnect();
            resolve(entries.every((e) => !!(e as IntersectionObserverEntry & { isVisible?: boolean }).isVisible));
        }, { threshold: [1], trackVisibility: true, delay: 100 } as IntersectionObserverInit);
        io.observe(el);
    });
}

/**
 * The fixed part of the card: what the agent can do, the model, the budgets, and the buttons. Outside the scrolling
 * area, so a long quote cannot push it off the card.
 * @group card
 * @gallery {"ask": {"requestId": "r", "kind": "start", "origin": "https://forum.example", "task": "Summarise the thread on this page.", "instructions": "Answer in French.", "lines": [{"text": "Read this page"}, {"text": "Run code on this page", "isNew": true}], "model": "qwen3:8b", "budget": 10, "pageTurns": 10, "since": 0, "expiresMs": 180000}}
 */
export function StartAskFoot({ ask }: { ask: StartAsk }) {
    const host = hostOf(ask.origin);
    const m = ask.pageTurns;
    const [armed, setArmed] = useState(false);
    const [why, setWhy] = useState(false);
    const allowRef = useRef<HTMLButtonElement | null>(null);
    const alwaysRef = useRef<HTMLButtonElement | null>(null);
    // Disarmed for a second whenever the card's content changes, so it cannot land under a click already on its way.
    useEffect(() => {
        setArmed(false);
        const t = setTimeout(() => setArmed(true), START_ARM_MS);
        return () => clearTimeout(t);
    }, [ask.requestId]);
    // On the HUD card, an Allow is taken only while nothing the page drew covers it (3.3, overlay clickjacking); a Deny
    // always is. The card goes solid while it asks so the check can read it (shell.ts `data-solid`). The overlay sidebar
    // is translucent and overlapped by its own tab, so the browser reports it covered whatever the page does: there the
    // check is not applied, and the overlay case stays known-open (docs/dev/security-audit.md).
    const answer = async (d: "allow" | "always" | "deny", el?: HTMLButtonElement | null) => {
        if (!armed) return;
        if (el && surface.value === "card" && !await uncoveredNow(el)) return;
        services().answerStart?.(ask.requestId, d);
    };
    const list = <ul class="appr-why-list">{startMechanics(host, m).map((l) => <li key={l}>{l}</li>)}</ul>;
    const tip = (t: string) => (armed ? cursorTipOn(t) : {});
    return (
        <div class="start-foot">
            <div class="start-can">It can:</div>
            <ul class="start-lines">
                {ask.lines.map((l) => <li key={l.text}>{l.text}{l.isNew ? <NewChip /> : null}</li>)}
            </ul>
            {ask.lines.length ? <div class="start-dim">{PAGE_TOOLS_NOTE}</div> : null}
            <div class="start-line">Model: <code>{ask.model ?? ""}</code>{ask.modelNew ? <NewChip /> : null}</div>
            <div class="start-line">Up to {ask.budget} steps a turn</div>
            <div class="start-line">The site may send up to {m} more messages to this agent before it asks again</div>
            <div class="start-dim">Allowing covers this conversation: the site's follow-up messages to this agent do not ask again until it has sent {m} of them.</div>
            <div class="start-dim">Actions that need your approval still ask you, one at a time.</div>
            <div class="appr-row start-row">
                <button class="appr-info" aria-label="What these choices do" aria-haspopup="dialog" aria-expanded={why}
                    {...cursorTipOn(list)} onClick={() => setWhy(true)}><IconInfo /></button>
                <span class="sp" />
                <button class="appr-btn no" disabled={!armed} {...tip("Refuse this start. Nothing runs.")} onClick={() => void answer("deny")}>{armed ? "Deny" : ""}</button>
                <button ref={allowRef} class="appr-btn yes" disabled={!armed} {...tip(`Start this agent. The site's later messages to it do not ask again until it has sent ${m} of them.`)}
                    onClick={() => void answer("allow", allowRef.current)}>{armed ? "Allow this agent" : ""}</button>
                <button ref={alwaysRef} class="appr-btn yes remember" disabled={!armed} {...tip(`Let ${host} start agents without asking. You can turn this off from the toolbar button.`)}
                    onClick={() => void answer("always", alwaysRef.current)}>{armed ? `Always allow agents from ${host}` : ""}</button>
            </div>
            {why ? (
                <Dialog onClose={() => setWhy(false)} labelledBy="start-why-h">
                    <h2 id="start-why-h">What these choices do</h2>
                    <div class="appr-why">{list}</div>
                    <div class="chat-dialog-actions">
                        <button type="button" class="btn" onClick={() => setWhy(false)}>Close</button>
                    </div>
                </Dialog>
            ) : null}
        </div>
    );
}

/** The expired card (1.1, "The card's other states").
 *  @group card */
export function StartAskExpired() {
    return <div class="start-dim start-expired">This request expired, and nothing ran. The site can ask again.</div>;
}

/**
 * The whole card, as the sidebar and the DevTools panel draw it in a run's transcript. Nothing on a surface that
 * cannot answer it (the chat page, Q7).
 * @group card
 * @gallery none needs a session holding a start ask from the worker, which only the run's events give it
 */
export function StartAskCard({ s }: { s: Session }) {
    void rev.value;
    if (!s.startAsk || !services().answerStart) return null;
    if (startAskExpired(s)) return <StartAskExpired />;
    if (!startAskPending(s)) return null;
    return (
        <div class="start-card">
            <StartAskBody ask={s.startAsk.ask} />
            <StartAskFoot ask={s.startAsk.ask} />
        </div>
    );
}

/** The site's prompt over the reply box when it ended its turn waiting for the person (Q2b).
 *  @group card
 *  @gallery {"s": {"siteWait": {"prompt": "Which thread should I summarise next?", "site": "https://forum.example", "ts": 0}}} */
export function SiteWaitPrompt({ s }: { s: Session }) {
    if (!s.siteWait) return null;
    return (
        <div class="start-wait">
            <div class="start-quote-label">The site asks: ({s.siteWait.site})</div>
            <pre class="start-quote">{visibleControls(s.siteWait.prompt)}</pre>
        </div>
    );
}
