/**
 * This principal's keys and what it was paired with, kept in IndexedDB. The private halves are non-extractable
 * CryptoKeys, stored as themselves: IndexedDB keeps a CryptoKey by structured clone, so a key that can sign or agree is
 * never readable as bytes, not even by this code.
 *
 * Three records, each written once and replaced only on purpose:
 * - `self`: the identity and agreement keys. Generated once and kept across pairings, so pairing again (a new hub, a
 *   lost certificate) keeps this principal the same one, and whatever was granted to it stays granted.
 * - `membership`: what pairing handed over (the chain, the account root, the channel key) and where the hub is.
 * - `root`: ONLY on the account's first device, the one that created it: the root identity and the channel key it
 *   hands every device it pairs. No runtime holds it (window-ml-hub `docs/design/end-to-end-crypto.md` decision 4).
 *
 * chrome-free: the extension's pages and worker, the chat page's web build and a phone all use it, each with its own
 * origin's IndexedDB.
 */
import { Certificate } from "../proto/wmlhub/v1/identity.gen";
import { AgreementKey, Bytes, generateAgreementKey } from "./hpke";
import { Identity, generateIdentity } from "./keys";

/** What pairing handed over, and where to use it. */
export interface Membership {
    /** `ws://` or `wss://` */
    hubUrl: string;
    /** the name the hub gave while pairing, which every `Hello` names back */
    hubName: string;
    accountRoot: Bytes;
    /** leaf first, as `PairedWith` carried it */
    chain: Certificate[];
    channelKey: Bytes;
    pairedAtMs: number;
}

/** The account's root, held by the device that created the account and by nothing else. */
export interface AccountRoot {
    identity: Identity;
    channelKey: Bytes;
    createdAtMs: number;
}

/** This principal: its keys, and what it holds once paired (or once it created the account). */
export interface Principal {
    identity: Identity;
    agreement: AgreementKey;
    membership: Membership | null;
    root: AccountRoot | null;
}

const STORE = "k";

/** The keyring in one IndexedDB database. `idb` is injectable so a test runs on `fake-indexeddb`. */
export class Keyring {
    private constructor(private readonly db: IDBDatabase) {}

    static open(name = "ml-hub-keyring", idb: IDBFactory = indexedDB): Promise<Keyring> {
        return new Promise((resolve, reject) => {
            const r = idb.open(name, 1);
            r.onupgradeneeded = () => r.result.createObjectStore(STORE);
            r.onsuccess = () => resolve(new Keyring(r.result));
            r.onerror = () => reject(r.error);
        });
    }

    private get<T>(key: string): Promise<T | null> {
        return new Promise((resolve, reject) => {
            const q = this.db.transaction(STORE).objectStore(STORE).get(key);
            q.onsuccess = () => resolve((q.result as T | undefined) ?? null);
            q.onerror = () => reject(q.error);
        });
    }

    private put(entries: Record<string, unknown>, remove: string[] = []): Promise<void> {
        return new Promise((resolve, reject) => {
            const t = this.db.transaction(STORE, "readwrite");
            const s = t.objectStore(STORE);
            for (const [k, v] of Object.entries(entries)) s.put(v, k);
            for (const k of remove) s.delete(k);
            t.oncomplete = () => resolve();
            t.onerror = () => reject(t.error);
        });
    }

    /** Everything this principal holds, or null before it has keys. */
    async load(): Promise<Principal | null> {
        const self = await this.get<{ identity: Identity; agreement: AgreementKey }>("self");
        if (!self) return null;
        return { ...self, membership: await this.get<Membership>("membership"), root: await this.get<AccountRoot>("root") };
    }

    /** This principal's keys, generated the first time. The same keys from then on, whatever it is paired with. */
    async keys(): Promise<Principal> {
        const had = await this.load();
        if (had) return had;
        // Generated outside the transaction (a transaction commits at the first await), then written only if still
        // absent INSIDE one: two callers racing the first generation end up with ONE pair of keys, the first written.
        const self = { identity: await generateIdentity(), agreement: await generateAgreementKey() };
        await new Promise<void>((resolve, reject) => {
            const t = this.db.transaction(STORE, "readwrite");
            const s = t.objectStore(STORE);
            const q = s.get("self");
            q.onsuccess = () => { if (q.result === undefined) s.put(self, "self"); };
            t.oncomplete = () => resolve();
            t.onerror = () => reject(t.error);
        });
        return (await this.load())!;
    }

    /** Keep what a pairing handed over, replacing any earlier membership. */
    savePaired(membership: Membership): Promise<void> {
        return this.put({ membership });
    }

    /** Keep a newly created account's root and this device's own membership of it, as one write. */
    saveAccount(root: AccountRoot, membership: Membership): Promise<void> {
        return this.put({ root, membership });
    }

    /**
     * Forget the membership (and a root, if this device held one), keeping the keys: leaving an account. Forgetting a
     * root is final, so a caller says so, and the UI says what it costs before it asks.
     */
    leave({ andRoot = false } = {}): Promise<void> {
        return this.put({}, andRoot ? ["membership", "root"] : ["membership"]);
    }

    /** A record kept beside the keys under a name of the caller's (a runtime's device list), or null. */
    record<T>(name: string): Promise<T | null> {
        return this.get<T>(`record:${name}`);
    }

    /** Replace a record kept beside the keys. */
    putRecord(name: string, value: unknown): Promise<void> {
        return this.put({ [`record:${name}`]: value });
    }

    close(): void {
        this.db.close();
    }
}
