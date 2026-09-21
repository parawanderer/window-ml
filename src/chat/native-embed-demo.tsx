// native-embed-demo.tsx — the phone app's page over the FAKE HOST's demo world (demo-world.ts): a laptop, a lab box and
// an old Mac with sessions on them. For building and screenshotting the app's screens with no hub. Only a demo build of
// the app carries it (mobile/scripts/sync-embed.mjs --demo); a release never does.

import { demoHost } from "./demo-world";
import { runEmbed } from "./native-embed";

const host = demoHost(Date.now());
// The same scripting handle as the web demo's (web.tsx): the specs fail a command or change a runtime through it.
(globalThis as { __chatFake?: unknown }).__chatFake = host;
runEmbed(host, { account: { label: "Demo phone", hubUrl: "demo", root: false }, bundle: "demo" });
