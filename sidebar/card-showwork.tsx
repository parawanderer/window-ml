// The off-mode card's "Show work" trace: the collapsible step trace (ShowWork), a scannable ask/answer
// disclosure (CardTraceMsg), and — for a multi-task run — per-task blocks (RunTaskBlockView). Extracted
// from hud-card.tsx; reuses the run-render layer (AgentTurn / AnswerBody) so the card matches the sidebar.
import { useState, useEffect, useRef } from "preact/hooks";
import type { Session, AgentStep } from "./store";
import { rev, cardShowWorkHash, revealSeq } from "./store";
import { markdown } from "./format";
import { IconChevron } from "./icons";
import { ClickableImg, inlineText } from "./ui-kit";
import { exportSession, printSession } from "./export";
import { AnswerBody } from "./answer-render";
import { AgentTurn, SteerSeen } from "./agent-detail";
import { buildRunBlocks, ensureBlockSummary, blockSummaries, blockKey, groupTurns } from "./debug-reducer";
import type { RunTaskBlock } from "./debug-reducer";

export function ShowWork({ run }: { run: Session }) {
    // Reading cardShowWorkHash auto-memoizes this component; `run` is mutated in place (same ref), so also
    // subscribe to `rev` — else a landed Explain gloss (rev bump) wouldn't re-render. Retained via data-rev.
    const rv = rev.value;
    const open = cardShowWorkHash.value === run.hash;
    // Drop empty groups — a turn carrying only a usage sample (final-answer token counts), no thought /
    // reasoning / tool — which otherwise render as a blank block in the trace (the same filter AgentRunView
    // uses). KEEP a reasoning-only turn (the final-answer turn shows its thinking).
    const turns = groupTurns(run.steps || []).filter(t => t.thought || t.reasoning || t.tools.length);
    // "N steps" = the number of loop iterations actually shown (turn-groups across ALL turns), not just the
    // tool calls — a thinking-only step is still a step, and the old tool-only count undercounted multi-turn runs.
    const n = turns.length;
    // Multi-TASK run (>1 answer) → segment into collapsible per-task blocks; else null → the flat trace below.
    const blocks = buildRunBlocks(run);
    // Interleave the CONVERSATION into the trace — your prompts (task + follow-ups → "you asked") and PAST
    // answers, positioned with the step-groups by cumulative step (same scheme as the panel's AgentRunView:
    // task at -1, an answer just after its turn's steps, a following prompt just after that). The LATEST
    // answer isn't here — it's the card BODY (or, while running, the live prose) — so a done run drops it.
    const running = run.status === "pending";
    const answers = run.answers || [];
    const pastAnswers = running ? answers : answers.slice(0, -1);
    // Answers and says share one positional base (atStep + 0.5); TS breaks the tie — see AgentRunView for
    // why a fixed answer-before-say fraction mis-orders a chat-style turn that ran no tool steps.
    const traceItems: { pos: number; ts: number; el: preact.JSX.Element }[] = [
        ...(run.task || run.taskImages?.length ? [{ pos: -1, ts: run.createdTs || 0, el: <CardTraceMsg key="task" label="you asked" text={run.task || ""} cls="acard-you" images={run.taskImages} /> }] : []),
        ...(run.says || []).map((s, i) => ({ pos: s.atStep + 0.5, ts: s.ts, el: <CardTraceMsg key={`say${i}`} label="you asked" text={s.text} cls="acard-you" images={s.images} steer={s.id ? { seen: s.seen } : undefined} /> })),
        ...pastAnswers.map((a, i) => ({ pos: a.atStep + 0.5, ts: a.ts, el: <CardTraceMsg key={`ans${i}`} label={a.cancelled ? "cancelled" : a.hitCap ? "stopped early" : "answered"} text={a.text || "(no reply)"} cls="acard-ans" /> })),
        ...turns.map(t => ({ pos: t.step, ts: 0, el: <AgentTurn key={`t${t.step}`} turn={t} max={run.maxSteps} hash={run.hash} /> })),
    ].sort((a, b) => a.pos - b.pos || a.ts - b.ts);
    // Right-click the toggle → export THIS run (Markdown / PDF), reusing the debug bar's export logic. The
    // `head` wraps ONLY the toggle + menu, so a click on the TRACE (or anywhere else, or the page → iframe
    // blur) dismisses it — the trace is a sibling, outside `head`.
    const [expMenu, setExpMenu] = useState(false);
    const head = useRef<HTMLDivElement>(null);
    useEffect(() => {
        if (!expMenu) return;
        const close = () => setExpMenu(false);
        const onDown = (e: Event) => { if (!head.current?.contains(e.target as Node)) close(); };
        const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
        document.addEventListener("pointerdown", onDown);
        document.addEventListener("keydown", onKey);
        window.addEventListener("blur", close);   // clicking the page (outside the iframe) blurs it
        return () => { document.removeEventListener("pointerdown", onDown); document.removeEventListener("keydown", onKey); window.removeEventListener("blur", close); };
    }, [expMenu]);
    const exp = (fn: (h: string) => void) => { setExpMenu(false); fn(run.hash); };
    return (
        <div class="card-work" data-rev={rv}>
            <div class="card-work-head" ref={head}>
                <button class={`card-work-toggle${open ? " open" : ""}`} title="Right-click to export this run (Markdown / PDF)"
                    onClick={() => (cardShowWorkHash.value = open ? "" : run.hash)}
                    onContextMenu={e => { e.preventDefault(); setExpMenu(v => !v); }}>
                    <span class="card-work-label">{open ? "Hide work" : "Show work"}</span>
                    <span class="card-work-n">{n} {n === 1 ? "step" : "steps"}</span>
                    <span class="sp" />
                    <span class={`tri${open ? " open" : ""}`} aria-hidden="true"><IconChevron /></span>
                </button>
                {expMenu ? (
                    <div class="card-export-menu" role="menu">
                        <div class="menu-head">Export this run</div>
                        <button class="menu-item" role="menuitem" onClick={() => exp(exportSession)}>Markdown<span class="menu-hint">.zip with screenshots</span></button>
                        <button class="menu-item" role="menuitem" onClick={() => exp(printSession)}>PDF<span class="menu-hint">opens the print dialog</span></button>
                    </div>
                ) : null}
            </div>
            {open ? <div class="card-work-trace">
                {/* Multi-task run → per-task BLOCKS (collapse priors, expand the latest); single task → the
                    flat interleaved trace as before. */}
                {blocks
                    ? blocks.map((b, i) => <RunTaskBlockView key={i} run={run} block={b} index={i} last={i === blocks.length - 1} />)
                    : traceItems.map(it => it.el)}
            </div> : null}
        </div>
    );
}

// A collapsed disclosure in the card trace for a USER PROMPT ("you asked") or a PAST ANSWER ("answered") —
// styled like the thinking block, so Show-work reads as a scannable conversation SHAPE (ask → work → answer
// → ask → …). Collapsed with a one-line preview; expand for the full text. This is how a multi-turn HUD run
// stays legible: you can tell which steps belonged to which of your prompts.
export function CardTraceMsg({ label, text, cls, images, steer, run, scope }: { label: string; text: string; cls: string; images?: string[]; steer?: { seen?: boolean }; run?: Session; scope?: readonly AgentStep[] }) {
    const [open, setOpen] = useState(false);
    return (
        <div class={`athought ${cls}`}>
            <button class="astep-head" onClick={() => setOpen(v => !v)}>
                <span class={`tri${open ? " open" : ""}`} aria-hidden="true"><IconChevron /></span>
                <span class="who">{label}</span>
                {steer ? <SteerSeen seen={!!steer.seen} /> : null}
                {!open ? <span class="astep-preview">{inlineText(text || "")}</span> : null}
            </button>
            {images?.length ? <div class="thumbs">{images.map((src, i) => <ClickableImg key={i} src={src} />)}</div> : null}
            {/* A PAST ANSWER (given `run`) resolves its @tool citations via AnswerBody — same as the card body /
                sidebar reply — so a `![…](@tool:…)` renders the actual output, not raw markdown. A user prompt
                (no `run`) is plain text. AnswerBody handles the no-token case, so passing `run` is always safe. */}
            {open && text
                ? (run
                    ? <AnswerBody text={text} run={run} cls="astep-body" scope={scope} />
                    : <div class="md astep-body" dangerouslySetInnerHTML={{ __html: markdown(text || "", { math: true }) }} />)
                : null}
        </div>
    );
}

// One TASK block in the HUD Show-work (a multi-task run only). Collapsed → a one-line summary (utility-model,
// lazy + cached) or the prompt fallback, + a step-count chip. Expanded → the prompt, its turns, and (for a
// PRIOR block) its answer — the LATEST block's answer is the card body, so it's not repeated here. The latest
// block is expanded by default; priors collapse. Card-only (the debug sidebar shows the full flat trace).
export function RunTaskBlockView({ run, block, index, last }: { run: Session; block: RunTaskBlock; index: number; last: boolean }) {
    const rv = rev.value;   // subscribe → re-render when the lazy summary lands (retained via data-rev)
    const [userOpen, setUserOpen] = useState(last);   // latest expanded, priors collapsed
    // A provenance click (a bottom-answer citation) sets revealSeq to a step; if that step is in THIS block,
    // force it open so scrollToStepSeq can reach the row. Derived DURING RENDER (a signal read, so the component
    // re-renders when revealSeq changes) into a sticky `stuckOpen` — NOT a useEffect, because a signal-driven
    // re-render doesn't reconcile effect deps (the effect never re-ran → the collapsed block stayed shut, the
    // bug). `stuckOpen` persists after revealSeq auto-clears so the block stays open + collapsible.
    const [stuckOpen, setStuckOpen] = useState(false);
    const reveal = revealSeq.value;
    if (reveal != null && !stuckOpen && block.turns.some(t => t.tools.some(s => s.seq === reveal))) setStuckOpen(true);
    const open = userOpen || stuckOpen;
    // This component only MOUNTS when Show-work is open, so firing here = fire-on-open (lazy). Cached by key.
    useEffect(() => { ensureBlockSummary(run.hash, index, block.prompt, block.answer?.text || ""); }, [run.hash, index]);
    const summary = blockSummaries.get(blockKey(run.hash, index));
    const header = summary || inlineText(block.prompt) || "(task)";
    return (
        <div class="run-block" data-rev={rv} data-reveal={reveal ?? ""}>
            {/* Toggling clears the reveal-forced open so a collapse actually collapses (else `stuckOpen` re-opens). */}
            <button class="run-block-head" onClick={() => { setUserOpen(!open); setStuckOpen(false); }}>
                <span class={`tri${open ? " open" : ""}`} aria-hidden="true"><IconChevron /></span>
                <span class={`run-block-sum${summary ? " ml-reveal" : ""}`}
                    title={summary ? `${summary}\n\nRequest: ${block.prompt}` : block.prompt}>{header}</span>
                <span class="sp" />
                <span class="run-block-n">{block.turns.length} {block.turns.length === 1 ? "step" : "steps"}</span>
            </button>
            {open ? (
                <div class="run-block-body">
                    <CardTraceMsg label="you asked" text={block.prompt} cls="acard-you" images={block.promptImages} />
                    {/* Turns + any MID-RUN steers, interleaved by step so a steer sits where it was sent, not
                        appended after all the work (and never mis-nested into a different block). */}
                    {[
                        ...block.turns.map(t => ({ pos: t.step, el: <AgentTurn key={`t${t.step}`} turn={t} max={run.maxSteps} hash={run.hash} /> })),
                        ...block.steers.map((s, k) => ({ pos: s.atStep + 0.5, el: <CardTraceMsg key={`st${k}`} label="you asked" text={s.text} cls="acard-you" images={s.images} steer={s.id ? { seen: s.seen } : undefined} /> })),
                    ].sort((a, b) => a.pos - b.pos).map(x => x.el)}
                    {/* Scope the answer's @tool aliases to THIS block's steps so a prior block's `@tool:python_exec`
                        points at its OWN call, not a later turn's (buildRunBlocks already split the turns per task). */}
                    {block.answer && !last ? <CardTraceMsg label={block.answer.cancelled ? "cancelled" : block.answer.hitCap ? "stopped early" : "answered"} text={block.answer.text || "(no reply)"} cls="acard-ans" run={run} scope={block.turns.flatMap(t => t.tools)} /> : null}
                </div>
            ) : null}
        </div>
    );
}
