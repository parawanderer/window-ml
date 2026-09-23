// cut-tip.tsx — THE WHOLE OF A NAME THAT DID NOT FIT. The start page's pickers draw their text on one line and cut it
// with an ellipsis, so a model id and a tab title both arrive as "Verify TLS certificates, i…" and the part that tells
// two of them apart is the part that is gone. This is the tip that gives it back.
//
// It waits for a REST rather than appearing on contact: these are controls the pointer crosses on its way to the one
// it wants, and a tip that fires at every pass is noise. And it appears only where the text is ACTUALLY cut off,
// measured, so a name that fits is never explained to you.
//
// Shared by the model picker and the tab picker (`model-picker.tsx`, `tab-picker.tsx`), which draw the same pill and
// the same rows.

import { cursorTipOn } from "../sidebar/ui-kit";

/** How long the pointer rests on a cut-off name before the whole of it shows. */
const CUT_TIP_MS = 550;

/**
 * Is the text cut off? Measured on the pill's or row's own text element when this is attached to the button around it,
 * and on the element itself when it is attached to the text directly (a row whose other parts have tips of their own).
 */
const textCut = (el: Element): boolean => {
    const t = el.querySelector(".tp-pill-text, .tp-title, .tp-group-title") ?? el;
    return t.scrollWidth > t.clientWidth + 1;
};

/**
 * The full text, after a rest, only where it is cut off. A JSX node rather than a string, so it is never read as
 * markdown. `mono` is for an IDENTIFIER — a model id, where `qwen3.8-flash-next:vision` is a token to be compared
 * character by character; a tab's title is prose and is set in the page's own face.
 */
export const cutTip = (text: string, mono = false) =>
    cursorTipOn(mono ? <code class="tp-name-tip">{text}</code> : <span>{text}</span>, { delayMs: CUT_TIP_MS, onlyIf: textCut });
