// The HUD orb's live status — ONE pure projection over a run's current state into { icon, label, prose }.
// The point is LIVENESS: when a local model stalls for 20s on a big generation the orb must still prove the
// pipe is alive (a moving token count / an elapsed tick) rather than sitting frozen on "Looking…", so you can
// tell "the model is working" from "the glue broke". Kept pure + framework-free so it's unit-tested directly
// (streaming vs non-streaming) without mounting the component; hud-card.tsx calls orbStatus(run, now) and the
// heartbeat re-render is driven by a gated 1s ticker there.
import type { Session, AgentStep } from "./store";
import { stripFormatting } from "./format";

// Per-tool humanized status: `label` = what it's doing while the tool RUNS ("Running Python…"); `about` =
// what the model is chewing on once the tool has RETURNED ("Thinking about the Python output…"). `short` is
// the tab-strip glyph label. A custom tool with no entry degrades to a humanized `Running <name>…` (and
// "the result" for its about-phrase) — accommodating a caller who registered a tool but no status message.
export const ACTIVITY: Record<string, { icon: string; label: string; short: string; about: string }> = {
    look: { icon: "👁", label: "Viewing the screen…", short: "look", about: "what it saw" },
    findByText: { icon: "🔎", label: "Searching the page…", short: "find", about: "the matches" },
    interactives: { icon: "🔎", label: "Finding controls…", short: "controls", about: "the controls" },
    describeElement: { icon: "🔬", label: "Inspecting an element…", short: "inspect", about: "the element" },
    ancestors: { icon: "🧭", label: "Tracing the DOM…", short: "ancestors", about: "the DOM" },
    sampleText: { icon: "📄", label: "Reading text…", short: "read", about: "the text" },
    countMatches: { icon: "🔢", label: "Counting matches…", short: "count", about: "the count" },
    locate: { icon: "🎯", label: "Locating an element…", short: "locate", about: "the target" },
    click: { icon: "👆", label: "Clicking…", short: "click", about: "what changed" },
    type: { icon: "⌨️", label: "Typing…", short: "type", about: "what changed" },
    wait: { icon: "⏳", label: "Waiting for the page…", short: "wait", about: "the page" },
    exec: { icon: "λ", label: "Running JavaScript…", short: "exec", about: "the output" },
    python_exec: { icon: "🐍", label: "Running Python…", short: "python", about: "the Python output" },
    scroll: { icon: "🖱", label: "Scrolling…", short: "scroll", about: "the page" },
    screenshot: { icon: "📷", label: "Capturing…", short: "capture", about: "the capture" },
    fetch_url: { icon: "🌐", label: "Fetching a URL…", short: "fetch", about: "the page" },
    navigate: { icon: "🧭", label: "Navigating…", short: "navigate", about: "the new page" },
    answer: { icon: "📌", label: "Marking the answer…", short: "answer", about: "the answer" },
    agent_api_docs: { icon: "📖", label: "Reading its own manual…", short: "docs", about: "its manual" },
};

// The current turn's steps: those AFTER the last follow-up prompt's step position, so a fresh reply-turn
// never shows the PREVIOUS turn's tools. (Shared by activityFor + liveProseFor.)
function currentTurnSteps(run: Session): AgentStep[] {
    const steps = run.steps || [];
    const turnStart = Math.max(0, ...(run.says || []).map(s => s.atStep || 0));
    return steps.filter(s => (s.step || 0) > turnStart);
}

/** What the model is doing before it has produced anything this turn. "Thinking" was used for all of it,
 *  which is wrong in the two cases that take the longest and worry people most:
 *
 *   • AWAKENING — the model isn't resident yet, so the time is going into loading tens of GiB into VRAM.
 *     Nothing is being thought about; saying "Thinking… 17s" invites you to wonder what it could possibly be
 *     pondering. We can tell, now that the panel knows what is resident.
 *   • WAITING — resident, but nothing has come back yet: prompt processing, or a queue behind another
 *     request. Also not thinking.
 *
 *  THINKING is reserved for what it actually names: reasoning tokens arriving. Once ordinary content starts,
 *  it is writing, not thinking. */
export function startupPhase(run: Session, modelResident?: boolean): { icon: string; label: string; short: string } {
    const ls = run.liveStream;
    if (ls?.reasoning) return { icon: "💭", label: "Thinking…", short: "thinking" };
    if (ls?.content) return { icon: "✍️", label: "Writing…", short: "writing" };
    if (modelResident === false) return { icon: "🌅", label: "Awakening…", short: "loading" };
    return { icon: "⏳", label: "Waiting for the model…", short: "waiting" };
}

/** What the HUD orb should SAY a run is doing right now — the icon and the short label. Headless
 *  progress: the whole status when there is no panel open to read. */
export function activityFor(run: Session, modelResident?: boolean): { icon: string; label: string; short: string } {
    const cur = currentTurnSteps(run);
    // A tool actively RUNNING (pending) wins — that's the live op.
    const running = [...cur].reverse().find(s => s.pending && s.tool);
    if (running?.tool) {
        const A = ACTIVITY[running.tool];
        return A ? { icon: A.icon, label: A.label, short: A.short } : { icon: "⚙️", label: `Running ${running.tool}…`, short: running.tool };
    }
    // No tool running, but one just RETURNED → the model is processing its result. Name WHAT it's chewing on
    // ("Thinking about the Python output…") instead of a stale "Running Python…" or a context-free "Thinking…".
    const done = [...cur].reverse().find(s => s.tool && !s.pending);
    if (done?.tool) {
        const about = ACTIVITY[done.tool]?.about || "the result";
        // Once it starts WRITING, say so — "thinking about the Python output" while prose streams is stale.
        if (run.liveStream?.content && !run.liveStream?.reasoning)
            return { icon: "✍️", label: `Writing about ${about}…`, short: "writing" };
        return { icon: "💭", label: `Thinking about ${about}…`, short: "thinking" };
    }
    // Nothing yet this turn — and "thinking" is only one of the things that could mean (see startupPhase).
    return startupPhase(run, modelResident);
}

// The model's latest between-step PROSE (its `thought` narration, not the hidden `reasoning`) within the
// CURRENT turn — one plain ellipsized line. Null until the model narrates something this turn. Only the
// LATEST step's thought (an earlier step's caption goes stale as the agent moves on).
export function liveProseFor(run: Session): string | null {
    const cur = currentTurnSteps(run);
    if (!cur.length) return null;
    const latest = Math.max(0, ...cur.map(s => s.step || 0));
    const t = cur.filter(s => (s.step || 0) === latest).map(s => (s.thought || "").trim()).find(Boolean);
    return t ? (stripFormatting(t) || null) : null;
}

// Rough token estimate from the live stream buffer's accumulated characters (~4 chars/token). Streaming
// only — a non-streaming run has no liveStream, so no live count (it can't know mid-generation). Null when
// nothing has streamed yet.
export function liveTokensFor(run: Session): number | null {
    const ls = run.liveStream;
    if (!ls) return null;
    const chars = (ls.content?.length || 0) + (ls.reasoning?.length || 0);
    if (!chars) return null;
    return Math.round(chars / 4);
}

// Quantized so a per-90ms delta doesn't jitter the digits: ≥1k → "~1.2k tok"; below → nearest 10, "~840 tok".
export function fmtTokens(n: number): string {
    return n >= 1000 ? `~${(n / 1000).toFixed(1)}k tok` : `~${Math.round(n / 10) * 10} tok`;
}

// One plain ellipsized line for the caption — strips markdown/HTML (the pill is one line) and collapses
// whitespace, so streamed reply prose reads cleanly as it types.
function oneLine(s: string, cap = 140): string {
    const t = stripFormatting(s).replace(/\s+/g, " ").trim();
    return t.length > cap ? t.slice(0, cap - 1) + "…" : t;
}

// `caption` = render the orb as its auto-expanded caption pill (not the bare circle), because there's LIVE
// detail worth showing without a hover: streamed tokens ticking, the model's narration, or a stall's elapsed
// readout. The calm ambient phase (no live detail) stays a bare circle — caption is the "something's
// happening, show it" flag.
export interface OrbStatus {
    icon: string;
    label: string;
    /** The LIVE readout — a token count that is climbing, or the elapsed seconds of a stall. Kept OUT of
     *  `label` so a surface can render it in its own non-shrinking span: the pill ellipsizes on width, and
     *  with the two concatenated it was the readout that got cut ("Waiting for the model… · 1…" at ten
     *  seconds). That is precisely backwards — the phase label is the part you have already read, and the
     *  number is the only thing on the pill that is still telling you something. */
    suffix?: string;
    caption: boolean;
}

// No fresh activity for this long → append an elapsed "· Ns" so a frozen phase still proves the pipe is
// alive (the "did it hang or is it just slow?" case, especially with nothing to stream).
export const STALL_MS = 4000;

/** Compose the orb's live status. Priority: (1) STREAMING reply prose the model is typing right now → stream
 *  it live; else (2) the tool/thinking phase from activityFor, decorated with a live token count when
 *  streaming, or an elapsed heartbeat once it's gone quiet. `now` is injected so the heartbeat is testable. */
export function orbStatus(run: Session, now: number = Date.now(), modelResident?: boolean): OrbStatus {
    const tokens = liveTokensFor(run);
    const tokSuffix = tokens != null ? ` (${fmtTokens(tokens)})` : "";

    // (1) The model is emitting REPLY prose (not hidden reasoning) — its in-between/final output. Stream it
    //     live as the caption; that live typing is itself the liveness signal, so pair it with the count.
    const liveContent = run.liveStream?.content?.trim();
    if (liveContent) return { icon: "💬", label: oneLine(liveContent), suffix: tokSuffix || undefined, caption: true };

    // (2) Tool or thinking phase. A narrated `thought` (if any) rides as the caption over the phase label.
    const prose = liveProseFor(run);
    const a = activityFor(run, modelResident);
    const label = prose || a.label;
    let caption = !!prose || !!tokSuffix;                                // narrating or streaming → expand to show it
    let suffix = tokSuffix || undefined;                                 // streaming → live count (it's moving)
    if (!suffix && now - (run.lastTs || 0) > STALL_MS) {                 // quiet → elapsed heartbeat (still alive)
        suffix = ` · ${Math.round((now - (run.lastTs || 0)) / 1000)}s`;
        caption = true;                                                  // a stall IS the case we most want visible
    }
    return { icon: a.icon, label, suffix, caption };
}
