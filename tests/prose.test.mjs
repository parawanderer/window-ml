// MODEL PROSE (src/sidebar/prose.tsx) — the short runs of text a model writes about its own work: a margin
// note, a retry's claim. What it renders matters less than what it REFUSES to, and this file is mostly the
// refusals: every one of them was a deliberate call, and every one would be easy to lose to a "just use the
// markdown renderer" change six months from now.
import { test } from "node:test";
import assert from "node:assert";
import { splitProse } from "../src/sidebar/prose.tsx";

const kinds = (parts) => parts.map((p) => ("text" in p ? `t:${p.text}` : `p:${p.id}${p.slot ? ":" + p.slot : ""}`));

test("prose with no pointer is one text run — byte-identical, so nothing pays for the feature", () => {
    assert.deepEqual(splitProse("renamed from `total`, same arithmetic"), [{ text: "renamed from `total`, same arithmetic" }]);
});

test("a pointer link is split out, with the text either side kept in order", () => {
    assert.deepEqual(kinds(splitProse("as in [the totals](@tool:abc1234), but yearly")),
        ["t:as in ", "p:abc1234", "t:, but yearly"]);
});

test("a SLOT rides along, so a citation can land on the code rather than the top of a tall step", () => {
    assert.deepEqual(kinds(splitProse("see [the script](@tool:abc1234:in)")), ["t:see ", "p:abc1234:in"]);
    assert.deepEqual(kinds(splitProse("see [what it printed](@tool:abc1234:out)")), ["t:see ", "p:abc1234:out"]);
});

test("a TOOL-NAME alias is a pointer too — the model writes what it remembers", () => {
    assert.deepEqual(kinds(splitProse("[the last run](@tool:python_exec)")), ["p:python_exec"]);
});

test("several in one sentence, and adjacent ones, all come out in order", () => {
    assert.deepEqual(kinds(splitProse("[a](@tool:aaa1111) then [b](@tool:bbb2222).")),
        ["p:aaa1111", "t: then ", "p:bbb2222", "t:."]);
    assert.deepEqual(kinds(splitProse("[a](@tool:aaa1111)[b](@tool:bbb2222)")), ["p:aaa1111", "p:bbb2222"]);
});

test("an EXTERNAL link is NOT a pointer — it stays text, and stays a whole run", () => {
    // The refusal that matters most: a model-authored link out of a debug panel is a one-click egress the
    // reader did not ask for, in chrome they trust, and markdown lets the text and the href disagree.
    const parts = splitProse("see [the pandas docs](https://pandas.pydata.org/) for this");
    assert.equal(parts.length, 1);
    assert.match(parts[0].text, /\[the pandas docs\]\(https:/, "kept verbatim, to be rendered as the text it is");
});

test("an IMAGE is not a pointer either, however it is spelled", () => {
    // These surfaces are gutters and tooltips — places with no room — and a tool result could put pixels in
    // one. `![x](@tool:…)` is the embed syntax the ANSWER renderer honours; here it stays text.
    for (const src of ["![shot](@tool:abc1234)", "![shot](https://x/y.png)", "![shot](data:image/png;base64,AA)"]) {
        const parts = splitProse(src);
        assert.equal(parts.length, 1, `one text run for ${src}`);
        assert.ok("text" in parts[0]);
    }
});

test("a bare pointer with no link syntax is left alone", () => {
    // `@tool:abc1234` on its own is a REFERENCE the reader can copy, not a link the model asked for. Turning
    // every mention into a control would make prose about pointers unreadable.
    assert.deepEqual(splitProse("read it back with @tool:abc1234"), [{ text: "read it back with @tool:abc1234" }]);
});

test("a malformed link is text, not a half-parsed control", () => {
    for (const src of ["[unclosed](@tool:abc1234", "[](@tool:abc1234)", "[label](@tool:)", "[a\nb](@tool:abc1234)"]) {
        const parts = splitProse(src);
        assert.ok(parts.every((p) => "text" in p), `no pointer parsed from ${JSON.stringify(src)}`);
    }
});
