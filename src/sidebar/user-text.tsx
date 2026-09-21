// user-text.tsx — WHAT YOU SENT: the images as tiles under your message (`SentImages`), and the text folded when it is long: a pasted log, a stack trace, a whole file dropped into a prompt
// would otherwise push the reply a few screens down and bury the conversation under it. The first lines stay, fading
// out, and a button says how to see the rest. Shared by every surface that draws a user message (the chat page and the
// phone app's transcript through `MessageTurn` and `UserBubble`, and the sidebar), so a prompt folds the same everywhere.
//
// It folds by the DRAWN height, measured, not by a character count: forty short lines and one long paragraph are both
// long, and whether a line wraps depends on the width it is drawn at, which a count cannot know.

import { useLayoutEffect, useRef, useState } from "preact/hooks";
import { IconChevron } from "./icons";
import { ClickableImg } from "./ui-kit";

/** How tall a message may be before it folds, in lines of its own text. Past this it shows `FOLD_LINES` and fades. */
const FOLD_LINES = 8;
/** Folding a message only a line or two over the limit hides almost nothing and costs a click: it has to be clearly longer. */
const FOLD_SLACK_LINES = 3;

/** A user message's text, folded past `FOLD_LINES` lines with a button to open it; short messages are drawn as they are. */
export function UserText({ text }: { text: string }) {
    const el = useRef<HTMLDivElement>(null);
    const [long, setLong] = useState(false);
    const [open, setOpen] = useState(false);
    useLayoutEffect(() => {
        const node = el.current;
        if (!node) return;
        const measure = () => {
            const line = parseFloat(getComputedStyle(node).lineHeight) || 20;
            setLong(node.scrollHeight > line * (FOLD_LINES + FOLD_SLACK_LINES));
        };
        measure();
        // The width decides the wrapping: a phone rotated, a panel dragged wider.
        const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
        ro?.observe(node);
        return () => ro?.disconnect();
    }, [text]);
    const folded = long && !open;
    return (
        <div class={`utext-wrap${long ? " long" : ""}`}>
            <div ref={el} class={`utext${folded ? " folded" : ""}`} style={folded ? `--fold-lines:${FOLD_LINES}` : undefined}>{text}</div>
            {long ? (
                // Gemini's control: a round chevron at the text's bottom right, over the fade it explains. Named for a
                // screen reader and a keyboard, since the glyph alone says nothing to either.
                <button type="button" class={`utext-more${open ? " open" : ""}`} aria-expanded={open}
                    aria-label={open ? "Show less of this message" : "Show all of this message"} onClick={() => setOpen((v) => !v)}>
                    <IconChevron />
                </button>
            ) : null}
        </div>
    );
}

/**
 * The images sent with a message, as square TILES under its bubble rather than inside it (the way a messaging app
 * shows photos you sent): each cropped to fill its tile, opened full size on a click. Outside the bubble, the bubble
 * holds only the text, so a long one folds by its own height and nothing is drawn over the pictures.
 */
export function SentImages({ images }: { images?: readonly string[] | null }) {
    if (!images?.length) return null;
    return <div class="sent-tiles">{images.map((src, i) => <ClickableImg key={i} src={src} alt={`Image ${i + 1} you sent`} />)}</div>;
}
