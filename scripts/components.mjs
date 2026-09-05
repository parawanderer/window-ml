#!/usr/bin/env node
// THE COMPONENT INDEX — one grep-able line per reusable UI thing in the sidebar.
//
//   node scripts/components.mjs                  # everything
//   node scripts/components.mjs | grep -i pill   # …by CONCEPT, which is the point
//   node scripts/components.mjs --undocumented   # what is missing a docstring (exit 1 if any)
//
// WHY IT EXISTS. The failure it addresses is not "I searched and could not find it" — it is "I did not
// think to look." In one session this repo grew a CSS copy of an existing pointer chip, a FOURTH drag
// grip, and a second view-return signal, none of which would have been found by grepping for their real
// names (nobody greps `tok-chip` when they are about to write a pill). So the index is keyed on what a
// thing is FOR, in the words of its own docstring, and it is one line each so `grep` is the whole API.
//
// The docstrings ARE the index: nothing is duplicated into a manifest that would go stale. The cost of
// that is that an undocumented export is invisible, which `--undocumented` exists to make loud.
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const SRC = path.join(ROOT, "src", "sidebar");
const onlyUndocumented = process.argv.includes("--undocumented");

/** The first sentence of a doc comment, flattened to one line. A doc that opens with WHAT THE THING IS
 *  indexes well; one that opens with a war story does not, which is a nudge worth leaving in the output. */
const firstSentence = (doc) => {
    const flat = doc.replace(/\s*\n\s*\*?\s*/g, " ").replace(/^\/\*+\s*/, "").replace(/\s*\*+\/$/, "")
        .replace(/^\/\/+\s*/gm, "").trim();
    const stop = flat.search(/\.\s|\. *$/);
    return (stop > 0 ? flat.slice(0, stop) : flat).trim();
};

/** A JSDoc block or a run of `//` lines immediately above `line`, or "". */
function docAbove(lines, i) {
    let j = i - 1;
    if (lines[j]?.trim().endsWith("*/")) {
        const end = j;
        while (j >= 0 && !lines[j].includes("/*")) j--;
        return lines.slice(j, end + 1).join("\n");
    }
    const out = [];
    while (j >= 0 && /^\s*\/\//.test(lines[j])) { out.unshift(lines[j]); j--; }
    return out.join("\n");
}

const rows = [];
const add = (name, kind, file, line, doc) =>
    rows.push({ name, kind, where: `${path.relative(ROOT, file)}:${line}`, doc: doc ? firstSentence(doc) : "" });

// --- exported components and hooks -------------------------------------------------------------------
for (const f of readdirSync(SRC).filter((f) => f.endsWith(".tsx") || f.endsWith(".ts"))) {
    const file = path.join(SRC, f);
    const lines = readFileSync(file, "utf8").split("\n");
    lines.forEach((l, i) => {
        // `export function Name(` / `export const Name = (` / `export const Name = ({`. Capitalised = a
        // component; the rest are helpers, which are worth indexing too (a hook is a reusable thing).
        const m = /^export (?:function|const) ([A-Za-z_][A-Za-z0-9_]*)\s*[=(]/.exec(l);
        if (!m) return;
        const isComponent = /^[A-Z]/.test(m[1]);
        add(m[1], isComponent ? "component" : "helper", file, i + 1, docAbove(lines, i));
    });
}

// --- documented CSS classes ---------------------------------------------------------------------------
// The grip and the chip were both CSS, not components — an index that only knows about JSX would have
// missed the two clearest cases it exists for. Only classes with a comment above them: an undocumented
// rule has nothing to search on, and listing every selector would bury the ones that mean something.
const cssFile = path.join(SRC, "sidebar.css");
const css = readFileSync(cssFile, "utf8").split("\n");
css.forEach((l, i) => {
    const m = /^(\.[a-z][a-z0-9-]*)(?:[,\s{:])/.exec(l);
    if (!m) return;
    // Walk up to the OPENING `/*`, not just over lines that look like comment lines: a block whose
    // continuation lines have no leading `*` (most of this stylesheet) would otherwise be indexed by its
    // last line, which is the least useful sentence in it.
    if (!css[i - 1]?.trim().endsWith("*/")) return;
    let j = i - 1;
    while (j >= 0 && !css[j].includes("/*")) j--;
    if (j < 0) return;
    const doc = css.slice(j, i).join("\n").replace(/\/\*+|\*+\//g, "");
    add(m[1], "css", cssFile, i + 1, doc);
});

const undocumented = rows.filter((r) => !r.doc);
if (onlyUndocumented) {
    for (const r of undocumented) console.log(`${r.name}  ${r.where}  ${r.kind}  — NO DOCSTRING`);
    // Loud on purpose: an undocumented export is INVISIBLE to a grep of this index, so the next person
    // rebuilds it. That is the exact failure the index exists to prevent.
    if (undocumented.length) { console.error(`\n${undocumented.length} undocumented — they cannot be found by concept, so they will be rebuilt.`); process.exit(1); }
    console.log("all documented");
    process.exit(0);
}

// One line each, padded ONLY here: this output is for a human or a grep, never for a model's context (see
// the no-padding rule in AGENTS.md, which is about model-facing strings).
const w = Math.max(...rows.map((r) => r.name.length));
const wk = Math.max(...rows.map((r) => r.kind.length));
for (const r of rows.sort((a, b) => a.name.localeCompare(b.name)))
    console.log(`${r.name.padEnd(w)}  ${r.kind.padEnd(wk)}  ${r.where}${r.doc ? `  — ${r.doc}` : "  — (undocumented)"}`);
