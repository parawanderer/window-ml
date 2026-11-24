// classify-js.mjs — the cell classifier's JS half: an `exec` cell's labels and flags, read from its syntax tree
// (docs/spec/CELL_FACTS.md, Half 2). The Python half and the export reader are classify.py, which calls this.
//
//   node --import tsx notebooks/cell-labels/classify-js.mjs < cells.jsonl > labels.jsonl
//
// Each input line is `{ "id": …, "js": "<source>" }`; each output line is `{ "id", "labels", "flags", "imports",
// "lines", "parser" }`. A cell is parsed by the dialect's own parser first (after the pointer macro, as `exec` runs it),
// and by acorn when the dialect refuses it; both trees are read as ESTree. The rules are labels.json.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as acorn from "acorn";
import { tokenize } from "../../src/readonly-exec/tokenizer.ts";
import { Parser } from "../../src/readonly-exec/parser.ts";
import { expandPointers } from "../../src/pointers/pointer-macro.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** The rules file, read once: labels.json. */
export const RULES = JSON.parse(fs.readFileSync(path.join(HERE, "labels.json"), "utf8"));

// --- the dialect's tree, read as ESTree ---

const id = (name) => ({ type: "Identifier", name });

/** One node of the dialect's AST as the ESTree node acorn would build for the same source; throws on a shape it does not know. */
function estree(n) {
    if (n === null || n === undefined) return null;
    if (typeof n === "string") return id(n);
    const e = estree;
    switch (n.type) {
        case "Program": return { type: "Program", body: n.body.map(e) };
        case "Block": return { type: "BlockStatement", body: n.body.map(e) };
        // The dialect reads `function f(x) { … }` as a statement holding an unnamed function; acorn, as a declaration.
        case "ExprStmt": return n.expr.type === "Arrow" && n.expr.body.type === "Block" && !n.expr.paren
            ? { type: "FunctionDeclaration", params: n.expr.params.map(e), body: e(n.expr.body) }
            : { type: "ExpressionStatement", expression: e(n.expr) };
        case "If": return { type: "IfStatement", test: e(n.test), consequent: e(n.cons), alternate: e(n.alt) };
        case "ForOf": return { type: "ForOfStatement", left: { type: "VariableDeclaration", kind: n.kind, declarations: [{ type: "VariableDeclarator", id: n.pattern ? e(n.pattern) : id(n.name), init: null }] }, right: e(n.iter), body: e(n.body) };
        case "VarDecl": return { type: "VariableDeclaration", kind: n.kind, declarations: [{ type: "VariableDeclarator", id: n.pattern ? e(n.pattern) : id(n.name), init: e(n.init) }] };
        case "Return": return { type: "ReturnStatement", argument: e(n.arg) };
        case "Try": return { type: "TryStatement", block: e(n.block), handler: n.handler ? { type: "CatchClause", param: n.param ? id(n.param) : null, body: e(n.handler) } : null, finalizer: e(n.finalizer) };
        case "Assign": return { type: "AssignmentExpression", operator: n.op === "=" ? "=" : n.op + "=", left: e(n.target), right: e(n.value) };
        case "Cond": return { type: "ConditionalExpression", test: e(n.cond), consequent: e(n.cons), alternate: e(n.alt) };
        case "Logical": return { type: "LogicalExpression", operator: n.op, left: e(n.left), right: e(n.right) };
        case "Binary": return { type: "BinaryExpression", operator: n.op, left: e(n.left), right: e(n.right) };
        case "Await": return { type: "AwaitExpression", argument: e(n.arg) };
        case "Unary": return { type: "UnaryExpression", operator: n.op, argument: e(n.arg) };
        case "Update": return { type: "UpdateExpression", operator: n.op + n.op, prefix: n.prefix, argument: e(n.arg) };
        case "Member": return { type: "MemberExpression", object: e(n.obj), property: n.computed ? e(n.prop) : id(n.prop), computed: !!n.computed };
        case "Call": return { type: "CallExpression", callee: e(n.callee), arguments: n.args.map(e) };
        case "New": return { type: "NewExpression", callee: id(n.ctor), arguments: n.args.map(e) };
        case "Spread": return { type: "SpreadElement", argument: e(n.arg) };
        case "Arrow": {
            const block = n.body.type === "Block";
            return { type: "ArrowFunctionExpression", params: n.params.map(e), body: block ? e(n.body) : e(n.body.expr), expression: !block };
        }
        case "Array": return { type: "ArrayExpression", elements: n.elements.map(e) };
        case "Object": return { type: "ObjectExpression", properties: n.props.map(p => "spread" in p ? { type: "SpreadElement", argument: e(p.spread) } : { type: "Property", key: id(p.key), value: e(p.value) }) };
        case "ArrayPattern": return { type: "ArrayPattern", elements: [...n.elems.map(x => x === null ? null : id(x)), ...(n.rest ? [{ type: "RestElement", argument: id(n.rest) }] : [])] };
        case "ObjectPattern": return { type: "ObjectPattern", properties: n.keys.map(k => ({ type: "Property", key: id(k), value: id(k) })) };
        case "Template": return { type: "TemplateLiteral", quasis: n.quasis.map(q => ({ type: "TemplateElement", value: { cooked: q } })), expressions: n.exprs.map(e) };
        case "Regex": return { type: "Literal", value: null, regex: { pattern: n.pattern, flags: n.flags } };
        case "Lit": return { type: "Literal", value: n.value };
        case "Ident": return id(n.name);
        default: throw new Error(`unknown dialect node ${n.type}`);
    }
}

/** The cell's tree and which parser built it, or null when neither parses it. */
export function parseCell(js) {
    const src = expandPointers(js).code;
    try { return { tree: estree(new Parser(tokenize(src)).parseProgram()), parser: "dialect" }; } catch { /* the fallback below */ }
    try {
        return { tree: acorn.parse(src, { ecmaVersion: "latest", sourceType: "script", allowReturnOutsideFunction: true, allowAwaitOutsideFunction: true }), parser: "acorn" };
    } catch {
        return null;
    }
}

// --- names ---

const globRx = new Map();
/** Whether a dotted name matches one of a list of globs (`*` matches anything, dots included). */
export function matches(name, globs) {
    if (!name || !globs) return false;
    return globs.some(g => {
        let rx = globRx.get(g);
        if (!rx) globRx.set(g, rx = new RegExp("^" + g.split("*").map(s => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$"));
        return rx.test(name);
    });
}

/** A callee's or a read's dotted name; a receiver that is not a plain name or member chain reads as `*`. */
function dotted(x) {
    if (!x) return "*";
    if (x.type === "Identifier") return x.name;
    if (x.type === "ThisExpression") return "this";
    if (x.type === "MemberExpression") {
        const o = x.object.type === "Identifier" || x.object.type === "MemberExpression" || x.object.type === "ThisExpression" ? dotted(x.object) : "*";
        const p = !x.computed ? x.property.name : x.property.type === "Literal" && typeof x.property.value === "string" ? x.property.value : "*";
        return o + "." + p;
    }
    return "*";
}

const calleeName = (c) => dotted(c.callee);
const isCall = (n, globs) => n && (n.type === "CallExpression" || n.type === "NewExpression") && matches(calleeName(n), globs);
const LOOPS = new Set(["ForStatement", "ForOfStatement", "ForInStatement", "WhileStatement", "DoWhileStatement"]);
const FUNCS = new Set(["ArrowFunctionExpression", "FunctionExpression", "FunctionDeclaration"]);

/** Every child node of an ESTree node, in source order. */
function children(n) {
    const out = [];
    for (const k in n) {
        if (k === "type" || k === "start" || k === "end" || k === "loc" || k === "range" || k === "regex") continue;
        const v = n[k];
        if (Array.isArray(v)) { for (const x of v) if (x && typeof x.type === "string") out.push(x); }
        else if (v && typeof v.type === "string") out.push(v);
    }
    return out;
}

/** Whether a subtree holds a node for which `pred` holds. */
function contains(n, pred) {
    if (!n) return false;
    if (pred(n)) return true;
    return children(n).some(c => contains(c, pred));
}

// --- the labels ---

/** One `exec` cell's labels and flags (docs/spec/CELL_FACTS.md, Half 2). */
export function classifyJs(js, rules = RULES) {
    const R = rules.js;
    const lines = (js || "").split("\n").length;
    const parsed = parseCell(js || "");
    if (!parsed) return { labels: ["unparsed"], flags: [], imports: [], lines, parser: null };
    const { tree, parser } = parsed;
    const labels = new Set(), flags = new Set(), imports = new Set();

    const isSepSplit = (n) => {
        if (!n || n.type !== "CallExpression" || n.callee.type !== "MemberExpression" || dotted(n.callee).split(".").pop() !== "split") return false;
        const a = n.arguments[0];
        if (!a || a.type !== "Literal") return false;
        if (a.regex) return R.parse.split_regex_chars.some(ch => a.regex.pattern.includes(ch));
        return R.parse.split_separators.includes(a.value);
    };
    // Calls that feed a separator split (`txt.trim().split("\n")`) are part of the parse, not a transform.
    const feedsParse = new Set();
    const markFeed = (split) => {
        let recv = split.callee.object;
        while (recv && recv.type === "CallExpression" && matches(calleeName(recv), R.parse.map_chain_through)) { feedsParse.add(recv); recv = recv.callee.object; }
    };
    (function mark(n) { if (!n) return; if (isSepSplit(n)) markFeed(n); children(n).forEach(mark); })(tree);

    /** A `map` that is part of a hand parse: chained on a separator split, or splitting each item itself. */
    const mapIsParse = (n) => {
        let recv = n.callee.object;
        while (recv && recv.type === "CallExpression" && !isSepSplit(recv) && matches(calleeName(recv), R.parse.map_chain_through)) recv = recv.callee.object;
        return isSepSplit(recv) || contains(n.arguments[0], isSepSplit);
    };

    // The values a cell hands back: a top-level bare expression or return, and every console.log argument.
    const outputs = [];
    const expand = (v, out) => {
        if (!v) return out;
        out.push(v);
        if (v.type === "AwaitExpression") expand(v.argument, out);
        else if (isCall(v, R.inspect.unwrap)) expand(v.arguments[0], out);
        else if (v.type === "ConditionalExpression") { expand(v.consequent, out); expand(v.alternate, out); }
        else if (v.type === "ArrayExpression") v.elements.forEach(x => expand(x, out));
        else if (v.type === "ObjectExpression") v.properties.forEach(p => expand(p.type === "Property" ? p.value : null, out));
        else if (v.type === "TemplateLiteral") v.expressions.forEach(x => expand(x, out));
        return out;
    };

    function visit(n, ctx) {
        if (!n) return;
        const t = n.type;
        let next = ctx;
        if (LOOPS.has(t)) {
            // Only the body repeats per item: a `for (;;i++)` update is the loop's own counter, not an accumulation.
            flags.add("loop");
            const body = { ...ctx, loop: true };
            for (const k of ["init", "test", "update", "left", "right"]) visit(n[k], ctx);
            visit(n.body, body);
            return;
        }
        else if (FUNCS.has(t)) next = { ...ctx, fn: ctx.fn + 1 };
        if (t === "TryStatement") flags.add("try");
        if (t === "ImportExpression") { flags.add("import"); if (n.source.type === "Literal") imports.add(String(n.source.value)); }
        if (t === "ImportDeclaration") { flags.add("import"); imports.add(String(n.source.value)); }

        if (t === "FunctionDeclaration" && R.define.function) labels.add("define");
        if ((t === "ClassDeclaration") && R.define.class) labels.add("define");
        if (t === "VariableDeclarator" && n.init && (FUNCS.has(n.init.type) || n.init.type === "ClassExpression") && R.define.arrow_assigned) labels.add("define");

        if (ctx.fn === 0 && (t === "ExpressionStatement" || t === "ReturnStatement")) {
            const v = t === "ReturnStatement" ? n.argument : n.expression;
            if (v && !isCall(v, rules.js.output_calls)) outputs.push(v);
        }

        if (t === "Literal" && typeof n.value === "string" && R.ingest.pointer_strings.some(p => n.value.startsWith(p))) labels.add("ingest");

        if (t === "UnaryExpression" && n.operator === "typeof" && matches(dotted(n.argument), R.probe.typeof)) labels.add("probe");

        if (t === "CallExpression" || t === "NewExpression") {
            const name = calleeName(n);
            if (matches(name, rules.js.output_calls)) n.arguments.forEach(a => outputs.push(a));
            for (const lab of ["ingest", "parse", "list", "select", "aggregate", "report", "dom-read", "dom-act", "write", "shell", "plot"])
                if (matches(name, R[lab].calls)) labels.add(lab);
            if (matches(name, R["dom-read"].roots)) labels.add("dom-read");
            if (matches(name, R.transform.calls) && !feedsParse.has(n) && !(name.endsWith(".map") && mapIsParse(n))) labels.add("transform");
            if (isSepSplit(n)) labels.add("parse");
            if (matches(name, R.probe.keys_calls) && matches(dotted(n.arguments[0]), R.probe.keys_of)) labels.add("probe");
            if (matches(name, R.select.selector_calls)) {
                const a = n.arguments[0];
                if (a && a.type === "Literal" && typeof a.value === "string" && !new RegExp(R.select.trivial_selector).test(a.value.trim())) labels.add("select");
            }
            if (matches(name, R.aggregate.spread_calls) && n.arguments.some(a => a.type === "SpreadElement")) labels.add("aggregate");
            if (ctx.loop && matches(name, R.aggregate.set_get_in_loop) && n.arguments.some(a => contains(a, x => x.type === "CallExpression" && dotted(x.callee).endsWith(".get")))) labels.add("aggregate");
            // A forEach callback is a loop body for accumulation.
            if (matches(name, R.aggregate.loop_callbacks)) {
                visit(n.callee, ctx);
                n.arguments.forEach(a => visit(a, { ...ctx, loop: true }));
                return;
            }
            // The callee is a call, not a read: visit its receiver only.
            if (n.callee.type === "MemberExpression") { visit(n.callee.object, ctx); if (n.callee.computed) visit(n.callee.property, ctx); }
            else visit(n.callee, ctx);
            n.arguments.forEach(a => visit(a, next));
            return;
        }

        if (t === "MemberExpression" || t === "Identifier") {
            const name = dotted(n);
            if (matches(name, R["dom-read"].roots) || matches(name, R["dom-read"].reads)) labels.add("dom-read");
            if (matches(name, R.probe.reads)) labels.add("probe");
            if (matches(name, R.list.reads)) labels.add("list");
        }

        if (t === "AssignmentExpression") {
            const target = dotted(n.left);
            if (n.left.type === "MemberExpression") {
                if (matches(target, R["dom-act"].assign)) labels.add("dom-act");
                else if (n.operator === "=" && R.transform.assign_member) labels.add("transform");
            }
            if (n.operator !== "=" && ctx.loop && R.aggregate.accumulate_in_loop) labels.add("aggregate");
            if (n.left.type === "Identifier" && FUNCS.has(n.right.type) && R.define.arrow_assigned) labels.add("define");
            // The target is written, not read: visit only its receiver.
            if (n.left.type === "MemberExpression") { visit(n.left.object, next); if (n.left.computed) visit(n.left.property, next); }
            visit(n.right, next);
            return;
        }
        if (t === "UpdateExpression" && ctx.loop && R.aggregate.accumulate_in_loop) labels.add("aggregate");
        if (t === "VariableDeclarator") { visit(n.init, next); return; }
        if (FUNCS.has(t)) { visit(n.body, next); return; }
        if (t === "Property") { if (n.computed) visit(n.key, next); visit(n.value, next); return; }
        if (t === "MemberExpression") { visit(n.object, next); if (n.computed) visit(n.property, next); return; }
        for (const c of children(n)) visit(c, next);
    }
    visit(tree, { loop: false, fn: 0 });

    for (const v of outputs) {
        const cands = expand(v, []);
        if (cands.some(c => (c.type === "MemberExpression" && matches(dotted(c), R.inspect.output_reads))
            || (isCall(c, R.inspect.output_calls) && !matches(dotted(c.arguments[0]), R.probe.keys_of)))) labels.add("inspect");
        if (R.report.template_output && v.type === "TemplateLiteral" && v.expressions.length) labels.add("report");
    }

    const body = tree.body || [];
    const last = body[body.length - 1];
    if (last && (last.type === "ReturnStatement" || (last.type === "ExpressionStatement" && !isCall(last.expression, rules.js.output_calls)))) flags.add("returns");
    if (!labels.size) labels.add("other");
    return { labels: [...labels].sort(), flags: [...flags].sort(), imports: [...imports].sort(), lines, parser };
}

// --- the command: JSONL in, JSONL out ---

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const out = [];
    for (const line of fs.readFileSync(0, "utf8").split("\n")) {
        if (!line.trim()) continue;
        const { id: cellId, js } = JSON.parse(line);
        out.push(JSON.stringify({ id: cellId, ...classifyJs(js) }));
    }
    process.stdout.write(out.join("\n") + (out.length ? "\n" : ""));
}
