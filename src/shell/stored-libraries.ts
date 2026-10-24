// stored-libraries.ts — the tier 3 libraries a person approved for the read-only Python dialect: what a stored entry is and what the store refuses. No `chrome`.

// READONLY_LIBRARY_MANIFEST.md, "The runtime import loop", ruled 2026-10-24: an entry is a SNAPSHOT, the approved bytes
// with the path they were read from and their sha256, so a cell imports exactly what the person saw; a change on disk
// reaches the runtime only through a new proposal. Global scope only (the Python workers are shared and nothing unloads
// a module), workspace scope left. Tier 3 trusts no annotation: the gate judges the library's body as it judges a cell,
// so an entry admits an import and its listed names, never an effect. The storage itself is `src/sw/sw-libraries.ts`.

/** The most bytes a library's source may have: the head `ml.sh` returns whole (`SH_HEAD_BYTES`), stated on the card. */
export const LIBRARY_MAX_BYTES = 65536;

/** Whose word a stored library is: the model's draft the person approved on a card. (The person's own form is (d)'s.) */
export type LibraryOrigin = "proposed";

/** One admitted name of a library and what the card showed for it: a def with its parameters, or a constant. */
export interface LibraryName {
    name: string;
    kind: "def" | "constant";
    /** A def's parameters as written (`xs, start=0`); "" for a constant. */
    signature: string;
}

/** One stored tier 3 library. */
export interface StoredLibrary {
    id: string;
    /** The import name: one identifier. */
    module: string;
    /** Where the source was read from: the realpath the host resolved, and the configured root it was under. */
    path: string;
    root: string;
    /** sha256 of `source` as UTF-8, hex: the host's hash of the file when it was read. */
    sha256: string;
    source: string;
    /** The names a cell may read off the module. */
    names: LibraryName[];
    origin: LibraryOrigin;
    created: number;
}

/** What a caller asks the store to keep: everything but the id and the time, which the store assigns. */
export type LibraryRequest = Omit<StoredLibrary, "id" | "created">;

const SHA256 = /^[0-9a-f]{64}$/;
/** One identifier, not private: what a library's import name and its listed names must be. */
const PLAIN = /^[A-Za-z][A-Za-z0-9_]*$/;
const utf8Bytes = (s: string): number => new TextEncoder().encode(s).length;

/**
 * Why the store refuses to keep `r`, or undefined when it may.
 * @param r the entry asked for
 * @param stored what the store holds now
 */
export function libraryStoreRefusal(r: LibraryRequest, stored: readonly StoredLibrary[]): string | undefined {
    if (typeof r.module !== "string" || !PLAIN.test(r.module)) return "a library's name is one identifier, not starting with _";
    if (stored.some((s) => s.module === r.module)) return `a library named ${r.module} is already stored; remove it first`;
    if (typeof r.path !== "string" || !r.path.startsWith("/") || typeof r.root !== "string" || !r.root.startsWith("/")) return "a library is read from a file under a configured root";
    if (typeof r.sha256 !== "string" || !SHA256.test(r.sha256)) return "a library is pinned by its sha256";
    if (typeof r.source !== "string" || utf8Bytes(r.source) > LIBRARY_MAX_BYTES) return `a library's source is at most ${LIBRARY_MAX_BYTES} bytes`;
    if (!Array.isArray(r.names) || !r.names.length) return "a library lists at least one name a cell may read";
    for (const n of r.names) {
        if (!n || typeof n.name !== "string" || !PLAIN.test(n.name) || (n.kind !== "def" && n.kind !== "constant") || typeof n.signature !== "string") return "each listed name is one identifier, not starting with _";
    }
    if (new Set(r.names.map((n) => n.name)).size !== r.names.length) return "a name is listed twice";
    if (r.origin !== "proposed") return "a library is stored only from an approved proposal";
    return undefined;
}

/**
 * Whether `x`, read back from storage, is a stored library this code can use: anything else is dropped, so a library
 * that no longer validates is never loaded.
 * @param x what storage held
 */
export function validStoredLibrary(x: unknown): x is StoredLibrary {
    const s = x as StoredLibrary | null;
    return !!s && typeof s === "object" && typeof s.id === "string" && typeof s.created === "number" && libraryStoreRefusal(s, []) === undefined;
}
