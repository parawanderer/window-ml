// policy.ts — what a read-only survey may read, call, build and write: the denied properties, the per-kind method
// allowlist, the callable roots and safe constructors, and the `ml` facade the dialect sees.

import { isTable } from "../table/table-brand";   // a table facade is recognised by BRAND, and the brand module is itself dependency-free
import { Denied, riskyRegex, PIPE_CHARS_PER_STEP, MAX_STRING, NotInDialect, NeedsPage } from "./limits";

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
export const isDomCollection = (x: any): boolean =>
    x != null && typeof x === "object" && !Array.isArray(x) && !isTable(x) && typeof x.length === "number" && typeof x.item === "function";

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
    | "element" | "document" | "collection" | "style" | "console" | "table"
    | "Math" | "JSON" | "ObjectCtor" | "ArrayCtor" | "PromiseCtor" | "DateCtor";

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
    // CSSStyleDeclaration (getComputedStyle) — pure readers. Named property reads (`.color`) go through
    // readMember. No setProperty/removeProperty: mutation, and they throw on a computed style anyway.
    style: ["getPropertyValue", "getPropertyPriority", "item"],
    console: ["log", "info", "warn", "error", "debug"],
    // A fetched or dereferenced TABLE (table-data.ts's facade). These four names are the reason the gate is
    // scoped at all: `select` picks columns here and CHANGES THE PAGE'S TEXT SELECTION on an `<input>`, so it
    // could never have joined a flat list. Each returns plain data or another facade, reads nothing outside
    // the table, and mutates nothing — the facade itself refuses writes.
    table: ["col", "select", "records", "head"],
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
};

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
export function kindOf(obj: unknown): MethodKind | null {
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
        return null;
    }
    if (obj === (JSON as unknown)) return "JSON";
    if (obj === (Math as unknown)) return "Math";
    if (typeof obj !== "object") return null;
    // BY IDENTITY, before anything structural: a table facade is a Proxy that THROWS on an unknown key, so
    // shape-testing it would trip its own guard — and a page must not be able to CLAIM the kind, which a
    // property or a well-known symbol would allow (see table-brand.ts). Only `asTable` grants membership.
    if (isTable(obj)) return "table";
    const o = obj as Record<string, unknown>;
    // A String OBJECT, not a primitive: `ml.dereference` returns a String subclass (DerefText) so a pointer
    // read is usable as the string it is. It must get the string methods, or the wrapper silently costs the
    // caller `.split`/`.startsWith`.
    if (Object.prototype.toString.call(o) === "[object String]") return "string";
    // Set / Map, told apart by their own brand rather than by prototype identity: calling the getter on a
    // foreign object throws, which is the check. (`size` is an accessor on Set.prototype/Map.prototype.)
    if (isSet(o)) return "set";
    if (isMap(o)) return "map";
    if (typeof (o as { then?: unknown }).then === "function") return "promise";
    // By BRAND, not by `toString` tag: a page object can claim `Symbol.toStringTag = "Date"`, and since a date now has
    // methods, a claimed one would have its OWN `getTime` called. The borrowed getter throws on anything without a
    // Date's internal slot, across realms too.
    if (isDate(o)) return "date";
    if (Object.prototype.toString.call(o) === "[object RegExp]") return "regexp";
    // A DOCUMENT before an element: it answers `getElementById`, which an element does not.
    if (typeof (o as { createElement?: unknown }).createElement === "function" && typeof (o as { getElementById?: unknown }).getElementById === "function") return "document";
    if (typeof (o as { nodeType?: unknown }).nodeType === "number") return "element";
    if (typeof (o as { getPropertyValue?: unknown }).getPropertyValue === "function") return "style";
    if (isDomCollection(o)) return "collection";
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

const isSet = brandCheck(Set.prototype, "size");

const isMap = brandCheck(Map.prototype, "size");

/** Is this a real Date, from any realm? Its own getter cannot be faked: `Date.prototype.getTime` throws on anything
 *  else, whatever it claims to be. */
const isDate = (o: object): boolean => { try { Date.prototype.getTime.call(o); return true; } catch { return false; } };

/** May `key` be CALLED on `obj`? The whole method gate, in one place: the receiver's kind decides, an
 *  unrecognised receiver gets nothing, and "*" holds only what is harmless everywhere. */
export function methodAllowed(obj: unknown, key: string): boolean {
    if (ANY_KIND.has(key)) return true;
    const kind = kindOf(obj);
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
 *  DOM, where the run's own context can be read without it ever entering the page (docs/spec/CURRENT_CONTEXT.md). */
export type ReadonlyRealm = "page" | "worker";

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
                onPattern: (src: string) => {
                    const why = riskyRegex(src);
                    if (why) throw new Denied(`ml.jsonPath: the pattern ${JSON.stringify(src)} has ${why}, which can run for hours on one value — it needs approval`);
                },
            });
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
