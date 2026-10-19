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

/** A reply's Markdown, drawn as it streams in. `live` is whether text arriving now is arriving in front of the reader:
 *  false once the reply has settled, so a redraw (unfolding it, say) shows it at once. A surface opts in with
 *  `--word-fade-ms`; one that sets none draws each update in one frame, as before. */
export function StreamingMd({ content, live }: { content: string; live: boolean }) {
    const ref = useRef<HTMLDivElement>(null);
    // state: ui (which word of THIS bubble appeared when; dies with the bubble, and a redraw then shows it at once)
    const starts = useRef<number[]>([]);
    const html = markdown(live ? closeStreaming(content) : content, { math: true });
    useLayoutEffect(() => {
        const el = ref.current;
        if (!el) return;
        el.innerHTML = html;
        const ms = cssDurationMs(el, "--word-fade-ms");
        if (ms) fadeWords(el, starts.current, performance.now(), ms, live);
    }, [html, live]);
    return <div class="md" ref={ref} />;
}
