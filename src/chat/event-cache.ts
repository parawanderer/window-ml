// event-cache.ts — WHAT A PHONE HAS ALREADY SEEN OF A SESSION, kept past the app's own lifetime, so reopening a session
// after the OS killed the app replays it from the phone instead of fetching it again over the hub.
//
// It is a cache in the strict sense: never the truth, only a copy of what the runtime said, reconciled by the rules the
// session contract already has. A session is kept with its feed's position (`FeedSnapshot`), and on a later launch the
// store replays the copy and then SUBSCRIBES FROM THAT POSITION: the runtime sends only what is new, or answers `reset`
// when the history changed while the app was closed, which clears the copy through the store's ordinary reset path.
//
// Bounded, because a phone is not an archive: past `CACHE_SESSIONS` the least recently opened goes, and a session over
// `CACHE_MAX_BYTES` is TRIMMED to its newest events rather than dropped. It used to be dropped whole, on the reasoning
// that half a session is worse than none — which is true of a copy that lies about where it starts, and not true here,
// because `earlier.from` exists to say exactly that. The old rule also inverted what anyone wants: the biggest
// sessions, the ones most annoying to refetch over a hub, were the only ones kept at nothing.
//
// Trimming takes whole events off the OLD end, never anything out of an event. Dropping the images from a
// screenshot-heavy run would fit far more of it, and would also make the copy claim a history it does not have: the
// transcript would replay without the captures and nothing in the format can say they were left behind. A smaller
// honest copy beats a larger one that misrepresents itself.
//
// IT IS KEPT IN THE APP'S DOCUMENTS, not its cache directory. History you have already pulled should still be
// readable with no signal, and in the cache directory the OS could take it at any moment — which is a fine promise
// for an optimisation and the wrong one for something a reader relies on. It is still a cache in the sense that
// matters (never the truth, only a copy the runtime can invalidate by epoch); what changed is that it is no longer
// allowed to vanish on its own. The bounds above are what make that affordable: this is an archive with a ceiling,
// not a folder that grows until the phone is full.

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

/** The serialized size of a copy, which is what the cap is about. */
const sizeOf = (c: CachedSession): number => JSON.stringify(c).length;

/** The newest `k` events of a copy, with `earlier` moved to say where they now begin, or null when the oldest one
 *  kept cannot say its own position — a copy that cannot state where it starts is the one that would lie. */
function newest(session: CachedSession, k: number): CachedSession | null {
    if (k >= session.events.length) return session;
    const events = session.events.slice(session.events.length - k);
    const from = events[0]?.pos;
    return from === undefined ? null : { ...session, events, earlier: { from } };
}

/**
 * A copy that fits under `cap`, trimmed from the OLD end, or null when none can be kept honestly.
 *
 * Trimming the old end is what makes this safe: `feed` is the SUBSCRIPTION's position, at the new end, so dropping
 * older events leaves it exactly as true as it was — the next launch still replays this copy and subscribes from
 * where it left off. What changes is `earlier.from`, which is the field whose whole job is to say that history
 * continues before what is held.
 */
export function trimToCap(session: CachedSession, cap: number): CachedSession | null {
    if (sizeOf(session) <= cap) return session;
    // The most events that FIT (monotonic in k, so a binary search is sound)…
    let lo = 1, hi = session.events.length, fits = 0;
    while (lo <= hi) {
        const k = (lo + hi) >> 1;
        const cand = newest(session, k);
        if (cand && sizeOf(cand) <= cap) { fits = k; lo = k + 1; }
        else if (!cand) { lo = k + 1; }      // this k cannot state its start; a larger one may
        else { hi = k - 1; }
    }
    // …then back off until the oldest kept event can say where it sits. Fewer events is always smaller, so this
    // cannot push it back over the cap.
    for (let k = fits; k > 0; k--) {
        const cand = newest(session, k);
        if (cand && sizeOf(cand) <= cap) return cand;
    }
    return null;
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
            const keep = trimToCap(session, CACHE_MAX_BYTES);
            const keys = (await readIndex()).filter((k) => k !== session.key);
            // Nothing of it can be kept honestly (one event is itself over the cap, or the oldest that would fit
            // cannot say where it sits): forget any older copy too, which would now be stale.
            if (!keep) {
                await store.delete(nameFor(session.key));
                await writeIndex(keys);
                return;
            }
            await store.set(nameFor(session.key), JSON.stringify(keep));
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
