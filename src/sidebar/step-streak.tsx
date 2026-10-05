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
import { useState } from "preact/hooks";
import type { AgentStep } from "./store";
import { rev, revealSeq } from "./store";
import type { AgentTurnGroup } from "./debug-reducer";
import { fmtDur } from "./timestamps";
import { toolFailed } from "./format";
import { IconChevron } from "./icons";

/** The fewest turns worth folding. Two is a pair; three is where a reader starts skipping. */
export const STREAK_MIN = 3;

/** A folded run of turns that all called the same tool. `turns` is kept whole so expanding renders exactly what
 *  would have been there — an open streak is indistinguishable from no streak at all. */
export interface ToolStreak { kind: "streak"; tool: string; turns: AgentTurnGroup[]; step: number; }

/** Is this turn one that can join a streak at all? Exactly one tool call, no PROSE (if the model said something
 *  that is content, not noise), and nothing awaiting approval — a gate is never hidden, under any circumstance.
 *  THINKING does not disqualify it: that is the other half of what is being folded away. */
function foldable(t: AgentTurnGroup): AgentStep | null {
    if (t.thought || t.tools.length !== 1) return null;
    const st = t.tools[0];
    if (!st.tool || (st.awaitingApproval && st.pending)) return null;
    return st;
}

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
 */
export function foldStreaks(groups: AgentTurnGroup[], { live = false } = {}): (AgentTurnGroup | ToolStreak)[] {
    const out: (AgentTurnGroup | ToolStreak)[] = [];
    for (let i = 0; i < groups.length;) {
        const first = foldable(groups[i]);
        if (!first) { out.push(groups[i++]); continue; }
        let j = i + 1;
        while (j < groups.length) {
            const next = foldable(groups[j]);
            if (!next || next.tool !== first.tool) break;
            j++;
        }
        const run = groups.slice(i, j);
        // `j < groups.length` is "something follows it". Otherwise it is the tail, and only a finished run may
        // fold its tail — a live one is still adding to it.
        const ended = j < groups.length || !live;
        if (run.length >= STREAK_MIN && ended) out.push({ kind: "streak", tool: first.tool!, turns: run, step: run[0].step });
        else out.push(...run);
        i = j;
    }
    return out;
}

/** How many of a streak's calls came back an error, and how long they took in total — the two things the rows
 *  themselves could not say. `ms` is null when no call reported a time, so nothing is claimed. */
export function streakFacts(s: ToolStreak): { failed: number; ms: number | null } {
    let failed = 0, ms = 0, timed = 0;
    for (const t of s.turns) {
        const st = t.tools[0];
        if (toolFailed(st.result)) failed++;
        if (typeof st.toolMs === "number") { ms += st.toolMs; timed++; }
    }
    return { failed, ms: timed ? ms : null };
}

/** Does this streak hold the step a jump is trying to reach? The rule behind the sticky open below, pulled out so
 *  it is testable without a DOM: a citation or an event-lane click that landed inside a FOLDED streak and did
 *  nothing would be a new way to break the thing `scrollToStepSeq` exists to prevent. */
export const holdsSeq = (s: ToolStreak, seq: number | null | undefined): boolean =>
    seq != null && s.turns.some(t => t.tools[0]?.seq === seq);

/** One folded streak: a row saying what the calls did, and the calls themselves when it is open. `render` draws a
 *  member, so this never duplicates what a turn looks like. */
export function StepStreak({ s, render }: { s: ToolStreak; render: (t: AgentTurnGroup) => preact.JSX.Element }) {
    const [open, setOpen] = useState(false);
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
    const { failed, ms } = streakFacts(s);
    return (
        <div class={`astreak${shown ? " open" : ""}`} data-rev={r}>
            <button class="astreak-head" onClick={() => { setStuck(false); setOpen(v => !v); }}
                aria-expanded={shown} aria-label={`${s.turns.length} ${s.tool} calls`}>
                <span class={`tri${shown ? " open" : ""}`} aria-hidden="true"><IconChevron /></span>
                <span class="astreak-tool">{s.tool}</span>
                <span class="astreak-n">× {s.turns.length}</span>
                {failed ? <span class="astreak-bad">{failed} failed</span> : null}
                {ms != null ? <span class="astreak-ms">{fmtDur(ms)}</span> : null}
            </button>
            {shown ? <div class="astreak-body">{s.turns.map(render)}</div> : null}
        </div>
    );
}
