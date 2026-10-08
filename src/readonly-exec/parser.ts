// parser.ts — the read-only exec dialect's parser, tokens to an AST.
//
// Pratt/precedence-climbing over the token array. Every unexpected shape throws
// NotInDialect, so the parser can be deliberately incomplete and still safe.

import { NotInDialect } from "./limits";
import { Tok, COMPOUND, tokenize } from "./tokenizer";

/** An AST node of the dialect, as the parser builds it and the evaluator walks it. */
export type Node = any;

const BP: Record<string, number> = {
    "??": 1, "||": 1, "&&": 2, "===": 3, "!==": 3, "==": 3, "!=": 3,
    "<": 4, ">": 4, "<=": 4, ">=": 4, "+": 5, "-": 5, "*": 6, "/": 6, "%": 6,
    // EXPONENTIATION binds tighter than `*` and is RIGHT-associative (`2 ** 3 ** 2` is `2 ** 9`), exactly as in JS.
    "**": 7,
};

/** The dialect's Pratt parser: tokens to an AST, throwing NotInDialect on any shape it does not model. */
export class Parser {
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
        // Stamp the statement with the line it starts on — the granularity a reader and a model both want
        // ("line 4"), and the only one an interpreter can report honestly without carrying positions through
        // every expression node.
        const ln = this.peek().ln;
        const node = this.parseStatementInner();
        if (node.ln === undefined) node.ln = ln;
        return node;
    }
    parseStatementInner(): Node {
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
            return { type: "ForOf", kind: kw.v, name: id.v, iter, body };
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
                return { type: "VarDecl", kind: t.v, pattern, init };
            }
            const id = this.next();
            if (id.t !== "name") throw new NotInDialect("expected name");
            this.eat("=");
            const init = this.parseExpression();
            if (this.is(";")) this.i++;
            return { type: "VarDecl", kind: t.v, name: id.v, init };
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
    // Assignment is the LOWEST-precedence, right-associative level: `=` and the arithmetic compound forms. The
    // EVALUATOR mediates the target hard. A MEMBER write lands only on a script-local plain object/array, never a
    // DOM node / host object / the realm. A BARE NAME must resolve to a binding the script itself declared — the
    // host's own names live in a frame with a null prototype and are refused there — so the counter idiom
    // (`let n = 0; rows.forEach(r => n += r.x)`) runs, and nothing outside the evaluator can be written to.
    parseAssignment(): Node {
        const left = this.parseTernary();
        if (this.is("=")) { this.eat("="); return { type: "Assign", op: "=", target: left, value: this.parseAssignment() }; }
        const t = this.peek();
        if (t.t === "punct" && t.v in COMPOUND) {
            this.i++;
            return { type: "Assign", op: COMPOUND[t.v], target: left, value: this.parseAssignment() };
        }
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
            // JS refuses an UNPARENTHESISED unary operand on the left of `**` (`-2 ** 2` is a SyntaxError, because
            // whether it means (-2)**2 or -(2**2) is exactly what a reader gets wrong). Refused here too, so the
            // dialect never computes a value real JavaScript would not; `(-2) ** 2` parses, via the paren mark.
            if (op === "**" && (left.type === "Unary" || left.type === "Await") && !left.paren) throw new NotInDialect("a unary operand before ** must be parenthesised");
            const right = this.parseBinary(op === "**" ? BP[op] : BP[op] + 1);
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
        // Unary `+` is `Number(x)`, the idiom models write for a timestamp (`+new Date()`); it coerces exactly as `-` does.
        if (t.t === "punct" && (t.v === "!" || t.v === "-" || t.v === "+") || (t.t === "name" && t.v === "typeof")) {
            this.i++;
            return { type: "Unary", op: t.v, arg: this.parseUnary() };
        }
        // `++n` / `--n`. The counter a model actually writes; the same mediated target as `n += 1`.
        if (t.t === "punct" && (t.v === "++" || t.v === "--")) {
            this.i++;
            return { type: "Update", op: t.v === "++" ? "+" : "-", arg: this.parseUnary(), prefix: true };
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
        // `n++` / `n--`, AFTER the member/call chain, so `o.count++` reaches the same guarded member write that
        // `o.count += 1` does. Postfix yields the value BEFORE the change, which is the half of this that a
        // desugaring to `n += 1` would get wrong.
        const t = this.peek();
        if (t.t === "punct" && (t.v === "++" || t.v === "--")) {
            this.i++;
            return { type: "Update", op: t.v === "++" ? "+" : "-", arg: node, prefix: false };
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
            // Marked, for the one place grouping changes what is legal: a parenthesised unary operand of `**`.
            if (e && typeof e === "object") e.paren = true;
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
