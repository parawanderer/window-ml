// js-scan.mjs — just enough JavaScript to find a string literal and know it is not inside a comment.
//
// It exists because CI's `tools` job runs with NO `node_modules`: "plain node reading files", which is what makes
// it a ten-second job rather than a thirty-second one. `scripts/test-index.mjs` and `scripts/test-cover.mjs` need
// to read declarations out of source, and reaching for TypeScript's parser (through `@ts-morph/common`) broke that
// property the first time either of them ran there.
//
// A full parser is not needed for the question. Both tools ask "which string follows this token" — a test's name,
// an import's specifier — and everything a naive regex gets wrong is one of three things: a string that contains
// the pattern, a comment that contains it, and a nested template. So this strips comments and REPLACES every
// string literal with a sentinel the source cannot contain, handing back the values separately. A regex over the
// result is then safe, because there is nothing left in it that a regex can misread.
//
// What it deliberately does not do: interpolation. A template with `${…}` in it has no constant value, so its
// parts are dropped and the sentinel marks it as unknowable — which is what both callers want, since a name or a
// specifier built at runtime is one they refuse to guess at rather than report wrongly.

/** The sentinel that stands in for a string. `\0` cannot appear in source, so it cannot collide with real text. */
const MARK = "\0";

/**
 * Strip comments and lift out string literals.
 *
 * @param {string} text the source
 * @returns {{ code: string, strings: { value: string|null, line: number }[] }}
 *   `code` has every comment blanked (newlines kept, so line numbers survive) and every string replaced by
 *   `\0<n>\0`, where `n` indexes `strings`. A `value` of null is a template with interpolation: it had a string
 *   there, and what it is cannot be known without running the program.
 */
export function scan(text) {
    const strings = [];
    let code = "";
    let i = 0, line = 1;
    const push = (s) => { code += s; for (const ch of s) if (ch === "\n") line++; };

    while (i < text.length) {
        const ch = text[i];
        const next = text[i + 1];

        // Comments: blanked, but their newlines are kept so every later line number is still right.
        if (ch === "/" && next === "/") {
            const end = text.indexOf("\n", i);
            i = end < 0 ? text.length : end;
            continue;
        }
        if (ch === "/" && next === "*") {
            const end = text.indexOf("*/", i + 2);
            const body = text.slice(i, end < 0 ? text.length : end + 2);
            push(body.replace(/[^\n]/g, " "));
            i = end < 0 ? text.length : end + 2;
            continue;
        }

        // REGEX LITERALS, consumed whole. Without this, `/doesn't report vision/` reads as the start of a string
        // and swallows everything to the next apostrophe — which in one file was ninety-five tests. Whether a `/`
        // opens a regex or divides cannot be known without parsing, so this is the usual heuristic: a regex can
        // only follow something that cannot end an expression.
        if (ch === "/" && startsRegex(code)) {
            const end = readRegex(text, i);
            push(text.slice(i, end).replace(/[^\n]/g, " "));
            i = end;
            continue;
        }

        // Strings and templates.
        if (ch === '"' || ch === "'" || ch === "`") {
            const at = line;
            const { value, end, interpolated } = readString(text, i);
            strings.push({ value: interpolated ? null : value, line: at });
            code += `${MARK}${strings.length - 1}${MARK}`;
            // The literal's own newlines still have to be counted, or everything after a multi-line template moves.
            for (const c of text.slice(i, end)) if (c === "\n") line++;
            i = end;
            continue;
        }

        push(ch);
        i++;
    }
    return { code, strings };
}

/** After these, a `/` opens a REGEX rather than dividing: none of them can end an expression. */
const BEFORE_REGEX = new Set("(,=:[!&|?{};+-*%<>~^".split(""));
const KEYWORDS_BEFORE_REGEX = ["return", "typeof", "case", "in", "of", "do", "else", "yield", "await", "delete", "void", "instanceof", "new"];

/** Does a `/` at the end of `code` open a regex? Decided by the last thing that is not whitespace. */
function startsRegex(code) {
    const trimmed = code.replace(/\s+$/, "");
    if (!trimmed) return true;
    const last = trimmed[trimmed.length - 1];
    if (BEFORE_REGEX.has(last)) return true;
    const word = trimmed.match(/[A-Za-z_$][\w$]*$/);
    return !!word && KEYWORDS_BEFORE_REGEX.includes(word[0]);
}

/** Where a regex literal starting at `i` ends. A `/` inside a character class does not close it. */
function readRegex(text, i) {
    let j = i + 1, inClass = false;
    while (j < text.length) {
        const ch = text[j];
        if (ch === "\\") { j += 2; continue; }
        if (ch === "\n") return j;               // an unterminated regex is not a regex; give up at the line end
        if (ch === "[") inClass = true;
        else if (ch === "]") inClass = false;
        else if (ch === "/" && !inClass) { j++; while (/[a-z]/.test(text[j] ?? "")) j++; return j; }
        j++;
    }
    return j;
}

/** Read one string or template starting at `i`. Handles escapes and `${…}` nesting; returns where it ends. */
function readString(text, i) {
    const quote = text[i];
    let out = "";
    let interpolated = false;
    let j = i + 1;
    while (j < text.length) {
        const ch = text[j];
        if (ch === "\\") { out += text[j + 1] ?? ""; j += 2; continue; }
        if (ch === quote) return { value: out, end: j + 1, interpolated };
        if (quote === "`" && ch === "$" && text[j + 1] === "{") {
            interpolated = true;
            // Skip to the matching brace, counting nesting so `${ {a:1} }` does not end it early.
            let depth = 1;
            j += 2;
            while (j < text.length && depth) {
                if (text[j] === "{") depth++;
                else if (text[j] === "}") depth--;
                j++;
            }
            continue;
        }
        out += ch;
        j++;
    }
    return { value: out, end: text.length, interpolated };   // unterminated: take what there is
}

/** The index a sentinel names, for a `\0<n>\0` found in scanned code. */
export const markIndex = (s) => Number(s.replace(/\0/g, ""));

/** A regex source fragment matching one lifted string, capturing its index. */
export const MARKED = "\\0(\\d+)\\0";

/** Which line an offset in scanned code falls on (1-based). */
export function lineAt(code, offset) {
    let n = 1;
    for (let i = 0; i < offset && i < code.length; i++) if (code[i] === "\n") n++;
    return n;
}
