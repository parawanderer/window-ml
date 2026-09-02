// The ladder's PRESENTATION (sidebar/fetch-ladder.ts) — shared by the sidebar's DOM tree and both export
// sinks, so the two views cannot drift. Pure.
import { test } from "node:test";
import assert from "node:assert";
import { ladderLines, rungLabel, rungMeta, bytes, RUNG_LABEL, RESOLVED_LABEL, GLYPH } from "../sidebar/fetch-ladder.ts";

const A = (o) => ({ strategy: "accept", url: "https://d.test/x", outcome: "hit", ...o });

test("rungLabel: the URL for rungs that fetched a different one, the rung's NAME otherwise", () => {
    // `accept` re-requests the SAME url and `convert` fetches nothing, so a URL there tells the reader nothing.
    assert.equal(rungLabel(A({ strategy: "accept" })), RUNG_LABEL.accept);
    assert.equal(rungLabel(A({ strategy: "convert" })), RUNG_LABEL.convert);
    assert.equal(rungLabel(A({ strategy: "sibling", url: "https://d.test/x.md" })), "https://d.test/x.md");
    assert.equal(rungLabel(A({ strategy: "declared", url: "https://d.test/api?p=/x" })), "https://d.test/api?p=/x");
    // A rung that never ran has no URL — fall back to the name rather than printing an empty cell.
    assert.equal(rungLabel(A({ strategy: "sibling", url: "", outcome: "skipped" })), RUNG_LABEL.sibling);
});

test("rungMeta: omits whatever the rung didn't produce", () => {
    assert.equal(rungMeta(A({ status: 200, contentType: "text/markdown; charset=utf-8", bytes: 9107, ms: 61 })),
        "200 · text/markdown · 8.9 KB · 61 ms", "the charset is noise here");
    assert.equal(rungMeta(A({ outcome: "skipped" })), "", "a skipped rung has no numbers to show");
    assert.equal(rungMeta(A({ status: 404 })), "404");
});

test("bytes: readable sizes", () => {
    assert.equal(bytes(512), "512 B");
    assert.equal(bytes(9107), "8.9 KB");
    assert.equal(bytes(365465), "356.9 KB");
    assert.equal(bytes(undefined), "");
});

test("ladderLines: every rung is drawn, the last one closes the tree, and the footer names the winner", () => {
    const lines = ladderLines([
        { strategy: "accept", url: "https://bun.sh/docs/installation", status: 200, contentType: "text/html", bytes: 190610, ms: 84, outcome: "not-markdown" },
        { strategy: "declared", url: "", outcome: "skipped", note: "the page declares none" },
        { strategy: "sibling", url: "https://bun.sh/docs/installation.md", status: 200, contentType: "text/markdown", bytes: 9107, ms: 61, outcome: "hit" },
        { strategy: "convert", url: "", outcome: "skipped", note: "not used" },
    ], "sibling");
    assert.equal(lines.length, 5, "four rungs + the resolved-by footer");
    assert.ok(lines[0].startsWith("├─ ✗"), "a miss");
    assert.ok(lines[2].startsWith("├─ ✓"), "the hit");
    assert.ok(lines[3].startsWith("└─ ·"), "the last rung closes the tree, and unused rungs are still drawn");
    assert.match(lines[2], /installation\.md\s+200 · text\/markdown · 8\.9 KB · 61 ms/);
    assert.match(lines[4], /resolved by {2}its \.md URL/);
    // Nothing to draw when negotiation never ran (format:"html", or a data body).
    assert.deepEqual(ladderLines(undefined, undefined), []);
    assert.deepEqual(ladderLines([], "accept"), []);
});

test("the label maps cover every strategy and outcome the contract allows", () => {
    for (const s of ["accept", "declared", "sibling", "convert"]) {
        assert.ok(RUNG_LABEL[s], `no rung label for ${s}`);
        assert.ok(RESOLVED_LABEL[s], `no resolved label for ${s}`);
    }
    for (const o of ["hit", "not-markdown", "error", "skipped"]) assert.ok(GLYPH[o], `no glyph for ${o}`);
    // The winner's name must say whose Markdown it is — the whole point of showing the tree.
    assert.match(RESOLVED_LABEL.convert, /OUR reduction/);
});
