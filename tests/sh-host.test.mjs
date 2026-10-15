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
    assert.match(r.data.error, /wmlhost install --extension-id/);
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
