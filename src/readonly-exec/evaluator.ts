// evaluator.ts — the read-only exec dialect's mediated evaluator (a generator over the AST) and the two drivers that
// run it: `runAsync` awaits each yield, `runSync` serves the callbacks a host method invokes synchronously.

import type { CurrentSnapshot } from "../agent/current-context";
import { isTable, isStoredTable } from "../table/table-brand";   // a table facade is recognised by BRAND, and the brand module is itself dependency-free
import { NotInDialect, MAX_STRING, MAX_COLLECTION, Denied, riskyRegex, MAX_STORED_CELLS, STEP_BUDGET, NeedsPage, MAX_CALL_DEPTH } from "./limits";
import { Node } from "./parser";
import { isWritableTarget, ReadonlyRealm, DENIED_PROPS, isDomCollection, SAFE_CONSTRUCTORS, ANSWER_METHODS, methodAllowed, kindOf, MUTATING_METHODS, CALLABLE_ROOTS } from "./policy";
import { PrintSwap, abridgeRow, diffSwap, jsonPathKey } from "./print";

/** Per-frame set of names declared `const`, kept off the frame's own enumerable keys. */
const CONSTS = Symbol("consts");

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

/** The mediated evaluator: walks the parsed AST as a generator, gating every read, call, write and allocation. */
export class Evaluator {
    // Arrows we created — the only functions we'll invoke directly. Keyed to their node+scope so a
    // DIRECT call (an IIFE) can be driven by the CALLER's driver (an await inside it still works),
    // while the bare wrapper a host method receives stays synchronous.
    private ourFns = new WeakMap<Function, { node: Node; scope: any }>();
    private depth = 0;
    // What is left of the step budget. Spent by every node evaluated and every element iterated.
    /** The source line of the statement being evaluated — reported when a script throws. */
    line = 0;
    private fuel: number;
    /** Cells read out of STORED tables so far in this run. Each read is one host call doing work proportional to the
     *  table, which the step budget never sees, so the total has its own bound (MAX_STORED_CELLS). */
    private storedCells = 0;
    // Collections being iterated right now (a count, since loops over one collection can nest). A mutator or a
    // property write on one of these is refused: that is what keeps every loop's trip count fixed at its start.
    private iterating = new Map<object, number>();

    /** Charge work a host call does that the evaluator cannot see (a pipe's stages), against the same budget. */
    spend(n: number): void { this.tick(n); }
    private tick(n = 1): void {
        if ((this.fuel -= n) < 0) throw new NotInDialect(`too much work to run without asking: over ${this.budget} steps`);
    }
    /** Refuse a value one step made too big to have been cheap (see MAX_COLLECTION / MAX_STRING). */
    private sized<T>(v: T): T {
        if (typeof v === "string" ? v.length > MAX_STRING
            : Array.isArray(v) ? v.length > MAX_COLLECTION
                : (v instanceof Set || v instanceof Map) && v.size > MAX_COLLECTION)
            throw new NotInDialect("a value too large to build without asking");
        return v;
    }
    private hold(o: unknown): void { if (o !== null && typeof o === "object") this.iterating.set(o, (this.iterating.get(o) ?? 0) + 1); }
    private release(o: unknown): void {
        if (o === null || typeof o !== "object") return;
        const n = (this.iterating.get(o) ?? 1) - 1;
        if (n > 0) this.iterating.set(o, n); else this.iterating.delete(o);
    }
    private notIterating(o: unknown, what: string): void {
        if (o !== null && typeof o === "object" && this.iterating.has(o))
            throw new Denied(`can't ${what} a collection while it is being iterated — build a new one instead`);
    }
    /** `Array(n)` / `new Array(n)` allocate n in one step, which the budget never sees. */
    private allocation(name: string, args: unknown[]): void {
        if (name === "Array" && args.length === 1 && typeof args[0] === "number" && args[0] > MAX_COLLECTION)
            throw new NotInDialect("an array too large to build without asking");
    }
    /** A pattern given as a STRING becomes a regex inside the host call (`match`, `matchAll`, `search`, `new RegExp`),
     *  so it gets the same check a regex literal does. */
    private patternArg(p: unknown): void {
        const risk = typeof p === "string" ? riskyRegex(p) : null;
        if (risk) throw new NotInDialect(`a regex that could backtrack without end (${risk})`);
    }
    /** The host calls that do work proportional to an ARGUMENT, checked before they run: afterwards is too late. */
    private preflight(obj: unknown, key: string, args: unknown[]): void {
        const big = () => { throw new NotInDialect("a value too large to build without asking"); };
        if (typeof obj === "string") {
            if (key === "repeat" && obj.length * Math.max(0, Number(args[0]) || 0) > MAX_STRING) big();
            if ((key === "padStart" || key === "padEnd") && Number(args[0]) > MAX_STRING) big();
            if (key === "match" || key === "matchAll" || key === "search") this.patternArg(args[0]);
        }
        if (Array.isArray(obj) && key === "join" && obj.length * String(args[0] ?? ",").length > MAX_STRING) big();
        // `Array.from({ length: n })` walks n indices inside the host, with or without a mapper.
        const src = args[0] as { length?: unknown } | null;
        if (key === "from" && src !== null && typeof src === "object" && !Array.isArray(src)
            && typeof src.length === "number" && src.length > MAX_COLLECTION) big();
        // A TABLE facade builds its result in one host call: `records()` makes an object per row with a key per
        // column, `select` a row per row with a cell per name. Rows × width is the work, checked here because the
        // budget never sees inside the call. (Page tables are capped at 200k rows, so `col` alone never trips it;
        // a wide `records()` over a big one does.)
        // A STORED table's reads cover every row (its `shape`), not the preview in `rows`, and each is a request the
        // step budget cannot see, so their total across the run is bounded too.
        if (isTable(obj)) {
            const t = obj as { rows: unknown[]; columns: unknown[]; shape: [number, number] };
            const stored = isStoredTable(obj);
            const all = stored ? t.shape[0] : t.rows.length;
            const width = key === "records" ? t.columns.length
                : key === "select" ? (Array.isArray(args[0]) ? args[0].length : 0)
                    : key === "head" ? t.columns.length : 1;
            const height = key === "head" ? Math.min(all, Math.max(0, Number(args[0] ?? 5)) || 0) : all;
            if (height * width > MAX_COLLECTION) big();
            if (stored && (key === "col" || key === "select" || key === "records" || (key === "head" && height > t.rows.length))) {
                this.storedCells += height * width;
                if (this.storedCells > MAX_STORED_CELLS) throw new NotInDialect(`reading over ${MAX_STORED_CELLS.toLocaleString("en-US")} cells of stored tables in one script, which is too much work to run without asking`);
            }
        }
    }
    // Containers the SCRIPT created (plain object/array literals, `new`, and the fresh arrays/objects our
    // allowlisted methods return — .map/.filter/.slice/Object.entries/JSON.parse/spread/…). ONLY these may be
    // mutated (assignment + push/sort/…). An array/object reached by READING a property off a page value is
    // NOT here, so page state can't be written. Page arrays are never RETURNED by an allowlisted method (those
    // all build new ones), so marking method results owned can't launder a live page container.
    private owned = new WeakSet<object>();
    private own<T>(v: T): T { if (v !== null && typeof v === "object" && isWritableTarget(v)) this.owned.add(v as object); return v; }
    /** Containers that are READ-ONLY with a message saying so: `ml.current.messages`, its rows, and everything inside
     *  them. A write there is not a refusal (the human gate would then run the script on the page, where there is no
     *  `ml.current`) but a TypeError the model reads. The write half will one day make these writes MEAN something
     *  (docs/spec/AGENT_COMPACTION.md), so the error is loud now rather than a copy that silently discards them. */
    private readOnly = new WeakSet<object>();
    /** The part of {@link readOnly} that is `ml.current.debug`, so a write there is told what it hit. */
    private shared = new WeakSet<object>();
    /** Each message row, to its index: the print boundary abridges a large one and names how to print it whole. */
    private rows = new Map<object, number>();
    constructor(private ml: Record<string, unknown> | null, private budget: number = STEP_BUDGET, private realm: ReadonlyRealm = "page") { this.fuel = budget; }

    /** Reaching a member the facade does not carry, by a READ or a destructuring. In the worker every one defers the
     *  survey to the page. On the page a read of an absent member has always been `undefined` (an existence guard
     *  reads that way), EXCEPT for the run's context: `ml.current` there would make a survey that needs both the page
     *  and the run evaluate to a plausible wrong answer (`title + undefined`) with no one asked. So that name refuses. */
    private absentRead(key: string): void {
        if (this.realm === "worker") this.absentMl(key);
        if (key === "current") throw new NotInDialect("ml.current is the run's context, which a survey on the page does not have");
    }
    /** A member the facade does not carry. In the worker that defers the survey to the page; on the page it is a
     *  refusal, as it always was. */
    private absentMl(key: string): never {
        if (this.realm === "worker") throw new NeedsPage(`ml.${key} is not available in the worker`);
        throw new NotInDialect(`method '${key}' not allowed`);
    }

    /** Build what `ml.current` reads from a snapshot. `messages` is the snapshot's own copy, protected; `run`, `meta`
     *  and `log` are copies the script OWNS, since they will never be writable and annotating a working copy of the
     *  metadata is how a compaction is planned. Flat records, so one level of ownership covers all of them. `debug`,
     *  where the host adds it, is a read-only copy. */
    adoptCurrent(snap: CurrentSnapshot): Record<string, unknown> {
        const protect = (v: unknown, depth: number, shared = false): void => {
            if (v === null || typeof v !== "object" || depth > 8 || this.readOnly.has(v)) return;
            this.readOnly.add(v);
            if (shared) this.shared.add(v);
            for (const x of Object.values(v)) protect(x, depth + 1, shared);
        };
        protect(snap.messages, 0);
        snap.messages.forEach((m, i) => this.rows.set(m as object, i));
        const log = this.own(snap.log.map((r) => this.own({ ...r })));
        // What the PERSON shared (`debug.userWatches`, a worker-hosted run's): a copy, read-only like `messages`, since
        // it is their words and a script annotating it would be the model rewriting what it was told to look at.
        const debug = snap.debug ? structuredClone({ userWatches: snap.debug.userWatches }) : undefined;
        if (debug) protect(debug, 0, true);
        return Object.assign(Object.create(null), {
            run: this.own({ ...snap.run }),
            messages: snap.messages,
            meta: this.own(snap.meta.map((r) => this.own({ ...r }))),
            log: Object.assign(log, { text: snap.log.text }),
            ...(debug ? { debug } : {}),
        });
    }

    /** The PRINT boundary for `ml.current.messages`. Holding the context costs nothing; printing it is what spends
     *  tokens, and a model sees 500 characters of a result, so `console.log(ml.current.messages)` would show half a
     *  system prompt and nothing else. A row whose text is larger than {@link ABRIDGE_OVER} prints as a summary that
     *  names the expression printing it whole; the VALUE is untouched. Keyed to size, not role, so a large tool result
     *  abridges like the system prompt. Walks plain arrays and objects only, so anything else (an element a survey
     *  returns) passes through by reference. */
    printable(v: unknown, swaps: PrintSwap[] = [], where = "the returned value", path = "$", depth = 0, budget = { n: 20_000 }): unknown {
        if (!this.rows.size || v === null || typeof v !== "object" || depth > 6 || --budget.n < 0) return v;
        const at = this.rows.get(v);
        if (at !== undefined) {
            // EVERY SUBSTITUTION IS RECORDED HERE, by diffing what is printed against the value. The note a reader
            // gets is generated from that diff (`describeSwaps`), so a new kind of substitution is described the
            // day it is added, with no sentence of its own to write or keep true.
            const view = abridgeRow(v as Record<string, unknown>, at);
            if (view !== v) swaps.push(diffSwap(path, v as Record<string, unknown>, view as Record<string, unknown>, where));
            return view;
        }
        if (Array.isArray(v)) return v.map((x, i) => this.printable(x, swaps, where, `${path}[${i}]`, depth + 1, budget));
        if (!isWritableTarget(v)) return v;
        const out: Record<string, unknown> = {};
        for (const [k, x] of Object.entries(v)) out[k] = this.printable(x, swaps, where, `${path}${jsonPathKey(k)}`, depth + 1, budget);
        return out;
    }

    private refuseWrite(obj: unknown): void {
        if (obj !== null && typeof obj === "object" && this.shared.has(obj))
            throw new TypeError("ml.current.debug is read-only: it is what the person shared with you. To work on it as data, copy what you need ([...ml.current.debug.userWatches]).");
        if (obj !== null && typeof obj === "object" && this.readOnly.has(obj))
            throw new TypeError("ml.current.messages is read-only: it is the context the next model call gets. To work on the messages as data, build what you need (msgs.map(m => ({ role: m.role, content: m.content }))).");
    }

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
        if (this.ml !== null && obj === this.ml && !Object.prototype.hasOwnProperty.call(this.ml, key)) this.absentRead(key);
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
        if (this.ml !== null && obj === this.ml && !Object.prototype.hasOwnProperty.call(this.ml, key)) this.absentRead(key);
        const v = (obj as any)?.[key];
        if (typeof v === "function") return METHOD_REF;
        // Uniformly with querySelectorAll (evalCall), a collection PROPERTY (.children/.rows/.cells/…)
        // reads as a real Array too — so `el.children.map(…)` works like `qsa('x').map(…)`.
        return isDomCollection(v) ? Array.from(v as ArrayLike<unknown>) : v;
    }

    // Bind a destructuring pattern (`const {a,b} = …`, `([a,b]) => …`) MEDIATED: every extracted property goes
    // through `this.prop` (a denied key like `constructor`/`__proto__` throws; a live method → the inert
    // METHOD_REF sentinel), so you can GET a property but not USE it to escape. Shared by VarDecl + arrow params.
    private bindPattern(scope: any, pattern: Node, val: unknown, isConst = false): void {
        const bind = (name: string, v: unknown): void => { scope[name] = v; if (isConst) this.markConst(scope, name); };
        if (pattern.type === "ArrayPattern") {
            const arr = Array.isArray(val) ? val
                : (val != null && typeof (val as any)[Symbol.iterator] === "function") ? this.sized(Array.from(val as Iterable<unknown>))
                    : (() => { throw new TypeError("cannot destructure a non-iterable value"); })();
            (pattern.elems as (string | null)[]).forEach((name, i) => { if (name) bind(name, this.prop(arr, String(i))); });
            if (pattern.rest) bind(pattern.rest as string, this.own(arr.slice((pattern.elems as unknown[]).length)));
        } else {   // ObjectPattern — each key read through the member-read guard (denied → throw, method → inert)
            for (const k of pattern.keys as string[]) bind(k, this.prop(val, k));
        }
    }


    /** Apply one binary operator. Shared by `a + b` and by `a += b`, so the compound form cannot quietly skip
     *  `sized` — which is the guard that stops a loop building an unbounded string one concatenation at a time. */
    private applyBinary(op: string, l: any, r: any): unknown {
        switch (op) {
            case "===": return l === r; case "!==": return l !== r;
            case "==": return l == r; case "!=": return l != r;
            case "<": return l < r; case ">": return l > r;
            case "<=": return l <= r; case ">=": return l >= r;
            case "+": return this.sized(l + r); case "-": return l - r;
            case "*": return l * r; case "/": return l / r; case "%": return l % r;
            // A NUMBER power is one O(1) operation. A BigInt one grows with the exponent inside a single host
            // operation no step budget sees, so it is refused outright (BigInt is not reachable in the dialect
            // today; this keeps it that way if it ever becomes so).
            case "**":
                if (typeof l === "bigint" || typeof r === "bigint") throw new NotInDialect("a BigInt power is not bounded");
                return l ** r;
        }
        throw new NotInDialect(`operator ${op}`);
    }

    /** Which scope FRAME actually holds this binding, or null when nothing does. Frames are a prototype chain of
     *  plain objects, one per block / loop iteration / arrow call; the one at the end — the host's `document`,
     *  `ml`, `Math`, `console` — is built with `Object.create(null)`, so a null prototype IS the test for "this
     *  name belongs to the environment, not to the script". */
    private frameOf(scope: any, name: string): any {
        for (let f = scope; f; f = Object.getPrototypeOf(f)) if (Object.prototype.hasOwnProperty.call(f, name)) return f;
        return null;
    }
    /** Record that a name was declared `const` in this frame. The set is an OWN, non-enumerable property: read
     *  through the prototype chain it would be the ENCLOSING frame's set, and marking there would make an inner
     *  `const x` freeze an outer `let x` that merely shares its name. */
    private markConst(frame: any, name: string): void {
        if (!Object.prototype.hasOwnProperty.call(frame, CONSTS))
            Object.defineProperty(frame, CONSTS, { value: new Set<string>(), enumerable: false, configurable: true });
        (frame[CONSTS] as Set<string>).add(name);
    }
    private isConst(frame: any, name: string): boolean {
        return Object.prototype.hasOwnProperty.call(frame, CONSTS) && (frame[CONSTS] as Set<string>).has(name);
    }
    /** The frame a BARE NAME may be written to. The whole extension is this function: a binding the script itself declared has no
     *  existence outside the evaluator, so writing to one cannot be observed by the page — which is the same
     *  argument that already lets a script build an array and push to it. Everything else is refused, and the
     *  three refusals are each a different way the page could otherwise be reached: the environment's own names
     *  (`document = …`), a name nothing declared (an implicit global, which in real JS creates one), and a
     *  `const`, where accepting it would make the dialect compute a value real JavaScript would not. */
    private writableFrame(scope: any, name: string): any {
        const frame = this.frameOf(scope, name);
        if (!frame) throw new Denied(`'${name}' is not declared in this script — assignment never creates a binding here`);
        if (Object.getPrototypeOf(frame) === null) throw new Denied(`'${name}' belongs to the page's environment and cannot be assigned to`);
        if (this.isConst(frame, name)) throw new NotInDialect(`'${name}' was declared const`);
        return frame;
    }
    *eval(node: Node, scope: any): Ev {
        this.tick();
        // The line of the statement currently executing, so a runtime throw can say WHERE. Only statements
        // carry one (parseStatement stamps them), and a nested statement overwrites it on the way in without
        // restoring on the way out — which is right: the innermost statement that was running IS the answer.
        if (node.ln !== undefined) this.line = node.ln;
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
                if (node.pattern) { this.bindPattern(scope, node.pattern, val, node.kind === "const"); return undefined; }
                scope[node.name] = val;
                if (node.kind === "const") this.markConst(scope, node.name);
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
                // HELD for the loop's whole life, released however it ends (return, throw, a closed generator):
                // the body may read the collection but not change it, so the iteration cannot outrun itself.
                this.hold(iterable);
                try {
                    for (const item of iterable as Iterable<unknown>) {
                        this.tick();
                        const child = Object.create(scope);   // fresh per-iteration binding (const semantics)
                        child[node.name] = item;
                        if (node.kind === "const") this.markConst(child, node.name);
                        const v = yield* this.eval(node.body, child);
                        if (v && typeof v === "object" && RETURN in (v as object)) return v;   // a `return` breaks out + propagates
                    }
                } finally { this.release(iterable); }
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
            case "Regex": {
                const risk = riskyRegex(node.pattern);
                if (risk) throw new NotInDialect(`a regex that could backtrack without end (${risk})`);
                try { return new RegExp(node.pattern, node.flags); } catch { throw new NotInDialect("invalid regex"); }
            }
            case "Ident": {
                if (node.name in scope) return scope[node.name];
                throw new Denied(`'${node.name}' is not available`);
            }
            case "Array": {
                const arr: unknown[] = [];
                for (const e of node.elements) {
                    if (e.type === "Spread") { for (const v of (yield* this.eval(e.arg, scope)) as Iterable<unknown>) { this.tick(); arr.push(v); } }
                    else arr.push(yield* this.eval(e, scope));
                }
                return this.own(this.sized(arr));
            }
            case "Object": {
                const o: Record<string, unknown> = {};
                for (const p of node.props) {
                    if ("spread" in p) {
                        // Copy the spread source's OWN ENUMERABLE properties, each through the member-read
                        // guard (denied props throw; a function value → the inert sentinel — so a spread can't
                        // launder a live method into a plain object). null/undefined/primitives spread nothing.
                        const src = yield* this.eval(p.spread, scope);
                        if (src != null) for (const k of Object.keys(Object(src))) { this.tick(); o[k] = this.prop(src, k); }
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
                const args = yield* this.evalArgs(node.args, scope);
                this.allocation(node.ctor, args);
                if (node.ctor === "RegExp") this.patternArg(args[0]);
                const inst = new ctor(...args);
                if (inst !== null && typeof inst === "object") this.owned.add(inst as object);
                return this.sized(inst);
            }
            case "Assign": {
                // A BARE NAME must resolve to a binding the SCRIPT declared (setIdent holds that line): the
                // environment's own names sit in a null-prototype frame and are refused there, an undeclared name
                // is refused rather than created, and a `const` is refused so the dialect never computes a value
                // real JavaScript would not.
                if (node.target.type === "Ident") {
                    // The TARGET is checked before anything is computed. `ml += 1` would otherwise coerce the
                    // facade on its way to a refusal and report "Cannot convert object to primitive value" — a
                    // runtime error about the wrong thing, where the answer is that the name is not the script's.
                    const frame = this.writableFrame(scope, node.target.name);
                    const rhs = yield* this.eval(node.value, scope);
                    const val = node.op === "=" ? rhs : this.applyBinary(node.op, frame[node.target.name], rhs);
                    frame[node.target.name] = val;
                    return val;
                }
                // MEMBER: the target must be a container the SCRIPT CREATED (`owned`) with a non-denied key
                // (guardKey). So a write can never touch a DOM node, a page array, a host object, `window`, the
                // scope, or the realm (__proto__/constructor/prototype) — assignment stays read-only w.r.t. the page.
                if (node.target.type !== "Member")
                    throw new NotInDialect("assignment is allowed only to a name you declared, or to a property of an object/array you built (o[k] = v)");
                const obj: any = yield* this.eval(node.target.obj, scope);
                const key = node.target.computed ? this.guardKey(yield* this.eval(node.target.prop, scope)) : this.guardKey(node.target.prop);
                this.refuseWrite(obj);
                // owned AND a plain object/array: a script-created Set/Map is owned (so its mutator METHODS
                // work) but is NOT a valid `o[k]=v` target — mutate it through .add/.set, not property writes.
                if (!this.owned.has(obj) || !isWritableTarget(obj))
                    throw new Denied("can only assign to an object or array you built — never a DOM node, a page object, or the environment");
                this.notIterating(obj, "assign into");
                const rhs = yield* this.eval(node.value, scope);
                const val = node.op === "=" ? rhs : this.applyBinary(node.op, this.prop(obj, key), rhs);
                obj[key] = val;
                return val;
            }
            // `n++` / `--o.count`: the same two mediated targets as an assignment, and the same refusals. Postfix
            // evaluates to the value BEFORE the change, which is why this is not parsed as `n += 1`.
            case "Update": {
                const delta = node.op === "+" ? 1 : -1;
                if (node.arg.type === "Ident") {
                    const frame = this.writableFrame(scope, node.arg.name);
                    const before = Number(frame[node.arg.name]);
                    frame[node.arg.name] = before + delta;
                    return node.prefix ? before + delta : before;
                }
                if (node.arg.type !== "Member") throw new NotInDialect("++ and -- apply to a name you declared or to a property of an object you built");
                const obj: any = yield* this.eval(node.arg.obj, scope);
                const key = node.arg.computed ? this.guardKey(yield* this.eval(node.arg.prop, scope)) : this.guardKey(node.arg.prop);
                this.refuseWrite(obj);
                if (!this.owned.has(obj) || !isWritableTarget(obj))
                    throw new Denied("can only assign to an object or array you built — never a DOM node, a page object, or the environment");
                this.notIterating(obj, "assign into");
                const before = Number(this.prop(obj, key));
                obj[key] = before + delta;
                return node.prefix ? before + delta : before;
            }
            case "Unary": {
                const a = yield* this.eval(node.arg, scope);
                if (node.op === "!") return !a;
                if (node.op === "-") return -(a as number);
                if (node.op === "+") return +(a as number);
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
                return this.applyBinary(node.op, l, r);
            }
            case "Cond": return (yield* this.eval(node.cond, scope)) ? yield* this.eval(node.cons, scope) : yield* this.eval(node.alt, scope);
            // The chain result is CONSUMED here (not another chain link) → unwrap a short-circuit to undefined.
            case "Member": { const v = yield* this.readMember(node, scope); return v === SHORT ? undefined : v; }
            case "Call": { const v = yield* this.evalCall(node, scope); return v === SHORT ? undefined : v; }
            case "Template": {
                // Concatenate quasi[0] expr[0] quasi[1] … — String() coercion, exactly like JS.
                let out = node.quasis[0];
                for (let k = 0; k < node.exprs.length; k++) out = this.sized(out + String(yield* this.eval(node.exprs[k], scope)) + node.quasis[k + 1]);
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
            if (a.type === "Spread") { for (const v of (yield* this.eval(a.arg, scope)) as Iterable<unknown>) { this.tick(); out.push(v); } }
            else out.push(yield* this.eval(a, scope));
        }
        return out;
    }

    // Invoke one of OUR arrows: bind the params in a child scope and evaluate its body. The depth
    // guard unwinds in `finally`, which runs even when the sync driver closes the generator early.
    private *callArrow(node: Node, scope: any, args: unknown[]): Ev {
        if (++this.depth > MAX_CALL_DEPTH) { this.depth--; throw new NotInDialect(`calls nested more than ${MAX_CALL_DEPTH} deep`); }
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
            // `ml.answer` is a curate-only facade with its OWN allowlist (ANSWER_METHODS), identified by identity
            // like `onMl` — so add/remove/clear/dump run on IT, and nothing else. Its methods deliberately never
            // join ALLOWED_METHODS (so `x.remove()`/`x.dump()` on a page object stay out of dialect).
            const onAnswer = this.ml !== null && obj != null && obj === (this.ml as Record<string, unknown>).answer;
            // THE CURATED FACADES FIRST, where absence is a REFUSAL rather than a typo. `ml` holds only the
            // read-only API, and `ml.answer` only its four curate methods — the real `window.ml` has
            // `setModel`/`chat`/`pythonExec`, so a missing name here means "the dialect withheld it", which
            // is precisely the thing a human may want to approve. Escalate, never explain it away.
            if (onMl) {
                if (!Object.prototype.hasOwnProperty.call(this.ml, key)) this.absentMl(key);
            } else if (onAnswer) {
                if (!ANSWER_METHODS.has(key)) throw new NotInDialect(`method '${key}' not allowed`);
            } else if (!methodAllowed(obj, key)) {
                // WHICH KIND OF "no" IS THIS? The distinction decides whether a human gets interrupted.
                //
                // A method that EXISTS on the receiver but is not allowed here (`input.select()`,
                // `el.click()`) is a real capability the dialect refuses — escalating is right, because
                // approving it is a decision a person can meaningfully make.
                //
                // A method that DOES NOT EXIST cannot be fixed by any approval: the approved run throws the
                // same TypeError a moment later, having spent a human interrupt on a typo. So it fails HERE,
                // as the runtime error it is — catchable in-dialect, reported to the model, no prompt.
                const missing = obj == null || typeof (obj as Record<string, unknown>)[key] !== "function";
                if (missing) throw new TypeError(obj == null
                    ? `Cannot read properties of ${String(obj)} (reading '${key}')`
                    : `${key} is not a function on this ${kindOf(obj) ?? "value"}`);
                // Say WHAT it was called on: with the gate scoped by receiver, "not allowed" without the kind
                // sends the reader looking for a missing name when the real answer is that the name is fine
                // and the receiver is wrong.
                throw new NotInDialect(`method '${key}' not allowed on ${kindOf(obj) ?? "this value"}`);
            }
            // An in-place MUTATOR (push/sort/…) may run ONLY on a container the script itself created — never an
            // array reached off a page value. So `pageState.items.push(x)` / `.sort()` can't mutate page data.
            // The answer facade is EXEMPT: curating your own answer is the point, and its methods touch only the
            // run's answer set (no nodes/media/realm reachable through them).
            if (MUTATING_METHODS.has(key)) this.refuseWrite(obj);
            if (MUTATING_METHODS.has(key) && !this.owned.has(obj) && !onAnswer)
                throw new Denied(`'${key}' can only mutate an array you created, not one reached from the page`);
            if (MUTATING_METHODS.has(key) && !onAnswer) this.notIterating(obj, "change");
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
            const args = yield* this.evalArgs(node.args, scope);
            this.preflight(obj, key, args);
            // A callback handed to a host method may run WHILE that method walks its receiver (`set.forEach`,
            // `arr.sort`) or its source (`Array.from(src, fn)`), so both are held for the call: the callback can read
            // them and cannot grow them. (Array methods fix their length when they start and would halt anyway; the
            // rule is simpler kept uniform than special-cased per method.)
            const held = args.some((a) => typeof a === "function" && this.ourFns.has(a as Function))
                ? [obj, key === "from" ? args[0] : undefined] : [];
            for (const h of held) this.hold(h);
            let out: unknown;
            try { out = fn.apply(obj, args); } finally { for (const h of held) this.release(h); }
            // Auto-await an ml call ONLY when it actually returns a promise (getModel/config/… round-trip),
            // so a forgotten `await` still reads the value. The SYNC ml reads (queryAll, range) return a plain
            // value — pass it straight through WITHOUT yielding, so they work inside a `.map`/`.filter` callback
            // (the sync driver can't honour a yield). Yielding those unconditionally was why `cs.map(s =>
            // ml.queryAll(s).length)` fell out of dialect.
            // `this.own`: a FRESH plain array/object our allowlisted methods return (.map/.filter/.slice/
            // Object.entries/JSON.parse/…) becomes mutable, so `arr.filter(…).push(x)` and the accumulator
            // idioms work. Page arrays are never RETURNED by an allowlisted method (they all build new ones),
            // so this can't launder a live page container — the mutator gate above still refuses page arrays.
            // A STORED table's reads are requests too (POINTER_VALUES slice 7), awaited the same way. Inside a `.map`
            // callback there is nowhere to await, so one there falls out of dialect rather than handing back a promise.
            if (onMl || isStoredTable(obj)) return this.own(this.sized((out != null && typeof (out as { then?: unknown }).then === "function") ? yield out : out));
            // Accommodate a common model mistake: querySelectorAll / getElementsBy* return a NodeList /
            // HTMLCollection, which have no .map/.filter, so `querySelectorAll('x').map(…)` throws (the
            // model forgets to spread). In this read-only dialect it's safe to just hand back a real
            // Array, so the survey runs instead of falling through to the manual gate.
            return this.own(this.sized(isDomCollection(out) ? Array.from(out as ArrayLike<unknown>) : out));
        }
        // Ident(args) — only whitelisted coercion/parse builtins.
        if (callee.type === "Ident" && CALLABLE_ROOTS.has(callee.name) && callee.name in scope) {
            const fn = scope[callee.name] as Function;
            const args = yield* this.evalArgs(node.args, scope);
            this.allocation(callee.name, args);
            return this.sized(fn(...args));
        }
        // (arrow)(args) / immediately-invoked arrow (or function expression). Driven by OUR driver
        // rather than through the sync wrapper, so an `await` inside an IIFE is honoured.
        const fn = yield* this.eval(callee, scope);
        const ours = typeof fn === "function" ? this.ourFns.get(fn as Function) : undefined;
        if (ours) return yield* this.callArrow(ours.node, ours.scope, yield* this.evalArgs(node.args, scope));
        throw new NotInDialect("call target not allowed");
    }
}

/** Run an evaluation to completion, AWAITING every yielded value. The top-level driver. A rejected
 *  awaited value (e.g. an `ml` read that throws) is thrown BACK INTO the generator via `gen.throw`, so a
 *  dialect `try { await … } catch` can catch it; uncaught, it propagates out (→ falls back to approval). */
export async function runAsync(gen: Ev): Promise<unknown> {
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
