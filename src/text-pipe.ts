// text-pipe.ts — a tiny, SAFE shell-pipeline interpreter for scanning a text stream a tool produced
// (fetch_url's Markdown, navigate's text verify, …). It's the SAFE subset of a shell: pure line-based
// text→text transforms — no I/O, no filesystem, no eval, no network. There is nothing to escape TO (it runs
// over a STRING we already have), so unlike readonly-exec this needs correctness tests, not a red-team suite;
// the one theoretical footgun (a catastrophic grep regex) is defanged because grep is PER-LINE and the input
// is already clipped.
//
// A MODELED dialect (like readonly-exec): only the modeled verbs/flags run; anything else throws an actionable
// error — it is NOT a real shell. The verbs are PIPE_CMDS below (the single source for every message,
// prompt and tool-parameter description that names them); chain them with `|`.
// The input text is the pipeline's stdin (no `cat`); each stage transforms the lines and feeds the next.

import { jsonShape } from "./dom";

/** Every verb the dialect implements — the SINGLE SOURCE for the refusal message AND for the system prompt's
 *  "here is what you can pipe" list. A prompt that advertises a verb the dialect lacks costs the model a whole
 *  turn to discover, which has happened once already; deriving both from this makes that drift impossible. */
export const PIPE_CMDS = ["grep", "sed", "head", "tail", "wc", "count", "sort", "uniq", "keys", "values", "schema", "type"] as const;
const CMDS = `${PIPE_CMDS.join(" · ")} · a .path`;

/** What each verb ACCEPTS, in the model's words — the flags and the one-line semantics. Typed as a total
 *  Record over {@link PIPE_CMDS}, so adding a verb without describing it is a COMPILE error, not a doc that
 *  quietly goes stale. Feeds {@link PIPE_SYNTAX}; nothing else should spell a verb list out by hand. */
const PIPE_USAGE: Record<(typeof PIPE_CMDS)[number], string> = {
    grep: "grep PATTERN (-i -v -n -c -F -w -o -E, context -A/-B/-C N)",
    sed: "sed s/PATTERN/REPLACEMENT/ (flags g i; SUBSTITUTION only — no addresses, no other commands). Another delimiter works for a pattern full of slashes, but QUOTE it, since | separates stages: sed 's|http://a|X|'",
    head: "head (-n N)",
    tail: "tail (-n N)",
    wc: "wc (-l -w -c)",
    count: "count (structure-aware size: array elements, table rows, object keys, else lines)",
    sort: "sort (-n -r -u -f)",
    uniq: "uniq (-c -i; adjacent only, so sort first)",
    keys: "keys (an object's keys, or a table's columns)",
    values: "values (an object's values)",
    schema: "schema (the SHAPE of a JSON value, not the data — the cheapest read of something big)",
    type: "type (what the value actually is)",
};

/** The one-line hint every pipe ERROR path shows the model. Derived from {@link PIPE_CMDS} so a failed pipe
 *  can never advertise a SMALLER dialect than the one that just refused it — a model told the set is
 *  "grep · head · tail · wc · sort · uniq" will never reach for `schema` or a `.path`. */
export const PIPE_HINT = `The pipe is a small line-scanner (${CMDS}), NOT a real shell.`;

/** The hint to append to a FAILED pipe's message — {@link PIPE_HINT}, or nothing when the dialect's own error
 *  already named the verbs (the unknown-command refusal does). Without this the model reads the same twelve
 *  verbs twice in one tool result, which is noise it pays for in context. Returns a leading blank line so a
 *  caller can concatenate it unconditionally. */
export function pipeHint(message: string): string {
    return message.includes(CMDS) ? "" : `\n\n${PIPE_HINT}`;
}

/** The model-facing DESCRIPTION of the dialect: the single source for every `pipe` tool PARAMETER (fetch_url,
 *  navigate's text verify, interactives). Each tool prepends its own lead-in and appends its own escape hatch;
 *  the dialect itself is described here once. */
export const PIPE_SYNTAX =
    "It's an interpreted line-based environment (NOT a real shell); supported commands, chained with `|`: " +
    `${PIPE_CMDS.map(c => PIPE_USAGE[c]).join(", ")}, or a \`.path\` into JSON (\`.rows[0].name\`). ` +
    "E.g. \"grep -i pricing | head -n 20\", or \"grep -o '[0-9]+' | sort -n | tail -n 1\". " +
    "A stage's argument needs quoting if it contains spaces; you can also pass an ARRAY with one stage per " +
    "entry ([\"grep -E error|warn\", \"head 5\"]), which is never re-split, so a `|` inside a stage needs no quotes.";
const escapeRegex = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** Split on newlines, dropping a single trailing "\n" so a text that ends in a newline isn't seen as having a
 *  phantom empty last line (matches how the shell tools treat a trailing line terminator). */
const toLines = (text: string): string[] => text.replace(/\n$/, "").split("\n");
const fromLines = (lines: string[]): string => lines.join("\n");

/** Quote-aware split of a pipeline STRING into stage strings, on unquoted `|` only. Respects '…' and "…"
 *  (both literal — no expansion, so a `|` inside quotes stays part of the argument, e.g. `grep 'a|b'`), and
 *  keeps the quotes so {@link parseArgv} can still see them. Throws on an unterminated quote.
 *
 *  This is deliberately SEPARATE from argv parsing, and stages are never re-joined into a string once split:
 *  a stage carrying an unquoted `|` (an array entry — `["grep -E head|tail"]`) would be torn in two by a
 *  second split, which used to silently grep for `head` and then run `tail` as its own stage. */
export function splitStages(pipe: string): string[] {
    const out: string[] = [];
    let cur = "", q = "";
    for (const c of pipe) {
        if (q) { cur += c; if (c === q) q = ""; continue; }        // inside quotes: copy verbatim, `|` included
        if (c === "'" || c === '"') { q = c; cur += c; continue; }
        if (c === "|") { out.push(cur); cur = ""; continue; }
        cur += c;
    }
    if (q) throw new Error(`unterminated quote (${q}) in the pipe.`);
    out.push(cur);
    return out.map(s => s.trim()).filter(Boolean);   // drop empty stages (leading/trailing/`||`)
}

/** Quote-aware parse of ONE stage into argv. Unquoted whitespace ends an argument; quotes are literal (no
 *  expansion) and are consumed, so `grep 'a|b'` yields the two args `grep` and `a|b`. A `|` here is an
 *  ORDINARY character — the stage boundary was already decided by {@link splitStages} or by the caller
 *  handing us an array. Throws on an unterminated quote. */
function parseArgv(stage: string): string[] {
    const argv: string[] = [];
    let cur = "", hasCur = false, q = "";
    const endArg = () => { if (hasCur) { argv.push(cur); cur = ""; hasCur = false; } };
    for (const c of stage) {
        if (q) { if (c === q) q = ""; else { cur += c; hasCur = true; } continue; }
        if (c === "'" || c === '"') { q = c; hasCur = true; continue; }   // an empty '' is still an (empty) arg
        if (c === " " || c === "\t" || c === "\n") { endArg(); continue; }
        cur += c; hasCur = true;
    }
    if (q) throw new Error(`unterminated quote (${q}) in the pipe.`);
    endArg();
    return argv;
}

/** Resolve a pipe to its stages' argv. A STRING is split on unquoted `|`; an ARRAY is already one entry per
 *  stage and is NEVER re-split, so an entry may contain a bare `|` (regex alternation) with no quoting at
 *  all — the whole point of the array form. */
function pipelineArgv(pipe: string | string[]): string[][] {
    const stages = Array.isArray(pipe)
        ? pipe.filter(s => typeof s === "string" && s.trim()).map(s => s.trim())
        : splitStages(pipe);
    return stages.map(parseArgv).filter(a => a.length);
}

/** Peel single-char boolean flags + numeric flags from an argv, returning the set of flags, a map of numeric
 *  flags (e.g. -n 20, -A3, -C 2), and the leftover positionals. `numeric` names the flags that consume a
 *  number (either glued `-A3` or the next token `-A 3`); a bare `-5` maps to the `""` numeric key (head/tail).
 *  Unknown flags throw with the command's allowed set. */
function parseArgs(cmd: string, argv: string[], allowed: string, numeric: string): { flags: Set<string>; nums: Record<string, number>; pos: string[] } {
    const flags = new Set<string>(), nums: Record<string, number> = {}, pos: string[] = [];
    for (let i = 1; i < argv.length; i++) {
        const a = argv[i];
        if (a === "--") { pos.push(...argv.slice(i + 1)); break; }
        if (a.length > 1 && a[0] === "-" && !/^-\d/.test(a)) {
            // A cluster of single-char flags; a numeric flag consumes the rest of the token, else the next token.
            for (let j = 1; j < a.length; j++) {
                const f = a[j];
                if (numeric.includes(f)) {
                    const glued = a.slice(j + 1);
                    const raw = glued !== "" ? glued : argv[++i];
                    const nnum = Number(raw);
                    if (raw == null || !Number.isFinite(nnum)) throw new Error(`\`${cmd} -${f}\` needs a number.`);
                    nums[f] = nnum;
                    j = a.length;   // consumed the rest of this token
                } else if (allowed.includes(f)) flags.add(f);
                else throw new Error(`\`${cmd}\` doesn't support -${f}. Allowed: ${allowed.split("").map(x => "-" + x).join(" ") || "(none)"}${numeric ? ` and ${numeric.split("").map(x => "-" + x + " N").join(" / ")}` : ""}.`);
            }
        } else if (/^-\d+$/.test(a)) nums[""] = Number(a.slice(1));   // bare `-5` (head/tail old syntax)
        else pos.push(a);
    }
    return { flags, nums, pos };
}

function grep(lines: string[], argv: string[]): string[] {
    // `E` (extended regex) is accepted as a NO-OP — JS RegExp is already extended-style, so `grep -E` just works.
    const { flags, nums, pos } = parseArgs("grep", argv, "ivncFwoE", "ABC");
    if (!pos.length) throw new Error("`grep` needs a PATTERN, e.g. `grep -i pricing`.");
    const pattern = pos[0];
    const i = flags.has("i"), v = flags.has("v"), n = flags.has("n"), count = flags.has("c"), only = flags.has("o");
    let src = flags.has("F") ? escapeRegex(pattern) : pattern;
    if (flags.has("w")) src = `\\b(?:${src})\\b`;
    let testRe: RegExp, gRe: RegExp;
    try { testRe = new RegExp(src, i ? "i" : ""); gRe = new RegExp(src, i ? "gi" : "g"); }
    catch (e) { throw new Error(`\`grep\` — invalid regex ${JSON.stringify(pattern)} (${(e as Error).message}). Use -F for a literal string.`); }
    const A = nums.C ?? nums.A ?? 0, B = nums.C ?? nums.B ?? 0;
    const matched: number[] = [];
    for (let k = 0; k < lines.length; k++) { let m = testRe.test(lines[k]); if (v) m = !m; if (m) matched.push(k); }
    if (count) return [String(matched.length)];
    if (only && !v) {   // -o: emit each matching substring on its own line (grep -o)
        const out: string[] = [];
        for (const k of matched) for (const m of lines[k].matchAll(gRe)) out.push(n ? `${k + 1}:${m[0]}` : m[0]);
        return out;
    }
    const matchedSet = new Set(matched);
    if (!A && !B) return matched.map(k => (n ? `${k + 1}:${lines[k]}` : lines[k]));
    // With context (-A/-B/-C): grep marks a match line with `:` and a context line with `-`, and separates
    // non-adjacent groups with `--`.
    const inRange = (k: number): boolean => matched.some(mi => k >= mi - B && k <= mi + A);
    const out: string[] = [];
    let last = -Infinity;
    for (let k = 0; k < lines.length; k++) {
        if (!inRange(k)) continue;
        if (out.length && k - last > 1) out.push("--");
        const sep = matchedSet.has(k) ? ":" : "-";
        out.push(n ? `${k + 1}${sep}${lines[k]}` : lines[k]);
        last = k;
    }
    return out;
}

function headTail(cmd: "head" | "tail", lines: string[], argv: string[]): string[] {
    const { nums, pos } = parseArgs(cmd, argv, "", "n");
    // Accept a BARE count (`head 20`) as well as the shell forms (`head -n 20`, `head -20`). Models write the
    // bare form constantly; refusing it would burn a turn to teach a flag that changes nothing.
    const bare = pos.length && /^\d+$/.test(pos[0]) ? Number(pos[0]) : undefined;
    const n = nums.n ?? nums[""] ?? bare ?? 10;
    if (n < 0) throw new Error(`\`${cmd} -n\` needs a non-negative number.`);
    return cmd === "head" ? lines.slice(0, n) : lines.slice(Math.max(0, lines.length - n));
}

function wc(lines: string[], argv: string[]): string[] {
    const { flags } = parseArgs("wc", argv, "lwc", "");
    const nl = lines.length;
    const nw = lines.reduce((a, l) => a + (l.trim() ? l.trim().split(/\s+/).length : 0), 0);
    const nc = lines.join("\n").length;
    const parts: string[] = [];
    if (flags.has("l")) parts.push(String(nl));
    if (flags.has("w")) parts.push(String(nw));
    if (flags.has("c")) parts.push(String(nc));
    return [parts.length ? parts.join(" ") : `${nl} ${nw} ${nc}`];   // no flag → lines words chars
}

function sortLines(lines: string[], argv: string[]): string[] {
    const { flags } = parseArgs("sort", argv, "nruf", "");
    const num = flags.has("n"), fold = flags.has("f");
    const key = (l: string): string => (fold ? l.toLowerCase() : l);
    let out = [...lines].sort((a, b) => num
        ? (parseFloat(a) || 0) - (parseFloat(b) || 0) || key(a).localeCompare(key(b))
        : key(a).localeCompare(key(b)));
    if (flags.has("r")) out.reverse();
    if (flags.has("u")) { const seen = new Set<string>(); out = out.filter(l => { const k = key(l); if (seen.has(k)) return false; seen.add(k); return true; }); }
    return out;
}

/**
 * SUBSTITUTION only: `sed s/PATTERN/REPLACEMENT/[gi]`.
 *
 * Not sed the language — addresses, ranges, `d`, `y`, hold spaces and the rest would be a second language
 * living inside this one, and the dialect's whole discipline is that it refuses what it does not model
 * rather than half-implementing it. What is left is the thing a substitution is actually reached for:
 * rewriting matches on each line.
 *
 * Any delimiter is accepted, because a pattern containing `/` is the common case (a path, a URL) and
 * `s|a|b|` is how a shell user already writes that. `$1`-style backreferences work, since the replacement is
 * handed to `String.replace` as written.
 */
function sed(lines: string[], argv: string[]): string[] {
    // argv[0] is the verb itself (the dispatcher passes the whole stage), and the expression is everything
    // after it — rejoined, because a substitution may legitimately contain spaces.
    const expr = argv.slice(1).join(" ").trim();
    if (!expr) throw new Error("sed: nothing to do — write a substitution, e.g. sed s/old/new/g.");
    if (expr[0] !== "s") {
        throw new Error(`sed: only SUBSTITUTION is supported (s/PATTERN/REPLACEMENT/), not "${expr.split(/\s/)[0]}". `
            + "Addresses, ranges and sed's other commands are deliberately not modelled.");
    }
    const delim = expr[1];
    if (!delim || /[a-zA-Z0-9\\]/.test(delim)) {
        throw new Error("sed: expected a delimiter after s, e.g. s/old/new/ or s|old|new| — got " + JSON.stringify(expr) + ".");
    }
    // Split on UNESCAPED delimiters, so a pattern may contain the delimiter as \/ the way a shell user
    // would write it.
    const parts: string[] = [];
    let cur = "";
    for (let i = 2; i < expr.length; i++) {
        const c = expr[i];
        if (c === "\\" && expr[i + 1] === delim) { cur += delim; i++; continue; }
        if (c === delim) { parts.push(cur); cur = ""; continue; }
        cur += c;
    }
    parts.push(cur);
    if (parts.length < 2) {
        throw new Error(`sed: unterminated substitution — expected s${delim}PATTERN${delim}REPLACEMENT${delim}.`);
    }
    const [pattern, replacement, rawFlags = ""] = parts;
    const flags = rawFlags.trim();
    const bad = [...flags].find((f) => !"gi".includes(f));
    if (bad) throw new Error(`sed: unknown flag "${bad}" — only g (every match on a line) and i (ignore case) are supported.`);
    let re: RegExp;
    try { re = new RegExp(pattern, flags.includes("g") ? (flags.includes("i") ? "gi" : "g") : (flags.includes("i") ? "i" : "")); }
    catch (e) { throw new Error(`sed: ${String((e as Error).message)}. Escape a literal metacharacter, or use grep -F to match one literally.`); }
    return lines.map((l) => l.replace(re, replacement));
}

function uniq(lines: string[], argv: string[]): string[] {
    const { flags } = parseArgs("uniq", argv, "ci", "");
    const ci = flags.has("i"), showCount = flags.has("c");
    const key = (l: string): string => (ci ? l.toLowerCase() : l);
    const out: string[] = [];
    let prev: string | null = null, run = 0, prevLine = "";
    const flush = () => { if (prev !== null) out.push(showCount ? `${run} ${prevLine}` : prevLine); };
    for (const l of lines) {
        if (prev !== null && key(l) === prev) { run++; continue; }
        flush(); prev = key(l); prevLine = l; run = 1;
    }
    flush();
    return out;
}

// --- STRUCTURAL stages -------------------------------------------------------------------------------------
// The line verbs above are blind to structure, which is useless for the JSON a tool often returns: "the keys of
// this object" is not a line operation. These stages parse the stream as JSON, transform it, and re-emit JSON —
// so they compose with the line verbs in either order (`.rows | head 5`, `grep id | schema`).
//
// Syntax is chosen so the two families can't collide: line verbs are bare words (`head 20`), structural PATHS
// start with a dot (`.items[0].name`). So the JS spelling `.keys()` is deliberately NOT it — that is `keys`,
// and "the keys of that field" composes as `.items | keys`.
//
// They REFUSE non-JSON rather than guessing a shape for prose: a fabricated key list is worse than an honest
// "this isn't JSON" (the same posture as the read-only exec dialect — a gap degrades to asking, never to a
// wrong answer).
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** A short, honest name for a value — used in every refusal so the model can correct itself. */
export function describeValue(v: unknown): string {
    if (v === null) return "null";
    if (v === undefined) return "missing";
    if (Array.isArray(v)) return `an array of ${v.length}`;
    if (typeof v === "object") return `an object with ${Object.keys(v as object).length} keys`;
    return `a ${typeof v}`;
}

function parseJson(lines: string[], cmd: string): unknown {
    const text = fromLines(lines).trim();
    if (!(text.startsWith("{") || text.startsWith("[")))
        throw new Error(`\`${cmd}\` needs JSON, but this is plain text (${text.length} chars). Use the line commands instead (${CMDS.split(" · ").slice(0, 6).join(" · ")}).`);
    try { return JSON.parse(text); }
    catch (e) { throw new Error(`\`${cmd}\` — this looks like JSON but doesn't parse (${(e as Error).message}).`); }
}
const emit = (v: unknown): string[] => toLines(typeof v === "string" ? v : JSON.stringify(v, null, 2));

/** `.a.b[0]` → the value there. Names the segment that failed and what WAS available, so a wrong path is a
 *  one-step correction rather than a bare `undefined`. */
function pickPath(root: unknown, path: string): unknown {
    let cur = root;
    for (const step of path.slice(1).split(".").filter(Boolean)) {
        const m = /^([^[\]]*)((?:\[\d+\])*)$/.exec(step);
        if (!m) throw new Error(`can't read the path segment "${step}".`);
        const [, key, idx] = m;
        if (key) {
            if (!isObj(cur)) throw new Error(`".${key}" needs an object, but that part of the value is ${describeValue(cur)}.`);
            if (!(key in cur)) throw new Error(`no key "${key}". Available: ${Object.keys(cur).slice(0, 20).join(", ") || "(none)"}`);
            cur = cur[key];
        }
        for (const n of idx.match(/\d+/g) ?? []) {
            if (!Array.isArray(cur)) throw new Error(`"[${n}]" needs an array, but that part of the value is ${describeValue(cur)}.`);
            cur = cur[Number(n)];
        }
    }
    return cur;
}

function keysOf(lines: string[]): string[] {
    const j = parseJson(lines, "keys");
    // A table entered as {columns, rows} (a DataFrame pointer) — its keys are its COLUMNS, which is the answer
    // the question actually wants. Likewise an array of uniform objects.
    if (isObj(j) && Array.isArray(j.columns)) return emit(j.columns);
    if (Array.isArray(j)) {
        const first = j.find(isObj);
        if (!first) throw new Error(`\`keys\` needs an object (or an array of objects); this is ${describeValue(j)}.`);
        return emit(Object.keys(first));
    }
    if (!isObj(j)) throw new Error(`\`keys\` needs an object; this is ${describeValue(j)}.`);
    return emit(Object.keys(j));
}

/** `ml.pipe(source, pipe)` — the dialect over ANY string, not just a fetched body.
 *
 *  The `pipe` PARAMETER on fetch_url / navigate's verify / interactives only ever reaches that one tool's own
 *  output. A model holding text from anywhere else (a DOM survey, python's stdout, two fetches concatenated,
 *  something on `ml.state`) had to hand-roll the equivalent JS, and models write shell pipelines far more
 *  reliably than they write `.split("\n").filter(...).slice(...)`. This is the same dialect, callable inline —
 *  and it inverts the `pipe` parameter's own escape hatch ("for anything more complex, use exec"): from inside
 *  exec you can now go the other way too.
 *
 *  `source` is a string, or anything with a `.text` (a {@link FetchResult}), in which case its readable form is
 *  used — `.markdown` when the fetch distilled one, else `.text`. Accepting the whole result object is
 *  deliberate: a model WILL write `ml.pipe(await ml.fetch(url), ...)`, the same accommodation the Python
 *  prelude makes for `pd.read_csv('current')`.
 *
 *  Pure: no I/O, no DOM, no tokens spent. Throws the dialect's own actionable Error on a bad stage. */
export function mlPipe(source: unknown, pipe?: string | string[] | null): string {
    let text: unknown = source;
    if (source && typeof source === "object") {
        const r = source as { markdown?: unknown; text?: unknown };
        if (typeof r.text === "string" || typeof r.markdown === "string") text = r.markdown ?? r.text;
    }
    if (typeof text !== "string") {
        throw new Error(`ml.pipe needs a string (or a fetch result), got ${text === null ? "null" : Array.isArray(text) ? "an array" : typeof text}. For an object, JSON.stringify it first — the \`.path\`/keys/schema stages then read it.`);
    }
    if (pipe == null || (Array.isArray(pipe) ? !pipe.length : !pipe.trim())) return text;   // no stages = unchanged
    return runPipe(text, pipe);
}

/** Run a `grep | head | …` pipeline over `text`, returning the transformed text. Throws an actionable Error on
 *  an unknown/misused command (the caller surfaces it to the model). Pure — no side effects.
 *
 *  `pipe` is either the dialect STRING (`"grep -i x | head 5"`, split on unquoted `|`) or an ARRAY with one
 *  stage per entry (`["grep -E error|warn", "head 5"]`), which is never re-split — so a stage may contain a
 *  bare `|` with no quoting. The two forms are equivalent for stages that contain no `|`. */
export function runPipe(text: string, pipe: string | string[]): string {
    const stages = pipelineArgv(pipe);
    let lines = toLines(text);
    for (const argv of stages) {
        const cmd = argv[0];
        switch (cmd) {
            case "grep": lines = grep(lines, argv); break;
            case "head": lines = headTail("head", lines, argv); break;
            case "tail": lines = headTail("tail", lines, argv); break;
            case "wc": lines = wc(lines, argv); break;
            case "sort": lines = sortLines(lines, argv); break;
            case "uniq": lines = uniq(lines, argv); break;
            case "sed": lines = sed(lines, argv); break;
            case "cat": break;   // a harmless no-op if the model prefixes `cat |` out of habit
            // `count` is the STRUCTURE-AWARE size: elements of an array, rows of a table, keys of an object,
            // lines of text. `wc -l` counts LINES, which after a path stage means the lines of pretty-printed
            // JSON — `.rows | wc -l` on a 3-row table says 14, which is true and useless. This is the verb to
            // reach for after a path.
            case "count": {
                const text = fromLines(lines).trim();
                if (text.startsWith("{") || text.startsWith("[")) {
                    const j = parseJson(lines, "count");
                    if (Array.isArray(j)) { lines = [String(j.length)]; break; }
                    if (isObj(j) && Array.isArray(j.rows)) { lines = [String(j.rows.length)]; break; }   // a table
                    if (isObj(j)) { lines = [String(Object.keys(j).length)]; break; }
                }
                lines = [String(lines.length)];
                break;
            }
            case "keys": lines = keysOf(lines); break;
            case "values": {
                const j = parseJson(lines, "values");
                if (!isObj(j)) throw new Error(`\`values\` needs an object; this is ${describeValue(j)}.`);
                lines = emit(Object.values(j)); break;
            }
            // The SHAPE, not the data — the cheapest read of a big structure, and what to reach for first.
            // `jsonschema` is accepted as the same thing: models reach for that name.
            case "schema": case "jsonschema": lines = toLines(jsonShape(parseJson(lines, cmd))); break;
            case "type": {
                const text = fromLines(lines).trim();
                const looksJson = text.startsWith("{") || text.startsWith("[");
                lines = [looksJson ? describeValue(parseJson(lines, "type")) : `text, ${text.length} chars / ${lines.length} lines`];
                break;
            }
            default:
                if (cmd.startsWith(".")) { lines = emit(pickPath(parseJson(lines, cmd), cmd)); break; }
                throw new Error(`\`${cmd}\` isn't a supported text command. This is a small scanning pipeline (${CMDS}), NOT a real shell — for a transform, process the text in a script instead.`);
        }
    }
    return fromLines(lines);
}
