// The `@tool:` pointer MACRO: fantasy syntax models already write, made real.
//
// Models write `@tool:abc1234` inline as though it were JS, because that is how the reference is spelled
// everywhere else they meet it — in a tool result's token line, in a citation, in their own prior turn. The
// house response to that is not to correct them: `python_exec`'s prelude patches `pd.read_csv` to return
// the preloaded frame, and `tables['name']` is aliased because a model reaches for the argument name it
// passed. Accommodate what they write.
//
// A LEXICAL pass, not an AST one, and that is forced rather than chosen: `@tool:abc` is not valid
// JavaScript, so a parser cannot find it — a parser can only find syntax it accepts. This is the same
// reason the C preprocessor runs as a separate pass before the compiler ever sees the file. It also
// inherits the preprocessor's central rule: a macro does NOT expand inside a string literal. `#define FOO 1`
// leaves `printf("FOO")` alone, and the single most likely place a model writes a pointer is inside a log
// line it is printing.
//
// The AST does get a job — verifying. After expansion the source IS parseable, so a caller can hand the
// result to acorn and refuse to run something we mangled, which is a check the un-expanded source could
// never have had.
import { TOKEN_HEX_SRC, TOOL_NAME_SRC } from "./token-id";

/** One substitution, so a UI can mark it and say what it came from. */
export interface PointerExpansion {
    /** Offsets in the EXPANDED source. A renderer marks these; the original is in `from`. */
    start: number;
    end: number;
    /** The text the model actually wrote. */
    from: string;
}

export interface ExpandResult {
    code: string;
    expansions: PointerExpansion[];
}

// The three DISJOINT reference forms, built from the same sources the rest of the pointer machinery uses so
// a fourth copy of the grammar cannot drift from them: a quoted label, a minted id, or a bare tool name.
const REF = new RegExp(`@tool:("(?:[^"\\\\]|\\\\.)*"|${TOKEN_HEX_SRC}|${TOOL_NAME_SRC})`, "y");

/** Is `/` at this offset starting a REGEX literal rather than a division? Decided by the previous
 *  significant character, which is the standard heuristic and wrong only for cases that do not arise here
 *  (`a++ /re/`). Getting it wrong would only mean skipping, or not skipping, a region — and a pointer inside
 *  a regex literal is not a thing anyone writes. */
function regexAllowed(src: string, i: number): boolean {
    for (let j = i - 1; j >= 0; j--) {
        const c = src[j];
        if (/\s/.test(c)) continue;
        return "([{;,=:!&|?+-*%~^<>".includes(c);
    }
    return true;
}

/**
 * Expand every `@tool:` reference that appears in CODE position.
 *
 * Skips string literals, template literals (re-entering code inside `${…}`, because that is code), line and
 * block comments, and regex literals. Everything else is code.
 *
 * The expansion is the BARE call, deliberately not `await`ed. Auto-awaiting would break the moment a model
 * writes one inside a non-async callback — `list.map(x => @tool:a)` would put `await` in a non-async arrow,
 * a SyntaxError — and it would hide that these are asynchronous, which the model needs to know in order to
 * write `await Promise.all([@tool:a, @tool:b])`. So: a pointer expression evaluates to a PROMISE, and the
 * model writes its own `await`.
 */
export function expandPointers(src: string): ExpandResult {
    // Nothing to do is the overwhelmingly common case, and it must cost nothing and risk nothing: exec
    // already works, and a macro pass that rewrote code containing no macros would be pure downside.
    if (!src.includes("@tool:")) return { code: src, expansions: [] };

    let out = "";
    const expansions: PointerExpansion[] = [];
    // Template-literal nesting: `${` pushes back into code, and the matching `}` returns to the template.
    const stack: ("template")[] = [];
    let i = 0;
    while (i < src.length) {
        const c = src[i];
        // --- comments ---
        if (c === "/" && src[i + 1] === "/") {
            const nl = src.indexOf("\n", i);
            const end = nl < 0 ? src.length : nl;
            out += src.slice(i, end); i = end; continue;
        }
        if (c === "/" && src[i + 1] === "*") {
            const close = src.indexOf("*/", i + 2);
            const end = close < 0 ? src.length : close + 2;
            out += src.slice(i, end); i = end; continue;
        }
        // --- regex literal ---
        if (c === "/" && regexAllowed(src, i)) {
            let j = i + 1, cls = false, closed = false;
            for (; j < src.length; j++) {
                const d = src[j];
                if (d === "\\") { j++; continue; }
                if (d === "[") cls = true;
                else if (d === "]") cls = false;
                else if (d === "/" && !cls) { closed = true; break; }
                else if (d === "\n") break;
            }
            if (closed) { out += src.slice(i, j + 1); i = j + 1; continue; }
            // Unterminated → it was division after all; fall through and treat as ordinary code.
        }
        // --- quoted strings ---
        if (c === '"' || c === "'") {
            let j = i + 1;
            for (; j < src.length; j++) {
                if (src[j] === "\\") { j++; continue; }
                if (src[j] === c || src[j] === "\n") break;
            }
            out += src.slice(i, Math.min(j + 1, src.length)); i = j + 1; continue;
        }
        // --- template literals, which re-enter CODE inside ${ } ---
        if (c === "`") {
            let j = i + 1;
            out += "`";
            for (; j < src.length; j++) {
                if (src[j] === "\\") { out += src.slice(j, j + 2); j++; continue; }
                if (src[j] === "`") { out += "`"; j++; break; }
                if (src[j] === "$" && src[j + 1] === "{") { out += "${"; j += 2; stack.push("template"); break; }
                out += src[j];
            }
            i = j;
            continue;
        }
        if (c === "}" && stack.length) {
            // Back into the template that opened this `${`.
            stack.pop();
            out += "}";
            let j = i + 1;
            for (; j < src.length; j++) {
                if (src[j] === "\\") { out += src.slice(j, j + 2); j++; continue; }
                if (src[j] === "`") { out += "`"; j++; break; }
                if (src[j] === "$" && src[j + 1] === "{") { out += "${"; j += 2; stack.push("template"); break; }
                out += src[j];
            }
            i = j;
            continue;
        }
        // --- the macro itself ---
        if (c === "@") {
            REF.lastIndex = i;
            const m = REF.exec(src);
            if (m && m.index === i) {
                const start = out.length;
                out += `ml.dereference(${JSON.stringify(m[0])})`;
                expansions.push({ start, end: out.length, from: m[0] });
                i += m[0].length;
                continue;
            }
        }
        out += c; i++;
    }
    return { code: out, expansions };
}
