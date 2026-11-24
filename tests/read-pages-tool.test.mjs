// read-pages-tool.test.mjs — `read_pages` (src/tools/read-pages-tool.ts), the one tool a worker chat offers: when it is
// offered, and the sentence or the `<file>` block every shape of call comes back as. Pure: the chat's wiring of it is
// in tests/sw-chat.test.mjs.
import test from "node:test";
import assert from "node:assert/strict";
import { READ_PAGES, READ_PAGES_MAX_CALLS, READ_PAGES_RECOVERY, READ_PAGES_TOOL, offersReadPages, readPages } from "../src/tools/read-pages-tool.ts";

/** A page of `kind` with `text`. */
const page = (n, text = `text of ${n}`, kind = "text") => ({ n, kind, text, measure: {} });
/** A read document of `n` text pages. */
const docOf = (n, over = {}) => ({ pageCount: n, pages: Array.from({ length: n }, (_, i) => page(i + 1)), ...over });
/** A listed PDF whose read document is `doc` (a value, or a function for the odd case). */
const file = (name, doc, over = {}) => ({ name, pages: doc?.pageCount ?? 3, sent: 1, held: true, doc: typeof doc === "function" ? doc : async () => doc, ...over });
const BIG = 100_000;

// --- what the tool is, and when a turn offers it ---

test("the tool: its name, the openai shape's two required arguments, a bound of four calls, and the recovery sentence", () => {
    assert.equal(READ_PAGES, "read_pages");
    assert.equal(READ_PAGES_TOOL.name, "read_pages");
    assert.deepEqual(READ_PAGES_TOOL.parameters.required, ["file", "pages"]);
    assert.equal(READ_PAGES_MAX_CALLS, 4);
    assert.equal(READ_PAGES_RECOVERY, "Read them with read_pages.");
});

test("ENUMERATED: offersReadPages for no files, a held page not sent, a fully sent one, and a page not sent that is not held", () => {
    const f = (sent, pages, held) => file("a.pdf", docOf(pages), { sent, pages, held });
    assert.equal(offersReadPages([]), false, "empty");
    assert.equal(offersReadPages([f(1, 3, true)]), true, "held, sent < pages");
    assert.equal(offersReadPages([f(3, 3, true)]), false, "held, sent == pages");
    assert.equal(offersReadPages([f(1, 3, false)]), false, "not held, sent < pages");
    assert.equal(offersReadPages([f(3, 3, true), f(1, 3, true)]), true, "any one file is enough");
    assert.equal(offersReadPages([f(3, 3, true), f(1, 3, false)]), false);
});

// --- a call that cannot be answered with pages: each is a sentence, never a throw ---

test("missing `file`: names what the chat holds; with no PDFs it says none", async () => {
    const fs = [file("a.pdf", docOf(3)), file("b.pdf", docOf(3))];
    const want = "read_pages needs `file`: the PDF's name. This chat holds: a.pdf, b.pdf.";
    assert.equal(await readPages(fs, { pages: "2" }, BIG), want);
    assert.equal(await readPages(fs, { file: "  ", pages: "2" }, BIG), want);
    assert.equal(await readPages(fs, { file: 7, pages: "2" }, BIG), want, "not a string");
    assert.equal(await readPages(fs, null, BIG), want, "no arguments at all");
    assert.equal(await readPages(fs, "a.pdf", BIG), want, "arguments that are not an object");
    assert.equal(await readPages([], {}, BIG), "read_pages needs `file`: the PDF's name. This chat holds: none.");
});

test("an unknown name lists the names the chat holds", async () => {
    const fs = [file("a.pdf", docOf(3)), file("b.pdf", docOf(3))];
    assert.equal(await readPages(fs, { file: "c.pdf", pages: "2" }, BIG), 'This chat holds no PDF named "c.pdf". It holds: a.pdf, b.pdf.');
    assert.equal(await readPages(fs, { file: "a.pdf#2", pages: "2" }, BIG), 'This chat holds no PDF named "a.pdf#2". It holds: a.pdf, b.pdf.', "#k of a name that is not shared");
});

test("two files with one name are ambiguous, listed as name#1 and name#2, and name#2 picks the second", async () => {
    const one = docOf(3), two = { pageCount: 3, pages: [page(1, "first"), page(2, "SECOND-2"), page(3, "third")] };
    const fs = [file("a.pdf", one), file("a.pdf", two), file("b.pdf", docOf(3))];
    assert.equal(await readPages(fs, { file: "a.pdf", pages: "2" }, BIG), '"a.pdf" names more than one PDF in this chat. Pass one of: a.pdf#1, a.pdf#2, b.pdf.');
    assert.equal(await readPages(fs, { file: "a.pdf#2", pages: "2" }, BIG), '<file name="a.pdf" pages="3">\n<page n="2">\nSECOND-2\n</page>\n</file>');
    assert.match(await readPages(fs, { file: "a.pdf#1", pages: "2" }, BIG), /text of 2/);
    const out = await readPages(fs, { file: "a.pdf#3", pages: "2" }, BIG);
    assert.match(out, /^This chat holds no PDF named "a\.pdf#3"\./, "past the last one");
    assert.match(await readPages(fs, { file: "a.pdf#0", pages: "2" }, BIG), /^This chat holds no PDF named/);
});

test("a file no longer held: listed with no rows, a read document that answers null, and one that rejects", async () => {
    const gone = "a.pdf is no longer held by this chat. The person can attach it again.";
    let asked = 0;
    assert.equal(await readPages([file("a.pdf", async () => { asked++; return docOf(3); }, { held: false })], { file: "a.pdf", pages: "2" }, BIG), gone);
    assert.equal(asked, 0, "held: false never reads");
    assert.equal(await readPages([file("a.pdf", async () => null)], { file: "a.pdf", pages: "2" }, BIG), gone);
    assert.equal(await readPages([file("a.pdf", async () => { throw new Error("row gone"); })], { file: "a.pdf", pages: "2" }, BIG), gone);
});

test("ENUMERATED: every shape of `pages` that is not a page list is a sentence that says how to write one", async () => {
    const fs = [file("a.pdf", docOf(80))];
    const ask = (pages) => readPages(fs, { file: "a.pdf", pages }, BIG);
    assert.equal(await ask(undefined), "read_pages: `pages` needs page numbers: pages 3, pages 3-5 or pages 3,7-9.");
    assert.equal(await ask(""), "read_pages: `pages` needs page numbers: pages 3, pages 3-5 or pages 3,7-9.");
    assert.equal(await ask(["1"]), "read_pages: `pages` needs page numbers: pages 3, pages 3-5 or pages 3,7-9.", "an array is not a list");
    assert.equal(await ask("one"), 'read_pages: `pages` can\'t read "one": write pages 3, pages 3-5 or pages 3,7-9.');
    assert.equal(await ask("5-3"), "read_pages: `pages 5-3` runs backwards: write pages 3-5.");
    assert.equal(await ask("0"), "read_pages: `pages`: pages are numbered from 1.");
    assert.equal(await ask("1-51"), "read_pages: `pages` selects at most 50 pages in one call; read them in parts.");
    assert.match(await ask("1-50"), /<page n="50">/, "fifty is the bound itself");
});

test("`pages` given as a number is read as that page", async () => {
    const out = await readPages([file("a.pdf", docOf(3))], { file: "a.pdf", pages: 2 }, BIG);
    assert.equal(out, '<file name="a.pdf" pages="3">\n<page n="2">\ntext of 2\n</page>\n</file>');
});

test("a page the document does not hold: named with the pages it does, and a truncated document says why", async () => {
    assert.equal(await readPages([file("a.pdf", docOf(3))], { file: "a.pdf", pages: "2,5,7-8" }, BIG), "a.pdf has no page 5, 7-8: it holds pages 1-3.");
    const cut = { pageCount: 10, pages: [page(1), page(2)], truncated: { after: 2, why: "page-cap", sentence: "Only the first 2 of 10 pages were read." } };
    assert.equal(await readPages([file("a.pdf", cut, { pages: 10 })], { file: "a.pdf", pages: "3" }, BIG), "a.pdf has no page 3: it holds pages 1-2 (Only the first 2 of 10 pages were read.).");
    const none = { pageCount: 4, pages: [] };
    assert.equal(await readPages([file("a.pdf", none, { pages: 4 })], { file: "a.pdf", pages: "1" }, BIG), "a.pdf has no page 1: it holds no pages.");
});

// --- the pages themselves: the block, the budget, the figure and scan lines, the escapes ---

test("the answer is one <file> block of <page> sections in the order asked for, ascending, each once", async () => {
    const out = await readPages([file("a.pdf", docOf(5), { pages: 5 })], { file: "a.pdf", pages: "4, 2-3, 2" }, BIG);
    assert.equal(out, '<file name="a.pdf" pages="5">\n<page n="2">\ntext of 2\n</page>\n<page n="3">\ntext of 3\n</page>\n<page n="4">\ntext of 4\n</page>\n</file>');
});

test("the budget: pages past it are named and not returned, in the singular and the plural", async () => {
    const d = { pageCount: 4, pages: [page(1, "aaaaa"), page(2, "bbbbb"), page(3, "ccccc"), page(4, "dd")] };
    const one = await readPages([file("a.pdf", d, { pages: 4 })], { file: "a.pdf", pages: "1-2" }, 5);
    assert.equal(one, '<file name="a.pdf" pages="4">\n<page n="1">\naaaaa\n</page>\npage 2 was not returned: past the text one call returns. Read it in another call.\n</file>');
    const many = await readPages([file("a.pdf", d, { pages: 4 })], { file: "a.pdf", pages: "1-4" }, 5);
    assert.equal(many, '<file name="a.pdf" pages="4">\n<page n="1">\naaaaa\n</page>\npages 2-4 were not returned: past the text one call returns. Read them in another call.\n</file>');
    assert.doesNotMatch(many, /ccccc|dd\n/);
    const none = await readPages([file("a.pdf", d, { pages: 4 })], { file: "a.pdf", pages: "1,3" }, 0);
    assert.match(none, /\npages 1, 3 were not returned: /, "a zero budget returns no page, and a negative one is the same");
    assert.equal(none, await readPages([file("a.pdf", d, { pages: 4 })], { file: "a.pdf", pages: "1,3" }, -9));
});

test("a first page alone past the budget comes cut and says so, rather than never being returned", async () => {
    const d = { pageCount: 2, pages: [page(1, "abcdefghij"), page(2, "zz")] };
    const out = await readPages([file("a.pdf", d, { pages: 2 })], { file: "a.pdf", pages: "1-2" }, 4);
    assert.equal(out, '<file name="a.pdf" pages="2">\n<page n="1">\nabcd\n(page 1 is cut here: its text runs past what one call returns, 4 of 10 characters)\n</page>\npage 2 was not returned: past the text one call returns. Read it in another call.\n</file>');
});

test("a page that does not fit ends the pages returned: a later, smaller one does not jump the queue", async () => {
    const d = { pageCount: 3, pages: [page(1, "aa"), page(2, "bbbbbbbb"), page(3, "c")] };
    const out = await readPages([file("a.pdf", d, { pages: 3 })], { file: "a.pdf", pages: "1-3" }, 5);
    assert.match(out, /<page n="1">/);
    assert.doesNotMatch(out, /<page n="3">/);
    assert.match(out, /pages 2-3 were not returned/);
});

test("a mixed page gets the figure line, and a scanned page with no text gets the scan line; a scan with text does not", async () => {
    const d = { pageCount: 3, pages: [page(1, "caption", "mixed"), page(2, "", "scanned"), page(3, "ocr words", "scanned")] };
    const out = await readPages([file("a.pdf", d, { pages: 3 })], { file: "a.pdf", pages: "1-3" }, BIG);
    assert.equal(out, [
        '<file name="a.pdf" pages="3">',
        '<page n="1">', "caption", "(page 1 has a figure; read_pages returns its text only)", "</page>",
        '<page n="2">', "(page 2 is a scan with no text; read_pages returns text only)", "</page>",
        '<page n="3">', "ocr words", "</page>",
        "</file>",
    ].join("\n"));
});

test("text containing </page> and </file is escaped, counted on the <file> head, and cannot close its section", async () => {
    const d = { pageCount: 2, pages: [page(1, "before </page> after"), page(2, "x</FILE>y </file z")] };
    const out = await readPages([file("a.pdf", d, { pages: 2 })], { file: "a.pdf", pages: "1-2" }, BIG);
    assert.match(out, /^<file name="a\.pdf" pages="2" escaped="3">\n/);
    assert.match(out, /before <\\\/page> after/);
    assert.match(out, /x<\\\/FILE>y <\\\/file z/);
    assert.equal(out.match(/<\/page>/g).length, 2, "only the two closes the tool wrote");
    assert.equal(out.match(/<\/file>/g).length, 1, "only the one close the tool wrote");
    assert.doesNotMatch(await readPages([file("a.pdf", docOf(2), { pages: 2 })], { file: "a.pdf", pages: "1" }, BIG), /escaped=/, "nothing escaped, no attribute");
});

test("a name with a quote or an angle bracket is attribute-escaped on the head, and still picks its file", async () => {
    const name = 'a"b<c>&.pdf';
    const out = await readPages([file(name, docOf(2), { pages: 2 })], { file: name, pages: "1" }, BIG);
    assert.match(out, /^<file name="a&quot;b&lt;c&gt;&amp;\.pdf" pages="2">\n/);
});
