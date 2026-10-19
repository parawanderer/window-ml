// pin-glide.ts — how the transcript FOLLOWS ITS BOTTOM while content arrives: a short glide instead of a jump.
//
// The pane keeps the newest text in view by scrolling to the end whenever its content grows (chat-app.tsx). Done in
// one frame, every new line of a streaming reply moves the whole transcript up by a line height at once, which reads
// as the page twitching under words that are otherwise fading in gently (streaming-md.tsx). So a SMALL growth is
// followed with a short ease-out instead, retargeted from wherever it is when the content grows again mid-glide.
//
// A LARGE one still jumps: a session drawn for the first time, a reply that landed whole, anything over half the
// view. Gliding there would scroll the reader through text they did not ask to see, slowly. And reduced motion jumps.

/** How long one glide takes. Short enough that a line arriving every few hundred ms is never chased for long. */
export const GLIDE_MS = 140;

/** Ease-out cubic: fast at first, settling at the end, so the new line is in view almost at once. */
export const easeOut = (x: number): number => 1 - (1 - Math.min(1, Math.max(0, x))) ** 3;

/** Whether a growth of `delta` px in a view `clientHeight` tall is followed by gliding (rather than jumping). */
export const glides = (delta: number, clientHeight: number): boolean => delta > 0 && delta <= clientHeight / 2;

/** A follower for one scroller: `follow()` brings it to its bottom, gliding when the distance is small; `stop()`
 *  abandons a glide in flight (the reader took over). */
export function pinGlide(el: HTMLElement, opts: { reduced?: () => boolean; raf?: (f: FrameRequestCallback) => number; caf?: (id: number) => void; now?: () => number } = {}) {
    const raf = opts.raf ?? ((f: FrameRequestCallback) => requestAnimationFrame(f));
    const caf = opts.caf ?? ((id: number) => cancelAnimationFrame(id));
    const now = opts.now ?? (() => performance.now());
    const reduced = opts.reduced ?? (() => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches);
    // state: plumbing (the glide in flight for this scroller; dies with the pane)
    let frame = 0, from = 0, start = 0, wrote = 0;
    const end = (): number => el.scrollHeight - el.clientHeight;
    const step = (): void => {
        // SOMETHING ELSE SCROLLED since the last frame (a citation jumping up the transcript, a reveal): the glide
        // gives way rather than dragging the view back down, which it would otherwise do on every remaining frame.
        if (Math.abs(el.scrollTop - wrote) > 1) { frame = 0; return; }
        const x = (now() - start) / GLIDE_MS;
        el.scrollTop = from + (end() - from) * easeOut(x);
        wrote = el.scrollTop;
        frame = x < 1 ? raf(step) : 0;
    };
    return {
        follow(): void {
            const delta = end() - el.scrollTop;
            if (delta <= 0) return;
            if (reduced() || !glides(delta, el.clientHeight)) { if (frame) caf(frame); frame = 0; el.scrollTop = el.scrollHeight; return; }
            // Retarget from where it is now, on a fresh clock: the target is always read live, so content that grows
            // again mid-glide is followed without a second loop.
            from = wrote = el.scrollTop;
            start = now();
            if (!frame) frame = raf(step);
        },
        stop(): void { if (frame) caf(frame); frame = 0; },
    };
}
