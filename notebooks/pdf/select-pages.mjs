// select-pages.mjs — which measured PDF pages the threshold notebook has labelled: every page whose measurements sit
// near a provisional cut-off (pdf-classify.ts, pdf-measure.ts), plus a random few of each document as controls, each
// document capped so a 300-page book does not drown out a 3-page form.
//
//   node notebooks/pdf/select-pages.mjs            → data/selection.jsonl (the vision model's set)
//   node notebooks/pdf/select-pages.mjs --opus     → data/selection-opus.jsonl (the calibration set, from qwen's labels)
//
// Deterministic: "random" is the order of a hash of the page's id and number, so a rerun picks the same pages.

import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
/** Near-cut-off pages kept per document, and controls (pages near nothing) per document. */
const NEAR_PER_DOC = 12, CONTROLS_PER_DOC = 4;

/**
 * Which cut-offs a page's measurements sit near (empty when none): the band each is read in is wide on purpose,
 * since where the cut-off should be is the question.
 * @param {any} p a pages.jsonl row
 * @returns {string[]}
 */
export function nearWhat(p) {
    const r = [];
    if (p.usableChars >= 50 && p.usableChars <= 450) r.push("text-min");
    if (p.imageCover >= 0.3 && p.imageCover <= 0.7) r.push("scanned-cover");
    if (p.imageCover >= 0.08 && p.imageCover <= 0.25) r.push("mixed-cover");
    if (p.imageCover >= 0.005 && p.imageCover <= 0.06) r.push("blank-cover");
    if (p.usableChars < 10 && p.imageCover < 0.005) r.push("blank");
    if (p.brokenChars >= 10 && p.brokenRatio >= 0.1 && p.brokenRatio <= 0.6) r.push("broken-ratio");
    if (p.invisibleShare >= 0.5 && p.invisibleShare < 0.99) r.push("invisible-share");
    if (p.largestImage >= 0.6 && p.largestImage <= 0.97) r.push("full-page");
    return r;
}

/** The page's place in the deterministic shuffle. */
const rank = (p) => createHash("sha256").update(`${p.id}#${p.n}`).digest("hex");

/** The calibration set's cells: (our kind, qwen's kind or text layer) → how many pages of it Opus labels. */
const OPUS_CELLS = [
    ["text", "kind:blank", 4], ["text", "kind:figure", 3], ["text", "kind:mixed", 4], ["mixed", "kind:figure", 3],
    ["scanned", "kind:blank", 4], ["scanned", "kind:text", 4], ["ocr-scan", "kind:text", 3], ["blank", "kind:figure", 2],
    ["*", "layer:garbled", 5], ["*", "layer:hidden", 3],
];
/** Agreements Opus also labels, so a bias common to every page is not read as a hard-page effect. */
const OPUS_CONTROLS = 5;

const pages = readFileSync(join(HERE, "data", "pages.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
if (process.argv.includes("--opus")) {
    const kindOf = new Map(pages.map((p) => [`${p.id}#${p.n}`, p.kind]));
    const qwen = readFileSync(join(HERE, "data", "labels-qwen3.8-flash-next-vision.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((r) => r.label)
        .sort((a, b) => rank(a) < rank(b) ? -1 : 1);
    const taken = new Set(), out = [];
    const take = (r, why) => { const k = `${r.id}#${r.n}`; if (taken.has(k)) return false; taken.add(k); out.push({ id: r.id, n: r.n, why }); return true; };
    for (const [ours, cell, want] of OPUS_CELLS) {
        const [what, v] = cell.split(":");
        let got = 0;
        for (const r of qwen) {
            if (got >= want) break;
            if (ours !== "*" && kindOf.get(`${r.id}#${r.n}`) !== ours) continue;
            if ((what === "kind" ? r.label.kind : r.label.textLayer) !== v) continue;
            if (take(r, `${ours} vs qwen ${cell}`)) got++;
        }
    }
    const same = { text: "text", mixed: "mixed", scanned: "scanned", blank: "blank" };
    let controls = 0;
    for (const r of qwen) {
        if (controls >= OPUS_CONTROLS) break;
        if (same[kindOf.get(`${r.id}#${r.n}`)] === r.label.kind && take(r, "control: agreement")) controls++;
    }
    writeFileSync(join(HERE, "data", "selection-opus.jsonl"), out.map((r) => JSON.stringify(r)).join("\n") + "\n");
    console.log(`${out.length} pages for the calibration set`);
    process.exit(0);
}
const byDoc = new Map();
for (const p of pages) (byDoc.get(p.id) ?? byDoc.set(p.id, []).get(p.id)).push(p);
const out = [];
for (const ps of byDoc.values()) {
    const shuffled = [...ps].sort((a, b) => rank(a) < rank(b) ? -1 : 1);
    const near = shuffled.filter((p) => nearWhat(p).length).slice(0, NEAR_PER_DOC);
    const controls = shuffled.filter((p) => !nearWhat(p).length).slice(0, CONTROLS_PER_DOC);
    for (const p of near) out.push({ id: p.id, n: p.n, near: nearWhat(p) });
    for (const p of controls) out.push({ id: p.id, n: p.n, near: [] });
}
out.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : a.n - b.n);
writeFileSync(join(HERE, "data", "selection.jsonl"), out.map((r) => JSON.stringify(r)).join("\n") + "\n");
console.log(`${out.length} pages selected from ${byDoc.size} documents (${out.filter((r) => r.near.length).length} near a cut-off)`);
