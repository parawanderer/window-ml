// script-grammar.ts — the narrow sed script and awk program a program manifest describes (PROGRAM_MANIFEST.md, "sed and awk").

// A sed script or an awk program is a second language inside one argument, and the commands that write a file or start
// a program (`w`, `e`, `r`, `s///w`, `system()`, `print > f`, `cmd | getline`) live in it, not in the argv. A manifest
// cannot list them as flags, so `script: "sed" | "awk"` on a command hands the text to these checkers. Each one ACCEPTS
// only a small grammar and returns why anything else is refused; a refusal only makes the call ask. Neither interprets the
// text: they decide whether every implementation the manifest describes would read nothing but those commands.

/** Where a delimited part ends that is not a regular expression (an `s` replacement, a `y` string), as both seds read it
 *  (GNU `match_slash` with `regex` false, BSD `compile_subst`): a backslash escapes the next character, and the first
 *  unescaped delimiter ends it. Returns the index just past the delimiter, or -1 when a newline or the end comes first. */
function plainDelimitedEnd(s: string, at: number, delim: string): number {
    for (let i = at; i < s.length; i++) {
        const c = s[i];
        if (c === "\n") return -1;
        if (c === delim) return i + 1;
        if (c === "\\") { i++; if (i >= s.length || s[i] === "\n") return -1; }
    }
    return -1;
}

/** Where a bracket expression ends, as GNU sed's `snarf_char_class` reads it (sed/compile.c, 4.9): `at` is just past
 *  the `[`. A leading `^`, then a leading `]`, are members; then a state machine where `[` followed by `.`, `:` or `=`
 *  opens a class, that same character starts closing it, and a `]` then closes it (a `[` in that state does not reset
 *  it, unlike BSD). Returns the index just past the bracket's `]`, or -1. */
function gnuBracketEnd(s: string, at: number): number {
    let i = at;
    if (s[i] === "^") i++;
    if (s[i] === "]") i++;
    let state = 0;
    let delim = "";
    for (; i < s.length; i++) {
        const ch = s[i];
        if (ch === "\n") return -1;
        if (ch === "." || ch === ":" || ch === "=") {
            if (state === 1) { delim = ch; state = 2; continue; }
            if (state === 2 && ch === delim) { state = 3; continue; }
        } else if (ch === "[") {
            if (state === 0) state = 1;
            continue;
        } else if (ch === "]") {
            if (state === 0 || state === 1) return i + 1;
            if (state === 3) state = 0;
        }
        state &= ~1;
    }
    return -1;
}

/** Where a regular expression's delimited part ends, as GNU sed's `match_slash` reads it: the first delimiter ends it,
 *  a backslash escapes the next character, and a bracket expression is skipped whole (`gnuBracketEnd`). Returns the
 *  index just past the delimiter, or -1. */
function gnuRegexEnd(s: string, at: number, delim: string): number {
    for (let i = at; i < s.length; i++) {
        const c = s[i];
        if (c === "\n") return -1;
        if (c === delim) return i + 1;
        if (c === "\\") { i++; if (i >= s.length || s[i] === "\n") return -1; continue; }
        if (c === "[") {
            const e = gnuBracketEnd(s, i + 1);
            if (e < 0) return -1;
            i = e - 1;
        }
    }
    return -1;
}

/** Where a bracket expression starting at `at` (`[`) ends, as BSD sed's `compile_ccl` reads it: a leading `^`, then a
 *  leading `]`, are members; `[:`, `[=` and `[.` open a class closed by `:]`, `=]` or `.]`. Returns the index just
 *  past its `]`, or -1 when the text ends first. */
function bsdBracketEnd(s: string, at: number): number {
    let i = at + 1;
    if (s[i] === "^") i++;
    if (s[i] === "]") i++;
    for (; i < s.length && s[i] !== "]"; i++) {
        if (s[i] === "\n") return -1;
        const d = s[i + 1];
        if (s[i] === "[" && (d === "." || d === ":" || d === "=")) {
            const close = s.indexOf(`${d}]`, i + 2);
            if (close < 0 || s.slice(i + 2, close).includes("\n")) return -1;
            i = close + 1;
        }
    }
    return i < s.length ? i + 1 : -1;
}

/** Where a regular expression's delimited part ends, as BSD sed's `compile_delimited` reads it: a bracket expression is
 *  skipped whole (so the delimiter inside one does not end it), and a backslash before the delimiter, `n`, `[` or `\`
 *  escapes it. Returns the index just past the delimiter, or -1. */
function bsdDelimitedEnd(s: string, at: number, delim: string): number {
    for (let i = at; i < s.length; i++) {
        const c = s[i];
        if (c === "\n") return -1;
        if (c === "[" && delim !== "[") {
            const e = bsdBracketEnd(s, i);
            if (e < 0) return -1;
            i = e - 1;
            continue;
        }
        if (c === "\\" && (s[i + 1] === "[" || s[i + 1] === delim || s[i + 1] === "n" || s[i + 1] === "\\")) { i++; continue; }
        if (c === delim) return i + 1;
    }
    return -1;
}

/** A regular expression's delimited part, read the same by both seds, or why not. */
function sedRegexEnd(s: string, at: number, delim: string): number | string {
    const g = gnuRegexEnd(s, at, delim);
    const b = bsdDelimitedEnd(s, at, delim);
    if (g < 0 || b < 0) return "a regular expression is not closed on its own line";
    if (g !== b) return "a regular expression's bracket expression ends in different places for GNU and BSD sed";
    return g;
}

/** sed commands that take no argument and touch nothing but the pattern space, the hold space and stdout. */
const SED_PLAIN = new Set(["p", "P", "d", "D", "n", "N", "h", "H", "g", "G", "x", "="]);

/** A delimiter both seds accept for `s` and `y` and read as one byte: printable ASCII, not a backslash or a space. */
const sedDelimOk = (c: string | undefined): c is string => c !== undefined && /^[!-~]$/.test(c) && c !== "\\";

/**
 * Why a sed script is not described, or undefined when it is: every command is one of `s y p P d D n N q = h H g G x
 * { } !`, separated by `;` or newlines; an address is a line number, `$` or `/re/`, or a range of two; `s` flags are
 * `g`, `p`, `i`, `I` and a number. Everything else is refused, whichever sed would accept it: `w`, `r`, `e` and their
 * `s` flags, which write a file or start a program, and also labels and branches, `a`/`i`/`c` text, comments, GNU's
 * address forms (`0,/re/`, `first~step`, `addr,+N`) and a custom address delimiter, so no reading of the text can
 * differ between the implementations. `q` with an exit code is GNU's alone.
 * @param script the script: the first operand, or every `-e` value joined by newlines
 * @param gnu whether GNU sed is the detected flavour
 */
export function sedScriptRefusal(script: string, gnu: boolean): string | undefined {
    const s = script;
    let i = 0;
    let depth = 0;
    const space = () => { while (s[i] === " " || s[i] === "\t") i++; };
    /** One address at `i`, or why not; leaves `i` after it. Returns false when there is none. */
    const address = (): boolean | string => {
        if (s[i] === "$") { i++; return true; }
        const m = /^\d+/.exec(s.slice(i));
        if (m) {
            if (/^0+$/.test(m[0])) return "line address 0 is GNU's alone";
            i += m[0].length;
            return true;
        }
        if (s[i] === "/") {
            const e = sedRegexEnd(s, i + 1, "/");
            if (typeof e === "string") return e;
            i = e;
            return true;
        }
        if (s[i] === "\\") return "an address with its own delimiter (\\cREc) is not described";
        return false;
    };
    /** After a command: blanks, then `;`, a newline, `}` or the end. */
    const end = (what: string): string | undefined => {
        space();
        if (i >= s.length || s[i] === ";" || s[i] === "\n" || s[i] === "}") return undefined;
        return `${JSON.stringify(s[i])} after ${what} is not described`;
    };
    for (;;) {
        while (i < s.length && /[ \t;\n]/.test(s[i])) i++;
        if (i >= s.length) break;
        if (s[i] === "}") {
            if (depth === 0) return "a } closes no {";
            depth--;
            i++;
            const e = end("}");
            if (e) return e;
            continue;
        }
        const a1 = address();
        if (typeof a1 === "string") return a1;
        if (a1 && s[i] === ",") {
            i++;
            const a2 = address();
            if (typeof a2 === "string") return a2;
            if (!a2) return `the range's second address ${JSON.stringify(s.slice(i, i + 2))} is not a line number, $ or /re/`;
        }
        space();
        while (s[i] === "!") { i++; space(); }
        const c = s[i];
        if (c === undefined) return "an address with no command";
        i++;
        if (c === "{") { depth++; continue; }
        if (SED_PLAIN.has(c)) {
            const e = end(c);
            if (e) return e;
            continue;
        }
        if (c === "q") {
            space();
            if (gnu && /\d/.test(s[i] ?? "")) while (/\d/.test(s[i] ?? "")) i++;
            const e = end("q");
            if (e) return e;
            continue;
        }
        if (c === "s") {
            const d = s[i];
            if (!sedDelimOk(d)) return `s with the delimiter ${JSON.stringify(d ?? "")} is not described`;
            const re = sedRegexEnd(s, i + 1, d);
            if (typeof re === "string") return re;
            const rep = plainDelimitedEnd(s, re, d);
            if (rep < 0) return "an s replacement is not closed on its own line";
            i = rep;
            const m = /^[gpiI0-9]*/.exec(s.slice(i))!;
            i += m[0].length;
            const e = end("an s command's flags");
            if (e) return /^"[wWeEmM]"/.test(e) ? `the s flag ${JSON.stringify(s[i])} is not described: it writes a file, runs a command or changes what the regular expression matches` : e;
            continue;
        }
        if (c === "y") {
            const d = s[i];
            if (!sedDelimOk(d)) return `y with the delimiter ${JSON.stringify(d ?? "")} is not described`;
            const from = plainDelimitedEnd(s, i + 1, d);
            const to = from < 0 ? -1 : plainDelimitedEnd(s, from, d);
            if (to < 0) return "a y command is not closed on its own line";
            if (s.slice(i + 1, to).includes("[")) return "a y command holding [ is not described";
            i = to;
            const e = end("y");
            if (e) return e;
            continue;
        }
        return `the sed command ${JSON.stringify(c)} is not described${"wWrReF".includes(c) ? ": it reads or writes a file, or runs a command" : ""}`;
    }
    if (depth > 0) return "a { is not closed";
    return undefined;
}

/** Words an awk program that is described never holds, as substrings: what runs a command, reads a file or the
 *  environment the operands do not name, or changes which files are read (`ARGV`), and gawk's `@include`/`@load` and
 *  indirect calls. */
const AWK_REFUSED = ["system", "getline", "ENVIRON", "ARGV", "ARGC", "PROCINFO", "@"];

/** An awk operand that is an assignment (`n=1`), not a file. */
export const AWK_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/**
 * Why an awk program is not described, or undefined when it is. The text is checked WITHOUT a lexer, by substrings, so
 * no string, regular expression or comment can hide what is beneath it: it holds none of AWK_REFUSED, no `|` that is not
 * part of `||` (a pipe to or from a command), and no `>` after its first `print` (an output redirection needs a `print`
 * or `printf` before its `>`). A program that compares with `>` after a print is refused too; that only asks. Each test
 * runs on the raw text and again with every backslash-newline removed, since an awk that splices lines inside a word
 * (`sys\<newline>tem`) would otherwise run a word no substring names.
 * @param text the program: the first operand
 */
export function awkProgramRefusal(text: string): string | undefined {
    for (const t of [text, text.replace(/\\\n/g, "")]) {
        const word = AWK_REFUSED.find((w) => t.includes(w));
        if (word) return `the awk program holds ${JSON.stringify(word)}, which can run a command, read a file or the environment, or change which files are read`;
        if (/\|/.test(t.replace(/\|\|/g, ""))) return "the awk program holds a | that is not ||: a pipe to or from a command";
        const p = t.indexOf("print");
        if (p >= 0 && t.indexOf(">", p) >= 0) return "the awk program holds a > after a print: an output redirection writes a file";
    }
    return undefined;
}

/** GNU sed's regex delimiter scanner, exported for the scanner tests (tests/sed-scanners.test.mjs) only. */
export const __gnuRegexEnd = gnuRegexEnd;
/** BSD sed's regex delimiter scanner, exported for the scanner tests only. */
export const __bsdDelimitedEnd = bsdDelimitedEnd;
/** The plain delimiter scanner (replacement text, y operands), exported for the scanner tests only. */
export const __plainDelimitedEnd = plainDelimitedEnd;
