// output-links.test.mjs — which parts of a line of tool output become links (src/sidebar/output-links.ts). Pure: no DOM.
// The rendered half (anchor, tip, click) is in tests/output-cell.test.mjs.
import { test } from "node:test";
import assert from "node:assert";

const { outputLinks, hasOutputLink, outputLinkTip, MAX_LINK_CHARS } = await import("../src/sidebar/output-links.ts");
const urls = (line) => outputLinks(line).filter((s) => typeof s !== "string").map((s) => s.url);
const texts = (line) => outputLinks(line).filter((s) => typeof s !== "string").map((s) => s.text);

// --- the scheme allowlist ---

test("http and https become links; every other scheme stays text", () => {
    assert.deepEqual(urls("http://a.example/x"), ["http://a.example/x"]);
    assert.deepEqual(urls("see HTTPS://A.example/x"), ["https://a.example/x"]);
    for (const bad of ["javascript:alert(1)", "data:text/html,<b>x", "file:///etc/passwd", "chrome-extension://abc/x.html",
        "window-ml:setting/apiKey", "ftp://a.example/x", "vbscript:x"])
        assert.deepEqual(outputLinks(bad), [bad], bad);
});

test("a scheme glued to a word does not count, and an http URL after another scheme still does", () => {
    assert.deepEqual(outputLinks("xhttps://a.example/"), ["xhttps://a.example/"]);
    assert.deepEqual(urls("javascript:void(0)//https://a.example/"), ["https://a.example/"]);
    assert.deepEqual(urls("blob:https://a.example/uuid"), ["https://a.example/uuid"], "the https address inside is the one a click opens, and the tip names it");
});

// --- boundaries and trailing punctuation ---

test("a URL stops at whitespace, quotes, angle brackets and a backtick", () => {
    assert.deepEqual(texts('go https://a.example/x now'), ["https://a.example/x"]);
    assert.deepEqual(texts('"https://a.example/x"'), ["https://a.example/x"]);
    assert.deepEqual(texts("'https://a.example/x'"), ["https://a.example/x"]);
    assert.deepEqual(texts("<https://a.example/x>"), ["https://a.example/x"]);
    assert.deepEqual(texts("`https://a.example/x`"), ["https://a.example/x"]);
});

test("sentence punctuation after a URL is not part of it", () => {
    for (const p of [".", ",", ";", ":", "!", "?", ")", "]", "}", "'", '"', "...", ".)", "?!"])
        assert.deepEqual(texts(`https://a.example/x${p}`), ["https://a.example/x"], JSON.stringify(p));
    assert.deepEqual(outputLinks("(https://a.example/x)")[2], ")");
});

test("a closer is kept when a bracket inside the URL opened it", () => {
    assert.deepEqual(texts("https://en.wikipedia.org/wiki/Foo_(bar)"), ["https://en.wikipedia.org/wiki/Foo_(bar)"]);
    assert.deepEqual(texts("(see https://en.wikipedia.org/wiki/Foo_(bar))"), ["https://en.wikipedia.org/wiki/Foo_(bar)"]);
    assert.deepEqual(texts("https://en.wikipedia.org/wiki/Foo_(bar)."), ["https://en.wikipedia.org/wiki/Foo_(bar)"]);
    assert.deepEqual(texts("https://a.example/x[0]"), ["https://a.example/x[0]"]);
    assert.deepEqual(texts("https://a.example/x[0]]"), ["https://a.example/x[0]"]);
});

test("several URLs on one line, with the text between them kept in order", () => {
    assert.deepEqual(outputLinks("a https://one.example/1, b http://two.example/2; c").map((s) => typeof s === "string" ? s : s.host),
        ["a ", "one.example", ", b ", "two.example", "; c"]);
    assert.equal(outputLinks("https://a.example/ https://b.example/").length, 3);
});

test("text with no URL comes back as the very same string, and a refused URL leaves the line whole", () => {
    for (const l of ["", "plain text", "a://b but not http", "https:// nothing"]) assert.deepEqual(outputLinks(l), [l], l);
    const bad = "x https://good.com@evil.com/ y";
    assert.deepEqual(outputLinks(bad), [bad]);
    assert.equal(hasOutputLink("a\nb\nc"), false);
    assert.equal(hasOutputLink("a\nhttps://a.example/\nc"), true);
    assert.equal(hasOutputLink(bad), false);
});

// --- what stays text, and why ---

test("userinfo stays text, whatever it looks like", () => {
    for (const u of ["https://good.com@evil.com/", "https://user:pw@a.example/", "https://good.com:443@evil.com/", "http://@a.example/", "https://a.example@/"])
        assert.deepEqual(urls(u), [], u);
    assert.deepEqual(urls("https://a.example/path@x"), ["https://a.example/path@x"], "an @ in the path is not userinfo");
});

test("a backslash stays text: the parser reads it as a slash, so what is shown and what is opened could differ", () => {
    assert.deepEqual(urls("https://evil.com\\@good.com/"), []);
});

test("a non-ASCII host stays text, so the host field is only ever ASCII", () => {
    for (const u of ["https://exаmple.com/", "https://münchen.example/", "https://例え.jp/", "https://a.example\u00e9/"])
        assert.deepEqual(urls(u), [], u);
    assert.deepEqual(urls("https://xn--mnchen-3ya.example/"), ["https://xn--mnchen-3ya.example/"]);
    assert.equal(outputLinks("https://xn--mnchen-3ya.example/")[0].host, "xn--mnchen-3ya.example");
});

test("bidi controls and zero-width or format characters stay text, in the host or anywhere in the URL", () => {
    for (const c of ["\u200b", "\u200c", "\u200d", "\u200e", "\u200f", "\u202a", "\u202e", "\u2066", "\u2069", "\u00ad", "\u2060"]) {
        assert.deepEqual(urls(`https://good${c}.example/`), [], `host U+${c.codePointAt(0).toString(16)}`);
        assert.deepEqual(urls(`https://a.example/x${c}y`), [], `path U+${c.codePointAt(0).toString(16)}`);
    }
});

test("U+FEFF counts as whitespace to the scanner, so a URL ends before it and what is shown is what is opened", () => {
    assert.deepEqual(urls("https://good\ufeff.evil.example/"), ["https://good/"]);
});

test("an unparseable URL stays text", () => {
    for (const u of ["https://", "https://a.example:99999/", "http://[::1/", "https://%/", "https://a.example:port/"])
        assert.deepEqual(urls(u), [], u);
});

test("a URL past the length cap stays text; one at the cap is a link", () => {
    assert.equal(MAX_LINK_CHARS, 2048);
    const head = "https://a.example/";
    assert.equal(urls(head + "x".repeat(MAX_LINK_CHARS - head.length)).length, 1);
    assert.equal(urls(head + "x".repeat(MAX_LINK_CHARS - head.length + 1)).length, 0);
});

// --- what a link carries ---

test("the host is the parser's, lower-cased, with the port dropped and an IPv6 literal bracketed", () => {
    assert.equal(outputLinks("https://EXAMPLE.com:8443/p")[0].host, "example.com");
    assert.equal(outputLinks("http://[::1]:3000/")[0].host, "[::1]");
    assert.equal(outputLinks("https://a.example")[0].url, "https://a.example/", "url is the normalised href; text is as printed");
    assert.equal(outputLinks("https://a.example")[0].text, "https://a.example");
});

test("the tip names the host first and cuts the address", () => {
    const [l] = outputLinks("https://example.com/" + "p".repeat(200));
    const tip = outputLinkTip(l);
    assert.ok(tip.startsWith("Opens example.com in a new tab · https://example.com/"));
    assert.ok(tip.endsWith("…") && tip.length < 130);
    assert.equal(outputLinkTip(outputLinks("https://example.com/a")[0]), "Opens example.com in a new tab · https://example.com/a");
});
