"use strict";
// `ml.dynamicTools.<bundle>.<fn>(args)` — the server-side tools as a callable namespace.
//
// Tested against a stub API rather than the bundle, because the interesting behaviour is all in the shape:
// what exists before a list has been fetched, what a whitelist hides, and what happens to arguments that do
// not match the server's own schema.
import { test } from "node:test";
import assert from "node:assert";

const { makeDynamicTools, DynamicToolArgumentError } = await import("../src/dynamic-tools.ts");

const SEARCH = {
    id: "searxng_web_search", name: "SearXNG", description: "Web search.", kind: "local",
    functions: [{ name: "search_web", description: "Search.", parameters: { type: "object", properties: { q: { type: "string" }, limit: { type: "number" } }, required: ["q"] } }],
};
const FETCH = {
    id: "web_page_fetch_summarize", name: "Fetch", description: "Read a page.", kind: "local",
    functions: [{ name: "fetch_page", description: "Fetch.", parameters: { type: "object", properties: { url: { type: "string" } }, required: ["url"] } }],
};

/** A stub `ml` recording what was dispatched. */
const stub = (bundles = [SEARCH, FETCH]) => {
    const calls = [];
    return {
        calls,
        serverTools: async () => bundles,
        execServerTool: async (toolId, name, args, options) => { calls.push({ toolId, name, args, options }); return { ok: true, result: { result: "x", durationMs: 1 }, output: "", marks: [], events: [] }; },
    };
};

test("a call dispatches to the right bundle and function", async () => {
    const ml = stub();
    const ns = makeDynamicTools(ml);
    await ns.load();
    await ns.searxng_web_search.search_web({ q: "ollama" });
    assert.deepEqual(ml.calls[0], { toolId: "searxng_web_search", name: "search_web", args: { q: "ollama" }, options: {} });
});

test("namespaced by BUNDLE, so two tools with the same function name stay distinct", async () => {
    // The reason it is not flattened: function names come from the server, and resolving one of two
    // identically-named functions would silently call the wrong tool.
    const twin = { ...FETCH, id: "other_fetcher", functions: [{ name: "fetch_page", description: "", parameters: null }] };
    const ml = stub([FETCH, twin]);
    const ns = makeDynamicTools(ml);
    await ns.load();
    await ns.web_page_fetch_summarize.fetch_page({ url: "https://a" });
    await ns.other_fetcher.fetch_page({ url: "https://b" });
    assert.deepEqual(ml.calls.map(c => c.toolId), ["web_page_fetch_summarize", "other_fetcher"]);
});

test("the schema is ON the callable, and is the same object the call is checked against", async () => {
    const ml = stub();
    const ns = makeDynamicTools(ml);
    await ns.load();
    const fn = ns.searxng_web_search.search_web;
    assert.equal(fn.schema, SEARCH.functions[0].parameters, "not a copy — a copy would drift from the check");
    assert.equal(fn.spec.description, "Search.");
    assert.equal(fn.toolId, "searxng_web_search");
});

test("arguments are validated BEFORE dispatch, against the server's own schema", async () => {
    const ml = stub();
    const ns = makeDynamicTools(ml);
    await ns.load();
    // A typo should fail here with the reason, not as a 400 from the far end and not as a call that
    // succeeded with an argument silently dropped.
    await assert.rejects(() => ns.searxng_web_search.search_web({ query: "ollama" }), (e) => {
        assert.ok(e instanceof DynamicToolArgumentError);
        assert.match(e.message, /missing required "q"/);
        return true;
    });
    assert.equal(ml.calls.length, 0, "nothing was dispatched");
});

test("a wrong TYPE is caught too, and the message names the tool", async () => {
    const ml = stub();
    const ns = makeDynamicTools(ml);
    await ns.load();
    await assert.rejects(() => ns.searxng_web_search.search_web({ q: "x", limit: "ten" }),
        /dynamicTools\["searxng_web_search"\]\.search_web/);
    assert.equal(ml.calls.length, 0);
});

test("a call works BEFORE any list has been fetched — the Proxy is why", async () => {
    // window.ml exists synchronously at document_start and the list needs a fetch, so a namespace that
    // waited would not exist when someone first reaches for it.
    const ml = stub();
    const ns = makeDynamicTools(ml);
    await ns.searxng_web_search.search_web({ q: "anything" });
    assert.equal(ml.calls[0].name, "search_web");
    assert.equal(ml.calls[0].toolId, "searxng_web_search");
});

test("…and an unlisted call cannot validate, so it dispatches rather than refusing", async () => {
    const ml = stub();
    const ns = makeDynamicTools(ml);
    const fn = ns.some_bundle.some_fn;
    assert.equal(fn.schema, null, "we were never told the shape");
    await fn({ whatever: 1 });
    assert.equal(ml.calls.length, 1, "refusing a tool that may well exist would be worse than asking");
});

test("real keys appear after load(), which is what makes completion work", async () => {
    const ml = stub();
    const ns = makeDynamicTools(ml);
    assert.deepEqual(Object.keys(ns).filter(k => k !== "load"), [], "nothing listed yet");
    const ids = await ns.load();
    assert.deepEqual(ids.sort(), ["searxng_web_search", "web_page_fetch_summarize"]);
    assert.ok(Object.keys(ns).includes("searxng_web_search"), "enumerable, so the console can complete it");
});

test("a run's whitelist HIDES the rest, and says so instead of being undefined", async () => {
    // `undefined is not a function` sends the reader hunting for a typo; naming the restriction does not.
    const ml = stub();
    const ns = makeDynamicTools(ml, ["searxng_web_search"]);
    await ns.load();
    await ns.searxng_web_search.search_web({ q: "ok" });
    assert.equal(ml.calls.length, 1);
    assert.throws(() => ns.web_page_fetch_summarize, /may not use "web_page_fetch_summarize"/);
    assert.ok(!Object.keys(ns).includes("web_page_fetch_summarize"), "and it is not listed either");
});

test("streaming options pass straight through", async () => {
    const ml = stub();
    const ns = makeDynamicTools(ml);
    await ns.load();
    const onOutput = () => {};
    await ns.web_page_fetch_summarize.fetch_page({ url: "https://a" }, { onOutput });
    assert.equal(ml.calls[0].options.onOutput, onOutput);
});

/* --------------------------- the LIVE run scope --------------------------- */
// The whitelist is not a check, it is the object. There is no caller identity to test — an approved `exec`
// runs in the page's main world, the same realm as the console — so what changes is what `ml.dynamicTools`
// IS for the duration of a tool call.

test("the scope is read PER ACCESS, so one namespace is narrow in a run and wide in the console", async () => {
    const ml = stub();
    let scope = null;                       // null = outside a run
    const ns = makeDynamicTools(ml, undefined, () => scope);
    await ns.load();

    // Console: everything the key can reach.
    assert.ok(ns.web_page_fetch_summarize.fetch_page);
    assert.ok(Object.keys(ns).includes("web_page_fetch_summarize"));

    // Inside a tool call that was given only the search bundle — the SAME object.
    scope = ["searxng_web_search"];
    assert.ok(ns.searxng_web_search.search_web);
    assert.throws(() => ns.web_page_fetch_summarize, /may not use "web_page_fetch_summarize"/);
    assert.ok(!Object.keys(ns).includes("web_page_fetch_summarize"), "and it is not enumerable either");

    // …and back, when the call returns.
    scope = null;
    assert.ok(ns.web_page_fetch_summarize.fetch_page);
});

test("a run that was given NO server tools reaches none", async () => {
    // The case a captured-at-construction whitelist would get wrong: the namespace a run sees would be
    // whatever the first caller built, which in practice is the console's unrestricted one.
    const ml = stub();
    let scope = null;
    const ns = makeDynamicTools(ml, undefined, () => scope);
    await ns.load();
    scope = [];
    assert.throws(() => ns.searxng_web_search, /no server tools/);
    assert.deepEqual(Object.keys(ns).filter(k => k !== "load"), []);
});
