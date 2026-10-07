// tokenizer.ts — the read-only exec dialect's tokenizer: source text to tokens, regex literals and template literals included.

import { NotInDialect } from "./limits";

// `ln` is the 1-based source line the token starts on. It exists for ONE purpose: when a script throws a
// runtime error, the model is told WHERE. That used to come free, because a throwing survey escalated to the
// approved path and `execErrorLine` read it off a real stack — but a runtime error is now answered here
// instead of escalating, and an interpreter's stack is the INTERPRETER's, not the script's.
export interface Tok { t: "num" | "str" | "name" | "punct" | "eof" | "template" | "regex"; v: string; ln: number; quasis?: string[]; exprs?: string[]; flags?: string; }

// After these tokens a `/` begins a REGEX (an expression is expected); after a value-producing token
// (a number/string/template, an identifier, or a closing `)`/`]`/`}`) a `/` is DIVISION. The keyword
// identifiers below are the value-EXCEPTIONS: a regex may follow them (`return /re/`, `typeof /re/`).
// A regex is pure (no side effect, no realm walk-back), so this only decides division-vs-regex, never safety.
const REGEX_PRECEDING_KEYWORDS = new Set(["return", "typeof", "instanceof", "in", "of", "void", "delete", "case", "do", "else", "yield", "await"]);

function regexAllowed(prev: Tok | undefined): boolean {
    if (!prev) return true;                                                  // start of input
    if (prev.t === "num" || prev.t === "str" || prev.t === "template" || prev.t === "regex") return false;
    if (prev.t === "name") return REGEX_PRECEDING_KEYWORDS.has(prev.v);
    if (prev.t === "punct") return !(prev.v === ")" || prev.v === "]" || prev.v === "}");
    return true;
}

// --- template literals (`a${x}b`) ---------------------------------------------------------------
// Pure string concatenation with interpolated expressions — no new capability (each ${expr} runs
// through the same eval/mediation). The tokenizer extracts the literal QUASIS + the raw SOURCE of each
// interpolation; the parser re-tokenizes+parses each source, so nesting/objects/quotes just work.
// `skipTemplateSpan`/`findExprEnd` are mutually recursive so nested templates + braces are matched right.
function skipTemplateSpan(src: string, start: number): number {   // start = opening backtick → index AFTER the close
    let j = start + 1;
    while (j < src.length) {
        const c = src[j];
        if (c === "\\") { j += 2; continue; }
        if (c === "`") return j + 1;
        if (c === "$" && src[j + 1] === "{") { j = findExprEnd(src, j + 2) + 1; continue; }
        j++;
    }
    throw new NotInDialect("unterminated template literal");
}

function findExprEnd(src: string, start: number): number {   // start = just after `${` → index of the matching `}`
    let depth = 1, j = start, quote = "";
    while (j < src.length) {
        const c = src[j];
        if (quote) { if (c === "\\") { j += 2; continue; } if (c === quote) quote = ""; j++; continue; }
        if (c === '"' || c === "'") { quote = c; j++; continue; }
        if (c === "`") { j = skipTemplateSpan(src, j); continue; }
        if (c === "{") { depth++; j++; continue; }
        if (c === "}") { if (--depth === 0) return j; j++; continue; }
        j++;
    }
    throw new NotInDialect("unterminated template expression");
}

function scanTemplate(src: string, start: number): { quasis: string[]; exprs: string[]; end: number } {
    let i = start + 1;
    const quasis: string[] = [], exprs: string[] = [];
    let cur = "";
    while (i < src.length) {
        const c = src[i];
        if (c === "\\") { const e = src[i + 1]; cur += e === "n" ? "\n" : e === "t" ? "\t" : e === "r" ? "\r" : e; i += 2; continue; }
        if (c === "`") { quasis.push(cur); return { quasis, exprs, end: i + 1 }; }
        if (c === "$" && src[i + 1] === "{") { quasis.push(cur); cur = ""; const end = findExprEnd(src, i + 2); exprs.push(src.slice(i + 2, end)); i = end + 1; continue; }
        cur += c; i++;
    }
    throw new NotInDialect("unterminated template literal");
}

// Multi-char punctuators, longest first so greedy matching is correct.
const PUNCT = [
    "===", "!==", "...", "?.", "=>", "==", "!=", "<=", ">=", "&&", "||", "??", "**",
    // Compound assignment and the counter operators. They must come BEFORE the single characters or greedy
    // matching takes the `+` out of `+=`; `a + +b` is unaffected, since the space stops `++` matching.
    "+=", "-=", "*=", "/=", "%=", "++", "--",
    ".", ",", "(", ")", "[", "]", "{", "}", "?", ":", "!", "<", ">",
    "+", "-", "*", "/", "%", "=", ";",
];

/** The compound assignments, mapped to the binary operator each one applies. No `||=`/`&&=`/`??=`: those
 *  short-circuit, so whether the write happens at all depends on the value, and a form whose effect you have to
 *  evaluate the operand to predict is the wrong one to be adding to a dialect that exists to be predictable. */
export const COMPOUND: Record<string, string> = { "+=": "+", "-=": "-", "*=": "*", "/=": "/", "%=": "%" };

/** Split a survey's source into tokens, each stamped with its 1-based line; throws NotInDialect on what it cannot lex. */
export function tokenize(src: string): Tok[] {
    const toks: Tok[] = [];
    let i = 0;
    // The line a token starts on. A single cursor walked forward, never rescanned: every push below happens
    // while `i` is still at the token's first character, and pushes run in increasing `i`.
    let lineAt = 0, lineNo = 1;
    const ln = (): number => { while (lineAt < i) { if (src[lineAt] === "\n") lineNo++; lineAt++; } return lineNo; };
    const isIdStart = (c: string) => /[A-Za-z_$]/.test(c);
    const isId = (c: string) => /[A-Za-z0-9_$]/.test(c);
    while (i < src.length) {
        const c = src[i];
        if (c === " " || c === "\t" || c === "\n" || c === "\r") { i++; continue; }
        // Line & block comments — the model sometimes annotates its surveys.
        if (c === "/" && src[i + 1] === "/") { while (i < src.length && src[i] !== "\n") i++; continue; }
        if (c === "/" && src[i + 1] === "*") { i += 2; while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) i++; i += 2; continue; }
        // A REGEX LITERAL — only where an expression is expected (else `/` is division, handled by PUNCT
        // below). Scan the body honouring `\`-escapes and `[...]` char classes (where `/` is literal), then
        // the flags. The pattern is compiled to a real RegExp at eval time; a regex is a pure value, so this
        // grants no new capability — it just lets the common `.replace(/…/g, …)` / `.match(/…/)` survey run.
        if (c === "/" && regexAllowed(toks[toks.length - 1])) {
            let j = i + 1, inClass = false, body = "";
            while (j < src.length) {
                const ch = src[j];
                if (ch === "\n") throw new NotInDialect("unterminated regex");
                if (ch === "\\") { body += ch + (src[j + 1] ?? ""); j += 2; continue; }
                if (ch === "[") { inClass = true; body += ch; j++; continue; }
                if (ch === "]") { inClass = false; body += ch; j++; continue; }
                if (ch === "/" && !inClass) break;
                body += ch; j++;
            }
            if (j >= src.length || src[j] !== "/") throw new NotInDialect("unterminated regex");
            j++;   // past the closing `/`
            let flags = "";
            while (j < src.length && /[a-z]/i.test(src[j])) { flags += src[j]; j++; }
            toks.push({ t: "regex", v: body, flags, ln: ln() }); i = j; continue;
        }
        if (c === "`") { const { quasis, exprs, end } = scanTemplate(src, i); toks.push({ t: "template", v: "", quasis, exprs, ln: ln() }); i = end; continue; }
        if (c >= "0" && c <= "9") {
            let j = i + 1;
            while (j < src.length && /[0-9.]/.test(src[j])) j++;
            toks.push({ t: "num", v: src.slice(i, j), ln: ln() }); i = j; continue;
        }
        if (c === '"' || c === "'") {
            let j = i + 1, out = "";
            while (j < src.length && src[j] !== c) {
                if (src[j] === "\\") {
                    const e = src[j + 1];
                    out += e === "n" ? "\n" : e === "t" ? "\t" : e === "r" ? "\r" : e;
                    j += 2;
                } else { out += src[j]; j++; }
            }
            if (j >= src.length) throw new NotInDialect("unterminated string");
            toks.push({ t: "str", v: out, ln: ln() }); i = j + 1; continue;
        }
        if (isIdStart(c)) {
            let j = i + 1;
            while (j < src.length && isId(src[j])) j++;
            toks.push({ t: "name", v: src.slice(i, j), ln: ln() }); i = j; continue;
        }
        const p = PUNCT.find(x => src.startsWith(x, i));
        if (!p) throw new NotInDialect(`unexpected character '${c}'`);
        toks.push({ t: "punct", v: p, ln: ln() }); i += p.length; continue;
    }
    toks.push({ t: "eof", v: "", ln: ln() });
    return toks;
}
