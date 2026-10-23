// manifests-message.test.mjs — `MANIFESTS`, the registration page's route to the manifests store (background.ts,
// src/sw/sw-manifests.ts): an extension page reads, adds and removes; a page sender gets nothing. The red team's own
// pass for the type is in tests/redteam.test.js.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { loadBackground } = require("./helpers");
const RELAY = await import("../src/page-relay.ts");
import { fakeNativeHost } from "./fake-native-host.mjs";

const T = { timeout: 20000 };
const plain = (x) => JSON.parse(JSON.stringify(x ?? null));
const config = { chatUrl: "http://host/api/chat/completions", apiKey: "sk-test", model: "m", apiFormat: "openai", ocrModel: "", debugMode: "off" };
const EXT_PAGE = { url: "chrome-extension://test/sidebar.html" };
const PAGE = "https://site.example/p";
const TOOL = { program: "mytool", version: { range: "*", args: [], pattern: "" }, command: { effects: ["read"], paths: "operands", flags: {} } };
const PIN = { path: "/opt/bin/mytool", fingerprint: "1:2:3:4", inRoot: false };

// --- the registration page's message ---

/** A worker with ml.sh on over `roots`, its host faked; `facts` replaces the host's answer to a spawn. */
function withHost(roots = ["/w/proj"], facts) {
    const host = fakeNativeHost({ landlockAbi: null, ...(facts ? { facts } : {}) });
    const bg = loadBackground({ config: { ...config, shellEnabled: true, shellRoots: roots }, onNative: host.onNative });
    return { bg, host };
}
const add = (bg, payload) => bg.send({ type: "MANIFESTS", payload: { op: "add", ...payload } }, EXT_PAGE).then(plain);

test("an extension page lists, adds (as the person's, pinned by the host) and removes a stored manifest; a refused add names why", T, async () => {
    const { bg, host } = withHost();
    const empty = plain(await bg.send({ type: "MANIFESTS", payload: {} }, EXT_PAGE));
    assert.deepEqual([empty.data.global, empty.data.workspace], [[], []]);
    assert.ok(empty.data.shipped.includes("git"));
    const added = await add(bg, { scope: "global", manifest: TOOL, pin: { ...PIN, path: "/tmp/evil", fingerprint: "6:6:6:6" }, origin: "proposed" });
    assert.equal(added.data.global.length, 1);
    const [s] = added.data.global;
    assert.equal(s.origin, "person", "the page's word is the person's; it cannot claim to be a proposal");
    assert.deepEqual(s.pin, { path: "/usr/bin/mytool", fingerprint: "1:2:3:4", inRoot: false }, "the host's pin, never the payload's");
    assert.deepEqual(host.names().filter((n) => n !== "hello" && n !== "configure"), ["spawn", "discard"], "resolved and discarded: nothing started");
    assert.equal(host.calls.find((c) => c.call === "spawn").args.owner, undefined, "no run owns the page's resolve");
    const shipped = await add(bg, { scope: "global", manifest: { ...TOOL, program: "rm" } });
    assert.match(shipped.error, /shipped manifest src\/shell\/manifests\/rm\.json/);
    assert.match((await add(bg, { scope: "global", manifest: TOOL })).error, /^mytool is already registered here/);
    assert.match((await add(bg, { scope: "everywhere", manifest: TOOL })).error, /^scope is "global"/, "the model-facing prefix is dropped");
    const removed = plain(await bg.send({ type: "MANIFESTS", payload: { op: "remove", id: s.id } }, EXT_PAGE));
    assert.deepEqual(removed.data.global, []);
    assert.equal(plain(await bg.send({ type: "MANIFESTS", payload: { op: "remove", id: "man-none" } }, EXT_PAGE)).error, "no such manifest");
    assert.equal(plain(await bg.send({ type: "MANIFESTS", payload: { op: "rename" } }, EXT_PAGE)).error, "unknown op");
});

test("a workspace add is kept for the root the page names; an unconfigured root, or ml.sh off, is refused", T, async () => {
    const { bg } = withHost(["/w/proj", "/w/other"]);
    const r = await add(bg, { scope: "workspace", root: "/w/other", manifest: TOOL });
    assert.deepEqual(r.data.workspace.map((w) => w.root), ["/w/other"]);
    assert.match((await add(bg, { scope: "workspace", root: "/w/nowhere", manifest: TOOL })).error, /^\/w\/nowhere is not a configured workspace folder/);
    const off = loadBackground({ config });
    assert.match((await add(off, { scope: "global", manifest: TOOL })).error, /^ml\.sh is not available/);
    assert.deepEqual(plain(await off.send({ type: "MANIFESTS", payload: {} }, EXT_PAGE)).data.global, []);
});

test("a program inside a root, added as global, is kept for its workspace and the answer says why (B3)", T, async () => {
    const facts = (args) => ({ argv: args.argv, program: { path: "/w/proj/bin/mytool", inRoot: true, fingerprint: "5:5:5:5" }, cwd: { path: args.cwd, inRoot: true }, env: { set: [], secrets: [], free: true }, repo: null, repoConfigRunsCode: null, paths: [], effects: "unknown", mode: "host", sandboxed: true, placement: "host-sandbox" });
    const { bg } = withHost(["/w/proj"], facts);
    const r = await add(bg, { scope: "global", manifest: TOOL });
    assert.deepEqual([r.data.global, r.data.workspace[0].root, r.data.workspace[0].manifests[0].pin.path], [[], "/w/proj", "/w/proj/bin/mytool"]);
    assert.match(r.data.forced, /inside the workspace \/w\/proj, so only that workspace may describe it/);
});

test("MANIFESTS is no page-started type, and a page sender is refused on every op", T, async () => {
    assert.ok(!RELAY.PAGE_STARTED_TYPES.has("MANIFESTS"));
    assert.ok(!Object.values(RELAY.HANDLE_MAP).some((e) => e.type === "MANIFESTS"));
    const bg = loadBackground({ config, openTabs: [{ id: 7, url: PAGE }] });
    const pageSender = { tab: { id: 7, url: PAGE }, url: PAGE, origin: "https://site.example", frameId: 0, documentId: "d1" };
    for (const payload of [{}, { op: "list" }, { op: "add", scope: "global", manifest: TOOL, pin: PIN }, { op: "remove", id: "x" }])
        assert.equal(plain(await bg.send({ type: "MANIFESTS", payload }, pageSender))?.error, "refused", JSON.stringify(payload));
    assert.deepEqual(plain(await bg.send({ type: "MANIFESTS", payload: {} }, EXT_PAGE)).data.global, [], "nothing the page sent was stored");
});
