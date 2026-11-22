// live-call.tsx — a tool call the model is still WRITING, drawn as the start of the step it will become: the tool's
// name, and its code, Markdown or argument tree growing with a caret where the text arrives. A liveness signal, like a
// tool's streamed output: a long script or document passed as an argument used to show nothing until the model
// stopped. Display only; the step that replaces it is drawn from the parsed call.

import { noteLiveCall } from "./just-arrived";
import { noteLiveGlyphs, wasStreamed } from "./code-morph";
import { liveMounted, liveUnmounted } from "./live-hold";
import { focusMode } from "../store";
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { Code, Dot, cursorTipOn } from "../ui-kit";
import { IconQuiet } from "../icons";
import { markdown } from "../format";
import { closeStreaming } from "./stream-close";
import { JsonNode } from "./json-tree";
import { liveCallView } from "./live-call-view";
import { stallNote } from "./orb-status";
import { advance, nextGap, revealJumps, revealRate, tickDelay } from "./reveal";
import type { LiveToolCall } from "../../contract";

/** "1.2k chars" for a count of characters. */
const chars = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(1)}k chars` : `${n} chars`);

/** Whether the person asked for less motion. Read per arrival: cheap, and it follows a change of the setting. */
const reducedMotion = (): boolean => {
    try { return !!globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches; } catch { return false; }
};

/**
 * `text` TYPED OUT at an even pace instead of in the bursts it arrives in (reveal.ts has the rules). It only ever
 * shows text that has arrived, trailing it by about one gap between arrivals; a long backlog, a replaced text, an
 * expensive render or reduced motion shows it at once. Nothing waits on it: the step that replaces the call unmounts
 * it mid-reveal, and its timer goes with it.
 */
function useReveal(text: string): string {
    // state: ui — this call's reveal, gone with the call
    const st = useRef({ shown: 0, seen: "", gap: 90, rate: 0, at: 0, cost: 0, ticked: 0, timer: 0 });
    const [, bump] = useState(0);
    const s = st.current;
    const t0 = performance.now();
    if (text !== s.seen) {
        if (s.at) s.gap = nextGap(s.gap, t0 - s.at);
        s.at = t0;
        // A tick's step is measured from the PREVIOUS TICK, and from this arrival only when the reveal was idle: measured
        // from each arrival, a tick slower than the gap between arrivals (a long cell) never caught up.
        if (s.shown >= s.seen.length) s.ticked = t0;
        if (revealJumps({ shownText: s.seen.slice(0, s.shown), text, costMs: s.cost, reduced: reducedMotion() })) s.shown = text.length;
        s.rate = revealRate(text.length - s.shown, s.gap);
        s.seen = text;
    }
    // What a render costs (highlighting the cell is most of it), smoothed: it sets how often the reveal ticks.
    useLayoutEffect(() => { s.cost = s.cost ? s.cost * 0.7 + (performance.now() - t0) * 0.3 : performance.now() - t0; });
    // ONE pending tick at a time, armed when none is: an arrival never postpones it. Re-armed on every render, a tick
    // slower than the gap between arrivals (a long cell) was pushed back by each one and never fired.
    useEffect(() => {
        if (s.timer || s.shown >= s.seen.length) return;
        s.timer = setTimeout(() => {
            s.timer = 0;
            const now = performance.now();
            s.shown = advance(s.shown, s.seen.length, s.rate, now - s.ticked);
            s.ticked = now;
            bump((n) => n + 1);
        }, tickDelay(s.cost)) as unknown as number;
    });
    useEffect(() => () => clearTimeout(s.timer), []);
    return text.slice(0, s.shown);
}

/**
 * A tool call still being written, open, in the shape of a pending `.astep` so the step that lands in its place does
 * not jump: the name once the stream has said it, how much has arrived, and the arguments so far.
 *
 * @gallery {"call":{"index":0,"name":"python_exec","args":"{\"code\": \"import math\\nfor i in range(3):\\n    print(math.sqrt(i))\\nprint(\\\"do","chars":78}}
 * @group transcript
 */
export function LiveCall({ call, leaving, queued }: { call: LiveToolCall; /** folding away: its step is not opening to take it */ leaving?: boolean; /** the model has finished its answer: this call is written and waits behind the ones before it */ queued?: boolean }) {
    const v = liveCallView(call);
    // Code is typed out evenly; Markdown and argument trees are drawn as they arrive (re-rendering either per frame
    // costs more than it shows).
    const typed = useReveal(v.kind === "text" && v.as !== "markdown" ? v.text : "");
    // FOLLOW THE TEXT, like a terminal: past its height cap the body scrolls, and the line being written is the one to
    // see. Until the reader scrolls up to read an earlier line, which stops the follow; scrolling back down resumes it.
    const body = useRef<HTMLDivElement>(null);
    const follow = useRef(true);
    useLayoutEffect(() => { const el = body.current; if (!el) return; noteLiveCall(el.offsetHeight); if (follow.current) el.scrollTop = el.scrollHeight; });
    // As it unmounts for the step that replaces it, say where each character of the code sits, so the reformat can move them.
    // How long it stood and how many times it grew: a provider that sends the call whole leaves nothing to fly from.
    const life = useRef({ at: Date.now(), arrivals: 0, chars: call.chars });
    if (call.chars !== life.current.chars) { life.current.chars = call.chars; life.current.arrivals++; }
    useLayoutEffect(() => {
        const el = body.current;
        liveMounted(call.index);
        return () => {
            liveUnmounted(call.index);
            if (el) { noteLiveCall(el.offsetHeight); noteLiveGlyphs(el, wasStreamed(life.current.arrivals, Date.now() - life.current.at)); }   // the hand-over's window starts now
        };
    }, []);
    // The caret of a tree sits at the end of its last value: the tree is blocks, so it is placed by measuring (`.jt-args > .live-caret`).
    const args = useRef<HTMLDivElement>(null);
    useLayoutEffect(() => {
        const box = args.current, caret = box?.querySelector<HTMLElement>(":scope > .live-caret");
        if (!box || !caret) return;
        const vals = box.querySelectorAll<HTMLElement>(".jt-val"), at = vals.length ? vals[vals.length - 1] : box.querySelector<HTMLElement>(".jt-brace");
        if (!at) return;
        const b = box.getBoundingClientRect(), r = at.getBoundingClientRect();
        caret.style.left = `${Math.round(r.right - b.left + 2)}px`;
        caret.style.top = `${Math.round(r.top - b.top + (r.height - caret.offsetHeight) / 2)}px`;
    });
    const onScroll = (): void => { const el = body.current; if (el) follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 8; };
    // HAS IT GONE QUIET? A model that stalls mid-call (a server that stopped, a dropped stream) looked exactly like
    // one writing slowly: a counter that is not moving. Timed by THIS clock from when the count last changed, so a
    // runtime's skewed `ts` cannot fake or hide it, on a 1 s beat that is cleared with the call.
    const seen = useRef({ chars: call.chars, at: Date.now() });
    if (call.chars !== seen.current.chars) seen.current = { chars: call.chars, at: Date.now() };
    const [now, setNow] = useState(() => Date.now());
    useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);
    // WRITTEN, and drawn all the way: the readout of how much is arriving has nothing left to say (the calm view sends it away).
    const written = queued || (v.kind === "text" ? !v.writing && typed.length >= v.text.length : v.kind === "tree" ? !v.writing : false);
    // A call that is written, or waiting its turn, is not "gone quiet": nothing more is due from the model for it.
    const stall = written ? null : stallNote(now - seen.current.at);
    const tip = queued ? "Written, and waiting its turn: it runs after the calls before it." : written ? "Written. The model is finishing the rest of its answer." : "The model is still writing this call.";
    return (
        <div class={`astep tool pending open live-call${stall ? " stalled" : ""}${leaving ? " live-leaving" : ""}`} data-live-call={call.index} data-tool={call.name}>
            <div class="astep-head">
                <Dot status="pending" tip={tip} />
                <span class="tool-name">{call.name ?? "tool call"}</span>
                <span class={`astep-preview dim${written ? " written" : ""}`}>writing… {chars(call.chars)}{stall ? <span class="live-call-stall"> · {stall}</span> : null}</span>
                {/* The calm view's form of the same readout: a slowly pulsing clock, its words in the tip. A spinner
                    would say "working", which is the one thing a stall cannot claim. */}
                {stall ? <span class="live-call-quiet" role="img" aria-label={stall} {...cursorTipOn(stall)}><IconQuiet /></span> : null}
            </div>
            {/* The reading view's step carries the fold rail down its left; the live call wears it too (STILL: nothing folds a call
                that is being written), so it does not appear at the hand-over. */}
            <div class={`astep-body${focusMode.value ? " railed" : ""}`} ref={body} onScroll={onScroll}>
                {focusMode.value ? <span class="fold-rail fold-rail-still" aria-hidden="true" /> : null}
                {v.kind === "text" && v.as !== "markdown"
                    ? <div class={`live-call-code${v.writing || typed.length < v.text.length ? " writing" : ""}`}><Code text={typed} lang={v.as} /></div>
                    : v.kind === "text"
                        ? <div class={`md live-call-md${v.writing ? " writing" : ""}`} dangerouslySetInnerHTML={{ __html: markdown(closeStreaming(v.text) || "\u200b", { math: true }) }} />
                        : v.kind === "tree"
                            ? <div class="jt-args" ref={args}>
                                <JsonNode v={v.value} allOpen defaultOpen />
                                {v.writing ? <span class="live-caret" aria-hidden="true" /> : null}
                              </div>
                            : v.kind === "raw"
                                ? <div class="live-call-code writing"><Code text={v.text} lang="text" /></div>
                                : <span class="dim">The arguments appear here once the call is complete.</span>}
            </div>
        </div>
    );
}
