// ask.ts — the stub `window.ml` on a page that may ask for access but not use window.ml yet: `requestAccess` and nothing else.
//
// docs/spec/SITE_PRESENCE.md "The rule": a VISIBLE origin that is not allowed (the person marked it, or "Let sites ask for
// access" is on) knows window.ml is here and may ask, and that is all. sw-presence.ts registers this file in the main world
// at document_start for those origins only, never beside injected.js. The content script relays nothing from such a page
// but the request (page-gate.ts `gateAsks`), and the worker judges it on the sender's origin. When the person allows the
// site, the worker puts injected.js into the open page, which replaces this object and fires `ml:ready`.

import { requestAccess } from "./ml/ml-access";
import { onIsolated } from "./page-channel";

(function() {
    // Open the channel now, before any page script runs, so the port is handed over where no page listener can see it.
    onIsolated(() => { /* the answers are heard by each call's own listener (bridge.ts) */ });
    const w = window as unknown as { ml?: unknown };
    if (w.ml) return;   // the full API got here first
    w.ml = { requestAccess };
})();
