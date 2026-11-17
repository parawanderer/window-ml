#!/usr/bin/env node
// count-programs.mjs — which shell programs past Claude Code sessions ran (counts only, never command text).
//
// Reads every *.jsonl under ~/.claude/projects/ (top-level sessions and subagent transcripts), takes each assistant
// `Bash` tool_use, splits the command with a quote-aware tokenizer and counts PROGRAM NAMES. Command text, arguments,
// paths and tool output are never stored or printed: a name is kept only if it matches NAME_RE and appears in at least
// MIN_SESSIONS distinct sessions; everything else is folded into `(other)`. A command the tokenizer cannot parse
// (unterminated quote, `$(`, heredoc) is counted in `parse_failures` and contributes no programs.
//
//   node notebooks/shell/count-programs.mjs [out.json] [--root <dir>] [--watch top,ps,...]
//
// --watch names are exempt from the two-session filter (they are fixed names from the command line, never from a
// transcript), so "seen once" and "never seen" can be told apart for a list someone already has in mind.
//
// Method and caveats: notebooks/shell/make-shell-usage.py, the notebook's first cell.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

export const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,39}$/;
export const MIN_SESSIONS = 2;

const KEYWORDS_SKIP = new Set(["for", "case", "function", "select", "fi", "done", "esac", "}", "{", "(", ")", "[[", "]]", "[", "]", "in", ";;", "cd", "export", "source", "."]);
const KEYWORDS_STRIP = new Set(["if", "then", "else", "elif", "do", "while", "until", "!", "&&", "||"]);
// Wrappers that just run another program, each with the options that take a separate value.
const WRAPPERS = {
    env: { val: new Set(["-u", "-C", "-S", "--unset", "--chdir"]) },
    sudo: { val: new Set(["-u", "-g", "-h", "-C", "-p", "-U", "-r", "-t"]) },
    nohup: { val: new Set() },
    time: { val: new Set(["-f", "-o", "--format", "--output"]) },
    nice: { val: new Set(["-n", "--adjustment"]) },
    caffeinate: { val: new Set(["-t", "-w"]) },
    xargs: { val: new Set(["-I", "-n", "-P", "-L", "-d", "-E", "-s", "-a", "-J"]) },
    timeout: { val: new Set(["-s", "-k", "--signal", "--kill-after"]), duration: true },
};
// Shell builtins (bash/zsh `type -t` says builtin or keyword); anything else counts as external.
const BUILTINS = new Set(["echo", "printf", "cd", "export", "source", ".", "set", "unset", "read", "test", "type", "alias", "unalias", "eval", "exec", "exit", "return", "shift", "trap", "wait", "kill", "pwd", "true", "false", ":", "command", "builtin", "local", "declare", "typeset", "readonly", "umask", "ulimit", "jobs", "fg", "bg", "hash", "let", "getopts", "pushd", "popd", "dirs", "history", "which", "whence", "where", "setopt", "unsetopt", "break", "continue", "time"]);
export const isBuiltin = (n) => BUILTINS.has(n);

/**
  * Tokenize one command into simple commands (arrays of words). Words are unquoted and carry NO structure beyond their
  * text; `$(...)` and backtick bodies are parsed recursively into extra commands and the word becomes "\0".
  * Throws on a parse failure (unterminated quote, paren or heredoc).
  */
export function parseCommands(src, depth = 0) {
    if (depth > 6) throw new Error("depth");
    const out = [];
    let words = [];
    let cur = "";
    let has = false; // a word is in progress (an empty "" still is one)
    let skipNext = false; // after a redirection operator: its target is not a word
    const heredocs = [];
    const flushWord = () => {
        if (!has) return;
        if (skipNext) skipNext = false;
        else if (/^(\d*|&)?(>>?|<<?<?|>&|<&|>\|)$/.test(cur) && !cur.includes("\0")) skipNext = !/^\d*>&$|^\d*<&$/.test(cur);
        else if (/^(\d*|&)?(>>?|<)[^&]/.test(cur) && !cur.includes("\0")) { /* `>file`, `2>file`: target attached */ }
        else words.push(cur);
        cur = ""; has = false;
    };
    const endCmd = () => { flushWord(); if (words.length) out.push(words); words = []; skipNext = false; };
    const n = src.length;
    let i = 0;
    /** Read the body of $( ... ) starting after the "(": returns the text and the index after the ")". */
    const readParen = (start) => {
        let d = 1, j = start;
        while (j < n) {
            const c = src[j];
            if (c === "\\") { j += 2; continue; }
            if (c === "'") { const k = src.indexOf("'", j + 1); if (k < 0) throw new Error("quote"); j = k + 1; continue; }
            if (c === '"') { j++; while (j < n && src[j] !== '"') { if (src[j] === "\\") j++; j++; } if (j >= n) throw new Error("quote"); j++; continue; }
            if (c === "(") d++;
            else if (c === ")" && --d === 0) return [src.slice(start, j), j + 1];
            j++;
        }
        throw new Error("paren");
    };
    const sub = (body) => { for (const c of parseCommands(body, depth + 1)) out.push(c); };
    while (i < n) {
        const c = src[i];
        if (c === "\\") { if (src[i + 1] === "\n") { i += 2; continue; } cur += src[i + 1] ?? ""; has = true; i += 2; continue; }
        if (c === "'") { const k = src.indexOf("'", i + 1); if (k < 0) throw new Error("quote"); cur += src.slice(i + 1, k); has = true; i = k + 1; continue; }
        if (c === '"') {
            i++; has = true;
            while (i < n && src[i] !== '"') {
                if (src[i] === "\\") { cur += src[i + 1] ?? ""; i += 2; continue; }
                if (src[i] === "$" && src[i + 1] === "(") { const [b, e] = readParen(i + 2); sub(b); cur += "\0"; i = e; continue; }
                if (src[i] === "`") { const k = src.indexOf("`", i + 1); if (k < 0) throw new Error("tick"); sub(src.slice(i + 1, k)); cur += "\0"; i = k + 1; continue; }
                cur += src[i++];
            }
            if (i >= n) throw new Error("quote");
            i++; continue;
        }
        if (c === "$" && src[i + 1] === "(") {
            if (src[i + 2] === "(") { // arithmetic $(( ... )): not a command
                const [, e] = readParen(i + 2); cur += "\0"; has = true; i = e; continue;
            }
            const [b, e] = readParen(i + 2); sub(b); cur += "\0"; has = true; i = e; continue;
        }
        if (c === "`") { const k = src.indexOf("`", i + 1); if (k < 0) throw new Error("tick"); sub(src.slice(i + 1, k)); cur += "\0"; has = true; i = k + 1; continue; }
        if ((c === "<" || c === ">") && src[i + 1] === "(") { const [b, e] = readParen(i + 2); sub(b); cur += "\0"; has = true; i = e; continue; } // process substitution
        if (c === "<" && src[i + 1] === "<" && src[i + 2] !== "<") { // heredoc: note the terminator, skip the body after the newline
            let j = i + 2; if (src[j] === "-") j++;
            while (src[j] === " " || src[j] === "\t") j++;
            let tag = "";
            while (j < n && !/[\s;|&()<>]/.test(src[j])) {
                if (src[j] === "'" || src[j] === '"') { const q = src[j]; const k = src.indexOf(q, j + 1); if (k < 0) throw new Error("heredoc"); tag += src.slice(j + 1, k); j = k + 1; } else if (src[j] === "\\") { tag += src[j + 1] ?? ""; j += 2; } else tag += src[j++];
            }
            if (!tag) throw new Error("heredoc");
            heredocs.push({ tag, dash: src[i + 2] === "-" });
            flushWord(); skipNext = false; i = j; continue; // the redirection target is the tag, already consumed
        }
        if (c === "\n") {
            endCmd(); i++;
            while (heredocs.length) { // skip body lines until the terminator
                const h = heredocs.shift(); let found = false;
                while (i < n) {
                    let k = src.indexOf("\n", i); if (k < 0) k = n;
                    let line = src.slice(i, k); i = Math.min(k + 1, n);
                    if (h.dash) line = line.replace(/^\t+/, "");
                    if (line === h.tag) { found = true; break; }
                }
                if (!found) throw new Error("heredoc");
            }
            continue;
        }
        if (c === ";" || c === "|" || c === "&" || c === "(" || c === ")") {
            if (c === "&" && (src[i + 1] === ">" || (cur !== "" && /\d$/.test(cur) && false))) { cur += c; has = true; i++; continue; } // &> redirect
            if (c === "&" && cur !== "" && (src[i - 1] === ">" || src[i - 1] === "<")) { cur += c; i++; continue; } // 2>&1
            endCmd(); while (src[i + 1] === c && c !== "(" && c !== ")") i++; i++; continue;
        }
        if (c === " " || c === "\t") { flushWord(); i++; continue; }
        if (c === "#" && !has) { while (i < n && src[i] !== "\n") i++; continue; }
        cur += c; has = true; i++;
    }
    if (heredocs.length && !/^\s*$/.test("")) { /* heredoc opened on the last line: body missing */ throw new Error("heredoc"); }
    endCmd();
    return out;
}

const isAssign = (w) => /^[A-Za-z_][A-Za-z0-9_]*(\+)?=/.test(w);
const baseName = (w) => (w.includes("/") ? w.slice(w.lastIndexOf("/") + 1) : w);

/**
  * From one simple command's words: the wrappers it runs through and the program it runs, plus (for an interpreter)
  * the sub-name of what the interpreter runs. Returns null when there is nothing to count (a builtin we skip, a keyword).
  */
export function classify(words) {
    let w = words.slice();
    const wrappers = [];
    for (let guard = 0; guard < 8; guard++) {
        while (w.length && isAssign(w[0])) w.shift();
        while (w.length && KEYWORDS_STRIP.has(w[0])) w.shift();
        if (!w.length) return null;
        const prog = baseName(w[0]);
        if (KEYWORDS_SKIP.has(prog) || KEYWORDS_SKIP.has(w[0])) return null;
        const spec = WRAPPERS[prog];
        if (!spec) break;
        wrappers.push(prog);
        w.shift();
        let needDur = !!spec.duration;
        while (w.length) {
            if (isAssign(w[0]) && prog === "env") { w.shift(); continue; }
            if (w[0].startsWith("-") && w[0] !== "-") { const takes = spec.val.has(w[0]); w.shift(); if (takes) w.shift(); continue; }
            if (needDur) { needDur = false; w.shift(); continue; }
            break;
        }
    }
    if (!w.length) return wrappers.length ? { wrappers, program: null, sub: null } : null;
    const program = baseName(w[0]);
    let sub = null;
    const args = w.slice(1);
    const firstPos = (valueFlags) => { for (let k = 0; k < args.length; k++) { const a = args[k]; if (a.startsWith("-")) { if (valueFlags.has(a)) k++; continue; } return a; } return null; };
    if (program === "node") {
        const a = firstPos(new Set(["--import", "-r", "--require", "--loader", "-e", "--eval", "-p", "--test-name-pattern", "--env-file"]));
        if (a && /\.(mjs|cjs|js|ts|mts)$/.test(a)) sub = baseName(a).replace(/\.[^.]+$/, "");
    } else if (program === "npm" || program === "pnpm" || program === "yarn") {
        const a = firstPos(new Set(["--prefix", "-w", "--workspace"]));
        if (a === "run" || a === "run-script") { const k = args.indexOf(a); sub = firstPos2(args.slice(k + 1)); } else sub = a;
    } else if (program === "npx") sub = firstPos(new Set(["-p", "--package", "-c"]));
    else if (/^python[0-9.]*$/.test(program)) {
        const m = args.indexOf("-m");
        if (m >= 0 && args[m + 1]) sub = args[m + 1]; else { const a = firstPos(new Set(["-W", "-X"])); if (a && /\.py$/.test(a)) sub = baseName(a).replace(/\.py$/, ""); }
    } else if (program === "uv") {
        const a = firstPos(new Set());
        if (a === "run") {
            const rest = args.slice(args.indexOf("run") + 1);
            for (let k = 0; k < rest.length; k++) { if (rest[k].startsWith("-")) { if (["--with", "--python", "-p", "--project", "--directory"].includes(rest[k])) k++; continue; } sub = /\.py$/.test(rest[k]) ? baseName(rest[k]).replace(/\.py$/, "") : baseName(rest[k]); break; }
        } else sub = a;
    }
    return { wrappers, program, sub };
}
function firstPos2(a) { for (const x of a) if (!x.startsWith("-")) return x; return null; }

/** Denial markers on an error tool_result, matched on the fixed leading phrase only; the text is never kept. */
export function denialKind(content) {
    const t = typeof content === "string" ? content : Array.isArray(content) ? content.map((x) => (x && x.text) || "").join("") : "";
    if (/^Permission for this action/.test(t)) return "auto";
    if (/^The user (doesn.t want to proceed|rejected)/.test(t)) return "user";
    return null;
}

function walk(dir, out = []) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p, out); else if (e.name.endsWith(".jsonl")) out.push(p);
    }
    return out;
}

async function main() {
    const args = process.argv.slice(2);
    let root = path.join(os.homedir(), ".claude", "projects");
    let outPath = null;
    let watch = new Set();
    for (let k = 0; k < args.length; k++) { if (args[k] === "--root") root = args[++k]; else if (args[k] === "--watch") watch = new Set(String(args[++k]).split(",").filter((x) => NAME_RE.test(x))); else outPath = args[k]; }
    const files = walk(root);
    const corpus = { files_top_level: 0, files_subagent: 0, sessions: 0, projects: 0, bash_tool_uses: 0, duplicate_tool_uses_skipped: 0, simple_commands: 0, parse_failures: 0, tool_results_matched: 0, denied_auto: 0, denied_user: 0, error_results_bash: 0 };
    const sessionsSeen = new Set(), projectsSeen = new Set(), seenUse = new Set();
    const P = new Map(); // program -> agg
    const W = new Map(); // wrapper -> agg
    const S = new Map(); // interp\0sub -> agg
    const bump = (m, key, sess, proj, date, extra) => {
        let a = m.get(key);
        if (!a) m.set(key, (a = { calls: 0, sessions: new Set(), projects: new Set(), first: date, last: date, denied_auto: 0, denied_user: 0 }));
        a.calls++; a.sessions.add(sess); a.projects.add(proj);
        if (date && (!a.first || date < a.first)) a.first = date;
        if (date && (!a.last || date > a.last)) a.last = date;
        if (extra) { a.denied_auto += extra.auto; a.denied_user += extra.user; }
    };
    for (const f of files) {
        const rel = path.relative(root, f).split(path.sep);
        const proj = rel[0];
        const isSub = rel.includes("subagents") || rel.length > 2;
        const sessId = isSub ? rel[1] : rel[rel.length - 1].replace(/\.jsonl$/, "");
        const sess = proj + "/" + sessId;
        if (isSub) corpus.files_subagent++; else corpus.files_top_level++;
        sessionsSeen.add(sess); projectsSeen.add(proj);
        const uses = new Map(); // tool_use id -> {entries:[{kind,key,sub}], date}
        const results = new Map();
        const rl = readline.createInterface({ input: fs.createReadStream(f), crlfDelay: Infinity });
        for await (const line of rl) {
            const hasUse = line.includes('"tool_use"'), hasRes = line.includes('"tool_result"');
            if (!hasUse && !hasRes) continue;
            let o; try { o = JSON.parse(line); } catch { continue; }
            const c = o.message && o.message.content;
            if (!Array.isArray(c)) continue;
            for (const b of c) {
                if (b && b.type === "tool_use" && b.name === "Bash" && typeof b.input?.command === "string") {
                    if (b.id && seenUse.has(b.id)) { corpus.duplicate_tool_uses_skipped++; continue; }
                    if (b.id) seenUse.add(b.id);
                    corpus.bash_tool_uses++;
                    const date = typeof o.timestamp === "string" ? o.timestamp.slice(0, 10) : null;
                    let entries = [];
                    try {
                        for (const words of parseCommands(b.input.command)) {
                            const r = classify(words);
                            if (!r) continue;
                            corpus.simple_commands++;
                            for (const wr of r.wrappers) entries.push({ m: W, key: wr });
                            if (r.program) {
                                const name = r.program;
                                entries.push({ m: P, key: name });
                                if (r.sub) entries.push({ m: S, key: name + "\0" + r.sub });
                                else if (["node", "npm", "npx", "uv"].includes(name) || /^python/.test(name)) entries.push({ m: S, key: name + "\0" });
                            }
                        }
                    } catch { corpus.parse_failures++; entries = []; }
                    uses.set(b.id, { entries, date });
                } else if (b && b.type === "tool_result" && b.tool_use_id) {
                    results.set(b.tool_use_id, b.is_error ? denialKind(b.content) || "err" : "ok");
                }
            }
        }
        for (const [id, u] of uses) {
            const res = results.get(id);
            if (res !== undefined) corpus.tool_results_matched++;
            if (res === "err") corpus.error_results_bash++;
            const extra = { auto: res === "auto" ? 1 : 0, user: res === "user" ? 1 : 0 };
            corpus.denied_auto += extra.auto; corpus.denied_user += extra.user;
            for (const e of u.entries) bump(e.m, e.key, sess, proj, u.date, extra);
        }
    }
    corpus.sessions = sessionsSeen.size; corpus.projects = projectsSeen.size;

    // Privacy filter: keep a name only if it looks like a program name and was seen in >= MIN_SESSIONS sessions.
    const fold = (m, keep) => {
        const kept = [], other = { calls: 0, names: 0, denied_auto: 0, denied_user: 0 };
        for (const [key, a] of m) {
            if (keep(key, a)) kept.push({ key, ...a, sessions: a.sessions.size, projects: a.projects.size });
            else { other.calls += a.calls; other.names++; other.denied_auto += a.denied_auto; other.denied_user += a.denied_user; }
        }
        kept.sort((x, y) => y.sessions - x.sessions || y.calls - x.calls || (x.key < y.key ? -1 : 1));
        return { kept, other };
    };
    const okName = (n, a) => NAME_RE.test(n) && (a.sessions.size >= MIN_SESSIONS || watch.has(n));
    const progs = fold(P, okName);
    const wraps = fold(W, okName);
    const subs = fold(S, (k, a) => { const [i, s] = k.split("\0"); return NAME_RE.test(i) && (s === "" || NAME_RE.test(s)) && a.sessions.size >= MIN_SESSIONS; });
    const manifestDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "src", "shell", "manifests");
    const manifests = fs.existsSync(manifestDir) ? new Set(fs.readdirSync(manifestDir).filter((x) => x.endsWith(".json")).map((x) => x.slice(0, -5))) : new Set();
    const result = {
        corpus: { ...corpus, name_filter: NAME_RE.source, min_sessions: MIN_SESSIONS },
        programs: progs.kept.map(({ key, ...a }) => ({ name: key, ...a, kind: isBuiltin(key) ? "builtin" : "external", has_manifest: manifests.has(key) })),
        other: progs.other,
        wrappers: wraps.kept.map(({ key, ...a }) => ({ name: key, ...a })),
        subnames: subs.kept.map(({ key, ...a }) => { const [interp, name] = key.split("\0"); return { interp, name: name || null, ...a }; }),
        subnames_other: subs.other,
        watched: [...watch].sort(),
        manifests: [...manifests].sort(),
    };
    const text = JSON.stringify(result, null, 1) + "\n";
    if (outPath) fs.writeFileSync(outPath, text); else process.stdout.write(text);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
    main().catch(() => { process.stderr.write("count-programs failed (details withheld: they could contain command text)\n"); process.exit(1); });
}
