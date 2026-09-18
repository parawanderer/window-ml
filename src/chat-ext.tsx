// THE CHAT PAGE'S EXTENSION ENTRY: `chat.html` as a tab of this browser, over the local runtime
// (docs/spec/CHAT_PAGE.md §Two places). The twin of `src/chat/web.tsx`, which opens the same app on a fake host.
//
// It lives OUT here rather than in `src/chat/` because it is the one file of the chat page that knows about
// `chrome`: everything under `src/chat/` must build for a phone, and `scripts/build-web.mjs` fails on a `chrome.*`
// reference to keep it that way. The same reason `sidebar/services-ext.ts` sits beside the seam it fills.
import { render } from "preact";
import { ChatApp } from "./chat/chat-app";
import { ChatStore } from "./chat/chat-store";
import { hostServices } from "./chat/host-services";
import { LocalHost } from "./chat/local-host";
import { webPlatform, type ClientPlatform } from "./chat/platform";
import { SESSIONS_PORT } from "./session-server";
import { installServices } from "./sidebar/services";
import { applyCodePrefs, applyFocus, initThemeStyle } from "./sidebar/prefs";
import { installTooltipLayer } from "./sidebar/tooltip-layer";

/**
 * The extension's device adapter.
 *
 * It is the web adapter with a different `kind`, and saying so is more honest than inventing differences: an
 * extension page is a page, with the same `localStorage` (on the extension's own origin, so preferences are shared
 * with any other extension page rather than with a site), the same anchor download and the same clipboard. `kind`
 * still matters, because a surface may offer something only where it can be done — pairing by camera on a phone,
 * for one — and that question is asked of the platform, never guessed from the runtime.
 */
const extensionPlatform: ClientPlatform = { ...webPlatform, kind: "extension" };

// One port for the page's life, reconnected by `LocalHost` itself: an MV3 worker is evicted when idle, which drops
// every port, and the host re-requests the index and resumes each subscription from its last delivered position.
const host = new LocalHost(() => chrome.runtime.connect({ name: SESSIONS_PORT }));
const store = new ChatStore(host);

installServices(hostServices(store, extensionPlatform));
initThemeStyle();
applyCodePrefs();
applyFocus();
try { installTooltipLayer(document); } catch { /* no DOM */ }
store.start();
render(<ChatApp store={store} />, document.getElementById("root") || document.body);
