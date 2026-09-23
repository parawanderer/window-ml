// user-text.tsx — WHAT YOU SENT: the images as tiles under your message (`SentImages`), and the text folded when it is long: a pasted log, a stack trace, a whole file dropped into a prompt
// would otherwise push the reply a few screens down and bury the conversation under it. The first lines stay, fading
// out, and a button says how to see the rest. Shared by every surface that draws a user message (the chat page and the
// phone app's transcript through `MessageTurn` and `UserBubble`, and the sidebar), so a prompt folds the same everywhere.
//
// It folds by the DRAWN height, measured, not by a character count: forty short lines and one long paragraph are both
// long, and whether a line wraps depends on the width it is drawn at, which a count cannot know.

import { useLayoutEffect, useRef, useState } from "preact/hooks";
import { IconChevron, IconCheck, IconCompose, IconCopy } from "./icons";
import { ClickableImg, cursorTipOn, openCtxMenu, useCopy } from "./ui-kit";

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

/** How long a finger rests on a message before its menu opens. Long enough not to fire while scrolling past it. */
const HOLD_MS = 450;
/** Why Edit is offered but does nothing yet. Shown as its tooltip, and as the reason the menu item is dimmed. */
const EDIT_SOON = "Editing a message you have sent is not built yet.";

/**
 * WHAT YOU CAN DO WITH A MESSAGE YOU SENT: copy it, and — later — edit it and ask again from there.
 *
 * Two surfaces, one set of actions. With a pointer they are buttons in the bubble's corner, shown on hover, because
 * a message that always carries two controls is a message with furniture on it. With a finger there is no hover, so
 * the same two arrive as a menu on a long press, which is where a phone puts them.
 *
 * COPY WORKS. Edit is the placeholder: it is drawn, dimmed, and says why, because a control that silently does
 * nothing teaches people the app is broken, and a missing one teaches them the feature will never exist.
 */
export function UserActions({ text }: { text: string }) {
    const { copied, copy } = useCopy();
    const items = [
        { label: copied ? "Copied" : "Copy", icon: <IconCopy />, run: () => copy(text) },
        { label: "Edit", icon: <IconCompose />, disabled: true, run: () => {} },
    ];
    // A long press, by hand: `contextmenu` does not fire consistently over text on a phone, where the platform wants
    // to start a selection instead. The timer is dropped the moment the finger moves, so scrolling past a message
    // never opens anything.
    const held = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
    const stop = () => clearTimeout(held.current);
    const start = (e: PointerEvent) => {
        if (e.pointerType === "mouse") return;
        const { clientX: x, clientY: y } = e;
        held.current = setTimeout(() => openCtxMenu({ clientX: x, clientY: y, preventDefault: () => {} } as MouseEvent, items), HOLD_MS);
    };
    return (
        <span class="umsg-acts" onPointerDown={start} onPointerMove={stop} onPointerUp={stop} onPointerCancel={stop}
            onContextMenu={(e: MouseEvent) => { e.preventDefault(); openCtxMenu(e, items); }}>
            <button type="button" class="icon-btn" aria-label="Copy this message" {...cursorTipOn("Copy")} onClick={() => copy(text)}>
                {copied ? <IconCheck /> : <IconCopy />}
            </button>
            <button type="button" class="icon-btn off" aria-label="Edit this message" aria-disabled="true" {...cursorTipOn(EDIT_SOON)}>
                <IconCompose />
            </button>
        </span>
    );
}
