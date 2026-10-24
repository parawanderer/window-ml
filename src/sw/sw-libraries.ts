// sw-libraries.ts — the tier 3 libraries stored for the read-only Python dialect (READONLY_LIBRARY_MANIFEST.md, "The runtime import loop"), global scope only.

// Kept in `chrome.storage.local`, never `sync`: an entry is the approved source itself, up to 64 KiB, read from a file on
// THIS machine. What may be stored is the pure `src/shell/stored-libraries.ts`. Delivered to the Python sandbox with
// every cell run inside the dialect (`sw-python.ts`), which loads each pin once; a page never reaches the store.

import { defineState } from "../state-registry";
import { libraryStoreRefusal, validStoredLibrary, type LibraryRequest, type StoredLibrary } from "../shell/stored-libraries";
import type { DialectLibrary } from "../python/python-dialect-run";

/** The storage key of the stored libraries. */
export const LIBRARIES_KEY = "ml_libraries_global";
/** At most this many libraries: past it, an add is refused rather than an old entry dropped. */
export const LIBRARIES_MAX = 50;

const libraries: StoredLibrary[] = [];

defineState({
    id: "libraries.global", scope: "browser", realm: "worker", audience: "human", lostOn: [],
    describe: "Pure-Python libraries the person approved for the read-only Python dialect, each the approved source pinned by its sha256: what a cell inside the dialect may import besides the shipped modules. An import, never a permission: the gate judges the library's body as it judges a cell.",
    read: () => (libraries.length ? libraries.map((s) => ({ ...s })) : undefined),
});

/** Storage has been read. A change waits for it, so an add made before the read is not overwritten by it. */
export const librariesReady: Promise<void> = (() => {
    try {
        return chrome.storage.local.get([LIBRARIES_KEY]).then((got) => {
            const l = got?.[LIBRARIES_KEY];
            libraries.splice(0, libraries.length, ...(Array.isArray(l) ? l.filter(validStoredLibrary) : []));
        }).catch(() => { /* storage unavailable: no library is importable, so a cell that imports one asks */ });
    } catch { return Promise.resolve(); }   // no storage (a test harness)
})();

function save(): void {
    try { void chrome.storage.local.set({ [LIBRARIES_KEY]: libraries }).catch(() => {}); } catch { /* storage unavailable */ }
}

let seq = 0;   // state: plumbing — makes ids unique within one worker; the time prefix covers the rest
const newId = (): string => `lib-${Date.now().toString(36)}-${(seq++).toString(36)}`;

/** Every stored library, as copies. */
export function storedLibraries(): StoredLibrary[] {
    return libraries.map((s) => ({ ...s, names: s.names.map((n) => ({ ...n })) }));
}

/** The stored libraries as the sandbox loads them, once storage has been read. */
export async function dialectLibraries(): Promise<DialectLibrary[]> {
    await librariesReady;
    return libraries.map((s) => ({ name: s.module, source: s.source, sha256: s.sha256, names: s.names.map((n) => n.name) }));
}

/**
 * Store a library, once storage has been read; refused with the reason when the store may not keep it.
 * @param r the entry
 * @returns the stored entry, or why not
 */
export async function addLibrary(r: LibraryRequest): Promise<StoredLibrary | { refused: string }> {
    await librariesReady;
    const why = libraryStoreRefusal(r, libraries);
    if (why) return { refused: why };
    if (libraries.length >= LIBRARIES_MAX) return { refused: `${LIBRARIES_MAX} libraries are already stored` };
    const entry: StoredLibrary = { id: newId(), module: r.module, path: r.path, root: r.root, sha256: r.sha256, source: r.source, names: r.names.map((n) => ({ ...n })), origin: r.origin, created: Date.now() };
    libraries.push(entry);
    save();
    return { ...entry };
}

/**
 * Remove a stored library by id, once storage has been read. A module once loaded stays in the sandboxes that loaded
 * it until they restart (the ruling's corollary: the registration page restarts them).
 * @param id the entry's id
 * @returns whether there was one
 */
export async function removeLibrary(id: string): Promise<boolean> {
    await librariesReady;
    const i = libraries.findIndex((s) => s.id === id);
    if (i < 0) return false;
    libraries.splice(i, 1);
    save();
    return true;
}
