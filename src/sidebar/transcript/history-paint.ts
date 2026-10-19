// history-paint.ts — telling a transcript's FIRST paint (history) from what lands in it afterwards.
//
// `justArrived` (just-arrived.ts) separates the two by the clock, which is right for a session opened long after it ran
// and wrong for one opened seconds after: a reload during a run draws its last step "a moment ago" and would animate
// it as if it had landed in view. A page that knows when it drew the history says so here, and everything mounted in
// that paint is history whatever its stamp. The default is false, so the DevTools panel is unchanged.
import { createContext } from "preact";
import { useContext, useState } from "preact/hooks";
import { justArrived } from "./just-arrived";

/** True while a transcript is drawing its history for the first time: nothing mounted under it has just arrived. */
export const HistoryPaint = createContext(false);

/** Is this component being mounted as part of a transcript's first paint? Read once, at mount. */
export const useHistoryPaint = (): boolean => useContext(HistoryPaint);

/** Did this land IN FRONT OF THE READER: not part of the first paint, and stamped a moment ago? Read once, at mount, so
 *  it cannot decay in the middle of its own animation. */
export const useJustArrived = (ts: number | undefined | null): boolean => {
    const history = useHistoryPaint();
    const [fresh] = useState(() => !history && justArrived(ts));
    return fresh;
};
