// redteam-output-links.test.mjs — the output-link renderer (src/sidebar/output-links.ts, `LinkedLine`/`PlainOutput`)
// attacked with what a hostile PROGRAM can print (docs/dev/output-and-code.md, "An http(s) address in output is a
// link"). The property: the text is drawn as it was printed, an anchor appears only where the printed text and the
// destination agree, the tip always names the host the browser will connect to, and nothing downstream changes.
//
// The lane's rows (tests/output-links.test.mjs, tests/output-cell.test.mjs, tests/sidebar-answer.test.js) hold the
// scheme allowlist, the boundaries, userinfo, backslash, non-ASCII hosts, format characters, U+FEFF, the cap, the tip,
// the click and the embedded-by-pointer paths. These hold the shapes their lists do not take: hosts the parser
// rewrites (punycode, percent-encoding, a numeric IPv4), the concatenation invariant every line must keep, the
// behaviour of a C0 control in the path, and the export side.

import { test } from "node:test";
import assert from "node:assert/strict";

const { outputLinks, hasOutputLink, outputLinkTip, MAX_LINK_CHARS } = await import("../src/sidebar/output-links.ts");
const links = (line) => outputLinks(line).filter((s) => typeof s !== "string");
const urls = (line) => links(line).map((s) => s.url);

// --- what every line must keep, whatever is in it ---

test("RED TEAM: the rendered text is the printed text, exactly, for every hostile shape", () => {
    // The anchor is drawn over the same characters; the copy button, the in-cell find and both exports read the string.
    // So the segments must concatenate back to the line, character for character, whatever a program printed.
    const hostile = [
        "xhttps://a.example/", "javascript:alert(1)", "data:text/html,<b>x</b> https://a.example/",
        "https://good.com@evil.com/", "https://a.example\\@b.example/", "https://а\u{456}\u{456}le.example/",
        "https://a.example/‮evil", "https://a.example/​", "https://a.example.﻿/path",
        "https://2130706433/", "https://%65vil.example/", "blob:https://a.example/uuid",
        "a\u0085b https://a.example/x", "https://" + "a".repeat(MAX_LINK_CHARS) + "/x",
    ];
    for (const line of hostile) {
        const seg = outputLinks(line);
        assert.equal(seg.map((s) => (typeof s === "string" ? s : s.text)).join(""), line, `the text changed: ${JSON.stringify(line.slice(0, 60))}`);
    }
});

// --- hosts the parser rewrites ---

test("RED TEAM: a mixed-script host stays text, and an xn-- host links only to the name the browser resolves", () => {
    // Cyrillic а in "аpple": the printed name and the resolved name differ, so it stays text (the lane's non-ASCII rule).
    const homograph = "https://аpple.example/login";
    assert.deepEqual(outputLinks(homograph), [homograph], "a mixed-script host was linked");
    // Punycode is the same class of difference, and the renderer's answer is the TIP: the anchor's text is what was
    // printed, and the tooltip's first words are the parser's host, which IS what the browser connects to.
    const [l] = links("see https://xn--80ak6aa92e.example/x");
    assert.ok(l, "an xn-- host was not linked at all");
    assert.equal(l.host, "xn--80ak6aa92e.example");
    assert.ok(outputLinkTip(l).startsWith(`Opens ${l.host} `), outputLinkTip(l));
    assert.equal(new URL(l.url).host, l.host, "the tip names a different host than the destination");
});

test("RED TEAM: a percent-encoded host links only as the parser reads it, and the tip says so", () => {
    // `%65vil` is `evil` to every URL parser: what is printed and what is resolved differ, so the tip is the disclosure.
    // The property to hold is the tip, not the refusal: a link made from such a host must never be tipped with `%65vil`.
    const [l] = links("go https://%65vil.example/a");
    if (!l) return;   // refused by the scanner: the stricter answer, and the lane's parse-failure row covers the class
    assert.equal(l.host, new URL(l.url).hostname, "the tip's host is not the parser's");
    assert.ok(!l.host.includes("%"), `the host field kept the escaped form: ${l.host}`);
    assert.ok(outputLinkTip(l).startsWith(`Opens ${l.host} `), outputLinkTip(l));
});

test("RED TEAM: a numeric IPv4-looking host is tipped with the address the browser resolves", () => {
    // `2130706433` is 127.0.0.1 to the WHATWG parser. Whatever the parser decides, the tip must carry that, never the
    // printed digits alone, or a click would reach a host the person never read.
    const [l] = links("open https://2130706433/ now");
    if (!l) return;   // refused: also safe
    assert.equal(l.host, new URL(l.url).hostname);
    assert.ok(outputLinkTip(l).startsWith(`Opens ${l.host} `), `a numeric host was tipped as its printed form: ${outputLinkTip(l)}`);
});

test("RED TEAM: a backslash, a tab, a line separator or a newline never becomes part of a link", () => {
    for (const bad of ["https://a.example\\@b.example/x", "https://a.example\t/x", "https://a.example/\u2028", "https://a.example/\n"]) {
        for (const l of links(bad)) {
            assert.ok(!l.text.includes("\\") && !/[\t\n\u2028\u2029]/.test(l.text), `a control or backslash reached the anchor text: ${JSON.stringify(l)}`);
            assert.ok(!l.url.includes("\\") && !/[\t\n\u2028\u2029]/.test(l.url), `a control or backslash reached the destination: ${JSON.stringify(l)}`);
        }
    }
});

test("RED TEAM: a C0 control or DEL anywhere in the URL keeps it text", () => {
    // The coordinator's ruling on #2067: a C0 control or DEL is a character a reader cannot see, in a place the parser
    // normalises, so the printed text and the destination are two different strings by construction. Refused as a class
    // beside the backslash check. TAB, LF and CR are excluded from the refusal because the scanner ALREADY ends the
    // address at them (they are whitespace), which the boundary row holds; they are asserted below to never enter a link.
    const REFUSED = ["\u0000", "\u0001", "\u0007", "\u001b", "\u001f", "\u007f"];
    for (const c of REFUSED) {
        for (const where of [`https://a.example/x${c}y`, `https://a.example/x?q=${c}y`, `https://a.example/x#${c}y`, `https://a.example/x/${c}`]) {
            assert.deepEqual(outputLinks(where), [where], `a C0 control (U+${c.charCodeAt(0).toString(16).padStart(4, "0")}) was linked in ${JSON.stringify(where)}`);
        }
    }
    for (const c of ["\u0009", "\u000a", "\u000d"]) {
        for (const where of [`https://a.example/x${c}y`, `https://a.example/x?q=${c}y`]) {
            for (const l of links(where)) {
                assert.ok(!l.text.includes(c) && !l.url.includes(c), `whitespace control U+${c.charCodeAt(0).toString(16)} entered a link: ${JSON.stringify(l)}`);
            }
        }
    }
});

// --- the cap, on both sides ---

test("RED TEAM: at the cap the line holds an anchor; one past it holds none, and the text is the same either way", () => {
    const base = "https://a.example/";
    const at = base + "x".repeat(MAX_LINK_CHARS - base.length);
    const over = base + "x".repeat(MAX_LINK_CHARS - base.length + 1);
    assert.equal(links(at).length, 1, "a URL at the cap was not linked");
    assert.equal(links(over).length, 0, "a URL past the cap was linked");
    assert.equal(outputLinks(over)[0], over, "the over-cap line is not the very string");
});

// --- nothing downstream changes ---

test("RED TEAM: no export reads the renderer, and the renderer never changes the string it is given", async () => {
    // The rule is "rendering only": the anchor is drawn over characters, and both exports read the session object, never
    // the DOM. A source-structure row pins that where a live export row cannot: the export modules load the sidebar's
    // CSS through its bundler, and this suite's realm has no loader for that.
    const { readdirSync, readFileSync } = await import("node:fs");
    const dir = new URL("../src/sidebar/export/", import.meta.url);
    const files = readdirSync(dir).filter((f) => /\.tsx?$/.test(f));
    assert.ok(files.length >= 2, "positive control: the export modules were found");
    for (const f of files) {
        const src = readFileSync(new URL(f, dir), "utf8");
        assert.ok(!/from\s+["'][^"']*(output-links|render-panel)["']/.test(src) && !/class="out-link"/.test(src), `${f} imports or draws the link renderer`);
    }
    // And the scanner is pure: the input string is unchanged, and a line with no link is the very same string.
    const line = "open https://a.example/x?q=1 now";
    const before = line.slice();
    outputLinks(line);
    assert.equal(line, before);
    assert.deepEqual(outputLinks("no address here"), ["no address here"]);
    assert.equal(hasOutputLink("no address here"), false);
    assert.equal(urls("open https://a.example/x?q=1 now").length, 1, "positive control: a link is found");
});
