// code-links.test.mjs — URLs and @tool: pointers made clickable INSIDE highlighted code (src/sidebar/code-links.ts):
// where a link is cut out of hljs's token HTML, which tokens keep their colour, and what stays text. Pure: no DOM.
import { test } from "node:test";
import assert from "node:assert";

const { linkifyHtml } = await import("../src/sidebar/code-links.ts");
const { highlight } = await import("../src/sidebar/format.ts");

const known = (id) => id === "abc1234" || id === "exec";
const anchors = (html) => [...html.matchAll(/<a [^>]*>/g)].map((m) => m[0]);
const text = (html) => html.replace(/<[^>]*>/g, "");
const raws = (html) => anchors(html).map((a) => /data-raw="([^"]*)"/.exec(a)?.[1]);

// --- a link keeps the token it sits in ---

test("a URL in a string token is an anchor INSIDE the string span, so it keeps the string colour", () => {
    const out = linkifyHtml('<span class="hljs-string">"see https://a.example/x now"</span>');
    assert.match(out, /<span class="hljs-string">"see <a [^>]*class="out-link"[^>]*>https:\/\/a\.example\/x<\/a> now"<\/span>/);
});

test("a URL in a comment token stays inside the comment span", () => {
    const out = linkifyHtml('<span class="hljs-comment">// docs: https://a.example/d.</span>');
    assert.match(out, /<span class="hljs-comment">\/\/ docs: <a [^>]*>https:\/\/a\.example\/d<\/a>\.<\/span>/);
});

test("a URL broken across two spans is one link cut into one anchor per span", () => {
    const out = linkifyHtml('<span class="a">https://a.exa</span><span class="b">mple/x</span>');
    assert.deepEqual(raws(out), ["https://a.example/x", "https://a.example/x"]);
    assert.match(out, /<span class="a"><a [^>]*>https:\/\/a\.exa<\/a><\/span><span class="b"><a [^>]*>mple\/x<\/a><\/span>/);
    assert.equal(text(out), "https://a.example/x");
});

test("the visible text is exactly the source text, whatever is linked", () => {
    const html = '<span class="hljs-string">&quot;https://a.example/?q=1&amp;r=2&quot;</span> <span class="x">tail</span>';
    assert.equal(text(linkifyHtml(html)), text(html));
    assert.deepEqual(raws(linkifyHtml(html)), ["https://a.example/?q=1&amp;r=2"]);
});

test("an entity in the address is decoded for the check and the anchor opens the decoded address", () => {
    const out = linkifyHtml("https://a.example/?q=1&amp;r=2");
    assert.match(out, /href="https:\/\/a\.example\/\?q=1&amp;r=2"/);
});

// --- what stays text ---

test("refused addresses stay text: zero-width, bidi, over-long, other schemes, userinfo", () => {
    for (const bad of ["https://a.exa​mple/x", "https://a.example/‮x", "https://a.example/⁦x", "javascript:alert(1)", "data:text/html,<b>x".replace("<", "&lt;"),
        "https://good.com@evil.com/", "https://a.example/" + "x".repeat(2100), "https://exämple.com/"]) {
        const html = `<span class="hljs-string">${bad}</span>`;
        assert.equal(linkifyHtml(html), html, JSON.stringify(bad.slice(0, 30)));
    }
});

test("html with nothing to link comes back as the very string", () => {
    const html = highlight("const x = 1; // nothing here", "javascript");
    assert.equal(linkifyHtml(html), html);
});

test("real hljs output: a URL in a JS string and a comment", () => {
    const out = linkifyHtml(highlight('const u = "https://a.example/p"; // see https://b.example/q', "javascript"), known);
    assert.deepEqual(raws(out), ["https://a.example/p", "https://b.example/q"]);
    assert.match(out, /hljs-string[^>]*>[^]*<a [^>]*>https:\/\/a\.example\/p<\/a>/);
    assert.match(out, /hljs-comment[^>]*>[^]*<a [^>]*>https:\/\/b\.example\/q<\/a>/);
});

test("text inside a tooltip pop is never linked", () => {
    const html = '<span class="tt tt-code expanded"><span class="tt-pop wrap">Expanded from <code>https://a.example/x</code></span>y</span>';
    assert.equal(linkifyHtml(html), html);
});

// --- @tool: pointers ---

test("a pointer naming a step is an anchor that carries its id", () => {
    const out = linkifyHtml('<span class="hljs-string">"@tool:abc1234:out"</span>', known);
    assert.match(out, /<a [^>]*data-ptr="abc1234"[^>]*data-slot="out"[^>]*>@tool:abc1234:out<\/a>/);
});

test("a pointer naming no step stays text, and with no resolver no pointer is linked", () => {
    const html = '<span class="hljs-string">"@tool:zzzzzzz"</span>';
    assert.equal(linkifyHtml(html, known), html);
    assert.equal(linkifyHtml('@tool:abc1234'), '@tool:abc1234');
});

test("a pointer glued to a word or longer than its id is not matched", () => {
    assert.equal(linkifyHtml("x@tool:abc1234", known), "x@tool:abc1234");
    assert.equal(linkifyHtml("@tool:abc1234x", known), "@tool:abc1234x");
});

test("a pointer inside a URL is part of the URL, not a second link", () => {
    const out = linkifyHtml("https://a.example/@tool:abc1234", known);
    assert.equal(anchors(out).length, 1);
    assert.doesNotMatch(out, /data-ptr/);
});

test("a tool-name alias resolves when the run has it", () => {
    assert.match(linkifyHtml("@tool:exec", known), /data-ptr="exec"/);
});

// --- the raw view: an hljs-link token that is not a link loses its underline ---

test("markdown raw view: a qualifying link target is linked and its token stays", () => {
    const out = linkifyHtml(highlight("see [x](https://a.example/p) and ![y](@tool:abc1234:out)", "markdown"), known);
    assert.deepEqual(raws(out), ["https://a.example/p", undefined], "the address, then the pointer (which has no data-raw)");
    assert.match(out, /data-ptr="abc1234"/);
    assert.doesNotMatch(out, /hljs-link-dead/);
});

test("markdown raw view: a relative path, a data: URI, a refused URL and a missing pointer lose the underline", () => {
    for (const target of ["docs/readme.md", "data:image/png;base64,AAAA", "javascript:alert(1)", "https://good.com@evil.com/", "@tool:zzzzzzz", "https://a.exa​mple/"]) {
        const base = highlight(`[x](${target})`, "markdown");
        assert.match(base, /hljs-link/, `fixture: hljs marks ${target} as a link`);
        const out = linkifyHtml(base, known);
        assert.match(out, /hljs-link hljs-link-dead/, target);
        assert.equal(anchors(out).length, 0, target);
    }
});

test("markdown raw view: a live link token is not marked dead, a dead one beside it is", () => {
    const out = linkifyHtml(highlight("[a](https://a.example/p) [b](nope.md)", "markdown"), known);
    assert.equal((out.match(/hljs-link-dead/g) || []).length, 1);
    assert.deepEqual(raws(out), ["https://a.example/p"]);
});

test("a dead mark is added only to an hljs-link span, in any language", () => {
    const html = '<span class="hljs-string">x</span>';
    assert.equal(linkifyHtml(html), html);
});

// --- the real components draw the links (wiring: each surface must pass `links`) ---

import { before } from "node:test";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { createRequire } from "node:module";
const require_ = createRequire(import.meta.url);

let h, render, doc, CodeRender, CodeDiff, ReplyBubble, DiffLines, SplitLines;

before(async () => {
    const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", { pretendToBeVisual: true });
    globalThis.window = dom.window;
    globalThis.document = dom.window.document;
    globalThis.Node = dom.window.Node;
    globalThis.NodeFilter = dom.window.NodeFilter;
    globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
    doc = dom.window.document;
    // preact through require, so it is the same instance the tsx components compile against
    ({ h, render } = require_("preact"));
    ({ CodeRender, CodeDiff } = await import("../src/sidebar/transcript/render-panel.tsx"));
    ({ ReplyBubble } = await import("../src/sidebar/transcript/reply.tsx"));
    ({ DiffLines, SplitLines } = await import("../src/sidebar/code-diff.tsx"));
});

// The gallery examples are the fixtures, read from the doc comments that define them, so the test and the screenshot
// cannot drift apart.
const galleryProps = (file, name) => {
    const line = readFileSync(new URL(`../src/sidebar/${file}`, import.meta.url), "utf8").split("\n").find((l) => l.includes(`@gallery ${name} {`));
    assert.ok(line, `@gallery ${name} exists in ${file}`);
    return JSON.parse(line.slice(line.indexOf("{", line.indexOf(`@gallery ${name}`))));
};
const mountEl = async (vnode) => {
    const host = doc.getElementById("root");
    render(null, host);
    render(vnode, host);
    await new Promise((r) => setTimeout(r, 40));
    return host;
};
const aText = (host) => [...host.querySelectorAll("a.out-link")].map((a) => a.textContent);
const inToken = (host, url) => [...host.querySelectorAll("a.out-link")].filter((a) => a.textContent === url).every((a) => a.parentElement.matches('span[class^="hljs-"]'));

const CODE = galleryProps("transcript/render-panel.tsx", "links in code");
const DIFF = galleryProps("transcript/render-panel.tsx", "diff view with links");

test("a code block links the address in a comment and in a string, inside their tokens, and nothing else", async () => {
    const host = await mountEl(h(CodeRender, CODE));
    assert.deepEqual(aText(host), ["https://example.com/docs/api", "https://example.com/v1/items?page=2"]);
    assert.ok(inToken(host, "https://example.com/docs/api") && host.querySelector(".hljs-comment a.out-link"));
    assert.ok(host.querySelector(".hljs-string a.out-link"));
    assert.match(host.textContent, /good\.com@evil\.com\/login/);
    assert.match(host.textContent, /javascript:alert\(1\)/);
});

for (const [name, comp] of [["unified diff", "diff"], ["split diff", "split"]]) {
    test(`a ${name} links the addresses of both sides and not javascript:`, async () => {
        const host = await mountEl(h(CodeDiff, { ...DIFF, view: comp, splitMinPx: 0 }));
        assert.ok(host.querySelector(comp === "split" ? ".dsplit" : ".dlines:not(.dsplit)"), `the ${comp} view is what drew`);
        const got = aText(host);
        assert.ok(got.includes("https://example.com/old") && got.includes("https://example.com/new"), JSON.stringify(got));
        assert.ok(host.querySelector(".hljs-comment a.out-link"));
        assert.ok(!got.some((t) => t.includes("javascript:")));
    });
}

test("DiffLines and SplitLines draw links only when lent them", async () => {
    const rows = [{ kind: "add", text: "// https://a.example/x", a: 0, b: 1 }];
    const links = { step: () => null, open() {}, jump() {}, tip: () => ({}) };
    for (const C of [DiffLines, SplitLines]) {
        assert.equal((await mountEl(h(C, { rows, lang: "javascript", links }))).querySelectorAll("a.out-link").length, 1, C.name);
        assert.equal((await mountEl(h(C, { rows, lang: "javascript" }))).querySelectorAll("a.out-link").length, 0, C.name);
    }
});

// --- the raw view of an answer ---

test("the raw answer view links an image's address and strips the underline of a relative link target", async () => {
    const host = await mountEl(h(ReplyBubble, { content: "![label](https://a.example/i.png)\n\n[x](docs/readme.md)", status: "ok", model: "m", profile: null, ts: 1760000000000, initialRaw: true }));
    assert.deepEqual(aText(host), ["https://a.example/i.png"]);
    const spans = [...host.querySelectorAll(".hljs-link")];
    const dead = spans.filter((s) => s.classList.contains("hljs-link-dead"));
    assert.deepEqual(dead.map((s) => s.textContent), ["docs/readme.md"]);
    assert.ok(spans.some((s) => s.querySelector("a.out-link")), "the live target is not dead");
});

// --- the delegated click and key handlers ---

const { codeLinkHandlers } = await import("../src/sidebar/code-links.ts");
const fake = () => {
    const calls = [];
    return { calls, links: {
        step: (id) => id === "abc1234" ? { seq: 7, tip: "step 7" } : null,
        open: (u) => calls.push(["open", u]), jump: (s, slot) => calls.push(["jump", s, slot]), tip: () => ({}),
    } };
};
const anchorOf = (html) => { const el = doc.createElement("div"); el.innerHTML = html; return el.querySelector("a"); };
const fire = (handler, a, init = {}) => { let prevented = false; handler({ target: a, key: init.key, preventDefault: () => { prevented = true; } }); return prevented; };

test("a click on a linkified address opens the decoded address once; on a pointer it jumps to the step and slot", () => {
    const { calls, links } = fake();
    const on = codeLinkHandlers(links);
    const [url] = [anchorOf(linkifyHtml("see https://a.example/?q=1&amp;r=2 now"))];
    assert.equal(fire(on.onClick, url), true);
    assert.deepEqual(calls, [["open", "https://a.example/?q=1&r=2"]]);
    calls.length = 0;
    const ptr = anchorOf(linkifyHtml("@tool:abc1234:in", (id) => id === "abc1234"));
    fire(on.onClick, ptr);
    assert.deepEqual(calls, [["jump", 7, "in"]]);
});

test("a hand-made anchor opens nothing: a look-alike address, a pointer naming no step, a non-anchor", () => {
    const { calls, links } = fake();
    const on = codeLinkHandlers(links);
    for (const html of ['<a class="out-link" data-raw="https://good.com@evil.com/">x</a>', '<a class="out-link" data-raw="javascript:alert(1)">x</a>',
        '<a class="out-link" data-raw="https://a.example/ https://b.example/">x</a>', '<a class="out-link" data-ptr="zzzzzzz">x</a>', '<a class="out-link">x</a>']) {
        fire(on.onClick, anchorOf(html));   // a pointer anchor may swallow the click; what matters is that nothing was called
        fire(on.onKeyDown, anchorOf(html), { key: "Enter" });
    }
    assert.deepEqual(calls, []);
    fire(on.onClick, doc.createElement("span"));
    assert.deepEqual(calls, []);
});

test("Enter on a pointer anchor jumps; another key, and Enter on an address anchor, do nothing", () => {
    const { calls, links } = fake();
    const on = codeLinkHandlers(links);
    const ptr = anchorOf(linkifyHtml("@tool:abc1234", (id) => id === "abc1234"));
    fire(on.onKeyDown, ptr, { key: "a" });
    assert.deepEqual(calls, []);
    fire(on.onKeyDown, ptr, { key: "Enter" });
    assert.deepEqual(calls, [["jump", 7, undefined]]);
    calls.length = 0;
    fire(on.onKeyDown, anchorOf(linkifyHtml("https://a.example/")), { key: "Enter" });
    assert.deepEqual(calls, []);
});
