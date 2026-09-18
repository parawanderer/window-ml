// THE CHAT PAGE: the session list and one session, over a `ChatStore`. Two panes side by side on a wide screen, one at
// a time on a narrow one (a phone), where the list comes first and a session has a back button. The transcript and
// the composer are the panel's own components (`DetailView`, `Composer`), fed by the same reducer, so a run reads the
// same here as in the DevTools panel.
//
// Rendered by capability and grant, never by "it is local": a runtime this device may only watch gets no composer, an
// offline one says when it was last seen, and one speaking an unknown contract version is listed but not opened.
import { signal } from "@preact/signals";
import { useEffect, useRef, useState } from "preact/hooks";
import type { RuntimeInfo, SessionId, SessionKey, SessionStatus, SessionSummary } from "../session-host";
import { parseSessionKey } from "../session-host";
import { DetailView } from "../sidebar/session-detail";
import { Composer } from "../sidebar/composer";
import { AgentBadge } from "../sidebar/reply";
import { IconBench, IconCamera, IconChevron, IconClose, IconSave, IconSearch, IconVram } from "../sidebar/icons";
import { services } from "../sidebar/services";
import { ContextMenu, CursorTipLayer, Dot, Hash, Stamp, cursorTipOn } from "../sidebar/ui-kit";
import { benchOpen, openBench, rev, sessionMap, view, type Status } from "../sidebar/store";
import { truncate } from "../sidebar/format";
import { STEP_JUMP_EVENT } from "../sidebar/step-scroll";
import type { ChatStore } from "./chat-store";
import { mayCommand, speaksOurContract } from "./grants";
import { NewSession, ResumeSession, StartMenu, resumableHere, type StartKind } from "./new-session";
import { ListToggle, ViewToggle, calm, foldedRuntimes, listOpen, pane, setPane, toggleRuntime } from "./view-mode";
import type { ChatExtras } from "./extras";
import { lightboxSrc, type ClientPlatform } from "./platform";

/** Below this width the page shows one pane at a time. */
export const NARROW_PX = 760;

/** The index's status as the panel's status dot draws it: a run stopped at its cap is `err` there too (the reducer marks
 *  an answer `err` on `hitCap`), so the list and the transcript agree. */
const DOT: Record<SessionStatus, Status> = { running: "pending", waiting: "pending", done: "ok", capped: "err", error: "err", cancelled: "err", interrupted: "err" };

/** What each status says in a list, where the dot alone would not tell a waiting run from a working one. */
const STATUS_LABEL: Partial<Record<SessionStatus, string>> = { waiting: "waiting on you", capped: "stopped at its step cap", cancelled: "cancelled", interrupted: "interrupted", error: "failed" };

/** Is the viewport narrow? Follows resizes and rotation. */
function useNarrow(): boolean {
    const query = `(max-width: ${NARROW_PX}px)`;
    const [narrow, setNarrow] = useState(() => typeof matchMedia === "function" && matchMedia(query).matches);
    useEffect(() => {
        if (typeof matchMedia !== "function") return;
        const mq = matchMedia(query);
        const on = () => setNarrow(mq.matches);
        mq.addEventListener("change", on);
        return () => mq.removeEventListener("change", on);
    }, []);
    return narrow;
}

/** Whether this page pushed the history entry the open session sits on. Back then pops it (so the phone's own back
 *  gesture and the button agree); a session opened from a link has no entry of ours beneath it to go back to. */
let pushedEntry = false;

/** The open session lives in the URL (`#s=<key>`), so a reload stays put and a phone's back gesture returns to the
 *  list. The view signal stays the source of truth for the shared components; this only mirrors it both ways. */
function useHashRoute(): void {
    useEffect(() => {
        const read = () => {
            const m = /^#s=(.+)$/.exec(location.hash);
            const key = m ? decodeURIComponent(m[1]) : null;
            const want = key && parseSessionKey(key) ? { name: "detail" as const, hash: key } : { name: "list" as const };
            const v = view.value;
            if (want.name === "list") pushedEntry = false;
            if (want.name !== v.name || (want.name === "detail" && v.name === "detail" && want.hash !== v.hash)) view.value = want;
        };
        read();
        addEventListener("hashchange", read);
        return () => removeEventListener("hashchange", read);
    }, []);
    const v = view.value;
    const key = v.name === "detail" ? v.hash : null;
    useEffect(() => {
        const want = key ? `#s=${encodeURIComponent(key)}` : "";
        if (location.hash === want || (!want && !location.hash)) return;
        // Opening a session is a step you go back from; closing one is that step undone.
        if (want) { history.pushState(null, "", want); pushedEntry = true; }
        else { history.replaceState(null, "", location.pathname + location.search); pushedEntry = false; }
    }, [key]);
}

/** Open a session: the one navigation the page has. */
const openSession = (key: SessionKey) => { view.value = { name: "detail", hash: key }; };

/**
 * Sessions whose newest event landed while you were reading something else.
 *
 * Deliberately not stored: it answers "what moved while I was here", which is the brainstorming case — you are
 * talking in one session and the run in the next tab gets somewhere — and not "what is unread", which would mark
 * every session on this device the first time the page is opened and teach everyone to ignore the mark.
 */
const movedSince = signal<ReadonlySet<SessionKey>>(new Set());

/** Follow the index, marking a session whose `lastTs` advances while it is not the one open. */
function useMovedSince(store: ChatStore, openKey: SessionKey | null): void {
    const seen = useRef(new Map<SessionKey, number>());
    const index = store.index.value;
    useEffect(() => {
        let next: Set<SessionKey> | null = null;
        for (const [key, s] of index) {
            const before = seen.current.get(key);
            seen.current.set(key, s.lastTs);
            // A session seen for the FIRST time is not "moved": on a first render that would be all of them.
            if (before === undefined || key === openKey || s.lastTs <= before) continue;
            (next ??= new Set(movedSince.value)).add(key);
        }
        if (next) movedSince.value = next;
    }, [index, openKey]);
    // Reading it IS catching up with it.
    useEffect(() => {
        if (!openKey || !movedSince.value.has(openKey)) return;
        const next = new Set(movedSince.value);
        next.delete(openKey);
        movedSince.value = next;
    }, [openKey, index]);
}

/** A page's host, which is what tells two of someone's tabs apart in one line. Falls back to the whole string,
 *  because a runtime's `page.url` is untrusted input and may not parse. */
function hostOf(url: string): string {
    try { return new URL(url).host || url; } catch { return url; }
}

/**
 * THE TAB A RUN IS DRIVING, said wherever that run is listed or opened.
 *
 * A session on this page can be one of several the agent owns at once, and until now nothing said which: the header
 * read `Work laptop · qwen3:32b`, which names the machine and the model and not the document being acted on. The
 * host is the part that identifies it; the title and the full URL ride the tip, because a URL is long and this sits
 * in a row that already ellipsizes.
 *
 * It is NOT a link. Opening the URL would make a second tab showing the same document, which is precisely not the
 * tab the run holds, and there is no command in the contract for putting an existing one in front.
 */
function PageChip({ page }: { page: NonNullable<SessionSummary["page"]> }) {
    return (
        <span class="chat-page" {...cursorTipOn(<span><b>{page.title || "the page this run is on"}</b><br />{page.url}</span>)}>
            {hostOf(page.url)}
        </span>
    );
}

/**
 * What the tab looks like RIGHT NOW, into the same full-size view an image in a transcript opens in.
 *
 * Offered only where there is still a TAB to capture — `page.tabId` absent is the tell that the one the run worked
 * in has closed, the same tell `resumableHere` reads — and where the runtime says it can capture and this client
 * holds the scope for it. The browser can only
 * capture the tab its window is SHOWING, so a run working in a background tab answers `conflict` and the store puts
 * the runtime's own sentence on screen — which is the rule stated once, where it is met, rather than a button that
 * quietly does nothing.
 */
function PagePeek({ store, id, rt, sessionKey, summary }: { store: ChatStore; id: SessionId; rt: RuntimeInfo; sessionKey: SessionKey; summary?: SessionSummary }) {
    const [busy, setBusy] = useState(false);
    if (summary?.page?.tabId == null) return null;
    if (!rt.online || !rt.capabilities.screenshots || !mayCommand(rt, "tab.screenshot", { key: sessionKey, summary }, store.host.self)) return null;
    const peek = async (): Promise<void> => {
        setBusy(true);
        try {
            const r = await store.send({ type: "tab.screenshot", runtime: rt.id, target: { session: id } });
            if (r.ok) services().openLightbox(r.data.image);
        } finally { setBusy(false); }
    };
    return (
        <button class="tt hbtn chat-peek" aria-label="Look at the page" disabled={busy} onClick={() => void peek()}>
            <IconCamera />
            <span class="tt-pop left" role="tooltip">Look at the page this run is on, as it is now</span>
        </button>
    );
}

/** A runtime's heading in the list: its name, whether it is reachable, and what this device may do there. */
function RuntimeHead({ rt, folded, count }: { rt: RuntimeInfo; folded: boolean; count: number }) {
    const watchOnly = !mayCommand(rt, "session.send");
    return (
        <button class={`chat-rt${rt.online ? "" : " off"}${folded ? " folded" : ""}`} data-runtime={rt.id}
            aria-expanded={!folded} onClick={() => toggleRuntime(rt.id)}>
            <span class={`tri${folded ? "" : " open"}`} aria-hidden="true"><IconChevron /></span>
            <span class={`chat-rt-dot${rt.online ? " on" : ""}`} aria-hidden="true" />
            <b class="chat-rt-name">{rt.name}</b>
            {!rt.online ? <span class="chat-rt-note">offline{rt.lastSeen ? <> · seen <Stamp ts={rt.lastSeen} /></> : null}</span> : null}
            {rt.online && watchOnly ? <span class="chat-chip">view only</span> : null}
            {folded ? <span class="chat-rt-note chat-rt-count">{count} session{count === 1 ? "" : "s"}</span> : null}
        </button>
    );
}

/** One session in the list, from its index row (the transcript is fetched only when it is opened). */
function IndexRow({ s, rt, active, moved }: { s: SessionSummary; rt: RuntimeInfo; active: boolean; moved: boolean }) {
    const key = `${s.id.runtime}:${s.id.hash}`;
    const title = s.title || s.task || "(untitled)";
    const offset = rt.clockOffsetMs ?? 0;
    return (
        <button class={`row chat-row${active ? " active" : ""}`} data-session={key} onClick={() => openSession(key)}>
            <Dot status={DOT[s.status] ?? "pending"} />
            <span class="chat-row-body">
                <b class="row-title">{truncate(title, 90)}</b>
                <span class="chat-row-meta">
                    {s.kind === "agent" ? <AgentBadge /> : null}
                    {s.page ? <PageChip page={s.page} /> : null}
                    {STATUS_LABEL[s.status] ? <span class={`chat-status st-${s.status}`}>{STATUS_LABEL[s.status]}</span> : null}
                    {s.pendingApprovals > 0 ? <span class="chat-appr-badge">{s.pendingApprovals} approval{s.pendingApprovals === 1 ? "" : "s"}</span> : null}
                </span>
            </span>
            {moved ? <span class="chat-moved" {...cursorTipOn("Something happened here while you were reading something else")} aria-label="new activity" /> : null}
            <Stamp ts={s.lastTs - offset} snap="right" />
        </button>
    );
}

/** Does a session answer to what was typed in the filter? Matched against everything a person would use to name
 *  one out loud: its title, the task it was given, the page it is on, and the runtime it is running on. */
function matches(s: SessionSummary, rt: RuntimeInfo, q: string): boolean {
    if (!q) return true;
    return [s.title, s.task, s.page?.url, s.page?.title, rt.name].some((v) => !!v && v.toLowerCase().includes(q));
}

/** The session list, grouped by runtime. */
function SessionList({ store, activeKey, narrow, onStart }: { store: ChatStore; activeKey: SessionKey | null; narrow: boolean; onStart: (kind: StartKind) => void }) {
    const runtimes = store.runtimes.value;
    const sessions = store.listed();
    const status = store.status.value;
    const moved = movedSince.value;
    const folded = foldedRuntimes.value;
    const [query, setQuery] = useState("");
    const [searching, setSearching] = useState(false);
    const box = useRef<HTMLInputElement>(null);
    const q = searching ? query.trim().toLowerCase() : "";
    // A filter is a way of FINDING one session, so it looks past a folded group rather than through it: hiding a
    // match because its runtime happens to be folded would be the list refusing to answer the question asked.
    const shown = (rt: RuntimeInfo) => sessions.filter((s) => s.id.runtime === rt.id && matches(s, rt, q));
    const groups = runtimes.map((rt) => ({ rt, mine: shown(rt) })).filter(({ mine }) => !q || mine.length);
    return (
        <aside class="chat-list" aria-label="Sessions">
            <div class="head">
                <ListToggle narrow={narrow} /><b>Sessions</b><span class="sp" />
                {status.state !== "online" ? <span class="chat-chip warn">{status.state === "connecting" ? "connecting…" : "offline"}</span> : null}
                {/* The box is not there until it is asked for: a list you can still scan does not need one, and a
                    permanent field at the top of a quiet page is chrome that earns nothing most of the time. */}
                {sessions.length > 4 ? (
                    <button class={`tt hbtn${searching ? " on" : ""}`} aria-label="Find a session" aria-expanded={searching}
                        onClick={() => { const next = !searching; setSearching(next); if (!next) setQuery(""); else requestAnimationFrame(() => box.current?.focus()); }}>
                        <IconSearch /><span class="tt-pop" role="tooltip">Find a session</span>
                    </button>
                ) : null}
                <StartMenu store={store} onPick={onStart} />{narrow ? <ViewToggle /> : null}
            </div>
            <div class={`chat-filter${searching ? " open" : ""}`} aria-hidden={!searching}>
                <div class="chat-filter-row">
                    <input ref={box} type="search" class="chat-filter-in" value={query} tabIndex={searching ? 0 : -1}
                        aria-label="Filter sessions" placeholder="Filter by title, page or runtime…"
                        onInput={(e: any) => setQuery(e.target.value)}
                        onKeyDown={(e: KeyboardEvent) => { if (e.key === "Escape") { setQuery(""); setSearching(false); } }} />
                </div>
            </div>
            <div class="view chat-list-scroll">
                {runtimes.length === 0 && status.state === "online" ? <div class="empty">No runtimes yet. Pair one to see its sessions here.</div> : null}
                {q && !groups.length ? <div class="empty">Nothing matches “{truncate(query.trim(), 40)}”.</div> : null}
                {groups.map(({ rt, mine }) => {
                    const shut = folded.has(rt.id) && !q;
                    return (
                        <section class={`chat-group${shut ? " folded" : ""}`} key={rt.id}>
                            <RuntimeHead rt={rt} folded={shut} count={mine.length} />
                            {shut ? null : !speaksOurContract(rt)
                                ? <div class="chat-rt-empty">This runtime speaks version {rt.contractVersion} of the session contract, which this app does not. Its sessions open once both sides agree.</div>
                                : mine.length
                                    ? mine.map((s) => {
                                        const key = `${s.id.runtime}:${s.id.hash}`;
                                        return <IndexRow key={key} s={s} rt={rt} active={activeKey === key} moved={moved.has(key)} />;
                                    })
                                    : <div class="chat-rt-empty">No sessions.</div>}
                        </section>
                    );
                })}
            </div>
        </aside>
    );
}

/** One session: its header, the transcript and, where this device may drive it, the composer. */
function SessionPane({ store, sessionKey, narrow, extras }: { store: ChatStore; sessionKey: SessionKey; narrow: boolean; extras?: ChatExtras }) {
    const r = rev.value;   // subscribe: the transcript changes by rev, and this pane must re-render with it
    const id = parseSessionKey(sessionKey);
    const summary = store.index.value.get(sessionKey);
    const rt = id ? store.runtimes.value.find((x) => x.id === id.runtime) : undefined;
    const s = sessionMap.get(sessionKey);
    const truncated = store.truncated.value.has(sessionKey);
    const scroller = useRef<HTMLDivElement>(null);
    const content = useRef<HTMLDivElement>(null);
    const stuck = useRef(true);

    // Follow the newest event while the reader is at the bottom; leave them alone once they scroll up.
    useEffect(() => {
        stuck.current = true;
        const el = scroller.current;
        if (el) el.scrollTop = el.scrollHeight;
    }, [sessionKey]);
    useEffect(() => {
        const el = scroller.current, inner = content.current;
        if (!el || !inner || typeof ResizeObserver === "undefined") return;
        const ro = new ResizeObserver(() => { if (stuck.current) el.scrollTop = el.scrollHeight; });
        ro.observe(inner);
        return () => ro.disconnect();
    }, [sessionKey]);
    const onScroll = () => {
        const el = scroller.current;
        if (el) stuck.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    };
    // A citation sending the reader UP the transcript stops it following the bottom, or the step it opens grows
    // the content, the observer above pins back down, and the jump is overwritten before it lands.
    useEffect(() => {
        const off = () => { stuck.current = false; };
        document.addEventListener(STEP_JUMP_EVENT, off);
        return () => document.removeEventListener(STEP_JUMP_EVENT, off);
    }, []);

    const [resuming, setResuming] = useState(false);
    const canDrive = !!rt && rt.online && mayCommand(rt, "session.send", { key: sessionKey, summary }, store.host.self);
    const canResume = resumableHere(rt, sessionKey, summary, store.host.self);
    // A session whose page went away, opened while the form was up: the form is about THIS session, so it closes.
    useEffect(() => setResuming(false), [sessionKey]);
    const title = summary?.title || s?.title || summary?.task || s?.task || "Session";
    const waiting = (summary?.pendingApprovals ?? 0) > 0 && !!rt && mayCommand(rt, "approval.answer", { key: sessionKey, summary }, store.host.self);
    const jumpToApproval = () => (scroller.current?.querySelector(".astep-approve") as HTMLElement | null)?.scrollIntoView({ block: "center", behavior: "smooth" });
    // The bar at the top exists for a gate several screens down a long run. When the gate is ON SCREEN it says,
    // in the loudest colour the page has, what the card right there already says with buttons — so in calm it
    // appears only when the card cannot be seen. The detail view keeps the panel's behaviour, because that is
    // what it is for.
    const [gateAway, setGateAway] = useState(false);
    useEffect(() => {
        const root = scroller.current;
        if (!waiting || !root || typeof IntersectionObserver === "undefined") { setGateAway(false); return; }
        const card = root.querySelector(".astep-approve");
        if (!card) { setGateAway(true); return; }   // not rendered yet: say it until it is
        const io = new IntersectionObserver(([e]) => setGateAway(!e.isIntersecting), { root });
        io.observe(card);
        return () => io.disconnect();
    }, [waiting, sessionKey, r]);

    return (
        <main class="chat-main" data-rev={r} data-session={sessionKey}>
            <div class="head chat-head">
                {narrow ? <button class="nav" aria-label="Back to sessions" onClick={() => (pushedEntry ? history.back() : (view.value = { name: "list" }))}>‹</button> : null}
                {!narrow && !listOpen.value ? <ListToggle narrow={narrow} /> : null}
                <span class="chat-head-title">
                    <b>{truncate(title, 120)}</b>
                    <span class="chat-head-sub">
                        {rt?.name ?? id?.runtime}{summary?.model ? ` · ${summary.model}` : ""}
                        {summary?.page ? <> · <PageChip page={summary.page} /></> : null}
                    </span>
                </span>
                <span class="sp" />
                {id && rt && summary?.page ? <PagePeek store={store} id={id} rt={rt} sessionKey={sessionKey} summary={summary} /> : null}
                {narrow ? null : <DeviceViews extras={extras} rt={rt} />}
                <ViewToggle />
                {id ? <Hash hash={id.hash} /> : null}
            </div>
            {waiting && (gateAway || !calm.value) ? <button class="chat-waiting" onClick={jumpToApproval}>Waiting on your approval<span class="chat-waiting-go">Review ›</span></button> : null}
            <div class="view chat-transcript" ref={scroller} onScroll={onScroll}>
                <div ref={content}>
                    {truncated ? <div class="chat-truncated">Older events no longer exist on {rt?.name ?? "the runtime"}. What is shown here is what this device kept.</div> : null}
                    {s ? <DetailView hash={sessionKey} />
                        : !summary && !rt ? <div class="empty">Session not found.</div>
                            : <div class="empty">Loading…</div>}
                </div>
            </div>
            {/* A run whose page is gone cannot be sent to, so the composer is replaced by the one thing that WOULD
                work: picking it up somewhere else. `canResume` is false while its tab is still open, so the two
                never both offer to continue the same run. */}
            {canResume && id && rt ? (
                resuming
                    ? <ResumeSession store={store} rt={rt} session={{ runtime: id.runtime, hash: id.hash }}
                        onResumed={() => setResuming(false)} onCancel={() => setResuming(false)} />
                    : <button class="chat-resume" onClick={() => setResuming(true)}>
                        The page this run was on is gone<span class="chat-resume-go">Resume it somewhere ›</span>
                    </button>
            ) : s && canDrive ? <Composer s={s} multiline />
                : s && rt ? <div class="chat-readonly">{!rt.online ? `${rt.name} is offline. You can read this session, and send to it once it is back.` : `This device may watch sessions on ${rt.name}, not drive them.`}</div>
                    : null}
        </main>
    );
}

/**
 * The buttons for this device's OWN views (`src/chat/extras.ts`), and the pane one of them opens.
 *
 * Both are asked twice before they appear: the RUNTIME has to report the capability, and this DEVICE has to be able
 * to draw it. The second question is what keeps the page honest — a phone reaching a browser over the hub gets
 * neither, not because it is a phone but because it holds no implementation, and nothing here asks which it is.
 */
function DeviceViews({ extras, rt }: { extras?: ChatExtras; rt?: RuntimeInfo }) {
    if (!rt || !extras) return null;
    const graphs = rt.capabilities.resourcePanel && extras.resourcePanel?.(rt.id) != null;
    const bench = rt.capabilities.pythonBench && extras.bench?.(rt.id) != null;
    if (!graphs && !bench) return null;
    const on = pane.value === "resource";
    return (
        <>
            {graphs ? (
                <button class={`tt hbtn${on ? " on" : ""}`} aria-label="The box" aria-pressed={on} onClick={() => setPane(on ? null : "resource")}>
                    <IconVram /><span class="tt-pop left" role="tooltip">{on ? "Close the box's panel" : `What ${rt.name} is running, and what it is using`}</span>
                </button>
            ) : null}
            {bench ? (
                <button class={`tt hbtn${benchOpen.value ? " on" : ""}`} aria-label="Python bench" aria-pressed={benchOpen.value}
                    onClick={() => (benchOpen.value ? (benchOpen.value = false) : openBench())}>
                    <IconBench /><span class="tt-pop left" role="tooltip">A Python bench against the same sandbox a run uses</span>
                </button>
            ) : null}
        </>
    );
}

/** Command failures and other short news, bottom of the page, each dismissable and gone on its own after a while. */
function Notices({ store }: { store: ChatStore }) {
    const list = store.notices.value;
    useEffect(() => {
        if (!list.length) return;
        const oldest = list[0];
        const t = setTimeout(() => store.dismiss(oldest.id), 6000);
        return () => clearTimeout(t);
    }, [list]);
    if (!list.length) return null;
    return (
        <div class="chat-notices" role="status" aria-live="polite">
            {list.map((n) => (
                <div class={`chat-notice ${n.tone}`} key={n.id}>
                    <span>{n.text}</span>
                    <button class="chat-notice-x" aria-label="Dismiss" onClick={() => store.dismiss(n.id)}>×</button>
                </div>
            ))}
        </div>
    );
}

/** A `data:` / `blob:` image as a Blob, for saving it. Null when it is neither, or the encoding is broken. */
async function imageBlob(src: string): Promise<Blob | null> {
    try { return await (await fetch(src)).blob(); } catch { return null; }
}

/**
 * The web adapter's full-size image view — and the one place a screenshot or a plot can be KEPT.
 *
 * A picture a run produced is the sort of thing you want out of the page (into a message, a ticket, a notebook),
 * and until now the only ways were the whole-run export or a right-click, which on a `blob:` URL a page minted
 * gives a file named after nothing. Saving goes through the platform, because what a save IS differs by device:
 * a download on a desktop, the share sheet on a phone.
 */
function Lightbox({ platform }: { platform: ClientPlatform }) {
    const src = lightboxSrc.value;
    useEffect(() => {
        if (!src) return;
        const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") lightboxSrc.value = null; };
        addEventListener("keydown", onKey);
        return () => removeEventListener("keydown", onKey);
    }, [src]);
    if (!src) return null;
    const save = async (): Promise<void> => {
        const blob = await imageBlob(src);
        if (!blob) return;
        const ext = (/^data:image\/([a-z0-9.+-]+)/i.exec(src)?.[1] || blob.type.split("/")[1] || "png").replace("svg+xml", "svg");
        platform.saveFile(`window-ml-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}.${ext}`, blob);
    };
    return (
        <div class="chat-lightbox" role="dialog" aria-label="Image" onClick={() => (lightboxSrc.value = null)}>
            <div class="chat-lightbox-bar" onClick={(e) => e.stopPropagation()}>
                <button class="tt hbtn" aria-label="Save this image" onClick={() => void save()}>
                    <IconSave /><span class="tt-pop left" role="tooltip">Save this image</span>
                </button>
                <button class="tt hbtn" aria-label="Close" onClick={() => (lightboxSrc.value = null)}>
                    <IconClose /><span class="tt-pop left" role="tooltip">Close (Esc)</span>
                </button>
            </div>
            <img src={src} alt="" />
        </div>
    );
}

/** The chat page. */
export function ChatApp({ store, platform, extras }: { store: ChatStore; platform: ClientPlatform; extras?: ChatExtras }) {
    const narrow = useNarrow();
    useHashRoute();
    const v = view.value;
    const key = v.name === "detail" ? v.hash : null;
    // The new-session form is deliberately NOT in the URL, unlike the open session: it holds what someone is part
    // way through typing, and a link to a half-written message is not a thing anyone wants to share or reload into.
    const [starting, setStarting] = useState<StartKind | null>(null);
    // WHOSE box the device's own views describe: the open session's runtime, or — with nothing open — the first
    // one that offers anything. Never "the local one": that question is not asked anywhere on this page.
    const openRt = key ? store.runtime(parseSessionKey(key)?.runtime ?? "") : undefined;
    const deviceRt = openRt ?? store.runtimes.value.find((r) => r.online && (r.capabilities.resourcePanel || r.capabilities.pythonBench));
    const asideRt = !narrow && pane.value === "resource" && deviceRt?.capabilities.resourcePanel ? deviceRt : undefined;
    const benchRt = !narrow && benchOpen.value && deviceRt?.capabilities.pythonBench ? deviceRt : undefined;
    const aside = asideRt ? extras?.resourcePanel?.(asideRt.id) : null;
    const bench = benchRt ? extras?.bench?.(benchRt.id) : null;
    useMovedSince(store, key);
    useEffect(() => { if (key) store.open(key); else store.close(); }, [key]);
    useEffect(() => { if (key) setStarting(null); }, [key]);   // opening a session puts the form away
    return (
        <div class={`chat${narrow ? " narrow" : ""}${calm.value ? " calm" : ""}${!narrow && !listOpen.value ? " list-hidden" : ""}${aside ? " pane-open" : ""}`}>
            <ContextMenu />
            <CursorTipLayer />
            {(!narrow || (!key && !starting)) ? <SessionList store={store} activeKey={key} narrow={narrow} onStart={setStarting} /> : null}
            {starting ? <NewSession store={store} kind={starting} onCancel={() => setStarting(null)}
                onStarted={(k) => { setStarting(null); openSession(k); }} />
                : key ? <SessionPane store={store} sessionKey={key} narrow={narrow} />
                    : !narrow ? (
                        <main class="chat-main">
                            {/* The empty pane carries a header of its own so the two page-level controls sit where
                                they always sit — a toggle that moves when nothing is open is a toggle you hunt for. */}
                            <div class="head chat-head">
                                {!listOpen.value ? <ListToggle narrow={narrow} /> : null}
                                <span class="sp" />
                                {narrow ? null : <DeviceViews extras={extras} rt={deviceRt} />}
                                <ViewToggle />
                            </div>
                            <div class="empty chat-pick">Pick a session.</div>
                        </main>
                    ) : null}
            {aside ? <aside class="chat-pane" aria-label="The box">{aside}</aside> : null}
            {bench ? <div class="chat-bench">{bench}</div> : null}
            <Notices store={store} />
            <Lightbox platform={platform} />
        </div>
    );
}
