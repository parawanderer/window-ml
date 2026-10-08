// event-cache.ts — WHAT A PHONE HAS ALREADY SEEN OF A SESSION, kept past the app's own lifetime, so reopening a session
// after the OS killed the app replays it from the phone instead of fetching it again over the hub.
//
// This is the SHAPE and the bounds; where it lands is the phone's SQLite archive (mobile/src/archive.ts), reached over
// the bridge (src/native/archive-bridge.ts), which is the same database the extension archives into. It was a JSON
// file per session here, rewritten whole a few hundred milliseconds after every change — the implementation is gone
// and so is that cost, since the archive is appended to and trimmed by deleting rows.
//
// It is a cache in the strict sense: never the truth, only a copy of what the runtime said, reconciled by the rules the
// session contract already has. A session is kept with its feed's position (`FeedSnapshot`), and on a later launch the
// store replays the copy and then SUBSCRIBES FROM THAT POSITION: the runtime sends only what is new, or answers `reset`
// when the history changed while the app was closed, which clears the copy through the store's ordinary reset path.
//
// Bounded, because a phone is not an unbounded archive: past `CACHE_SESSIONS` the least recently active session goes,
// and a session over `CACHE_MAX_BYTES` is TRIMMED to its newest events rather than dropped. It used to be dropped
// whole, on the reasoning that half a session is worse than none — true of a copy that lies about where it starts, and
// not true here, because `earlier` exists to say exactly that. The old rule also inverted what anyone wants: the
// biggest sessions, the ones most annoying to refetch over a hub, were the only ones kept at nothing.
//
// Trimming takes whole events off the OLD end, never anything out of an event. Dropping a screenshot-heavy run's
// images would fit far more of it and would make the copy claim a history it does not have: the transcript would
// replay without the captures and nothing in the format can say they were left behind.
//
// IT IS KEPT IN THE APP'S DOCUMENTS, not its cache directory. History you have already pulled should still be
// readable with no signal, and in the cache directory the OS could take it at any moment — a fine promise for an
// optimisation and the wrong one for something a reader relies on.

import type { MlDebugEvent } from "../contract/contract-debug";
import type { SessionKey, SessionSummary } from "../session/session-host";
import type { FeedSnapshot } from "./session-feed";

/** The largest session kept, serialized. A screenshot-heavy agent run passes it quickly and is refetched instead. */
export const CACHE_MAX_BYTES = 1_500_000;
/** How many sessions are kept; the least recently opened past this goes. */
export const CACHE_SESSIONS = 40;

/** One session as the phone last saw it. `earlier` is where the subscription's history began, when it had more.
 *
 *  It carries the SUMMARY as well as the events, which is what makes the phone's copy the same thing the extension
 *  archives rather than a loose bag of events beside it: an archived session is a summary, a history and the events,
 *  and a copy missing the first two could not be read back by the shared reader or handed to an export without being
 *  rebuilt from somewhere. Absent where the session is not in the index — then there is nothing to list it by, and
 *  the copy is not kept. */
export interface CachedSession {
    v: 1;
    key: SessionKey;
    feed: FeedSnapshot;
    events: { pos?: number; event: MlDebugEvent }[];
    earlier: { from: number } | null;
    truncated: boolean;
    summary?: SessionSummary;
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


