// evaluator.ts — the read-only exec dialect's mediated evaluator (a generator over the AST) and the two drivers that
// run it: `runAsync` awaits each yield, `runSync` serves the callbacks a host method invokes synchronously.

import type { CurrentSnapshot } from "../agent/current-context";
import { isTable, isStoredTable } from "../table/table-brand";   // a table facade is recognised by BRAND, and the brand module is itself dependency-free
import { NotInDialect, Stopped, MAX_STRING, MAX_COLLECTION, Denied, riskyRegex, MAX_STORED_CELLS, STEP_BUDGET, NeedsPage, MAX_CALL_DEPTH, HOST_CHARS_PER_STEP, HOST_SCAN_CHARS_PER_STEP, FIXED_SLICE_FREE_CHARS, HOST_SCAN_ELEMENTS_PER_STEP, HOST_COPY_ELEMENTS_PER_STEP, EXPANDED_PARTS_PER_STEP, MAX_EXPANDED, MAX_EXPANDED_CHARS } from "./limits";
import { Node } from "./parser";
import { regexSteps } from "./regex-cost";
import { replaceSize, replaceWorstCase } from "./replace-size";
import { isSet, isMap, isWritableTarget, ReadonlyRealm, DENIED_PROPS, isDomCollection, SAFE_CONSTRUCTORS, ANSWER_METHODS, methodAllowed, kindOf, MUTATING_METHODS, CALLABLE_ROOTS, argWrites } from "./policy";
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

// WHAT A HOST CALL IS CHARGED, beyond its one step (limits.ts, HOST_CHARS_PER_STEP and the rest). A step is a fair unit
// only if no step does unbounded work, and a host method on a long string or a large array does work proportional to
// it, so a loop of them outran the budget by hours.

/** String methods that read a fixed slice, whatever the receiver's length: free up to FIXED_SLICE_FREE_CHARS. */
const FIXED_SLICE_STRING = new Set(["charAt", "charCodeAt", "codePointAt", "at", "slice", "substring", "substr", "startsWith", "endsWith"]);

/** String methods that run a regex when handed one (regex-cost.ts prices the search). */
const REGEX_STRING = new Set(["match", "matchAll", "search", "replace", "replaceAll", "split"]);

/** The String methods that also COMPILE a pattern handed as anything other than a RegExp. */
const COMPILES_PATTERN = new Set(["match", "matchAll", "search"]);

/** Refuse a replace before it builds a result over {@link MAX_STRING}. The count stops once past it, so the message
 *  names the limit, not a size the replace would not have stopped at. */
function tooMuchReplaced(): never {
    throw new NotInDialect(`a replace that would build over ${MAX_STRING.toLocaleString("en-US")} characters, more than a value may hold without asking`);
}

/** String methods that only scan, hash or compare (HOST_SCAN_CHARS_PER_STEP); every other one builds (HOST_CHARS_PER_STEP). */
const SCANNING_STRING = new Set(["includes", "indexOf", "lastIndexOf", "search", "localeCompare", "normalize", "trim", "trimStart", "trimEnd", "test"]);

/** Methods that STORE their arguments or compare them by identity, never expand them: their arguments are not walked
 *  (an accumulator handed to `push` would otherwise be walked whole on every call). `includes`/`indexOf`/`lastIndexOf`
 *  on an array compare by SameValue, which never coerces. On a string they coerce, so a string receiver walks its
 *  arguments regardless. A string argument of a KEYED one is hashed, which is charged (KEYED). */
const STORES = new Set(["push", "unshift", "add", "set", "has", "get", "delete", "includes", "indexOf", "lastIndexOf", "fill", "splice", "then", "isArray", "item"]);

/** The stores that hash a key: a long string key is charged its length. */
const KEYED = new Set(["add", "set", "has", "get", "delete"]);

/** Calls that read their arguments ONE level deep and coerce nothing: `Object.keys(o)` lists o's own keys,
 *  `Array.from(x)`/`new Set(x)` iterate x, `concat` spreads an array argument once, `Promise.all` awaits each element.
 *  None calls `toString` on what it finds, so a shared-part array inside costs nothing here: it is walked when something
 *  expands it. Their arguments are charged their top level (HOST_COPY_ELEMENTS_PER_STEP), not walked whole.
 *  `Object.fromEntries` is NOT one: it coerces every key. */
const ONE_LEVEL = new Set(["keys", "values", "entries", "assign", "from", "of", "concat", "all", "allSettled"]);

/** Constructors that store or iterate their arguments one level; the rest (`Date`, `String`, `Error`…) coerce them. */
const ONE_LEVEL_CTORS = new Set(["Set", "Map", "WeakSet", "WeakMap", "Array", "Object"]);

/** Array methods that scan the receiver's top level with no callback to tick per element. */
const ARRAY_SCANS = new Set(["indexOf", "lastIndexOf", "includes"]);

/** Array methods that move or overwrite the receiver in place. (`slice`/`concat` build a new array, charged by its size.) */
const ARRAY_MOVES = new Set(["reverse", "fill", "shift", "unshift", "splice"]);

/** Array methods that EXPAND the receiver: they read it whole, every nested array included (`join` and a default
 *  `sort` coerce each element, and coercing an array is `join` again). */
const ARRAY_EXPANDS = new Set(["join", "toString", "sort", "flat", "flatMap"]);

/** Host calls that COERCE what a script arrow they call returns: a comparator's result is ToNumber'd, a replacer's
 *  ToString'd, a stringify replacer's serialised. A callback's return is walked for these, since the walk of the
 *  arguments cannot see it. (`map`, `reduce`, `Array.from` store what a callback returns, which is walked where it is
 *  later expanded.) */
const COERCES_CALLBACK = new Set(["sort", "replace", "replaceAll", "stringify"]);

/** `ml` members that read their arguments as DATA and charge their own work, so the dialect neither walks nor charges
 *  them: `pipe` unwraps its source from own data properties and charges each stage per character, `jsonPath` reads
 *  members as data, charges every node, and refuses a getter or a cycle. Every other member (`range`, `dereference`,
 *  `schema`, `fetch`, `queryAll`, `a11y`, `capabilities`) may coerce or walk an argument, and the answer facade's
 *  `add` coerces with `String`. */
const DATA_MEMBERS = new Set(["pipe", "jsonPath"]);

/** A Map, Set or Array ITERATOR is materialised into an array when a host call returns one: a walk cannot see through an
 *  iterator without consuming it, and a Map's could carry a shared-part key into `Object.fromEntries`. */
const MATERIALISED = new Set(["[object Map Iterator]", "[object Set Iterator]", "[object Array Iterator]"]);

/** Marks, on the walk's stack, that the container below it is being left. */
const LEAVE = Symbol("leave");

/** A RegExp, of any realm, by its tag. A page object could claim the tag, but that only adds a check. */
const isRegExp = (v: unknown): v is RegExp => v !== null && typeof v === "object" && Object.prototype.toString.call(v) === "[object RegExp]";

/** The mediated evaluator: walks the parsed AST as a generator, gating every read, call, write and allocation. */
/** The `ml.current` fields `adoptCurrent` treats specially; every other field is copied whole. */
const SPECIAL_CURRENT_FIELDS = new Set(["run", "messages", "meta", "log", "debug"]);
/** How many objects one non-special `ml.current` field may copy into a survey before the rest is cut. */
const OWNED_COPY_NODES = 10_000;

export class Evaluator {
    // Arrows we created — the only functions we'll invoke directly. Keyed to their node+scope so a
    // DIRECT call (an IIFE) can be driven by the CALLER's driver (an await inside it still works),
    // while the bare wrapper a host method receives stays synchronous.
    private ourFns = new WeakMap<Function, { node: Node; scope: any }>();
    private depth = 0;
    /** The call depth of a host call in progress that coerces what its callbacks return (COERCES_CALLBACK), or -1. */
    coercingAt = -1;
    /** A `replace` in progress whose replacer is a script arrow: the call depth, and the characters it has built so far
     *  (the receiver's, plus what each call returned). Each return is counted before the host adds it to the result. */
    private replacing: { depth: number; chars: number } | null = null;
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
    /** `Array.from` of an iterable a pattern destructures, charged its size first: a string's characters, a Set's or a
     *  Map's members. Destructuring a 10-million-character string in a loop was one step an iteration. */
    private copied(val: unknown): unknown[] {
        const n = typeof val === "string" ? val.length / HOST_SCAN_CHARS_PER_STEP
            : (isSet(val) || isMap(val)) ? (val as Set<unknown>).size / HOST_COPY_ELEMENTS_PER_STEP
                : typeof (val as { length?: unknown }).length === "number" ? (val as { length: number }).length / HOST_COPY_ELEMENTS_PER_STEP : 0;
        this.tick(Math.floor(n));
        return Array.from(val as Iterable<unknown>);
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
    /** The text a host call coerces a pattern or a searched value to. A string, a String object or a primitive is its
     *  `String()`; anything else is refused, since the host would coerce it by running its `toString`, and an array
     *  or an object with a `toString` arrow handed `match` a backtracking pattern no check had read. */
    private regexText(v: unknown, what: string): string {
        if (v === null || typeof v !== "object" || kindOf(v) === "string") return String(v);
        throw new NotInDialect(`a regex ${what} that is not a string or a regex`);
    }
    /** The regex a host call is about to run and the text it searches, or null when it runs none: a String method
     *  handed a RegExp (or, for `match`/`matchAll`/`search`, a pattern it compiles), or a RegExp's `test`/`exec`. */
    private regexSearch(obj: unknown, key: string, args: unknown[], str: string | null): [string, string, string] | null {
        if (str !== null && REGEX_STRING.has(key)) {
            const p = args[0];
            if (isRegExp(p)) return [String(p.source), String(p.flags), str];
            if (!COMPILES_PATTERN.has(key)) return null;
            return [p === undefined ? "(?:)" : this.regexText(p, "pattern"), key === "matchAll" ? "g" : "", str];
        }
        if (isRegExp(obj) && (key === "test" || key === "exec")) return [String(obj.source), String(obj.flags), this.regexText(args[0], "search over a value")];
        return null;
    }
    /** Charge a regex search for the backtracking it can do on THIS input (regex-cost.ts), before it runs: one host
     *  call, unbounded by anything else (`/a+b/` on a long run of "a" is quadratic). Over what is left of the budget,
     *  the survey goes to the person. */
    private regexCharge(search: [string, string, string]): void {
        const [source, flags, input] = search;
        const steps = regexSteps(source, flags, input, (n) => this.tick(n), HOST_SCAN_CHARS_PER_STEP);
        if (steps > this.fuel) throw new NotInDialect(`a regex search that could backtrack for too long on this input (/${source.length > 40 ? source.slice(0, 40) + "…" : source}/ over ${input.length.toLocaleString("en-US")} characters)`);
        this.tick(steps);
    }
    /** Charge a `replace` or `replaceAll` for the text it BUILDS, before it builds it. The host sizes and allocates its
     *  result in one call, so the check after it (`sized`) came only once a string of up to V8's limit was in memory,
     *  and a result under {@link MAX_STRING} was charged as if it were the receiver: 300 replaces of 8.8 million
     *  characters each ran without asking. The worst case is tried first and, when it is over the limit, the replace is
     *  measured match by match (replace-size.ts: a second search, charged as the first was). A replacer arrow is
     *  counted as it returns (`replacing`). */
    private replaceCharge(str: string, key: string, args: unknown[], search: [string, string, string] | null): void {
        const [p, r] = args;
        // `replaceAll` with a RegExp that is not global throws before it does anything: let it say so itself.
        if (key === "replaceAll" && isRegExp(p) && !String(p.flags).includes("g")) return;
        if (typeof r === "function") {
            if (!this.ourFns.has(r)) throw new NotInDialect("a replacer that is not an arrow written in the script");
            return;
        }
        const text = this.replacementText(r);
        const global = key === "replaceAll" || (isRegExp(p) && String(p.flags).includes("g"));
        let size = replaceWorstCase(str.length, text, global);
        if (size > MAX_STRING) {
            const pattern = isRegExp(p) ? p as RegExp : this.regexText(p, "pattern");
            if (search) this.regexCharge(search); else this.scans(str);
            const measured = replaceSize(str, pattern, text, global, MAX_STRING);
            this.tick(Math.floor(measured.matches / HOST_COPY_ELEMENTS_PER_STEP));
            size = measured.size;
        }
        if (size > MAX_STRING) tooMuchReplaced();
        this.tick(Math.floor(Math.max(0, size) / HOST_CHARS_PER_STEP));
    }
    /** The text a host call coerces a replacement to. A string, a String object or a primitive is its `String()`; an
     *  object is refused, since the host would coerce it by running its `toString`, and the text it returns (a `$'`) is
     *  what decides the size. */
    private replacementText(v: unknown): string {
        if (v === null || typeof v !== "object" || kindOf(v) === "string") return String(v);
        throw new NotInDialect("a replacement that is not a string or a function");
    }
    /** What a replacer arrow returned for one match, counted before the host adds it to the result (`replacing`): the
     *  result so far grows by the return and loses the match it replaces. */
    private replaced(rep: { chars: number }, ret: unknown, match: unknown): void {
        if (ret !== null && typeof ret === "object" && kindOf(ret) !== "string")
            throw new NotInDialect("a replacer that returns an object, which the host would turn into text by running its toString");
        const len = String(ret).length;
        rep.chars += len - String(match).length;
        if (rep.chars > MAX_STRING) tooMuchReplaced();
        this.tick(Math.floor(len / HOST_CHARS_PER_STEP));
    }
    /** How many parts `v` expands to when walked whole, counting a part as often as a walk would visit it (so an array
     *  that shares its parts counts at its expanded size), and how many characters its strings hold. Throws past
     *  {@link MAX_EXPANDED}: that walk is what `JSON.stringify`, `flat` and every coercion of an array would do, and an
     *  array built by `d = [d, d]` forty times expands to 2^40. A cycle is not followed (stringify throws on it, and
     *  `join` prints it empty). Only arrays and plain objects are entered: anything else is one part. Iterative, so a
     *  deep value cannot overflow the stack here. */
    private expanded(v: unknown): { parts: number; chars: number } {
        let parts = 0, chars = 0;
        // Stop as soon as the walk alone would spend what is left of the budget: the refusal is the same either way.
        const cap = Math.min(MAX_EXPANDED, Math.max(0, this.fuel) * EXPANDED_PARTS_PER_STEP);
        const onPath = new Set<object>();
        // A value, or LEAVE followed by the container being left (popped in that order).
        const stack: unknown[] = [v];
        while (stack.length) {
            const x = stack.pop();
            if (x === LEAVE) { onPath.delete(stack.pop() as object); continue; }
            if (typeof x === "string") { chars += x.length; continue; }
            if (x === null || typeof x !== "object" || isTable(x)) continue;
            const coll = !(Array.isArray(x) || isWritableTarget(x)) && (isSet(x) || isMap(x));
            if (!(Array.isArray(x) || isWritableTarget(x)) && !coll) {
                // A String object (a pointer's text) is its characters; anything else is one part, read no further.
                if (Object.prototype.toString.call(x) === "[object String]") chars += String(x).length;
                continue;
            }
            if (onPath.has(x)) continue;
            // A toJSON the SCRIPT wrote (an arrow on an object or an array it built) is called by JSON.stringify, inside
            // the dialect or in the caller's serialisation of the result, and what it returns is never walked.
            if (!coll && typeof Object.getOwnPropertyDescriptor(x, "toJSON")?.value === "function")
                throw new NotInDialect("a value with its own toJSON, which a serialisation would call: it needs approval");
            onPath.add(x);
            stack.push(x, LEAVE);
            // An object's members are read as DATA: a getter is not run by the walk (on the page it is the page's code).
            // A Map's keys and values, and a Set's members, are walked too: `Object.fromEntries(map)` coerces each key.
            const kids: unknown[] = Array.isArray(x) ? x
                : coll ? (isMap(x) ? [...(x as Map<unknown, unknown>)].flat() : [...(x as Set<unknown>)])
                    : Object.keys(x).map((k) => Object.getOwnPropertyDescriptor(x, k)?.value);
            parts += kids.length;
            if (parts > cap) throw new NotInDialect(cap < MAX_EXPANDED
                ? `too much work to run without asking: walking a value that expands to over ${cap.toLocaleString("en-US")} parts`
                : `a value that expands to over ${MAX_EXPANDED.toLocaleString("en-US")} parts (an array holding the same array twice counts it twice), too much to walk without asking`);
            for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]);
            if (chars > MAX_EXPANDED_CHARS) throw new NotInDialect(`a value whose strings expand to over ${MAX_EXPANDED_CHARS.toLocaleString("en-US")} characters, too much to walk without asking`);
        }
        if (chars > MAX_EXPANDED_CHARS) throw new NotInDialect(`a value whose strings expand to over ${MAX_EXPANDED_CHARS.toLocaleString("en-US")} characters, too much to walk without asking`);
        return { parts, chars };
    }
    /** Charge the walk of `v` (see {@link expanded}) to the budget: what a host call or a coercion is about to do to it. */
    private expands(v: unknown): void {
        if (typeof v === "string") { this.tick(Math.floor(v.length / HOST_CHARS_PER_STEP)); return; }
        if (v === null || typeof v !== "object") return;
        const { parts, chars } = this.expanded(v);
        this.tick(Math.floor(parts / EXPANDED_PARTS_PER_STEP) + Math.floor(chars / HOST_CHARS_PER_STEP));
    }
    /** Charge a ONE-LEVEL read of `v` (see ONE_LEVEL): its top-level length, and the strings at that level, which a
     *  Set hashes. Nothing below the top is read, so nothing below it is walked. */
    private shallow(v: unknown): void {
        if (typeof v === "string") { this.tick(Math.floor(v.length / HOST_SCAN_CHARS_PER_STEP)); return; }
        if (v === null || typeof v !== "object") return;
        let n = 0, chars = 0;
        if (Array.isArray(v)) { n = v.length; for (const x of v) if (typeof x === "string") chars += x.length; }
        else if (isSet(v) || isMap(v)) n = (v as Set<unknown>).size;
        else if (isWritableTarget(v)) n = Object.keys(v).length;
        this.tick(Math.floor(n / HOST_COPY_ELEMENTS_PER_STEP) + Math.floor(chars / HOST_SCAN_CHARS_PER_STEP));
    }
    /** A string that is about to be hashed, compared, parsed as a number or flattened: charged its length. */
    private scans(...vs: unknown[]): void {
        let n = 0;
        for (const v of vs) if (typeof v === "string") n += v.length;
        if (n >= HOST_SCAN_CHARS_PER_STEP) this.tick(Math.floor(n / HOST_SCAN_CHARS_PER_STEP));
    }
    /** Refuse a value that expands past {@link MAX_EXPANDED}, without charging: for what the caller serialises after the
     *  survey has finished (the returned value). */
    checkExpands(v: unknown): void { if (v !== null && typeof v === "object") this.expanded(v); }
    /** A COERCION of an operand (`+`, `<`, a template, a computed key): an object becomes a string through its
     *  `toString`, which for an array is `join`, so it is walked first. Two strings compared cost their shorter one. */
    private coerces(...vs: unknown[]): void {
        for (const v of vs) if (v !== null && typeof v === "object") this.expands(v);
    }

    /** The host calls that do work proportional to an ARGUMENT, checked before they run: afterwards is too late. */
    private preflight(obj: unknown, key: string, args: unknown[], member: "ml" | "answer" | null = null): void {
        const big = () => { throw new NotInDialect("a value too large to build without asking"); };
        // A String OBJECT is a string here: `new String(…)` is a safe constructor and `ml.dereference` returns one
        // (DerefText), and while this read only `typeof obj === "string"` a pointer's text took a backtracking pattern.
        const str = typeof obj === "string" ? obj : kindOf(obj) === "string" ? String(obj) : null;
        if (str !== null) {
            if (key === "repeat" && str.length * Math.max(0, Number(args[0]) || 0) > MAX_STRING) big();
            if ((key === "padStart" || key === "padEnd") && Number(args[0]) > MAX_STRING) big();
            if (COMPILES_PATTERN.has(key) && args[0] !== undefined && !isRegExp(args[0])) this.patternArg(this.regexText(args[0], "pattern"));
            if (FIXED_SLICE_STRING.has(key)) { if (str.length > FIXED_SLICE_FREE_CHARS) this.scans(str); }
            else if (SCANNING_STRING.has(key)) this.scans(str);
            else this.tick(Math.floor(str.length / HOST_CHARS_PER_STEP));
        }
        // A RegExp the script did not build (a page value's property, on the page realm) never passed the literal or
        // `new RegExp` check, so every one a call is handed, as receiver or argument, is checked here.
        for (const v of [obj, ...args]) if (isRegExp(v)) this.patternArg(String(v.source));
        if (Array.isArray(obj) && key === "join" && obj.length * String(args[0] ?? ",").length > MAX_STRING) big();
        if (Array.isArray(obj) && ARRAY_EXPANDS.has(key)) this.expands(obj);
        else if (Array.isArray(obj) && ARRAY_SCANS.has(key)) this.tick(Math.floor(obj.length / HOST_SCAN_ELEMENTS_PER_STEP));
        else if (Array.isArray(obj) && ARRAY_MOVES.has(key)) this.tick(Math.floor(obj.length / HOST_COPY_ELEMENTS_PER_STEP));
        // The ARGUMENTS: a host method may coerce, copy or walk any of them, so each is charged its size and an array
        // sharing its parts is refused before anything expands it. `Object.assign`'s target is written to, not read.
        // An `ml` member's arguments are walked whatever its name, except the two that read them as data (DATA_MEMBERS);
        // the answer facade's `add` coerces. A one-level reader is charged its arguments' top level (ONE_LEVEL). A
        // keyed store hashes a string key. A string PRINTED is kept or counted, never scanned (output-clip.ts), so the
        // console is charged only what it stringifies.
        const printing = kindOf(obj) === "console";
        if (member === "ml" && DATA_MEMBERS.has(key)) { /* reads as data, charges its own work */ }
        else if (member !== null) args.forEach((a) => this.expands(a));
        else if (str === null && STORES.has(key)) { if (KEYED.has(key)) this.scans(...args); }
        else if (ONE_LEVEL.has(key) && str === null) args.forEach((a, i) => { if (!(key === "assign" && i === 0)) this.shallow(a); });
        else args.forEach((a) => { if (!(printing && typeof a === "string")) this.expands(a); });
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
        // Last, once the arguments are walked: the search's own backtracking, which nothing above bounds.
        const search = this.regexSearch(obj, key, args, str);
        if (search) this.regexCharge(search);
        if (str !== null && (key === "replace" || key === "replaceAll")) this.replaceCharge(str, key, args, search);
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

    /** STRICT FACADES: the policy realm's `c` and every object and array inside it. Reading a field one does not have
     *  is a REFUSAL, never `undefined`, so a typo'd `deny` is a broken policy the person sees rather than a rule that
     *  silently never fires (docs/spec/POLICIES.md, "The policy realm"). An array is strict for its non-index keys
     *  only: an index past the end reads `undefined`, as `c.argv[1] === "status"` on a one-word argv needs. Decided by
     *  the member-read path itself, so an alias (`const x = c; x.argv0`) is refused the same way. */
    private strict = new WeakSet<object>();
    /** Mark a policy facade object strict (see {@link strict}); only `evalPolicy` builds them. */
    markStrict<T extends object>(o: T): T { this.strict.add(o); return o; }
    /** The first fact this evaluation read that is `null`, by its field name. A `null` fact is UNKNOWN, and an ALLOW
     *  whose condition read one never fires (docs/spec/POLICIES.md, the tree's ruling of 2026-10-21); `evalPolicy` reads
     *  this after the call, and sets it before the call for a list holding a `null` (see `buildFacade`). */
    nullRead: string | undefined;
    /** Strict facades, to whether one holds a `null` field anywhere beneath it (they are frozen, so it is fixed). */
    private nullBeneath = new WeakMap<object, boolean>();
    /** Note a `null` field a builtin or a constructor takes out of the call wholesale (`JSON.stringify(c)`,
     *  `Object.values(c.program)`, `new Map(Object.entries(c))`), which reads every field without a member read. The
     *  walk goes through what the script built (`JSON.stringify([c])`) to the facades inside it. */
    private noteNulls(v: unknown): void {
        if (this.realm !== "policy" || this.nullRead !== undefined || v === null || typeof v !== "object") return;
        if (this.holdsNull(v, new Set())) this.nullRead = "a fact that is null";
    }
    /** Whether a strict facade at or beneath `v` holds a `null` field. */
    private holdsNull(v: object, seen: Set<object>): boolean {
        if (seen.has(v)) return false;
        seen.add(v);
        const strict = this.strict.has(v);
        if (strict) { const got = this.nullBeneath.get(v); if (got !== undefined) return got; }
        const out = Object.values(v).some((x) => x === null ? strict : typeof x === "object" && this.holdsNull(x, seen));
        if (strict) this.nullBeneath.set(v, out);
        return out;
    }
    /** Refuse a read of a field a strict facade does not have; note a read of one that is `null`. */
    private strictRead(obj: unknown, key: string): void {
        // A policy reading off null or undefined is a TypeError, as in JavaScript. A survey reads `undefined` there, a
        // forgiveness that in a policy turns `c.argv[9].length > 0` into a quiet `false`, and a `deny` into nothing.
        if (obj == null && this.realm === "policy") throw new TypeError(`Cannot read properties of ${String(obj)} (reading '${key}')`);
        // A string's typo (`c.url.lenght`) is refused in a policy too: a string has its length, its indices and its
        // methods (read as values only to be called), and nothing else.
        if (this.realm === "policy" && typeof obj === "string" && !(key in Object(obj))) throw new NotInDialect(`a string has no field '${key}'`);
        if (obj === null || typeof obj !== "object" || !this.strict.has(obj)) return;
        const own = Object.prototype.hasOwnProperty.call(obj, key);
        if (!own && !(Array.isArray(obj) && /^(0|[1-9]\d*)$/.test(key))) throw new NotInDialect(`the call has no field '${key}'`);
        if (own && (obj as Record<string, unknown>)[key] === null && this.nullRead === undefined) this.nullRead = Array.isArray(obj) ? "a fact that is null" : key;
    }

    /** Members this run does not have, to why (ml-member-tools.ts): the host leaves them off the facade, and reaching
     *  one is a runtime error saying so, since no approval would give the run a tool it was not built with. */
    hidden: ReadonlyMap<string, string> = new Map();
    /** Throw the run's reason when `key` is a member it does not have. */
    private hiddenMember(key: string): void {
        const why = this.hidden.get(key);
        if (why) throw new Error(why);
    }

    /** Reaching a member the facade does not carry, by a READ or a destructuring. In the worker every one defers the
     *  survey to the page. On the page a read of an absent member has always been `undefined` (an existence guard
     *  reads that way), EXCEPT for the run's context: `ml.current` there would make a survey that needs both the page
     *  and the run evaluate to a plausible wrong answer (`title + undefined`) with no one asked. So that name refuses. */
    private absentRead(key: string): void {
        this.hiddenMember(key);
        if (this.realm === "worker") this.absentMl(key);
        if (key === "current") throw new NotInDialect("ml.current is the run's context, which a survey on the page does not have");
    }
    /** A member the facade does not carry. In the worker that defers the survey to the page; on the page it is a
     *  refusal, as it always was. */
    private absentMl(key: string): never {
        this.hiddenMember(key);
        if (this.realm === "worker") throw new NeedsPage(`ml.${key} is not available in the worker`);
        throw new NotInDialect(`method '${key}' not allowed`);
    }

    /** Build what `ml.current` reads from a snapshot. `messages` is the snapshot's own copy, protected; `run`, `meta`
     *  and `log` are copies the script OWNS, since they will never be writable and annotating a working copy of the
     *  metadata is how a compaction is planned. Flat records, so one level of ownership covers all of them. `debug`,
     *  where the host adds it, is a read-only copy. Any OTHER field (`env`, and whatever comes next) is copied whole
     *  for the script to own, so nothing new is silently absent from a survey (`env` was, while this listed fields). */
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
            // Every other field (`env`, and whatever is added next) is plain data: a deep copy the script owns, walked
            // whole, so a new field reaches a survey without a line here.
            ...Object.fromEntries(Object.entries(snap).filter(([k, v]) => !SPECIAL_CURRENT_FIELDS.has(k) && v !== undefined).map(([k, v]) => [k, this.ownedCopy(v)])),
        });
    }

    /** A copy of `v` the script owns, made breadth first so a deep field cannot overflow the stack (`structuredClone`
     *  recurses). Plain objects and arrays are copied and owned; anything else is cloned whole as a leaf. Past
     *  {@link OWNED_COPY_NODES} objects the rest is cut to a note rather than handed over by reference. */
    private ownedCopy(v: unknown): unknown {
        const fresh = (x: object): object => Array.isArray(x) ? new Array(x.length) : {};
        const plain = (x: object): boolean => Array.isArray(x) || [Object.prototype, null].includes(Object.getPrototypeOf(x));
        if (v === null || typeof v !== "object") return v;
        if (!plain(v)) return structuredClone(v);
        const seen = new Map<object, object>([[v, this.own(fresh(v))]]);
        const queue: object[] = [v];
        for (let n = 0; n < queue.length; n++) {
            const from = queue[n], to = seen.get(from) as Record<string, unknown>;
            for (const [k, x] of Object.entries(from)) {
                if (x === null || typeof x !== "object") to[k] = x;
                else if (seen.has(x)) to[k] = seen.get(x);
                else if (!plain(x)) to[k] = structuredClone(x);
                else if (seen.size >= OWNED_COPY_NODES) to[k] = `[cut: over ${OWNED_COPY_NODES} objects]`;
                else { seen.set(x, this.own(fresh(x))); to[k] = seen.get(x); queue.push(x); }
            }
        }
        return seen.get(v);
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
        this.coerces(key);   // a computed key is coerced with `String`, which walks an array whole
        this.scans(key);     // and a string key is hashed
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
        this.strictRead(obj, key);
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
        this.strictRead(obj, key);
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
                : (val != null && typeof (val as any)[Symbol.iterator] === "function") ? this.sized(this.copied(val))
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
        // `===` and `!==` never coerce, nor does `==` between two objects or against null; every other operator may call
        // an object operand's `toString`.
        const loose = op === "==" || op === "!=";
        // In a POLICY a coercing comparison is where a quiet mistake becomes a grant (`"0" == 0`), so it is refused there.
        if (loose && this.realm === "policy") throw new NotInDialect(`${op} coerces; compare with ${op}=`);
        // So does an ordering between a string and a number (`c.n < "10"`): refused there too.
        if (this.realm === "policy" && (op === "<" || op === ">" || op === "<=" || op === ">=") && typeof l !== typeof r)
            throw new NotInDialect(`${op} between a ${typeof l} and a ${typeof r} coerces`);
        if (op !== "===" && op !== "!==" && !(loose && (l == null || r == null || (typeof l === "object") === (typeof r === "object")))) this.coerces(l, r);
        // A string operand of anything but `+` (a rope stays O(1) there) is flattened and compared or parsed: charged its
        // length. `===` between strings of different lengths answers from the lengths alone.
        if (op === "===" || op === "!==") { if (typeof l === "string" && typeof r === "string" && l.length === r.length) this.scans(l, r); }
        else if (op !== "+") this.scans(l, r);
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
                const fn = function (...args: unknown[]) {
                    // Called by a host method that COERCES what it returns (COERCES_CALLBACK): walked before the host gets it.
                    const coerced = self.coercingAt === self.depth;
                    const ret = runSync(self.callArrow(node, scope, args));
                    if (coerced) self.expands(ret);
                    const rep = self.replacing;
                    if (rep !== null && rep.depth === self.depth) self.replaced(rep, ret, args[0]);
                    return ret;
                };
                this.ourFns.set(fn, { node, scope });
                return fn;
            }
            case "New": {
                const ctor = SAFE_CONSTRUCTORS[node.ctor];
                // A policy is a function of the call alone: the clock is not one of its facts.
                if (node.ctor === "Date" && this.realm === "policy") throw new NotInDialect("new Date() reads the clock, which is not a fact of the call");
                if (!ctor) throw new Denied(`new ${node.ctor}() is not allowed — only pure builtins (Set, Map, Array, Date, RegExp, …)`);
                // A script-CREATED instance is owned, so its own mutators (Set.add / Map.set/…) pass the
                // MUTATING_METHODS gate. Mark it directly, not via own(): a Set/Map's prototype isn't
                // Object.prototype, so own()'s isWritableTarget check would skip it. (Assignment `o[k]=v`
                // stays restricted to plain objects/arrays — the Assign case re-checks isWritableTarget.)
                const args = yield* this.evalArgs(node.args, scope);
                for (const a of args) this.noteNulls(a);
                this.allocation(node.ctor, args);
                if (node.ctor === "RegExp") this.patternArg(isRegExp(args[0]) ? String(args[0].source) : args[0]);
                for (const a of args) if (ONE_LEVEL_CTORS.has(node.ctor)) this.shallow(a); else this.expands(a);
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
                if (node.op === "-" || node.op === "+") { this.coerces(a); this.scans(a); }
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
                for (let k = 0; k < node.exprs.length; k++) {
                    const v = yield* this.eval(node.exprs[k], scope);
                    this.coerces(v);
                    out = this.sized(out + String(v) + node.quasis[k + 1]);
                }
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

    /** Call one of the script's OWN functions with host-supplied arguments (a policy is called with `c`). Anything
     *  else is not a policy. */
    *callOwn(fn: unknown, args: unknown[]): Ev {
        const ours = typeof fn === "function" ? this.ourFns.get(fn as Function) : undefined;
        if (!ours) throw new NotInDialect("a policy is a function of the call: (c) => …");
        return yield* this.callArrow(ours.node, ours.scope, args);
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
            // A STRICT facade object (the policy realm's `c.effects`) carries its own callables, put there by
            // `evalPolicy` alone, so an own function is the whole check, and a name it lacks is a refusal like any
            // other field it lacks. A strict ARRAY's methods are the array kind's, gated below as on any array.
            const onStrict = obj !== null && typeof obj === "object" && this.strict.has(obj) && !Array.isArray(obj);
            if (onStrict) this.strictRead(obj, key);
            if (onMl) {
                if (!Object.prototype.hasOwnProperty.call(this.ml, key)) this.absentMl(key);
            } else if (onStrict) {
                if (typeof obj[key] !== "function") throw new TypeError(`${key} is not a function on the call`);
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
            // An argument the call WRITES (ARG_WRITERS: `Object.assign`'s target) meets the same rule as `o[k] = v`: a
            // plain object or array the script built, not one being iterated. Without it, a survey assigned into the
            // page (`Object.assign(document.body, { innerHTML })`) and into the host's own builtins (`Math`, `JSON`,
            // `Array`), which outlive the survey and every guard here reads.
            for (const i of argWrites(obj, key)) {
                const target = args[i];
                this.refuseWrite(target);
                if (target === null || typeof target !== "object" || !this.owned.has(target) || !isWritableTarget(target))
                    throw new Denied(`${key} can only write into an object or array you built — never a DOM node, a page object, or a builtin`);
                this.notIterating(target, "write into");
            }
            this.preflight(obj, key, args, onMl ? "ml" : onAnswer ? "answer" : null);
            // A builtin reads its arguments whole (`JSON.stringify(c)`, `Object.values(c.program)`): a `null` field it
            // takes out of the call is a read of it. `Object.keys` reads names, never values.
            if (!(obj === Object && (key === "keys" || key === "getOwnPropertyNames"))) for (const a of args) this.noteNulls(a);
            // A callback handed to a host method may run WHILE that method walks its receiver (`set.forEach`,
            // `arr.sort`) or its source (`Array.from(src, fn)`), so both are held for the call: the callback can read
            // them and cannot grow them. (Array methods fix their length when they start and would halt anyway; the
            // rule is simpler kept uniform than special-cased per method.)
            const held = args.some((a) => typeof a === "function" && this.ourFns.has(a as Function))
                ? [obj, key === "from" ? args[0] : undefined] : [];
            for (const h of held) this.hold(h);
            let out: unknown;
            const wasCoercing = this.coercingAt;
            if (COERCES_CALLBACK.has(key)) this.coercingAt = this.depth;
            const wasReplacing = this.replacing;
            if ((key === "replace" || key === "replaceAll") && typeof args[1] === "function" && (typeof obj === "string" || kindOf(obj) === "string"))
                this.replacing = { depth: this.depth, chars: String(obj).length };
            try { out = fn.apply(obj, args); } finally { for (const h of held) this.release(h); this.coercingAt = wasCoercing; this.replacing = wasReplacing; }
            if (out !== null && typeof out === "object" && MATERIALISED.has(Object.prototype.toString.call(out))) out = Array.from(out as Iterable<unknown>);
            // A NEW array is charged its length: what `slice`, `map` or `split` built is a copy proportional to it.
            if (Array.isArray(out) && out !== obj) this.tick(Math.floor(out.length / HOST_COPY_ELEMENTS_PER_STEP));
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
            for (const a of args) this.expands(a);   // each coerces its argument (`String(d)` is `join` for an array)
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
export async function runAsync(gen: Ev, stop?: AbortSignal): Promise<unknown> {
    let sent: unknown, err: unknown, hasErr = false;
    for (;;) {
        // STOPPED: the generator is never resumed again, not thrown into. A throw into it would run the script's own
        // `finally` (the Try case runs a finalizer after a guard error), and a finalizer can await and print, so a
        // stopped survey would go on. Abandoned, nothing of it runs; the host call it was awaiting is left to settle.
        if (stop?.aborted) throw new Stopped("the run was stopped while this survey ran");
        const r = hasErr ? gen.throw(err) : gen.next(sent);
        hasErr = false;
        if (r.done) return r.value;
        try { sent = await (stop ? untilStopped(r.value, stop) : r.value); }
        catch (e) { err = e; hasErr = true; }
    }
}

/** `v` awaited, or a rejection the moment `stop` aborts, so a stop lands during a slow host call too. */
function untilStopped(v: unknown, stop: AbortSignal): Promise<unknown> {
    return new Promise((resolve, reject) => {
        const onStop = (): void => reject(new Stopped("the run was stopped while this survey ran"));
        stop.addEventListener("abort", onStop, { once: true });
        Promise.resolve(v).then(resolve, reject).finally(() => stop.removeEventListener("abort", onStop));
    });
}

/** Run one SYNCHRONOUSLY — for an arrow a host method invokes (`arr.map(fn)` calls fn synchronously,
 *  so there is nowhere to await). A yield means the body tried to: close the generator (its `finally`
 *  unwinds the depth guard) and fall out of dialect, so the survey drops to the approval path. */
export function runSync(gen: Ev): unknown {
    const r = gen.next();
    if (!r.done) { gen.return(undefined); throw new NotInDialect("await is not supported inside a callback"); }
    return r.value;
}
