#!/usr/bin/env node
// THE CODE INDEX — one TAB-separated line per thing in this repo you could reuse, searchable by what it is FOR.
//
//   node scripts/index.mjs                       # everything
//   node scripts/index.mjs 'pill|chip|badge'     # a REGEX over name + summary (case-insensitive)
//   node scripts/index.mjs table --kind file     # which MODULES are about tables
//   node scripts/index.mjs '' --kind css         # every documented CSS class
//   node scripts/index.mjs fetch --sig           # …with each symbol's signature
//   node scripts/index.mjs --exported            # module surface only (--local for the rest)
//   node scripts/index.mjs --local --kind function    # a file's private helpers
//   node scripts/index.mjs --stats               # how big the index is, by kind
//
// The checks (each exits 1 on a finding, and each is run by the pre-commit hook and CI's `tools` job):
//   node scripts/index.mjs --new [ref] [--staged]     # THE RATCHET: what this change ADDS with nothing to search on
//   node scripts/index.mjs --new-css [ref]            # …the CSS half alone
//   node scripts/index.mjs --undocumented             # every undocumented export, repo-wide (a survey, ships red)
//   node scripts/index.mjs --headerless               # source files with no header comment
//   node scripts/index.mjs --check-speed              # a cold build against its own time budget
//
// WHY IT EXISTS. It replaces `scripts/components.mjs`, which indexed sidebar components and CSS classes, and it
// exists for the same failure one level up: not "I searched and could not find it" but "I did not think to look."
// The component index was written after one session grew a second pointer chip, a FOURTH drag grip and a second
// view-return signal. The same thing happens to MODULES — the cost is just higher, because what gets rebuilt is a
// subsystem rather than a pill. So the unit of search here is the FILE as well as the symbol, and the two live in
// one tool because having to know which of two scripts to run is that same failure wearing a hat.
//
// WHAT MAKES IT SEARCHABLE: prose, not names. You cannot grep `tok-chip` while about to write a pill, and you
// cannot grep `sw-values.ts` while about to write a value store. So every row carries the first sentence of a
// DOCSTRING — a file's header comment, a declaration's JSDoc, a CSS rule's comment — and the regex runs over that
// sentence as well as the name. The docstrings ARE the index: nothing is duplicated into a manifest that would go
// stale, and the price of that is that an undocumented thing is INVISIBLE, which `--undocumented` and
// `--headerless` exist to make loud.
//
// OUTPUT IS TAB-SEPARATED, one record per line, so it chains: `grep`, `cut -f2`, `awk -F'\t'`, `sort`, `wc -l`.
// Nothing is column-padded — padding is what breaks `cut`, and this output is read by a pipeline at least as often
// as by eyes. Fields: KIND, NAME, PATH:LINE, [SIGNATURE with --sig,] SUMMARY.
//
// WHAT IS INDEXED: module-scope declarations only, and their bindings rather than their innards. JavaScript lets
// you nest objects forever and indexing that depth would bury the rows that mean something. One deliberate
// exception, exactly one level deep and never recursive: a module-scope object literal lists its own top-level
// keys (`API_FORMATS … keys: openai, ollama`), because that pattern IS the API surface in several files here, and
// a class lists its method names for the same reason.
//
// WHY THERE IS NO TYPESCRIPT PROGRAM BEHIND IT. Parsing the repo with the compiler is seconds; a column-0 scan is
// tens of milliseconds, and module-scope declarations are unambiguous at column 0. The cost is that a declaration
// indented inside something else is not seen, which is the scope of the tool anyway.
import { readFileSync, readdirSync, writeFileSync, statSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
/** Where the cache lives. ctags-style: one flat file at the root, gitignored, rebuilt when a file's bytes change. */
const CACHE = path.join(ROOT, ".index-cache.tsv");
const CACHE_VERSION = "v1";
/** Every source tree the index covers. `src/` recursively; tests and scripts are deliberately out (a long test file
 *  is a long LIST, and indexing it by purpose would drown the modules). */
const SRC_ROOTS = ["src"];
/** The stylesheets whose classes are indexed and ratcheted. */
const CSS_FILES = ["src/sidebar/sidebar.css", "src/chat/chat.css"];
/** Generated files: indexing them is noise, and their headers are written by a generator. */
const SKIP = /\.gen\.ts$|\.d\.ts$/;

// SPEED BUDGET for a COLD build (`--check-speed`, run in CI, where there is never a cache). This tool is meant to
// be reachable mid-thought — the moment it costs enough to think about, it stops getting run, and an index nobody
// runs prevents nothing. Measured 2026-09-18: 100 ms for 142 files / 3,486 records on a laptop, of which ~40 ms is
// node's own startup. The headroom below is for a CI runner being slower and noisier, NOT for the tool getting
// slower — if these ever trip, the cause is a change in kind (a TypeScript program, a per-file `git` call), not
// growth, because growth is ~0.4 ms per file and the repo would need 2,000 files to reach the warning by itself.
const SPEED_WARN_MS = 750;
const SPEED_FAIL_MS = 3000;

// ---- arguments ---------------------------------------------------------------------------------------------
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const opt = (name) => { const i = argv.indexOf(`--${name}`); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : undefined; };
/** The first non-flag argument, and never the VALUE of a flag that takes one. */
const queryArg = (() => {
    for (let i = 0; i < argv.length; i++) {
        if (argv[i].startsWith("--")) { if (["kind", "new-css"].includes(argv[i].slice(2))) i++; continue; }
        return argv[i];
    }
    return undefined;
})();
const kinds = opt("kind") ? new Set(opt("kind").split(",").map((s) => s.trim())) : null;
const wantExported = flag("exported"), wantLocal = flag("local");
const withSig = flag("sig");

// ---- reading docstrings ------------------------------------------------------------------------------------
/** The first sentence of a doc comment, flattened to one line. A doc that opens with WHAT THE THING IS indexes
 *  well; one that opens with a war story does not, which is a nudge worth leaving in the output. */
function firstSentence(doc) {
    // Strip each line's own comment marker BEFORE flattening. Doing it after leaves `//` embedded mid sentence for
    // a multi-line `//` block, which reads as garbage in a one-line index.
    const flat = doc.split("\n").map((l) => l.replace(/^\s*(?:\/\/+|\*+|\/\*+)\s?/, "").replace(/\s*\*+\/\s*$/, ""))
        .join(" ").replace(/\s+/g, " ").trim();
    // A sentence ends at a period followed by a CAPITAL or the end — not at any period-space, which cuts
    // "wrap long code lines vs. horizontal scroll" into nonsense at the "vs.". Prose here is full of those
    // (vs. / e.g. / i.e.), and a truncated first sentence is worse than a long one.
    const stop = flat.search(/\.\s+(?=[A-Z])|\. *$/);
    const one = (stop > 0 ? flat.slice(0, stop) : flat).trim();
    return one.length > 160 ? `${one.slice(0, 159).trimEnd()}…` : one;
}

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

/** A file's HEADER: the comment block it opens with, before any code. This is the row that answers "is there
 *  already a module for this", so a file without one is invisible at exactly the moment it matters most. */
function fileHeader(lines) {
    let i = 0;
    while (i < lines.length && !lines[i].trim()) i++;
    if (lines[i]?.trim().startsWith("/*")) {
        const start = i;
        while (i < lines.length && !lines[i].includes("*/")) i++;
        return lines.slice(start, i + 1).join("\n");
    }
    const out = [];
    while (i < lines.length && /^\s*\/\//.test(lines[i])) { out.push(lines[i]); i++; }
    return out.join("\n");
}

// ---- scanning one source file ------------------------------------------------------------------------------
/** Collapse a multi-line declaration head to one line, and cap it: a signature is a reminder of the shape, and a
 *  200-character one has stopped being that. */
const sig = (s) => {
    const one = s.replace(/\s+/g, " ").trim().replace(/\s*\{$/, "");
    return one.length > 160 ? `${one.slice(0, 159).trimEnd()}…` : one;
};

/** Read forward from `i` until the declaration's HEAD ends: the `{` that opens a body, or a `;`/`=` that ends a
 *  signature. Balanced on parens and angle brackets, so a generic or a multi-line parameter list survives. */
function headOf(lines, i) {
    let depth = 0, out = "";
    for (let j = i; j < lines.length && j < i + 40; j++) {
        for (const ch of lines[j]) {
            if (ch === "(" || ch === "<" || ch === "[") depth++;
            else if (ch === ")" || ch === ">" || ch === "]") depth--;
            else if (depth <= 0 && (ch === "{" || ch === ";")) return out.trim();
            out += ch === "\n" ? " " : ch;
            continue;
        }
        out += " ";
        if (depth <= 0 && /[;{]\s*$/.test(lines[j])) break;
    }
    return out.trim();
}

/** The top-level keys of an object literal opening at `lines[i]`, one level deep and never recursive. */
function objectKeys(lines, i) {
    let depth = 0, started = false;
    const keys = [];
    for (let j = i; j < lines.length && j < i + 400; j++) {
        for (let k = 0; k < lines[j].length; k++) {
            const ch = lines[j][k];
            if (ch === "{" || ch === "[") { depth++; started = true; }
            else if (ch === "}" || ch === "]") { depth--; if (started && depth <= 0) return keys; }
        }
        if (!started) continue;
        // Depth 1 means a direct member of THIS literal; anything deeper is the slop we deliberately do not index.
        if (depth === 1) {
            const m = /^\s*(?:"([^"]+)"|'([^']+)'|\[?([A-Za-z_$][\w$]*)\]?)\s*:/.exec(lines[j + 1] ?? "");
            if (m) keys.push(m[1] ?? m[2] ?? m[3]);
        }
    }
    return keys;
}

/** A class's own method and accessor names, read at brace depth 1. Bodies are never entered. */
function classMembers(lines, i) {
    let depth = 0, started = false;
    const names = [];
    for (let j = i; j < lines.length && j < i + 800; j++) {
        const before = depth;
        for (const ch of lines[j]) {
            if (ch === "{") { depth++; started = true; }
            else if (ch === "}") { depth--; if (started && depth <= 0) return names; }
        }
        if (!started || before !== 1) continue;
        const m = /^\s+(?:(?:public|private|protected|static|readonly|async|get|set|override)\s+)*([A-Za-z_$][\w$]*)\s*[(<]/.exec(lines[j]);
        if (m && m[1] !== "constructor") names.push(m[1]);
    }
    return names;
}

/** Every module-scope declaration in one file, as index records. Column-0 anchored: a declaration indented inside
 *  anything else is out of scope by design (see the header). */
function scanSource(rel, text) {
    const lines = text.split("\n");
    const out = [];
    const header = fileHeader(lines);
    out.push({ kind: "file", name: path.basename(rel), where: `${rel}:1`, exported: true, sig: rel, doc: header ? firstSentence(header) : "" });

    lines.forEach((l, i) => {
        // Column 0 only. `^export?` then the declarator — the shapes TypeScript allows at module scope.
        const m = /^(export\s+(?:default\s+)?)?(?:declare\s+)?(?:(async)\s+)?(function|class|interface|type|enum|const|let|var)\s+([A-Za-z_$][\w$]*)/.exec(l);
        if (!m) return;
        const [, exp, , declarator, name] = m;
        const exported = !!exp;
        let kind = declarator === "function" ? "function"
            : declarator === "class" ? "class"
            : declarator === "interface" || declarator === "type" ? "type"
            : declarator === "enum" ? "enum" : "const";
        let signature = headOf(lines, i);

        if (kind === "const") {
            // A component, a hook and a plain value are all `const` to the scanner, and telling them apart is what
            // makes `--kind component` mean anything. Capitalised + JSX/arrow → component; `use*` → hook.
            const rhs = l.slice(l.indexOf(name) + name.length).replace(/^\s*:[^=]*/, "").replace(/^\s*=\s*/, "");
            if (/^[A-Z]/.test(name) && /=>|\bfunction\b/.test(rhs)) kind = "component";
            else if (/^use[A-Z]/.test(name)) kind = "hook";
            else if (/=>|\bfunction\b/.test(rhs)) kind = "function";
            if (rhs.trimStart().startsWith("{")) {
                const keys = objectKeys(lines, i);
                if (keys.length) signature = `${sig(signature)} keys: ${keys.join(", ")}`;
            }
        }
        if (kind === "class") {
            const members = classMembers(lines, i);
            if (members.length) signature = `${sig(signature)} members: ${members.join(", ")}`;
        }
        // A TRAILING comment counts. It is the house style for a one-line export here (`export const codeWrap =
        // signal(true);   // wrap long code lines`), and refusing it would mean moving thirty of them above their
        // declaration to satisfy an indexer — churn for nothing, and worse to read. A block above still wins.
        const trailing = /;?\s*\/\/\s*(.+)$/.exec(l);
        const doc = docAbove(lines, i) || (trailing ? `// ${trailing[1]}` : "");
        out.push({ kind, name, where: `${rel}:${i + 1}`, exported, sig: sig(signature), doc: doc ? firstSentence(doc) : "" });
    });
    return out;
}

/** Documented CSS classes, plus (for the ratchet) whether each declared class carries a comment anywhere. */
function scanCss(rel, text) {
    const css = text.split("\n");
    // ONE row per class, not one per declaration. A class is declared several times (a modifier, a media override,
    // a `:hover`), and listing each would put five undocumented `.am-chip` lines under the one that explains it —
    // burying the sentence the index exists to surface. The DOCUMENTED declaration wins; otherwise the first.
    const byName = new Map();
    css.forEach((l, i) => {
        const m = /^(\.[a-z][a-z0-9-]*)(?:[,\s{:])/.exec(l);
        if (!m) return;
        // Walk up to the OPENING `/*`, not merely over lines that LOOK like comment lines: a block whose
        // continuation lines have no leading `*` (most of this stylesheet) would otherwise be indexed by its last
        // line, which is the least useful sentence in it.
        let doc = "";
        if (css[i - 1]?.trim().endsWith("*/")) {
            let j = i - 1;
            while (j >= 0 && !css[j].includes("/*")) j--;
            if (j >= 0) doc = firstSentence(css.slice(j, i).join("\n").replace(/\/\*+|\*+\//g, ""));
        }
        const prev = byName.get(m[1]);
        if (prev && (prev.doc || !doc)) return;
        byName.set(m[1], { kind: "css", name: m[1], where: `${rel}:${i + 1}`, exported: true, sig: m[1], doc });
    });
    return [...byName.values()];
}

// ---- the file set ------------------------------------------------------------------------------------------
function sourceFiles() {
    const out = [];
    const walk = (dir) => {
        for (const e of readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, e.name);
            if (e.isDirectory()) { walk(full); continue; }
            if (!/\.(ts|tsx|css)$/.test(e.name) || SKIP.test(e.name)) continue;
            out.push(path.relative(ROOT, full));
        }
    };
    for (const r of SRC_ROOTS) walk(path.join(ROOT, r));
    return out.sort();
}

// ---- the cache ---------------------------------------------------------------------------------------------
// ctags-style: one flat TSV at the repo root, gitignored. A `F` line opens a file's block with its stat and its
// content hash; the records follow. mtime+size is the cheap pre-filter and the HASH is what decides, because a
// branch switch rewrites mtimes wholesale and a cache that trusted them alone would rebuild everything (or, worse,
// a checkout that restored an older file with the same size would look fresh while being wrong).
const sha = (s) => createHash("sha1").update(s).digest("hex").slice(0, 16);

function loadCache() {
    if (!existsSync(CACHE)) return new Map();
    try {
        const lines = readFileSync(CACHE, "utf8").split("\n");
        if (lines[0] !== `#${CACHE_VERSION}`) return new Map();
        const byFile = new Map();
        let cur = null;
        for (const line of lines.slice(1)) {
            if (!line) continue;
            const f = line.split("\t");
            if (f[0] === "F") { cur = { hash: f[2], size: Number(f[3]), mtime: Number(f[4]), records: [] }; byFile.set(f[1], cur); }
            else if (cur) cur.records.push({ kind: f[0], name: f[1], where: f[2], exported: f[3] === "1", sig: f[4] ?? "", doc: f[5] ?? "" });
        }
        return byFile;
    } catch { return new Map(); }
}

function saveCache(byFile) {
    const out = [`#${CACHE_VERSION}`];
    for (const [rel, e] of [...byFile].sort((a, b) => a[0].localeCompare(b[0]))) {
        out.push(["F", rel, e.hash, e.size, e.mtime].join("\t"));
        for (const r of e.records) out.push([r.kind, r.name, r.where, r.exported ? "1" : "0", r.sig, r.doc].join("\t"));
    }
    try { writeFileSync(CACHE, out.join("\n") + "\n"); } catch { /* a read-only checkout still works, just slower */ }
}

/** Every record for the repo, reusing cached blocks whose bytes have not changed. */
function buildIndex({ rebuild = false } = {}) {
    const cache = rebuild ? new Map() : loadCache();
    const next = new Map();
    let scanned = 0;
    for (const rel of sourceFiles()) {
        const st = statSync(path.join(ROOT, rel));
        const hit = cache.get(rel);
        if (hit && hit.size === st.size && hit.mtime === Math.floor(st.mtimeMs)) { next.set(rel, hit); continue; }
        const text = readFileSync(path.join(ROOT, rel), "utf8");
        const hash = sha(text);
        // The stat moved but the CONTENT did not (a branch switch, a checkout): keep the records, refresh the stat.
        if (hit && hit.hash === hash) { next.set(rel, { ...hit, size: st.size, mtime: Math.floor(st.mtimeMs) }); continue; }
        scanned++;
        next.set(rel, { hash, size: st.size, mtime: Math.floor(st.mtimeMs), records: rel.endsWith(".css") ? scanCss(rel, text) : scanSource(rel, text) });
    }
    if (scanned || next.size !== cache.size) saveCache(next);
    return { records: [...next.values()].flatMap((e) => e.records), scanned, files: next.size };
}

// ---- the index, then the checks that read it ----------------------------------------------------------------
const { records, scanned, files } = buildIndex({ rebuild: flag("rebuild") });

// ---- the CSS ratchet ---------------------------------------------------------------------------------------
/** Every class the stylesheets declare, and whether ANY declaration of it carries a comment — a class declared in
 *  several places is documented if one of them explains it, since the others are usually a modifier or a media
 *  override, which do not each need their own paragraph. */
function cssClassDocs() {
    const doc = new Map();
    for (const rel of CSS_FILES) {
        const css = readFileSync(path.join(ROOT, rel), "utf8").split("\n");
        css.forEach((l, i) => {
            const m = /^(\.[a-z][a-z0-9-]*)(?:[,\s{:])/.exec(l);
            if (!m) return;
            doc.set(m[1], (doc.get(m[1]) || false) || (css[i - 1]?.trim().endsWith("*/") || false));
        });
    }
    return doc;
}

/** Does some SHORTER form of this class already carry an explanation? `.r-diff-head` is a part of `.r-diff`, and a
 *  rule demanding its own paragraph would flag forty-nine members of nine documented blocks — the shape of check
 *  people route around. What this exists to catch is a NEW FAMILY under a name nobody would grep: a second pointer
 *  chip called something else, which has no documented ancestor by definition. */
function documentedAncestor(cls, docs) {
    const parts = cls.slice(1).split("-");
    for (let n = parts.length - 1; n >= 1; n--) if (docs.get("." + parts.slice(0, n).join("-"))) return true;
    return false;
}

// THE RATCHET. Two things a change ADDS must be findable: a CSS class under a new family, and an exported symbol.
// Both are checked against the DIFF, never against the repo, because the repo has 176 undocumented exports and 323
// uncommented classes — and a check that ships red is one people learn to scroll past, which enforces nothing. What
// it asks for is the thing that stops the next person rebuilding what you just wrote: one sentence saying what it
// is FOR, in words someone would search.
if (flag("new-css") || flag("new")) {
    const { execFileSync } = await import("node:child_process");
    const base = opt("new-css") || opt("new") || "origin/main";
    // `--staged` compares the base to the INDEX, which is the only thing a pre-commit hook may ask about:
    // `base...HEAD` diffs COMMITS, so the hook passed cleanly with an undocumented class staged — it was checking
    // the state before the change it was called to check. CI wants the commit range; the hook wants what is about
    // to become one, and they are not the same diff.
    const range = flag("staged") ? ["diff", "--cached", "--unified=0", base] : ["diff", "--unified=0", `${base}...HEAD`];
    let diff, srcDiff = "";
    try {
        diff = execFileSync("git", [...range, "--", ...CSS_FILES], { cwd: ROOT, encoding: "utf8" });
        // `-U0` with a file header per hunk, so an added declaration can be attributed to its file.
        if (flag("new")) srcDiff = execFileSync("git", [...range, "--", "src"], { cwd: ROOT, encoding: "utf8" });
    }
    catch {
        // No such ref (a shallow clone, a fork with no origin/main). SKIP rather than fail: a ratchet that blocks a
        // build because it could not find a baseline teaches people to pass --no-verify, and then it enforces nothing.
        console.log(`index: cannot diff against ${base} — skipping the CSS ratchet.`);
        process.exit(0);
    }
    const docs = cssClassDocs();
    const added = new Set();
    for (const line of diff.split("\n")) {
        if (!line.startsWith("+") || line.startsWith("+++")) continue;
        const m = /^\+(\.[a-z][a-z0-9-]*)(?:[,\s{:])/.exec(line);
        if (m && docs.get(m[1]) === false && !documentedAncestor(m[1], docs)) added.add(m[1]);
    }
    // Exported symbols this change ADDS, matched against the index by name and file: the index already knows which
    // carry a docstring, so the diff only has to say which ones are new. A declaration that merely MOVED lines is
    // caught too, which is correct — a symbol with no docstring is unfindable wherever it sits.
    const bad = [];
    if (flag("new") && srcDiff) {
        const undoc = new Map();
        for (const r of records) if (r.exported && !r.doc && r.kind !== "css" && r.kind !== "file") undoc.set(`${r.where.split(":")[0]}\t${r.name}`, r);
        let file = "";
        for (const line of srcDiff.split("\n")) {
            const f = /^\+\+\+ b\/(.+)$/.exec(line);
            if (f) { file = f[1]; continue; }
            if (!line.startsWith("+") || line.startsWith("+++")) continue;
            const m = /^\+export\s+(?:default\s+)?(?:declare\s+)?(?:async\s+)?(?:function|class|interface|type|enum|const|let|var)\s+([A-Za-z_$][\w$]*)/.exec(line);
            const hit = m && undoc.get(`${file}\t${m[1]}`);
            if (hit && !bad.includes(hit)) bad.push(hit);
        }
    }
    if (added.size || bad.length) {
        for (const c of added) console.log(`css\t${c}\t— NO COMMENT (added on this branch)`);
        for (const r of bad) console.log(`${r.kind}\t${r.name}\t${r.where}\t— NO DOCSTRING (added on this branch)`);
        if (added.size) console.error(`\n${added.size} new CSS class(es) with nothing to search on.`);
        if (bad.length) console.error(`${bad.length} newly exported symbol(s) with no docstring — invisible to`
            + ` \`node scripts/index.mjs <concept>\`, so the next person rebuilds them.`);
        console.error(`Say what it is FOR in a comment above it — that sentence is what stops the second copy.`);
        process.exit(1);
    }
    console.log(`index: everything added since ${base} is documented.`);
    process.exit(0);
}

// ---- query -------------------------------------------------------------------------------------------------
// A cold build against the budget. A WARNING annotation lands on the diff (the repo's pattern for advice —
// check-file-size does the same) and the hard cap is the backstop for a change in kind rather than in size.
if (flag("check-speed")) {
    const t0 = performance.now();
    const cold = buildIndex({ rebuild: true });
    const ms = Math.round(performance.now() - t0);
    const per = (ms / Math.max(1, cold.files)).toFixed(2);
    const summary = `${ms} ms for ${cold.files} files, ${cold.records.length} records (${per} ms/file)`;
    // WHAT TO DO WHEN IT TRIPS, said here rather than left to whoever meets it: the first question is always
    // whether something changed in KIND, because growth cannot get you here on its own. Only once that is ruled
    // out is "make it faster" the right problem, and the honest last resort is a different language — the hub repo
    // (window-ml-hub) already carries a Rust toolchain, and this cache file is the interface a rewrite would keep.
    const advice = `First look for a change in KIND, not size: a parser or TypeScript program behind the scan, a`
        + ` per-file subprocess, an O(n²) walk. Growth alone cannot reach this — it is ~0.5 ms/file, so the repo`
        + ` would need thousands of files. If the implementation is genuinely already lean, the next moves are to`
        + ` narrow what is indexed, or to port the scanner to a faster language (the hub repo has Rust; .index-cache.tsv`
        + ` is the interface a port would keep).`;
    if (ms > SPEED_FAIL_MS) {
        console.error(`::error::The code index took ${summary}, past its ${SPEED_FAIL_MS} ms cap. At this cost it stops`
            + ` being reachable mid-thought, and an index nobody runs prevents nothing. ${advice}`);
        process.exit(1);
    }
    // Annotations, so the number lands ON the diff rather than in a log nobody opens — which is what makes it a
    // TREND you can see getting worse, instead of a threshold you only meet on the day it breaks.
    if (ms > SPEED_WARN_MS) console.log(`::warning::The code index took ${summary} — over its ${SPEED_WARN_MS} ms budget`
        + ` (hard cap ${SPEED_FAIL_MS} ms). Attend to it now, while it is still a warning. ${advice}`);
    else console.log(`::notice::The code index built in ${summary}, inside its ${SPEED_WARN_MS} ms budget.`);
    process.exit(0);
}

if (flag("stats")) {
    const by = {};
    for (const r of records) by[r.kind] = (by[r.kind] || 0) + 1;
    console.log(`files\t${files}\nrescanned\t${scanned}\nrecords\t${records.length}`);
    for (const [k, n] of Object.entries(by).sort()) console.log(`${k}\t${n}`);
    process.exit(0);
}

// A source file with NO header comment: invisible to a search by purpose, which is the whole point of the row.
if (flag("headerless")) {
    const bad = records.filter((r) => r.kind === "file" && !r.doc);
    for (const r of bad) console.log(`${r.where}\t— NO HEADER COMMENT`);
    if (bad.length) {
        console.error(`\n${bad.length} source file(s) with no header. A file nobody can find by purpose gets REBUILT:`
            + ` open it with a comment saying what the module is for, in words someone would search.`);
        process.exit(1);
    }
    console.log("index: every source file has a header.");
    process.exit(0);
}

// An undocumented EXPORT is invisible to a concept search, so the next person rebuilds it. CSS is a ratchet
// (--new-css) rather than part of this, because 323 of the stylesheet's classes have no comment and a check that
// ships red is one people learn to scroll past.
if (flag("undocumented")) {
    const bad = records.filter((r) => r.exported && !r.doc && r.kind !== "css" && r.kind !== "file");
    for (const r of bad) console.log(`${r.kind}\t${r.name}\t${r.where}\t— NO DOCSTRING`);
    if (bad.length) { console.error(`\n${bad.length} undocumented — they cannot be found by concept, so they will be rebuilt.`); process.exit(1); }
    console.log("index: all documented");
    process.exit(0);
}

let rows = records;
if (kinds) rows = rows.filter((r) => kinds.has(r.kind));
if (wantExported) rows = rows.filter((r) => r.exported);
if (wantLocal) rows = rows.filter((r) => !r.exported);
if (queryArg) {
    let re;
    try { re = new RegExp(queryArg, "i"); }
    catch (e) { console.error(`index: ${queryArg} is not a regex (${e.message})`); process.exit(2); }
    // Over the NAME, the SUMMARY and the path — searching prose is the point, and a path match is how `--kind file`
    // answers "anything under sidebar/". The signature joins in only when it is being shown.
    rows = rows.filter((r) => re.test(r.name) || re.test(r.doc) || re.test(r.where) || (withSig && re.test(r.sig)));
}

rows.sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name));
for (const r of rows)
    console.log([r.kind, r.name, r.where, ...(withSig ? [r.sig] : []), r.doc || "(undocumented)"].join("\t"));
