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
// the facade's store reader, so a copy of it (`copyTable`) can read the whole table too: the reader is never a
// property a caller could reach or swap.
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

/** The store reader behind a stored facade; undefined for anything else. For `copyTable` only. */
export function storedReader(x: unknown): unknown {
    return typeof x === "object" && x !== null ? stored.get(x as object) : undefined;
}
