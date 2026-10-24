// step-streak.tsx — FOLDING A RUN OF THE SAME TOOL in the reading view.
//
// A model that calls `exec` eight times in a row produces eight turns, each with its own `thinking 17 tokens`
// above it, filling a screen and a half. What makes that unreadable is not the repetition: a collapsed step row
// shows the tool's name and a preview of its output, and when the previews are empty eight rows say `exec` eight
// times. If they read "3 fare cards", "#261 merged", you would want them listed. So the honest condition is "a run
// of adjacent steps that say nothing distinguishable", and the same tool name is the cheap, legible approximation
// of it — a rule a reader can predict, which a cleverer heuristic would not be.
//
// It follows that the folded row has to carry what the rows could not. `exec × 8` alone is the same nothing,
// compressed; the failure count is the part that matters, because in the run this came from two calls were red and
// that was the only signal in the whole stretch.
//
// CALM ONLY, and nothing is dropped: the busy view keeps the whole trace, and so do both exports. Design note and
// the rules behind each clause: tmp/design-tool-streaks.md.
import { createContext } from "preact";
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import type { AgentStep } from "../store";
import { rev, revealSeq } from "../store";
import type { AgentTurnGroup } from "../debug-reducer";
import { fmtDur } from "../timestamps";
import { toolFailed } from "../format";
import { IconChevron } from "../icons";
import { FoldRail } from "./fold-rail";
import { useCloseAnimation } from "../use-close";
import { justArrived } from "./just-arrived";
import { useHistoryPaint } from "./history-paint";
import { Ticking } from "../ui-kit";

/** A member drawn inside a streak, where the GROUP owns the motion: a step that also slid itself in would fight
 *  the collapse that is describing the same event. Only the members the group was opened with (`groupOwns`): a call
 *  that JOINS an open group arrives like any other. */
export const InStreak = createContext(false);

/**
 * Which members' motion the GROUP speaks for, and so which stay still as they are drawn inside it.
 *
 * The ones it was OPENED with: the rows a refold collapses, and the rows a reader's click opens (the body's own opening
 * is the motion then). A call that lands while the group is open is new to the reader, and arrives as a call does
 * anywhere else, sliding in from the left; it was a row appearing in one frame at the foot of the group.
 * @param known the members' steps when the body was last closed (or the group mounted)
 * @param step a member's step
 */
export const groupOwns = (known: ReadonlySet<number>, step: number): boolean => known.has(step);

/** The fewest turns worth folding. Two is a pair; three is where a reader starts skipping. */
export const STREAK_MIN = 3;

/** The fewest CALLS worth folding once the reader has asked for everything to be grouped. Counted in calls and not
 *  in turns, which is the only counting that answers both halves of the question: one lone step is not a group and
 *  is left where it is, while ONE turn whose model call decided on five tools is five calls and is. */
export const STREAK_MIN_ALL = 2;

/** When this streak's last call landed — 0 when nothing in it is stamped. */
const lastTs = (s: ToolStreak): number => {
    const tools = s.turns[s.turns.length - 1]?.tools ?? [];
    return tools[tools.length - 1]?.ts ?? 0;
};

/**
 * Did this fold happen IN FRONT OF THE READER? The rule behind the collapse-on-mount below, pulled out so it is
 * testable without a DOM and without waiting on a clock — the same reason {@link holdsSeq} is.
 *
 * A fold the reader WATCHED — three `exec` rows replaced the instant a fourth tool lands — has to collapse, or a
 * block of the transcript vanishes between frames and they go looking for it. A transcript OPENED LATER wants to
 * be folded already. {@link justArrived} is that distinction, shared with the arriving-turn animation, because
 * two answers to "did I see this happen" is how one of them ends up subtly different.
 */
export const foldedInView = (s: ToolStreak, now = Date.now()): boolean => {
    if (!justArrived(lastTs(s), now)) return false;
    // …AND THE ROWS WERE ON SCREEN LONG ENOUGH TO HAVE BEEN SEEN. One turn that calls two tools at once folds about as
    // soon as its first row appears, and collapsing a row that was up for a few frames is a flicker rather than a
    // motion that says where anything went. Measured from the EARLIEST stamped call, which is the row that was up
    // longest; with nothing earlier than the last stamped, there is no evidence anything was watched.
    const first = firstTs(s);
    return first > 0 && now - first >= FOLD_SEEN_MS;
};

/** How long a group's rows must have been on screen before folding them is worth animating. */
export const FOLD_SEEN_MS = 600;

/**
 * The rows a refold collapses: the members that were on screen, not the call that CAUSED the fold. That one landed a
 * moment ago and was never a row to the reader; drawn into the collapse, it made the group's first frame a row taller
 * than the transcript had been the frame before, and then shrink. It arrives already inside the head instead, so the
 * collapse starts at exactly the height the reader was looking at.
 * @param turns the group's members
 * @param now when the group mounted
 */
export const rowsSeen = (turns: AgentTurnGroup[], now = Date.now()): AgentTurnGroup[] =>
    turns.filter(t => t.tools.some(st => !!st.ts && now - st.ts >= FOLD_SEEN_MS));

/**
 * Did this group COME TOGETHER in front of the reader, without the collapse above having been the motion?
 *
 * The ordinary fold's motion is the rows shrinking into one row, which only exists when they were on screen long
 * enough to have been seen (`foldedInView`). A "group all" pair, or two calls that land within `FOLD_SEEN_MS`,
 * never had separate rows to collapse — the component mounts already folded — and that is the case the user's eye
 * actually reports as "the tool calls popped onto the screen and were suddenly one thing". So the head itself has
 * to say they were grouped.
 *
 * Same clock as {@link foldedInView}, and history is excluded the same way: a transcript opened later is already
 * a group and must simply be one.
 */
export const groupedInView = (s: ToolStreak, now = Date.now()): boolean =>
    justArrived(lastTs(s), now) && !foldedInView(s, now);

/** When this streak's earliest stamped call landed — 0 when none is stamped. */
const firstTs = (s: ToolStreak): number => {
    let min = 0;
    for (const t of s.turns) for (const st of t.tools) if (st.ts && (!min || st.ts < min)) min = st.ts;
    return min;
};

/** A folded run of turns. `turns` is kept whole so expanding renders exactly what would have been there — an open
 *  streak is indistinguishable from no streak at all. `tools` is the DISTINCT tool names in it, in order: one in
 *  the ordinary rule by construction, and however many the reader's "group everything" toggle swept up. */
export interface ToolStreak { kind: "streak"; tool: string; tools: string[]; turns: AgentTurnGroup[]; step: number; }

/**
 * Is this turn one that can join a streak at all?
 *
 * Exactly one tool call, no PROSE (if the model said something that is content, not noise), nothing awaiting
 * approval (a gate is never hidden, under any circumstance), and nothing that REVISES an earlier call.
 *
 * WHY THE TOOL'S NAME IS ENOUGH HERE, which took being wrong twice to see. In the reading view the collapsed row's
 * output preview is hidden as spam (`html[data-focus] .astep-preview`), so every collapsed tool row says its name
 * and nothing else — "a run of rows that say nothing distinguishable" and "a run of the same tool" are the same
 * set in this view, which they would not be in the panel. Gating on the preview's TEXT would be testing something
 * the reader cannot see.
 *
 * The one row that still says something is a RETRY's: focus mode folds a diff's rows but deliberately keeps its
 * header, which names what the step revises and by how much. Folding the step takes that header with it — and a
 * real run in this repo's own tests is three `python_exec` calls each revising the last, where it would also mean
 * flipping into the reading view makes whatever you were reading disappear.
 *
 * THINKING does not disqualify a turn: that is the other half of what is being folded away.
 */
function foldable(t: AgentTurnGroup): AgentStep | null {
    if (t.thought || t.tools.length !== 1) return null;
    const st = t.tools[0];
    if (!st.tool || (st.awaitingApproval && st.pending)) return null;
    if (revisionOf(st)) return null;
    return st;
}

/**
 * The `all` mode's much shorter question: is this turn anything other than CONTENT or a DECISION?
 *
 * The rule above is conservative because it is GUESSING — it folds only where the rows provably say nothing a
 * reader could tell apart, and every clause is an argument for why some row might still be worth seeing. A reader
 * who has turned "group all tool calls" on has answered all of those arguments at once, so the clauses that
 * protect a legible row (a different tool, a revision's header, fewer than three, a tail still growing) go.
 *
 * TWO DO NOT GO, and neither is about legibility. A gate is a DECISION waiting on a human and may never be hidden
 * by a display preference, under any circumstance. And prose is what the model SAID, which is the thing the
 * reading view exists to show — folding that away would leave a transcript of nothing but folded rows.
 *
 * A turn with no tool call at all — pure thinking — folds here and not above: that is the other half of what this
 * toggle was asked for ("group all tool calls AND thinking blocks").
 */
function foldableAll(t: AgentTurnGroup): boolean {
    if (t.thought) return false;
    return !t.tools.some((st) => st.awaitingApproval && st.pending);
}

/**
 * Which SEGMENT of the transcript a turn is in — how many boundaries sit before it.
 *
 * A fold may not span one. Answers and the reader's own messages are interleaved with the turns BY POSITION
 * after the fold is computed, so a streak that merged across one left that item rendering below the whole block:
 * a run's "stopped at its step cap" seam appeared after the seven steps it sat in the middle of, which says the
 * opposite of what happened. Found by a demo, because a finished transcript shows a plausible-looking order.
 *
 * A boundary of `4` means "after turn 4, before turn 5" — the same `atStep + 0.5` the items list positions by.
 */
const segmentOf = (step: number, breaks: readonly number[]): number => {
    let n = 0;
    for (const b of breaks) if (b < step) n++;
    return n;
};

/** The distinct tool names in a run of turns, in the order they first appear. */
const toolsIn = (turns: AgentTurnGroup[]): string[] => {
    const seen: string[] = [];
    for (const t of turns) for (const st of t.tools) if (st.tool && !seen.includes(st.tool)) seen.push(st.tool);
    return seen;
};

/** Does this step revise an earlier one? The link lives on the IN descriptor, which is the only place the "revises"
 *  line comes from — so it is also the only way to know that folding the row would take that line with it. */
const revisionOf = (st: AgentStep): unknown =>
    st.renderIn && typeof st.renderIn === "object" && "revision" in st.renderIn ? st.renderIn.revision : undefined;

/**
 * Fold runs of same-tool turns, leaving everything else alone.
 *
 * A streak folds only once it has ENDED — something follows it, or the run is no longer going. Rows collapsing
 * out from under you while you are reading them is motion at exactly the wrong moment; a repeated tool is often
 * the thing you are watching; and the end of a streak is a real event, so the fold means something. That also
 * keeps it clear of the pulsing rail on the in-flight step.
 *
 * @param groups the run's turns, in order (`groupTurns`)
 * @param live is the run still going? the last streak stays open while it is
 * @param all the reader's "group all tool calls" preference — fold by adjacency rather than by tool name
 * @param breaks step positions a fold may not span: where an answer or one of the reader's own messages sits
 */
export function foldStreaks(groups: AgentTurnGroup[], { live = false, all = false, breaks = [] as readonly number[] } = {}): (AgentTurnGroup | ToolStreak)[] {
    const out: (AgentTurnGroup | ToolStreak)[] = [];
    const seg = (t: AgentTurnGroup): number => segmentOf(t.step, breaks);
    for (let i = 0; i < groups.length;) {
        if (all) {
            if (!foldableAll(groups[i])) { out.push(groups[i++]); continue; }
            let j = i + 1;
            while (j < groups.length && foldableAll(groups[j]) && seg(groups[j]) === seg(groups[i])) j++;
            const run = groups.slice(i, j);
            // NO "ENDED" TEST HERE, unlike the ordinary rule. A group of two exists almost immediately and every
            // later call joins a row that is ALREADY closed, so nothing collapses out from under a reader mid-run —
            // the count simply ticks up. It is also the only way the toggle does anything at all while a run goes.
            const calls = run.reduce((n, t) => n + t.tools.length, 0);
            if (calls >= STREAK_MIN_ALL) out.push({ kind: "streak", tool: toolsIn(run)[0] ?? "", tools: toolsIn(run), turns: run, step: run[0].step });
            else out.push(...run);
            i = j;
            continue;
        }
        const first = foldable(groups[i]);
        if (!first) { out.push(groups[i++]); continue; }
        let j = i + 1;
        while (j < groups.length) {
            const next = foldable(groups[j]);
            if (!next || next.tool !== first.tool || seg(groups[j]) !== seg(groups[i])) break;
            j++;
        }
        const run = groups.slice(i, j);
        // `j < groups.length` is "something follows it". Otherwise it is the tail, and only a finished run may
        // fold its tail — a live one is still adding to it.
        const ended = j < groups.length || !live;
        if (run.length >= STREAK_MIN && ended) out.push({ kind: "streak", tool: first.tool!, tools: [first.tool!], turns: run, step: run[0].step });
        else out.push(...run);
        i = j;
    }
    return out;
}

/** How many of a streak's calls came back an error, and how long they took in total — the two things the rows
 *  themselves could not say. `ms` is null when no call reported a time, so nothing is claimed. */
export function streakFacts(s: ToolStreak): { failed: number; ms: number | null; calls: number; pending: boolean } {
    let failed = 0, ms = 0, timed = 0, calls = 0, pending = false;
    for (const t of s.turns) {
        // Every call, not `tools[0]`: the "group all" rule sweeps up a turn whose one model call decided on
        // SEVERAL tools, and counting those as one would under-report the thing the row exists to report.
        for (const st of t.tools) {
            calls++;
            if (toolFailed(st.result)) failed++;
            if (st.pending) pending = true;
            if (typeof st.toolMs === "number") { ms += st.toolMs; timed++; }
        }
    }
    return { failed, ms: timed ? ms : null, calls, pending };
}

/** Does this streak hold the step a jump is trying to reach? The rule behind the sticky open below, pulled out so
 *  it is testable without a DOM: a citation or an event-lane click that landed inside a FOLDED streak and did
 *  nothing would be a new way to break the thing `scrollToStepSeq` exists to prevent. */
export const holdsSeq = (s: ToolStreak, seq: number | null | undefined): boolean =>
    seq != null && s.turns.some(t => t.tools.some(st => st.seq === seq));

/** One folded streak: a row saying what the calls did, and the calls themselves when it is open. `render` draws a
 *  member, so this never duplicates what a turn looks like.
 *  @group transcript
 *  @gallery mixed tools, one failed {"s": {"kind": "streak", "tool": "fetch_url", "tools": ["fetch_url", "agent_api_docs", "exec"], "turns": [{"step": 1, "localStep": 1, "tools": [{"step": 1, "tool": "fetch_url", "result": "ok", "toolMs": 120}]}, {"step": 2, "localStep": 2, "tools": [{"step": 2, "tool": "agent_api_docs", "result": "ok", "toolMs": 86}]}, {"step": 3, "localStep": 3, "tools": [{"step": 3, "tool": "exec", "result": "Error: boom", "toolMs": 40}]}, {"step": 4, "localStep": 4, "tools": [{"step": 4, "tool": "exec", "result": "ok", "toolMs": 140}]}], "step": 1}}
 *  @gallery-flow summary slides away tests/gallery-flows/StepStreak.mjs {"s": {"kind": "streak", "tool": "fetch_url", "tools": ["fetch_url", "agent_api_docs", "exec"], "turns": [{"step": 1, "localStep": 1, "tools": [{"step": 1, "tool": "fetch_url", "result": "ok", "toolMs": 120}]}, {"step": 2, "localStep": 2, "tools": [{"step": 2, "tool": "agent_api_docs", "result": "ok", "toolMs": 86}]}, {"step": 3, "localStep": 3, "tools": [{"step": 3, "tool": "exec", "result": "Error: boom", "toolMs": 40}]}, {"step": 4, "localStep": 4, "tools": [{"step": 4, "tool": "exec", "result": "ok", "toolMs": 140}]}], "step": 1}}
 */
export function StepStreak({ s, render }: { s: ToolStreak; render: (t: AgentTurnGroup) => preact.JSX.Element }) {
    // FOLDING IN FRONT OF A READER, as a collapse rather than a cut. Captured ONCE, on mount: it is a fact about
    // how this streak came to exist, and re-reading the clock on later renders would make it decay mid-animation.
    const history = useHistoryPaint();
    // Cleared once the collapse is done, so a group opened later by a click is an ordinary open group (its rail, its
    // titles) rather than one still dressed for the fold.
    const [refolding, setRefolding] = useState(() => !history && foldedInView(s));
    const [mountedAt] = useState(() => Date.now());
    // …AND A GROUP THAT NEVER HAD ROWS TO COLLAPSE still has to say it gathered them. `forming` is the pair
    // `foldedInView` refuses: the component mounted already folded, so the head is the only motion there is.
    // `grouped` is the wider set — a watched fold washes the head too, so the row you are left looking at is
    // marked as the thing the vanished rows became.
    const [forming] = useState(() => !history && groupedInView(s));
    const grouped = refolding || forming;
    const [open, setOpen] = useState(refolding);
    const { failed, ms, calls, pending } = streakFacts(s);
    // A CALL JOINING A LIVING GROUP is the one moment the fold's own motion cannot speak: the row is already
    // closed and nothing moves except a number. That number gets a pop — and only then. The counter is seeded
    // with the count it already shows, so a streak drawn into a transcript (or one that formed a moment ago and
    // is animating its head) does not also punch its own tally on the way in.
    const prevCalls = useRef(calls);
    const [bumped, setBumped] = useState(false);
    useEffect(() => {
        if (prevCalls.current === calls) return;
        prevCalls.current = calls;
        setBumped(true);
        const t = setTimeout(() => setBumped(false), 320);
        return () => clearTimeout(t);
    }, [calls]);
    // THROUGH THE SAME CLOSE A STEP USES. Eleven turns arriving in one frame is most of a screen appearing at once,
    // which shoves whatever you were reading down the page — the shove `.astep-body` was given an animation for,
    // and this was the one disclosure on the surface still doing it. The surface declares the duration; the hook
    // holds the body mounted for exactly that long so there is something left to animate.
    const rootRef = useRef<HTMLDivElement>(null);
    const { closing, close, cancel } = useCloseAnimation(rootRef);
    // A citation or an event-lane click that jumps INTO a folded streak has to open it, or we have built a new way
    // to make a citation silently do nothing. Read during render into a sticky flag, the way a step and the HUD's
    // per-task block already do it: `revealSeq` clears itself about a second later, and reading it directly would
    // fold the streak again right after it opened.
    // SUBSCRIBED TO `rev` TOO, and the read is kept in the output. This renders inside the WINDOWED transcript, and
    // reading a signal here makes @preact/signals memoize the component on its props — which stops it re-rendering
    // from the parent's cascade, and that cascade is how a grown window reaches the screen. Exactly the trap
    // `RunStatsBar` already carries a note about.
    const r = rev.value;
    const want = revealSeq.value;
    const [stuck, setStuck] = useState(false);
    const holds = holdsSeq(s, want);
    if (holds && !stuck) setStuck(true);
    const shown = open || stuck;
    // The members the group speaks for (`groupOwns`): every one present while it is shut, and none that joins after
    // it opens. Kept in a ref and read during render, like `stuck`: it is about how each row came to be drawn.
    const known = useRef<Set<number>>(new Set(s.turns.map(t => t.step)));
    if (!shown) known.current = new Set(s.turns.map(t => t.step));
    // Opening is immediate; closing waits for the animation, which is why both pieces of state are cleared in the
    // callback rather than on the click. `stuck` goes with them: a streak held open by a jump closes like any other
    // once you ask it to, or the one opened FOR you is the one that will not shut.
    const toggle = (): void => {
        if (!shown) { cancel(); setOpen(true); return; }
        close(() => { setStuck(false); setOpen(false); });
    };
    // The collapse starts BEFORE the first paint, from where the rows were: a layout effect, which runs once the node
    // exists (`close` measures the duration off it) and before the browser draws. It was an ordinary effect, which
    // painted one frame of the group OPEN first — the head appearing above both rows with the rail beside them —
    // and then shut it, which read as the group popping into existence and snapping closed.
    useLayoutEffect(() => { if (refolding) close(() => { setOpen(false); setRefolding(false); }); }, []);
    // ONE TOOL NAMES ITSELF — `exec × 4` reads as the rows it replaced. SEVERAL cannot, so the row counts the calls
    // and names the tools beside it: "11 tool calls · exec, look, python_exec". Dropping the names would make the
    // one row standing for a whole run of work say less about it than any one of the rows did.
    const one = s.tools.length === 1;
    // The names already listed when the group was drawn. One that joins after ARRIVES (`.arrived`, chat.css) with its
    // comma, as a call does, rather than the list being redrawn a name longer in one frame.
    const named = useRef<ReadonlySet<string>>(new Set(s.tools));
    // `expanded` is the reader's INTENT, like the chevron's turn below: it goes on at the click and comes off at the
    // click that folds, while `open` lingers until the body has finished leaving. The summary slides away and back
    // on that flag (chat.css), so it moves with the click and not after the rows.
    return (
        <div ref={rootRef} class={`astreak${shown ? " open" : ""}${shown && !closing ? " expanded" : ""}${closing ? " closing" : ""}${refolding ? " refolding" : ""}${grouped ? " grouped" : ""}${forming ? " forming" : ""}${pending ? " running" : ""}`} data-rev={r}>
            <button class="astreak-head" onClick={toggle}
                aria-expanded={shown && !closing}
                aria-label={one ? `${calls} ${s.tool} calls` : `${calls} tool calls: ${s.tools.join(", ")}`}>
                {/* The chevron turns back on the CLICK, not when the body has finished leaving: it is the control's
                    acknowledgement, and the body collapsing behind it is the result. */}
                <span class={`tri${shown && !closing ? " open" : ""}`} aria-hidden="true"><IconChevron /></span>
                {/* The count POPS when a later call joins (`bumped` above): the one moment the fold's motion cannot
                    describe, because the row is already closed and nothing else moves. */}
                {one
                    ? <><span class="astreak-tool">{s.tool}</span><span class={`astreak-n${bumped ? " bumped" : ""}`}>× {calls}</span></>
                    : <><span class={`astreak-n astreak-calls${bumped ? " bumped" : ""}`}>{calls} tool calls</span>
                        <span class="astreak-tools">{s.tools.map((t, i) =>
                            <span key={t} class={`astreak-name${named.current.has(t) ? "" : " arrived"}`}>{i ? ", " : ""}{t}</span>)}</span></>}
                {failed ? <span class="astreak-bad">{failed} failed</span> : null}
                {/* A GROUP THAT IS STILL GROWING SAYS SO. In "group all" the newest call joins a row that is already
                    closed, so without this the only sign of a run in progress would be the number changing. */}
                {pending ? <span class="astreak-live">running…</span> : ms != null ? <span class="astreak-ms"><Ticking text={fmtDur(ms)} /></span> : null}
            </button>
            {shown
                ? <div class={`astreak-body${closing ? " closing" : ""}`}>
                    {/* THE RAIL IS THE CONTROL, not a decoration. It is the one thing on screen that says where the
                        group ends, so it is what a reader points at when they want it gone — and it was a `border`,
                        which cannot be clicked. A real element, with a hit strip wider than the 2px line it draws.

                        Pointer-only, deliberately: `aria-hidden` + `tabindex -1` because it DUPLICATES the header
                        above it, and a second tab stop for one action is noise in a keyboard pass. The header is
                        also the full-width target a finger gets — a thin strip beside the content is a mis-tap
                        waiting to happen on a phone, which is why the stylesheet takes this one's clicks away on a
                        coarse pointer. */}
                    <FoldRail onFold={toggle} tip="Collapse this group" />
                    {(refolding ? rowsSeen(s.turns, mountedAt) : s.turns).map(t => <InStreak.Provider key={`m${t.step}`} value={groupOwns(known.current, t.step)}>{render(t)}</InStreak.Provider>)}
                  </div>
                : null}
        </div>
    );
}
