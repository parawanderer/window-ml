// injected-isolated.ts — the page-side tools of a run the person starts on a page that may not see window.ml, in the
// content scripts' world (docs/spec/SITE_PRESENCE.md, step 3).
//
// The same bundle as injected.js, put in by the worker (sw-presence.ts `injectRunTools`) with world ISOLATED, so the page's
// world gets nothing: no window.ml, no event, no port handed over the page's window. Its channel to content.js is in-process
// (page-channel.ts), and it reads closed shadow roots with `chrome.dom.openOrClosedShadowRoot` instead of the main world's
// load-time capture, so a root the page attached before the run started is read too.

import "./page-world-isolated";
import "./injected";
