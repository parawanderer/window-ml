// raw-view.ts — the rendered⇄raw choice of one block, which the calm chat resets each time it is switched on.

import { useEffect, useRef, useState } from "preact/hooks";
import { calmEntered } from "./store";

/**
 * `useState` for "is this block showing its RAW view", with one addition: switching the calm chat ON puts it back on the
 * rendered view. The calm view has no switch for it, so a block left on raw in the other view (where the switch exists)
 * would stay raw with nothing to turn it back. A block with no rendered view to go back to is unaffected: it is raw
 * either way.
 */
export function useRawView(initial = false) {
    const [raw, setRaw] = useState(initial);
    const epoch = calmEntered.value;
    const first = useRef(true);
    // state: ui — only the first run's skip
    useEffect(() => { if (first.current) { first.current = false; return; } setRaw(false); }, [epoch]);
    return [raw, setRaw] as const;
}
