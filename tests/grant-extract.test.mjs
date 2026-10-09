// grant-extract.test.mjs — button #3's static egress extraction. It must find the LITERAL ml.fetch URLs a
// human would see (so "remember" persists exactly those) and skip everything dynamic (a URL the human never
// saw can't be remembered). Pure + chrome-free — imported straight from source via tsx.

import test from "node:test";
import assert from "node:assert/strict";
import { extractGrants, fetchUrlLiterals, tabGrantsForCall } from "../src/sw/grant-extract.ts";

test("extracts ml.fetch string literals from exec", () => {
    const grants = extractGrants("exec", { js: `const a = await ml.fetch("https://x.test/data.json"); a.text` });
    assert.deepEqual(grants, [{ kind: "fetch-url", urls: ["https://x.test/data.json"] }]);
});

test("window.ml.fetch and quasi-only template literals count", () => {
    assert.deepEqual(fetchUrlLiterals("window.ml.fetch(`https://a.test/b`)"), ["https://a.test/b"]);
    assert.deepEqual(fetchUrlLiterals("ml.fetch('https://a.test/c')"), ["https://a.test/c"]);
});

test("dynamic targets are NOT persistable (variable, interpolated template, member)", () => {
    assert.deepEqual(fetchUrlLiterals("ml.fetch(url)"), []);
    assert.deepEqual(fetchUrlLiterals("ml.fetch(`https://a.test/${id}`)"), []);
    assert.deepEqual(fetchUrlLiterals("ml.fetch(cfg.url)"), []);
    assert.deepEqual(extractGrants("exec", { js: "ml.fetch(paths[0])" }), []);
});

test("multiple + de-duplicated, in source order", () => {
    const js = `ml.fetch("https://a.test/1"); ml.fetch("https://a.test/2"); ml.fetch("https://a.test/1")`;
    assert.deepEqual(fetchUrlLiterals(js), ["https://a.test/1", "https://a.test/2"]);
});

test("ml.fetch inside a string or comment is NOT a call (real parser, not regex)", () => {
    assert.deepEqual(fetchUrlLiterals(`const s = 'ml.fetch("https://evil.test/x")'; s`), []);
    assert.deepEqual(fetchUrlLiterals(`// ml.fetch("https://evil.test/y")\n1`), []);
});

test("a DIFFERENT .fetch (not ml/window.ml) is ignored", () => {
    assert.deepEqual(fetchUrlLiterals(`fetch("https://a.test/raw"); other.fetch("https://a.test/z")`), []);
    assert.deepEqual(fetchUrlLiterals(`api.ml.fetch("https://a.test/no")`), []);   // obj.ml.fetch where obj≠window
});

test("unparseable code yields no grants (falls through to one-off)", () => {
    assert.deepEqual(fetchUrlLiterals("this is (not js"), []);
    assert.deepEqual(extractGrants("exec", { js: "@@@" }), []);
});

test("unknown tool → no extractor → []", () => {
    assert.deepEqual(extractGrants("click", { selector: "#x" }), []);
    assert.deepEqual(extractGrants("exec", {}), []);   // no js arg
});

// --- what an approved call puts on its TAB (tabGrantsForCall) ---

const SHEET = "https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789/edit#gid=0";
const SHEET_ID = "1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789";

/** Every shape a python_exec's `tables` can name an external sheet in, and the other sources a call can mix with it. */
const PY_ARGS = {
    "a sheet": { tables: { s: SHEET } },
    "a sheet in an array": { tables: { s: [SHEET] } },
    "a sheet nested two deep": { tables: { s: [[SHEET]] } },
    "a sheet with an image (page-only)": { tables: { s: SHEET }, image: "current" },
    "a sheet with a selector (page-only)": { tables: { s: SHEET, t: "#table" } },
    "a sheet with a @tool: pointer": { tables: { s: SHEET, t: "@tool:abc1234" } },
    "full mode with a sheet": { mode: "full", code: "print(1)", tables: { s: SHEET } },
    "no sheet": { tables: { t: "#table" } },
};

test("CLAUSE B: a worker-built run's python_exec puts no sheet on the tab, whatever its args and wherever it runs", () => {
    for (const [label, args] of Object.entries(PY_ARGS)) for (const pyInWorker of [true, false]) {
        const g = tabGrantsForCall({ name: "python_exec", args, builtByWorker: true, pyInWorker });
        assert.deepEqual(g.sheets, [], `${label}, ${pyInWorker ? "in the worker" : "on the page"}: a sheet id went on the tab`);
    }
});

test("a page-built run's python_exec, which the page's own loop runs, still gets its sheets on the tab", () => {
    for (const [label, args] of Object.entries(PY_ARGS)) {
        const g = tabGrantsForCall({ name: "python_exec", args, builtByWorker: false, pyInWorker: false });
        assert.deepEqual(g.sheets, label === "no sheet" ? [] : [SHEET_ID], label);
    }
});

test("a python_exec the worker runs puts nothing at all on the tab; one on the page gets its full-mode code", () => {
    for (const builtByWorker of [true, false]) {
        const inWorker = tabGrantsForCall({ name: "python_exec", args: PY_ARGS["full mode with a sheet"], builtByWorker, pyInWorker: true });
        assert.deepEqual(inWorker, { serverTools: [], sheets: [], pyCode: [] });
        const onPage = tabGrantsForCall({ name: "python_exec", args: PY_ARGS["full mode with a sheet"], builtByWorker, pyInWorker: false });
        assert.deepEqual(onPage.pyCode, ["print(1)"]);
        assert.deepEqual(tabGrantsForCall({ name: "python_exec", args: { code: "print(1)" }, builtByWorker, pyInWorker: false }).pyCode, [], "readonly mode: no code grant");
    }
});

test("an exec gets the URLs its code spells out and no others; a server tool its exact call; any other tool nothing", () => {
    const exec = tabGrantsForCall({ name: "exec", args: { js: 'await ml.fetch("https://a.example/x"); await ml.fetch(u)' }, builtByWorker: true, pyInWorker: false });
    assert.deepEqual(exec, { fetchUrls: ["https://a.example/x"], serverTools: [], sheets: [], pyCode: [] });
    const remote = tabGrantsForCall({ name: "search", args: { q: "x" }, builtByWorker: true, pyInWorker: false, remoteKey: "bundle\u0000search\u0000{}" });
    assert.deepEqual(remote, { serverTools: ["bundle\u0000search\u0000{}"], sheets: [], pyCode: [] });
    for (const name of ["click", "type", "look", "fetch_url", "answer"])
        assert.deepEqual(tabGrantsForCall({ name, args: { tables: { s: SHEET }, js: 'ml.fetch("https://a.example/x")', mode: "full", code: "x" }, builtByWorker: false, pyInWorker: false }), { serverTools: [], sheets: [], pyCode: [] }, name);
});
