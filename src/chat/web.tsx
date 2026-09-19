// THE CHAT PAGE'S WEB ENTRY: a plain page with no extension, built to `dist-web/` (docs/spec/CHAT_PAGE.md §Two places).
// It opens on the fake host's demo world, because the host a phone will really use, `HubHost`, is slice 6; until then
// this build is for developing the core and testing it at phone width. The build fails if `chrome` reaches this bundle
// (scripts/build-web.mjs), which is what keeps the core portable.
import { render } from "preact";
import { installServices } from "../sidebar/services";
import { installTooltipLayer } from "../sidebar/tooltip-layer";
import { applyCodePrefs, initThemeStyle } from "../sidebar/prefs";
import { ChatStore } from "./chat-store";
import { demoHost } from "./demo-world";
import { hostServices } from "./host-services";
import { webPlatform } from "./platform";
import { installViewPrefs } from "./view-mode";
import { installPageTheme } from "./page-theme";
import { ChatApp } from "./chat-app";
import { fakePairing } from "../pairing/fake-pairing";

// `__chatFakeLatencyMs`, set by a spec's init script before load, slows every answer: how a spec sees what the page
// draws while it waits (a first list, a placeholder), which an instant demo host never shows.
const host = demoHost(Date.now(), { latencyMs: Number((globalThis as { __chatFakeLatencyMs?: unknown }).__chatFakeLatencyMs) || 0 });
// Scripting handle for the specs and for poking at the page by hand: emit events, restart a runtime, change grants.
(globalThis as { __chatFake?: unknown }).__chatFake = host;
const store = new ChatStore(host);
installServices(hostServices(store, webPlatform));
initThemeStyle();
applyCodePrefs();
installViewPrefs(webPlatform.prefs);
installPageTheme();
try { installTooltipLayer(document); } catch { /* no DOM */ }
store.start();
// Pairing, faked the same way: this phone is in an account and may pair others, but pass on only what it holds, and a
// tablet is waiting under a code. `__pairFake` answers or fails a join, and swaps the membership, for the specs.
const pairing = fakePairing({
    joinsAs: "client", defaultLabel: "This phone",
    membership: { label: "Shane's phone", role: "client", hubUrl: "wss://hub.example", fingerprint: "5ab0e19c44d2", root: false, mayPair: true, principal: "5ab0e19c".repeat(8) },
    grantable: ["view", "drive", "screen"],
    devices: [
        { principal: "5ab0e19c".repeat(8), label: "Shane's phone", role: "client", kind: "phone", scopes: ["view", "drive", "screen"], mayPair: true, notAfterMs: Date.now() + 80 * 86_400_000, lastSeenMs: Date.now() - 5_000 },
        { principal: "c0ffee12".repeat(8), label: "Work laptop", role: "runtime", kind: "browser", scopes: [], mayPair: true, mayRevoke: true, notAfterMs: Date.now() + 85 * 86_400_000, lastSeenMs: Date.now() - 120_000 },
        { principal: "a41c9e07".repeat(8), label: "Kitchen tablet", role: "client", kind: "phone", scopes: ["view"], notAfterMs: Date.now() + 30 * 86_400_000, lastSeenMs: Date.now() - 3 * 86_400_000 },
        { principal: "0dd0dd00".repeat(8), label: "Old phone", role: "client", kind: "phone", scopes: ["view", "drive"], notAfterMs: Date.now() - 86_400_000, lastSeenMs: Date.now() - 95 * 86_400_000 },
    ],
});
pairing.addOffer("7K3M Q9XD", { label: "Kitchen tablet", role: "client", fingerprint: "a41c9e07d3b2" });
(globalThis as { __pairFake?: unknown }).__pairFake = pairing;
render(<ChatApp store={store} platform={{ ...webPlatform, pairing }} />, document.getElementById("root") || document.body);
