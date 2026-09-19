// search-page.tsx — EVERY SESSION, in the main pane: a search box, then the whole history newest first with each
// session's date at the right, drawn a page at a time as it scrolls. Gemini's search view, and the one place this page
// shows history: the list beside it is for what is recent, pinned or still running.
//
// It replaced two things that each did half of this — a filter that slid open over the list, and an "older sessions"
// view that slid in beside it — because two ways to find a session is one more than anyone can remember.
import { useEffect, useRef, useState } from "preact/hooks";
import type { RuntimeInfo, SessionSummary } from "../session-host";
import { IconBack, IconSearch } from "../sidebar/icons";
import { truncate } from "../sidebar/format";
import { view } from "../sidebar/store";
import type { ChatStore } from "./chat-store";
import { mainView } from "./nav";

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

/** The search page. `narrow` gives it a back arrow, since on a phone it is a screen of its own. */
export function SearchPage({ store, narrow }: { store: ChatStore; narrow: boolean }) {
    const [query, setQuery] = useState("");
    const [shown, setShown] = useState(PAGE);
    const box = useRef<HTMLInputElement>(null);
    const sentinel = useRef<HTMLDivElement>(null);
    const runtimes = store.runtimes.value;
    const rtOf = new Map(runtimes.map((rt) => [rt.id, rt]));
    const q = query.trim().toLowerCase();
    const all = store.listed().filter((s) => rtOf.has(s.id.runtime) && matches(s, rtOf.get(s.id.runtime), q));
    // Name the runtime only when the results span more than one: otherwise it is the same word on every row.
    const many = new Set(all.map((s) => s.id.runtime)).size > 1;
    useEffect(() => { box.current?.focus(); }, []);
    // Escape closes the page from ANYWHERE on it, not only from inside the box: clicking a date or the page's margin
    // took focus out of the input and left no key that closed it. The box keeps its own first step (clear what was
    // typed), and a menu or dialog open over the page gets the key instead.
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (e.key !== "Escape" || e.defaultPrevented || e.target === box.current) return;
            if (document.querySelector(".chat-menu, .chat-dialog")) return;
            mainView.value = null;
        };
        document.addEventListener("keydown", onKey);
        return () => document.removeEventListener("keydown", onKey);
    }, []);
    useEffect(() => { setShown(PAGE); }, [q]);
    useEffect(() => {
        const el = sentinel.current;
        if (!el || typeof IntersectionObserver !== "function") return;
        const io = new IntersectionObserver((es) => { if (es.some((e) => e.isIntersecting)) setShown((n) => n + PAGE); });
        io.observe(el);
        return () => io.disconnect();
    }, [shown, all.length]);
    const open = (key: string) => { mainView.value = null; view.value = { name: "detail", hash: key }; };
    return (
        <main class="chat-main chat-search" aria-label="Search sessions">
            <div class="view chat-search-scroll">
                <div class="chat-search-col">
                    {narrow ? (
                        <button class="nav chat-search-back" aria-label="Back to sessions" onClick={() => (mainView.value = null)}><IconBack /></button>
                    ) : null}
                    <label class="chat-search-box">
                        <IconSearch />
                        <input ref={box} type="search" value={query} placeholder="Search sessions" aria-label="Search sessions"
                            onInput={(e: any) => setQuery(e.target.value)}
                            onKeyDown={(e: KeyboardEvent) => { if (e.key === "Escape") { if (query) setQuery(""); else mainView.value = null; } }} />
                    </label>
                    <div class="chat-search-label">{q ? `${all.length} match${all.length === 1 ? "" : "es"}` : "Recent"}</div>
                    {q && !all.length ? <div class="chat-search-empty">Nothing matches “{truncate(query.trim(), 40)}”.</div> : null}
                    <ul class="chat-search-list">
                        {all.slice(0, shown).map((s) => {
                            const key = `${s.id.runtime}:${s.id.hash}`;
                            const rt = rtOf.get(s.id.runtime);
                            return (
                                <li key={key}>
                                    <button class="chat-search-row" data-session={key} onClick={() => open(key)}>
                                        <span class="chat-search-title">{truncate(s.title || s.task || "(untitled)", 140)}</span>
                                        {many ? <span class="chat-search-rt">{rt?.name}</span> : null}
                                        <span class="chat-search-date">{shortDate(s.lastTs - (rt?.clockOffsetMs ?? 0))}</span>
                                    </button>
                                </li>
                            );
                        })}
                    </ul>
                    {shown < all.length ? <div ref={sentinel} class="chat-search-more" aria-hidden="true" /> : null}
                </div>
            </div>
        </main>
    );
}
