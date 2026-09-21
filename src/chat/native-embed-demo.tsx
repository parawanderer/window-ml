// native-embed-demo.tsx — the phone app's page over the FAKE HOST's demo world (demo-world.ts): a laptop, a lab box and
// an old Mac with sessions on them. For building and screenshotting the app's screens with no hub. Only a demo build of
// the app carries it (mobile/scripts/sync-embed.mjs --demo); a release never does.

import { fakePairing } from "../pairing/fake-pairing";
import { demoHost } from "./demo-world";
import { runEmbed } from "./native-embed";

const host = demoHost(Date.now());
// The same scripting handle as the web demo's (web.tsx): the specs fail a command or change a runtime through it.
(globalThis as { __chatFake?: unknown }).__chatFake = host;
// Pairing, faked as the web demo fakes it: this phone may pair others and pass on what it holds, a tablet waits under a
// code, and the account has four devices. `__pairFake` answers or fails a join, for the specs.
const now = Date.now();
const pairing = fakePairing({
    joinsAs: "client", defaultLabel: "Phone", defaultHubUrl: "wss://hub.example", rootKeptIn: "this app's storage on this phone",
    membership: { label: "Demo phone", role: "client", hubUrl: "wss://hub.example", fingerprint: "5ab0e19c44d2", root: false, mayPair: true, principal: "5ab0e19c".repeat(8) },
    grantable: ["view", "drive", "screen"],
    devices: [
        { principal: "5ab0e19c".repeat(8), label: "Demo phone", role: "client", kind: "phone", scopes: ["view", "drive", "screen"], mayPair: true, notAfterMs: now + 80 * 86_400_000, lastSeenMs: now - 5_000 },
        { principal: "c0ffee12".repeat(8), label: "Work laptop", role: "runtime", kind: "browser", scopes: [], mayPair: true, mayRevoke: true, notAfterMs: now + 85 * 86_400_000, lastSeenMs: now - 120_000 },
        { principal: "a41c9e07".repeat(8), label: "Kitchen tablet", role: "client", kind: "phone", scopes: ["view"], notAfterMs: now + 30 * 86_400_000, lastSeenMs: now - 3 * 86_400_000 },
    ],
});
pairing.addOffer("7K3M Q9XD", { label: "Living-room tablet", role: "client", fingerprint: "a41c9e07d3b2" });
(globalThis as { __pairFake?: unknown }).__pairFake = pairing;
runEmbed(host, { account: { label: "Demo phone", hubUrl: "demo", root: false }, bundle: "demo", pairing });
