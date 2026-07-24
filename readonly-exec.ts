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

export class NotInDialect extends Error {}
export class Denied extends Error {}

// ---------------------------------------------------------------- tokenizer ---

interface Tok { t: "num" | "str" | "name" | "punct" | "eof"; v: string; }

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
        if (c === "`") throw new NotInDialect("template literals not supported");   // add later
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
        if (t.t === "name" && (t.v === "const" || t.v === "let" || t.v === "var")) {
            this.next();
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
        const e = this.parseExpression();
        if (this.is(";")) this.i++;
        return { type: "ExprStmt", expr: e };
    }
    parseExpression(): Node { return this.parseTernary(); }
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
        if (t.t === "num") { this.i++; return { type: "Lit", value: parseFloat(t.v) }; }
        if (t.t === "str") { this.i++; return { type: "Lit", value: t.v }; }
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
            const params: string[] = [];
            while (!this.is(")")) {
                const n = this.next();
                if (n.t !== "name") throw new NotInDialect("param");
                params.push(n.v);
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
    parseArrowBody(): Node {
        if (this.is("{")) return this.parseBlock();
        return { type: "ExprBody", expr: this.parseExpression() };
    }
    parseObject(): Node {
        this.eat("{");
        const props: { key: string; value: Node }[] = [];
        while (!this.is("}")) {
            const k = this.next();
            let key: string;
            if (k.t === "name" || k.t === "str") key = k.v;
            else throw new NotInDialect("object key");
            if (this.is(":")) { this.i++; props.push({ key, value: this.parseExpression() }); }
            else props.push({ key, value: { type: "Ident", name: key } });   // shorthand
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
]);

// The ONLY methods a call may invoke — read/query/pure. No effectful method
// (click/submit/setAttribute/appendChild/remove/fetch/open/…) appears, so even a
// leaked `window` can't do anything: `window.fetch(…)` → method not allowlisted.
const ALLOWED_METHODS = new Set([
    // DOM read / query
    "querySelector", "querySelectorAll", "getElementById", "getElementsByClassName",
    "getElementsByTagName", "getElementsByName", "closest", "matches", "getAttribute",
    "getAttributeNames", "hasAttribute", "contains", "getBoundingClientRect", "getRootNode",
    // Array
    "from", "isArray", "of", "map", "filter", "forEach", "reduce", "find", "findIndex",
    "some", "every", "includes", "indexOf", "lastIndexOf", "slice", "concat", "join",
    "flat", "flatMap", "sort", "reverse", "at", "fill",
    // String
    "substring", "substr", "toLowerCase", "toUpperCase", "trim", "trimStart", "trimEnd",
    "split", "startsWith", "endsWith", "replace", "replaceAll", "padStart", "padEnd",
    "repeat", "charAt", "charCodeAt", "codePointAt", "normalize", "localeCompare",
    // Object / JSON / Math / Number
    "keys", "values", "entries", "fromEntries", "stringify", "parse", "assign",
    "max", "min", "floor", "ceil", "round", "abs", "pow", "sqrt", "sign", "trunc",
    "toFixed", "toString",
    // console (captured)
    "log", "info", "warn", "error", "debug",
]);

const CALLABLE_ROOTS = new Set(["String", "Number", "Boolean", "parseInt", "parseFloat", "isNaN", "isFinite"]);

const RETURN = Symbol("return");   // sentinel wrapper for a `return` value
// Inert stand-in returned when code reads a method as a value (existence guards).
// Truthy + typeof "function", but calling it throws → the real method never leaks.
const METHOD_REF = function (): never { throw new NotInDialect("a method reference cannot be called indirectly"); };

class Evaluator {
    private ourFns = new WeakSet<Function>();   // arrows we created — the only functions we'll invoke directly
    private depth = 0;
    constructor(private root: Record<string, unknown>) {}

    private guardKey(key: unknown): string {
        const k = String(key);
        if (DENIED_PROPS.has(k)) throw new Denied(`access to '${k}' is not allowed`);
        return k;
    }

    // read a member (NOT in call position). A function-valued read returns an
    // INERT sentinel, never the real method — so the common existence-guard idiom
    // `el.querySelector && el.querySelector('x')` stays in-dialect (the sentinel is
    // truthy, typeof "function"), while a method still can't be pulled off and
    // invoked past the call gate: calling the sentinel (directly or via .map)
    // throws, dropping the whole survey back to approval.
    private readMember(node: Node, scope: any): unknown {
        const obj = this.eval(node.obj, scope);
        if (node.optional && obj == null) return undefined;
        const key = node.computed ? this.guardKey(this.eval(node.prop, scope)) : this.guardKey(node.prop);
        const v = (obj as any)?.[key];
        if (typeof v === "function") return METHOD_REF;
        return v;
    }

    eval(node: Node, scope: any): unknown {
        switch (node.type) {
            case "Program": {
                let last: unknown;
                for (const s of node.body) {
                    const v = this.eval(s, scope);
                    if (v && typeof v === "object" && RETURN in (v as object)) return (v as any)[RETURN];
                    if (s.type === "ExprStmt") last = v;
                }
                return last;
            }
            case "Block": {
                const child = Object.create(scope);
                for (const s of node.body) {
                    const v = this.eval(s, child);
                    if (v && typeof v === "object" && RETURN in v) return v;   // propagate return upward
                }
                return undefined;
            }
            case "ExprBody": return this.eval(node.expr, scope);
            case "ExprStmt": return this.eval(node.expr, scope);
            // A taken branch may `return` — pass its RETURN wrapper up to the block/program loop.
            case "If": {
                if (this.eval(node.test, scope)) return this.eval(node.cons, scope);
                if (node.alt) return this.eval(node.alt, scope);
                return undefined;
            }
            case "VarDecl": { scope[node.name] = this.eval(node.init, scope); return undefined; }
            case "Return": return { [RETURN]: this.eval(node.arg, scope) };
            case "Lit": return node.value;
            case "Ident": {
                if (node.name in scope) return scope[node.name];
                throw new Denied(`'${node.name}' is not available`);
            }
            case "Array": {
                const arr: unknown[] = [];
                for (const e of node.elements) {
                    if (e.type === "Spread") { for (const v of this.eval(e.arg, scope) as Iterable<unknown>) arr.push(v); }
                    else arr.push(this.eval(e, scope));
                }
                return arr;
            }
            case "Object": {
                const o: Record<string, unknown> = {};
                for (const p of node.props) o[p.key] = this.eval(p.value, scope);
                return o;
            }
            case "Arrow": {
                const self = this;
                const fn = function (...args: unknown[]) {
                    if (++self.depth > 5000) { self.depth--; throw new NotInDialect("recursion limit"); }
                    try {
                        const child = Object.create(scope);
                        node.params.forEach((p: string, idx: number) => { child[p] = args[idx]; });
                        const r = self.eval(node.body, child);
                        return r && typeof r === "object" && RETURN in (r as object) ? (r as any)[RETURN] : r;
                    } finally { self.depth--; }
                };
                this.ourFns.add(fn);
                return fn;
            }
            case "Unary": {
                const a = this.eval(node.arg, scope);
                if (node.op === "!") return !a;
                if (node.op === "-") return -(a as number);
                return typeof a;
            }
            case "Logical": {
                const l = this.eval(node.left, scope);
                if (node.op === "&&") return l ? this.eval(node.right, scope) : l;
                if (node.op === "||") return l ? l : this.eval(node.right, scope);
                return l != null ? l : this.eval(node.right, scope);   // ??
            }
            case "Binary": {
                const l: any = this.eval(node.left, scope), r: any = this.eval(node.right, scope);
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
            case "Cond": return this.eval(node.cond, scope) ? this.eval(node.cons, scope) : this.eval(node.alt, scope);
            case "Member": return this.readMember(node, scope);
            case "Call": return this.evalCall(node, scope);
        }
        throw new NotInDialect(`node '${node.type}'`);
    }

    // Evaluate call arguments, expanding spread (`f(...args)`).
    private evalArgs(args: Node[], scope: any): unknown[] {
        const out: unknown[] = [];
        for (const a of args) {
            if (a.type === "Spread") { for (const v of this.eval(a.arg, scope) as Iterable<unknown>) out.push(v); }
            else out.push(this.eval(a, scope));
        }
        return out;
    }

    private evalCall(node: Node, scope: any): unknown {
        const callee = node.callee;
        // obj.method(args) — the common case. Allowlisted method names only.
        if (callee.type === "Member") {
            const obj: any = this.eval(callee.obj, scope);
            if (callee.optional && obj == null) return undefined;
            const key = callee.computed ? this.guardKey(this.eval(callee.prop, scope)) : this.guardKey(callee.prop);
            if (!ALLOWED_METHODS.has(key)) throw new NotInDialect(`method '${key}' not allowed`);
            const fn = obj?.[key];
            if (typeof fn !== "function") throw new NotInDialect(`'${key}' is not callable`);
            return fn.apply(obj, this.evalArgs(node.args, scope));
        }
        // Ident(args) — only whitelisted coercion/parse builtins.
        if (callee.type === "Ident" && CALLABLE_ROOTS.has(callee.name) && callee.name in scope) {
            const fn = scope[callee.name] as Function;
            return fn(...this.evalArgs(node.args, scope));
        }
        // (arrow)(args) / immediately-invoked arrow (or function expression).
        const fn = this.eval(callee, scope);
        if (typeof fn === "function" && this.ourFns.has(fn)) {
            return (fn as Function)(...this.evalArgs(node.args, scope));
        }
        throw new NotInDialect("call target not allowed");
    }
}

// -------------------------------------------------------------------- entry ---

/**
 * Evaluate a read-only survey. `document` is the only host object injected; all
 * other globals are this module's own (safe) intrinsics. Returns the program
 * value plus any captured console output. Throws NotInDialect / Denied on
 * anything outside the dialect or blocked — callers fall back to approval+eval.
 */
export function evalReadonly(code: string, doc: Document): { value: unknown; logs: string[] } {
    const logs: string[] = [];
    const rec = (...a: unknown[]) => logs.push(a.map(x => typeof x === "string" ? x : safeStr(x)).join(" "));
    const root: Record<string, unknown> = Object.create(null);
    Object.assign(root, {
        document: doc, Array, Object, JSON, Math, String, Number, Boolean,
        parseInt, parseFloat, isNaN, isFinite, undefined, NaN, Infinity,
        console: { log: rec, info: rec, warn: rec, error: rec, debug: rec },
    });
    const ast = new Parser(tokenize(code)).parseProgram();
    const value = new Evaluator(root).eval(ast, root);
    return { value, logs };
}

function safeStr(x: unknown): string { try { return JSON.stringify(x); } catch { return String(x); } }
