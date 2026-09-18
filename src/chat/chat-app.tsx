// THE CHAT PAGE: the session list and one session, over a `ChatStore`. Two panes side by side on a wide screen, one at
// a time on a narrow one (a phone), where the list comes first and a session has a back button. The transcript and
// the composer are the panel's own components (`DetailView`, `Composer`), fed by the same reducer, so a run reads the
// same here as in the DevTools panel.
//
// Rendered by capability and grant, never by "it is local": a runtime this device may only watch gets no composer, an
// offline one says when it was last seen, and one speaking an unknown contract version is listed but not opened.
import { useEffect, useRef, useState } from "preact/hooks";
import type { RuntimeInfo, SessionId, SessionKey, SessionStatus, SessionSummary } from "../session-host";
import { parseSessionKey } from "../session-host";
import { DetailView } from "../sidebar/session-detail";
import { Composer } from "../sidebar/composer";
import { AgentBadge } from "../sidebar/reply";
import { IconCamera } from "../sidebar/icons";
import { services } from "../sidebar/services";
import { ContextMenu, CursorTipLayer, Dot, Hash, Stamp, cursorTipOn } from "../sidebar/ui-kit";
import { rev, sessionMap, view, type Status } from "../sidebar/store";
import { truncate } from "../sidebar/format";
import type { ChatStore } from "./chat-store";
import { mayCommand, speaksOurContract } from "./grants";
import { NewSession, ResumeSession, StartMenu, resumableHere, type StartKind } from "./new-session";
import { ListToggle, ViewToggle, calm, listOpen } from "./view-mode";
import { lightboxSrc } from "./platform";

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
function RuntimeHead({ rt }: { rt: RuntimeInfo }) {
    const watchOnly = !mayCommand(rt, "session.send");
    return (
        <div class={`chat-rt${rt.online ? "" : " off"}`} data-runtime={rt.id}>
            <span class={`chat-rt-dot${rt.online ? " on" : ""}`} aria-hidden="true" />
            <b class="chat-rt-name">{rt.name}</b>
            {!rt.online ? <span class="chat-rt-note">offline{rt.lastSeen ? <> · seen <Stamp ts={rt.lastSeen} /></> : null}</span> : null}
            {rt.online && watchOnly ? <span class="chat-chip">view only</span> : null}
        </div>
    );
}

/** One session in the list, from its index row (the transcript is fetched only when it is opened). */
function IndexRow({ s, rt, active }: { s: SessionSummary; rt: RuntimeInfo; active: boolean }) {
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
            <Stamp ts={s.lastTs - offset} snap="right" />
        </button>
    );
}

/** The session list, grouped by runtime. */
function SessionList({ store, activeKey, narrow, onStart }: { store: ChatStore; activeKey: SessionKey | null; narrow: boolean; onStart: (kind: StartKind) => void }) {
    const runtimes = store.runtimes.value;
    const sessions = store.listed();
    const status = store.status.value;
    return (
        <aside class="chat-list" aria-label="Sessions">
            <div class="head"><ListToggle narrow={narrow} /><b>Sessions</b><span class="sp" />{status.state !== "online" ? <span class="chat-chip warn">{status.state === "connecting" ? "connecting…" : "offline"}</span> : null}<StartMenu store={store} onPick={onStart} />{narrow ? <ViewToggle /> : null}</div>
            <div class="view chat-list-scroll">
                {runtimes.length === 0 && status.state === "online" ? <div class="empty">No runtimes yet. Pair one to see its sessions here.</div> : null}
                {runtimes.map((rt) => {
                    const mine = sessions.filter((s) => s.id.runtime === rt.id);
                    return (
                        <section class="chat-group" key={rt.id}>
                            <RuntimeHead rt={rt} />
                            {!speaksOurContract(rt)
                                ? <div class="chat-rt-empty">This runtime speaks version {rt.contractVersion} of the session contract, which this app does not. Its sessions open once both sides agree.</div>
                                : mine.length
                                    ? mine.map((s) => <IndexRow key={`${s.id.runtime}:${s.id.hash}`} s={s} rt={rt} active={activeKey === `${s.id.runtime}:${s.id.hash}`} />)
                                    : <div class="chat-rt-empty">No sessions.</div>}
                        </section>
                    );
                })}
            </div>
        </aside>
    );
}

/** One session: its header, the transcript and, where this device may drive it, the composer. */
function SessionPane({ store, sessionKey, narrow }: { store: ChatStore; sessionKey: SessionKey; narrow: boolean }) {
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

    const [resuming, setResuming] = useState(false);
    const canDrive = !!rt && rt.online && mayCommand(rt, "session.send", { key: sessionKey, summary }, store.host.self);
    const canResume = resumableHere(rt, sessionKey, summary, store.host.self);
    // A session whose page went away, opened while the form was up: the form is about THIS session, so it closes.
    useEffect(() => setResuming(false), [sessionKey]);
    const title = summary?.title || s?.title || summary?.task || s?.task || "Session";
    const waiting = (summary?.pendingApprovals ?? 0) > 0 && !!rt && mayCommand(rt, "approval.answer", { key: sessionKey, summary }, store.host.self);
    const jumpToApproval = () => (scroller.current?.querySelector(".astep-approve") as HTMLElement | null)?.scrollIntoView({ block: "center", behavior: "smooth" });

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
                <ViewToggle />
                {id ? <Hash hash={id.hash} /> : null}
            </div>
            {waiting ? <button class="chat-waiting" onClick={jumpToApproval}>Waiting on your approval<span class="chat-waiting-go">Review ›</span></button> : null}
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
            ) : s && canDrive ? <Composer s={s} />
                : s && rt ? <div class="chat-readonly">{!rt.online ? `${rt.name} is offline. You can read this session, and send to it once it is back.` : `This device may watch sessions on ${rt.name}, not drive them.`}</div>
                    : null}
        </main>
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

/** The web adapter's full-size image view. */
function Lightbox() {
    const src = lightboxSrc.value;
    useEffect(() => {
        if (!src) return;
        const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") lightboxSrc.value = null; };
        addEventListener("keydown", onKey);
        return () => removeEventListener("keydown", onKey);
    }, [src]);
    if (!src) return null;
    return (
        <div class="chat-lightbox" role="dialog" aria-label="Image" onClick={() => (lightboxSrc.value = null)}>
            <img src={src} alt="" />
        </div>
    );
}

/** The chat page. */
export function ChatApp({ store }: { store: ChatStore }) {
    const narrow = useNarrow();
    useHashRoute();
    const v = view.value;
    const key = v.name === "detail" ? v.hash : null;
    // The new-session form is deliberately NOT in the URL, unlike the open session: it holds what someone is part
    // way through typing, and a link to a half-written message is not a thing anyone wants to share or reload into.
    const [starting, setStarting] = useState<StartKind | null>(null);
    useEffect(() => { if (key) store.open(key); else store.close(); }, [key]);
    useEffect(() => { if (key) setStarting(null); }, [key]);   // opening a session puts the form away
    return (
        <div class={`chat${narrow ? " narrow" : ""}${calm.value ? " calm" : ""}${!narrow && !listOpen.value ? " list-hidden" : ""}`}>
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
                                <ViewToggle />
                            </div>
                            <div class="empty chat-pick">Pick a session.</div>
                        </main>
                    ) : null}
            <Notices store={store} />
            <Lightbox />
        </div>
    );
}
