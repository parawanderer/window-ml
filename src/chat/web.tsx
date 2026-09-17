// THE CHAT PAGE'S WEB ENTRY: a plain page with no extension, built to `dist-web/` (docs/spec/CHAT_PAGE.md §Two places).
// It opens on the fake host's demo world, because the host a phone will really use, `HubHost`, is slice 6; until then
// this build is for developing the core and testing it at phone width. The build fails if `chrome` reaches this bundle
// (scripts/build-web.mjs), which is what keeps the core portable.
import { render } from "preact";
import { installServices } from "../sidebar/services";
import { installTooltipLayer } from "../sidebar/tooltip-layer";
import { applyCodePrefs, applyFocus, initThemeStyle } from "../sidebar/prefs";
import { ChatStore } from "./chat-store";
import { demoHost } from "./demo-world";
import { hostServices } from "./host-services";
import { webPlatform } from "./platform";
import { ChatApp } from "./chat-app";

const host = demoHost();
// Scripting handle for the specs and for poking at the page by hand: emit events, restart a runtime, change grants.
(globalThis as { __chatFake?: unknown }).__chatFake = host;
const store = new ChatStore(host);
installServices(hostServices(store, webPlatform));
initThemeStyle();
applyCodePrefs();
applyFocus();
try { installTooltipLayer(document); } catch { /* no DOM */ }
store.start();
render(<ChatApp store={store} />, document.getElementById("root") || document.body);
