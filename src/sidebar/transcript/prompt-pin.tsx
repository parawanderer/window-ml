// prompt-pin.tsx — THE MESSAGE YOU ARE READING THE ANSWER TO, pinned to the top of the panel once it scrolls away. A
// run's transcript is mostly machinery between two things you said, and a hundred steps down nothing on screen says
// which of them it is working on. The pin names it, and a click goes back to it (Claude Code pins the last prompt the
// same way). The panel and the overlay sidebar only: the chat page's calm view folds the machinery, which is the
// same problem answered another way.
//
// WHICH message is a question about where you are reading, not about the newest one: halfway through a session of
// five prompts it is the one ABOVE what is on screen. And that one may not be in the DOM at all, because a long
// transcript is windowed (transcript-window.tsx); so the order comes from the session's data, the positions from the
// messages that are drawn, and a click goes through `reveal`, which draws it first.

import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import type { Session } from "../store";
import { atBottom, rev, sessionMap } from "../store";
import { reveal } from "./transcript-window";
import { cursorTipOn } from "../ui-kit";
import { truncate } from "../format";
import { IconChevron } from "../icons";
import { hostOf } from "../../agent-start";

/** One message the pin can name: the key its bubble carries as `data-prompt`, and what it shows. */
export interface PinPrompt { key: string; text: string; who: string }

/**
 * A session's messages from its reader, in transcript order: an agent run's task, then each follow-up and mid-run
 * message by where it landed (the order `AgentRunView` sorts them into), or a chat's user turns. The keys are the
 * ones the bubbles carry, so the pin can match what is drawn against what is held.
 */
export function promptsOf(s: Session): PinPrompt[] {
    const text = (t: string | undefined, images?: readonly string[] | null): string => (t || "").trim() || (images?.length ? "(an image)" : "");
    if (s.kind === "agent") {
        const says = (s.says || []).map((m, i) => ({ m, i })).sort((a, b) => a.m.atStep - b.m.atStep || a.m.ts - b.m.ts);
        return [
            { key: "task", text: text(s.taskDisplay?.typed ?? s.task, s.taskImages), who: s.site ? hostOf(s.site) : "you" },
            ...says.map(({ m, i }) => ({ key: `s${i}`, text: text(m.display?.typed ?? m.text, m.images), who: m.site ? hostOf(m.site) : "you" })),
        ].filter((p) => p.text);
    }
    if (s.kind === "embed") return [];
    return (s.turns || []).map((t) => ({ key: `t${t.id}`, text: text(t.user, t.images), who: "user" })).filter((p) => p.text);
}

/**
 * Which message to pin, from where the drawn ones are. `order` is every message's key in transcript order; `drawn`
 * is the box of each one in the DOM; `viewTop` is the scroller's top edge, in the same coordinates.
 *
 * The answer is the LAST message that starts above the top edge, and nothing when that message is still partly on
 * screen (you can see it already). When no drawn message is above the edge, the one before the first drawn message
 * is: the window holds back only what is older, so it is above. And with none drawn at all, every message is.
 */
export function pinnedPrompt(order: readonly string[], drawn: ReadonlyMap<string, { top: number; bottom: number }>, viewTop: number): string | null {
    let cur: string | null = null, first = -1;
    for (let i = 0; i < order.length; i++) {
        const r = drawn.get(order[i]);
        if (!r) continue;
        if (first < 0) first = i;
        if (r.top >= viewTop) break;
        cur = order[i];
    }
    if (cur != null) return drawn.get(cur)!.bottom <= viewTop ? cur : null;
    const before = first < 0 ? order.length - 1 : first - 1;
    return before >= 0 ? order[before] : null;
}

/** How long the message a click lands on is marked, ms: the `astep-pulse` a citation's step gets. */
const PULSE_MS = 1400;

/**
 * The pin: a zero-height sticky row at the top of the scroller it is drawn in (its first child), showing the message
 * you have scrolled past. Draws nothing while that message is on screen, or when there is none.
 * @group transcript
 * @gallery none it draws only once the panel has scrolled a message out of view; covered by tests/e2e/prompt-pin.spec.mjs
 */
export function PromptPin({ hash }: { hash: string }) {
    // Every event re-measures: a new message moves the order, a new step moves the boxes.
    const r = rev.value;
    const s = sessionMap.get(hash);
    const prompts = s ? promptsOf(s) : [];
    const holder = useRef<HTMLDivElement>(null);
    const order = useRef<string[]>([]);
    order.current = prompts.map((p) => p.key);
    const [key, setKey] = useState<string | null>(null);
    const measure = useRef<() => void>(() => {});
    useLayoutEffect(() => {
        const scroller = holder.current?.parentElement;
        if (!scroller) return;
        let raf = 0;
        const run = (): void => {
            raf = 0;
            const top = scroller.getBoundingClientRect().top;
            const drawn = new Map<string, { top: number; bottom: number }>();
            for (const el of scroller.querySelectorAll<HTMLElement>("[data-prompt]")) {
                const b = el.getBoundingClientRect();
                if (b.height > 0 && el.dataset.prompt) drawn.set(el.dataset.prompt, b);
            }
            setKey(pinnedPrompt(order.current, drawn, top + 1));
        };
        measure.current = () => { if (!raf) raf = requestAnimationFrame(run); };
        run();
        scroller.addEventListener("scroll", measure.current, { passive: true });
        const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure.current);
        ro?.observe(scroller);
        return () => { scroller.removeEventListener("scroll", measure.current); ro?.disconnect(); if (raf) cancelAnimationFrame(raf); };
    }, [hash]);
    useEffect(() => measure.current(), [r]);
    const p = key != null ? prompts.find((x) => x.key === key) : undefined;
    const jump = (): void => {
        const scroller = holder.current?.parentElement;
        if (!p || !scroller) return;
        // Stop following the newest event first, or the panel pins itself back to the bottom as the window grows.
        atBottom.v = false;
        const find = (): HTMLElement | null => scroller.querySelector<HTMLElement>(`[data-prompt="${CSS.escape(p.key)}"]`);
        void reveal(hash, find).then((got) => {
            const el = find();
            if (got !== "shown" || !el) return;
            el.scrollIntoView({ block: "start", behavior: "smooth" });
            el.classList.add("astep-pulse");
            setTimeout(() => el.classList.remove("astep-pulse"), PULSE_MS);
        });
    };
    return (
        <div class="prompt-pin-row" ref={holder}>
            {p ? (
                <button type="button" class="prompt-pin" onClick={jump} aria-label={`Go back to the message: ${truncate(p.text, 120)}`}
                    {...cursorTipOn(<div class="prompt-pin-tip">{truncate(p.text, 600)}</div>)}>
                    <span class="who">{p.who}</span>
                    <span class="prompt-pin-text">{p.text}</span>
                    <span class="prompt-pin-go" aria-hidden="true"><IconChevron /></span>
                </button>
            ) : null}
        </div>
    );
}
