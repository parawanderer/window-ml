// archive-bridge.ts — THE PAGE'S COPY OF A SESSION, kept in the app's SQLite archive rather than in the WebView.
//
// The same job `event-cache.ts` describes and the same `EventCache` the store takes; what changes is where it lands.
// The app writes it into the database the extension archives into (mobile/src/archive.ts over src/archive/db.ts), so
// the phone's offline history and an archived session are one format rather than two that agree until someone looks.
//
// WHY THIS IS NOT THE PLAIN STORE (store-bridge.ts). That store writes whole values by name, so keeping a session in
// it meant re-serialising and re-sending the entire history a few hundred milliseconds after every change — for a
// long session, megabytes, repeatedly, for the sake of a few new events. Moving it to SQLite only helps if the SAVE
// is incremental too: otherwise the cost of rewriting the file is just moved onto the bridge. So the app reports the
// highest history position it holds, and the next save carries only what is past it.

import type { CachedSession, EventCache } from "../chat/event-cache";
import type { SessionKey } from "../session-host";
import type { ToNative, ToWeb } from "./bridge";

type Result = Extract<ToWeb, { type: "archiveResult" }>;

/**
 * An `EventCache` over the bridge. `settle` takes each `archiveResult` the app sends back.
 *
 * A request the app does not answer in `timeoutMs` fails rather than leaving the page waiting on its own
 * bookkeeping — and a failed save leaves the high-water mark alone, so the next one re-sends what did not land
 * instead of skipping it.
 */
export function bridgeArchive(post: (m: ToNative) => void, timeoutMs = 15_000): { cache: EventCache; settle(m: Result): void } {
    const pending = new Map<string, (m: Result) => void>();
    /** The highest history position the APP has confirmed holding, per session: what a save sends past. */
    const held = new Map<SessionKey, number>();
    let n = 0;

    const ask = (op: "load" | "save" | "drop" | "clear", key?: SessionKey, session?: CachedSession) =>
        new Promise<Result>((resolve, reject) => {
            const id = `a${++n}`;
            const timer = setTimeout(() => { pending.delete(id); reject(new Error("the app's archive did not answer")); }, timeoutMs);
            pending.set(id, (m) => {
                clearTimeout(timer);
                if (m.ok) resolve(m);
                else reject(new Error(m.error ?? "the app's archive refused"));
            });
            post({ type: "archive", id, op, ...(key ? { key } : {}), ...(session ? { session } : {}) });
        });

    return {
        cache: {
            async load(key) {
                const r = await ask("load", key);
                const s = (r.session ?? null) as CachedSession | null;
                // What came back is what the app holds, so the next save starts from there rather than from nothing.
                if (s) held.set(key, s.events.reduce((hi, e) => (typeof e.pos === "number" && e.pos > hi ? e.pos : hi), -1));
                else held.delete(key);
                return s;
            },
            async save(session) {
                const since = held.get(session.key) ?? -1;
                const fresh = session.events.filter((e) => typeof e.pos === "number" && e.pos > since);
                // Nothing new and nothing else to say: the summary and the feed position still have to go, because a
                // reconnect resumes from the feed and a renamed session has to be listed under its new title.
                const r = await ask("save", session.key, { ...session, events: fresh });
                if (typeof r.held === "number") held.set(session.key, r.held);
            },
            async drop(key) { held.delete(key); await ask("drop", key); },
            async clear() { held.clear(); await ask("clear"); },
        },
        settle(m) {
            const r = pending.get(m.id);
            pending.delete(m.id);
            r?.(m);
        },
    };
}
