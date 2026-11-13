// policy.ts — what a read-only survey may read, call, build and write: the denied properties, the per-kind method
// allowlist, the callable roots and safe constructors, and the `ml` facade the dialect sees.

import { isTable } from "../table/table-brand";   // a table facade is recognised by BRAND, and the brand module is itself dependency-free
import { isEmbedding } from "../ml/embedding";   // an embedding is recognised by BRAND too; embedding.ts imports nothing
import { Denied, riskyRegex, PIPE_CHARS_PER_STEP, MAX_STRING, NotInDialect, NeedsPage, EMBED_SURVEY_CHARS, EMBED_SURVEY_CALLS, EMBED_CALL_INPUTS, HOST_SCAN_CHARS_PER_STEP } from "./limits";

// Property names that can walk back to the realm (window/Function/…). Denied on
// every read, static or computed. `constructor`/`__proto__` kill the
// `.constructor.constructor` → Function escape; the DOM/window names kill node →
// window.
export const DENIED_PROPS = new Set([
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
// A table facade is ruled out FIRST: it throws on a key it does not answer to (that is its job), and `length`
// is one, so probing its shape would trip the guard meant for a model's pandas reach.
// A DOMTokenList (`classList`, `relList`, `sandbox`, …) has the same shape and is ruled out by its BRAND, so it keeps the
// `tokenlist` kind (and `contains`) instead of being copied into an Array of strings: pass the evaluation's brand.
export const isDomCollection = (x: any, isTokenList: (o: unknown) => boolean = isTokenListHere): boolean =>
    x != null && typeof x === "object" && !Array.isArray(x) && !isTable(x) && !isTokenList(x) && typeof x.length === "number" && typeof x.item === "function";

/** The `length` getter of a realm's `DOMTokenList.prototype`, or undefined where there is none (the worker). */
function tokenListLength(ctor: unknown): ((this: unknown) => unknown) | undefined {
    const proto = typeof ctor === "function" ? (ctor as { prototype?: unknown }).prototype : undefined;
    return proto !== null && typeof proto === "object" ? Object.getOwnPropertyDescriptor(proto, "length")?.get : undefined;
}

// Captured when this module loads. Through the registered MAIN-world script (`document_start`, an approved origin) that is
// before the page's own scripts. But the worker also injects the page scripts into a page that has ALREADY run
// (`injectPageScripts`, sw-presence.ts: a page restored after a reload, a site approved while open, a run started on
// one), and then this is whatever `DOMTokenList` the page left: no pristine intrinsic survives a page that already ran.
// A page that replaced it can make its own objects read as token lists, so their `contains`/`item` run with converted
// string arguments, and can break the survey (every object a `tokenlist`, `document` included). That is accepted, not
// defended (docs/dev/readonly-exec.md, "A token list keeps its kind"). The worker has none, and has no DOM to hold one.
const TOKEN_LIST_LENGTH = tokenListLength((globalThis as { DOMTokenList?: unknown }).DOMTokenList);

/** The brand test for a real DOMTokenList, of any realm: BORROWS the interface's own `length` getter, whose receiver check
 *  throws on anything without the platform object's internals (a look-alike, an object whose prototype was set to
 *  `DOMTokenList.prototype`, a `Symbol.toStringTag` claim) and never runs the object's own members. The getter is this
 *  module's realm's; only a realm with NO `DOMTokenList` of its own (a test under Node, holding a jsdom document) takes
 *  it from `view`, the document's window, read before the survey starts. A browser realm with a document always has its
 *  own, so the getter is never re-read from the page's `window` during a survey. All of this holds for the getter
 *  captured at `document_start`; on a late injection the captured one may be the page's (`TOKEN_LIST_LENGTH`). */
export function tokenListBrand(view?: unknown): (o: unknown) => boolean {
    const get = TOKEN_LIST_LENGTH ?? (view !== null && typeof view === "object" ? tokenListLength((view as { DOMTokenList?: unknown }).DOMTokenList) : undefined);
    if (!get) return () => false;
    return (o) => {
        if (o === null || typeof o !== "object") return false;
        try { return typeof get.call(o) === "number"; } catch { return false; }
    };
}

/** {@link tokenListBrand} for this module's own realm: the default where no evaluation supplies one. */
const isTokenListHere = tokenListBrand();

// WHAT MAY BE CALLED, SCOPED TO WHAT IT IS CALLED ON.
//
// This was one flat set of NAMES, allowed on every receiver the dialect could reach — and the flat version
// was never what anyone meant. `querySelector` on a string and `map` on an element are already nonsense; they
// were simply nonsense that was permitted. The cost of that is not tidiness: a name harmless on one kind can
// be EFFECTFUL on another, and the allowlist could not tell them apart. `select` is the case that forced this
// — on a table it picks columns, on an `<input>` it changes the page's text selection.
//
// The codebase had already invented the fix twice, ad hoc: `ANSWER_METHODS` and `ML_READONLY_METHODS` sit
// outside the flat set precisely so `x.remove()` and `x.schema()` on a page object stay out of dialect. This
// generalises that, and those two become ordinary entries.
//
// Rules that make it a security mechanism rather than a lookup table:
//   · `kindOf` DEFAULTS TO DENY. An unrecognised receiver gets no methods at all and never falls back to "*".
//   · "*" is for names that must be harmless on EVERY receiver — which is exactly the property that failed
//     for `select`, so it stays as close to empty as the language allows.
//   · Kinds are decided STRUCTURALLY, not by `instanceof` or a constructor name: the dialect can reach an
//     iframe's document (`queryAll` pierces them), so a cross-realm Array is still an Array, and a page could
//     name a class anything it likes.
//
// Ownership stays a SEPARATE, orthogonal gate (MUTATING_METHODS + `owned`): the kind answers "is this name
// meaningful here", ownership answers "may I mutate THIS object". A Set reached off a page object is still a
// Set, and must not be mutable.
type MethodKind =
    | "array" | "string" | "number" | "date" | "regexp" | "set" | "map" | "promise"
    | "element" | "document" | "collection" | "tokenlist" | "style" | "console" | "table" | "embedding"
    | "Math" | "JSON" | "ObjectCtor" | "ArrayCtor" | "PromiseCtor" | "DateCtor" | "NumberCtor";

const BY_KIND: Record<MethodKind | "*", readonly string[]> = {
    // Harmless on anything. `then` is here because the dialect APPLIES a callback to a non-thenable (the shape
    // models write over auto-awaited ml reads), so its receiver can be any value; `toString` reads nothing.
    "*": ["then", "toString"],
    // Array — readers/pure PLUS the in-place builders (push/pop/…): array mutation is already tolerated
    // (sort/reverse/fill mutate in place), and these operate on a SCRIPT-LOCAL computation array (models write
    // `(o[k] = o[k] || []).push(x)` to build accumulators). Their returns are a length/element/removed-array —
    // plain data, never the realm. The `owned` gate below is what keeps them off the page's arrays.
    array: ["map", "filter", "forEach", "reduce", "reduceRight", "find", "findIndex", "findLast", "findLastIndex",
        "some", "every", "includes", "indexOf", "lastIndexOf", "slice", "concat", "join",
        "flat", "flatMap", "sort", "reverse", "at", "fill", "push", "pop", "shift", "unshift", "splice",
        "keys", "values", "entries"],
    // String, plus the string side of RegExp matching. All side-effect-free; `match`/`matchAll` return match
    // arrays, not the realm.
    string: ["substring", "substr", "toLowerCase", "toUpperCase", "trim", "trimStart", "trimEnd",
        "split", "startsWith", "endsWith", "replace", "replaceAll", "padStart", "padEnd",
        "repeat", "charAt", "charCodeAt", "codePointAt", "normalize", "localeCompare",
        "match", "matchAll", "search", "includes", "indexOf", "lastIndexOf", "slice", "concat", "at"],
    number: ["toFixed", "toPrecision", "toLocaleString"],
    // A Date's READS and FORMATTING (what models write: `new Date(ts).toISOString()`, `.getTime()`), never a `set*`,
    // which changes the Date in place. Each is O(1) and returns a number or a string.
    date: ["getTime", "valueOf", "getTimezoneOffset", "toISOString", "toJSON", "toString", "toDateString", "toTimeString",
        "toUTCString", "toLocaleString", "toLocaleDateString", "toLocaleTimeString",
        "getFullYear", "getMonth", "getDate", "getDay", "getHours", "getMinutes", "getSeconds", "getMilliseconds",
        "getUTCFullYear", "getUTCMonth", "getUTCDate", "getUTCDay", "getUTCHours", "getUTCMinutes", "getUTCSeconds",
        "getUTCMilliseconds"],
    regexp: ["test", "exec"],
    // Set / Map — reads (has/get; size is a property, read via readMember) PLUS the mutators, which the
    // `owned` gate confines to containers the script created. Scoping them here is what stops the same names
    // reaching a DOMTokenList or any other page object that happens to spell a method `add`.
    set: ["has", "add", "delete", "clear", "forEach", "keys", "values", "entries"],
    map: ["has", "get", "set", "delete", "clear", "forEach", "keys", "values", "entries"],
    promise: [],                    // `then` is in "*"; `catch`/`finally` are not in the dialect
    // DOM read / query. Nothing here mutates, and nothing returns the realm — the walk back to `window` is
    // cut by DENIED_PROPS.
    element: ["querySelector", "querySelectorAll", "getElementsByClassName", "getElementsByTagName",
        "getElementsByName", "closest", "matches", "getAttribute", "getAttributeNames", "hasAttribute",
        "contains", "getBoundingClientRect", "getRootNode"],
    document: ["querySelector", "querySelectorAll", "getElementById", "getElementsByClassName",
        "getElementsByTagName", "getElementsByName", "contains", "getRootNode"],
    collection: ["item", "forEach", "keys", "values", "entries", "at"],
    // A DOMTokenList (`classList`, `relList`, `sandbox`, `part`): its READ half. `add`/`remove`/`toggle`/`replace` change
    // the element's attribute and stay out, so on a token list they are refused as withheld, not missing (so is `supports`,
    // a pure read no survey has asked for, and which throws on every list but `rel`'s); `value` is a
    // property (a write to it is refused as any write to a page object is). `keys`/`values`/`entries`/`forEach` are
    // Array.prototype's own on this interface, and an iterator they return is drained (`drainIterator`).
    tokenlist: ["contains", "item", "forEach", "keys", "values", "entries"],
    // CSSStyleDeclaration (getComputedStyle) — pure readers. Named property reads (`.color`) go through
    // readMember. No setProperty/removeProperty: mutation, and they throw on a computed style anyway.
    style: ["getPropertyValue", "getPropertyPriority", "item"],
    console: ["log", "info", "warn", "error", "debug"],
    // A fetched or dereferenced TABLE (table-data.ts's facade). These four names are the reason the gate is
    // scoped at all: `select` picks columns here and CHANGES THE PAGE'S TEXT SELECTION on an `<input>`, so it
    // could never have joined a flat list. Each returns plain data or another facade, reads nothing outside
    // the table, and mutates nothing — the facade itself refuses writes.
    table: ["col", "select", "records", "head"],
    // An `ml.embed` result (embedding.ts): a unit vector and the two comparisons on it. Each is O(dimensions x
    // candidates), charged before it runs (evaluator.ts `preflight`), and neither reads anything but other embeddings.
    embedding: ["dot", "rank"],
    Math: ["max", "min", "floor", "ceil", "round", "abs", "pow", "sqrt", "sign", "trunc"],
    JSON: ["stringify", "parse"],
    ObjectCtor: ["keys", "values", "entries", "fromEntries", "assign"],
    ArrayCtor: ["from", "isArray", "of"],
    // Promise combinators. `Promise` itself is never callable (not a CALLABLE_ROOT, and `new` isn't in the
    // dialect), so this cannot mint a promise around anything the gates did not already allow.
    PromiseCtor: ["all", "allSettled"],
    // The clock and two pure parsers. `Date` itself is not a CALLABLE_ROOT, so `Date()` stays refused; `new Date(…)`
    // is a SAFE_CONSTRUCTOR as before.
    DateCtor: ["now", "parse", "UTC"],
    // The number tests and parsers. `Number.isNaN` and `Number.isFinite` do not coerce, unlike the free `isNaN` and
    // `isFinite` the dialect already calls; `Number.parseFloat`/`parseInt` ARE the free ones.
    NumberCtor: ["isNaN", "isFinite", "isInteger", "isSafeInteger", "parseFloat", "parseInt"],
};

// ---------------------------------------------------------------------------------------------------------------
// CONVERSION: which argument of which admitted method the HOST converts to a primitive.
//
// A host method converts an object argument with ToString or ToNumber, which calls the object's own `toString`/`valueOf`:
// a page's code, run inside a survey that promised to run none. So at the host-call site each converting position must
// hold a value `convertible` (evaluator.ts) judges to be data. Every admitted method is in exactly ONE of the two tables
// below, and a test walks `METHODS_BY_KIND` to fail for a method in neither: a method added to the whitelist later has
// to be decided here, not slip through. A position is "all" (every argument) or the indexes that convert.
type Positions = "all" | readonly number[];
/** Types a table of positions, since object literals naming `toString`/`toLocaleString` fight the inherited signatures. */
const all = (...names: string[]): Record<string, Positions> => Object.fromEntries(names.map((n) => [n, "all" as const]));
const pos = (...o: Record<string, Positions>[]): Record<string, Positions> => Object.assign(Object.create(null), ...o);
/** The arguments of each admitted method (by receiver kind) that the host converts to a primitive, running an object's own `toString`/`valueOf`: each must hold a value `converts` accepts. */
export const CONVERTS: Readonly<Record<string, Readonly<Record<string, Positions>>>> = {
    string: {
        substring: "all", substr: "all", slice: "all", at: "all", charAt: "all", charCodeAt: "all", codePointAt: "all",
        repeat: "all", padStart: "all", padEnd: "all", normalize: "all", includes: "all", indexOf: "all", lastIndexOf: "all",
        startsWith: "all", endsWith: "all", concat: "all", localeCompare: "all", split: "all", replace: "all", replaceAll: "all",
    },
    array: { flat: [0], slice: [0, 1], at: [0], splice: [0, 1], fill: [1, 2], includes: [1], indexOf: [1], lastIndexOf: [1] },
    number: pos(all("toFixed", "toPrecision", "toLocaleString"), { toString: [0] }),
    date: pos(all("toLocaleString", "toLocaleDateString", "toLocaleTimeString")),
    Math: { max: "all", min: "all", floor: "all", ceil: "all", round: "all", abs: "all", pow: "all", sqrt: "all", sign: "all", trunc: "all" },
    JSON: { parse: [0], stringify: [2] },
    NumberCtor: { parseFloat: "all", parseInt: "all" },
    DateCtor: { parse: [0], UTC: "all" },
    element: { querySelector: [0], querySelectorAll: [0], getElementsByClassName: [0], getElementsByTagName: [0], getElementsByName: [0],
        closest: [0], matches: [0], getAttribute: [0], hasAttribute: [0], getRootNode: [0] },
    document: { querySelector: [0], querySelectorAll: [0], getElementById: [0], getElementsByClassName: [0], getElementsByTagName: [0],
        getElementsByName: [0], getRootNode: [0] },
    collection: { item: [0], at: [0] },
    tokenlist: { contains: [0], item: [0] },
    style: { getPropertyValue: [0], getPropertyPriority: [0], item: [0] },
    table: { col: "all", select: "all", records: "all", head: "all" },
};

const NONE = "takes no argument";
const DATA = "its arguments are values compared or stored as data, never converted";
/** The admitted methods that convert NO argument, each with the reason. A method here that gains a converting position is a bug the
 *  tests catch by measurement (tests/redteam-coerce-args.test.mjs), not by this list. */
export const NO_CONVERSION: Readonly<Record<string, Readonly<Record<string, string>>>> = {
    "*": { then: "takes a callback, judged by onlyOurFunctions", toString: NONE + " (a number's radix is under `number`)" },
    array: { map: "callback", filter: "callback", forEach: "callback", reduce: "callback", reduceRight: "callback", find: "callback",
        findIndex: "callback", findLast: "callback", findLastIndex: "callback", some: "callback", every: "callback", flatMap: "callback",
        sort: "callback or none", join: "its separator is judged by joinsData and the string-separator check",
        concat: DATA, reverse: NONE, push: DATA, pop: NONE, shift: NONE, unshift: DATA, keys: NONE, values: NONE, entries: NONE },
    string: { toLowerCase: NONE, toUpperCase: NONE, trim: NONE, trimStart: NONE, trimEnd: NONE,
        match: "a non-string non-regex pattern already refuses (redteam-coercion)", matchAll: "as match", search: "as match" },
    date: { getTime: NONE, getTimezoneOffset: NONE, valueOf: NONE, toISOString: NONE, toJSON: NONE, toString: NONE, toDateString: NONE,
        toTimeString: NONE, toUTCString: NONE, getFullYear: NONE, getMonth: NONE, getDate: NONE, getDay: NONE, getHours: NONE,
        getMinutes: NONE, getSeconds: NONE, getMilliseconds: NONE, getUTCFullYear: NONE, getUTCMonth: NONE, getUTCDate: NONE,
        getUTCDay: NONE, getUTCHours: NONE, getUTCMinutes: NONE, getUTCSeconds: NONE, getUTCMilliseconds: NONE },
    regexp: { test: "a non-string argument already refuses (redteam-coercion)", exec: "as test" },
    set: { has: DATA, add: DATA, delete: DATA, clear: NONE, forEach: "callback", keys: NONE, values: NONE, entries: NONE },
    map: { has: DATA, get: DATA, set: DATA, delete: DATA, clear: NONE, forEach: "callback", keys: NONE, values: NONE, entries: NONE },
    promise: {},
    element: { getAttributeNames: NONE, contains: "takes a Node: a TypeError, never a conversion", getBoundingClientRect: NONE },
    document: { contains: "takes a Node: a TypeError, never a conversion" },
    collection: { forEach: "callback", keys: NONE, values: NONE, entries: NONE },
    tokenlist: { forEach: "callback", keys: NONE, values: NONE, entries: NONE },
    console: { log: "recorded through printable(), never converted", info: "as log", warn: "as log", error: "as log", debug: "as log" },
    embedding: { dot: "arguments are validated as embeddings by preflight", rank: "as dot" },
    ObjectCtor: { keys: "property reads, not conversion", values: "as keys", entries: "as keys", fromEntries: "as keys", assign: "as keys" },
    ArrayCtor: { from: "its first argument is an iterable judged by `iterates` (an array-like included), its mapper by onlyOurFunctions", isArray: DATA, of: DATA },
    PromiseCtor: { all: DATA, allSettled: DATA },
    DateCtor: { now: NONE },
    NumberCtor: { isNaN: "does not coerce", isFinite: "does not coerce", isInteger: "does not coerce", isSafeInteger: "does not coerce" },
};

/** The argument indexes of `args` that `kind`'s method `key` converts to a primitive, or none. */
export function convertingArgs(kind: string | null, key: string, count: number): number[] {
    if (kind === null) return [];
    const at = CONVERTS[kind] !== undefined && Object.hasOwn(CONVERTS[kind], key) ? CONVERTS[kind][key] : undefined;
    if (at === undefined) return [];
    return at === "all" ? Array.from({ length: count }, (_, i) => i) : at.filter((i) => i < count);
}

/** The constructors (`SAFE_CONSTRUCTORS`) that convert their arguments, with the positions: `new Date(o)`, `new String(o)`, `new RegExp(o, flags)`. A collection's iterable is `CTOR_ITERABLES`; the rest are `NO_CTOR_CONVERSION`. */
export const CTOR_CONVERTS: Readonly<Record<string, Positions>> = { Date: "all", RegExp: [0, 1], Number: "all", String: "all", Error: [0] };

/** The constructors whose first argument is an ITERABLE the host walks by calling its `Symbol.iterator` and `next` (`new Set(o)`): a page's own
 *  iterator is page code, so the argument must be a string, an array, a Set or a Map without an own iterator (judged in `iterates`). */
export const CTOR_ITERABLES: ReadonlySet<string> = new Set(["Set", "Map", "WeakSet", "WeakMap"]);

/** The `SAFE_CONSTRUCTORS` that neither convert an argument nor walk an iterable, each with the reason; a test enumerates the whitelist against
 *  this and `CTOR_CONVERTS` and `CTOR_ITERABLES`, so a constructor added later has to be decided. */
export const NO_CTOR_CONVERSION: Readonly<Record<string, string>> = {
    Array: "a length (a number) or the elements themselves, stored as data",
    Object: "wraps its argument as it is",
    Boolean: "truthiness, never a conversion that calls a method",
};

/** The bare roots that convert their arguments (`String(o)`, `parseInt(o)`), with the positions: `getComputedStyle`'s pseudo-element
 *  is the one converting argument of a function whose first is an element. */
export const ROOT_CONVERTS: Readonly<Record<string, Positions>> = { String: "all", Number: "all", parseInt: "all", parseFloat: "all", isNaN: "all", isFinite: "all", getComputedStyle: [1] };

/** The prototypes a script-built object may inherit from without any of them being a page's: compared by identity. */
const INTRINSIC_PROTOS: ReadonlySet<unknown> = new Set([Object.prototype, Array.prototype, Date.prototype, RegExp.prototype, String.prototype, Number.prototype, Boolean.prototype, Map.prototype, Set.prototype]);

/** Does a SCRIPT-BUILT object convert to a primitive only through code the engine mediates? Its own `toString`, `valueOf` and
 *  `Symbol.toPrimitive` must be a function the script wrote (`ours`; a page's function stored in a literal is not), it has no
 *  accessor for them and no own `Symbol.toStringTag`, and its prototype chain is intrinsic prototypes only. Only ever asked
 *  of a value the evaluator owns: inspecting a page's object this way could itself run its Proxy traps. */
export function convertsByIntrinsics(o: object, ours: (f: unknown) => boolean): boolean {
    for (const k of Reflect.ownKeys(o)) {
        if (k === Symbol.toStringTag) return false;
        if (k === "toString" || k === "valueOf" || k === Symbol.toPrimitive) {
            const d = Object.getOwnPropertyDescriptor(o, k);
            if (!d || !("value" in d) || (typeof d.value === "function" ? !ours(d.value) : d.value != null)) return false;
        }
    }
    for (let p = Object.getPrototypeOf(o); p !== null; p = Object.getPrototypeOf(p)) if (!INTRINSIC_PROTOS.has(p)) return false;
    return true;
}

/** Every method the dialect admits, by receiver kind (`*` is every receiver): what the completeness walk in the tests reads. */
export const METHODS_BY_KIND: Readonly<Record<string, readonly string[]>> = BY_KIND;

const KIND_SETS = new Map<string, Set<string>>(Object.entries(BY_KIND).map(([k, v]) => [k, new Set(v)]));

const ANY_KIND = KIND_SETS.get("*")!;

/** The methods a completion may OFFER on a receiver of `kind` (a watch's input, the read-only console): the kind's own
 *  allowlist, without the mutators, since what a completion is offered is state the script did not build and may only
 *  read. Empty for a kind with none, and for a name that is no kind. */
export function offeredMethods(kind: string): readonly string[] {
    // OWN keys only: `BY_KIND.constructor` is Object's, and a typed name is not to reach it.
    return Object.hasOwn(BY_KIND, kind) ? BY_KIND[kind as MethodKind].filter((m) => !MUTATING_METHODS.has(m)) : [];
}

/** What KIND of receiver is this, for the purpose of deciding which method names are callable on it?
 *
 *  Structural throughout, because `instanceof` is realm-bound and the dialect can hold a value from an
 *  iframe's realm (`ml.queryAll` pierces them). Returns null for anything unrecognised — and null means NO
 *  methods, never a fallback, so a receiver this does not understand cannot be called at all. */
export function kindOf(obj: unknown, isTokenList: (o: unknown) => boolean = isTokenListHere): MethodKind | null {
    if (obj == null) return null;
    if (typeof obj === "string") return "string";
    if (typeof obj === "number") return "number";
    if (Array.isArray(obj)) return "array";
    if (typeof obj === "function") {
        // The namespace/constructor objects whose STATICS the dialect allows. Compared by identity against
        // this realm's builtins; a cross-realm `Array` is a different function object and simply is not one of
        // these, which fails closed.
        if (obj === Math as unknown) return "Math";
        if (obj === (Object as unknown)) return "ObjectCtor";
        if (obj === (Array as unknown)) return "ArrayCtor";
        if (obj === (Promise as unknown)) return "PromiseCtor";
        if (obj === (Date as unknown)) return "DateCtor";
        if (obj === (Number as unknown)) return "NumberCtor";
        return null;
    }
    if (obj === (JSON as unknown)) return "JSON";
    if (obj === (Math as unknown)) return "Math";
    if (typeof obj !== "object") return null;
    // BY IDENTITY, before anything structural: a table facade is a Proxy that THROWS on an unknown key, so
    // shape-testing it would trip its own guard — and a page must not be able to CLAIM the kind, which a
    // property or a well-known symbol would allow (see table-brand.ts). Only `asTable` grants membership.
    if (isTable(obj)) return "table";
    // The same for an embedding: only `Embedding.from` grants it, so a page object cannot claim `dot`.
    if (isEmbedding(obj)) return "embedding";
    const o = obj as Record<string, unknown>;
    // A String OBJECT, not a primitive: `ml.dereference` returns a String subclass (DerefText) so a pointer
    // read is usable as the string it is. It must get the string methods, or the wrapper silently costs the
    // caller `.split`/`.startsWith`.
    // By BRAND, not by `toString` tag (a page sets that through Symbol.toStringTag, and reading it RUNS the page's getter).
    if (isStringObject(o)) return "string";
    // Set / Map, told apart by their own brand rather than by prototype identity: calling the getter on a
    // foreign object throws, which is the check. (`size` is an accessor on Set.prototype/Map.prototype.)
    if (isSet(o)) return "set";
    if (isMap(o)) return "map";
    if (typeof (o as { then?: unknown }).then === "function") return "promise";
    // By BRAND, not by `toString` tag: a page object can claim `Symbol.toStringTag = "Date"`, and since a date now has
    // methods, a claimed one would have its OWN `getTime` called. The borrowed getter throws on anything without a
    // Date's internal slot, across realms too.
    if (isDate(o)) return "date";
    if (isRegExpObject(o)) return "regexp";
    // By BRAND, before the structural `collection` it would otherwise match: a page object with a `length`, an `item`
    // and a `contains` of its own stays a collection, whose allowlist has no `contains`.
    if (isTokenList(o)) return "tokenlist";
    // A DOCUMENT before an element: it answers `getElementById`, which an element does not.
    if (typeof (o as { createElement?: unknown }).createElement === "function" && typeof (o as { getElementById?: unknown }).getElementById === "function") return "document";
    if (typeof (o as { nodeType?: unknown }).nodeType === "number") return "element";
    if (typeof (o as { getPropertyValue?: unknown }).getPropertyValue === "function") return "style";
    if (isDomCollection(o, isTokenList)) return "collection";
    // The CAPTURED console — the evaluator swaps in its own recorder, so this is matched by shape rather
    // than by identity with the global (which the interpreter deliberately never holds).
    if (typeof (o as { log?: unknown }).log === "function" && typeof (o as { warn?: unknown }).warn === "function") return "console";
    return null;
}

/** Is this a real Set / Map? Asked by BORROWING the prototype's own accessor: it throws on anything that is
 *  not one, which no amount of shape-copying by a page object can fake, and it works across realms where
 *  `instanceof` does not. */
const brandCheck = (proto: object, prop: string) => {
    const get = Object.getOwnPropertyDescriptor(proto, prop)?.get;
    return (o: unknown): boolean => { try { get?.call(o); return !!get; } catch { return false; } };
};

/** A real Set, of any realm. */
export const isSet = brandCheck(Set.prototype, "size");

/** A real Map, of any realm. */
export const isMap = brandCheck(Map.prototype, "size");

/** Is this a real Date, from any realm? Its own getter cannot be faked: `Date.prototype.getTime` throws on anything
 *  else, whatever it claims to be. */
const isDate = (o: object): boolean => { try { Date.prototype.getTime.call(o); return true; } catch { return false; } };

/** Is this a real String object, from any realm? Asked by BORROWING `String.prototype.valueOf`, which throws on anything
 *  without a String's internal slot and never runs the object's own `valueOf`, `toString` or `Symbol.toStringTag`. */
export const isStringObject = (o: object): boolean => { try { String.prototype.valueOf.call(o); return true; } catch { return false; } };

const regexpGlobal = Object.getOwnPropertyDescriptor(RegExp.prototype, "global")?.get;

/** Is this a real RegExp, from any realm? Asked by BORROWING the `global` accessor: it throws on anything without a
 *  RegExp's internal slot, and answers `undefined` only for this realm's `RegExp.prototype`, which is no regexp. */
export const isRegExpObject = (o: object): boolean => { try { return typeof regexpGlobal?.call(o) === "boolean"; } catch { return false; } };

const ITERATOR_NEXTS = [[], new Set(), new Map()].map((c) => Object.getPrototypeOf((c as Iterable<unknown>)[Symbol.iterator]()).next as (this: unknown) => IteratorResult<unknown>);

/** The items of a real Array, Set or Map ITERATOR of this realm, drained by BORROWING the intrinsic `next` (it throws on
 *  anything that is no such iterator, before consuming a thing), or null when `o` is not one. Never runs the object's own
 *  `next`, `Symbol.iterator` or `Symbol.toStringTag`, which a page object can all set. */
export function drainIterator(o: object): unknown[] | null {
    for (const next of ITERATOR_NEXTS) {
        let r: IteratorResult<unknown>;
        try { r = next.call(o); } catch { continue; }
        const items: unknown[] = [];
        for (; !r.done; r = next.call(o)) items.push(r.value);
        return items;
    }
    return null;
}

/** May `key` be CALLED on `obj`? The whole method gate, in one place: the receiver's kind decides, an
 *  unrecognised receiver gets nothing, and "*" holds only what is harmless everywhere. */
export function methodAllowed(obj: unknown, key: string, isTokenList?: (o: unknown) => boolean): boolean {
    if (ANY_KIND.has(key)) return true;
    const kind = kindOf(obj, isTokenList);
    return kind !== null && (KIND_SETS.get(kind)?.has(key) ?? false);
}

// Free identifiers that may be CALLED directly: coercion/parse builtins + getComputedStyle (a pure,
// same-origin read; bound to the view in evalReadonly so it never hands back `window`, and its result's
// walk-back to window is cut by DENIED_PROPS). Historic :visited history-sniffing is dead — every modern
// browser returns the UNVISITED style through getComputedStyle.
// `Array(n)` is included so the idiomatic bounded counter loop `[...Array(n).keys()].map(…)` resolves —
// pure (a holey array of length n), and its only new failure mode (a huge spread) is the same unbounded
// allocation `Array.from({length:n}, …)` already permits, not a new capability. `Array.from`/`Array.isArray`
// stay reachable as member calls regardless.
export const CALLABLE_ROOTS = new Set(["String", "Number", "Boolean", "Array", "parseInt", "parseFloat", "isNaN", "isFinite", "getComputedStyle"]);

/** The engine's OWN functions a script may hand a host method as its callback by bare name (`.map(Number)`, `.filter(Boolean)`):
 *  this module's intrinsics, matched by identity, so a function a page handed back as data is never one of them. A member
 *  reference (`Math.abs`) is the inert `METHOD_REF`, which throws if called and so is always admitted. `getComputedStyle`
 *  is admitted by the evaluator against its own root, not here. */
export const INTRINSIC_CALLBACKS: ReadonlySet<unknown> = new Set([String, Number, Boolean, Array, parseInt, parseFloat, isNaN, isFinite]);

/** The engine's own function for each bare root a script may call by name (all of `CALLABLE_ROOTS` but `getComputedStyle`, which is per realm):
 *  a call is allowed only when the name still holds THIS function, by identity. */
export const INTRINSIC_ROOTS: Readonly<Record<string, unknown>> = { String, Number, Boolean, Array, parseInt, parseFloat, isNaN, isFinite };

/** The intrinsics in `INTRINSIC_CALLBACKS` that COERCE their argument (all but `Boolean` and `Array`): as a callback they
 *  run an element's own `valueOf`/`toString`, so the elements they are handed must be data. */
export const COERCING_CALLBACKS: ReadonlySet<unknown> = new Set([String, Number, parseInt, parseFloat, isNaN, isFinite]);

// A target a member WRITE may land on: a SCRIPT-LOCAL computation container only — a plain object (`{}` /
// `Object.create(null)` / a JSON.parse result / an `ml.config()` value) or an Array. A DOM node (proto is
// HTMLElement.prototype), a NodeList, a Set/Map, `window`, the interpreter's scope — anything with a
// non-plain prototype — is REFUSED, so `o[k] = v` can never mutate the PAGE or the realm. Combined with
// guardKey (which denies __proto__/constructor/prototype), assignment stays read-only w.r.t. the page.
export function isWritableTarget(o: unknown): boolean {
    if (Array.isArray(o)) return true;
    if (o == null || typeof o !== "object") return false;
    const proto = Object.getPrototypeOf(o);
    return proto === Object.prototype || proto === null;
}

// The ONLY constructors `new X(…)` may build — pure, side-effect-free, realm-safe builtins. Everything else
// is ABSENT → Denied: `new Function('code')` (code gen), `new Image`/`XMLHttpRequest`/`WebSocket`/`Worker`
// (network / side effect), any host constructor. Resolved by NAME, not by a scope lookup, so it can't be
// rebound. Their RESULTS are ordinary values that flow through the same read/call mediation as everything else.
export const SAFE_CONSTRUCTORS: Record<string, new (...a: any[]) => unknown> = {
    Set, Map, WeakSet, WeakMap, Array, Object, Date, RegExp, Number, String, Boolean, Error,
};

// In-place MUTATORS (array push/…, plus Set.add and Map/Set set/delete/clear). Allowed ONLY on a container
// the SCRIPT created (tracked in `owned`) — never a container reached off a page object. So `pageState.items
// .push(x)` / `.sort()` / `document.body.classList.add('x')` can't grow/reorder/mutate the page's own data;
// only the survey's local accumulators (`(o[k] = o[k] || []).push(x)`, `new Set()`, `new Map()`) can.
export const MUTATING_METHODS = new Set(["push", "pop", "shift", "unshift", "splice", "sort", "reverse", "fill", "add", "set", "delete", "clear"]);

/** Allowed methods that WRITE one of their ARGUMENTS, by receiver kind, to the argument indices they write: the library
 *  manifest's `mutates(i)` in miniature (docs/spec/READONLY_LIBRARY_MANIFEST.md). Each listed argument must be what
 *  `o[k] = v` may write: a plain object or array the script built, not being iterated. A new allowed member that writes
 *  an argument is covered by a line here, and `tests/readonly-exec.test.mjs` enumerates this table. */
export const ARG_WRITERS: Readonly<Partial<Record<MethodKind, Readonly<Record<string, readonly number[]>>>>> = {
    ObjectCtor: { assign: [0] },
};

/** The argument indices `obj.key(…)` writes, from {@link ARG_WRITERS}; empty for a call that writes none. */
export function argWrites(obj: unknown, key: string): readonly number[] {
    const kind = kindOf(obj);
    const row = kind ? ARG_WRITERS[kind as MethodKind] : undefined;
    return row && Object.hasOwn(row, key) ? row[key] : [];
}

// The ONLY methods callable on the `ml.answer` facade (curate the run's own user-facing answer). Kept
// local so this interpreter stays dependency-free; must match makeAnswerFacade's surface in answer-set.ts.
// Deliberately NOT in ALLOWED_METHODS — so `x.remove()`/`x.dump()` on any OTHER object stays out of dialect.
export const ANSWER_METHODS = new Set(["add", "remove", "clear", "dump"]);

// The `window.ml` methods this dialect may call — side-effect-free reads: no privilege, no page
// mutation, no tokens/VRAM. Everything else is simply ABSENT from the facade we build, so it can't
// be reached: setModel/unload MUTATE (setModel would re-point the model the run itself is using),
// chat/agent/read spend tokens and can recurse, pythonExec/screenshot are privileged. `config()` is
// already the non-secret MlPublicConfig subset — no URL, no API key. `queryAll` returns live Elements
// (not plain data), but those flow through the SAME read-mediation as document.querySelectorAll's —
// a pure shadow/iframe-piercing query, no new capability over what the dialect already reaches.
// `a11y` takes a LIVE element (from queryAll) and returns a fresh plain OBJECT of STRINGS — role / accessible
// name / aria state / `>>>` reference — pure reads of one node (the same a11y + reference expertise the
// interactives/findByText tools use). It adds no capability the dialect lacks (it already reaches elements +
// reads their attributes); it just packages it. The object's values are strings and its `constructor`/proto
// stay denied by guardKey, so it can't reach a realm/effect, and it neither mutates nor spends.
// `info` is machine CAPACITY (VRAM totals, system RAM) — a read of the hardware, spending nothing and
// changing nothing, and it exposes no more than `ps` already does. A survey asking "will this fit" shouldn't
// cost a prompt.
// `dereference` belongs here for the same reason the rest do: it is a pure READ of values THIS run already
// captured — no page mutation, no egress, no token spend, and nothing it returns wasn't already produced by an
// approved call. A survey that re-reads its own earlier output should not cost a prompt. (It is also run-bound
// on the real API, so outside a run it throws before the facade is even reached.)
// `schema` is here rather than in ALLOWED_METHODS deliberately: the facade is dispatched by IDENTITY, so
// this grants `ml.schema(…)` and nothing else, where allowing the NAME would grant `.schema()` on every
// object the dialect can reach. Pure — it reads data and returns a type string, spending nothing.
export const ML_READONLY_METHODS = ["getModel", "config", "models", "capabilities", "ps", "serverTools", "queryAll", "range", "a11y", "dereference", "info", "schema"] as const;

/** The read-only members that read the PAGE, so a worker-side evaluation has none of them and defers to the page. */
const PAGE_ML_METHODS: ReadonlySet<string> = new Set(["queryAll", "a11y"]);

/** Where a survey is evaluated. `page`: the page's main world, with its DOM. `worker`: the service worker, with no
 *  DOM, where the run's own context can be read without it ever entering the page (docs/spec/CURRENT_CONTEXT.md).
 *  `policy`: a policy over one call's facts (docs/spec/POLICIES.md), with no `ml`, no DOM and no clock, whose only root
 *  is `c`, a facade that refuses a field it does not have; `==` and `!=` are refused there (`evalPolicy`). */
export type ReadonlyRealm = "page" | "worker" | "policy";

/** Build the `ml` object the dialect sees: ONLY {@link ML_READONLY_METHODS}, bound to the real API.
 *  A purpose-built facade rather than `window.ml` itself, so the free set is enforced by what exists,
 *  not only by a name check. Returns null when there's no ml (→ `ml` isn't in scope at all). */
export function mlFacade(ml: unknown, reused?: string[], answerFacade?: unknown, meter?: { charge(steps: number): void }, realm: ReadonlyRealm = "page"): Record<string, unknown> | null {
    if (!ml || typeof ml !== "object") return null;
    const out: Record<string, unknown> = Object.create(null);
    // IN THE WORKER the facade is an ALLOW list of what is safe there, built by leaving out what reads the page,
    // rather than a deny list of what does not: a member nobody listed is ABSENT, and reaching an absent member in
    // the worker defers the survey to the page (NeedsPage) instead of failing. So a page-reading member added later
    // costs one extra hop, never a hole. Left out here: the DOM reads, the page's fetch cache, the answer set.
    const worker = realm === "worker";
    for (const name of ML_READONLY_METHODS) {
        if (worker && PAGE_ML_METHODS.has(name)) continue;
        const fn = (ml as Record<string, unknown>)[name];
        if (typeof fn === "function") out[name] = (fn as (...a: unknown[]) => unknown).bind(ml);
    }
    // `ml.fetch(url)` in the dialect is CACHE-ONLY: it returns an ALREADY-fetched result (a pure read of
    // bytes the user already approved fetching) and THROWS on a cache miss — so a NEW url falls through to
    // the normal approval + full eval, which does the real (egress) fetch. It NEVER egresses in read-only,
    // so a survey that re-reads an approved URL auto-approves (the python_exec+Sheet parallel). Kept OUT of
    // ML_READONLY_METHODS (which drives the "always free" docs) because it's free only for cached URLs.
    const cachedFetch = (ml as Record<string, unknown>)["_fetchCached"];
    // Each realm reads its OWN cache, and neither ever fetches: the page's is `ml.fetch`'s in the main world, the
    // worker's is what the run's `fetch_url` read there (worker-tools.ts). In the worker, anything it cannot answer
    // (a miss, a non-default mode) defers to the page, whose cache an approved exec's inline fetch fills and whose
    // live document answers a session render of itself; there a miss is refused as before.
    if (typeof cachedFetch === "function") {
        out.fetch = (url: unknown, opts?: unknown): unknown => {
            // The MODE is part of the question, so it is handed to the host rather than dropped: the cache holds
            // only default-mode results, and a `rendered` or `format: "html"` read answered from it would be a
            // different document under the name of the one asked for. Handed over as a fresh copy of the four
            // fields the host reads, never the script's own object.
            const o = opts && typeof opts === "object" ? opts as Record<string, unknown> : {};
            const mode = { fresh: !!o.fresh, credentials: !!o.credentials, rendered: !!o.rendered, format: o.format === "html" ? "html" as const : "markdown" as const };
            // `fresh` skips the cache by definition: always egress, so never here.
            if (mode.fresh) throw new Denied("fetch({ fresh }) is a live fetch — it needs approval");
            let r = (cachedFetch as (u: unknown, m: typeof mode) => unknown).call(ml, url, mode);
            // Defence in depth, kept HERE rather than trusted to the host: a non-default mode is only ever
            // answered by a LIVE read of the page you are on (nothing else in those modes is cached), so any
            // other answer to one is a host bug handing back the wrong document — refused, not served.
            if (r !== undefined && (mode.credentials || mode.rendered) && !(r as { live?: unknown })?.live) r = undefined;
            if (r === undefined && worker) throw new NeedsPage(`fetch(${JSON.stringify(String(url))}) is not in the worker's cache`);
            if (r === undefined) throw new Denied(mode.credentials
                ? "fetch({ credentials }) is an authenticated fetch — it needs approval"
                : `fetch(${JSON.stringify(String(url))}) isn't cached in this mode — approve it once, then re-reads are free`);
            // A cache HIT = this survey re-read a URL you already approved (transparency). A LIVE read of the page
            // you are on reused no grant, so it is not reported as one.
            if (!(r as { live?: unknown }).live) reused?.push(String(url));
            return r;
        };
    }
    // `ml.pipe(text, stages)` — the `grep | head` line scanner, which models reach for constantly, often in place of
    // the JS they would otherwise have to write (`ml.pipe(JSON.stringify(cfg, null, 1), "grep -iE 'model|approve' |
    // head 40")`). Pure: no I/O, no DOM, no tokens. Free here on three conditions the host enforces through `limits`,
    // because one pipe is one host call the step budget cannot otherwise see:
    //   - every regex it is about to compile passes `riskyRegex` (V8 has no match timeout, and `grep -E` and `sed`
    //     compile what the model wrote), else the survey goes to the human;
    //   - each stage is charged its input at PIPE_CHARS_PER_STEP, so a pipe inside a `.map` costs what it does;
    //   - no stage may produce more than MAX_STRING characters, and the two that grow by more than a constant factor
    //     (`sed`, and JSON pretty-printing, which is quadratic in depth) are refused BEFORE they build it.
    // The SOURCE is unwrapped HERE, from own data properties only: handing the host an arbitrary object would let
    // it read a getter, and on the page a getter is the page's code. A third argument from the script is never
    // forwarded, so a script cannot pass its own (absent) limits.
    const hostPipe = (ml as Record<string, unknown>)["pipe"];
    if (typeof hostPipe === "function") {
        const own = (o: object, k: string): unknown => Object.getOwnPropertyDescriptor(o, k)?.value;
        out.pipe = (source: unknown, stages?: unknown): unknown => {
            let text: unknown = source;
            if (source !== null && typeof source === "object" && (Array.isArray(source) || isWritableTarget(source))) {
                const md = own(source, "markdown"), tx = own(source, "text");
                if (typeof md === "string" || typeof tx === "string") text = typeof md === "string" ? md : tx;
            }
            if (typeof text !== "string") {
                const got = text === null ? "null" : Array.isArray(text) ? "an array" : typeof text === "object" ? "an object" : typeof text;
                throw new Error(`ml.pipe needs a string (or a fetch result), got ${got}. For an object, JSON.stringify it first — the \`.path\`/keys/schema stages then read it.`);
            }
            if (stages != null && typeof stages !== "string" && !(Array.isArray(stages) && stages.every(x => typeof x === "string")))
                throw new Error("ml.pipe's stages are a string (\"grep x | head 5\") or an array of strings, one stage each.");
            return (hostPipe as (...a: unknown[]) => unknown).call(ml, text, Array.isArray(stages) ? [...stages] : stages, {
                onPattern: (src: string) => {
                    const why = riskyRegex(src);
                    if (why) throw new Denied(`ml.pipe: the pattern ${JSON.stringify(src)} has ${why}, which can run for hours on one line — it needs approval`);
                },
                charge: (chars: number) => meter?.charge(Math.ceil(chars / PIPE_CHARS_PER_STEP)),
                ...(meter ? { steps: (n: number) => meter.charge(n) } : {}),
                maxChars: MAX_STRING,
                tooLarge: (msg: string): never => { throw new NotInDialect(`${msg}, too much to build without asking`); },
            });
        };
    }
    // `ml.jsonPath(value, expr, { paths })` — RFC 9535 JSONPath over JSON data (json-path.ts): no eval, its own parser.
    // Free here under the same three bounds as the pipe, and for the same reason (one host call, work the step count
    // cannot otherwise see, over an expression the model wrote): every node it visits is CHARGED to the step budget
    // (`$..[?@..x]` is quadratic), every `match()`/`search()` pattern passes `riskyRegex` before it is compiled, and only
    // a sanitized `{ paths }` is forwarded, never the script's own object. It reads members as DATA, so a getter on a
    // page object is refused, not run, and a cycle is an error, not a hang.
    const hostJsonPath = (ml as Record<string, unknown>)["jsonPath"];
    if (typeof hostJsonPath === "function") {
        out.jsonPath = (source: unknown, expr: unknown, opts?: unknown): unknown => {
            if (typeof expr !== "string") throw new Error('ml.jsonPath takes an expression string as its second argument, such as "$..id"');
            const paths = !!(opts && typeof opts === "object" && Object.getOwnPropertyDescriptor(opts, "paths")?.value === true);
            return (hostJsonPath as (...a: unknown[]) => unknown).call(ml, source, expr, { paths }, {
                charge: (n: number) => meter?.charge(n),
                ...(meter ? { steps: (n: number) => meter.charge(n) } : {}),
                onPattern: (src: string) => {
                    const why = riskyRegex(src);
                    if (why) throw new Denied(`ml.jsonPath: the pattern ${JSON.stringify(src)} has ${why}, which can run for hours on one value — it needs approval`);
                },
            });
        };
    }
    // `ml.embed(text | texts)` — the ONE survey member that makes a live model call: the configured embedding model,
    // nothing else, so a survey can find WHERE a long text talks about something (embed its pages, rank them against
    // a query) without a prompt. Free on four conditions, because a call is a round trip to the embedding server
    // whose time the step budget cannot see:
    //   - only the configured model: any second argument (`{ model }`) goes to the person;
    //   - the inputs are read as DATA here: a string, a String object, or an array of them, copied out of own
    //     indexed data properties, so a getter on a page array never runs; anything else is a TypeError the
    //     survey can catch;
    //   - each call is charged the interpreter's own work, its inputs scanned (a vector costs a step an element read,
    //     and `dot`/`rank` are charged their dimensions);
    //   - the server's work is capped per survey: EMBED_SURVEY_CHARS characters and EMBED_SURVEY_CALLS calls in all,
    //     EMBED_CALL_INPUTS strings a call; past any of them the survey goes to the person, who sees the code.
    // A survey that embeds and then falls out of dialect has spent that time, but changed nothing anyone else reads:
    // the vectors were the survey's own, and the approved run that replaces it embeds again.
    // A PAGE member: in the worker it is absent whatever the host has, so a worker survey defers to the page, and a
    // facade built with no meter (the Python wire's, sw-ml-wire.ts) never makes a live call, since nothing would charge it.
    const hostEmbed = (ml as Record<string, unknown>)["embed"];
    if (typeof hostEmbed === "function" && !worker && meter) {
        let chars = 0, calls = 0;
        // A String OBJECT is told by BRAND (`isStringObject`), never by the tag: reading it runs the getter a page can set.
        const textOf = (x: unknown): string | null =>
            typeof x === "string" ? x : x !== null && typeof x === "object" && isStringObject(x) ? String.prototype.valueOf.call(x) : null;
        out.embed = (input: unknown, opts?: unknown): unknown => {
            if (opts !== undefined) throw new Denied("ml.embed with options (a { model }) chooses what runs; in a survey only the configured embedding model does, so it needs approval");
            const many = Array.isArray(input);
            let texts: string[];
            if (many) {
                const arr = input as unknown[];
                const n = Object.getOwnPropertyDescriptor(arr, "length")?.value;
                if (typeof n !== "number" || n > EMBED_CALL_INPUTS) throw new NotInDialect(`ml.embed of more than ${EMBED_CALL_INPUTS.toLocaleString("en-US")} strings in one call, which is too much to embed without asking`);
                texts = [];
                for (let i = 0; i < n; i++) {
                    const t = textOf(Object.getOwnPropertyDescriptor(arr, i)?.value);
                    if (t === null) throw new TypeError(`ml.embed takes a string or an array of strings; item ${i} is not a string`);
                    texts.push(t);
                }
            } else {
                const t = textOf(input);
                if (t === null) throw new TypeError("ml.embed takes a string or an array of strings");
                texts = [t];
            }
            const size = texts.reduce((a, t) => a + t.length, 0);
            if (++calls > EMBED_SURVEY_CALLS) throw new NotInDialect(`more than ${EMBED_SURVEY_CALLS} ml.embed calls in one survey, which is too much to embed without asking; pass an array to embed many strings in one call`);
            if ((chars += size) > EMBED_SURVEY_CHARS) throw new NotInDialect(`ml.embed of over ${EMBED_SURVEY_CHARS.toLocaleString("en-US")} characters in one survey, which is too much to embed without asking`);
            meter?.charge(Math.ceil(size / HOST_SCAN_CHARS_PER_STEP));
            // A fresh array of the copied strings, never the script's own, and no options: the configured model. What
            // it builds (a unit vector a string) is bounded by EMBED_CALL_INPUTS; reading one costs a step an element.
            return (hostEmbed as (i: unknown) => unknown).call(ml, many ? texts : texts[0]);
        };
    }
    // `ml.answer` — the run's curated answer set (a curate-only facade: add/remove/clear/dump/length, built by
    // the CALLER via makeAnswerFacade so this interpreter stays dependency-free + DOM-free). Mutating your OWN
    // user-facing answer is a safe terminating operation (the dialect already builds + mutates script-local
    // arrays/Sets), so it's free here — the FIRST mutating facade member. It grants nothing: the facade exposes
    // no nodes/media, and the page can already call ml.answer from its own console.
    // The answer set holds the PAGE's elements, so it is a page member.
    if (answerFacade && typeof answerFacade === "object" && !worker) out.answer = answerFacade;
    return Object.keys(out).length ? out : null;
}
