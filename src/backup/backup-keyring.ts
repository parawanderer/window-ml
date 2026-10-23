// backup-keyring.ts — where this install's backup data key is kept at rest, and the passphrase and recovery key set-up around it.

/**
 * The format module (`backup-format.ts`) makes a data key and wraps it; this keeps the result between sessions. The
 * record is one IndexedDB entry in the extension's origin: the data key as the NON-EXTRACTABLE `CryptoKey` it was imported
 * as (IndexedDB stores a `CryptoKey` structurally, so no byte of the key is ever in the profile), and the two wrapped
 * copies a file header needs. Anything running in the extension's origin can USE the key (the service worker, the
 * offscreen archive worker, a page); nothing can read it back out, and a new passphrase needs the old passphrase or the
 * recovery key to unwrap it (`changePassphrase`).
 *
 * State: one persistent store, `ml-backup-keyring` (docs/dev/state.md, "Where a value can live"). Not a run's state, so
 * not declared to the state registry; the module keeps nothing in memory.
 */
import { BackupError, createKeyring, rewrap, unlock, type Keyring, type KeyringOptions, type Secret } from "./backup-format";

/** The IndexedDB database, its one object store and the one record in it. */
const DB_NAME = "ml-backup-keyring";
const STORE = "k";
const RECORD = "ring";

/** The persistence the keyring needs, so a test (and the phone, one day) can bring its own. */
export interface KeyringStore {
    /** the stored keyring, or null before setup */
    read(): Promise<Keyring | null>;
    /** store the first keyring; refuses (rejects) when one is already there, so two contexts racing a set-up cannot both win */
    create(ring: Keyring): Promise<void>;
    /** replace the keyring with one carrying the same data key (a new passphrase wrap) */
    replace(ring: Keyring): Promise<void>;
}

/**
 * The keyring in this origin's IndexedDB.
 * @param idb the factory; defaults to the global one
 */
export function idbKeyringStore(idb?: IDBFactory): KeyringStore {
    let opened: Promise<IDBDatabase> | null = null;   // state: plumbing — the open connection, reopened when a caller finds it closed
    const open = (): Promise<IDBDatabase> => (opened ??= new Promise((resolve, reject) => {
        const r = (idb ?? indexedDB).open(DB_NAME, 1);
        r.onupgradeneeded = () => r.result.createObjectStore(STORE);
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => { opened = null; reject(r.error); };
    }));
    const run = async <T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> => {
        const db = await open();
        return new Promise<T>((resolve, reject) => {
            const tx = db.transaction(STORE, mode);
            const req = fn(tx.objectStore(STORE));
            tx.oncomplete = () => resolve(req.result);
            tx.onerror = () => reject(req.error ?? tx.error);
            tx.onabort = () => reject(req.error ?? tx.error);
        });
    };
    return {
        async read() { return ((await run("readonly", (s) => s.get(RECORD))) as Keyring | undefined) ?? null; },
        async create(ring) {
            try { await run("readwrite", (s) => s.add(ring, RECORD)); }
            catch (e) {
                if ((e as DOMException)?.name === "ConstraintError") throw new Error("a backup passphrase is already set up on this install");
                throw e;
            }
        },
        async replace(ring) { await run("readwrite", (s) => s.put(ring, RECORD)); },
    };
}

/** What the person is shown after set-up: the recovery key, once, as groups to copy, print or type back. */
export interface RecoveryDisplay {
    /** the key with its dashes: `K7QF-2MXR-…` */
    recoveryKey: string;
    /** the same, one group per entry, for the screen that asks for one group to be typed back */
    groups: string[];
}

/**
 * Whether this install has a backup data key, and which (`keyId` is the public name of the data key, not secret).
 * @param store the keyring store
 */
export async function keyringState(store: KeyringStore): Promise<{ set: false } | { set: true; keyId: string }> {
    const ring = await store.read();
    return ring ? { set: true, keyId: ring.keyId } : { set: false };
}

/**
 * Set up backup encryption: a random data key wrapped under the passphrase and under a new recovery key, stored. The
 * recovery key is returned HERE and nowhere else; the caller shows it once and drops it.
 * @param store the keyring store
 * @param passphrase the passphrase the person chose
 * @param o Argon2 cost override (tests only)
 * @throws when a passphrase is already set up, or the passphrase is empty
 */
export async function setupKeyring(store: KeyringStore, passphrase: string, o: KeyringOptions = {}): Promise<RecoveryDisplay & { keyId: string }> {
    const { keyring, recoveryKey } = await createKeyring(passphrase, o);
    await store.create(keyring);
    return { keyId: keyring.keyId, recoveryKey, groups: recoveryKey.split("-") };
}

/**
 * The stored keyring, to encrypt with. Asks for no secret: the data key is usable (not readable) by design, which is what
 * lets the folder write without prompting. Null before set-up.
 * @param store the keyring store
 */
export async function loadKeyring(store: KeyringStore): Promise<Keyring | null> {
    return store.read();
}

/**
 * Check a passphrase or recovery key against the stored wraps without changing anything.
 * @returns true when it opens the keyring; false for a wrong secret
 * @throws a `BackupError` for a malformed recovery key, or when nothing is set up
 */
export async function checkSecret(store: KeyringStore, secret: Secret): Promise<boolean> {
    const ring = await store.read();
    if (!ring) throw new BackupError("needs-key", "no backup passphrase is set up on this install");
    try { await unlock(ring.wraps, secret); return true; }
    catch (e) { if (e instanceof BackupError && e.reason === "wrong-secret") return false; throw e; }
}

/**
 * Change the passphrase. The old passphrase or the recovery key opens the data key; the passphrase wrap is replaced; the
 * recovery wrap and the data key itself are unchanged, so every file already written still opens with the recovery key
 * and with the OLD passphrase (its header carries the old wrap), and new files carry the new one.
 * @throws `wrong-secret` when `oldSecret` does not open the keyring
 */
export async function changePassphrase(store: KeyringStore, oldSecret: Secret, newPassphrase: string, o: KeyringOptions = {}): Promise<void> {
    const ring = await store.read();
    if (!ring) throw new BackupError("needs-key", "no backup passphrase is set up on this install");
    const wraps = await rewrap(ring.wraps, oldSecret, newPassphrase, o);
    await store.replace({ key: ring.key, keyId: ring.keyId, wraps });
}
