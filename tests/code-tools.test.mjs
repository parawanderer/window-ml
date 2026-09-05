// The affordances on a rendered code block (sidebar/render-panel.tsx CodeTools + the margin notes in
// ui-kit's Code). Rendered directly, no app: what is pinned is that the annotation is drawn BESIDE the
// code and never in it, that hiding notes does not throw the call away, and that the button says what it
// can actually do.
import { test, before, after } from "node:test";
import assert from "node:assert";
import { JSDOM } from "jsdom";
import { createRequire } from "node:module";
const require_ = createRequire(import.meta.url);

let h, render, RenderPanel, store, summaries, doc, sent;

before(async () => {
    // A real `url`: localStorage throws on an opaque origin, and the bench button writes to it.
    const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", { pretendToBeVisual: true, url: "https://example.test/" });
    globalThis.window = dom.window;
    globalThis.document = dom.window.document;
    globalThis.Node = dom.window.Node;
    globalThis.NodeFilter = dom.window.NodeFilter;
    globalThis.localStorage = dom.window.localStorage;
    doc = dom.window.document;
    sent = [];
    globalThis.chrome = {
        runtime: { sendMessage: (msg, cb) => { sent.push({ msg, cb }); }, lastError: null },
        storage: { local: { get: () => {}, set: () => {} }, sync: { get: () => {}, set: () => {} } },
    };
    ({ h, render } = require_("preact"));
    ({ RenderPanel } = await import("../src/sidebar/render-panel.tsx"));
    store = await import("../src/sidebar/store.ts");
    summaries = await import("../src/sidebar/summaries.tsx");
});
after(() => { try { globalThis.window?.close(); } catch { /* already gone */ } });

const tick = () => new Promise(r => setTimeout(r, 40));
const KEY = "h1:7";
const ctx = { hash: "h1", seq: 7, result: "42\n" };

// A python-in descriptor with a body worth annotating.
const PY = { type: "python-in", mode: "script", code: "import numpy as np\ntotal = np.arange(10).sum()\nreturn int(total)" };

const mount = async (d, withCtx = true) => {
    const host = doc.getElementById("root");
    render(null, host);
    render(h(RenderPanel, { d, ctx: withCtx ? ctx : undefined }), host);
    await tick();
    return host;
};
const reset = () => {
    summaries.codeNotes.delete(KEY);
    summaries.notesState.delete(KEY);
    summaries.notesHidden.delete(KEY);
    sent.length = 0;
    store.config.value = { ...store.config.value, utilityModel: "qwen3.5:4b" };
};

test("no step context (an export, a preview) → no tools at all", async () => {
    reset();
    const host = await mount(PY, false);
    assert.equal(host.querySelector(".code-tools"), null);
    assert.ok(host.querySelector("pre.code"), "the code itself still renders");
});

test("without a utility model the explain button is present but disabled, and says why", async () => {
    reset();
    store.config.value = { ...store.config.value, utilityModel: "" };
    const host = await mount(PY);
    const btn = host.querySelector(".code-tool");
    assert.ok(btn.disabled);
    assert.match(btn.querySelector(".tt-pop").textContent, /Set a utility model/);
});

test("explain asks the UTILITY model, over the lines the reader is shown", async () => {
    reset();
    const host = await mount(PY);
    host.querySelector(".code-tool").click();
    await tick();
    assert.equal(sent.length, 1);
    const { payload } = sent[0].msg;
    assert.equal(sent[0].msg.type, "FETCH_LLM");
    assert.equal(payload.extend, "utility");
    assert.ok(payload.schema, "constrained by a schema, not parsed out of prose");
    // Numbered against the DISPLAYED source: the reader sees three lines, so the model is given three.
    assert.match(payload.messages[1].content, /1\|import numpy as np/);
    assert.match(payload.messages[1].content, /3\|return int\(total\)/);
    // Given what it produced, so the gloss can say what a line FOUND.
    assert.match(payload.messages[1].content, /It produced:\n42/);
});

test("a landed note is drawn beside its line, and the SOURCE is untouched", async () => {
    reset();
    const host = await mount(PY);
    host.querySelector(".code-tool").click();
    await tick();
    sent[0].cb({ data: JSON.stringify({ notes: [{ line: 2, note: "sums 0..9 with `numpy`" }] }) });
    await tick();
    const notes = host.querySelectorAll(".lnote");
    assert.equal(notes.length, 1);
    assert.match(notes[0].textContent, /sums 0\.\.9/);
    // Rendered through the markdown renderer (backticks → <code>), per the inline-prose rule.
    assert.ok(notes[0].querySelector("code"), "the note goes through the markdown renderer");
    // The code lines are still exactly the three the model ran — a note is a SIBLING of a line, never
    // inserted into it, which is what keeps py-format's line map (and every traceback) valid.
    const lines = [...host.querySelectorAll(".cline")].map(el => el.querySelector(".lcode").textContent);
    assert.deepEqual(lines, ["import numpy as np", "total = np.arange(10).sum()", "return int(total)"]);
    assert.deepEqual([...host.querySelectorAll(".lno")].map(e => e.textContent), ["1", "2", "3"]);
});

test("notes hide and come back WITHOUT a second call", async () => {
    reset();
    summaries.codeNotes.set(KEY, [{ line: 1, note: "imports numpy" }]);
    const host = await mount(PY);
    assert.equal(host.querySelectorAll(".lnote").length, 1);
    const toggle = host.querySelector(".code-tool");
    assert.match(toggle.textContent, /notes/);
    toggle.click(); await tick();
    assert.equal(host.querySelectorAll(".lnote").length, 0, "hidden");
    assert.equal(sent.length, 0, "hiding does not re-ask");
    host.querySelector(".code-tool").click(); await tick();
    assert.equal(host.querySelectorAll(".lnote").length, 1, "back, from the same call");
    assert.equal(sent.length, 0);
});

test("a reply with nothing usable becomes a retry, not a silently dead button", async () => {
    reset();
    const host = await mount(PY);
    host.querySelector(".code-tool").click();
    await tick();
    sent[0].cb({ data: "sorry, I can't do that" });
    await tick();
    assert.equal(host.querySelectorAll(".lnote").length, 0);
    const btn = host.querySelector(".code-tool");
    assert.match(btn.textContent, /retry/);
    assert.ok(!btn.disabled);
});

test("python offers the bench, javascript offers a copy", async () => {
    reset();
    const py = await mount(PY);
    assert.match(py.querySelector(".code-tools").textContent, /bench/);
    reset();
    const js = await mount({ type: "code", text: "const x = 1;\nreturn x;", lang: "javascript" });
    const tools = js.querySelector(".code-tools").textContent;
    assert.match(tools, /copy/);
    assert.doesNotMatch(tools, /bench/);
});

test("the bench button hands the bench the script and navigates there", async () => {
    reset();
    store.view.value = { name: "detail", hash: "h1" };
    const host = await mount(PY);
    [...host.querySelectorAll(".code-tool")].find(b => /bench/.test(b.textContent)).click();
    await tick();
    assert.equal(localStorage.getItem(store.BENCH_CODE_KEY), PY.code);
    assert.equal(store.view.value.name, "bench");
    store.view.value = { name: "list" };
});
