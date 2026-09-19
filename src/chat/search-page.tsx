// search-page.tsx — EVERY SESSION, in the main pane: a search box, then the whole history newest first with each
// session's date at the right, drawn a page at a time as it scrolls. Gemini's search view, and the one place this page
// shows history: the list beside it is for what is recent, pinned or still running.
//
// It replaced two things that each did half of this — a filter that slid open over the list, and an "older sessions"
// view that slid in beside it — because two ways to find a session is one more than anyone can remember.
//
// PAST THE LIST. What the page already holds (the index snapshot) is drawn first; past it, each runtime is asked for
// more with `sessions.list` (live and archived merged, newest first), a page at a time as the end scrolls into view.
// Typing asks each runtime `sessions.search` too, which reads every word an ARCHIVED session holds and answers with a
// snippet; the snapshot is still filtered here, so a runtime without search still finds by title. An archived row is
// marked, and opening it sends `session.unarchive` first, which brings it back into the live store.
import { useEffect, useRef, useState } from "preact/hooks";
import type { ListedSession, RuntimeId, RuntimeInfo, SessionSummary } from "../session-host";
import { IconBack, IconSearch } from "../sidebar/icons";
import { truncate } from "../sidebar/format";
import { view } from "../sidebar/store";
import type { ChatStore } from "./chat-store";
import { mayCommand } from "./grants";
import { mainView, useEscapeCloses } from "./nav";

/** How many sessions are drawn at a time; scrolling to the end of them draws the next page. */
const PAGE = 40;

/** Does a session answer to what was typed? Matched against everything a person would use to name one out loud: its
 *  title, the task it was given, the page it is on, and the runtime it is running on. */
export function matches(s: SessionSummary, rt: RuntimeInfo | undefined, q: string): boolean {
    if (!q) return true;
    return [s.title, s.task, s.page?.url, s.page?.title, rt?.name].some((v) => !!v && v.toLowerCase().includes(q));
}

/** A session's date the way a list of them wants it: the time for today, the day this year, the year otherwise. */
export function shortDate(ts: number, now = Date.now()): string {
    const d = new Date(ts), n = new Date(now);
    if (d.toDateString() === n.toDateString()) return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
    return d.toLocaleDateString(undefined, d.getFullYear() === n.getFullYear() ? { day: "numeric", month: "short" } : { day: "numeric", month: "short", year: "numeric" });
}

/** A search snippet as text, with the runtime's «guillemet»-marked match picked out. Never markup: it is the session's
 *  own words, which may hold anything. */
export function Snippet({ text }: { text: string }) {
    const parts = text.split(/«|»/);
    return <span class="chat-search-snip">{parts.map((p, i) => (i % 2 ? <mark key={i}>{p}</mark> : p))}</span>;
}

/** One runtime's paging state: where the next page starts (a `lastTs`, exclusive), whether there is one, and whether
 *  it has been asked for. */
interface Cursor { before?: number; more: boolean; loading: boolean }

/** The search page. `narrow` gives it a back arrow, since on a phone it is a screen of its own. */
export function SearchPage({ store, narrow }: { store: ChatStore; narrow: boolean }) {
    const [query, setQuery] = useState("");
    const [shown, setShown] = useState(PAGE);
    const box = useRef<HTMLInputElement>(null);
    const sentinel = useRef<HTMLDivElement>(null);
    const runtimes = store.runtimes.value;
    const rtOf = new Map(runtimes.map((rt) => [rt.id, rt]));
    const q = query.trim().toLowerCase();
    // What the runtimes answered past the snapshot, by session key, and each runtime's cursor. Reset when the query
    // changes; a search waits for typing to pause, so every keystroke is not a round trip.
    const [fetched, setFetched] = useState<ReadonlyMap<string, ListedSession>>(new Map());
    const [cursors, setCursors] = useState<ReadonlyMap<RuntimeId, Cursor>>(new Map());
    const [settledQ, setSettledQ] = useState("");
    const gen = useRef(0);
    useEffect(() => { const t = setTimeout(() => setSettledQ(q), q ? 250 : 0); return () => clearTimeout(t); }, [q]);
    const command = settledQ ? "sessions.search" : "sessions.list";
    const askable = runtimes.filter((rt) => rt.online && mayCommand(rt, command));
    useEffect(() => {
        gen.current++;
        setFetched(new Map());
        setCursors(new Map(askable.map((rt) => [rt.id, { more: true, loading: false }])));
    }, [settledQ, askable.map((r) => r.id).join(",")]);
    const loadMore = () => {
        const g = gen.current;
        for (const [id, cur] of cursors) {
            if (!cur.more || cur.loading) continue;
            setCursors((m) => new Map(m).set(id, { ...cur, loading: true }));
            const ask = settledQ
                ? store.send({ type: "sessions.search", runtime: id, query: settledQ, before: cur.before, limit: PAGE }, { quiet: true })
                : store.send({ type: "sessions.list", runtime: id, before: cur.before, limit: PAGE }, { quiet: true });
            void ask.then((r) => {
                if (g !== gen.current) return;   // the query changed while this page was on its way
                if (!r.ok) { setCursors((m) => new Map(m).set(id, { ...cur, more: false, loading: false })); return; }
                const rows = r.data.sessions;
                setFetched((m) => { const n = new Map(m); for (const row of rows) n.set(`${row.id.runtime}:${row.id.hash}`, row); return n; });
                setCursors((m) => new Map(m).set(id, { before: rows.at(-1)?.lastTs ?? cur.before, more: r.data.more && rows.length > 0, loading: false }));
            });
        }
    };
    // The snapshot, filtered here, then whatever the runtimes answered: a fetched row wins, since it knows whether the
    // session is archived and why it matched. Newest first across every runtime.
    const merged = new Map<string, ListedSession>();
    for (const s of store.listed()) if (rtOf.has(s.id.runtime) && matches(s, rtOf.get(s.id.runtime), q)) merged.set(`${s.id.runtime}:${s.id.hash}`, s);
    if (settledQ === q) for (const [k, row] of fetched) if (rtOf.has(row.id.runtime)) merged.set(k, row);
    const all = [...merged.values()].sort((a, b) => b.lastTs - a.lastTs);
    const anyMore = [...cursors.values()].some((c) => c.more);
    const loading = [...cursors.values()].some((c) => c.loading);
    // Name the runtime only when the results span more than one: otherwise it is the same word on every row.
    const many = new Set(all.map((s) => s.id.runtime)).size > 1;
    useEffect(() => { box.current?.focus(); }, []);
    useEscapeCloses(box);
    useEffect(() => { setShown(PAGE); }, [q]);
    // The end of the list in view: draw the next page of what is held, and once everything held is drawn, ask the
    // runtimes for their next page.
    useEffect(() => {
        const el = sentinel.current;
        if (!el || typeof IntersectionObserver !== "function") return;
        const io = new IntersectionObserver((es) => {
            if (!es.some((e) => e.isIntersecting)) return;
            if (shown < all.length) setShown((n) => n + PAGE); else loadMore();
        });
        io.observe(el);
        return () => io.disconnect();
    }, [shown, all.length, cursors]);
    // An archived session is brought back into the live store before it is opened: from then on it is an ordinary one.
    const [opening, setOpening] = useState<string | null>(null);
    const open = async (key: string, row: ListedSession) => {
        if (row.archived) {
            setOpening(key);
            const r = await store.send({ type: "session.unarchive", session: row.id });
            setOpening(null);
            if (!r.ok) return;   // said as a notice by the store
        }
        mainView.value = null; view.value = { name: "detail", hash: key };
    };
    return (
        <main class="chat-main chat-search" aria-label="Search sessions">
            <div class="view chat-sheet-scroll">
                <div class="chat-sheet-col">
                    {narrow ? (
                        <button class="hbtn chat-sheet-back" aria-label="Back to sessions" onClick={() => (mainView.value = null)}><IconBack /></button>
                    ) : null}
                    <label class="chat-search-box">
                        <IconSearch />
                        <input ref={box} type="search" value={query} placeholder="Search sessions" aria-label="Search sessions"
                            onInput={(e: any) => setQuery(e.target.value)}
                            onKeyDown={(e: KeyboardEvent) => { if (e.key === "Escape") { if (query) setQuery(""); else mainView.value = null; } }} />
                    </label>
                    <div class="chat-search-label">{q ? `${all.length}${anyMore ? "+" : ""} match${all.length === 1 && !anyMore ? "" : "es"}` : "Recent"}</div>
                    {q && !all.length && !loading && settledQ === q ? <div class="chat-search-empty">Nothing matches “{truncate(query.trim(), 40)}”.</div> : null}
                    <ul class="chat-search-list">
                        {all.slice(0, shown).map((s) => {
                            const key = `${s.id.runtime}:${s.id.hash}`;
                            const rt = rtOf.get(s.id.runtime);
                            return (
                                <li key={key}>
                                    <button class={`chat-search-row${s.match ? " has-snip" : ""}`} data-session={key} aria-busy={opening === key}
                                        onClick={() => void open(key, s)}>
                                        <span class="chat-search-main">
                                            <span class="chat-search-title">{truncate(s.title || s.task || "(untitled)", 140)}</span>
                                            {s.match ? <Snippet text={s.match.snippet} /> : null}
                                        </span>
                                        {s.archived ? <span class="chat-chip chat-search-arch">{opening === key ? "restoring…" : "archived"}</span> : null}
                                        {many ? <span class="chat-search-rt">{rt?.name}</span> : null}
                                        <span class="chat-search-date">{shortDate(s.lastTs - (rt?.clockOffsetMs ?? 0))}</span>
                                    </button>
                                </li>
                            );
                        })}
                    </ul>
                    {shown < all.length || anyMore ? <div ref={sentinel} class="chat-search-more" aria-hidden="true" /> : null}
                    {loading ? <div class="chat-search-empty">Looking further back…</div> : null}
                    <ArchiveFolderNotes store={store} />
                </div>
            </div>
        </main>
    );
}

/**
 * A runtime whose archive folder lost its permission: the archive still answers this search (it lives in the browser);
 * only the copy into the folder, the one that survives a wiped profile, is paused until someone clicks in THAT
 * runtime's own Settings. No command can grant it, so this says where, and opens Settings when it is this browser's.
 */
function ArchiveFolderNotes({ store }: { store: ChatStore }) {
    const lapsed = store.runtimes.value.filter((r) => r.capabilities.archive?.folder === "needs-grant");
    if (!lapsed.length) return null;
    return (
        <div class="chat-search-foot">
            {lapsed.map((r) => {
                const pending = r.capabilities.archive?.pending ?? 0;
                return (
                    <p key={r.id}>
                        Reconnect {r.name === "This browser" ? "your" : `${r.name}'s`} archive folder: it lost the browser's permission, so
                        {pending ? ` ${pending} month${pending === 1 ? " is" : "s are"}` : " nothing new is"} not yet copied into it. Search still finds archived sessions.{" "}
                        {r.capabilities.localSettings
                            ? <>In <button class="chat-link" onClick={() => (mainView.value = "settings")}>Settings</button> → Extension → Appearance → Archive folder.</>
                            : <>It is reconnected in that browser's own Settings.</>}
                    </p>
                );
            })}
        </div>
    );
}
