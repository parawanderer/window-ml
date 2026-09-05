#!/usr/bin/env node
// THE COMPONENT INDEX — one grep-able line per reusable UI thing in the sidebar.
//
//   node scripts/components.mjs                  # everything
//   node scripts/components.mjs | grep -i pill   # …by CONCEPT, which is the point
//   node scripts/components.mjs --undocumented   # exported things missing a docstring (exit 1 if any)
//   node scripts/components.mjs --new-css [ref]  # CSS classes THIS BRANCH ADDS that have no comment
//   node scripts/components.mjs --new-css [ref] --staged   # …the same, but of what is STAGED (the hook)
//
// WHY IT EXISTS. The failure it addresses is not "I searched and could not find it" — it is "I did not
// think to look." In one session this repo grew a CSS copy of an existing pointer chip, a FOURTH drag
// grip, and a second view-return signal, none of which would have been found by grepping for their real
// names (nobody greps `tok-chip` when they are about to write a pill). So the index is keyed on what a
// thing is FOR, in the words of its own docstring, and it is one line each so `grep` is the whole API.
//
// The docstrings ARE the index: nothing is duplicated into a manifest that would go stale. The cost of
// that is that an undocumented export is invisible, which `--undocumented` exists to make loud.
//
// CSS IS A RATCHET, NOT A RULE. 323 of the stylesheet's 557 classes have no comment, and a check that
// ships red is one people learn to scroll past — so `--new-css` asks only about classes a change ADDS,
// read from the diff. That matches what the index is actually for: the failure is someone REBUILDING a
// primitive that already exists, which is a fact about what is being written now, not about the backlog.
// No baseline file, because a checked-in list of 323 names is a thing that rots and gets rubber-stamped.
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const SRC = path.join(ROOT, "src", "sidebar");
const onlyUndocumented = process.argv.includes("--undocumented");
const newCssAt = process.argv.indexOf("--new-css");

/** The first sentence of a doc comment, flattened to one line. A doc that opens with WHAT THE THING IS
 *  indexes well; one that opens with a war story does not, which is a nudge worth leaving in the output. */
const firstSentence = (doc) => {
    // Strip each line's own comment marker BEFORE flattening. Doing it after leaves `//` embedded mid
    // sentence for a multi-line `//` block, which reads as garbage in a one-line index.
    const flat = doc.split("\n").map((l) => l.replace(/^\s*(?:\/\/+|\*+|\/\*+)\s?/, "").replace(/\s*\*+\/\s*$/, ""))
        .join(" ").replace(/\s+/g, " ").trim();
    // A sentence ends at a period followed by a CAPITAL or the end — not at any period-space, which cuts
    // "wrap long code lines vs. horizontal scroll" into nonsense at the "vs.". Prose here is full of those
    // (vs. / e.g. / i.e.), and a truncated first sentence is worse than a long one: the index is read as a
    // description, and half a description misleads.
    const stop = flat.search(/\.\s+(?=[A-Z])|\. *$/);
    const one = (stop > 0 ? flat.slice(0, stop) : flat).trim();
    // A cap, because this is ONE LINE per thing and a paragraph defeats that — a docstring whose first
    // sentence runs past this is telling you it does not open with what the thing is.
    return one.length > 150 ? `${one.slice(0, 149).trimEnd()}…` : one;
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
        // SCREAMING_CASE is a constant, not a component — worth telling apart so a search can be narrowed
        // to the things you can actually reuse as UI (`| grep component`).
        const kind = /^[A-Z0-9_]+$/.test(m[1]) ? "const" : /^[A-Z]/.test(m[1]) ? "component" : "helper";
        // A TRAILING comment counts. It is the house style for a one-line export (`export const codeWrap =
        // signal(true);   // wrap long code lines vs. horizontal scroll`), and ignoring it would have had
        // me move thirty of them above their declaration to satisfy the indexer — churn for nothing, and
        // worse to read. A block above still wins: it is the fuller description when both exist.
        const trailing = /;?\s*\/\/\s*(.+)$/.exec(l);
        add(m[1], kind, file, i + 1,
            docAbove(lines, i) || (trailing ? `// ${trailing[1]}` : ""));
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

// --- the CSS ratchet ------------------------------------------------------------------------------------
// Every class the stylesheet declares, and whether it carries a comment — computed over the WHOLE file so a
// class this branch adds beside an existing documented one is judged on its own comment, not its neighbour's.
function cssClassDocs() {
    const doc = new Map();
    css.forEach((l, i) => {
        const m = /^(\.[a-z][a-z0-9-]*)(?:[,\s{:])/.exec(l);
        if (!m) return;
        // A class declared in several places is documented if ANY of them explains it — the others are
        // usually a modifier or a media-query override, which do not each need their own paragraph.
        const has = css[i - 1]?.trim().endsWith("*/") || false;
        doc.set(m[1], (doc.get(m[1]) || false) || has);
    });
    return doc;
}

/** Does some SHORTER form of this class already carry an explanation? `.r-diff-head` is a part of `.r-diff`,
 *  and a rule that demanded its own paragraph would flag forty-nine members of nine documented blocks — which
 *  is the shape of check people route around, and it is not what the index is for either. The failure it
 *  exists to catch is a NEW FAMILY under a name nobody would grep: a second pointer chip called something
 *  else. That has no documented ancestor by definition, so this lets the parts through and keeps the
 *  families. */
function documentedAncestor(cls, docs) {
    const parts = cls.slice(1).split("-");
    for (let n = parts.length - 1; n >= 1; n--) {
        if (docs.get("." + parts.slice(0, n).join("-"))) return true;
    }
    return false;
}

if (newCssAt >= 0) {
    const { execFileSync } = await import("node:child_process");
    const base = process.argv[newCssAt + 1] && !process.argv[newCssAt + 1].startsWith("--")
        ? process.argv[newCssAt + 1] : "origin/main";
    // `--staged` compares the base to the INDEX, which is the only thing a pre-commit hook may ask about:
    // `base...HEAD` diffs COMMITS, so the hook passed cleanly with an undocumented class staged — it was
    // checking the state before the change it was called to check. CI wants the commit range; the hook
    // wants what is about to become one, and they are not the same diff.
    // (The COMMENTS are still read from the file on disk rather than the index. In the normal case those
    // agree; when they do not, CI is the backstop, and reading blobs out of the index to be exact here
    // would be more machinery than the gap deserves.)
    const staged = process.argv.includes("--staged");
    const range = staged ? ["diff", "--cached", "--unified=0", base] : ["diff", "--unified=0", `${base}...HEAD`];
    let diff;
    try {
        diff = execFileSync("git", [...range, "--", "src/sidebar/sidebar.css"],
            { cwd: ROOT, encoding: "utf8" });
    } catch {
        // No such ref (a shallow clone, a fork with no origin/main). SKIP rather than fail: a ratchet that
        // blocks a build because it could not find a baseline teaches people to pass --no-verify, and then
        // it is not enforcing anything at all.
        console.log(`components: cannot diff against ${base} — skipping the CSS ratchet.`);
        process.exit(0);
    }
    const docs = cssClassDocs();
    const added = new Set();
    for (const line of diff.split("\n")) {
        if (!line.startsWith("+") || line.startsWith("+++")) continue;
        const m = /^\+(\.[a-z][a-z0-9-]*)(?:[,\s{:])/.exec(line);
        if (m && docs.get(m[1]) === false && !documentedAncestor(m[1], docs)) added.add(m[1]);
    }
    if (added.size) {
        for (const c of added) console.log(`${c}  — NO COMMENT (added on this branch)`);
        console.error(`\n${added.size} new CSS class(es) with nothing to search on. Say what it is FOR in a`
            + ` comment above it — that sentence is what stops the next person building a second one.`);
        process.exit(1);
    }
    console.log(`components: every CSS class added since ${base} is documented.`);
    process.exit(0);
}

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
