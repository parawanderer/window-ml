// streaming-md.tsx — a reply drawn WHILE IT STREAMS: each new word fades in instead of appearing with a jump.
//
// Every update renders the whole reply again (its open Markdown closed first, stream-close.ts, so the text only ever
// grows), and then marks the words. Each word is remembered by its POSITION in the text, with the moment it first
// appeared; a word still inside its fade is wrapped in a span whose animation delay is how far into the fade it already
// is (negative), so drawing the reply again does not restart it. That is why there is no DOM diffing here: the HTML can
// be replaced wholesale and nothing visible restarts.
//
// New words are also PACED: the stream arrives in bursts, and a burst of twelve words fading in together reads as a
// block appearing. Each word starts a little after the one before, never more than `FADE_LAG_MS` behind the stream.

import { useLayoutEffect, useRef } from "preact/hooks";
import { markdown } from "../format";
import { cssDurationMs } from "../use-close";
import { closeStreaming } from "./stream-close";
import { splitAnswer } from "../../pointers/answer-tokens";
import { escapeHtml } from "../format";

/** How long after the previous word a new one starts fading, while a burst is being spread out. */
export const FADE_STEP_MS = 24;
/** The most a word may be held back behind the stream to keep the pace even. */
export const FADE_LAG_MS = 150;

/**
 * Mark the words under `root` that are still fading. `starts[k]` is when the k-th word of the text first appeared;
 * a word seen for the first time is given a start now (paced after the previous new word), or, when `live` is false,
 * none at all (`-Infinity`: it was already there, as on a reply redrawn after it settled). A word whose fade is over
 * is left as plain text.
 */
export function fadeWords(root: Element, starts: number[], now: number, fadeMs: number, live = true): void {
    const doc = root.ownerDocument;
    const walker = doc.createTreeWalker(root, 4 /* NodeFilter.SHOW_TEXT */);
    const texts: Text[] = [];
    for (let n = walker.nextNode(); n; n = walker.nextNode()) texts.push(n as Text);
    let k = 0;
    let last = starts.length ? Math.max(...starts.filter(Number.isFinite), -Infinity) : -Infinity;
    for (const t of texts) {
        const pieces = t.data.match(/\s+|\S+\s*/g);
        if (!pieces) continue;
        let fading = false;
        const ages: number[] = [];
        for (const p of pieces) {
            if (!/\S/.test(p)) { ages.push(Infinity); continue; }
            if (starts[k] === undefined) {
                starts[k] = live ? Math.min(Math.max(now, last + FADE_STEP_MS), now + FADE_LAG_MS) : -Infinity;
                if (live) last = starts[k];
            }
            const age = now - starts[k++];
            ages.push(age);
            if (age < fadeMs) fading = true;
        }
        if (!fading) continue;
        const frag = doc.createDocumentFragment();
        let plain = "";
        pieces.forEach((p, i) => {
            if (ages[i] >= fadeMs) { plain += p; return; }
            if (plain) { frag.appendChild(doc.createTextNode(plain)); plain = ""; }
            const span = doc.createElement("span");
            span.className = "w-in";
            span.style.animationDelay = `${Math.round(-ages[i])}ms`;
            span.textContent = p;
            frag.appendChild(span);
        });
        if (plain) frag.appendChild(doc.createTextNode(plain));
        t.replaceWith(frag);
    }
}

/** The Markdown of a streaming reply with each finished `@tool:` citation set aside, and the HTML to put back in its
 *  place. The citations are resolved only once the answer settles (`AnswerBody`); until then an EMBED is its label,
 *  quiet, where the value will be, and a LINK is its label as text. Inline, both: a short value settles inline in the
 *  sentence (`42`), and which values are short is not known until they are resolved. Without this the plain renderer drew
 *  the literal `![label](@tool:…)` for the whole stream and then swapped it for the embed. */
export function setAsideTokens(md: string, isAlias?: (name: string) => boolean): { md: string; restore: (html: string) => string } {
    const kept: string[] = [];
    const text = splitAnswer(md, isAlias).map((seg) => {
        if (seg.kind === "prose") return seg.text;
        const label = escapeHtml(seg.label || `@tool:${seg.id}`);
        kept.push(`<span class="${seg.embed ? "tok-streaming" : "tok-streaming-link"}">${label}</span>`);
        return `@@TOK${kept.length - 1}@@`;
    }).join("");
    const restore = (html: string): string => html.replace(/@@TOK(\d+)@@/g, (_, i: string) => kept[+i]);
    return { md: text, restore };
}

// state: ui (when each run last drew a live answer, by run hash; a page reload loses it, and then nothing is animating)
const liveAnswerAt = new Map<string, number>();
/** How soon after its last live frame a run's final answer counts as the same answer settling. */
const CONTINUES_MS = 2000;

/** A run drew its answer live just now. Called while the live bubble renders (agent-detail.tsx, `LiveStream`). */
export const noteLiveAnswer = (hash: string, now = Date.now()): void => { liveAnswerAt.set(hash, now); };

/** Is the answer mounting now the one that was just streaming? An agent's live bubble and its finished answer are
 *  different elements, so without this the answer the reader watched stream in vanished and grew back in from nothing
 *  (reply.tsx, `useReplyArrival`). */
export const continuesLiveAnswer = (hash: string | undefined, now = Date.now()): boolean => {
    const at = hash ? liveAnswerAt.get(hash) : undefined;
    return at != null && now - at < CONTINUES_MS;
};

/** A reply's Markdown, drawn as it streams in. `live` is whether text arriving now is arriving in front of the reader:
 *  false once the reply has settled, so a redraw (unfolding it, say) shows it at once. A surface opts in with
 *  `--word-fade-ms`; one that sets none draws each update in one frame, as before. */
export function StreamingMd({ content, live }: { content: string; live: boolean }) {
    const ref = useRef<HTMLDivElement>(null);
    // state: ui (which word of THIS bubble appeared when; dies with the bubble, and a redraw then shows it at once)
    const starts = useRef<number[]>([]);
    const { md, restore } = setAsideTokens(live ? closeStreaming(content) : content);
    const html = restore(markdown(md, { math: true }));
    useLayoutEffect(() => {
        const el = ref.current;
        if (!el) return;
        el.innerHTML = html;
        const ms = cssDurationMs(el, "--word-fade-ms");
        if (ms) fadeWords(el, starts.current, performance.now(), ms, live);
    }, [html, live]);
    // `md-live`: a ```mermaid fence that closes in here closes in front of the reader, so it is drawn with its states
    // (mermaid-client.ts); anywhere else it simply appears drawn.
    return <div class={live ? "md md-live" : "md"} ref={ref} />;
}
