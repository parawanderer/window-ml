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
 *
 * WITH A VAULT (`Keyring.keepSecretsIn`, the phone app): the secrets live in the platform's keystore instead, and
 * IndexedDB keeps only what is not secret. WebKit cannot store an X25519 CryptoKey in IndexedDB at all (it reads back
 * as nothing), and a phone has a better place for a device key than a WebView's storage anyway. A keystore holds bytes,
 * not CryptoKeys, so this mode keeps each private key as its 32-byte seed and imports it NON-EXTRACTABLE on every load:
 * the seed is readable only by the keyring, between the keystore and `importKey`. The vault's records:
 * - `self`: the identity's seed and public key, and the agreement key's scalar;
 * - `membership`: its channel key (the rest of the membership stays in IndexedDB);
 * - `root`: the root identity's seed and public key, and the channel key (IndexedDB keeps when it was made).
 * A record in IndexedDB whose secrets the vault does not hold is treated as absent.
 */
import { Certificate } from "../proto/wmlhub/v1/identity.gen";
import { AgreementKey, Bytes, generateAgreementKey, importAgreementKey } from "./hpke";
import { Identity, generateIdentity, identityFromSeed } from "./keys";

/**
 * Where a platform keeps secrets outside the page's storage: the iOS Keychain, or Android's Keystore-backed storage,
 * reached over the phone app's bridge. Values are strings; the keyring names the records (`self`, `membership`, `root`).
 */
export interface SecretVault {
    get(name: string): Promise<string | null>;
    set(name: string, value: string): Promise<void>;
    delete(name: string): Promise<void>;
}

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

/** What the vault keeps for `self`. */
interface SelfSecrets { identitySeed: Bytes; identityPublic: Bytes; agreementScalar: Bytes }
/** What the vault keeps for `root`. */
interface RootSecrets { identitySeed: Bytes; identityPublic: Bytes; channelKey: Bytes }

/** The vault every `Keyring.open` uses unless it is given one: null (IndexedDB alone) until an entry point sets it. */
let defaultVault: SecretVault | null = null;
/** One first generation at a time across every keyring on this page, since a vault has no transaction to race inside. */
let generating: Promise<unknown> | null = null;
/** The seeds of roots `Keyring.generateIdentity` made for a vaulted keyring, until `saveAccount` stores them. */
const rootSeeds = new WeakMap<CryptoKey, Bytes>();

/** A vault record as a string: JSON, with every byte string as `{"$b": base64}`. */
function encode(value: unknown): string {
    return JSON.stringify(value, (_k, v: unknown) => (v instanceof Uint8Array ? { $b: btoa(String.fromCharCode(...v)) } : v));
}

/** A vault record back from its string, or null for none (or one this code cannot read). */
function decode<T>(text: string | null): T | null {
    if (text === null) return null;
    try {
        return JSON.parse(text, (_k, v: unknown) => {
            if (v && typeof v === "object" && typeof (v as { $b?: unknown }).$b === "string")
                return Uint8Array.from(atob((v as { $b: string }).$b), (c) => c.charCodeAt(0));
            return v;
        }) as T;
    } catch {
        return null;
    }
}

/**
 * A fresh Ed25519 identity whose seed is known, so a vault can keep it. Generated extractable only long enough to read
 * the seed out of its PKCS#8 form (16 bytes of DER, then the 32-byte seed); the identity returned is re-imported
 * from that seed non-extractable, and the extractable pair is dropped.
 */
async function seededIdentity(): Promise<{ identity: Identity; seed: Bytes }> {
    const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
    const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
    if (pkcs8.length !== 48) throw new Error(`an Ed25519 PKCS#8 key of ${pkcs8.length} bytes, expected 48`);
    const seed = pkcs8.slice(16);
    pkcs8.fill(0);
    const publicKey = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
    return { identity: await identityFromSeed(seed, publicKey), seed };
}

/**
 * The keyring in one IndexedDB database, and a vault when the platform has one. `idb` is injectable so a test runs on
 * `fake-indexeddb`; `vault` defaults to what `keepSecretsIn` set.
 */
export class Keyring {
    private constructor(private readonly db: IDBDatabase, private readonly vault: SecretVault | null) {}

    static open(name = "ml-hub-keyring", idb: IDBFactory = indexedDB, vault: SecretVault | null = defaultVault): Promise<Keyring> {
        return new Promise((resolve, reject) => {
            const r = idb.open(name, 1);
            r.onupgradeneeded = () => r.result.createObjectStore(STORE);
            r.onsuccess = () => resolve(new Keyring(r.result, vault));
            r.onerror = () => reject(r.error);
        });
    }

    /** Keep every keyring's secrets in `vault` from now on: the phone app's page calls this before anything opens one. */
    static keepSecretsIn(vault: SecretVault | null): void {
        defaultVault = vault;
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
        if (this.vault) return this.loadVaulted(this.vault);
        const self = await this.get<{ identity: Identity; agreement: AgreementKey }>("self");
        if (!self) return null;
        return { ...self, membership: await this.get<Membership>("membership"), root: await this.get<AccountRoot>("root") };
    }

    /** This principal's keys, generated the first time. The same keys from then on, whatever it is paired with. */
    async keys(): Promise<Principal> {
        const had = await this.load();
        if (had) return had;
        if (this.vault) return this.generateVaulted(this.vault);
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

    /**
     * A fresh identity for an account's root, made so that THIS keyring can keep it: with a vault, one whose seed is
     * known (held until `saveAccount` stores it); without one, a non-extractable key as ever.
     */
    async generateIdentity(): Promise<Identity> {
        if (!this.vault) return generateIdentity();
        const { identity, seed } = await seededIdentity();
        rootSeeds.set(identity.privateKey, seed);
        return identity;
    }

    /** Keep what a pairing handed over, replacing any earlier membership. */
    async savePaired(membership: Membership): Promise<void> {
        if (!this.vault) return this.put({ membership });
        const { channelKey, ...rest } = membership;
        await this.vault.set("membership", encode({ channelKey }));
        await this.put({ membership: rest });
    }

    /** Keep a newly created account's root and this device's own membership of it, as one write. */
    async saveAccount(root: AccountRoot, membership: Membership): Promise<void> {
        if (!this.vault) return this.put({ root, membership });
        const seed = rootSeeds.get(root.identity.privateKey);
        if (!seed) throw new Error("this root's key cannot be kept here: make it with the keyring's generateIdentity");
        const secrets: RootSecrets = { identitySeed: seed, identityPublic: root.identity.publicKey, channelKey: root.channelKey };
        const { channelKey, ...rest } = membership;
        await this.vault.set("root", encode(secrets));
        await this.vault.set("membership", encode({ channelKey }));
        await this.put({ root: { createdAtMs: root.createdAtMs }, membership: rest });
        rootSeeds.delete(root.identity.privateKey);
    }

    /**
     * Forget the membership (and a root, if this device held one), keeping the keys: leaving an account. Forgetting a
     * root is final, so a caller says so, and the UI says what it costs before it asks.
     */
    async leave({ andRoot = false } = {}): Promise<void> {
        const gone = andRoot ? ["membership", "root"] : ["membership"];
        await this.put({}, gone);
        if (this.vault) for (const name of gone) await this.vault.delete(name);
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

    /** `load` with a vault: the keys imported from their seeds, each record joined with the secrets the vault holds. */
    private async loadVaulted(vault: SecretVault): Promise<Principal | null> {
        const self = decode<SelfSecrets>(await vault.get("self"));
        if (!self) return null;
        const identity = await identityFromSeed(self.identitySeed, self.identityPublic);
        const agreement = await importAgreementKey(self.agreementScalar);
        const m = await this.get<Omit<Membership, "channelKey">>("membership");
        const ms = m && decode<{ channelKey: Bytes }>(await vault.get("membership"));
        const r = await this.get<{ createdAtMs: number }>("root");
        const rs = r && decode<RootSecrets>(await vault.get("root"));
        return {
            identity,
            agreement,
            membership: m && ms ? { ...m, channelKey: ms.channelKey } : null,
            root: r && rs ? {
                identity: await identityFromSeed(rs.identitySeed, rs.identityPublic), channelKey: rs.channelKey, createdAtMs: r.createdAtMs,
            } : null,
        };
    }

    /**
     * `keys` the first time, with a vault. Anything IndexedDB still holds was paired with keys that are gone (a keyring
     * from before the vault, or a keystore wiped under it), so it goes too: a membership nothing can sign for is not one.
     */
    private async generateVaulted(vault: SecretVault): Promise<Principal> {
        while (generating) await generating.catch(() => undefined);
        const run = (async () => {
            if (decode<SelfSecrets>(await vault.get("self"))) return;
            const { identity, seed } = await seededIdentity();
            const agreementScalar = crypto.getRandomValues(new Uint8Array(32));
            await importAgreementKey(agreementScalar); // refused here, before anything is written or deleted
            const secrets: SelfSecrets = { identitySeed: seed, identityPublic: identity.publicKey, agreementScalar };
            await this.put({}, ["self", "membership", "root"]);
            for (const name of ["membership", "root"]) await vault.delete(name);
            await vault.set("self", encode(secrets));
        })();
        generating = run;
        try {
            await run;
        } finally {
            if (generating === run) generating = null;
        }
        return (await this.load())!;
    }
}
