// pkg-mirror-db.ts — the package mirror's IndexedDB store, read and opened from any extension realm: the service worker
// writes approved wheels into it (`sw-pkg-mirror.ts`), and the offscreen document reads them back for a run's installs.

// One database, `ml-pkg-mirror`, store `wheels` keyed by sha256; its state is declared once, as `packages.mirror`, in
// sw-pkg-mirror.ts. A read re-checks the bytes against their digest.

const DB_NAME = "ml-pkg-mirror";

const WHEELS = "wheels";

/** One wheel the mirror holds. */
export interface MirrorRow {
    sha256: string;
    name: string;
    version: string;
    filename: string;
    size: number;
    bytes: Blob;
    /** When it was stored (ms). */
    stored: number;
}

/** Settle an IDBRequest as a promise. */
export const done = <T>(req: IDBRequest<T>): Promise<T> => new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });

// state: cache (a handle to the database)
let dbp: Promise<IDBDatabase> | null = null;

/** The mirror's database, or null where there is no IndexedDB (the unit tests' vm realm without a fake). */
function db(): Promise<IDBDatabase> | null {
    if (typeof indexedDB === "undefined") return null;
    dbp ??= new Promise<IDBDatabase>((res, rej) => {
        const req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = () => { req.result.createObjectStore(WHEELS, { keyPath: "sha256" }); };
        req.onsuccess = () => res(req.result);
        req.onerror = () => rej(req.error);
    }).catch((e) => { dbp = null; throw e; });
    return dbp;
}

/** The wheels store in a transaction of its own, or null without IndexedDB. */
export async function wheels(mode: IDBTransactionMode): Promise<IDBObjectStore | null> {
    const d = await db();
    return d ? d.transaction(WHEELS, mode).objectStore(WHEELS) : null;
}

/**
 * The bytes of a held wheel, checked against its digest again as they are read.
 * @param sha256 the digest
 * @returns the bytes, or undefined when the mirror does not hold them or they no longer match
 */
export async function mirroredWheel(sha256: string): Promise<Blob | undefined> {
    const st = await wheels("readonly");
    const row = st ? await done(st.get(sha256)) as MirrorRow | undefined : undefined;
    if (!row || await digest(await row.bytes.arrayBuffer()) !== sha256) return undefined;
    return row.bytes;
}

/** Lowercase hex sha256 of some bytes. */
export async function digest(bytes: ArrayBuffer): Promise<string> {
    return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");
}
