// settings-search.test.mjs — filtering the Settings panel to the rows matching a query (src/sidebar/settings-search.ts),
// against a hand-built body shaped like the real one: tab headings, collapsible sections and loose rows, each row
// followed by its help text.
import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { filterSettings, queryWords, MISS } from "../src/sidebar/settings-search.ts";

const BODY = `
<div class="set-search-tab">Connection</div>
<div class="set-note">Point this at OpenWebUI.</div>
<label class="set-field"><span>Chat completions URL</span><input></label>
<div class="set-hint">OpenWebUI: /api/chat/completions</div>
<label class="set-field"><span>API key</span><input></label>
<div class="set-search-tab">Appearance</div>
<details class="set-section" open><summary>Storage</summary>
  <label class="set-field"><span>Retention (days)</span><input></label>
  <div class="set-hint">A saved session that has done nothing for this many days is deleted.</div>
  <label class="set-field"><span>Saved session storage (MB)</span><input></label>
</details>
<details class="set-section" open><summary>Agent HUD</summary>
  <label class="set-field"><span>Card corner</span><select><option>Bottom right</option></select></label>
</details>`;

const body = () => {
    const doc = new JSDOM(`<div id="b">${BODY}</div>`).window.document;
    return doc.getElementById("b");
};
const hidden = (root) => [...root.querySelectorAll(`.${MISS}`)].map((e) => (e.querySelector("span, summary")?.textContent || e.textContent).trim().slice(0, 24));
const shown = (root, sel) => [...root.querySelectorAll(sel)].filter((e) => !e.closest(`.${MISS}`)).map((e) => e.textContent.trim());

// --- what one row is, and what a query has to find in it ---

test("a row matches on its HELP text too, and the help text stays with its field", () => {
    const b = body();
    assert.equal(filterSettings(b, "deleted"), 1);
    assert.deepEqual(shown(b, ".set-field > span"), ["Retention (days)"]);
    assert.ok(!b.querySelector(".set-section .set-hint").classList.contains(MISS), "the hint that matched is shown with its field");
    assert.ok(b.querySelector(".set-search-tab:nth-of-type(1)").classList.contains(MISS), "a tab with nothing left loses its heading");
});

test("every word must appear, in any order, and the section and tab names count", () => {
    const b = body();
    assert.equal(filterSettings(b, "storage"), 2, "the section is named Storage, so both of its rows match… ");
    assert.equal(filterSettings(b, "mb saved"), 1, "…while two words found only in one row find that row");
    assert.deepEqual(shown(b, ".set-field > span"), ["Saved session storage (MB)"]);
    assert.equal(filterSettings(b, "appearance corner"), 1, "the tab's own name narrows like any other word");
    assert.equal(filterSettings(b, "corner zebra"), 0);
});

test("a section whose title matches shows whole; a section with no match hides, and so does its tab heading", () => {
    const b = body();
    filterSettings(b, "hud");
    assert.deepEqual(shown(b, ".set-field > span"), ["Card corner"]);
    assert.ok(b.querySelectorAll("details")[0].classList.contains(MISS), "the Storage section had nothing");
    assert.ok(!b.querySelectorAll("details")[1].classList.contains(MISS));
    assert.deepEqual(shown(b, ".set-search-tab"), ["Appearance"]);
});

test("an option's text is searchable, and an empty query clears every mark", () => {
    const b = body();
    assert.equal(filterSettings(b, "bottom right"), 1);
    assert.ok(hidden(b).length > 0);
    assert.equal(filterSettings(b, "   "), 0);
    assert.deepEqual(hidden(b), [], "nothing is left hidden once the box is empty");
    assert.deepEqual(queryWords("  Chat   URL "), ["chat", "url"]);
});
