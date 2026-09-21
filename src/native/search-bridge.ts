// search-bridge.ts — SEARCHING EVERY RUNTIME'S HISTORY, for the phone app: the page does the asking, the paging and the
// deciding of who may be asked, and hands the app rows. The web page's search (src/chat/search-page.tsx) as a bridge
// call, so the two find a session the same way rather than the app growing its own rules (docs/spec/NATIVE_SHELL.md).
//
// What the page already holds is answered first, filtered here, so a search says something before any runtime replies;
// past that, each runtime is asked `sessions.search` (or `sessions.list` for an empty query) a page at a time. Rows are
// remembered until the next search, because an ARCHIVED one must be brought back (`session.unarchive`) before it opens,
// and the app knows nothing about archives.

import type { ListedSession, RuntimeId, RuntimeInfo, SessionKey } from "../session-host";
import type { ChatStore } from "../chat/chat-store";
import { mayCommand } from "../chat/grants";
import { matches } from "../chat/search-page";
import type { ToNative, ToWeb } from "./bridge";

/** How many rows a runtime is asked for at a time, as the web page asks. */
const PAGE = 40;

/** One runtime's place in a search: where its next page starts (a `lastTs`, exclusive) and whether it has one. */
interface Cursor { before?: number; more: boolean }

/** What a search knows between pages: what was asked, of whom, who is still answering, and what has been sent. */
interface Search { query: string; runtime?: RuntimeId; cursors: Map<RuntimeId, Cursor>; sent: Set<string> }

/** The rows a search has answered with, for as long as the app can still open one of them. */
export interface SearchMemory { row(key: SessionKey): ListedSession | undefined }

/**
 * The page's side of the app's search. Returns the handler for a `search` message and the memory of what it answered,
 * which `runEmbed` reads to unarchive a session the app asks to open.
 */
export function searchBridge(store: ChatStore, post: (m: ToNative) => void): {
    handle(m: Extract<ToWeb, { type: "search" }>): Promise<void>;
    memory: SearchMemory;
} {
    let current: Search | null = null;
    let id = "";
    let seen = new Map<SessionKey, ListedSession>();

    /** The runtimes worth asking: online, willing to answer this command from this device, and the one asked about. */
    const askable = (query: string, only?: RuntimeId): RuntimeInfo[] =>
        store.runtimes.value.filter((rt) => rt.online && (!only || rt.id === only) && mayCommand(rt, query ? "sessions.search" : "sessions.list"));

    /** What the page already holds, filtered as the web page filters it: an answer before any runtime replies. */
    const held = (query: string, only?: RuntimeId): ListedSession[] => {
        const by = new Map(store.runtimes.value.map((rt) => [rt.id, rt]));
        const q = query.trim().toLowerCase();
        return store.listed()
            .filter((s) => by.has(s.id.runtime) && (!only || s.id.runtime === only) && matches(s, by.get(s.id.runtime), q))
            .sort((a, b) => b.lastTs - a.lastTs);
    };

    /** Send one page of rows, remembering them so an archived one can be opened later. */
    const answer = (rows: ListedSession[], more: boolean, error?: string): void => {
        const fresh = rows.filter((r) => current && !current.sent.has(`${r.id.runtime}:${r.id.hash}`));
        for (const r of fresh) {
            current?.sent.add(`${r.id.runtime}:${r.id.hash}`);
            seen.set(`${r.id.runtime}:${r.id.hash}` as SessionKey, r);
        }
        post({ type: "searchResult", id, rows: fresh, more, ...(error ? { error } : {}) });
    };

    /** Ask every runtime that still has a page for one, and answer with what comes back. */
    const askOnce = async (s: Search): Promise<void> => {
        const asks = [...s.cursors].filter(([, c]) => c.more).map(async ([runtime, c]) => {
            const r = await store.send(s.query
                ? { type: "sessions.search", runtime, query: s.query, before: c.before, limit: PAGE }
                : { type: "sessions.list", runtime, before: c.before, limit: PAGE }, { quiet: true });
            if (s !== current) return [];   // the query changed while this page was on its way
            if (!r.ok) { s.cursors.set(runtime, { ...c, more: false }); return []; }
            const rows = r.data.sessions;
            s.cursors.set(runtime, { before: rows.at(-1)?.lastTs ?? c.before, more: r.data.more && rows.length > 0 });
            return rows;
        });
        const rows = (await Promise.all(asks)).flat().sort((a, b) => b.lastTs - a.lastTs);
        if (s !== current) return;
        answer(rows, [...s.cursors.values()].some((c) => c.more));
    };

    return {
        async handle(m) {
            if (!m.more || !current || current.query !== m.query || current.runtime !== m.runtime) {
                // A new search: forget the last one's rows, so the memory cannot grow for a session nobody is looking at.
                id = m.id;
                seen = new Map();
                current = {
                    query: m.query.trim(), runtime: m.runtime,
                    cursors: new Map(askable(m.query.trim(), m.runtime).map((rt) => [rt.id, { more: true }])), sent: new Set(),
                };
                answer(held(m.query, m.runtime), current.cursors.size > 0);
            } else {
                id = m.id;
            }
            const s = current;
            if (![...s.cursors.values()].some((c) => c.more)) { answer([], false); return; }
            await askOnce(s);
        },
        memory: { row: (key) => seen.get(key) },
    };
}
