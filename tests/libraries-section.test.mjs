// libraries-section.test.mjs — the Settings "Python libraries" page (src/sidebar/settings/libraries-section.tsx,
// READONLY_LIBRARY_MANIFEST.md, "The runtime import loop"): each stored library with what a cell may use, where it was
// read from and its source; no add; a remove sends the id and says how many Python sandboxes it restarted. The worker's
// side of `LIBRARIES` is tests/libraries-message.test.mjs.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { createRequire } from "node:module";
const require_ = createRequire(import.meta.url);

let h, render, L, doc;
const sent = [];
let answer = () => ({ data: VIEW });
before(async () => {
    const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", { pretendToBeVisual: true, url: "https://extension.test/" });
    globalThis.window = dom.window;
    globalThis.document = dom.window.document;
    globalThis.Node = dom.window.Node;
    globalThis.chrome = {
        runtime: { lastError: undefined, sendMessage: (msg, cb) => { sent.push(structuredClone(msg)); cb(answer(msg.payload)); } },
        storage: { onChanged: { addListener() {}, removeListener() {} } },
    };
    doc = dom.window.document;
    ({ h, render } = require_("preact"));
    L = await import("../src/sidebar/settings/libraries-section.tsx");
});

const SOURCE = "def total(xs, start=0):\n    return sum(xs) + start\nSCALE = 2\n";
const LIB = { id: "lib-1", module: "stats_lib", path: "/w/proj/lib/stats.py", root: "/w/proj", sha256: "3f1c2a9e0b7d".padEnd(64, "0"), source: SOURCE, names: [{ name: "total", kind: "def", signature: "xs, start=0" }, { name: "SCALE", kind: "constant", signature: "" }], origin: "proposed", created: Date.UTC(2026, 9, 24) };
const GEO = { ...LIB, id: "lib-2", module: "geo", names: [{ name: "km", kind: "def", signature: "m" }] };
const VIEW = { libraries: [LIB, GEO] };

// Hooks run their effects after paint (requestAnimationFrame under jsdom), which a loaded CI runner can delay past any
// fixed sleep, so each step waits for what it is about to assert.
async function until(ok, what) {
    for (const end = Date.now() + 5000; !ok();) {
        if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
        await new Promise((r) => setTimeout(r, 10));
    }
}
async function show() {
    const host = doc.getElementById("root");
    render(null, host);
    sent.length = 0;
    render(h(L.LibrariesSectionBody, {}), host);
    await until(() => !/Reading…/.test(host.textContent), "the first read");
    return host;
}
const row = (host, id) => host.querySelector(`[data-library-id="${id}"]`);

// --- each library: what a cell may use, where it was read from, its source ---

test("each stored library shows its import, what a cell may use as the card showed it, its file, size and sha256, and its source; there is no add", async () => {
    answer = () => ({ data: VIEW });
    const host = await show();
    assert.deepEqual(sent.map((m) => [m.type, m.payload]), [["LIBRARIES", {}]], "it reads the store once on open");
    const r = row(host, "lib-1");
    assert.match(r.textContent, /import stats_lib/);
    assert.match(r.textContent, /may use total\(xs, start=0\), SCALE\./);
    assert.match(r.textContent, new RegExp(`Read from /w/proj/lib/stats\\.py on .* \\(${Buffer.byteLength(SOURCE)} bytes, sha256 3f1c2a9e0b7d\\)`));
    assert.equal(r.querySelector("pre code").textContent, SOURCE);
    assert.ok(row(host, "lib-2"));
    assert.match(host.textContent, /Removing one restarts the Python sandboxes that loaded a library/);
    assert.equal(host.querySelectorAll("textarea, input").length, 0, "no add form: only an approved card stores a library");
});

test("with nothing stored, the page says how a library gets here", async () => {
    answer = () => ({ data: { libraries: [] } });
    const host = await show();
    assert.match(host.textContent, /No library stored\. The model proposes one with propose_manifest; it is stored only when you approve its card\./);
});

// --- remove ---

test("the remove button sends the entry's id and says how many sandboxes restarted", async () => {
    answer = (p) => p.op === "remove" ? { data: { libraries: [GEO], restarted: 2 } } : { data: VIEW };
    const host = await show();
    row(host, "lib-1").querySelector("button").click();
    await until(() => host.querySelector(".lib-note"), "the remove's note");
    assert.deepEqual(sent.at(-1), { type: "LIBRARIES", payload: { op: "remove", id: "lib-1" } });
    assert.equal(row(host, "lib-1"), null);
    assert.match(host.querySelector(".lib-note").textContent, /^Removed stats_lib\. 2 Python sandboxes restarted, so no cell can still import it\.$/);
    answer = (p) => p.op === "remove" ? { data: { libraries: [], restarted: 0 } } : { data: VIEW };
    row(host, "lib-2").querySelector("button").click();
    await until(() => /Removed geo/.test(host.querySelector(".lib-note").textContent), "the second remove's note");
    assert.match(host.querySelector(".lib-note").textContent, /^Removed geo\. No Python sandbox had loaded a library, so none restarted\.$/);
});

test("a remove the worker refuses shows its reason", async () => {
    answer = (p) => p.op === "remove" ? { error: "no such library" } : { data: VIEW };
    const host = await show();
    row(host, "lib-1").querySelector("button").click();
    await until(() => host.querySelector(".lib-err"), "the refusal");
    assert.equal(host.querySelector(".lib-err").textContent, "no such library");
    assert.ok(row(host, "lib-1"), "the list is unchanged");
});
