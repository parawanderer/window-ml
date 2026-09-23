// dialog.tsx — the page's ONE modal shell: a dimmed backdrop, a centred card, Escape and a click outside to leave.
//
// It exists because the third dialog was about to hand-roll the same three things a fourth time, and each copy is a
// place one of them can be forgotten — the resume form, before this, was not a dialog at all but a screen that
// REPLACED the transcript, so leaving it meant finding the ×.
//
// What it deliberately does NOT own is the buttons. A confirmation ends in Cancel/Delete, a rename in a submit, and
// the resume form's footer carries a sentence beside its button; a shell that insisted on a shape would be argued
// with by every one of them. It owns the frame and the ways out.

import type { ComponentChildren } from "preact";
import { useEffect, useRef } from "preact/hooks";

/**
 * A modal card over the page.
 *
 * `onClose` is the ONE way out, called by Escape, by a click on the backdrop and by whatever the caller wires to it —
 * so a dialog can never be dismissed by a route this does not know about. The focus moves inside on open (to
 * `initialFocus` if given, else the card), because a modal whose focus is still on the page behind it reads to a
 * keyboard as a page that did not change.
 *
 * @param labelledBy id of the heading inside; `alert` makes it an `alertdialog` (a confirmation, not a form).
 */
export function Dialog({ onClose, labelledBy, describedBy, alert, wide, initialFocus, children, onSubmit }: {
    onClose: () => void;
    labelledBy: string;
    describedBy?: string;
    alert?: boolean;
    wide?: boolean;
    initialFocus?: { current: HTMLElement | null };
    children: ComponentChildren;
    onSubmit?: () => void;
}) {
    const card = useRef<HTMLDivElement | HTMLFormElement>(null);
    useEffect(() => {
        (initialFocus?.current ?? card.current)?.focus();
        const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
        document.addEventListener("keydown", onKey);
        return () => document.removeEventListener("keydown", onKey);
    }, []);
    const inner = {
        class: `chat-dialog${wide ? " wide" : ""}`,
        role: (alert ? "alertdialog" : "dialog") as "alertdialog" | "dialog",
        "aria-modal": true,
        "aria-labelledby": labelledBy,
        "aria-describedby": describedBy,
        tabIndex: -1,
    };
    return (
        <div class="chat-dialog-back" onPointerDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
            {onSubmit
                ? <form {...inner} ref={card as { current: HTMLFormElement | null }} onSubmit={(e) => { e.preventDefault(); onSubmit(); }}>{children}</form>
                : <div {...inner} ref={card as { current: HTMLDivElement | null }}>{children}</div>}
        </div>
    );
}
