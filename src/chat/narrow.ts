// narrow.ts — whether the chat page is on a phone-width screen, as a hook every part of the page reads the same way.
//
// Lifted out of chat-app.tsx so a view drawn INSIDE the page (the extension's Settings, chat-ext.tsx) can pick its
// layout from the same breakpoint the page uses for its own panes, rather than a second number that drifts.

import { useState, useEffect } from "preact/hooks";

/** Below this width the page shows one pane at a time. */
export const NARROW_PX = 760;

/** Is the viewport narrow? Follows resizes and rotation. */
export function useNarrow(): boolean {
    const query = `(max-width: ${NARROW_PX}px)`;
    const [narrow, setNarrow] = useState(() => typeof matchMedia === "function" && matchMedia(query).matches);
    useEffect(() => {
        if (typeof matchMedia !== "function") return;
        const mq = matchMedia(query);
        const on = () => setNarrow(mq.matches);
        mq.addEventListener("change", on);
        return () => mq.removeEventListener("change", on);
    }, []);
    return narrow;
}
