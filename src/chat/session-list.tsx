// session-list.tsx — THE LIST OF SESSIONS, grouped by the machine each runs on: a runtime's heading and what it can
// be told to do, one row per session, what is waiting on you above everything, and the way back into the older ones.
//
// Extracted from chat-app.tsx, which had grown past 900 lines and was the file this repo's UI work kept landing in.
// It is the half you READ; `chat-app.tsx` keeps the half you operate (the panes, the routing, the shell).
//
// The rows are the PHONE'S rows (mobile/src/screens/ListScreen.tsx) and deliberately so: same order, same glyphs,
// same colours, because the two lists are one list on two devices — see `mobile/AGENTS.md`.

import { signal } from "@preact/signals";
import { useRef, useEffect } from "preact/hooks";
import type { SessionStatus, SessionKey, RuntimeInfo, SessionSummary } from "../session-host";
import { truncate } from "../sidebar/format";
import { IconChevron, IconHistory, IconPin, IconPlus, IconSearch, IconCompose, IconInbox } from "../sidebar/icons";
import { AgentBadge } from "../sidebar/reply";
import type { Status } from "../sidebar/store";
import { Stamp, Dot, cursorTipOn } from "../sidebar/ui-kit";
import type { ChatStore } from "./chat-store";
import { useFadeEdges } from "./fade-edges";
import { mayCommand, speaksOurContract } from "./grants";
import { openSession, mainView, openSearch } from "./nav";
import { startableOn, type StartKind, StartMenu } from "./new-session";
import { PageChip } from "./page-chip";
import { isPinned, RowMenu } from "./row-menu";
import { toggleRuntime, foldedRuntimes, pinned, ListToggle } from "./view-mode";

/** The index's status as the panel's status dot draws it. A run stopped at its cap is `err` underneath (the reducer marks
 *  an answer `err` on `hitCap`), and is DRAWN amber, in the list and the transcript alike: it did not fail. */
const DOT: Record<SessionStatus, Status> = { running: "pending", waiting: "pending", done: "ok", capped: "err", error: "err", cancelled: "err", interrupted: "err" };

/** What each status says in a list, where the dot alone would not tell a waiting run from a working one. */
const STATUS_LABEL: Partial<Record<SessionStatus, string>> = { waiting: "waiting on you", capped: "stopped at its step cap", cancelled: "cancelled", interrupted: "interrupted", error: "failed" };

/** A session's pending approvals, as the one badge that replaces the `waiting` label. PENDING rather than a bare
 *  count, because "1" beside a title reads as a fact about the run rather than as something waiting on the reader —
 *  and without the word "approval", which the badge's colour and its place in a list of runs already say, and which
 *  a phone's row has no width for. The phone's list (mobile/src/screens/ListScreen.tsx) words it the same. */
export const approvalsPending = (n: number): string => `${n} pending`;

/**
 * Sessions whose newest event landed while you were reading something else.
 *
 * Deliberately not stored: it answers "what moved while I was here", which is the brainstorming case — you are
 * talking in one session and the run in the next tab gets somewhere — and not "what is unread", which would mark
 * every session on this device the first time the page is opened and teach everyone to ignore the mark.
 */
const movedSince = signal<ReadonlySet<SessionKey>>(new Set());

/** Follow the index, marking a session whose `lastTs` advances while it is not the one open. */
export function useMovedSince(store: ChatStore, openKey: SessionKey | null): void {
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

/** A runtime's heading in the list: its name, whether it is reachable, and what this device may do there. */
function RuntimeHead({ store, rt, folded, onStart }: { store: ChatStore; rt: RuntimeInfo; folded: boolean; onStart: (kind: StartKind, runtime: string) => void }) {
    const watchOnly = !mayCommand(rt, "session.send");
    // The kind this device would start here: the FIRST one it can, not the page's usual default. A machine that runs
    // agents and not chats must not open the form on Chat and then quietly swap the device out from under the choice.
    const kind = (["agent", "chat"] as const).find((k) => startableOn(store, k).some((r) => r.id === rt.id));
    return (
        // A wrapper with TWO buttons rather than one inside the other: the head is itself a button (it folds the
        // group), and a button cannot hold a button — the same reason a row's `⋮` is a sibling of the row.
        <div class="chat-rt-head">
            <button class={`chat-rt${rt.online ? "" : " off"}${folded ? " folded" : ""}`} data-runtime={rt.id}
                aria-expanded={!folded} onClick={() => toggleRuntime(rt.id)}>
                <span class={`tri${folded ? "" : " open"}`} aria-hidden="true"><IconChevron /></span>
                <span class={`chat-rt-dot${rt.online ? " on" : ""}`} aria-hidden="true" />
                <b class="chat-rt-name">{rt.name}</b>
                {!rt.online ? <span class="chat-rt-note">offline{rt.lastSeen ? <> · seen <Stamp ts={rt.lastSeen} /></> : null}</span> : null}
                {rt.online && watchOnly ? <span class="chat-chip">view only</span> : null}
            </button>
            {/* Only where something can actually be started here. A machine that is offline, or that this device may
                only watch, gets none — a `+` that cannot work is worse than no `+`, and its absence is itself the
                honest signal about which machines can take work. */}
            {kind ? (
                <button class="tt chat-rt-add hbtn" aria-label={`Start a session on ${rt.name}`} onClick={() => onStart(kind, rt.id)}>
                    <IconPlus /><span class="tt-pop" role="tooltip">Start a session on {rt.name}</span>
                </button>
            ) : null}
        </div>
    );
}

/** One session in the list, from its index row (the transcript is fetched only when it is opened). The row and its
 *  `⋮` are siblings in a wrapper rather than one inside the other, because a button cannot hold a button. */
function IndexRow({ store, s, rt, active, moved, showRuntime, showPin, reveal }: { store: ChatStore; s: SessionSummary; rt: RuntimeInfo; active: boolean; moved: boolean; showRuntime?: boolean;
    /** mark it pinned, for a row OUTSIDE the Pinned group — where being in that group is the mark */
    showPin?: boolean;
    /** this row was just REVEALED by "older on this runtime": its place in that page, which staggers the animation.
     *  It plays on mount and never again, which is what makes it say "these are the new ones" rather than decorate. */
    reveal?: number }) {
    const key = `${s.id.runtime}:${s.id.hash}`;
    const title = s.title || s.task || "(untitled)";
    const offset = rt.clockOffsetMs ?? 0;
    return (
        <div class={`chat-row-wrap${active ? " active" : ""}${reveal != null ? " revealed" : ""}`} style={reveal != null ? { "--i": String(reveal) } : undefined}>
            <button class={`row chat-row${active ? " active" : ""}`} data-session={key} onClick={() => openSession(key)}>
                <Dot status={DOT[s.status] ?? "pending"} warn={s.status === "capped" ? "Stopped at its step cap. Open it to give it more steps." : undefined} />
                <span class="chat-row-body">
                    <b class="row-title">{truncate(title, 90)}</b>
                    {/* WHERE IT STANDS COMES FIRST, then what kind of session it is, then where it lives — the phone's
                        order (mobile ListScreen), and the phone's for the phone's reason: a status that trails a page
                        host of any length is one the eye has to hunt for again on every row. It was last here, after
                        a hostname that is a different width in every row. */}
                    <span class="chat-row-meta">
                        {/* ONE THING, NOT TWO. "waiting on you" beside "1 approval" is the same fact in two
                            voices, and the badge is the one that says how many and reads at a glance — so where
                            there is a count, the count IS the status and the word goes. */}
                        {s.pendingApprovals > 0 ? <span class="chat-appr-badge">{approvalsPending(s.pendingApprovals)}</span> : null}
                        {STATUS_LABEL[s.status] && !s.pendingApprovals ? <span class={`chat-status st-${s.status}`}>{STATUS_LABEL[s.status]}</span> : null}
                        {/* A PIN TAKEN WHERE IT CANNOT MOVE THE ROW. Pinning from "Needs you" is real — it is stored,
                            and the row drops into Pinned once the gate is answered — but nothing moved at the time,
                            so the press read as a press that did nothing. */}
                        {showPin && isPinned(s) ? <span class="chat-row-pin" aria-label="Pinned"><IconPin /></span> : null}
                        {s.kind === "agent" ? <AgentBadge /> : null}
                        {/* OUT OF ITS GROUP, the machine is what the row is missing; the page host is what it can
                            spare, since opening it says both. Showing both in a 300px column truncated each of them
                            to about a word. The phone's rule, for the phone's reason. */}
                        {showRuntime
                            ? <span class="chat-row-rt">{rt.name}</span>
                            : s.page ? <PageChip page={s.page} /> : null}
                    </span>
                </span>
                {moved ? <span class="chat-moved" {...cursorTipOn("Something happened here while you were reading something else")} aria-label="new activity" /> : null}
                <Stamp ts={s.lastTs - offset} snap="right" />
            </button>
            <RowMenu store={store} s={s} rt={rt} title={title} />
        </div>
    );
}

/** How far back the list reaches. Everything older is revealed a page at a time, then on the search page. */
const RECENT_DAYS = 30;

/** How many older sessions one press of a runtime's "older" line reveals. */
const OLDER_PAGE = 10;

/**
 * How many of each runtime's older sessions its group is currently showing, by runtime id.
 *
 * NOT a preference, so not in `view-mode.ts` with the pins and the folds: it answers "how far back have I looked
 * just now", which is worth keeping while the page is open and nothing at all tomorrow. Reaching back into last
 * month on Tuesday is no reason for Wednesday's list to open long.
 */
const shownOlder = signal<ReadonlyMap<string, number>>(new Map());

/** Show the next {@link OLDER_PAGE} of a runtime's older sessions, in place. */
function revealOlder(id: string): void {
    shownOlder.value = new Map(shownOlder.value).set(id, (shownOlder.value.get(id) ?? 0) + OLDER_PAGE);
}

/** A session's last activity on THIS device's clock (the runtime's clock may be off; `clockOffsetMs` says by how much). */
const localTs = (s: SessionSummary, rt: RuntimeInfo | undefined) => s.lastTs - (rt?.clockOffsetMs ?? 0);

/**
 * The foot of a runtime's group: how many of its sessions are older than the list reaches, and the way to the rest.
 *
 * ONE LINE, lined up with the titles above it. It was two left-aligned grey sentences hanging under the rows, which
 * read as neither rows nor chrome — clickable text, indented differently from everything near it, taking two lines
 * to say what is a count and a door.
 *
 * A control ALONE takes words; a control beside another takes its glyph and a tooltip. So while there is still
 * something to reveal, the counter carries the line and searching is the icon at the end of it; once everything held
 * is shown, searching is the only thing left and says so in full. That rule is what keeps a lone magnifying glass
 * under a list of sessions from being the one thing on screen nobody can name.
 */
function OlderFoot({ rt, left }: { rt: RuntimeInfo; left: number }) {
    const label = `Search all history on ${rt.name}`;
    return (
        <div class="chat-older">
            {left > 0 ? (
                <>
                    {/* Revealing fetches NOTHING: these sessions are in the index already and the list is simply not
                        reaching back far enough, which is why this is a press with no wait and no spinner. The one
                        thing here that does ask a runtime is the search page, and it says so there while it waits. */}
                    <button class="chat-older-more" onClick={() => revealOlder(rt.id)}>
                        <IconHistory /><span class="chat-older-n">{left}</span> older
                    </button>
                    <button class="tt hbtn chat-older-all" aria-label={label} onClick={() => openSearch(rt.id)}>
                        <IconSearch /><span class="tt-pop" role="tooltip">{label}</span>
                    </button>
                </>
            ) : (
                <button class="chat-older-more" aria-label={label} onClick={() => openSearch(rt.id)}>
                    <IconSearch />Search all history
                </button>
            )}
        </div>
    );
}

/**
 * The session list: what is pinned, then each runtime's RECENT sessions, then a way to the rest.
 *
 * A session that is still running or waiting on you is recent however long ago it started — the list never files
 * away something that wants you. Everything else past `RECENT_DAYS` lives on the search page (`search-page.tsx`),
 * which both the header's search button and the "Older sessions" row open: one place to find a session, not two.
 */
export function SessionList({ store, activeKey, narrow, onStart, gear, gearWide }: { store: ChatStore; activeKey: SessionKey | null; narrow: boolean; onStart: (kind: StartKind, runtime?: string) => void; gear: preact.ComponentChildren; gearWide: preact.ComponentChildren }) {
    const runtimes = store.runtimes.value;
    const sessions = store.listed();
    const status = store.status.value;
    const moved = movedSince.value;
    const folded = foldedRuntimes.value;
    const pins = pinned.value;
    const rtOf = new Map(runtimes.map((rt) => [rt.id, rt]));
    const listScroll = useRef<HTMLDivElement>(null);
    useFadeEdges(listScroll);
    const keyOf = (s: SessionSummary) => `${s.id.runtime}:${s.id.hash}`;
    const cutoff = Date.now() - RECENT_DAYS * 86_400_000;
    const live = (s: SessionSummary) => s.status === "running" || s.status === "waiting";
    const isRecent = (s: SessionSummary) => live(s) || localTs(s, rtOf.get(s.id.runtime)) >= cutoff;
    void pins;   // read, so the list re-renders when this device's pins change (`isPinned` reads them too)
    // WHAT IS WAITING ON YOU, ABOVE EVERYTHING (the phone's `needsYou`). A run holding a gate is the only thing in
    // this list that stops until you come back to it, and finding it meant knowing which machine it was on and
    // scrolling to that group. Newest first, and it LEAVES its own group while it is up here: the same row twice
    // within one screen reads as a bug, and a row up here names its machine, so nothing is lost by moving it.
    const needsYou = sessions.filter((s) => s.pendingApprovals > 0 && rtOf.has(s.id.runtime)).sort((a, b) => b.lastTs - a.lastTs);
    const upTop = new Set(needsYou.map(keyOf));
    const pinnedRows = sessions.filter((s) => isPinned(s) && !upTop.has(keyOf(s)) && rtOf.has(s.id.runtime));
    /** A runtime's sessions from before the recent window, newest first — the list's own, not a round trip. */
    const olderOn = (id: string) => sessions.filter((s) => s.id.runtime === id && !isPinned(s) && !isRecent(s));
    const row = (s: SessionSummary, showRuntime = false, showPin = false, reveal?: number) => {
        const key = keyOf(s);
        return <IndexRow key={key} store={store} s={s} rt={rtOf.get(s.id.runtime)!} active={activeKey === key} moved={moved.has(key)} showRuntime={showRuntime} showPin={showPin} reveal={reveal} />;
    };
    const revealed = shownOlder.value;
    return (
        <aside class="chat-list" aria-label="Sessions">
            <div class="head">
                <ListToggle narrow={narrow} /><b>Sessions</b><span class="sp" />
                {status.state !== "online" ? <span class="chat-chip warn">{status.state === "connecting" ? "connecting…" : "offline"}</span> : null}
                <button class={`tt hbtn${mainView.value === "search" ? " on" : ""}`} aria-label="Search sessions" onClick={() => openSearch()}>
                    <IconSearch /><span class="tt-pop" role="tooltip">Search sessions</span>
                </button>
                <StartMenu store={store} onPick={onStart} icon={<IconCompose />} />{narrow ? gear : null}
            </div>
            <div class="view chat-list-scroll fade-edges" ref={listScroll}>
                {runtimes.length === 0 && status.state === "online" ? <div class="empty">No runtimes yet. Pair one to see its sessions here.</div> : null}
                {needsYou.length ? (
                    <section class="chat-group chat-needs-you" aria-label="Needs you">
                        <div class="chat-group-label chat-needs-label"><IconInbox />Needs you</div>
                        {/* ALWAYS named, even with one runtime: out of its group a row has lost the heading that said
                            where it runs, and that is the first thing you need to answer a gate. */}
                        {needsYou.map((s) => row(s, true, true))}
                    </section>
                ) : null}
                {pinnedRows.length ? (
                    <section class="chat-group chat-pinned" aria-label="Pinned">
                        <div class="chat-group-label"><IconPin />Pinned</div>
                        {pinnedRows.map((s) => row(s, runtimes.length > 1))}
                    </section>
                ) : null}
                {runtimes.map((rt) => {
                    const mine = sessions.filter((s) => s.id.runtime === rt.id && !isPinned(s) && !upTop.has(keyOf(s)) && isRecent(s));
                    const older = olderOn(rt.id);
                    const show = Math.min(revealed.get(rt.id) ?? 0, older.length);
                    const shut = folded.has(rt.id);
                    return (
                        <section class={`chat-group${shut ? " folded" : ""}`} key={rt.id}>
                            <RuntimeHead store={store} rt={rt} folded={shut} onStart={onStart} />
                            {/* Mounted while folded, so folding slides both ways; `inert` keeps a folded group's rows out of reach. */}
                            <div class="chat-group-body" inert={shut}>
                                <div class="chat-group-rows">
                                    {!speaksOurContract(rt)
                                        ? <div class="chat-rt-empty">This runtime speaks version {rt.contractVersion} of the session contract, which this app does not. Its sessions open once both sides agree.</div>
                                        : mine.length
                                            ? mine.map((s) => row(s))
                                            : <div class="chat-rt-empty">Nothing in the last {RECENT_DAYS} days.</div>}
                                    {/* UNDER THE RUNTIME IT BELONGS TO, and carrying it. One row at the foot of the whole
                                        list answered "older than a month" with a number spanning every machine, and then
                                        opened a page looking at all of them — so finding the thing you were just looking
                                        at meant picking the device again, under the heading that had already said which
                                        one it was. The phone has had it this way (ListScreen's section footer); this is
                                        the page catching up, which is the rule for anything drawn on both.

                                        IT OPENS IN PLACE. These sessions are already here — the index holds them and
                                        the list is simply not reaching back far enough — so sending the reader to
                                        another view to look at a row that was five pixels away was a round trip to
                                        nowhere. The reveal animates because the rows appear BELOW the thing that was
                                        clicked, where nothing moved at the press: the line has to be seen to do
                                        something, or it reads as a press that failed.

                                        The way to the search page arrives once the reader has shown they are looking
                                        backwards, and stays once the list has nothing left to give. It is the honest
                                        end of this line: what is held here is what the runtime still has in its
                                        index, and only that page can go further (it asks). */}
                                    {older.slice(0, show).map((s, i) => row(s, false, false, i % OLDER_PAGE))}
                                    {older.length ? <OlderFoot rt={rt} left={older.length - show} /> : null}
                                </div>
                            </div>
                        </section>
                    );
                })}
            </div>
            {narrow ? null : <div class="chat-list-foot">{gearWide}</div>}
        </aside>
    );
}
