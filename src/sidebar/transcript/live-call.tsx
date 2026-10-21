// live-call.tsx — a tool call the model is still WRITING, drawn as the start of the step it will become: the tool's
// name, and its code, Markdown or argument tree growing with a caret where the text arrives. A liveness signal, like a
// tool's streamed output: a long script or document passed as an argument used to show nothing until the model
// stopped. Display only; the step that replaces it is drawn from the parsed call.

import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { Code, Dot } from "../ui-kit";
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
export function LiveCall({ call }: { call: LiveToolCall }) {
    const v = liveCallView(call);
    // Code is typed out evenly; Markdown and argument trees are drawn as they arrive (re-rendering either per frame
    // costs more than it shows).
    const typed = useReveal(v.kind === "text" && v.as !== "markdown" ? v.text : "");
    // FOLLOW THE TEXT, like a terminal: past its height cap the body scrolls, and the line being written is the one to
    // see. Until the reader scrolls up to read an earlier line, which stops the follow; scrolling back down resumes it.
    const body = useRef<HTMLDivElement>(null);
    const follow = useRef(true);
    useLayoutEffect(() => { const el = body.current; if (el && follow.current) el.scrollTop = el.scrollHeight; });
    const onScroll = (): void => { const el = body.current; if (el) follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 8; };
    // HAS IT GONE QUIET? A model that stalls mid-call (a server that stopped, a dropped stream) looked exactly like
    // one writing slowly: a counter that is not moving. Timed by THIS clock from when the count last changed, so a
    // runtime's skewed `ts` cannot fake or hide it, on a 1 s beat that is cleared with the call.
    const seen = useRef({ chars: call.chars, at: Date.now() });
    if (call.chars !== seen.current.chars) seen.current = { chars: call.chars, at: Date.now() };
    const [now, setNow] = useState(() => Date.now());
    useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);
    const stall = stallNote(now - seen.current.at);
    return (
        <div class={`astep tool pending open live-call${stall ? " stalled" : ""}`} data-live-call={call.index} data-tool={call.name}>
            <div class="astep-head">
                <Dot status="pending" />
                <span class="tool-name">{call.name ?? "tool call"}</span>
                <span class="astep-preview dim">writing… {chars(call.chars)}{stall ? <span class="live-call-stall"> · {stall}</span> : null}</span>
            </div>
            <div class="astep-body" ref={body} onScroll={onScroll}>
                {v.kind === "text" && v.as !== "markdown"
                    ? <div class={`live-call-code${v.writing || typed.length < v.text.length ? " writing" : ""}`}><Code text={typed} lang={v.as} /></div>
                    : v.kind === "text"
                        ? <div class={`md live-call-md${v.writing ? " writing" : ""}`} dangerouslySetInnerHTML={{ __html: markdown(closeStreaming(v.text) || "\u200b", { math: true }) }} />
                        : v.kind === "tree"
                            ? <div class="jt-args">
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
