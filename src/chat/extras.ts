// extras.ts — WHAT A DEVICE CAN DRAW THAT THE CHAT CORE CANNOT: the views that only exist where the extension is,
// handed to `ChatApp` by the entry that has them (`src/chat-ext.tsx`).
//
// The resource panel and the Python bench are the extension's own UI: they talk to this browser's worker over
// `chrome.*`, which `src/chat/` may never do — the same bundle is the phone app, and `scripts/build-web.mjs` fails
// on the reference. So the core does not import them. It asks for them, and a place that has none simply offers
// none, which is how a phone talking to a headless box ends up with a sensible page and no `if (local)` anywhere.
//
// Each is asked PER RUNTIME, and that is the whole point of the argument. A resource panel drawn from this
// browser's worker describes THIS browser's box; rendering it beside a session running on someone's lab box would
// be a lie told confidently. The entry answers for the runtimes it can actually speak for, and null for the rest.
import type { ComponentChildren } from "preact";
import type { RuntimeId } from "../session-host";

/** The device's own views, if it has any. Every member is optional: absent means this place cannot draw it. */
export interface ChatExtras {
    /** The resource panel (capacity, the residents, the event lane) for one runtime's box. */
    resourcePanel?(runtime: RuntimeId): ComponentChildren | null;
    /** A Python bench running against one runtime's sandbox. */
    bench?(runtime: RuntimeId): ComponentChildren | null;
    /** The runtime's own settings, editable from here — offered where the runtime reports `localSettings`. */
    settings?(runtime: RuntimeId): ComponentChildren | null;
    /** The runtime's housekeeping log (what it decided on its own: evictions, sweeps, worker restarts), read-only. */
    housekeeping?(runtime: RuntimeId): ComponentChildren | null;
    /**
     * The one-click fix for an attention code (attention.ts) on a runtime this device IS: a permission (`tab-groups`,
     * `site-access`), a setting (`archive-off`), the folder picker (`archive-folder-none`, `archive-folder-lapsed`). A
     * function, not a view: it must be CALLED inside the click that asked, the only place a browser shows a permission
     * prompt or a folder picker. Resolves whether it worked. Null where this device cannot fix it.
     */
    fix?(runtime: RuntimeId, code: string): (() => Promise<boolean>) | null;
    /**
     * Has this device fixed this code on this runtime before, so its coming back is a REPEAT? Only the device that
     * fixed it can know: the browser says `granted` for "allow this time" and "allow on every visit" alike, and a folder
     * that lapses again was allowed only once. Worded as a repeat where the code has words for one (attention.ts).
     */
    fixedBefore?(runtime: RuntimeId, code: string): boolean;
}
