// THE CHAT PAGE'S EXTENSION ENTRY: `chat.html` as a tab of this browser, over the local runtime
// (docs/spec/CHAT_PAGE.md §Two places). The twin of `src/chat/web.tsx`, which opens the same app on a fake host.
//
// It lives OUT here rather than in `src/chat/` because it is the one file of the chat page that knows about
// `chrome`: everything under `src/chat/` must build for a phone, and `scripts/build-web.mjs` fails on a `chrome.*`
// reference to keep it that way. The same reason `sidebar/services-ext.ts` sits beside the seam it fills.
import { render } from "preact";
import { useEffect } from "preact/hooks";
import { ChatApp } from "./chat/chat-app";
import type { ChatExtras } from "./chat/extras";
import { ChatStore } from "./chat/chat-store";
import { hostServices } from "./chat/host-services";
import { LocalHost } from "./chat/local-host";
import { webPlatform, type ClientPlatform } from "./chat/platform";
import { SESSIONS_PORT } from "./session-server";
import { installServices } from "./sidebar/services";
import { applyCodePrefs, initThemeStyle } from "./sidebar/prefs";
import { installTooltipLayer } from "./sidebar/tooltip-layer";
import { installViewPrefs } from "./chat/view-mode";
import { VRAM_POLL_MS } from "./sidebar/panel-state";
import { BACKEND_HEALTH_MS, VramPanel, connectResourceStream, fetchModels, pollBackendHealth, pollPs } from "./sidebar/vram";
import { BenchDrawer } from "./sidebar/vram-bench";
import type { RuntimeId } from "./session-host";

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

/**
 * The resource panel, with the polling and the live feed it needs, started when it is mounted and stopped when it
 * is not. The sidebar app keeps these going for the whole of its life because it is mounted in every tab and has a
 * status dot to feed; this page has neither, so the box is only asked about while someone is looking at it.
 */
function BoxPanel() {
    useEffect(() => {
        fetchModels();
        pollBackendHealth();
        pollPs();
        connectResourceStream();
        const health = setInterval(pollBackendHealth, BACKEND_HEALTH_MS);
        const ps = setInterval(pollPs, VRAM_POLL_MS);
        return () => { clearInterval(health); clearInterval(ps); };
    }, []);
    return <VramPanel />;
}

/**
 * The runtimes THIS browser is, as `LocalHost` reports them — the only ones whose box and sandbox the extension's
 * own views can honestly describe. A hub runtime reaches the same page through the same store, and asking it for
 * this browser's VRAM would draw someone else's machine under its name.
 */
const localRuntimes = new Set<RuntimeId>();

/** What this device can draw beyond the chat core. Every answer is per runtime, and null for one that is not ours. */
const extras: ChatExtras = {
    resourcePanel: (id) => (localRuntimes.has(id) ? <BoxPanel /> : null),
    bench: (id) => (localRuntimes.has(id) ? <BenchDrawer /> : null),
};

// One port for the page's life, reconnected by `LocalHost` itself: an MV3 worker is evicted when idle, which drops
// every port, and the host re-requests the index and resumes each subscription from its last delivered position.
const host = new LocalHost(() => chrome.runtime.connect({ name: SESSIONS_PORT }));
const store = new ChatStore(host);
host.runtimes((list) => { localRuntimes.clear(); for (const r of list) localRuntimes.add(r.id); });

installServices(hostServices(store, extensionPlatform));
initThemeStyle();
applyCodePrefs();
// This page reads its OWN view preference rather than the panel's `focusMode`: the two surfaces share an origin,
// and a reading choice made in a tab must not quietly reconfigure the DevTools panel beside a page.
installViewPrefs(extensionPlatform.prefs);
try { installTooltipLayer(document); } catch { /* no DOM */ }
store.start();
render(<ChatApp store={store} extras={extras} />, document.getElementById("root") || document.body);
