// fold-rail.tsx — the line down the left of something open in the reading view, which closes it when clicked.

import { cursorTipOn } from "../ui-kit";

/**
 * The FOLD RAIL: the hairline that says where an open thing (a group of calls, one call, an output embedded in an
 * answer) ends, and the control that closes it. A real button with a hit strip wider than the 2px line it draws,
 * because the line is what a reader points at when they want the thing gone.
 *
 * Pointer-only, deliberately: `aria-hidden` + `tabindex -1`, because a group and a step already have a header that
 * does the same from the keyboard, and a second tab stop for one action is noise. An embed has no header: it folds
 * by pointer only, and its folded row is a button that opens it again. The stylesheet also takes its clicks away on
 * a coarse pointer, where an 11px strip beside the content is a mis-tap rather than an affordance.
 *
 * The click stops here: a rail inside an embed sits inside a link-like block whose own click jumps to the source
 * step, and closing it must not also send the reader somewhere.
 */
export function FoldRail({ onFold, tip, cls }: { onFold: () => void; tip: string; /** a modifier: `fold-rail-cite` for an embed */ cls?: string }) {
    return <button class={`fold-rail${cls ? ` ${cls}` : ""}`} aria-hidden="true" tabIndex={-1} type="button"
        onClick={(e) => { e.stopPropagation(); onFold(); }} {...cursorTipOn(tip)} />;
}
