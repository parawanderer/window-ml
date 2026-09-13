// Code themes (src/code-themes.ts): the VS Code → highlight.js converter, and the bundled presets.
// The converter is the part that can be wrong quietly — a theme that "loads" but colours the wrong tokens — so
// what is pinned is TextMate's own precedence, and that nothing from an uploaded file reaches CSS verbatim.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { parseJsonc, convertVscodeTheme, hljsBaseColors, CODE_THEME_PRESETS, presetFile, DEFAULT_CODE_THEME, SCOPE_MAP } from "../src/code-themes.ts";

const rule = (scope, foreground, fontStyle) => ({ scope, settings: { foreground, ...(fontStyle != null ? { fontStyle } : {}) } });
const colorOf = (css, cls) => new RegExp(`\\.${cls.replace(".", "\\.")}\\{color:(#[0-9a-f]+)`).exec(css)?.[1];

test("JSONC: comments and trailing commas are allowed, and a `//` inside a string is kept", () => {
    const text = `{
        // a line comment
        "name": "Mine", /* a block
        comment */ "url": "https://example.com/x",
        "tokenColors": [ { "scope": "comment", "settings": { "foreground": "#aaaaaa", }, }, ],
    }`;
    const t = parseJsonc(text);
    assert.equal(t.name, "Mine");
    assert.equal(t.url, "https://example.com/x");
    assert.equal(t.tokenColors.length, 1);
});

test("the MORE SPECIFIC scope wins, and a later rule wins a tie — TextMate's precedence", () => {
    const c = convertVscodeTheme({ colors: { "editor.background": "#101010" }, tokenColors: [
        rule("keyword.control", "#ff0000"),
        rule("keyword", "#00ff00"),            // less specific, even though later
        rule("string", "#111111"),
        rule("string", "#222222"),            // same selector, later: wins
    ] });
    assert.equal(colorOf(c.css, "hljs-keyword"), "#ff0000");
    assert.equal(colorOf(c.css, "hljs-string"), "#222222");
});

test("a class falls back along its scopes, and a parent-scope selector is not applied everywhere", () => {
    const c = convertVscodeTheme({ tokenColors: [
        rule("storage.type", "#0000ff"),                               // no keyword rule at all
        rule("meta.function-call entity.name.function", "#ff00ff"),     // only in a call context — skipped
        rule("entity.name.function", "#00ffff"),
    ] });
    assert.equal(colorOf(c.css, "hljs-keyword"), "#0000ff", "keywords take storage.type when there is nothing better");
    assert.equal(colorOf(c.css, "hljs-title.function_"), "#00ffff", "the context-free rule, not the call-site one");
});

test("comma-separated and array scopes both work, and font styles come through", () => {
    const c = convertVscodeTheme({ tokenColors: [
        rule("comment, string.comment", "#777777", "italic"),
        rule(["constant.numeric", "constant.language"], "#aa00aa", "bold underline"),
    ] });
    assert.match(c.css, /\.hljs-comment\{color:#777777;font-style:italic\}/);
    assert.match(c.css, /\.hljs-number\{color:#aa00aa;font-weight:bold;text-decoration:underline\}/);
});

test("nothing from the file reaches the stylesheet unless it is a hex colour or a known font style", () => {
    const c = convertVscodeTheme({ name: "x}</style><script>", colors: { "editor.background": "red;} body{display:none" }, tokenColors: [
        rule("comment", "#fff;} .hljs{background:url(//evil)"),
        rule("string", "rgb(1,2,3)"),
        rule("keyword", "#123456", "italic; background: url(//evil)"),
    ] });
    assert.doesNotMatch(c.css, /evil|display:none|script|rgb\(/);
    assert.equal(colorOf(c.css, "hljs-comment"), undefined, "a colour with a payload is dropped, not truncated");
    assert.match(c.css, /\.hljs-keyword\{color:#123456;font-style:italic\}/, "the valid parts of a rule survive");
    assert.match(c.css, /\.hljs\{color:#d4d4d4;background:#1e1e1e\}/, "an unusable background falls back to the default");
});

test("dark or light: the theme's own `type` wins, else the background's luminance decides", () => {
    assert.equal(convertVscodeTheme({ type: "light", colors: { "editor.background": "#000000" } }).type, "light");
    assert.equal(convertVscodeTheme({ colors: { "editor.background": "#fdf6e3" } }).type, "light");
    assert.equal(convertVscodeTheme({ colors: { "editor.background": "#002b36" } }).type, "dark");
    const light = convertVscodeTheme({ type: "light", tokenColors: [rule("comment", "#999999")] });
    assert.equal(light.bg, "#ffffff", "a light theme with no background gets a light default");
});

test("an old-style theme's global rule supplies the default text and background", () => {
    const c = convertVscodeTheme({ tokenColors: [{ settings: { foreground: "#cccccc", background: "#202020" } }, rule("comment", "#666666")] });
    assert.equal(c.fg, "#cccccc");
    assert.equal(c.bg, "#202020");
});

test("it reports what it could and could not colour, and names the theme", () => {
    const c = convertVscodeTheme({ name: "Tiny", tokenColors: [rule("comment", "#666666")] }, "tiny.json");
    assert.equal(c.name, "Tiny");
    assert.ok(c.matched.includes("hljs-comment") && c.matched.includes("hljs-quote"));
    assert.ok(c.missing.includes("hljs-keyword"));
    assert.equal(c.matched.length + c.missing.length, Object.keys(SCOPE_MAP).length);
    assert.equal(convertVscodeTheme({ tokenColors: [rule("comment", "#666666")] }, "tiny.json").name, "tiny.json");
});

test("a file that is not a colour theme is refused with the reason", () => {
    assert.throws(() => convertVscodeTheme({ include: "./dark_vs.json" }), /not a VS Code colour theme/);
    assert.throws(() => convertVscodeTheme([1, 2]), /not a VS Code colour theme|not a VS Code theme/);
    assert.throws(() => parseJsonc("{ nope"), SyntaxError);
});

// EVERY preset, not a sample: each one's stylesheet must exist, and must declare the background and text colour
// its code surfaces are painted with — a preset missing either would draw light tokens on the panel's white.
const STYLES = path.resolve(import.meta.dirname, "../node_modules/highlight.js/styles");
test("every preset's files exist and declare a background and a text colour", () => {
    const ids = new Set();
    for (const p of CODE_THEME_PRESETS) {
        assert.ok(!ids.has(p.id), `${p.id} is listed once`); ids.add(p.id);
        assert.ok(p.dark || p.light, `${p.id} has a variant`);
        for (const file of [p.dark, p.light].filter(Boolean)) {
            const css = fs.readFileSync(path.join(STYLES, `${file}.css`), "utf8");
            const { bg, fg } = hljsBaseColors(css);
            assert.ok(bg, `${file}: a background`);
            assert.ok(fg, `${file}: a text colour`);
        }
    }
    assert.equal(CODE_THEME_PRESETS[0].id, DEFAULT_CODE_THEME);
});

test("a preset follows the panel where it can, and an unknown id is the default", () => {
    assert.equal(presetFile("github", "dark").file, "github-dark");
    assert.equal(presetFile("github", "light").file, "github");
    assert.equal(presetFile("nord", "light").file, "nord", "a dark-only theme is used as it is in a light panel");
    assert.equal(presetFile("xcode", "dark").file, "xcode");
    assert.equal(presetFile("gone-in-a-later-version", "dark").preset.id, DEFAULT_CODE_THEME);
});
