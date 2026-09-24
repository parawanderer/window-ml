// text-size.ts — the code sizes a person is offered, as one list both surfaces read.
//
// Its own module, with no imports, because the phone app offers the same choice natively and cannot import the
// page's `view-mode.tsx` (which pulls Preact's signals into a React Native bundle). Two lists would drift, and a
// size the app offers that the page does not honour is a control that does nothing.

/**
 * The size code is set at on this page, in px: transcript code blocks, the Python bench's editor and what it prints.
 *
 * A setting rather than a constant because it is the one size here that people disagree about. The page reads prose
 * at 15px, and code inherited that — a monospace face nearly the size of the prose stops reading as an inset, and the
 * bench, built for the DevTools panel's 12px, came out a size and a half too big. The default is the panel's code
 * size, near enough; someone reading at arm's length can raise it without the prose moving.
 */
export const CODE_SIZES = [{ px: 11, label: "Small" }, { px: 12.5, label: "Default" }, { px: 14, label: "Large" }, { px: 15.5, label: "Larger" }] as const;

/** The default code size, in px. */
export const CODE_DEFAULT = 12.5;
