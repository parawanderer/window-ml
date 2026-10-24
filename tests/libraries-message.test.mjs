// libraries-message.test.mjs — `LIBRARIES`, the registration page's route to the tier 3 libraries store (background.ts,
// src/sw/sw-libraries.ts): an extension page lists and removes, and a remove restarts the Python workers that held a
// library (READONLY_LIBRARY_MANIFEST.md, ruling D); there is no add, since only an approved card stores one; a page
// sender gets nothing. The offscreen half of the restart is tests/python-run-namespace.test.mjs.
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
const LIB = { id: "lib-1", module: "stats_lib", path: "/w/proj/lib/stats.py", root: "/w/proj", sha256: "a".repeat(64), source: "def total(xs):\n    return sum(xs)\n", names: [{ name: "total", kind: "def", signature: "xs" }], origin: "proposed", created: 1 };
const send = (bg, payload, sender = EXT_PAGE) => bg.send({ type: "LIBRARIES", payload }, sender).then(plain);

// --- the registration page's message ---

test("an extension page lists the stored libraries and removes one, which restarts the Python workers that held a library", T, async () => {
    const bg = loadBackground({ config, local: { ml_libraries_global: [LIB, { ...LIB, id: "lib-2", module: "geo" }] } });
    const listed = await send(bg, {});
    assert.deepEqual(listed.data.libraries.map((l) => l.module), ["stats_lib", "geo"]);
    assert.ok(!("restarted" in listed.data));
    assert.equal(bg.pyDrops.length, 0, "a read restarts nothing");
    const removed = await send(bg, { op: "remove", id: "lib-1" });
    assert.deepEqual(removed.data.libraries.map((l) => l.module), ["geo"]);
    assert.equal(removed.data.restarted, 1);
    assert.equal(bg.pyDrops.length, 1, "the remove restarted the workers");
    assert.deepEqual(bg.localStore.ml_libraries_global.map((l) => l.id), ["lib-2"]);
    assert.equal((await send(bg, { op: "remove", id: "lib-1" })).error, "no such library");
    assert.equal(bg.pyDrops.length, 1, "a remove of nothing restarts nothing");
    assert.equal((await send(bg, { op: "add", library: LIB })).error, "unknown op", "only an approved card stores a library");
});

test("LIBRARIES is no page-started type, and a page sender is refused on every op", T, async () => {
    assert.ok(!RELAY.PAGE_STARTED_TYPES.has("LIBRARIES"));
    assert.ok(!Object.values(RELAY.HANDLE_MAP).some((e) => e.type === "LIBRARIES"));
    const bg = loadBackground({ config, openTabs: [{ id: 7, url: PAGE }], local: { ml_libraries_global: [LIB] } });
    const pageSender = { tab: { id: 7, url: PAGE }, url: PAGE, origin: "https://site.example", frameId: 0, documentId: "d1" };
    for (const payload of [{}, { op: "list" }, { op: "remove", id: "lib-1" }, { op: "add", library: LIB }])
        assert.equal((await send(bg, payload, pageSender))?.error, "refused", JSON.stringify(payload));
    assert.deepEqual((await send(bg, {})).data.libraries.map((l) => l.id), ["lib-1"], "nothing the page sent was removed");
    assert.equal(bg.pyDrops.length, 0);
});
