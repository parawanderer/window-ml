// Debug sidebar — isolated content-script world, built with Preact. An opt-in,
// slide-out panel that logs every window.ml call, grouped into sessions (one per
// createChat). injected.js pushes a one-way event stream over window.postMessage
// ({ __mlDebug: MlDebugEvent }); we aggregate events into sessions by hash and
// render a list ⇄ detail UI. Bundled (Preact + signals) into dist/sidebar.js only
// — the core primitive stays dependency-free.
import { render } from "preact";
import { useState, useEffect, useRef } from "preact/hooks";
import type { MlDebugEvent, MlConfig, ElementContext } from "../contract";
import { DEFAULT_CONFIG } from "../contract";
import {
    FONT_KEY, WRAP_KEY, LINES_KEY, STATS_TOKENS_KEY, STATS_TPS_KEY, OUTMAX_KEY, OUTMAX_DEFAULT, OUTTS_KEY, RESWIN_KEY, RESWIN_DEFAULT, VRAMH_KEY, LANE_HIDDEN_KEY, laneHidden, LANE_SCOPE_KEY, laneScoped, SECTIONS_KEY, showLane, showModels, FOCUS_KEY, focusMode,
    sessionMap, rev, view, fontScale, codeWrap, codeLineNumbers, showStatsTokens, showStatsTps, outMaxH, showOutTimes, config,
    vramOpen, sidebarOpen, backendError, surface, atBottom, resWindowS, vramH } from "./store";
import { installTooltipLayer } from "./tooltip-layer";
import { ContextMenu, Hash, highlightPos } from "./ui-kit";
import type { InvocationInfo } from "../contract";
import { onDebug, maybeGenerateTitles, titleTried } from "./debug-reducer";
import { OptionsBlock, MessageTurn, ProfileBadge, SessionRow, AgentBadge, EmbedRunView } from "./reply";
import { AgentRunView } from "./agent-detail";
import { Composer } from "./composer";
import { fetchModels, pollPs, connectResourceStream, pollBackendHealth, VramPanel, PythonBench, ModelStatusDot, BACKEND_HEALTH_MS, VRAM_POLL_MS, VRAM_PALETTE_KEY, VRAM_PALETTES, vramPalette } from "./vram";
import { CardApp, endActiveCardDrag } from "./hud-card";
import {
    composerOpen, composerElement, composerTarget, selectedRun, cardSteerHash, setCardCollapsed,
} from "./card-state";
import { shownModel, sessionProfile } from "./model";
import { exportSession, exportSessionJson, printSession } from "./export";
import { applyTheme, applyFont, applyCodePrefs, applyFocus, initThemeStyle } from "./prefs";
import { IconWarn, IconGear, IconExport, IconVram, IconBench, IconTools, IconEye, IconEyeOff } from "./icons";
import { Settings, openSettingsAt } from "./settings";


/* ------------------------------ components ------------------------------- */




function ListView() {
    // `r` subscribes this view to session changes AND resolving model/profile
    // here (reads config) keeps that signal read out of SessionRow. Retained in
    // data-rev so the subscription survives minification.
    const r = rev.value;
    const list = [...sessionMap.values()].sort((a, b) => b.lastTs - a.lastTs);
    if (!list.length) return <EmptySessions rev={r} />;
    return <div class="list" data-rev={r}>{list.map(s => <SessionRow key={s.hash} s={s} profile={sessionProfile(s)} />)}</div>;
}

/** The shortcut that opens the HUD composer on THIS install, or "" when the user cleared it. Read live from
 *  chrome.commands (GET_INVOCATION) rather than hardcoded: it is user-rebindable, and naming a key that does
 *  nothing is worse than not mentioning one. Null until the answer arrives. */
function useInvocation(): InvocationInfo | null {
    const [info, setInfo] = useState<InvocationInfo | null>(null);
    useEffect(() => {
        try {
            chrome.runtime.sendMessage({ type: "GET_INVOCATION", payload: {} }, (resp: any) => {
                if (chrome.runtime.lastError || !resp || resp.error) return;
                setInfo(resp.data || null);
            });
        } catch { /* no runtime (a test harness) — the console line stands on its own */ }
    }, []);
    return info;
}

/** A keyboard shortcut as its own keys: "Alt+Space" → [Alt][Space]. */
export function KeyPill({ combo }: { combo: string }) {
    return (
        <span class="keys">
            {combo.split("+").map((k, i) => <kbd class="key" key={i}>{k}</kbd>)}
        </span>
    );
}

function EmptySessions({ rev }: { rev: number }) {
    const inv = useInvocation();
    // Only offer the shortcut when one is actually bound — the user may have cleared it, and pointing at a
    // dead key is worse than saying nothing.
    return (
        <div class="empty" data-rev={rev}>
            No ml calls yet. Run one in the console
            {inv?.shortcut ? <> or press <KeyPill combo={inv.shortcut} /></> : null}.
        </div>
    );
}

function DetailView({ hash }: { hash: string }) {
    // Re-renders via App's rev subscription (App cascades to this pure component);
    // turn updates are immutable (see onDebug) so children re-render too.
    const s = sessionMap.get(hash);
    if (!s) return <div class="empty">Session not found.</div>;
    if (s.kind === "agent") return <AgentRunView s={s} />;
    // An EMBED session is not a conversation. It reports through the chat events — a model call is a model
    // call, and reusing the machinery costs no new event kind — but rendering it as user/assistant bubbles
    // presents a request for vectors as something somebody said, which is where the confusion starts.
    if (s.kind === "embed") return <EmbedRunView s={s} />;
    return <><OptionsBlock s={s} />{s.turns.map(t => <MessageTurn key={t.id} t={t} hash={s.hash} />)}</>;
}


// Export button + its format menu. Two shapes of the same log: a markdown bundle
// (for a coding assistant — screenshots as real .png sidecars) or a PDF via the
// print dialog (for a human). Dismissed by a pointerdown outside, or Escape.
function ExportMenu({ hash }: { hash: string }) {
    const [open, setOpen] = useState(false);
    const wrap = useRef<HTMLSpanElement>(null);
    useEffect(() => {
        if (!open) return;
        // A pointerdown inside the wrapper is the trigger's own (its onClick
        // toggles) or an item's (its onClick closes) — closing here too would
        // fight them, so ignore anything within.
        const onDown = (e: Event) => { if (!wrap.current?.contains(e.target as Node)) setOpen(false); };
        const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
        document.addEventListener("pointerdown", onDown);
        document.addEventListener("keydown", onKey);
        return () => { document.removeEventListener("pointerdown", onDown); document.removeEventListener("keydown", onKey); };
    }, [open]);
    const pick = (fn: (h: string) => void) => { setOpen(false); fn(hash); };
    return (
        <span class="menuwrap" ref={wrap}>
            <button class={`tt hbtn${open ? " on" : ""}`} aria-label="Export log" aria-haspopup="menu" aria-expanded={open}
                onClick={() => setOpen(o => !o)}>
                <IconExport />
                {open ? null : <span class="tt-pop" role="tooltip">Export log</span>}
            </button>
            {open ? (
                <div class="menu" role="menu">
                    <button class="menu-item" role="menuitem" onClick={() => pick(exportSession)}>
                        Markdown<span class="menu-hint">.zip with screenshots</span>
                    </button>
                    <button class="menu-item" role="menuitem" onClick={() => pick(printSession)}>
                        PDF<span class="menu-hint">opens the print dialog</span>
                    </button>
                    <button class="menu-item" role="menuitem" onClick={() => pick(exportSessionJson)}>
                        JSON<span class="menu-hint">for other programs</span>
                    </button>
                </div>
            ) : null}
        </span>
    );
}


// Top-level switch: the off-mode card or the full slide-out panel. Kept separate (not a branch inside
// App) so App's hooks/effects — the ps polling, stick-to-bottom, title backfill — never run for the
// card, which needs none of them.
function Root() {
    // Proactive backend health, in BOTH surfaces: a dead box must surface even when a run fails silently or
    // HANGS (no error event). The panel is mounted whenever devtools/overlay is up; the off-mode card is
    // mounted while a run is active — exactly when a stuck "Starting…" would otherwise hang with no signal.
    useEffect(() => {
        pollBackendHealth();
        const id = setInterval(pollBackendHealth, BACKEND_HEALTH_MS);
        return () => clearInterval(id);
    }, []);
    return surface.value === "card" ? <CardApp /> : <App />;
}

// atBottom now lives in ./store (shared with agent-detail's ToolStep).

// A persistent, top-of-panel banner shown when the backend is UNREACHABLE (server down / wrong host /
// refused) — so a dead box reads at a glance in the devtools panel + overlay, without drilling into the
// failed run. Set/cleared in onDebug (backendError); the URL comes from the (cached) config so it shows even
// while nothing on the backend answers.
function BackendOfflineBanner() {
    const msg = backendError.value;
    if (!msg) return null;
    const url = config.value.chatUrl || "";
    return (
        <div class="backend-offline" role="alert">
            <IconWarn />
            <div class="bo-body">
                <b class="bo-title">Backend unreachable</b>
                <span class="bo-detail">Couldn't reach your server{url ? <> at <code>{url}</code></> : null}. Is it running? Check the Server URL / API format in Settings.</span>
            </div>
        </div>
    );
}

function App() {
    const v = view.value;
    // Subscribe to session-data changes. This read MUST land in always-rendered
    // output (the data-rev on .view below) — NOT a bare `rev.value;` statement
    // (minification drops it as dead code) and NOT a value used in only one
    // branch (minification inlines it into that branch). Either mistake leaves
    // the detail view subscribed to nothing, so a result that arrives while it's
    // open updates the turn's data but never re-renders (stale "…thinking").
    const r = rev.value;
    // The iframe body IS the panel; the slide-out shell (tab/resize/container)
    // lives in the content-script host (sidebar/shell.ts), not here.
    const inSettings = v.name === "settings";
    const inBench = v.name === "bench";
    const detailSession = v.name === "detail" ? sessionMap.get(v.hash) : null;
    // Lazily summarise session titles whenever the data or open-state changes.
    // `open` is read (not just used in deps) so App re-renders on open/close.
    const open = sidebarOpen.value;
    // `utilModel`/`autoTitles` are deps so enabling them later backfills sessions.
    const utilModel = config.value.utilityModel;
    const autoTitles = config.value.autoTitles;
    useEffect(() => { maybeGenerateTitles(); }, [r, open, utilModel, autoTitles]);
    // Poll Ollama's resident set for the VRAM panel + the header status dot: a
    // steady interval, plus an immediate poll whenever the view/open-state
    // changes (so the dot resolves promptly on navigation). pollPs self-gates.
    useEffect(() => {
        const id = setInterval(pollPs, VRAM_POLL_MS);
        return () => clearInterval(id);
    }, []);
    // The live feed, when the server has one, and ONLY while something is looking at it. Gated exactly like
    // the poll above (which self-gates internally): the overlay app is mounted in every tab, so subscribing on
    // mount would have every tab holding a subscription for a panel nobody has open. The interval STAYS
    // regardless — it stands down while the stream carries and comes back on its own if it drops, so a stock
    // Ollama with no /api/events at all is served by exactly the same code path it always was.
    const feedWanted = open && (vramOpen.value || v.name === "detail");
    useEffect(() => (feedWanted ? connectResourceStream() : undefined), [feedWanted]);
    useEffect(() => { pollPs(); }, [v.name, vramOpen.value, open]);
    // Stick-to-bottom: while a session's detail is open and the user is parked at the bottom,
    // keep the log pinned to the latest as it grows — but if they've scrolled UP to read, leave
    // them there. `atBottom.v` (module-level so ToolStep can consult it too) tracks intent,
    // recomputed on every manual scroll. Opening a detail jumps to the latest and re-sticks.
    const viewRef = useRef<HTMLDivElement>(null);
    const contentRef = useRef<HTMLDivElement>(null);
    // While a SMOOTH auto-pin is animating, the scroll events it emits show scrollTop short of the
    // bottom — onViewScroll must NOT read those as "the user scrolled up" (that flip mid-animation is
    // what made the pin give up and pop/stick-fail). So suppress recomputation while pinning, and clear
    // the flag once we've actually reached the bottom. A real user gesture (wheel/touch) clears it too,
    // so they can always break away from the follow.
    const pinning = useRef(false);
    const onViewScroll = () => {
        const el = viewRef.current;
        if (!el) return;
        const dist = el.scrollHeight - el.scrollTop - el.clientHeight;
        if (pinning.current) { if (dist < 4) { pinning.current = false; atBottom.v = true; } return; }
        atBottom.v = dist < 40;
    };
    const endPin = () => { pinning.current = false; };   // a user scroll gesture cancels the auto-follow
    /**
     * A wheel over the RESOURCE PANEL scrolls the transcript underneath it.
     *
     * The panel is a fixed-height sibling of the scroll container rather than content inside it, so a wheel
     * with the pointer resting on the chart had nothing to scroll and the gesture simply did nothing. Where
     * the pointer happens to be sitting is not a reason for the page to stop responding.
     *
     * Forwarded only when the panel cannot take the scroll itself: dragged tall enough to overflow, it
     * scrolls its own content first and this hands over only at the ends. `deltaMode` is honoured because a
     * mouse wheel reports LINES and a page key reports PAGES, and treating either as pixels moves the view
     * by a few pixels for a gesture that meant a screenful.
     */
    const wheelThroughPanel = (e: WheelEvent) => {
        const target = e.target as Element | null;
        // The CHART claims the wheel for itself — there it scrubs the window along the session (see
        // `wheelScrub`), which is a different and more specific meaning than "scroll the page". It calls
        // preventDefault when it acts, so anything still arriving here from inside the chart is a gesture it
        // declined, and should scroll like everywhere else in the panel.
        if (e.defaultPrevented) return;
        const panel = target?.closest?.(".vram") as HTMLElement | null;
        if (!panel) return;
        const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaMode === 2 ? e.deltaY * panel.clientHeight : e.deltaY;
        const room = panel.scrollHeight - panel.clientHeight;
        if (room > 1 && ((dy < 0 && panel.scrollTop > 0) || (dy > 0 && panel.scrollTop < room - 1))) return;
        const el = viewRef.current;
        if (!el) return;
        endPin();
        el.scrollTop += dy;
        e.preventDefault();
    };
    const pinBottom = (smooth: boolean) => {
        const el = viewRef.current;
        if (!el) return;
        if (smooth && el.scrollTo) { pinning.current = true; atBottom.v = true; el.scrollTo({ top: el.scrollHeight, behavior: "smooth" }); }
        else { pinning.current = false; el.scrollTop = el.scrollHeight; }   // instant (open jump / jsdom)
    };
    const detailKey = v.name === "detail" ? v.hash : "";
    // Open/switch a detail → jump straight to the latest and re-stick.
    useEffect(() => { if (detailKey) { pinBottom(false); atBottom.v = true; } }, [detailKey]);
    // Re-pin (smoothly) whenever the content's HEIGHT changes while stuck — this is the key: a new
    // event, an approval prompt or its revealed Out, a screenshot finishing loading, or streaming all
    // grow the content AFTER the render commits, which a render-keyed effect would miss (it scrolled to
    // the old height). A ResizeObserver catches every one. (Guarded for jsdom, which lacks it.)
    useEffect(() => {
        const content = contentRef.current;
        if (!detailKey || !content || typeof ResizeObserver === "undefined") return;
        const ro = new ResizeObserver(() => { if (atBottom.v) pinBottom(true); });
        ro.observe(content);
        return () => ro.disconnect();
    }, [detailKey]);
    return (
        <div class="app" onWheel={wheelThroughPanel}>
            <ContextMenu />
            <div class="head">
                {v.name !== "list" ? <button class="tt nav" aria-label="Back to sessions" onClick={() => (view.value = { name: "list" })}>‹<span class="tt-pop left" role="tooltip">Back to sessions</span></button> : null}
                {detailSession
                    ? <>
                        <ModelStatusDot model={shownModel(detailSession)} inFlight={detailSession.status === "pending"} />
                        <span class="tt head-model">{shownModel(detailSession)}<span class="tt-pop left" role="tooltip">The model that will respond to your next message in this session.</span></span>
                        <ProfileBadge profile={sessionProfile(detailSession)} />
                        {detailSession.kind === "agent" ? <AgentBadge /> : null}
                    </>
                    : <b>{inSettings ? "Settings" : inBench ? "Python bench" : `Sessions (${sessionMap.size})`}</b>}
                <span class="sp" />
                {v.name === "detail" ? <Hash hash={v.hash} /> : null}
                {v.name === "detail" ? <ExportMenu hash={v.hash} /> : null}
                {/* Focus mode: read the transcript as a conversation. Only offered on a DETAIL view, because
                    it quiets things that only exist there. Nothing is removed from the session — every
                    disclosure still opens, the export is unchanged, and turning it off brings it all back. */}
                {v.name === "detail"
                    ? <button class={`tt hbtn${focusMode.value ? " on" : ""}`} aria-label="Focus mode" aria-pressed={focusMode.value}
                        onClick={() => { focusMode.value = !focusMode.value; applyFocus(); chrome.storage.local.set({ [FOCUS_KEY]: focusMode.value }); }}>
                        {focusMode.value ? <IconEyeOff /> : <IconEye />}
                        <span class="tt-pop" role="tooltip">{focusMode.value ? "Focus mode on — show the step counters, badges and controls again" : "Focus mode — read it as a conversation, quieting step counters, badges and controls"}</span>
                    </button>
                    : null}
                {!inSettings && !inBench ? <button class={`tt hbtn${vramOpen.value ? " on" : ""}`} aria-label="VRAM monitor" onClick={() => (vramOpen.value = !vramOpen.value)}><IconVram /><span class="tt-pop" role="tooltip">VRAM monitor</span></button> : null}
                {!inSettings && !inBench ? <button class="tt hbtn" aria-label="Python bench" onClick={() => (view.value = { name: "bench" })}><IconBench /><span class="tt-pop" role="tooltip">Python bench — run scripts in the sandbox</span></button> : null}
                {/* Straight to the server-tool list, which is a thing you go looking for rather than a
                    setting you happen to pass — it is where you choose what an agent may reach for. */}
                {!inSettings && !inBench ? <button class="tt hbtn" aria-label="Server tools" onClick={() => { fetchModels(); openSettingsAt("advanced", "servertools"); }}><IconTools /><span class="tt-pop" role="tooltip">Server-side tools — choose what agents can call</span></button> : null}
                {!inSettings && !inBench ? <button class="tt hbtn" aria-label="Settings" onClick={() => { fetchModels(); view.value = { name: "settings" }; }}><IconGear /><span class="tt-pop" role="tooltip">Settings</span></button> : null}
            </div>
            <BackendOfflineBanner />
            {vramOpen.value && !inSettings && !inBench ? <VramPanel /> : null}
            <div class="view" data-rev={r} ref={viewRef} onScroll={onViewScroll} onWheel={endPin} onTouchMove={endPin}>
                <div ref={contentRef}>
                    {v.name === "settings" ? <Settings />
                        : v.name === "bench" ? <PythonBench />
                            : v.name === "list" ? <ListView />
                                : <DetailView hash={v.hash} />}
                </div>
            </div>
            {/* The run-stats readout lives in the composer's own footer, opposite the context gauge — the two
                are the same kind of fact (what this session has spent, how full it is) and were split across
                the composer, which made the spend line read as part of the transcript above it. */}
            {detailSession ? <Composer s={detailSession} /> : null}
        </div>
    );
}

/* --------------------------------- mount ---------------------------------
 * This runs INSIDE the sidebar iframe (an extension page — sidebar.html), which
 * the host web page can't read across the origin boundary. The content-script
 * shell (sidebar/shell.ts) hosts the iframe, relays each `__mlDebug` event in
 * via postMessage, and owns the slide-out container/tab/resize.
 */
// Debug events are relayed in from the shell (the parent window); a bare page
// can't reach this iframe's message bus across the extension-origin boundary.
// Drop all session state. The DevTools panel reuses one long-lived app across page
// reloads (the overlay gets a fresh iframe each load), so it must be told to clear —
// on a page navigation (ML_DEBUG_RESET) and before a reconnect's authoritative replay.
function resetSessions(): void {
    sessionMap.clear();
    titleTried.clear();
    if (view.value.name === "detail") view.value = { name: "list" };
    rev.value++;
}

function onMessage(e: MessageEvent): void {
    const d = e.data as any;
    if (e.source !== window.parent || !d) return;
    if (d.__mlDebug) onDebug(d.__mlDebug as MlDebugEvent);
    else if (typeof d.__mlHighlightPos === "string") highlightPos.value = d.__mlHighlightPos;   // where the approval target sits on the page
    else if (d.__mlDebugReset) resetSessions();
    else if (typeof d.__mlSidebarSurface === "string") {
        // The shell tells us which surface we are. The off-mode card renders a transparent, curated
        // view — flag <html> so the CSS drops the opaque canvas and the acrylic shows through.
        surface.value = d.__mlSidebarSurface === "card" ? "card" : "panel";
        document.documentElement.dataset.surface = surface.value;
    }
    else if (typeof d.__mlSidebarOpen === "boolean") {
        const wasOpen = sidebarOpen.value;
        sidebarOpen.value = d.__mlSidebarOpen;
        if (d.__mlSidebarOpen && !wasOpen) titleTried.clear();   // fresh open → backfill missing titles
    }
    else if (typeof d.__mlSidebarComposer === "string") { composerOpen.value = d.__mlSidebarComposer === "open"; if (d.__mlSidebarComposer !== "open") composerElement.value = null; }   // Spotlight bar
    else if (d.__mlComposerElement) composerElement.value = d.__mlComposerElement as ElementContext;   // right-click "ask about this" → element pill
    else if (d.__mlAddToCurrentRun) {
        // Right-click "Add to current run": open the composer targeting the OPEN run (append) instead of a
        // fresh one. If nothing's open, degrade to a normal new-run composer so the entry is never a dead-end.
        const cur = selectedRun();
        const ctx = d.__mlAddToCurrentRun.ctx;
        composerElement.value = (ctx && typeof ctx.selector === "string") ? ctx as ElementContext : null;
        composerTarget.value = cur ? { mode: "append", hash: cur.hash } : { mode: "new" };
        composerOpen.value = true;
    }
    else if (d.__mlSidebarCardEndDrag) endActiveCardDrag?.();   // shell's safety net force-ended a stuck drag → clean up our listeners
    else if (d.__mlSteerRun && typeof d.__mlSteerRun.hash === "string") {
        // Orb right-click → "Steer this run…": open the inline steer box on this run's card. Uncollapse it
        // (a collapsed toast can't hold the input) and ask the shell to focus the frame so typing lands.
        cardSteerHash.value = d.__mlSteerRun.hash;
        setCardCollapsed(d.__mlSteerRun.hash, false);
        window.parent.postMessage({ __mlSidebarCardFocus: true }, "*");
    }
}

function mount(): void {
    initThemeStyle();
    const root = document.getElementById("root") || document.body;
    chrome.storage.sync.get(DEFAULT_CONFIG, (cfg: any) => { config.value = cfg as MlConfig; applyTheme(); });
    // ONE floating tooltip layer for the whole surface (see tooltip-layer.ts): nothing clips it, it opens
    // whichever way there is room, and the source nodes stay display:none so their prose is never copied.
    try { installTooltipLayer(document); } catch { /* no DOM in a test harness */ }
    chrome.storage.local.get({ [FONT_KEY]: 1, [WRAP_KEY]: true, [LINES_KEY]: false, [STATS_TOKENS_KEY]: true, [STATS_TPS_KEY]: false, [OUTMAX_KEY]: OUTMAX_DEFAULT, [OUTTS_KEY]: true, [RESWIN_KEY]: RESWIN_DEFAULT, [VRAMH_KEY]: 0, [LANE_HIDDEN_KEY]: [], [LANE_SCOPE_KEY]: true, [SECTIONS_KEY]: null, [VRAM_PALETTE_KEY]: "", [FOCUS_KEY]: false }, (d: any) => {
        if (d[FONT_KEY]) fontScale.value = d[FONT_KEY]; applyFont();
        codeWrap.value = d[WRAP_KEY] !== false; codeLineNumbers.value = !!d[LINES_KEY]; applyCodePrefs();
        showStatsTokens.value = d[STATS_TOKENS_KEY] !== false; showStatsTps.value = !!d[STATS_TPS_KEY];
        if (typeof d[OUTMAX_KEY] === "number") outMaxH.value = d[OUTMAX_KEY];
        if (typeof d[RESWIN_KEY] === "number") resWindowS.value = d[RESWIN_KEY];
        if (Array.isArray(d[LANE_HIDDEN_KEY])) laneHidden.value = d[LANE_HIDDEN_KEY];
        if (typeof d[LANE_SCOPE_KEY] === "boolean") laneScoped.value = d[LANE_SCOPE_KEY];
        // An unknown palette name (a downgrade, a typo in storage) falls back rather than leaving every model
        // colourless, which is what indexing an absent palette would do.
        if (d[VRAM_PALETTE_KEY] && VRAM_PALETTES[d[VRAM_PALETTE_KEY]]) vramPalette.value = d[VRAM_PALETTE_KEY];
        // Absent means never set, which is BOTH shown — not both hidden, which is what reading a missing
        // object as falsy would give and would look like the panel had lost half of itself.
        if (d[SECTIONS_KEY] && typeof d[SECTIONS_KEY] === "object") {
            showLane.value = d[SECTIONS_KEY].lane !== false;
            showModels.value = d[SECTIONS_KEY].models !== false;
        }
        if (typeof d[VRAMH_KEY] === "number") vramH.value = d[VRAMH_KEY];
        showOutTimes.value = d[OUTTS_KEY] !== false;
        focusMode.value = !!d[FOCUS_KEY]; applyFocus();
    });
    applyTheme();
    applyCodePrefs();
    applyFocus();
    fetchModels();
    render(<Root />, root);

    window.addEventListener("message", onMessage);
    // Live-sync config edits made elsewhere (e.g. the popup) into the settings form.
    chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== "sync") return;
        const patch: Record<string, unknown> = {};
        for (const k in changes) patch[k] = changes[k].newValue;
        config.value = { ...config.value, ...patch };
        if (changes.theme) applyTheme();
    });
    // Tell the shell we're listening; it then handshakes injected.js on the page.
    window.parent.postMessage({ __mlSidebarApp: "ready" }, "*");
}

mount();
