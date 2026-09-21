// event-cache.ts — WHAT A PHONE HAS ALREADY SEEN OF A SESSION, kept past the app's own lifetime, so reopening a session
// after the OS killed the app replays it from the phone instead of fetching it again over the hub.
//
// It is a cache in the strict sense: never the truth, only a copy of what the runtime said, reconciled by the rules the
// session contract already has. A session is kept with its feed's position (`FeedSnapshot`), and on a later launch the
// store replays the copy and then SUBSCRIBES FROM THAT POSITION: the runtime sends only what is new, or answers `reset`
// when the history changed while the app was closed, which clears the copy through the store's ordinary reset path.
//
// Bounded, because a phone is not an archive: a session larger than `CACHE_MAX_BYTES` is not kept at all (half a
// session would be worse than none), and past `CACHE_SESSIONS` the least recently opened goes. The app keeps it in its
// CACHE directory, not its documents: out of backups, and the OS may purge it, which is exactly what a cache promises.

import type { MlDebugEvent } from "../contract-debug";
import type { SessionKey } from "../session-host";
import type { PlainStore } from "../native/store-bridge";
import type { FeedSnapshot } from "./session-feed";

/** The largest session kept, serialized. A screenshot-heavy agent run passes it quickly and is refetched instead. */
export const CACHE_MAX_BYTES = 1_500_000;
/** How many sessions are kept; the least recently opened past this goes. */
export const CACHE_SESSIONS = 40;

/** One session as the phone last saw it. `earlier` is where the subscription's history began, when it had more. */
export interface CachedSession {
    v: 1;
    key: SessionKey;
    feed: FeedSnapshot;
    events: { pos?: number; event: MlDebugEvent }[];
    earlier: { from: number } | null;
    truncated: boolean;
}

/** Where a store keeps what it has seen. The phone's page gives one to its `ChatStore`; the web page does not. */
export interface EventCache {
    load(key: SessionKey): Promise<CachedSession | null>;
    /** Keep a session, or drop it if it is too large to keep whole. */
    save(session: CachedSession): Promise<void>;
    drop(key: SessionKey): Promise<void>;
    /** Forget everything: a device that joins or leaves an account has no business replaying the last one's sessions. */
    clear(): Promise<void>;
}

/** A session key as a store name: `ev:` and a short hash, since a runtime id can be longer than a name may be. */
function nameFor(key: SessionKey): string {
    // FNV-1a over the key, twice with different seeds for 16 hex digits. A collision is caught on load: the record
    // carries its own key, and a mismatch reads as nothing cached.
    let a = 0x811c9dc5, b = 0x01000193 ^ 0x5bd1e995;
    for (let i = 0; i < key.length; i++) {
        const c = key.charCodeAt(i);
        a = Math.imul(a ^ c, 0x01000193) >>> 0;
        b = Math.imul(b ^ c, 0x01000193 ^ 0x2f) >>> 0;
    }
    return `ev:${a.toString(16).padStart(8, "0")}${b.toString(16).padStart(8, "0")}`;
}

/** The record listing what is kept, most recently opened last, for eviction. */
const INDEX = "ev-index";

/** An `EventCache` over the app's plain store (store-bridge.ts). */
export function storeCache(store: PlainStore): EventCache {
    const readIndex = async (): Promise<SessionKey[]> => {
        try { return JSON.parse((await store.get(INDEX)) ?? "[]") as SessionKey[]; } catch { return []; }
    };
    const writeIndex = (keys: SessionKey[]): Promise<void> => store.set(INDEX, JSON.stringify(keys));
    return {
        async load(key) {
            const raw = await store.get(nameFor(key));
            if (!raw) return null;
            try {
                const c = JSON.parse(raw) as CachedSession;
                return c.v === 1 && c.key === key ? c : null;
            } catch {
                return null;
            }
        },
        async save(session) {
            const raw = JSON.stringify(session);
            const keys = (await readIndex()).filter((k) => k !== session.key);
            // Too large to keep whole: keep none of it, and forget any older copy, which would now be stale.
            if (raw.length > CACHE_MAX_BYTES) {
                await store.delete(nameFor(session.key));
                await writeIndex(keys);
                return;
            }
            await store.set(nameFor(session.key), raw);
            keys.push(session.key);
            while (keys.length > CACHE_SESSIONS) await store.delete(nameFor(keys.shift()!));
            await writeIndex(keys);
        },
        async drop(key) {
            await store.delete(nameFor(key));
            await writeIndex((await readIndex()).filter((k) => k !== key));
        },
        async clear() {
            for (const k of await readIndex()) await store.delete(nameFor(k));
            await store.delete(INDEX);
        },
    };
}
