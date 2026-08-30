// A tiny, dependency-free interpreter for the READ-ONLY `exec` dialect — the
// stereotypical DOM surveys the agent writes constantly:
//
//   Array.from(document.querySelectorAll('input')).filter(el => …).map(el => ({…}))
//
// It walks an AST we parse ourselves and calls real methods by reflection, so
// (1) it is the whitelist — only the modeled dialect runs; (2) it NEVER compiles
// a string, so Trusted Types (`require-trusted-types-for 'script'`) is bypassed;
// (3) it is safe by MEDIATION — every property read is denylisted and every call
// is allowlisted to read/query/pure methods, so the auto-approved path can read
// the DOM and compute but call nothing with an effect. `window`/`fetch`/`Function`
// are never in scope and are unreachable through the object graph.
//
// Anything outside the dialect throws `NotInDialect`; any blocked access throws
// `Denied`. Callers treat BOTH as "fall back to the normal approval + eval path"
// — safe because the interpreter is side-effect-free, so a failed attempt does
// nothing observable. See docs/spec/READONLY_EXEC_SPEC.md.
//
// The evaluator is a GENERATOR: `yield`ing a value asks the driver to await it, so
// `await` works (the agent's own read-only `ml` introspection is async). There are two
// drivers — `runAsync` at the top level, and `runSync` for the arrows a host method
// invokes (`.map`/`.filter` call their callback synchronously, so an `await` in there
// can't be honoured and throws NotInDialect → the whole survey falls back to approval).

export class NotInDialect extends Error {}
export class Denied extends Error {}

// ---------------------------------------------------------------- tokenizer ---

interface Tok { t: "num" | "str" | "name" | "punct" | "eof" | "template" | "regex"; v: string; quasis?: string[]; exprs?: string[]; flags?: string; }

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
    "===", "!==", "...", "?.", "=>", "==", "!=", "<=", ">=", "&&", "||", "??",
    ".", ",", "(", ")", "[", "]", "{", "}", "?", ":", "!", "<", ">",
    "+", "-", "*", "/", "%", "=", ";",   // `=` only for `const x = …`; assignment expressions still fail closed
];

function tokenize(src: string): Tok[] {
    const toks: Tok[] = [];
    let i = 0;
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
            toks.push({ t: "regex", v: body, flags }); i = j; continue;
        }
        if (c === "`") { const { quasis, exprs, end } = scanTemplate(src, i); toks.push({ t: "template", v: "", quasis, exprs }); i = end; continue; }
        if (c >= "0" && c <= "9") {
            let j = i + 1;
            while (j < src.length && /[0-9.]/.test(src[j])) j++;
            toks.push({ t: "num", v: src.slice(i, j) }); i = j; continue;
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
            toks.push({ t: "str", v: out }); i = j + 1; continue;
        }
        if (isIdStart(c)) {
            let j = i + 1;
            while (j < src.length && isId(src[j])) j++;
            toks.push({ t: "name", v: src.slice(i, j) }); i = j; continue;
        }
        const p = PUNCT.find(x => src.startsWith(x, i));
        if (!p) throw new NotInDialect(`unexpected character '${c}'`);
        toks.push({ t: "punct", v: p }); i += p.length; continue;
    }
    toks.push({ t: "eof", v: "" });
    return toks;
}

// ------------------------------------------------------------------- parser ---
// Pratt/precedence-climbing over the token array. Every unexpected shape throws
// NotInDialect, so the parser can be deliberately incomplete and still safe.

type Node = any;
const BP: Record<string, number> = {
    "??": 1, "||": 1, "&&": 2, "===": 3, "!==": 3, "==": 3, "!=": 3,
    "<": 4, ">": 4, "<=": 4, ">=": 4, "+": 5, "-": 5, "*": 6, "/": 6, "%": 6,
};

class Parser {
    i = 0;
    constructor(private toks: Tok[]) {}
    peek(o = 0): Tok { return this.toks[this.i + o]; }
    next(): Tok { return this.toks[this.i++]; }
    is(v: string): boolean { const t = this.peek(); return (t.t === "punct" || t.t === "name") && t.v === v; }
    eat(v: string): void { if (!this.is(v)) throw new NotInDialect(`expected '${v}'`); this.i++; }

    parseProgram(): Node {
        const body: Node[] = [];
        while (this.peek().t !== "eof") body.push(this.parseStatement());
        return { type: "Program", body };
    }
    parseStatement(): Node {
        const t = this.peek();
        if (this.is("{")) return this.parseBlock();   // a bare block (e.g. an if body)
        if (t.t === "name" && t.v === "if") {
            this.next(); this.eat("(");
            const test = this.parseExpression();
            this.eat(")");
            const cons = this.parseStatement();
            let alt: Node | null = null;
            if (this.peek().t === "name" && this.peek().v === "else") { this.next(); alt = this.parseStatement(); }
            return { type: "If", test, cons, alt };
        }
        // `for (const x of iterable) …` ONLY. LLMs reach for this constantly and it's as safe/terminating as
        // spread (which already iterates any iterable): no infinite iterable is reachable in the dialect (no
        // `function*`, `Symbol` isn't in scope → no custom iterator). A C-style `for(;;)` (unbounded) and
        // `for…in` (prototype-chain enumeration — a read bypass; use `Object.keys`) are intentionally OUT.
        if (t.t === "name" && t.v === "for") {
            this.next(); this.eat("(");
            const kw = this.peek();
            if (!(kw.t === "name" && (kw.v === "const" || kw.v === "let" || kw.v === "var")))
                throw new NotInDialect("only `for (const x of iterable)` is supported — no C-style `for(;;)`");
            this.next();
            const id = this.next();
            if (id.t !== "name") throw new NotInDialect("expected loop variable name");
            const kwd = this.next();
            if (!(kwd.t === "name" && kwd.v === "of"))
                throw new NotInDialect(kwd.v === "in" ? "`for…in` is not supported — use `for (const x of Object.keys(o))` or `.map`" : "expected `of` in a for-loop");
            const iter = this.parseExpression();
            this.eat(")");
            const body = this.parseStatement();
            return { type: "ForOf", name: id.v, iter, body };
        }
        if (t.t === "name" && (t.v === "const" || t.v === "let" || t.v === "var")) {
            this.next();
            // Destructuring binding — `const [a, b, ...rest] = …` / `const { a, b } = …`. Pure: it just names
            // parts of an already-evaluated value (the RHS runs through the normal mediated pipeline, and the
            // object form reads each key through the SAME guard as a member read — denied props throw, a method
            // becomes the inert sentinel). The shape models write over Promise.all / ml.config() batches.
            if (this.is("[") || this.is("{")) {
                const pattern = this.is("[") ? this.parseArrayPattern() : this.parseObjectPattern();
                this.eat("=");
                const init = this.parseExpression();
                if (this.is(";")) this.i++;
                return { type: "VarDecl", pattern, init };
            }
            const id = this.next();
            if (id.t !== "name") throw new NotInDialect("expected name");
            this.eat("=");
            const init = this.parseExpression();
            if (this.is(";")) this.i++;
            return { type: "VarDecl", name: id.v, init };
        }
        if (t.t === "name" && t.v === "return") {
            this.next();
            let arg: Node = { type: "Lit", value: undefined };
            if (!this.is(";") && !this.is("}") && this.peek().t !== "eof") arg = this.parseExpression();
            if (this.is(";")) this.i++;
            return { type: "Return", arg };
        }
        // try { … } catch (e) { … } finally { … } — pure control flow, no new capability. The
        // evaluator NEVER lets a catch swallow a NotInDialect/Denied (those keep escalating to the
        // human gate), so `try { <denied op> } catch {}` can't paper over a denial.
        if (t.t === "name" && t.v === "try") {
            this.next();
            const block = this.parseBlock();
            let param: string | null = null, handler: Node | null = null, finalizer: Node | null = null;
            if (this.peek().t === "name" && this.peek().v === "catch") {
                this.next();
                if (this.is("(")) { this.eat("("); const n = this.next(); if (n.t !== "name") throw new NotInDialect("catch param"); param = n.v; this.eat(")"); }
                handler = this.parseBlock();
            }
            if (this.peek().t === "name" && this.peek().v === "finally") { this.next(); finalizer = this.parseBlock(); }
            if (!handler && !finalizer) throw new NotInDialect("try needs catch or finally");
            return { type: "Try", block, param, handler, finalizer };
        }
        const e = this.parseExpression();
        if (this.is(";")) this.i++;
        return { type: "ExprStmt", expr: e };
    }
    parseExpression(): Node { return this.parseAssignment(); }
    // Assignment is the LOWEST-precedence, right-associative level. Only a simple `=` (no compound `+=`/`||=`)
    // — the get-or-create-and-push idiom `(o[k] = o[k] || []).push(x)` and building a local accumulator. The
    // EVALUATOR mediates the target hard: a member write lands ONLY on a script-local plain object/array,
    // never a DOM node / host object / the realm — so this stays read-only w.r.t. the PAGE.
    parseAssignment(): Node {
        const left = this.parseTernary();
        if (this.is("=")) { this.eat("="); return { type: "Assign", target: left, value: this.parseAssignment() }; }
        return left;
    }
    parseTernary(): Node {
        const cond = this.parseBinary(0);
        if (this.is("?")) {
            this.i++;
            const cons = this.parseExpression();
            this.eat(":");
            const alt = this.parseExpression();
            return { type: "Cond", cond, cons, alt };
        }
        return cond;
    }
    parseBinary(minbp: number): Node {
        let left = this.parseUnary();
        while (true) {
            const t = this.peek();
            if (t.t !== "punct" || !(t.v in BP) || BP[t.v] < minbp) break;
            const op = t.v; this.i++;
            const right = this.parseBinary(BP[op] + 1);
            const logical = op === "&&" || op === "||" || op === "??";
            left = { type: logical ? "Logical" : "Binary", op, left, right };
        }
        return left;
    }
    parseUnary(): Node {
        const t = this.peek();
        // `await X` — the evaluator yields X to its driver. Only reachable at the top level
        // (or inside a directly-invoked arrow); inside a host callback the sync driver rejects it.
        if (t.t === "name" && t.v === "await") { this.i++; return { type: "Await", arg: this.parseUnary() }; }
        if (t.t === "punct" && (t.v === "!" || t.v === "-") || (t.t === "name" && t.v === "typeof")) {
            this.i++;
            return { type: "Unary", op: t.v, arg: this.parseUnary() };
        }
        return this.parsePostfix();
    }
    parsePostfix(): Node {
        let node = this.parsePrimary();
        while (true) {
            if (this.is(".")) {
                this.i++; const n = this.next();
                if (n.t !== "name") throw new NotInDialect("expected property name");
                node = { type: "Member", obj: node, prop: n.v, computed: false, optional: false };
            } else if (this.is("?.")) {
                this.i++;
                if (this.is("(")) { node = this.parseCall(node, true); }
                else if (this.is("[")) { node = this.parseComputed(node, true); }
                else { const n = this.next(); if (n.t !== "name") throw new NotInDialect("expected property name"); node = { type: "Member", obj: node, prop: n.v, computed: false, optional: true }; }
            } else if (this.is("[")) {
                node = this.parseComputed(node, false);
            } else if (this.is("(")) {
                node = this.parseCall(node, false);
            } else break;
        }
        return node;
    }
    parseComputed(obj: Node, optional: boolean): Node {
        this.eat("[");
        const prop = this.parseExpression();
        this.eat("]");
        return { type: "Member", obj, prop, computed: true, optional };
    }
    parseCall(callee: Node, optional: boolean): Node {
        this.eat("(");
        const args: Node[] = [];
        while (!this.is(")")) {
            if (this.is("...")) { this.i++; args.push({ type: "Spread", arg: this.parseExpression() }); }
            else args.push(this.parseExpression());
            if (this.is(",")) this.i++; else break;
        }
        this.eat(")");
        return { type: "Call", callee, args, optional };
    }
    // function [name](params) { … }  — an anonymous/named function expression (the
    // `(function(){ … })()` IIFE the models write constantly). Treated like an arrow.
    parseFunction(): Node {
        this.eat("function");
        if (this.peek().t === "name") this.i++;   // optional name (ignored)
        this.eat("(");
        const params: string[] = [];
        while (!this.is(")")) {
            const n = this.next();
            if (n.t !== "name") throw new NotInDialect("param");
            params.push(n.v);
            if (this.is(",")) this.i++; else break;
        }
        this.eat(")");
        if (!this.is("{")) throw new NotInDialect("function body");
        return { type: "Arrow", params, body: this.parseBlock() };
    }
    parsePrimary(): Node {
        const t = this.peek();
        // `async` before a function/arrow — the models' `(async () => { … })()` reflex. The keyword is
        // inert here: the body's `await` is already honoured by the driver, so skip it and re-dispatch to
        // the function/arrow parse. Only when a function/arrow actually follows (else `async` is an ident).
        if (t.t === "name" && t.v === "async") {
            const n = this.peek(1);
            const followsFn = n && ((n.t === "name" && n.v === "function") || (n.t === "punct" && n.v === "(") || (n.t === "name" && this.peek(2)?.t === "punct" && this.peek(2)?.v === "=>"));
            if (followsFn) { this.i++; return this.parsePrimary(); }
        }
        if (t.t === "num") { this.i++; return { type: "Lit", value: parseFloat(t.v) }; }
        if (t.t === "str") { this.i++; return { type: "Lit", value: t.v }; }
        if (t.t === "regex") { this.i++; return { type: "Regex", pattern: t.v, flags: t.flags || "" }; }
        if (t.t === "template") {
            this.i++;
            // Re-parse each interpolation's raw source; require it to fully consume (a stray `;`/statement
            // inside `${…}` fails closed rather than silently dropping code).
            const exprs = (t.exprs || []).map(s => { const p = new Parser(tokenize(s)); const n = p.parseExpression(); if (p.peek().t !== "eof") throw new NotInDialect("bad template expression"); return n; });
            return { type: "Template", quasis: t.quasis || [""], exprs };
        }
        // `new Ctor(args)` — a bare-identifier constructor only (no `new a.b()`); the evaluator allowlists it
        // to pure builtins (Set/Map/Array/…). Args are full expressions (incl. `...spread`).
        if (t.t === "name" && t.v === "new") {
            this.i++;
            const id = this.next();
            if (id.t !== "name") throw new NotInDialect("new expects a constructor name");
            const args: Node[] = [];
            if (this.is("(")) {
                this.eat("(");
                while (!this.is(")")) {
                    if (this.is("...")) { this.i++; args.push({ type: "Spread", arg: this.parseExpression() }); }
                    else args.push(this.parseExpression());
                    if (this.is(",")) this.i++; else break;
                }
                this.eat(")");
            }
            return { type: "New", ctor: id.v, args };
        }
        if (t.t === "name") {
            if (t.v === "true") { this.i++; return { type: "Lit", value: true }; }
            if (t.v === "false") { this.i++; return { type: "Lit", value: false }; }
            if (t.v === "null") { this.i++; return { type: "Lit", value: null }; }
            if (t.v === "undefined") { this.i++; return { type: "Lit", value: undefined }; }
            if (t.v === "function") return this.parseFunction();   // (function(){ … })()
            // single-param arrow:  x => …
            if (this.peek(1).t === "punct" && this.peek(1).v === "=>") {
                this.i++; this.eat("=>");
                return { type: "Arrow", params: [t.v], body: this.parseArrowBody() };
            }
            this.i++; return { type: "Ident", name: t.v };
        }
        if (this.is("[")) {
            this.i++; const elements: Node[] = [];
            while (!this.is("]")) {
                if (this.is("...")) { this.i++; elements.push({ type: "Spread", arg: this.parseExpression() }); }
                else elements.push(this.parseExpression());
                if (this.is(",")) this.i++; else break;
            }
            this.eat("]");
            return { type: "Array", elements };
        }
        if (this.is("{")) return this.parseObject();
        if (this.is("(")) return this.parseParenOrArrow();
        throw new NotInDialect(`unexpected token '${t.v || t.t}'`);
    }
    parseParenOrArrow(): Node {
        // Try (params) =>  ; on failure restore and parse ( expr ).
        const save = this.i;
        try {
            this.eat("(");
            const params: (string | Node)[] = [];   // a name, OR a destructuring pattern `[a,b]` / `{a,b}`
            while (!this.is(")")) {
                if (this.is("[")) params.push(this.parseArrayPattern());
                else if (this.is("{")) params.push(this.parseObjectPattern());
                else { const n = this.next(); if (n.t !== "name") throw new NotInDialect("param"); params.push(n.v); }
                if (this.is(",")) this.i++; else break;
            }
            this.eat(")");
            if (!this.is("=>")) throw new NotInDialect("not arrow");
            this.eat("=>");
            return { type: "Arrow", params, body: this.parseArrowBody() };
        } catch {
            this.i = save;
            this.eat("(");
            const e = this.parseExpression();
            this.eat(")");
            return e;
        }
    }
    parseBlock(): Node {
        this.eat("{");
        const body: Node[] = [];
        while (!this.is("}")) body.push(this.parseStatement());
        this.eat("}");
        return { type: "Block", body };
    }
    // `const [a, , b, ...rest] = …` — simple names, holes, and an optional trailing rest. No defaults/nesting.
    parseArrayPattern(): Node {
        this.eat("[");
        const elems: (string | null)[] = [];
        let rest: string | undefined;
        while (!this.is("]")) {
            if (this.is(",")) { elems.push(null); this.next(); continue; }   // hole
            if (this.is("...")) { this.next(); const r = this.next(); if (r.t !== "name") throw new NotInDialect("expected a name after `...`"); rest = r.v; break; }
            const n = this.next(); if (n.t !== "name") throw new NotInDialect("only simple names in array destructuring");
            elems.push(n.v);
            if (this.is(",")) this.next();
        }
        this.eat("]");
        return { type: "ArrayPattern", elems, rest };
    }
    // `const { a, b } = …` — SHORTHAND names only (no `{a: b}` rename, no `{a = 1}` default, no nesting), so
    // each bound name IS a property key read through the member-read guard (denied props throw, methods → inert).
    parseObjectPattern(): Node {
        this.eat("{");
        const keys: string[] = [];
        while (!this.is("}")) {
            const k = this.next();
            if (k.t !== "name") throw new NotInDialect("only shorthand `{ a, b }` destructuring is supported");
            if (this.is(":") || this.is("=")) throw new NotInDialect("only shorthand `{ a, b }` destructuring — no rename/default");
            keys.push(k.v);
            if (this.is(",")) this.next();
        }
        this.eat("}");
        return { type: "ObjectPattern", keys };
    }
    parseArrowBody(): Node {
        if (this.is("{")) return this.parseBlock();
        return { type: "ExprBody", expr: this.parseExpression() };
    }
    parseObject(): Node {
        this.eat("{");
        const props: ({ key: string; value: Node } | { spread: Node })[] = [];
        while (!this.is("}")) {
            if (this.is("...")) {
                // Object spread `{ ...expr }` — pure: it copies expr's OWN ENUMERABLE props (each read through
                // the member-read guard at eval time). The shape models write for conditional fields:
                // `{ a, ...(cond && { b }) }`.
                this.next();
                props.push({ spread: this.parseExpression() });
            } else {
                const k = this.next();
                let key: string;
                if (k.t === "name" || k.t === "str") key = k.v;
                else throw new NotInDialect("object key");
                if (this.is(":")) { this.i++; props.push({ key, value: this.parseExpression() }); }
                else props.push({ key, value: { type: "Ident", name: key } });   // shorthand
            }
            if (this.is(",")) this.i++; else break;
        }
        this.eat("}");
        return { type: "Object", props };
    }
}

// ---------------------------------------------------------------- evaluator ---

// Property names that can walk back to the realm (window/Function/…). Denied on
// every read, static or computed. `constructor`/`__proto__` kill the
// `.constructor.constructor` → Function escape; the DOM/window names kill node →
// window.
const DENIED_PROPS = new Set([
    "constructor", "__proto__", "prototype", "__defineGetter__", "__defineSetter__",
    "__lookupGetter__", "__lookupSetter__", "ownerDocument", "defaultView",
    "contentWindow", "contentDocument", "frameElement", "location", "cookie",
    "parent", "top", "opener", "self", "window", "globalThis", "eval", "Function",
    // Defense-in-depth for getComputedStyle's CSSStyleDeclaration: the ONLY walk-back to window is
    // parentRule → parentStyleSheet → ownerNode → ownerDocument → defaultView, and ownerDocument/
    // defaultView above already cut it — but deny the CSS-object hops too so it's cut at the source.
    "parentRule", "parentStyleSheet", "ownerNode", "sheet",
]);

// The ONLY methods a call may invoke — read/query/pure. No effectful method
// (click/submit/setAttribute/appendChild/remove/fetch/open/…) appears, so even a
// leaked `window` can't do anything: `window.fetch(…)` → method not allowlisted.
// A live DOM collection (NodeList/HTMLCollection) — array-like with a numeric length + an `item()`
// method, but NOT an Array. Detected structurally (no cross-realm/global dependency; works in jsdom).
const isDomCollection = (x: any): boolean =>
    x != null && typeof x === "object" && !Array.isArray(x) && typeof x.length === "number" && typeof x.item === "function";

const ALLOWED_METHODS = new Set([
    // DOM read / query
    "querySelector", "querySelectorAll", "getElementById", "getElementsByClassName",
    "getElementsByTagName", "getElementsByName", "closest", "matches", "getAttribute",
    "getAttributeNames", "hasAttribute", "contains", "getBoundingClientRect", "getRootNode",
    // Array — readers/pure PLUS the in-place builders (push/pop/…): array mutation is already tolerated
    // (sort/reverse/fill mutate in place), and these operate on a SCRIPT-LOCAL computation array (models write
    // `(o[k] = o[k] || []).push(x)` to build accumulators). Their returns are a length/element/removed-array —
    // plain data, never the realm.
    "from", "isArray", "of", "map", "filter", "forEach", "reduce", "reduceRight", "find", "findIndex", "findLast", "findLastIndex",
    "some", "every", "includes", "indexOf", "lastIndexOf", "slice", "concat", "join",
    "flat", "flatMap", "sort", "reverse", "at", "fill", "push", "pop", "shift", "unshift", "splice",
    // String
    "substring", "substr", "toLowerCase", "toUpperCase", "trim", "trimStart", "trimEnd",
    "split", "startsWith", "endsWith", "replace", "replaceAll", "padStart", "padEnd",
    "repeat", "charAt", "charCodeAt", "codePointAt", "normalize", "localeCompare",
    // String↔RegExp (pure matching — a regex literal is now in-dialect): the string-side readers plus the
    // RegExp-side `test`/`exec`. All side-effect-free; `exec`/matchAll return match arrays, not the realm.
    "match", "matchAll", "search", "test", "exec",
    // Set / Map — reads (has/get; size is a property, read via readMember) PLUS the mutators
    // (add/set/delete/clear). Like the array in-place builders, the mutators only run on a container the
    // SCRIPT created (MUTATING_METHODS + `owned`) — never a Set/Map/collection reached off a page object, so
    // e.g. `document.body.classList.add('x')` stays Denied while `new Set()`/`new Map()` accumulators work.
    "has", "get", "add", "set", "delete", "clear",
    // Object / JSON / Math / Number
    "keys", "values", "entries", "fromEntries", "stringify", "parse", "assign",
    // Promise combinators + `then` — models batch and chain the async ml reads
    // (`Promise.all([ml.models(), ml.getModel()])`, `ml.getModel().then(m => …)`). Only the
    // combinators: `Promise` itself is never callable (not a CALLABLE_ROOT, and `new` isn't in the
    // dialect), so this can't mint a promise around anything the gates didn't already allow.
    "all", "allSettled", "then",
    "max", "min", "floor", "ceil", "round", "abs", "pow", "sqrt", "sign", "trunc",
    "toFixed", "toString",
    // CSSStyleDeclaration (getComputedStyle) — pure readers. Named property reads (`.color`) go
    // through readMember and aren't denied; these are the method form. No setProperty/removeProperty
    // (mutation, and they throw on a computed style anyway) — absent, so uncallable.
    "getPropertyValue", "getPropertyPriority", "item",
    // console (captured)
    "log", "info", "warn", "error", "debug",
]);

// Free identifiers that may be CALLED directly: coercion/parse builtins + getComputedStyle (a pure,
// same-origin read; bound to the view in evalReadonly so it never hands back `window`, and its result's
// walk-back to window is cut by DENIED_PROPS). Historic :visited history-sniffing is dead — every modern
// browser returns the UNVISITED style through getComputedStyle.
// `Array(n)` is included so the idiomatic bounded counter loop `[...Array(n).keys()].map(…)` resolves —
// pure (a holey array of length n), and its only new failure mode (a huge spread) is the same unbounded
// allocation `Array.from({length:n}, …)` already permits, not a new capability. `Array.from`/`Array.isArray`
// stay reachable as member calls regardless.
const CALLABLE_ROOTS = new Set(["String", "Number", "Boolean", "Array", "parseInt", "parseFloat", "isNaN", "isFinite", "getComputedStyle"]);

// A target a member WRITE may land on: a SCRIPT-LOCAL computation container only — a plain object (`{}` /
// `Object.create(null)` / a JSON.parse result / an `ml.config()` value) or an Array. A DOM node (proto is
// HTMLElement.prototype), a NodeList, a Set/Map, `window`, the interpreter's scope — anything with a
// non-plain prototype — is REFUSED, so `o[k] = v` can never mutate the PAGE or the realm. Combined with
// guardKey (which denies __proto__/constructor/prototype), assignment stays read-only w.r.t. the page.
function isWritableTarget(o: unknown): boolean {
    if (Array.isArray(o)) return true;
    if (o == null || typeof o !== "object") return false;
    const proto = Object.getPrototypeOf(o);
    return proto === Object.prototype || proto === null;
}

// The ONLY constructors `new X(…)` may build — pure, side-effect-free, realm-safe builtins. Everything else
// is ABSENT → Denied: `new Function('code')` (code gen), `new Image`/`XMLHttpRequest`/`WebSocket`/`Worker`
// (network / side effect), any host constructor. Resolved by NAME, not by a scope lookup, so it can't be
// rebound. Their RESULTS are ordinary values that flow through the same read/call mediation as everything else.
const SAFE_CONSTRUCTORS: Record<string, new (...a: any[]) => unknown> = {
    Set, Map, WeakSet, WeakMap, Array, Object, Date, RegExp, Number, String, Boolean, Error,
};

// In-place MUTATORS (array push/…, plus Set.add and Map/Set set/delete/clear). Allowed ONLY on a container
// the SCRIPT created (tracked in `owned`) — never a container reached off a page object. So `pageState.items
// .push(x)` / `.sort()` / `document.body.classList.add('x')` can't grow/reorder/mutate the page's own data;
// only the survey's local accumulators (`(o[k] = o[k] || []).push(x)`, `new Set()`, `new Map()`) can.
const MUTATING_METHODS = new Set(["push", "pop", "shift", "unshift", "splice", "sort", "reverse", "fill", "add", "set", "delete", "clear"]);

// The `window.ml` methods this dialect may call — side-effect-free reads: no privilege, no page
// mutation, no tokens/VRAM. Everything else is simply ABSENT from the facade we build, so it can't
// be reached: setModel/unload MUTATE (setModel would re-point the model the run itself is using),
// chat/agent/read spend tokens and can recurse, pythonExec/screenshot are privileged. `config()` is
// already the non-secret MlPublicConfig subset — no URL, no API key. `queryAll` returns live Elements
// (not plain data), but those flow through the SAME read-mediation as document.querySelectorAll's —
// a pure shadow/iframe-piercing query, no new capability over what the dialect already reaches.
export const ML_READONLY_METHODS = ["getModel", "config", "models", "capabilities", "ps", "serverTools", "queryAll", "range"] as const;

/** Build the `ml` object the dialect sees: ONLY {@link ML_READONLY_METHODS}, bound to the real API.
 *  A purpose-built facade rather than `window.ml` itself, so the free set is enforced by what exists,
 *  not only by a name check. Returns null when there's no ml (→ `ml` isn't in scope at all). */
function mlFacade(ml: unknown, reused?: string[]): Record<string, unknown> | null {
    if (!ml || typeof ml !== "object") return null;
    const out: Record<string, unknown> = Object.create(null);
    for (const name of ML_READONLY_METHODS) {
        const fn = (ml as Record<string, unknown>)[name];
        if (typeof fn === "function") out[name] = (fn as (...a: unknown[]) => unknown).bind(ml);
    }
    // `ml.fetch(url)` in the dialect is CACHE-ONLY: it returns an ALREADY-fetched result (a pure read of
    // bytes the user already approved fetching) and THROWS on a cache miss — so a NEW url falls through to
    // the normal approval + full eval, which does the real (egress) fetch. It NEVER egresses in read-only,
    // so a survey that re-reads an approved URL auto-approves (the python_exec+Sheet parallel). Kept OUT of
    // ML_READONLY_METHODS (which drives the "always free" docs) because it's free only for cached URLs.
    const cachedFetch = (ml as Record<string, unknown>)["_fetchCached"];
    if (typeof cachedFetch === "function") {
        out.fetch = (url: unknown, opts?: unknown): unknown => {
            // `{ fresh: true }` skips the cache; `{ credentials: true }` fetches AS THE USER — both are egress
            // that ALWAYS needs approval, so they can't run in the read-only (no-approval) dialect.
            if (opts && typeof opts === "object" && ((opts as { fresh?: unknown }).fresh || (opts as { credentials?: unknown }).credentials))
                throw new Denied("fetch({ fresh | credentials }) is a live/authenticated fetch — it needs approval");
            const r = (cachedFetch as (u: unknown) => unknown).call(ml, url);
            if (r === undefined) throw new Denied(`fetch(${JSON.stringify(String(url))}) isn't cached — approve it once, then re-reads are free`);
            reused?.push(String(url));   // a cache HIT = this survey re-read a URL you already approved (transparency)
            return r;
        };
    }
    return Object.keys(out).length ? out : null;
}

const RETURN = Symbol("return");   // sentinel wrapper for a `return` value
// Sentinel: an optional chain (`a?.b.c()`) short-circuited. It propagates through the rest of the chain
// (evalChain/readMember/evalCall) and is unwrapped to `undefined` the moment the chain result is CONSUMED
// (the `eval` dispatch for Member/Call), so it never leaks into arithmetic, args, or comparisons.
const SHORT = Symbol("optional-short-circuit");
// Inert stand-in returned when code reads a method as a value (existence guards).
// Truthy + typeof "function", but calling it throws → the real method never leaks.
const METHOD_REF = function (): never { throw new NotInDialect("a method reference cannot be called indirectly"); };

// An evaluation in progress: `yield` a value to have the driver await it.
type Ev<T = unknown> = Generator<unknown, T, unknown>;

class Evaluator {
    // Arrows we created — the only functions we'll invoke directly. Keyed to their node+scope so a
    // DIRECT call (an IIFE) can be driven by the CALLER's driver (an await inside it still works),
    // while the bare wrapper a host method receives stays synchronous.
    private ourFns = new WeakMap<Function, { node: Node; scope: any }>();
    private depth = 0;
    // Containers the SCRIPT created (plain object/array literals, `new`, and the fresh arrays/objects our
    // allowlisted methods return — .map/.filter/.slice/Object.entries/JSON.parse/spread/…). ONLY these may be
    // mutated (assignment + push/sort/…). An array/object reached by READING a property off a page value is
    // NOT here, so page state can't be written. Page arrays are never RETURNED by an allowlisted method (those
    // all build new ones), so marking method results owned can't launder a live page container.
    private owned = new WeakSet<object>();
    private own<T>(v: T): T { if (v !== null && typeof v === "object" && isWritableTarget(v)) this.owned.add(v as object); return v; }
    constructor(private ml: Record<string, unknown> | null) {}

    private guardKey(key: unknown): string {
        const k = String(key);
        if (DENIED_PROPS.has(k)) throw new Denied(`access to '${k}' is not allowed`);
        return k;
    }

    // Read one property with the SAME mediation as readMember: a denied key throws, a function value becomes
    // the inert sentinel (never the real method — so `const { fetch } = someWindow` can't extract a live fetch),
    // a DOM collection becomes a real Array. Used by object destructuring.
    private prop(obj: unknown, key: string): unknown {
        this.guardKey(key);
        const v = (obj as any)?.[key];
        if (typeof v === "function") return METHOD_REF;
        return isDomCollection(v) ? Array.from(v as ArrayLike<unknown>) : v;
    }

    // read a member (NOT in call position). A function-valued read returns an
    // INERT sentinel, never the real method — so the common existence-guard idiom
    // `el.querySelector && el.querySelector('x')` stays in-dialect (the sentinel is
    // truthy, typeof "function"), while a method still can't be pulled off and
    // invoked past the call gate: calling the sentinel (directly or via .map)
    // throws, dropping the whole survey back to approval.
    // Evaluate a node that is a LINK in a member/call chain WITHOUT unwrapping the short-circuit sentinel,
    // so an optional access (`a?.b`) that hit nullish propagates SHORT through the rest of the chain
    // (`.c.d()`), exactly like JS: the whole chain after `?.` is skipped, not evaluated onto `undefined`.
    // A non-chain node goes through the normal eval (which never yields SHORT).
    private *evalChain(node: Node, scope: any): Ev {
        if (node.type === "Member") return yield* this.readMember(node, scope);
        if (node.type === "Call") return yield* this.evalCall(node, scope);
        return yield* this.eval(node, scope);
    }

    private *readMember(node: Node, scope: any): Ev {
        const obj = yield* this.evalChain(node.obj, scope);
        if (obj === SHORT) return SHORT;                       // an earlier `?.` short-circuited → keep skipping
        if (node.optional && obj == null) return SHORT;        // this `?.` short-circuits the rest of the chain
        const key = node.computed ? this.guardKey(yield* this.eval(node.prop, scope)) : this.guardKey(node.prop);
        const v = (obj as any)?.[key];
        if (typeof v === "function") return METHOD_REF;
        // Uniformly with querySelectorAll (evalCall), a collection PROPERTY (.children/.rows/.cells/…)
        // reads as a real Array too — so `el.children.map(…)` works like `qsa('x').map(…)`.
        return isDomCollection(v) ? Array.from(v as ArrayLike<unknown>) : v;
    }

    // Bind a destructuring pattern (`const {a,b} = …`, `([a,b]) => …`) MEDIATED: every extracted property goes
    // through `this.prop` (a denied key like `constructor`/`__proto__` throws; a live method → the inert
    // METHOD_REF sentinel), so you can GET a property but not USE it to escape. Shared by VarDecl + arrow params.
    private bindPattern(scope: any, pattern: Node, val: unknown): void {
        if (pattern.type === "ArrayPattern") {
            const arr = Array.isArray(val) ? val
                : (val != null && typeof (val as any)[Symbol.iterator] === "function") ? Array.from(val as Iterable<unknown>)
                    : (() => { throw new TypeError("cannot destructure a non-iterable value"); })();
            (pattern.elems as (string | null)[]).forEach((name, i) => { if (name) scope[name] = this.prop(arr, String(i)); });
            if (pattern.rest) scope[pattern.rest] = this.own(arr.slice((pattern.elems as unknown[]).length));
        } else {   // ObjectPattern — each key read through the member-read guard (denied → throw, method → inert)
            for (const k of pattern.keys as string[]) scope[k] = this.prop(val, k);
        }
    }

    *eval(node: Node, scope: any): Ev {
        switch (node.type) {
            case "Program": {
                let last: unknown;
                for (const s of node.body) {
                    const v = yield* this.eval(s, scope);
                    if (v && typeof v === "object" && RETURN in (v as object)) return (v as any)[RETURN];
                    if (s.type === "ExprStmt") last = v;
                }
                return last;
            }
            case "Block": {
                const child = Object.create(scope);
                for (const s of node.body) {
                    const v = yield* this.eval(s, child);
                    if (v && typeof v === "object" && RETURN in v) return v;   // propagate return upward
                }
                return undefined;
            }
            case "ExprBody": return yield* this.eval(node.expr, scope);
            case "ExprStmt": return yield* this.eval(node.expr, scope);
            // A taken branch may `return` — pass its RETURN wrapper up to the block/program loop.
            case "If": {
                if (yield* this.eval(node.test, scope)) return yield* this.eval(node.cons, scope);
                if (node.alt) return yield* this.eval(node.alt, scope);
                return undefined;
            }
            case "VarDecl": {
                const val = yield* this.eval(node.init, scope);
                if (node.pattern) { this.bindPattern(scope, node.pattern, val); return undefined; }
                scope[node.name] = val;
                return undefined;
            }
            case "ForOf": {
                const iterable = yield* this.eval(node.iter, scope);
                // Must be iterable — a non-iterable throws a catchable TypeError, not a guard error. Every
                // iterable reachable here is FINITE (arrays, NodeLists, strings, Array(n).keys()…): no
                // generator syntax, and `Symbol` isn't in scope, so no infinite iterator can be built — the
                // same termination property spread already relies on. The body is mediated like any code.
                if (iterable == null || typeof (iterable as { [Symbol.iterator]?: unknown })[Symbol.iterator] !== "function")
                    throw new TypeError("for…of over a non-iterable value");
                for (const item of iterable as Iterable<unknown>) {
                    const child = Object.create(scope);   // fresh per-iteration binding (const semantics)
                    child[node.name] = item;
                    const v = yield* this.eval(node.body, child);
                    if (v && typeof v === "object" && RETURN in (v as object)) return v;   // a `return` breaks out + propagates
                }
                return undefined;
            }
            case "Return": return { [RETURN]: yield* this.eval(node.arg, scope) };
            // `await X` — hand X to the driver, which awaits it (identity on a non-promise). The sync
            // driver has no way to, so an await inside a host callback (.map/.filter) falls out of dialect.
            case "Await": return yield yield* this.eval(node.arg, scope);
            case "Lit": return node.value;
            // A regex literal → a real RegExp. Pure value: no realm walk-back (its props are source/flags/
            // lastIndex — none in DENIED_PROPS is needed), and it can only be USED via allowlisted methods
            // (String.match/replace/split or RegExp.test/exec). An invalid pattern throws → falls back to approval.
            case "Regex": try { return new RegExp(node.pattern, node.flags); } catch { throw new NotInDialect("invalid regex"); }
            case "Ident": {
                if (node.name in scope) return scope[node.name];
                throw new Denied(`'${node.name}' is not available`);
            }
            case "Array": {
                const arr: unknown[] = [];
                for (const e of node.elements) {
                    if (e.type === "Spread") { for (const v of (yield* this.eval(e.arg, scope)) as Iterable<unknown>) arr.push(v); }
                    else arr.push(yield* this.eval(e, scope));
                }
                return this.own(arr);
            }
            case "Object": {
                const o: Record<string, unknown> = {};
                for (const p of node.props) {
                    if ("spread" in p) {
                        // Copy the spread source's OWN ENUMERABLE properties, each through the member-read
                        // guard (denied props throw; a function value → the inert sentinel — so a spread can't
                        // launder a live method into a plain object). null/undefined/primitives spread nothing.
                        const src = yield* this.eval(p.spread, scope);
                        if (src != null) for (const k of Object.keys(Object(src))) o[k] = this.prop(src, k);
                    } else {
                        o[p.key] = yield* this.eval(p.value, scope);
                    }
                }
                return this.own(o);
            }
            case "Arrow": {
                const self = this;
                // The value form: a plain function, because this is what a host method gets handed
                // (`arr.map(fn)`) and those invoke it SYNCHRONOUSLY. A direct call goes through
                // ourFns/callArrow instead, so only the callback case is restricted.
                const fn = function (...args: unknown[]) { return runSync(self.callArrow(node, scope, args)); };
                this.ourFns.set(fn, { node, scope });
                return fn;
            }
            case "New": {
                const ctor = SAFE_CONSTRUCTORS[node.ctor];
                if (!ctor) throw new Denied(`new ${node.ctor}() is not allowed — only pure builtins (Set, Map, Array, Date, RegExp, …)`);
                // A script-CREATED instance is owned, so its own mutators (Set.add / Map.set/…) pass the
                // MUTATING_METHODS gate. Mark it directly, not via own(): a Set/Map's prototype isn't
                // Object.prototype, so own()'s isWritableTarget check would skip it. (Assignment `o[k]=v`
                // stays restricted to plain objects/arrays — the Assign case re-checks isWritableTarget.)
                const inst = new ctor(...(yield* this.evalArgs(node.args, scope)));
                if (inst !== null && typeof inst === "object") this.owned.add(inst as object);
                return inst;
            }
            case "Assign": {
                // MEMBER-only, and the target must be a container the SCRIPT CREATED (`owned`) with a non-denied
                // key (guardKey). So a write can never touch a DOM node, a page array, a host object, `window`,
                // the scope, or the realm (__proto__/constructor/prototype) — assignment stays read-only w.r.t.
                // the page. A bare-name target (`window = …`, `x = …`) is refused outright (no env corruption).
                if (node.target.type !== "Member")
                    throw new NotInDialect("assignment is allowed only to a property of an object/array you built (o[k] = v), never a bare variable");
                const obj: any = yield* this.eval(node.target.obj, scope);
                const key = node.target.computed ? this.guardKey(yield* this.eval(node.target.prop, scope)) : this.guardKey(node.target.prop);
                // owned AND a plain object/array: a script-created Set/Map is owned (so its mutator METHODS
                // work) but is NOT a valid `o[k]=v` target — mutate it through .add/.set, not property writes.
                if (!this.owned.has(obj) || !isWritableTarget(obj))
                    throw new Denied("can only assign to an object or array you built — never a DOM node, a page object, or the environment");
                const val = yield* this.eval(node.value, scope);
                obj[key] = val;
                return val;
            }
            case "Unary": {
                const a = yield* this.eval(node.arg, scope);
                if (node.op === "!") return !a;
                if (node.op === "-") return -(a as number);
                return typeof a;
            }
            case "Logical": {
                const l = yield* this.eval(node.left, scope);
                if (node.op === "&&") return l ? yield* this.eval(node.right, scope) : l;
                if (node.op === "||") return l ? l : yield* this.eval(node.right, scope);
                return l != null ? l : yield* this.eval(node.right, scope);   // ??
            }
            case "Binary": {
                const l: any = yield* this.eval(node.left, scope), r: any = yield* this.eval(node.right, scope);
                switch (node.op) {
                    case "===": return l === r; case "!==": return l !== r;
                    case "==": return l == r; case "!=": return l != r;
                    case "<": return l < r; case ">": return l > r;
                    case "<=": return l <= r; case ">=": return l >= r;
                    case "+": return l + r; case "-": return l - r;
                    case "*": return l * r; case "/": return l / r; case "%": return l % r;
                }
                throw new NotInDialect(`operator ${node.op}`);
            }
            case "Cond": return (yield* this.eval(node.cond, scope)) ? yield* this.eval(node.cons, scope) : yield* this.eval(node.alt, scope);
            // The chain result is CONSUMED here (not another chain link) → unwrap a short-circuit to undefined.
            case "Member": { const v = yield* this.readMember(node, scope); return v === SHORT ? undefined : v; }
            case "Call": { const v = yield* this.evalCall(node, scope); return v === SHORT ? undefined : v; }
            case "Template": {
                // Concatenate quasi[0] expr[0] quasi[1] … — String() coercion, exactly like JS.
                let out = node.quasis[0];
                for (let k = 0; k < node.exprs.length; k++) out += String(yield* this.eval(node.exprs[k], scope)) + node.quasis[k + 1];
                return out;
            }
            case "Try": {
                // A NotInDialect/Denied is a GUARD signal, not a program error — it must ALWAYS reach the
                // driver so the survey escalates to the human gate. A user catch/finally can never swallow
                // it (that's the whole safety property); a normal throw (a DOM op, JSON.parse, …) IS caught.
                let result: unknown, guardErr: NotInDialect | Denied | null = null, otherErr: unknown, hasOther = false;
                try {
                    result = yield* this.eval(node.block, scope);   // undefined or a RETURN wrapper
                } catch (e) {
                    if (e instanceof NotInDialect || e instanceof Denied) guardErr = e;
                    else if (node.handler) {
                        const child = Object.create(scope);
                        if (node.param) child[node.param] = e;
                        try { result = yield* this.eval(node.handler, child); }
                        catch (e2) { if (e2 instanceof NotInDialect || e2 instanceof Denied) guardErr = e2; else { otherErr = e2; hasOther = true; } }
                    } else { otherErr = e; hasOther = true; }
                }
                if (node.finalizer) {
                    const f = yield* this.eval(node.finalizer, scope);
                    // A `return` in finally overrides a normal result/throw — but NEVER a guard denial.
                    if (!guardErr && f && typeof f === "object" && RETURN in (f as object)) return f;
                }
                if (guardErr) throw guardErr;   // escalate — no try/catch/finally can paper over a denial
                if (hasOther) throw otherErr;
                return result;                  // undefined or a RETURN wrapper (propagates up the block loop)
            }
        }
        throw new NotInDialect(`node '${node.type}'`);
    }

    // Evaluate call arguments, expanding spread (`f(...args)`).
    private *evalArgs(args: Node[], scope: any): Ev<unknown[]> {
        const out: unknown[] = [];
        for (const a of args) {
            if (a.type === "Spread") { for (const v of (yield* this.eval(a.arg, scope)) as Iterable<unknown>) out.push(v); }
            else out.push(yield* this.eval(a, scope));
        }
        return out;
    }

    // Invoke one of OUR arrows: bind the params in a child scope and evaluate its body. The depth
    // guard unwinds in `finally`, which runs even when the sync driver closes the generator early.
    private *callArrow(node: Node, scope: any, args: unknown[]): Ev {
        if (++this.depth > 5000) { this.depth--; throw new NotInDialect("recursion limit"); }
        try {
            const child = Object.create(scope);
            (node.params as (string | Node)[]).forEach((p, idx) => {
                if (typeof p === "string") child[p] = args[idx];
                else this.bindPattern(child, p, args[idx]);   // a destructuring param `([a,b])` / `({a,b})` — mediated
            });
            const r = yield* this.eval(node.body, child);
            return r && typeof r === "object" && RETURN in (r as object) ? (r as any)[RETURN] : r;
        } finally { this.depth--; }
    }

    private *evalCall(node: Node, scope: any): Ev {
        const callee = node.callee;
        // obj.method(args) — the common case. Allowlisted method names only.
        if (callee.type === "Member") {
            const obj: any = yield* this.evalChain(callee.obj, scope);
            if (obj === SHORT) return SHORT;                    // the receiver chain short-circuited → skip the call
            if (callee.optional && obj == null) return SHORT;
            const key = callee.computed ? this.guardKey(yield* this.eval(callee.prop, scope)) : this.guardKey(callee.prop);
            // The `ml` facade carries its OWN allowlist — it holds nothing but the read-only API methods,
            // so "is it on the facade" is the whole check. Their names deliberately never join
            // ALLOWED_METHODS, which is keyed by NAME across every object in scope.
            const onMl = this.ml !== null && obj === this.ml;
            if (onMl ? !Object.prototype.hasOwnProperty.call(this.ml, key) : !ALLOWED_METHODS.has(key)) {
                throw new NotInDialect(`method '${key}' not allowed`);
            }
            // An in-place MUTATOR (push/sort/…) may run ONLY on a container the script itself created — never an
            // array reached off a page value. So `pageState.items.push(x)` / `.sort()` can't mutate page data.
            if (MUTATING_METHODS.has(key) && !this.owned.has(obj))
                throw new Denied(`'${key}' can only mutate an array you created, not one reached from the page`);
            // `x.then(cb)` where x is NOT a thenable — the shape models write over the ml reads
            // (`ml.getModel().then(m => …)`), which auto-await left a plain value. Apply the callback
            // to it: Promise.resolve(x).then(cb) semantics, without minting a promise. Driven by OUR
            // driver, so an await inside the callback still works (unlike a host-invoked one).
            if (key === "then" && typeof obj?.then !== "function") {
                const [cb] = yield* this.evalArgs(node.args, scope);
                const ours = typeof cb === "function" ? this.ourFns.get(cb as Function) : undefined;
                if (!ours) throw new NotInDialect("then() needs an inline callback");
                return yield* this.callArrow(ours.node, ours.scope, [obj]);
            }
            const fn = obj?.[key];
            // The method name already passed the allowlist (above), so a non-function here is a RUNTIME
            // error — the receiver is null/undefined or the wrong type (`document.querySelector('#gone')
            // .getAttribute(x)`). Throw a real TypeError, NOT a guard NotInDialect: it's catchable by a
            // dialect try/catch (so a survey can handle a missing element in-dialect, no escalation),
            // while genuine denials (Denied / method-not-allowed NotInDialect) still bypass catch.
            if (typeof fn !== "function") throw new TypeError(`${obj == null ? String(obj) : "value"} has no callable '${key}'`);
            const out = fn.apply(obj, yield* this.evalArgs(node.args, scope));
            // Auto-await an ml call ONLY when it actually returns a promise (getModel/config/… round-trip),
            // so a forgotten `await` still reads the value. The SYNC ml reads (queryAll, range) return a plain
            // value — pass it straight through WITHOUT yielding, so they work inside a `.map`/`.filter` callback
            // (the sync driver can't honour a yield). Yielding those unconditionally was why `cs.map(s =>
            // ml.queryAll(s).length)` fell out of dialect.
            // `this.own`: a FRESH plain array/object our allowlisted methods return (.map/.filter/.slice/
            // Object.entries/JSON.parse/…) becomes mutable, so `arr.filter(…).push(x)` and the accumulator
            // idioms work. Page arrays are never RETURNED by an allowlisted method (they all build new ones),
            // so this can't launder a live page container — the mutator gate above still refuses page arrays.
            if (onMl) return this.own((out != null && typeof (out as { then?: unknown }).then === "function") ? yield out : out);
            // Accommodate a common model mistake: querySelectorAll / getElementsBy* return a NodeList /
            // HTMLCollection, which have no .map/.filter, so `querySelectorAll('x').map(…)` throws (the
            // model forgets to spread). In this read-only dialect it's safe to just hand back a real
            // Array, so the survey runs instead of falling through to the manual gate.
            return this.own(isDomCollection(out) ? Array.from(out as ArrayLike<unknown>) : out);
        }
        // Ident(args) — only whitelisted coercion/parse builtins.
        if (callee.type === "Ident" && CALLABLE_ROOTS.has(callee.name) && callee.name in scope) {
            const fn = scope[callee.name] as Function;
            return fn(...(yield* this.evalArgs(node.args, scope)));
        }
        // (arrow)(args) / immediately-invoked arrow (or function expression). Driven by OUR driver
        // rather than through the sync wrapper, so an `await` inside an IIFE is honoured.
        const fn = yield* this.eval(callee, scope);
        const ours = typeof fn === "function" ? this.ourFns.get(fn as Function) : undefined;
        if (ours) return yield* this.callArrow(ours.node, ours.scope, yield* this.evalArgs(node.args, scope));
        throw new NotInDialect("call target not allowed");
    }
}

// -------------------------------------------------------------------- drivers ---

/** Run an evaluation to completion, AWAITING every yielded value. The top-level driver. A rejected
 *  awaited value (e.g. an `ml` read that throws) is thrown BACK INTO the generator via `gen.throw`, so a
 *  dialect `try { await … } catch` can catch it; uncaught, it propagates out (→ falls back to approval). */
async function runAsync(gen: Ev): Promise<unknown> {
    let sent: unknown, err: unknown, hasErr = false;
    for (;;) {
        const r = hasErr ? gen.throw(err) : gen.next(sent);
        hasErr = false;
        if (r.done) return r.value;
        try { sent = await r.value; }
        catch (e) { err = e; hasErr = true; }
    }
}

/** Run one SYNCHRONOUSLY — for an arrow a host method invokes (`arr.map(fn)` calls fn synchronously,
 *  so there is nowhere to await). A yield means the body tried to: close the generator (its `finally`
 *  unwinds the depth guard) and fall out of dialect, so the survey drops to the approval path. */
function runSync(gen: Ev): unknown {
    const r = gen.next();
    if (!r.done) { gen.return(undefined); throw new NotInDialect("await is not supported inside a callback"); }
    return r.value;
}

// -------------------------------------------------------------------- entry ---

/**
 * Evaluate a read-only survey. `document` and the read-only slice of `ml`
 * ({@link ML_READONLY_METHODS}, omitted when `ml` is absent) are the only host objects
 * injected; all other globals are this module's own (safe) intrinsics. Returns the
 * program value plus any captured console output. Rejects with NotInDialect / Denied on
 * anything outside the dialect or blocked — callers fall back to approval+eval.
 */
export async function evalReadonly(code: string, doc: Document, ml?: unknown): Promise<{ value: unknown; logs: string[]; reused: string[] }> {
    const logs: string[] = [];
    const rec = (...a: unknown[]) => logs.push(a.map(x => typeof x === "string" ? x : safeStr(x)).join(" "));
    const reused: string[] = [];   // ml.fetch cache hits — URLs this survey re-read from a prior approval
    const facade = mlFacade(ml, reused);
    const root: Record<string, unknown> = Object.create(null);
    Object.assign(root, {
        document: doc, Array, Object, JSON, Math, String, Number, Boolean, Promise,
        parseInt, parseFloat, isNaN, isFinite, undefined, NaN, Infinity,
        console: { log: rec, info: rec, warn: rec, error: rec, debug: rec },
    });
    if (facade) root.ml = facade;
    // getComputedStyle bound to the view (never exposed itself, so calling it can't hand back `window`).
    // Its CSSStyleDeclaration reads are mediated like any other object; the walk-back to window is denied.
    const view = doc.defaultView;
    if (view && typeof view.getComputedStyle === "function") root.getComputedStyle = view.getComputedStyle.bind(view);
    const ast = new Parser(tokenize(code)).parseProgram();
    const value = await runAsync(new Evaluator(facade).eval(ast, root));
    return { value, logs, reused };
}

function safeStr(x: unknown): string { try { return JSON.stringify(x); } catch { return String(x); } }
