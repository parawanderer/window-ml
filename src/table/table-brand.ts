// IS THIS ONE OF OUR TABLE FACADES? A WeakSet, in a module of its own, imported by both the thing that
// mints facades (table-data.ts) and the thing that has to recognise them (readonly-exec.ts).
//
// Two reasons it is not a property, a symbol or a `instanceof`:
//
//   · A PAGE MUST NOT BE ABLE TO FORGE ONE. The read-only dialect decides what a value may be asked to do by
//     what it IS, and a table's `select` is the reason that matters: on a table it picks columns, on an
//     `<input>` it changes the page's text selection. A brand a page could copy — a property, or even
//     `Symbol.for("ml.table")`, which any script can look up — would let a hostile page mark an input as a
//     table and wait for a survey to call `select()` on it. Membership in a WeakSet held in module scope
//     cannot be claimed from outside; it can only be granted here.
//   · `instanceof` is realm-bound, and the dialect can hold a value from an iframe's realm.
//
// Its own module because readonly-exec.ts is deliberately dependency-free and DOM-free — importing
// table-data.ts for this one check would pull a CSV parser into the interpreter.
const facades = new WeakSet<object>();

/** Mark a value as a table facade. Called only by `asTable`. */
export function brandTable<T extends object>(t: T): T {
    facades.add(t);
    return t;
}

/** Is this one of ours? False for anything that merely LOOKS like a table — which is the point. */
export function isTable(x: unknown): boolean {
    return typeof x === "object" && x !== null && facades.has(x as object);
}

// A STORED table: a facade over a preview whose whole table is in the value store, so its `col`/`select`/`records` read
// every row (a request) rather than the rows in hand. The dialect sizes that work by the table's `shape`, not by
// `rows.length`, which is how it tells the two apart; granted only by `asTable`, like the brand above. The map holds
// the facade's store reader, which its views (`select`, a long `head`) are made with: the reader is never a property a
// caller could reach or swap. A copy does not keep it (`brandCut` below).
const stored = new WeakMap<object, unknown>();

/** Mark a table facade as stored, with the reader its whole-table reads go through. Called only by `asTable`. */
export function brandStored<T extends object>(t: T, reader: unknown): T {
    stored.set(t, reader);
    return t;
}

/** Is this a facade whose reads go to the value store? */
export function isStoredTable(x: unknown): boolean {
    return typeof x === "object" && x !== null && stored.has(x as object);
}

/** The store reader behind a stored facade; undefined for anything else. For `freezeTable` and `ml.table` only. */
export function storedReader(x: unknown): unknown {
    return typeof x === "object" && x !== null ? stored.get(x as object) : undefined;
}

// A READ-ONLY table (ruling 57, as amended 2026-11-20): what `ml.table` hands out, frozen at every level instead of
// copied. The set holds the facade and each array or record it is made of (`rows`, every row, `columns`, `shape`,
// `dtypes`), so the dialect can refuse a write to any of them with the way out, and so freezing the same stored
// value twice costs nothing the second time.
const frozenParts = new WeakSet<object>();   // state: plumbing

/** Record a part of a read-only table. Called only by `asTable`. */
export function markFrozenPart(x: object): void {
    frozenParts.add(x);
}

/** Is this a read-only table, or an array or record one is made of? */
export function isFrozenTablePart(x: unknown): boolean {
    return typeof x === "object" && x !== null && frozenParts.has(x as object);
}

/** What a write to a read-only table is told: the facade's traps and the dialect both say it, so a model reads one sentence. */
export const READ_ONLY_TABLE = "This table is read-only; call .copy() for one you can edit";

// An EDITABLE table: `t.copy()` and what its own `select`/`head` return. Its arrays belong to nobody else, so the
// dialect lets a script write to them; any other table may share its rows with a store, a cache or its parent.
const editable = new WeakSet<object>();   // state: plumbing

/** Mark a table facade as the caller's own copy. Called only by `asTable`. */
export function brandEditable<T extends object>(t: T): T {
    editable.add(t);
    return t;
}

/** Is this a table whose arrays are the caller's alone? */
export function isEditableTable(x: unknown): boolean {
    return typeof x === "object" && x !== null && editable.has(x as object);
}

// A CUT copy: `t.copy()` of a stored table, and what its own `select`/`head` return (docs/spec/ML_TABLE.md, "Views of a
// stored table in JS"). It holds the rows in hand and no reader, so a whole read past them (`col`, `records`) is refused
// with the source's spelling instead of answering the sample. Kept so a copy of the copy is cut too.
const cut = new WeakSet<object>();   // state: plumbing

/** Mark a table facade as a copy cut from a stored table. Called only by `asTable`. */
export function brandCut<T extends object>(t: T): T {
    cut.add(t);
    return t;
}

/** Is this a copy of a stored table, which holds only the rows it was cut with? */
export function isCutTable(x: unknown): boolean {
    return typeof x === "object" && x !== null && cut.has(x as object);
}
