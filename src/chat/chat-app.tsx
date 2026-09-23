// THE CHAT PAGE: the session list and one session, over a `ChatStore`. Two panes side by side on a wide screen, one at
// a time on a narrow one (a phone), where the list comes first and a session has a back button. The transcript and
// the composer are the panel's own components (`DetailView`, `Composer`), fed by the same reducer, so a run reads the
// same here as in the DevTools panel.
//
// Rendered by capability and grant, never by "it is local": a runtime this device may only watch gets no composer, an
// offline one says when it was last seen, and one speaking an unknown contract version is listed but not opened.
import { signal } from "@preact/signals";
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import type { RuntimeInfo, SessionId, SessionKey, SessionStatus, SessionSummary } from "../session-host";
import { parseSessionKey } from "../session-host";
import { DetailView } from "../sidebar/session-detail";
import { Composer } from "../sidebar/composer";
import { AgentBadge } from "../sidebar/reply";
import { IconBack, IconBench, IconBrain, IconCompose, IconCopy, IconCamera, IconChevron, IconClose, IconHistory, IconMore, IconPin, IconSave, IconSearch, IconVram } from "../sidebar/icons";
import { services } from "../sidebar/services";
import { ContextMenu, CursorTipLayer, Dot, Hash, Stamp, cursorTipOn } from "../sidebar/ui-kit";
import { benchOpen, openBench, rev, sessionMap, view, type Status } from "../sidebar/store";
import { truncate } from "../sidebar/format";
import { STEP_JUMP_EVENT, STEP_GONE_EVENT } from "../sidebar/step-scroll";
import type { ChatStore } from "./chat-store";
import { mayCommand, speaksOurContract, resumableHere } from "./grants";
import { ResumeSession, StartMenu, startableOn, type StartKind } from "./new-session";
import { START_GRACE_MS, StartPage, useHeldTrue } from "./start-page";
import { AttentionButton, AttentionPage, useAttention } from "./attention-page";
import { ListToggle, ViewToggle, calm, codeSize, foldedRuntimes, panelSize, listOpen, pane, pinned, setCalm, setPane, toggleRuntime } from "./view-mode";
import { MenuItem } from "./menu";
import { SessionModelPicker } from "./model-picker";
import { DeleteConfirm, RenameDialog, RowMenu, isPinned } from "./row-menu";
import { GearMenu, Rail, mainView, openSearch } from "./nav";
import { SearchPage } from "./search-page";
import { SettingsPage, settingsTab } from "./settings-page";
import { formatRoute, parseRoute } from "./route";
import { DockFrame, type DockPanel } from "./dock";
import type { ChatExtras } from "./extras";
import { lightboxSrc, type ClientPlatform } from "./platform";

/** Below this width the page shows one pane at a time. */
export const NARROW_PX = 760;

/** The index's status as the panel's status dot draws it. A run stopped at its cap is `err` underneath (the reducer marks
 *  an answer `err` on `hitCap`), and is DRAWN amber, in the list and the transcript alike: it did not fail. */
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

/**
 * The page's ADDRESS mirrors what is on screen, both ways (route.ts): the open session, or a main view and its tab. So
 * a reload stays put, a link opens a view (`#/settings/devices`), and a phone's back gesture undoes the last step. The
 * signals stay the source of truth for the shared components; this only mirrors them.
 */
function useHashRoute(): void {
    useEffect(() => {
        const read = () => {
            const r = parseRoute(location.hash);
            const key = r.session && parseSessionKey(r.session) ? r.session : null;
            const v = view.value;
            if (key) { if (v.name !== "detail" || v.hash !== key) view.value = { name: "detail", hash: key }; }
            // The list, or SEARCH: a session opened from search sits over it on a phone, so an address that names search
            // and no session (back from that session, or a link) closes the session to show search itself.
            else if (!r.main || r.main === "search") { if (!r.main) pushedEntry = false; if (v.name !== "list") view.value = { name: "list" }; }
            if (r.tab) settingsTab.value = r.tab;
            if (mainView.value !== (r.main ?? null)) mainView.value = r.main ?? null;
        };
        read();
        addEventListener("hashchange", read);
        return () => removeEventListener("hashchange", read);
    }, []);
    const v = view.value;
    const key = v.name === "detail" ? v.hash : null;
    const main = mainView.value;
    const tab = settingsTab.value;
    // The FIRST run is skipped: it sees the render before `read` above applied the address, so it would write the list's
    // address over the one the page was opened at, then push that one back once the state caught up. That wiped the hash
    // on every load and left a spurious history entry, which a quick back or a hash change then raced.
    const first = useRef(true);
    useEffect(() => {
        if (first.current) { first.current = false; return; }
        const want = formatRoute({ session: key ?? undefined, main: main ?? undefined, tab: main === "settings" ? tab : undefined });
        if (location.hash === want || (!want && !location.hash)) return;
        const here = parseRoute(location.hash);
        // A step you go back from is pushed; rewriting the SAME place (an old `#s=` link, another settings tab) is not.
        const same = formatRoute(here) === want || (here.main === "settings" && main === "settings");
        if (!want) { history.replaceState(null, "", location.pathname + location.search); pushedEntry = false; }
        else if (same) history.replaceState(null, "", want);
        else { history.pushState(null, "", want); pushedEntry = true; }
    }, [key, main, tab]);
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
function PageChip({ page, onShow }: { page: NonNullable<SessionSummary["page"]>; onShow?: () => void }) {
    const tip = <span><b>{page.title || "the page this run is on"}</b><br />{page.url}{onShow ? <><br /><i>Click to bring that tab to the front.</i></> : null}</span>;
    // WHERE THIS DEVICE CAN ACT ON IT, the chip is the way to the tab. Where it cannot — a runtime on somebody
    // else's machine — it stays what it was: the name of the document, and nothing that pretends to reach it.
    return onShow
        ? <button class="chat-page chat-page-go" data-inline-target {...cursorTipOn(tip)} onClick={onShow}>{hostOf(page.url)}</button>
        : <span class="chat-page" {...cursorTipOn(tip)}>{hostOf(page.url)}</span>;
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
/** Look at the page a run is on, as it is now: its capture, shown full size. Null where it cannot be (no tab, the runtime
 *  offline or without screenshots, or this client without the grant to ask). */
function usePeek(store: ChatStore, id: SessionId | null, rt: RuntimeInfo | undefined, sessionKey: SessionKey, summary?: SessionSummary): { busy: boolean; peek: () => void } | null {
    const [busy, setBusy] = useState(false);
    if (!id || !rt || summary?.page?.tabId == null) return null;
    if (!rt.online || !rt.capabilities.screenshots || !mayCommand(rt, "tab.screenshot", { key: sessionKey, summary }, store.host.self)) return null;
    const peek = (): void => {
        setBusy(true);
        void store.send({ type: "tab.screenshot", runtime: rt.id, target: { session: id } })
            .then((r) => { if (r.ok) services().openLightbox(r.data.image); })
            .finally(() => setBusy(false));
    };
    return { busy, peek };
}

/** Sessions whose runtime answered `unsupported` to a switch: their loop runs in a page, whose script owns the model. */
const pageOwnsModel = signal<ReadonlySet<SessionKey>>(new Set());

/**
 * The session's model at the top of its page, as a picker (model-picker.tsx) that switches it (`session.model`). The
 * pill shows the index's model, which the runtime changes at once, so nothing here is optimistic. It is drawn but
 * cannot switch where the runtime does not offer it, where this device lacks `drive`, and on a session whose runtime
 * refused because a page script runs it; each says which.
 */
function ModelTop({ store, rt, model, sessionKey, summary, quiet }: { store: ChatStore; rt: RuntimeInfo; model: string; sessionKey: SessionKey; summary?: SessionSummary; quiet?: boolean }) {
    const id = parseSessionKey(sessionKey);
    const owned = pageOwnsModel.value.has(sessionKey);
    const offered = !!rt.capabilities.switchModel;
    const may = rt.online && mayCommand(rt, "session.model", { key: sessionKey, summary }, store.host.self);
    const note = !offered ? "This runtime cannot switch a session's model. A new session can start on any of these."
        : owned ? "This session's model belongs to the page script that runs it, so it cannot be switched from here."
        : !rt.online ? `${rt.name} is offline.`
        : !may ? "This device may not switch this session's model." : undefined;
    const onSwitch = (m: string): void => {
        if (!id) return;
        void store.send({ type: "session.model", session: id, model: m }).then((r) => {
            if (!r.ok && r.error.code === "unsupported") pageOwnsModel.value = new Set([...pageOwnsModel.value, sessionKey]);
        });
    };
    return <SessionModelPicker store={store} rt={rt} current={model} canSwitch={!note} note={note} onSwitch={onSwitch} quiet={quiet} />;
}

/** The camera button in a wide header. */
function PagePeek({ peek }: { peek: { busy: boolean; peek: () => void } | null }) {
    if (!peek) return null;
    return (
        <button class="tt hbtn chat-peek" aria-label="Look at the page" disabled={peek.busy} onClick={peek.peek}>
            <IconCamera />
            <span class="tt-pop left" role="tooltip">Look at the page this run is on, as it is now</span>
        </button>
    );
}

/**
 * A PHONE's header keeps one button at its right, `⋮`, and the session's tools under it (looking at the page, calm
 * view, copying the id). Three icons at 390px crowded the title into two words, and a brain glyph says nothing on its
 * own; in a menu each has its name.
 */
function SessionMenu({ peek, hash, title }: { peek: { busy: boolean; peek: () => void } | null; hash?: string; title?: string }) {
    const [at, setAt] = useState<{ top: number; right: number } | null>(null);
    const btn = useRef<HTMLButtonElement>(null);
    const menu = useRef<HTMLDivElement>(null);
    useEffect(() => {
        if (!at) return;
        const off = (e: Event) => { const t = e.target as Node; if (!menu.current?.contains(t) && !btn.current?.contains(t)) setAt(null); };
        const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setAt(null); };
        document.addEventListener("pointerdown", off);
        document.addEventListener("keydown", esc);
        return () => { document.removeEventListener("pointerdown", off); document.removeEventListener("keydown", esc); };
    }, [at]);
    const open = () => { const r = btn.current!.getBoundingClientRect(); setAt({ top: r.bottom + 6, right: Math.max(8, innerWidth - r.right) }); };
    const act = (f: () => void) => () => { setAt(null); f(); };
    return (
        <>
            <button ref={btn} class="hbtn chat-head-more" aria-label="Session options" aria-haspopup="menu" aria-expanded={!!at}
                onClick={() => (at ? setAt(null) : open())}><IconMore /></button>
            {at ? (
                <div ref={menu} class="chat-menu chat-head-menu" role="menu" aria-label="Session options" style={`top:${at.top}px;right:${at.right}px`}>
                    {title ? <div class="chat-head-menu-title" role="presentation">{title}</div> : null}
                    {peek ? <MenuItem icon={<IconCamera />} label="Look at the page" onPick={act(peek.peek)} /> : null}
                    <MenuItem icon={<IconBrain />} label="Calm view" on={calm.value} onPick={act(() => setCalm(!calm.value))} />
                    {hash ? <MenuItem icon={<IconCopy />} label="Copy session id" onPick={act(() => void navigator.clipboard?.writeText(hash).catch(() => {}))} /> : null}
                </div>
            ) : null}
        </>
    );
}

/** A runtime's heading in the list: its name, whether it is reachable, and what this device may do there. */
function RuntimeHead({ rt, folded }: { rt: RuntimeInfo; folded: boolean }) {
    const watchOnly = !mayCommand(rt, "session.send");
    return (
        <button class={`chat-rt${rt.online ? "" : " off"}${folded ? " folded" : ""}`} data-runtime={rt.id}
            aria-expanded={!folded} onClick={() => toggleRuntime(rt.id)}>
            <span class={`tri${folded ? "" : " open"}`} aria-hidden="true"><IconChevron /></span>
            <span class={`chat-rt-dot${rt.online ? " on" : ""}`} aria-hidden="true" />
            <b class="chat-rt-name">{rt.name}</b>
            {!rt.online ? <span class="chat-rt-note">offline{rt.lastSeen ? <> · seen <Stamp ts={rt.lastSeen} /></> : null}</span> : null}
            {rt.online && watchOnly ? <span class="chat-chip">view only</span> : null}
        </button>
    );
}

/** The page chip's click: ask the RUNTIME to bring the run's tab (and its window) forward with `tab.focus`, so the chip
 *  works the same over a hub as on this browser. Undefined where there is no open tab or this client may not ask. */
function tabFocus(store: ChatStore, rt: RuntimeInfo | undefined, summary: SessionSummary | undefined): (() => void) | undefined {
    const tabId = summary?.page?.tabId;
    if (!rt || tabId == null || !rt.capabilities.tabs || !mayCommand(rt, "tab.focus")) return undefined;
    return () => { void store.send({ type: "tab.focus", runtime: rt.id, tabId }); };
}

/** One session in the list, from its index row (the transcript is fetched only when it is opened). The row and its
 *  `⋮` are siblings in a wrapper rather than one inside the other, because a button cannot hold a button. */
function IndexRow({ store, s, rt, active, moved, showRuntime }: { store: ChatStore; s: SessionSummary; rt: RuntimeInfo; active: boolean; moved: boolean; showRuntime?: boolean }) {
    const key = `${s.id.runtime}:${s.id.hash}`;
    const title = s.title || s.task || "(untitled)";
    const offset = rt.clockOffsetMs ?? 0;
    return (
        <div class={`chat-row-wrap${active ? " active" : ""}`}>
            <button class={`row chat-row${active ? " active" : ""}`} data-session={key} onClick={() => openSession(key)}>
                <Dot status={DOT[s.status] ?? "pending"} warn={s.status === "capped" ? "Stopped at its step cap. Open it to give it more steps." : undefined} />
                <span class="chat-row-body">
                    <b class="row-title">{truncate(title, 90)}</b>
                    <span class="chat-row-meta">
                        {showRuntime ? <span class="chat-row-rt">{rt.name}</span> : null}
                        {s.kind === "agent" ? <AgentBadge /> : null}
                        {s.page ? <PageChip page={s.page} /> : null}
                        {STATUS_LABEL[s.status] ? <span class={`chat-status st-${s.status}`}>{STATUS_LABEL[s.status]}</span> : null}
                        {s.pendingApprovals > 0 ? <span class="chat-appr-badge">{s.pendingApprovals} approval{s.pendingApprovals === 1 ? "" : "s"}</span> : null}
                    </span>
                </span>
                {moved ? <span class="chat-moved" {...cursorTipOn("Something happened here while you were reading something else")} aria-label="new activity" /> : null}
                <Stamp ts={s.lastTs - offset} snap="right" />
            </button>
            <RowMenu store={store} s={s} rt={rt} title={title} />
        </div>
    );
}

/** How far back the list reaches. Everything older is on the search page, which holds the whole history. */
const RECENT_DAYS = 30;

/** A session's last activity on THIS device's clock (the runtime's clock may be off; `clockOffsetMs` says by how much). */
const localTs = (s: SessionSummary, rt: RuntimeInfo | undefined) => s.lastTs - (rt?.clockOffsetMs ?? 0);

/**
 * The session list: what is pinned, then each runtime's RECENT sessions, then a way to the rest.
 *
 * A session that is still running or waiting on you is recent however long ago it started — the list never files
 * away something that wants you. Everything else past `RECENT_DAYS` lives on the search page (`search-page.tsx`),
 * which both the header's search button and the "Older sessions" row open: one place to find a session, not two.
 */
function SessionList({ store, activeKey, narrow, onStart, gear, gearWide }: { store: ChatStore; activeKey: SessionKey | null; narrow: boolean; onStart: (kind: StartKind) => void; gear: preact.ComponentChildren; gearWide: preact.ComponentChildren }) {
    const runtimes = store.runtimes.value;
    const sessions = store.listed();
    const status = store.status.value;
    const moved = movedSince.value;
    const folded = foldedRuntimes.value;
    const pins = pinned.value;
    const rtOf = new Map(runtimes.map((rt) => [rt.id, rt]));
    const keyOf = (s: SessionSummary) => `${s.id.runtime}:${s.id.hash}`;
    const cutoff = Date.now() - RECENT_DAYS * 86_400_000;
    const live = (s: SessionSummary) => s.status === "running" || s.status === "waiting";
    const isRecent = (s: SessionSummary) => live(s) || localTs(s, rtOf.get(s.id.runtime)) >= cutoff;
    void pins;   // read, so the list re-renders when this device's pins change (`isPinned` reads them too)
    const pinnedRows = sessions.filter((s) => isPinned(s) && rtOf.has(s.id.runtime));
    const olderCount = sessions.filter((s) => !isPinned(s) && !isRecent(s) && rtOf.has(s.id.runtime)).length;
    const row = (s: SessionSummary, showRuntime = false) => {
        const key = keyOf(s);
        return <IndexRow key={key} store={store} s={s} rt={rtOf.get(s.id.runtime)!} active={activeKey === key} moved={moved.has(key)} showRuntime={showRuntime} />;
    };
    return (
        <aside class="chat-list" aria-label="Sessions">
            <div class="head">
                <ListToggle narrow={narrow} /><b>Sessions</b><span class="sp" />
                {status.state !== "online" ? <span class="chat-chip warn">{status.state === "connecting" ? "connecting…" : "offline"}</span> : null}
                <button class={`tt hbtn${mainView.value === "search" ? " on" : ""}`} aria-label="Search sessions" onClick={openSearch}>
                    <IconSearch /><span class="tt-pop" role="tooltip">Search sessions</span>
                </button>
                <StartMenu store={store} onPick={onStart} icon={<IconCompose />} />{narrow ? gear : null}
            </div>
            <div class="view chat-list-scroll">
                {runtimes.length === 0 && status.state === "online" ? <div class="empty">No runtimes yet. Pair one to see its sessions here.</div> : null}
                {pinnedRows.length ? (
                    <section class="chat-group chat-pinned" aria-label="Pinned">
                        <div class="chat-group-label"><IconPin />Pinned</div>
                        {pinnedRows.map((s) => row(s, runtimes.length > 1))}
                    </section>
                ) : null}
                {runtimes.map((rt) => {
                    const mine = sessions.filter((s) => s.id.runtime === rt.id && !isPinned(s) && isRecent(s));
                    const shut = folded.has(rt.id);
                    return (
                        <section class={`chat-group${shut ? " folded" : ""}`} key={rt.id}>
                            <RuntimeHead rt={rt} folded={shut} />
                            {/* Mounted while folded, so folding slides both ways; `inert` keeps a folded group's rows out of reach. */}
                            <div class="chat-group-body" inert={shut}>
                                <div class="chat-group-rows">
                                    {!speaksOurContract(rt)
                                        ? <div class="chat-rt-empty">This runtime speaks version {rt.contractVersion} of the session contract, which this app does not. Its sessions open once both sides agree.</div>
                                        : mine.length
                                            ? mine.map((s) => row(s))
                                            : <div class="chat-rt-empty">Nothing in the last {RECENT_DAYS} days.</div>}
                                </div>
                            </div>
                        </section>
                    );
                })}
                {olderCount ? (
                    <button class="chat-older-go" onClick={openSearch}>
                        <IconHistory /><span>Older sessions</span><span class="chat-older-n">{olderCount}</span>
                    </button>
                ) : null}
            </div>
            {narrow ? null : <div class="chat-list-foot">{gearWide}</div>}
        </aside>
    );
}

/**
 * The top of a transcript that does not reach its session's start: where earlier events come from.
 *
 * Three different sentences, never drawn alike. MORE: an older page exists on the runtime, and it is fetched as you
 * scroll up to this edge (the search page's sentinel), with the reading position held so the text you were on does
 * not jump when a page lands above it. TRUNCATED: older events no longer exist anywhere, and what is shown is what
 * this device kept. A FAILED page says the runtime's reason and offers the fetch again, where the page would have
 * been rather than as a notice. The store does the paging (`loadEarlier`); this only asks for it and says what is so.
 */
function EarlierEdge({ store, sessionKey, scroller, rtName, truncated }: {
    store: ChatStore; sessionKey: SessionKey; scroller: { current: HTMLDivElement | null }; rtName?: string; truncated: boolean;
}) {
    const at = store.earlier.value.get(sessionKey);
    const sentinel = useRef<HTMLDivElement>(null);
    // Where the reader was when a page was asked for: its distance from the BOTTOM of the content, which is what a
    // page landing above leaves unchanged.
    const anchor = useRef<number | null>(null);
    const more = !!at?.more && !at.error;
    const load = () => {
        const el = scroller.current;
        if (el) anchor.current = el.scrollHeight - el.scrollTop;
        void store.loadEarlier(sessionKey);
    };
    useEffect(() => {
        const el = sentinel.current, root = scroller.current;
        if (!el || !root || !more || at?.loading || typeof IntersectionObserver !== "function") return;
        const io = new IntersectionObserver((es) => { if (es.some((e) => e.isIntersecting)) load(); }, { root, rootMargin: "200px 0px 0px 0px" });
        io.observe(el);
        return () => io.disconnect();
    }, [sessionKey, more, at?.loading, at?.from]);
    // A page landed: put the reader back where they were, measured from the bottom.
    useLayoutEffect(() => {
        const el = scroller.current;
        if (!el || anchor.current == null || at?.loading) return;
        el.scrollTop = el.scrollHeight - anchor.current;
        anchor.current = null;
    }, [at?.from, at?.loading]);
    if (at?.error) {
        return (
            <div class="chat-earlier err" role="status">
                <span>Earlier events could not be loaded: {at.error}</span>
                <button class="chat-earlier-retry" onClick={load}>Try again</button>
            </div>
        );
    }
    if (at?.loading) return <div class="chat-earlier" role="status">Loading earlier events…</div>;
    if (more) return <div class="chat-earlier" ref={sentinel}><button class="chat-earlier-retry" onClick={load}>Earlier events</button></div>;
    if (truncated || at?.truncated) {
        return <div class="chat-truncated">Older events no longer exist on {rtName ?? "the runtime"}. What is shown here is what this device kept.</div>;
    }
    return null;
}

/** One session: its header, the transcript and, where this device may drive it, the composer. */
/**
 * One open session: its header, the transcript, and the composer (or why there is none). With `native`, only the
 * transcript: the phone app's shell draws the header, the waiting bar and the composer itself (src/chat/native-embed.tsx,
 * docs/spec/NATIVE_SHELL.md), and the title leads the transcript as it does on a wide calm page.
 */
export function SessionPane({ store, sessionKey, narrow, extras, native, onGate }: { store: ChatStore; sessionKey: SessionKey; narrow: boolean; extras?: ChatExtras; native?: boolean; onGate?: (away: boolean) => void }) {
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
    // The phone app draws its own bar, from the same reading: it is chrome, and chrome up there is native.
    useEffect(() => onGate?.(waiting && gateAway), [onGate, waiting, gateAway]);
    // A citation whose step nothing can produce any more (not drawn, not loaded, not in the session's history) says
    // so: the click asked for something, and a transcript that neither moves nor speaks reads as a broken link.
    useEffect(() => {
        const said = (): void => store.notify("That step is no longer in this session's history.", "info");
        document.addEventListener(STEP_GONE_EVENT, said);
        return () => document.removeEventListener(STEP_GONE_EVENT, said);
    }, [store]);

    // NO HEADER BAND on a wide calm page: what it held has gone where each part belongs — the title into the
    // transcript (`Lede`), navigation and the page's tools to the left edge (the rail and the gear, `nav.tsx`). A
    // phone keeps the bar: it holds the way back, and there is no room for a rail beside a 390px column.
    const bare = native || (calm.value && !narrow);
    const peek = usePeek(store, id ?? null, rt, sessionKey, summary);
    // ON A WIDE PAGE THE MODEL SITS IN THE COMPOSER, beside send: it is what the NEXT message goes to, so it belongs
    // where that message is written, and a pill in a header read as a stray control. A phone keeps it in its bar
    // (there is no room in a 390px box), and so does a session with no composer, where it is only information.
    const modelBelow = !narrow && !native && !!summary?.model && !!rt && canDrive && !canResume;
    return (
        <main class="chat-main" data-rev={r} data-session={sessionKey}>
            {bare
                ? null
                : <div class="head chat-head">
                    {narrow ? <button class="hbtn chat-sheet-back" aria-label="Back to sessions" onClick={() => (pushedEntry ? history.back() : (view.value = { name: "list" }))}><IconBack /></button> : null}
                    {/* A PHONE leads with the MODEL: the title is on the row you tapped to get here, and a 390px bar
                        spent on it again says nothing new, where the model is what the next reply comes from. The
                        title is still one tap away, at the top of the ⋮ menu. */}
                    <span class="chat-head-title">
                        {narrow && summary?.model && rt ? <ModelTop store={store} rt={rt} model={summary.model} sessionKey={sessionKey} summary={summary} /> : <b>{truncate(title, 120)}</b>}
                        <span class="chat-head-sub">
                            {rt?.name ?? id?.runtime}
                            {summary?.page ? <> · <PageChip page={summary.page} onShow={tabFocus(store, rt, summary)} /></> : null}
                        </span>
                    </span>
                    <span class="sp" />
                    {!narrow && !modelBelow && summary?.model && rt ? <ModelTop store={store} rt={rt} model={summary.model} sessionKey={sessionKey} summary={summary} /> : null}
                    {narrow ? <SessionMenu peek={peek} hash={id?.hash} title={summary?.model ? title : undefined} /> : <>
                        <PagePeek peek={peek} />
                        <DeviceViews extras={extras} rt={rt} />
                        <ViewToggle />
                        {id ? <Hash hash={id.hash} /> : null}
                    </>}
                </div>}
            {!native && waiting && (gateAway || !calm.value) ? <button class="chat-waiting" onClick={jumpToApproval}>Waiting on your approval<span class="chat-waiting-go">Review ›</span></button> : null}
            <div class="view chat-transcript" ref={scroller} onScroll={onScroll}>
                <div ref={content}>
                    {bare ? <Lede title={title} rt={rt} summary={summary} id={id} store={store} sessionKey={sessionKey} native={native || modelBelow} /> : null}
                    <EarlierEdge store={store} sessionKey={sessionKey} scroller={scroller} rtName={rt?.name} truncated={truncated} />
                    {s ? <DetailView hash={sessionKey} />
                        : !summary && !rt ? <div class="empty">Session not found.</div>
                            : <div class="empty">Loading…</div>}
                </div>
            </div>
            {/* A run whose page is gone cannot be sent to, so the composer is replaced by the one thing that WOULD
                work: picking it up somewhere else. `canResume` is false while its tab is still open, so the two
                never both offer to continue the same run. */}
            {native ? null : canResume && id && rt ? (
                resuming
                    ? <ResumeSession store={store} rt={rt} session={{ runtime: id.runtime, hash: id.hash }}
                        onResumed={() => setResuming(false)} onCancel={() => setResuming(false)} />
                    : <button class="chat-resume" onClick={() => setResuming(true)}>
                        <span class="chat-resume-what">The tab this run worked in has closed.</span><span class="chat-resume-go">Resume on a page</span>
                    </button>
            ) : s && canDrive ? <Composer s={s} multiline
                tools={modelBelow && summary?.model && rt ? <ModelTop store={store} rt={rt} model={summary.model} sessionKey={sessionKey} summary={summary} quiet /> : undefined} />
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

/**
 * WHAT YOU ARE READING, at the top of it rather than in a band above it.
 *
 * The header was a permanent strip holding a title you need once — when you arrive — and never again while you
 * read. Here it is the transcript's first line, so it is there when you land on the session and gone the moment
 * you scroll, which is exactly how long it is worth the room.
 */
function Lede({ title, rt, summary, id, store, sessionKey, native }: {
    title: string; rt?: RuntimeInfo; summary?: SessionSummary; id: SessionId | null; store: ChatStore; sessionKey: SessionKey;
    /** the model is shown elsewhere: the phone app's header, or a wide page's composer */
    native?: boolean;
}) {
    const show = tabFocus(store, rt, summary);
    const peek = usePeek(store, id, rt, sessionKey, summary);
    return (
        <div class="chat-lede">
            <b class="chat-lede-title">{truncate(title, 120)}</b>
            {/* THE MODEL IS PART OF WHAT THIS SESSION IS, not a control sitting above it. On its own line it drew as a
                filled pill under the title with nothing to do with the title, and read as a stray dropdown. Here it
                joins the line that already says where the session runs and what page it is on, in the same quiet text
                the composer's picker uses: still openable, no longer announcing itself. */}
            <span class="chat-lede-sub">
                {rt?.name ?? id?.runtime}
                {summary?.page ? <> · <PageChip page={summary.page} onShow={show} /></> : null}
                <PagePeek peek={peek} />
                {!native && summary?.model && rt
                    ? <><span class="chat-lede-sep" aria-hidden="true">·</span><ModelTop store={store} rt={rt} model={summary.model} sessionKey={sessionKey} summary={summary} quiet /></>
                    : null}
            </span>
        </div>
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
    // Centred on the column being read, not the window: beside a session list (and a dock) the window's middle is
    // off to one side of the thread. The column is measured, because the list folds and the dock opens.
    const [mid, setMid] = useState<number | null>(null);
    useEffect(() => {
        if (!list.length) return;
        const main = document.querySelector<HTMLElement>(".chat-main");
        if (!main) { setMid(null); return; }
        const place = () => { const r = main.getBoundingClientRect(); setMid(r.left + r.width / 2); };
        place();
        const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(place);
        ro?.observe(main);
        addEventListener("resize", place);
        return () => { ro?.disconnect(); removeEventListener("resize", place); };
    }, [list.length > 0]);
    if (!list.length) return null;
    return (
        <div class="chat-notices" role="status" aria-live="polite" style={mid == null ? undefined : `left:${mid}px`}>
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
    // Asked per VIEW: reading a session on a machine that has no graphs must not take the graphs of one that does out
    // of the menu. Every label names the machine it describes, so falling back is never ambiguous about whose it is.
    const offering = (can: (r: RuntimeInfo) => boolean): RuntimeInfo | undefined =>
        openRt && can(openRt) ? openRt : store.runtimes.value.find((r) => r.online && can(r));
    const graphsRt = offering((r) => !!r.capabilities.resourcePanel && extras?.resourcePanel?.(r.id) != null);
    const benchOwner = offering((r) => !!r.capabilities.pythonBench && extras?.bench?.(r.id) != null);
    const aside = pane.value === "resource" && graphsRt ? extras?.resourcePanel?.(graphsRt.id) : null;
    const bench = benchOpen.value && benchOwner ? extras?.bench?.(benchOwner.id) : null;
    // The open panels, for the dock to place (dock.tsx): each is docked where this device last put it.
    const panels: DockPanel[] = [];
    if (aside) panels.push({ id: "resource", title: "Resources", icon: <IconVram />, body: aside, close: () => setPane(null),
        tip: `What ${graphsRt!.name} is running, and what it is using` });
    if (bench) panels.push({ id: "bench", title: "Python bench", icon: <IconBench />, body: bench, close: () => { benchOpen.value = false; },
        tip: `Python against ${benchOwner!.name}'s sandbox, the one a run's python_exec uses` });
    // The runtime whose settings this device may edit: one that reports `localSettings` and this device can draw.
    // Not gated on `online`: these read and write this browser's own storage, which needs no worker, and the browser
    // stops an idle worker every half minute, which took the Extension tab away with it.
    const settingsRt = store.runtimes.value.find((r) => r.capabilities.localSettings && extras?.settings?.(r.id) != null);
    const main = mainView.value;
    useMovedSince(store, key);
    useEffect(() => { if (key) store.open(key); else store.close(); }, [key]);
    useEffect(() => { if (key) { setStarting(null); mainView.value = null; } }, [key]);   // opening a session puts the form and the search page away
    // The compose button opens the start page: it closes whatever is open, because the start page IS the empty page.
    const start = (k: StartKind) => { mainView.value = null; setStarting(k); if (key) view.value = { name: "list" }; };
    // Held through a worker restart (START_GRACE_MS): the page does not trade the start page for "Pick a session" and
    // back each time the browser stops an idle worker.
    const canStart = useHeldTrue(startableOn(store, "agent").length > 0 || startableOn(store, "chat").length > 0, START_GRACE_MS);
    const att = useAttention(store, extras);
    const gear = <><AttentionButton items={att.items} /><GearMenu graphsRt={graphsRt} benchRt={benchOwner} /></>;
    const gearWide = <><AttentionButton items={att.items} labelled /><GearMenu graphsRt={graphsRt} benchRt={benchOwner} labelled /></>;
    // The sheet is always there: this page's own display settings need no runtime; the browser's settings join them
    // where a runtime offers them and this device can draw them.
    const browserSettings = settingsRt ? extras?.settings?.(settingsRt.id) : null;
    const housekeeping = settingsRt ? extras?.housekeeping?.(settingsRt.id) : null;
    return (
        <div class={`chat${narrow ? " narrow" : ""}${calm.value ? " calm" : ""}${!narrow && !listOpen.value ? " list-hidden" : ""}`}
            style={{ "--code-fs": `${codeSize.value}px`, "--panel-fs": `${panelSize.value}px` }}>
            <ContextMenu />
            <CursorTipLayer />
            {!narrow && !listOpen.value ? <Rail store={store} onStart={start} gear={gear} /> : null}
            {(!narrow || (!key && !starting && !main)) ? <SessionList store={store} activeKey={key} narrow={narrow} onStart={start} gear={gear} gearWide={gearWide} /> : null}
            <DockFrame panels={panels} narrow={narrow}>
            {main === "search" && (!narrow || !key) ? <SearchPage store={store} narrow={narrow} />
                : main === "attention" ? <AttentionPage items={att.items} extras={extras} />
                : main === "settings" ? <SettingsPage browser={browserSettings} housekeeping={housekeeping} pairing={platform.pairing} store={store} />
                : (starting || (!key && !narrow)) && canStart ? (
                    <main class="chat-main chat-home">
                        {calm.value || narrow ? null : (
                            <div class="head chat-head">
                                <span class="sp" />
                                <DeviceViews extras={extras} rt={graphsRt ?? benchOwner} />
                                <ViewToggle />
                            </div>
                        )}
                        {narrow ? <button class="hbtn chat-sheet-back chat-home-back" aria-label="Back to sessions" onClick={() => setStarting(null)}><IconBack /></button> : null}
                        <StartPage store={store} extras={extras} narrow={narrow} initialKind={starting ?? undefined} onStarted={(k) => { setStarting(null); openSession(k); }} />
                    </main>
                )
                    : key ? <SessionPane store={store} sessionKey={key} narrow={narrow} />
                        : !narrow ? (
                            <main class="chat-main">
                                {/* The same shape as an open session: nothing across the top on a calm page, the
                                    way back and the page's tools at the left edge. */}
                                {calm.value ? null : (
                                    <div class="head chat-head">
                                        <span class="sp" />
                                        <DeviceViews extras={extras} rt={graphsRt ?? benchOwner} />
                                        <ViewToggle />
                                    </div>
                                )}
                                <div class="empty chat-pick">Pick a session.</div>
                            </main>
                        ) : null}
            </DockFrame>
            <Notices store={store} />
            <Lightbox platform={platform} />
            <DeleteConfirm store={store} />
            <RenameDialog store={store} />
        </div>
    );
}
