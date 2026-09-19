// THE CHAT PAGE'S EXTENSION ENTRY: `chat.html` as a tab of this browser, over the local runtime
// (docs/spec/CHAT_PAGE.md §Two places). The twin of `src/chat/web.tsx`, which opens the same app on a fake host.
//
// It lives OUT here rather than in `src/chat/` because it is the one file of the chat page that knows about
// `chrome`: everything under `src/chat/` must build for a phone, and `scripts/build-web.mjs` fails on a `chrome.*`
// reference to keep it that way. The same reason `sidebar/services-ext.ts` sits beside the seam it fills.
import { HousekeepingView } from "./sidebar/housekeeping-log";
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
import { PythonBench } from "./sidebar/vram-bench";
import type { RuntimeId, RuntimeInfo } from "./session-host";
import { Settings } from "./sidebar/settings";
import { config } from "./sidebar/store";
import { DEFAULT_CONFIG, type MlConfig } from "./contract";

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
/** The latest description of each of them, for checks that read what the runtime reports about itself. */
const runtimeInfo = new Map<RuntimeId, RuntimeInfo>();

/**
 * The extension's own settings view, in the page's main pane. It reads and writes `chrome.storage.sync` itself
 * (settings.tsx), which is what the popup and the DevTools panel read too, so an edit here is the same edit there.
 * The page does not otherwise load the config, so the view loads it when it opens and follows changes made
 * elsewhere while it is open.
 */
function SettingsPane() {
    useEffect(() => {
        chrome.storage.sync.get(DEFAULT_CONFIG as never, (cfg: unknown) => { config.value = cfg as MlConfig; });
        const onChange = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
            if (area !== "sync") return;
            const patch: Record<string, unknown> = {};
            for (const k in changes) patch[k] = changes[k].newValue;
            config.value = { ...config.value, ...patch } as MlConfig;
        };
        chrome.storage.onChanged.addListener(onChange);
        return () => chrome.storage.onChanged.removeListener(onChange);
    }, []);
    return <Settings />;
}

/** The permissions an attention code asks for, where a click here can grant it. */
const GRANTS: Record<string, chrome.permissions.Permissions> = {
    "tab-groups": { permissions: ["tabGroups"] as chrome.runtime.ManifestPermission[] },
    "site-access": { origins: ["<all_urls>"] },
};

/**
 * This browser's attention codes that its runtime does not report itself (src/chat/attention.ts). The runtime reports
 * the rest on the contract (`capabilities.attention`, sw-attention.ts): the model, the backend, site access, the
 * permissions, the archive folder. What is left is the build: `pythonBench` is measured, so false here means the wheels
 * are missing.
 */
async function localAttention(id: string): Promise<string[]> {
    return runtimeInfo.get(id)?.capabilities.pythonBench === false ? ["python-packages-missing"] : [];
}

/** What this device can draw beyond the chat core. Every answer is per runtime, and null for one that is not ours. */
const extras: ChatExtras = {
    resourcePanel: (id) => (localRuntimes.has(id) ? <BoxPanel /> : null),
    // The bench itself, not its drawer: the page's dock is the drawer here (edge, size, zoom, close).
    bench: (id) => (localRuntimes.has(id) ? <PythonBench /> : null),
    settings: (id) => (localRuntimes.has(id) ? <SettingsPane /> : null),
    housekeeping: (id) => (localRuntimes.has(id) ? <HousekeepingView /> : null),
    attention: (id) => (localRuntimes.has(id) ? localAttention(id) : null),
    // Called straight from the click, so the browser still counts it as the user's gesture and shows its prompt.
    grant: (id, code) => {
        const want = GRANTS[code];
        return localRuntimes.has(id) && want && chrome.permissions ? () => chrome.permissions.request(want).catch(() => false) : null;
    },
};

// One port for the page's life, reconnected by `LocalHost` itself: an MV3 worker is evicted when idle, which drops
// every port, and the host re-requests the index and resumes each subscription from its last delivered position.
const host = new LocalHost(() => chrome.runtime.connect({ name: SESSIONS_PORT }));
const store = new ChatStore(host);
host.runtimes((list) => {
    localRuntimes.clear(); runtimeInfo.clear();
    for (const r of list) { localRuntimes.add(r.id); runtimeInfo.set(r.id, r); }
});

installServices(hostServices(store, extensionPlatform));
initThemeStyle();
applyCodePrefs();
// This page reads its OWN view preference rather than the panel's `focusMode`: the two surfaces share an origin,
// and a reading choice made in a tab must not quietly reconfigure the DevTools panel beside a page.
installViewPrefs(extensionPlatform.prefs);
try { installTooltipLayer(document); } catch { /* no DOM */ }
store.start();
render(<ChatApp store={store} platform={extensionPlatform} extras={extras} />, document.getElementById("root") || document.body);
