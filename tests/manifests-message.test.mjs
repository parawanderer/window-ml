// manifests-message.test.mjs — `MANIFESTS`, the registration page's route to the manifests store (background.ts,
// src/sw/sw-manifests.ts): an extension page reads, adds and removes; a page sender gets nothing. The red team's own
// pass for the type is in tests/redteam.test.js.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { loadBackground } = require("./helpers");
const RELAY = await import("../src/page-relay.ts");

const T = { timeout: 20000 };
const plain = (x) => JSON.parse(JSON.stringify(x ?? null));
const config = { chatUrl: "http://host/api/chat/completions", apiKey: "sk-test", model: "m", apiFormat: "openai", ocrModel: "", debugMode: "off" };
const EXT_PAGE = { url: "chrome-extension://test/sidebar.html" };
const PAGE = "https://site.example/p";
const TOOL = { program: "mytool", version: { range: "*", args: [], pattern: "" }, command: { effects: ["read"], paths: "operands", flags: {} } };
const PIN = { path: "/opt/bin/mytool", fingerprint: "1:2:3:4", inRoot: false };

// --- the registration page's message ---

test("an extension page lists, adds (as the person's) and removes a stored manifest; a refused add names why", T, async () => {
    const bg = loadBackground({ config });
    const empty = plain(await bg.send({ type: "MANIFESTS", payload: {} }, EXT_PAGE));
    assert.deepEqual([empty.data.global, empty.data.workspace], [[], []]);
    assert.ok(empty.data.shipped.includes("git"));
    const added = plain(await bg.send({ type: "MANIFESTS", payload: { op: "add", scope: "global", manifest: TOOL, pin: PIN, origin: "proposed" } }, EXT_PAGE));
    assert.equal(added.data.global.length, 1);
    assert.equal(added.data.global[0].origin, "person", "the page's word is the person's; it cannot claim to be a proposal");
    const shipped = plain(await bg.send({ type: "MANIFESTS", payload: { op: "add", scope: "global", manifest: { ...TOOL, program: "rm" }, pin: { ...PIN, path: "/bin/rm" } } }, EXT_PAGE));
    assert.match(shipped.error, /shipped manifest src\/shell\/manifests\/rm\.json/);
    const removed = plain(await bg.send({ type: "MANIFESTS", payload: { op: "remove", id: added.data.global[0].id } }, EXT_PAGE));
    assert.deepEqual(removed.data.global, []);
    assert.equal(plain(await bg.send({ type: "MANIFESTS", payload: { op: "remove", id: "man-none" } }, EXT_PAGE)).error, "no such manifest");
    assert.equal(plain(await bg.send({ type: "MANIFESTS", payload: { op: "rename" } }, EXT_PAGE)).error, "unknown op");
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
