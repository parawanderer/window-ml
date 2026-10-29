// measure-corpus.mjs — every page of the pinned PDF corpus read by the extension's own reader (src/pdf/pdf-read.ts), its
// measurements and provisional kind written as the threshold notebook's input rows.
//
// Run with `node --import tsx notebooks/pdf/measure-corpus.mjs` after `fetch-corpus.mjs`. Writes `data/pages.jsonl`
// (one row per page: the measurements, no text) and `data/docs.jsonl` (one per document: page count, truncation or
// refusal), both committed; and each page's text excerpt to the corpus cache (`<cache>/text/<id>.jsonl`), never
// committed, for the labelling prompts. The read budget is raised so long books are measured past the extension's 20 s.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { assets, pdfLib } from "../../tests/fixtures/pdf-node.mjs";
import { readPdf } from "../../src/pdf/pdf-read.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const CACHE = join(ROOT, "tests", "e2e", "artifacts", "pdf-corpus");
const DATA = join(HERE, "data");
/** Characters of each page's text kept for the labelling prompt. */
const EXCERPT = 800;
/** The read budget per document here: long enough for a 500-page book. */
const BUDGET_MS = 600_000;

/**
 * Read one corpus entry's cached file and return its document row, page rows and text excerpts.
 * @param {{id: string, sha256: string}} e the corpus entry
 * @returns {Promise<{doc: object, pages: object[], texts: object[]}>}
 */
async function measureOne(e) {
    const file = join(CACHE, e.sha256, "doc.pdf");
    if (!existsSync(file)) return { doc: { id: e.id, missing: true }, pages: [], texts: [] };
    const bytes = new Uint8Array(readFileSync(file));
    const size = bytes.length;   // read before pdf.js takes the buffer over, which leaves it empty
    const t0 = Date.now();
    const r = await readPdf(pdfLib, bytes, { assets, budgetMs: BUDGET_MS });
    const ms = Date.now() - t0;
    if (!r.ok) return { doc: { id: e.id, bytes: size, ms, refused: r.code }, pages: [], texts: [] };
    const { doc } = r;
    return {
        doc: { id: e.id, bytes: size, ms, pageCount: doc.pageCount, read: doc.pages.length, ...(doc.truncated ? { truncated: doc.truncated.why } : {}) },
        pages: doc.pages.map((p) => ({ id: e.id, n: p.n, kind: p.kind, textLen: p.text.length, ...p.measure })),
        texts: doc.pages.map((p) => ({ n: p.n, text: p.text.slice(0, EXCERPT) })),
    };
}

const corpus = JSON.parse(readFileSync(join(HERE, "corpus.json"), "utf8"));
mkdirSync(DATA, { recursive: true });
mkdirSync(join(CACHE, "text"), { recursive: true });
const docs = [], pages = [];
for (const e of corpus) {
    const m = await measureOne(e);
    docs.push(m.doc);
    pages.push(...m.pages);
    if (m.texts.length) writeFileSync(join(CACHE, "text", `${e.id}.jsonl`), m.texts.map((t) => JSON.stringify(t)).join("\n") + "\n");
    console.log(`${e.id}: ${m.doc.missing ? "missing" : m.doc.refused ? `refused ${m.doc.refused}` : `${m.doc.read}/${m.doc.pageCount} pages, ${m.doc.ms} ms`}`);
}
writeFileSync(join(DATA, "docs.jsonl"), docs.map((d) => JSON.stringify(d)).join("\n") + "\n");
writeFileSync(join(DATA, "pages.jsonl"), pages.map((p) => JSON.stringify(p)).join("\n") + "\n");
console.log(`${docs.length} documents, ${pages.length} pages`);
