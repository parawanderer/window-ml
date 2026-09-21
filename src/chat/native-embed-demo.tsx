// native-embed-demo.tsx — the phone app's page over the FAKE HOST's demo world (demo-world.ts): a laptop, a lab box and
// an old Mac with sessions on them. For building and screenshotting the app's screens with no hub. Only a demo build of
// the app carries it (mobile/scripts/sync-embed.mjs --demo); a release never does.

import type { ModelChoice } from "../session-host";
import { fakePairing } from "../pairing/fake-pairing";
import { demoHost } from "./demo-world";
import { keepKeysInApp, runEmbed } from "./native-embed";
import { storeCache } from "./event-cache";

/**
 * What THIS demo's box offers to run: a real one has dozens, which is what the app's model filter is for, and the web
 * demo's curated four say nothing about it. The three the demo's sessions name are in here, so switching still works.
 */
const DEMO_MODELS: ModelChoice[] = [
    { id: "qwen3:32b", kinds: ["completion", "tools", "thinking"], default: true, where: "local" },
    { id: "qwen3:14b", kinds: ["completion", "tools", "thinking"], where: "local" },
    { id: "qwen3:8b", kinds: ["completion", "tools", "thinking"], where: "local" },
    { id: "qwen3-coder:30b", kinds: ["completion", "tools"], where: "local" },
    { id: "gemma3:27b", kinds: ["completion", "vision"], where: "local" },
    { id: "gemma3:12b", kinds: ["completion", "vision"], where: "local" },
    { id: "gemma3:4b", kinds: ["completion", "vision"], where: "local" },
    { id: "llama3.3:70b", kinds: ["completion", "tools"], where: "local" },
    { id: "llama3.2-vision:11b", kinds: ["completion", "vision"], where: "local" },
    { id: "mistral-small3.2:24b", kinds: ["completion", "tools", "vision"], where: "local" },
    { id: "devstral:24b", kinds: ["completion", "tools"], where: "local" },
    { id: "deepseek-r1:32b", kinds: ["completion", "thinking"], where: "local" },
    { id: "phi4:14b", kinds: ["completion"], where: "local" },
    { id: "granite3.3:8b", kinds: ["completion", "tools"], where: "local" },
    { id: "minicpm-v:8b", kinds: ["completion", "vision"], where: "local" },
    { id: "nomic-embed-text", kinds: ["embedding"], where: "local" },
    { id: "mxbai-embed-large", kinds: ["embedding"], where: "local" },
    { id: "litellm.google/gemini-flash-latest", where: "cloud" },
    { id: "litellm.anthropic/claude-haiku-latest", where: "cloud" },
    { id: "litellm.openai/gpt-5-mini", where: "cloud" },
];

const host = demoHost(Date.now());
host.models = DEMO_MODELS;
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
// The same cache the real app keeps, over the same bridge: the demo exercises it end to end on a device. Its fake runtime
// starts a new history on every launch, so a reopened session is also the RESET path, which is worth seeing work.
// Only inside the app: a page opened on its own (the specs) has no store to keep anything in.
const inApp = !!(globalThis as { ReactNativeWebView?: unknown }).ReactNativeWebView;
const cache = inApp ? storeCache(keepKeysInApp()) : undefined;
runEmbed(host, { account: { label: "Demo phone", hubUrl: "demo", root: false }, bundle: "demo", pairing, ...(cache ? { cache } : {}) });
