// text-pipe.ts — a tiny, SAFE shell-pipeline interpreter for scanning a text stream a tool produced
// (fetch_url's Markdown, navigate's text verify, …). It's the SAFE subset of a shell: pure line-based
// text→text transforms — no I/O, no filesystem, no eval, no network. There is nothing to escape TO (it runs
// over a STRING we already have), so unlike readonly-exec this needs correctness tests, not a red-team suite;
// the one theoretical footgun (a catastrophic grep regex) is defanged because grep is PER-LINE and the input
// is already clipped.
//
// A MODELED dialect (like readonly-exec): only the modeled verbs/flags run; anything else throws an actionable
// error — it is NOT a real shell. Supported verbs: grep · head · tail · wc · sort · uniq, chained with `|`.
// The input text is the pipeline's stdin (no `cat`); each stage transforms the lines and feeds the next.

const CMDS = "grep · head · tail · wc · sort · uniq";
const escapeRegex = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** Split on newlines, dropping a single trailing "\n" so a text that ends in a newline isn't seen as having a
 *  phantom empty last line (matches how the shell tools treat a trailing line terminator). */
const toLines = (text: string): string[] => text.replace(/\n$/, "").split("\n");
const fromLines = (lines: string[]): string => lines.join("\n");

/** Quote-aware parse of a pipeline string into stages of argv. Respects '…' and "…" (both literal — no
 *  expansion, so a `|` or space inside quotes stays part of the argument, e.g. `grep 'a|b'`). An unquoted `|`
 *  ends a stage; unquoted whitespace ends an argument. Throws on an unterminated quote. */
function parsePipeline(str: string): string[][] {
    const stages: string[][] = [];
    let argv: string[] = [], cur = "", hasCur = false, q = "";
    const endArg = () => { if (hasCur) { argv.push(cur); cur = ""; hasCur = false; } };
    const endStage = () => { endArg(); stages.push(argv); argv = []; };
    for (const c of str) {
        if (q) { if (c === q) q = ""; else { cur += c; hasCur = true; } continue; }
        if (c === "'" || c === '"') { q = c; hasCur = true; continue; }   // an empty '' is still an (empty) arg
        if (c === "|") { endStage(); continue; }
        if (c === " " || c === "\t" || c === "\n") { endArg(); continue; }
        cur += c; hasCur = true;
    }
    if (q) throw new Error(`unterminated quote (${q}) in the pipe.`);
    endStage();
    return stages.filter(s => s.length);   // drop empty stages (leading/trailing/`||`)
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
    const { nums } = parseArgs(cmd, argv, "", "n");
    const n = nums.n ?? nums[""] ?? 10;
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

/** Run a `grep | head | …` pipeline over `text`, returning the transformed text. Throws an actionable Error on
 *  an unknown/misused command (the caller surfaces it to the model). Pure — no side effects. */
export function runPipe(text: string, pipe: string): string {
    const stages = parsePipeline(pipe);
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
            case "cat": break;   // a harmless no-op if the model prefixes `cat |` out of habit
            default: throw new Error(`\`${cmd}\` isn't a supported text command. This is a small scanning pipeline (${CMDS}), NOT a real shell — for a transform, process the text in a script instead.`);
        }
    }
    return fromLines(lines);
}
