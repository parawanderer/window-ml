// A SCRIPTED `SessionHost`, for developing and testing the chat core with no extension and no hub
// (docs/spec/CHAT_PAGE.md §Testing both places). It keeps real per-session event logs with an epoch and cursors, so
// the stream rules are exercised as a real host would exercise them: resume from a position, `reset` after a restart
// that kept history, `backfilled` truncated after one that did not, `gone` on delete. Commands are checked against
// the runtime's grants and capabilities, recorded, and answered with plausible events.
//
// Development only. It ships in the web build until `HubHost` exists (slice 6) and never in the extension.
import type { MlDebugEvent } from "../contract-debug";
import {
    COMMAND_SCOPE, SESSION_CONTRACT_VERSION, sessionKey,
    type Command, type CommandResult, type HostStatus, type ModelChoice, type Principal, type RuntimeId, type RuntimeInfo, type SessionHost,
    type SessionId, type SessionIndexUpdate, type SessionKey, type SessionStreamMessage, type SessionSummary, type StreamPosition, type TabGroupInfo, type TabInfo, type Unsubscribe, type ListedSession,
} from "../session-host";
import { capTitle } from "../session-title";
import { holds } from "./grants";

interface Logged { cursor: number; event: MlDebugEvent }
interface Held {
    summary: SessionSummary;
    epoch: string;
    log: Logged[];
    nextCursor: number;
    /** events before this cursor were lost (a restart without history) */
    lostBefore: number;
}
type Sub = { session: SessionId; listener: (m: SessionStreamMessage) => void; live: boolean };

/** What a fake `side.call` answers, by purpose, unless a test supplies its own. */
const SIDE_REPLIES = { title: "A scripted title", summary: "Did the scripted thing.", explain: "{\"notes\":[]}" } as const;

let epochSeq = 0;
const newEpoch = () => `e${++epochSeq}`;

/** The tabs a demo runtime says it has, so the new-session form's picker has something real to show. */
/** A favicon as the runtime hands one on: a small image already turned into a data URL. */
const DEMO_ICON = "data:image/svg+xml;utf8," + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect width="16" height="16" rx="3" fill="#4f7cff"/><path d="M4 11V5h2l2 3 2-3h2v6" stroke="#fff" stroke-width="1.6" fill="none"/></svg>`);

/** The demo's tabs, in the order a runtime sends them (focused window first, strip order within it). Window 1 holds
 *  one group the runtime can name ("Research") and one it cannot (no `tabGroups` grant), so both drawings show. */
const DEMO_TABS: TabInfo[] = [
    { tabId: 11, url: "https://news.example/front", title: "The front page", active: true, windowId: 1, index: 0, favicon: DEMO_ICON },
    { tabId: 12, url: "https://docs.example/api/tables", title: "Tables — API reference", active: false, windowId: 1, index: 1, groupId: 5 },
    { tabId: 14, url: "https://docs.example/api/pointers#pipe", title: "Pointers — the pipe dialect", active: false, windowId: 1, index: 2, groupId: 5 },
    { tabId: 15, url: "https://shop.example/cart", title: "Your cart", active: false, windowId: 1, index: 3, groupId: 6 },
    { tabId: 13, url: "https://mail.example/inbox", title: "Inbox (3)", active: false, windowId: 2 },
    // The tab the demo world's flight runs are driving (their `page.tabId`), so `tab.focus` on their chip finds it.
    { tabId: 41, url: "https://flights.example/search?from=AMS&to=LIS", title: "Flights AMS → LIS", active: true, windowId: 3 },
];

/** The groups the runtime can name; group 6 is left out, as it is without the `tabGroups` grant. */
const DEMO_GROUPS: TabGroupInfo[] = [{ id: 5, title: "Research", color: "blue" }];

/** What the demo world hands back for a screenshot: an SVG of a page rather than a real capture, because the point
 *  of the demo is the button, the round trip and the viewer, and none of those can tell. */
const DEMO_SHOT = "data:image/svg+xml;utf8," + encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="900" height="560" viewBox="0 0 900 560">
        <rect width="900" height="560" fill="#f6f7f9"/>
        <rect width="900" height="52" fill="#ffffff"/>
        <circle cx="26" cy="26" r="6" fill="#d9dce1"/><circle cx="46" cy="26" r="6" fill="#d9dce1"/>
        <rect x="70" y="16" width="300" height="20" rx="10" fill="#eceef1"/>
        <text x="84" y="31" font-family="system-ui" font-size="12" fill="#6b7280">flights.example/search</text>
        <text x="40" y="106" font-family="system-ui" font-size="22" fill="#111827">Amsterdam → Lisbon</text>
        ${[0, 1, 2].map((i) => `<rect x="40" y="${140 + i * 92}" width="820" height="76" rx="10" fill="#ffffff" stroke="#e5e7eb"/>
        <text x="64" y="${172 + i * 92}" font-family="system-ui" font-size="15" fill="#111827">${["TP 675", "HV 5183", "KL 1691"][i]}</text>
        <text x="64" y="${194 + i * 92}" font-family="system-ui" font-size="12" fill="#6b7280">07:${["05", "40", "15"][i]} — 09:${["35", "10", "45"][i]}</text>
        <text x="800" y="${182 + i * 92}" font-family="system-ui" font-size="18" fill="#111827">€${[118, 96, 131][i]}</text>`).join("")}
    </svg>`.replace(/\s+/g, " "));

/** A tab id for one the demo world just opened, past the ids `DEMO_TABS` already uses. */
let nextFakeTabId = 90;

/** A session hash for something the demo world just started: the same 8 hex characters a runtime mints. */
let hashSeq = 0;
const newHash = () => (0xd0000000 + ++hashSeq).toString(16);

/** The scripted host. Construct it with runtimes and sessions, then drive it from a test or the page's console
 *  (`window.__chatFake` in the web build). */
export class FakeHost implements SessionHost {
    readonly self: Principal;
    /** every command received, in order, whatever its outcome */
    readonly commands: Command[] = [];
    /** override the reply to a command type; return undefined to fall through to the default */
    handlers: { [T in Command["type"]]?: (c: Extract<Command, { type: T }>) => CommandResult<T> | undefined } = {};

    private _status: HostStatus = { state: "online" };
    private _runtimes: RuntimeInfo[];
    private held = new Map<SessionKey, Held>();
    private statusL = new Set<(s: HostStatus) => void>();
    private runtimeL = new Set<(r: RuntimeInfo[]) => void>();
    private indexL = new Set<{ fn: (u: SessionIndexUpdate) => void; runtime?: RuntimeId }>();
    private subs = new Set<Sub>();

    constructor(opts: { self?: Principal; runtimes: RuntimeInfo[]; sessions?: { summary: SessionSummary; events?: MlDebugEvent[] }[]; archived?: { summary: SessionSummary; events?: MlDebugEvent[] }[]; latencyMs?: number }) {
        this.self = opts.self ?? { id: "fake-device", kind: "device", name: "This device" };
        this._runtimes = opts.runtimes;
        this.latencyMs = opts.latencyMs ?? 0;
        for (const s of opts.sessions ?? []) this.addSession(s.summary, s.events);
        for (const a of opts.archived ?? []) this.archive.set(sessionKey(a.summary.id), { summary: a.summary, events: a.events ?? [] });
    }

    /** Sessions only the ARCHIVE holds: not in the index, found by `sessions.list` / `sessions.search`, and brought
     *  back into it by `session.unarchive`, the way the runtime's SQLite archive behaves. */
    archive = new Map<SessionKey, { summary: SessionSummary; events: MlDebugEvent[] }>();

    /** A page of `sessions.list` or `sessions.search` rows for one runtime: live and archived merged, newest first,
     *  strictly older than `before`. `match` decides a row and may return its snippet. */
    private listPage(runtime: RuntimeId, before: number | undefined, limit: number | undefined,
        match: (s: SessionSummary, events: MlDebugEvent[] | null) => { snippet?: string } | null): { sessions: ListedSession[]; more: boolean } {
        const rows: ListedSession[] = [];
        for (const h of this.held.values()) {
            if (h.summary.id.runtime !== runtime) continue;
            const m = match(h.summary, null);
            if (m) rows.push({ ...h.summary, ...(m.snippet ? { match: { snippet: m.snippet } } : {}) });
        }
        for (const a of this.archive.values()) {
            if (a.summary.id.runtime !== runtime) continue;
            const m = match(a.summary, a.events);
            if (m) rows.push({ ...a.summary, archived: true, ...(m.snippet ? { match: { snippet: m.snippet } } : {}) });
        }
        const n = Math.min(Math.max(1, limit ?? 40), 200);
        const older = rows.filter((r) => before == null || r.lastTs < before).sort((a, b) => b.lastTs - a.lastTs);
        return { sessions: older.slice(0, n), more: older.length > n };
    }

    /** delay before every delivery and command result, to see loading states */
    latencyMs: number;

    /**
     * How many events a fresh subscription delivers, the newest ones, the way a hub's short ring does; `backfilled`
     * then says where they begin (`from`) and `session.backfill` serves the rest. Unset: the whole history, `from: 0`.
     */
    ringLimit?: number;
    /** What `models.list` answers, on every runtime. */
    models: ModelChoice[] = [
        { id: "qwen3:32b", kinds: ["completion", "tools", "thinking"], default: true, where: "local" },
        { id: "gemma3:27b", kinds: ["completion", "vision"], where: "local" },
        { id: "nomic-embed-text", kinds: ["embedding"], where: "local" },
        { id: "litellm.google/gemini-flash-latest", where: "cloud" },
    ];
    /** The open tabs `tabs.list` reports, a copy per host so a test can close one as a person would. */
    tabs: TabInfo[] = DEMO_TABS.map((t) => ({ ...t }));
    /** Open tabs `tabs.list` says it could not list (site access limited), 0 for none. */
    tabsWithheld = 0;
    /** The tab groups `tabs.list` reports, a copy per host so a test can fold one as the browser's strip would. */
    tabGroups: TabGroupInfo[] = DEMO_GROUPS.map((g) => ({ ...g }));
    /** The model access filter's effect, as `models.list` reports it; null for no filter. */
    modelsFiltered: { hidden: number } | null = { hidden: 2 };

    /** A short ring WITHOUT the session's start, as an older runtime would send it, to exercise the fallback. */
    ringDropsStart?: boolean;

    /** Deliver later, in order, never synchronously. */
    private later(fn: () => void): void {
        if (this.latencyMs > 0) setTimeout(fn, this.latencyMs);
        else queueMicrotask(fn);
    }

    /* ------------------------------ scripting ------------------------------ */

    setStatus(s: HostStatus): void {
        this._status = s;
        for (const l of this.statusL) this.later(() => l(s));
    }

    /** Replace a runtime's info (online, grants, capabilities…). */
    setRuntime(id: RuntimeId, patch: Partial<RuntimeInfo>): void {
        this._runtimes = this._runtimes.map((r) => (r.id === id ? { ...r, ...patch } : r));
        const list = this._runtimes;
        for (const l of this.runtimeL) this.later(() => l(list));
    }

    /** Add (or replace) a session and its history. */
    addSession(summary: SessionSummary, events: MlDebugEvent[] = []): void {
        const key = sessionKey(summary.id);
        const h: Held = { summary, epoch: newEpoch(), log: [], nextCursor: 1, lostBefore: 0 };
        for (const event of events) h.log.push({ cursor: h.nextCursor++, event });
        this.held.set(key, h);
        this.upsertIndex(summary);
    }

    /** Change a session's index row. */
    updateSummary(key: SessionKey, patch: Partial<SessionSummary>): void {
        const h = this.held.get(key);
        if (!h) return;
        h.summary = { ...h.summary, ...patch };
        this.upsertIndex(h.summary);
    }

    /** Append an event to a session and deliver it live. */
    emit(key: SessionKey, event: MlDebugEvent): void {
        const h = this.held.get(key);
        if (!h) return;
        const entry = { cursor: h.nextCursor, event };
        // Cursors are strictly increasing, not contiguous: skip one now and then, as a real ring may.
        h.nextCursor += 1 + (h.nextCursor % 5 === 0 ? 1 : 0);
        h.log.push(entry);
        h.summary = { ...h.summary, lastTs: Math.max(h.summary.lastTs, event.ts) };
        this.upsertIndex(h.summary);
        for (const sub of this.subs) {
            if (sessionKey(sub.session) !== key) continue;
            this.later(() => { if (sub.live) sub.listener(this.envelope(h, entry)); });
        }
    }

    /** Deliver a raw stream message to a session's subscribers, for tests of what a misbehaving host could send. */
    inject(key: SessionKey, message: SessionStreamMessage): void {
        for (const sub of this.subs) if (sessionKey(sub.session) === key) this.later(() => { if (sub.live) sub.listener(message); });
    }

    /** The runtime restarted. With `keepHistory` it rebuilt the session under a new epoch (subscribers get `reset` and
     *  the backfill); without, the history is gone (subscribers get `backfilled` truncated, and keep what they show). */
    restart(key: SessionKey, keepHistory: boolean): void {
        const h = this.held.get(key);
        if (!h) return;
        h.epoch = newEpoch();
        if (!keepHistory) { h.lostBefore = h.nextCursor; h.log = []; }
        for (const sub of this.subs) if (sessionKey(sub.session) === key) this.replay(sub, h, undefined, keepHistory);
    }

    /** Delete a session: subscribers get `gone`, the index a `remove`. */
    deleteSession(key: SessionKey): void {
        const h = this.held.get(key);
        if (!h) return;
        this.held.delete(key);
        for (const sub of [...this.subs]) {
            if (sessionKey(sub.session) !== key) continue;
            this.later(() => { if (sub.live) sub.listener({ type: "gone", session: h.summary.id }); });
            this.subs.delete(sub);
        }
        for (const l of this.indexL) if (!l.runtime || l.runtime === h.summary.id.runtime) this.later(() => l.fn({ type: "remove", id: h.summary.id }));
    }

    /** A session's history, for assertions. */
    history(key: SessionKey): MlDebugEvent[] {
        return this.held.get(key)?.log.map((e) => e.event) ?? [];
    }

    /* ------------------------------ SessionHost ------------------------------ */

    status(listener: (status: HostStatus) => void): Unsubscribe {
        this.statusL.add(listener);
        this.later(() => { if (this.statusL.has(listener)) listener(this._status); });
        return () => { this.statusL.delete(listener); };
    }

    runtimes(listener: (runtimes: RuntimeInfo[]) => void): Unsubscribe {
        this.runtimeL.add(listener);
        this.later(() => { if (this.runtimeL.has(listener)) listener(this._runtimes); });
        return () => { this.runtimeL.delete(listener); };
    }

    sessions(listener: (update: SessionIndexUpdate) => void, opts?: { runtime?: RuntimeId }): Unsubscribe {
        const entry = { fn: listener, runtime: opts?.runtime };
        this.indexL.add(entry);
        const ids = opts?.runtime ? [opts.runtime] : this._runtimes.map((r) => r.id);
        for (const runtime of ids) {
            const sessions = [...this.held.values()].map((h) => h.summary).filter((s) => s.id.runtime === runtime);
            this.later(() => { if (this.indexL.has(entry)) listener({ type: "snapshot", runtime, sessions }); });
        }
        return () => { this.indexL.delete(entry); };
    }

    events(session: SessionId, listener: (message: SessionStreamMessage) => void, opts?: { since?: StreamPosition }): Unsubscribe {
        const sub: Sub = { session, listener, live: true };
        const h = this.held.get(sessionKey(session));
        if (!h) {
            this.later(() => { if (sub.live) listener({ type: "gone", session }); });
            return () => { sub.live = false; };
        }
        this.subs.add(sub);
        this.replay(sub, h, opts?.since, false);
        return () => { sub.live = false; this.subs.delete(sub); };
    }

    async send<C extends Command>(command: C, opts?: { signal?: AbortSignal }): Promise<CommandResult<C["type"]>> {
        this.commands.push(command);
        await new Promise<void>((r) => this.later(r));
        if (opts?.signal?.aborted) return { ok: false, error: { code: "aborted", message: "" } };
        return this.answer(command) as CommandResult<C["type"]>;
    }

    /* ------------------------------ internals ------------------------------ */

    private envelope(h: Held, e: Logged): SessionStreamMessage {
        return { type: "event", v: SESSION_CONTRACT_VERSION, session: h.summary.id, epoch: h.epoch, cursor: e.cursor, pos: h.log.indexOf(e), event: e.event };
    }

    private upsertIndex(summary: SessionSummary): void {
        for (const l of this.indexL) if (!l.runtime || l.runtime === summary.id.runtime) this.later(() => l.fn({ type: "upsert", session: summary }));
    }

    /** The subscription sequence: `reset` when the client may hold history this replaces (it asked to resume from a
     *  position this runtime cannot serve, or the runtime rebuilt the session under it), the backfill, `backfilled`. */
    private replay(sub: Sub, h: Held, since: StreamPosition | undefined, rebuilt: boolean): void {
        const epoch = h.epoch;
        const resumable = !!since && since.epoch === epoch && since.cursor >= h.lostBefore - 1;
        const out: SessionStreamMessage[] = [];
        if (h.log.length && (rebuilt || (since && !resumable))) out.push({ type: "reset", session: h.summary.id, epoch });
        const after = resumable ? since!.cursor : -Infinity;
        // A fresh start sends the ring's worth, newest last; a resume sends what the client lacks, whatever its size.
        const start = resumable || this.ringLimit == null ? 0 : Math.max(0, h.log.length - this.ringLimit);
        // The session's first event rides along with a short ring, as a runtime keeps it: `from` still names where
        // the contiguous tail begins.
        if (start > 0 && !this.ringDropsStart && h.log[0].cursor > after) out.push(this.envelope(h, h.log[0]));
        for (const e of h.log.slice(start)) if (e.cursor > after) out.push(this.envelope(h, e));
        out.push({ type: "backfilled", session: h.summary.id, epoch, cursor: h.log.at(-1)?.cursor ?? 0, truncated: h.lostBefore > 0 && !resumable, ...(resumable ? {} : { from: start }) });
        for (const m of out) this.later(() => { if (sub.live) sub.listener(m); });
    }

    private answer(c: Command): CommandResult<Command["type"]> {
        const fail = (code: "unsupported" | "forbidden" | "not-found" | "invalid" | "conflict" | "unavailable", message: string) => ({ ok: false as const, error: { code, message } });
        const runtimeId = "runtime" in c ? c.runtime : c.session.runtime;
        const rt = this._runtimes.find((r) => r.id === runtimeId);
        if (!rt) return fail("not-found", "no such runtime");
        if (!rt.online) return fail("unavailable", `${rt.name} is offline`);
        const key = "session" in c && c.session ? sessionKey(c.session) : undefined;
        const h = key ? this.held.get(key) : undefined;
        if (!holds(rt, COMMAND_SCOPE[c.type], key ? { key, summary: h?.summary } : undefined, this.self)) return fail("forbidden", `this device may not ${c.type} on ${rt.name}`);
        const custom = (this.handlers as Record<string, ((x: Command) => CommandResult<Command["type"]> | undefined) | undefined>)[c.type]?.(c);
        if (custom) return custom;
        const ok = <T>(data: T) => ({ ok: true as const, data }) as CommandResult<Command["type"]>;
        const caps = rt.capabilities;
        switch (c.type) {
            case "side.call":
                if (!caps.sideCalls) return fail("unsupported", "no side calls on this runtime");
                return ok({ content: SIDE_REPLIES[c.purpose] });
            case "page.highlight":
                return caps.highlight ? ok({}) : fail("unsupported", "no page to highlight on");
            case "tabs.list":
                return caps.tabs ? ok({ tabs: this.tabs, groups: this.tabGroups, ...(this.tabsWithheld ? { withheld: this.tabsWithheld } : {}) }) : fail("unsupported", "this runtime has no tabs");
            // The real runtime can only capture the tab its window is SHOWING (src/session-commands.ts), so a run
            // working in a background tab is refused rather than captured behind the scenes. The demo world keeps
            // that rule, since a peek that always works would teach the UI the wrong lesson about when it does.
            case "tab.screenshot": {
                if (!caps.screenshots) return fail("unsupported", "this runtime cannot capture a tab");
                const tabId = "tabId" in c.target ? c.target.tabId : this.held.get(sessionKey(c.target.session))?.summary.page?.tabId;
                if (tabId == null) return fail("not-found", "that session is not on a tab");
                const tab = this.tabs.find((t) => t.tabId === tabId);
                if (tab && !tab.active) return fail("conflict", "that tab is not in front in its window, so it cannot be captured");
                return ok({ image: DEMO_SHOT, width: 900, height: 560, ts: Date.now() });
            }
            case "tab.focus":
                if (!caps.tabs) return fail("unsupported", "this runtime has no tabs");
                return this.tabs.some((t) => t.tabId === c.tabId) ? ok({}) : fail("not-found", "no such tab");
            case "session.backfill": {
                if (!h) return fail("not-found", "no such session");
                if (c.before != null && (!Number.isInteger(c.before) || c.before < 0)) return fail("invalid", "before must be a position in this session's history");
                const end = c.before == null ? h.log.length : Math.min(c.before, h.log.length);
                const from = Math.max(0, end - Math.min(c.limit ?? 40, 40));
                return ok({ session: h.summary.id, epoch: h.epoch, events: h.log.slice(from, end).map((e) => e.event), from, more: from > 0, truncated: from === 0 && h.lostBefore > 0 });
            }
            // What this runtime keeps, as a real one reports it: its own sessions' rows, sized from the events it holds,
            // so the Storage view (and the phone's Runtimes screen) has something true to draw in the demo.
            case "storage.stats": {
                if (!caps.persistence) return fail("unsupported", "this runtime keeps nothing");
                const mine = [...this.held.values()].filter((h) => h.summary.id.runtime === rt.id);
                const size = (h: (typeof mine)[number]) => h.log.reduce((n, e) => n + JSON.stringify(e.event).length, 200);
                const images = mine.reduce((n, h) => n + h.log.filter((e) => "images" in (e.event as object)).length * 90_000, 0);
                const toolOutput = Math.round(mine.reduce((n, h) => n + size(h), 0) * 0.4);
                const total = mine.reduce((n, h) => n + size(h), 0) + images;
                // Every field of `SessionBytes`: the Storage view reads `byTool` and `imageCount` too, and a snapshot
                // missing one throws in the page rather than drawing a smaller picture.
                const byTool: Record<string, number> = {};
                for (const h of mine) for (const e of h.log) {
                    const tool = (e.event as { tool?: string }).tool;
                    if (tool) byTool[tool] = (byTool[tool] ?? 0) + JSON.stringify(e.event).length;
                }
                const now = {
                    t: Date.now(), sessions: mine.length, events: mine.reduce((n, h) => n + h.log.length, 0),
                    pinned: mine.filter((h) => h.summary.pinned).length, unmeasured: 0,
                    total, images, imageCount: Math.round(images / 90_000), toolOutput, byTool,
                    other: Math.max(0, total - images - toolOutput),
                };
                return ok({
                    now, history: [{ ...now, t: now.t - 86_400_000 }, now],
                    largest: mine.map((h) => ({ hash: h.summary.id.hash, title: h.summary.title, bytes: size(h), ...(h.summary.pinned ? { pinned: true as const } : {}) }))
                        .sort((a, b) => b.bytes - a.bytes).slice(0, 5),
                    ...(caps.archive?.folder === "connected" ? { archive: { sessions: 12, events: 400, bytes: 209_715_200, images: 30, imageBytes: 104_857_600 } } : {}),
                });
            }
            case "sessions.list":
                return ok(this.listPage(c.runtime, c.before, c.limit, (s) => (c.archived === true && !this.archive.has(sessionKey(s.id))) || (c.archived === false && this.archive.has(sessionKey(s.id))) ? null : {}));
            case "sessions.search": {
                const q = c.query.trim().toLowerCase();
                if (!q) return fail("invalid", "an empty search");
                // Live sessions by title, task and page title; archived ones by every word they hold, with a snippet.
                return ok(this.listPage(c.runtime, c.before, c.limit, (s, events) => {
                    if ([s.title, s.task, s.page?.title].some((v) => v?.toLowerCase().includes(q))) return {};
                    if (!events) return null;
                    for (const e of events) {
                        const text = (e as { content?: unknown; task?: unknown; text?: unknown }).content ?? (e as { task?: unknown }).task ?? (e as { text?: unknown }).text;
                        if (typeof text !== "string") continue;
                        const at = text.toLowerCase().indexOf(q);
                        if (at < 0) continue;
                        const from = Math.max(0, at - 40), to = Math.min(text.length, at + q.length + 60);
                        return { snippet: `${from > 0 ? "…" : ""}${text.slice(from, at)}«${text.slice(at, at + q.length)}»${text.slice(at + q.length, to)}${to < text.length ? "…" : ""}` };
                    }
                    return null;
                }));
            }
            case "models.list":
                return ok({ models: this.models, ...(this.modelsFiltered ? { filtered: this.modelsFiltered } : {}) });
            case "runtime.info":
                return ok({ kind: rt.kind, contractVersion: rt.contractVersion, capabilities: caps, nowMs: Date.now() });
            // Starting a session: the demo world mints one and answers the first turn, so the new-session form is
            // exercised here at phone width before it is exercised against a browser.
            case "chat.start": {
                if (!caps.chat) return fail("unsupported", "this runtime holds no chats");
                const hash = newHash();
                const key = sessionKey({ runtime: rt.id, hash });
                this.addSession({ id: { runtime: rt.id, hash }, kind: "chat", status: "done", createdTs: Date.now(), lastTs: Date.now(), pendingApprovals: 0, saved: !c.ephemeral, task: c.text });
                const t = { id: `${hash}-0`, ts: Date.now(), save: !c.ephemeral, session: { hash, turn: 0 } };
                this.emit(key, {
                    ...t, kind: "chat", streaming: false,
                    request: { model: "fake", extend: null, messages: [{ role: "user", content: c.text }], images: c.images ?? null, toolIds: null, schema: false, think: null, maxTokens: null },
                    config: { system: c.system ?? null, model: c.model ?? "fake", think: c.think ?? null, schema: false, toolIds: null, maxTokens: null, save: !c.ephemeral },
                } as MlDebugEvent);
                this.emit(key, { ...t, ts: Date.now() + 1, kind: "chat-result", content: `You said: ${c.text}`, sources: null, structured: false, model: "fake", extend: null, reasoning: null, usage: null });
                return ok({ session: { runtime: rt.id, hash } });
            }
            case "agent.start": {
                if (!caps.agent) return fail("unsupported", "this runtime runs no agents");
                if (c.target.kind === "headless" && !caps.headless) return fail("unsupported", "this runtime has no headless target");
                if (c.target.kind === "tab" && !caps.tabs) return fail("unsupported", "this runtime has no tabs");
                // As the real runtime does: a tab that has closed is refused, never swapped for another.
                if (c.target.kind === "tab" && !this.tabs.some((t) => c.target.kind === "tab" && t.tabId === c.target.tabId)) return fail("not-found", "no such tab");
                const hash = newHash();
                const key = sessionKey({ runtime: rt.id, hash });
                this.addSession({ id: { runtime: rt.id, hash }, kind: "agent", status: "running", createdTs: Date.now(), lastTs: Date.now(), pendingApprovals: 0, saved: !c.ephemeral, task: c.task });
                this.emit(key, { id: hash, ts: Date.now(), save: !c.ephemeral, session: { hash, turn: 0 }, kind: "agent", task: c.task, model: c.model ?? "fake", maxSteps: c.maxSteps ?? 10, config: undefined as never } as MlDebugEvent);
                return ok({ session: { runtime: rt.id, hash } });
            }
        }
        // Unarchiving is the one session command about a session the index does NOT hold: the archive has it.
        if (c.type === "session.unarchive" && key) {
            const a = this.archive.get(key);
            if (!a) return h ? ok({ session: c.session }) : fail("not-found", "no such session");
            this.archive.delete(key);
            this.addSession(a.summary, a.events);
            return ok({ session: c.session });
        }
        if (!("session" in c) || !h || !key) return key ? fail("not-found", "no such session") : fail("unsupported", `the fake host does not do ${c.type}`);
        const now = Date.now();
        const base = { id: `${c.session.hash}-${now}`, ts: now, save: h.summary.saved, session: { hash: c.session.hash, turn: 0 } };
        switch (c.type) {
            case "approval.answer": {
                const gate = [...h.log].reverse().map((e) => e.event).find((e) => e.kind === "agent-step" && e.seq === c.seq);
                if (!gate || gate.kind !== "agent-step" || !gate.awaitingApproval) return ok({ resolved: false });
                const approved = c.decision === "approve";
                this.emit(key, {
                    ...gate, ...base, pending: false, awaitingApproval: false, approval: approved ? "user" : "denied",
                    result: approved ? "ok (scripted)" : "The user denied this call.",
                });
                this.updateSummary(key, { pendingApprovals: Math.max(0, h.summary.pendingApprovals - 1), status: "running" });
                return ok({ resolved: true });
            }
            case "session.send": {
                if (h.summary.kind === "agent") {
                    this.emit(key, { ...base, kind: "agent-say", text: c.text, ...(c.images ? { images: c.images } : {}), sayId: `say-${now}` });
                    return ok({ mode: h.summary.status === "running" || h.summary.status === "waiting" ? "steer" : "turn" });
                }
                const turn = h.log.filter((e) => e.event.kind === "chat").length;
                const t = { ...base, id: `${c.session.hash}-${turn}`, session: { hash: c.session.hash, turn } };
                this.emit(key, {
                    ...t, kind: "chat", streaming: false,
                    request: { model: "fake", extend: null, messages: [{ role: "user", content: c.text }], images: c.images ?? null, toolIds: null, schema: false, think: null, maxTokens: null },
                    config: { system: null, model: "fake", think: null, schema: false, toolIds: null, maxTokens: null, save: h.summary.saved },
                } as MlDebugEvent);
                this.emit(key, { ...t, ts: now + 1, kind: "chat-result", content: `You said: ${c.text}`, sources: null, structured: false, model: "fake", extend: null, reasoning: null, usage: null });
                return ok({ mode: "turn" });
            }
            case "session.model": {
                if (!caps.switchModel) return fail("unsupported", "this runtime cannot switch a session's model");
                if (!this.models.some((m) => m.id === c.model)) return fail("invalid", `${c.model} is not offered on ${rt.name}`);
                this.updateSummary(key, { model: c.model });
                return ok({ model: c.model, applies: h.summary.status === "running" ? "next-step" : "next-turn" });
            }
            case "session.cancel":
                if (h.summary.kind === "agent") this.emit(key, { ...base, kind: "agent-result", summary: "", steps: 0, hitCap: false, cancelled: true });
                this.updateSummary(key, { status: "cancelled", pendingApprovals: 0 });
                return ok({});
            case "session.continue": {
                if (h.summary.status !== "capped") return fail("conflict", "only a run stopped at its step cap can continue");
                if (c.maxSteps != null && (!Number.isInteger(c.maxSteps) || c.maxSteps < 1)) return fail("invalid", "maxSteps must be a whole number of steps");
                // A chosen budget is announced the way a real runtime announces it, so the demo world exercises the
                // event the surfaces actually read rather than only the command.
                if (c.maxSteps != null) this.emit(key, { id: h.summary.id.hash, ts: Date.now(), save: false, session: { hash: h.summary.id.hash, turn: 0 }, kind: "agent-cap", maxSteps: c.maxSteps } as MlDebugEvent);
                this.updateSummary(key, { status: "running" });
                return ok(c.maxSteps != null ? { maxSteps: c.maxSteps } : {});
            }
            case "session.resume": {
                if (h.summary.kind !== "agent") return fail("unsupported", "only a run resumes onto a page");
                if (h.summary.status === "running" || h.summary.status === "waiting") return fail("conflict", "that session is still going");
                // A blank target becomes a REAL tab, because that is what opening one does. Reporting a page with no
                // tab id would leave the run looking as homeless as it was a moment ago, and the page would go on
                // offering to resume something it had just resumed.
                const tabId = c.target.kind === "tab" ? c.target.tabId : nextFakeTabId++;
                const url = c.target.kind === "tab"
                    ? this.tabs.find((t) => t.tabId === tabId)?.url ?? "https://example.com/"
                    : (c.target.kind === "blank" && c.target.url) || "https://example.com/";
                // The note the real runtime writes, so the divider is exercised by the demo rather than only by a
                // test: a resume a reader cannot see is how the seam stops being drawn without anyone noticing.
                this.emit(key, {
                    ...base, id: `${c.session.hash}-r${now}`, kind: "session-resumed", url,
                    ...(h.summary.page?.url ? { fromUrl: h.summary.page.url } : {}),
                    afterMs: Math.max(0, now - h.summary.lastTs),
                    dropped: ["live references to elements on the old page", "the page's state object", "approval grants"],
                } as MlDebugEvent);
                this.updateSummary(key, { page: { url, tabId } });
                // A budget means "and carry it on", the way the real runtime reads it: the demo world has to show
                // the one press doing both, or the dialog's picker looks like a setting with no effect.
                if (c.maxSteps != null) {
                    if (!Number.isInteger(c.maxSteps) || c.maxSteps < 1) return fail("invalid", "maxSteps must be a whole number of steps");
                    this.emit(key, { ...base, id: c.session.hash, kind: "agent-cap", maxSteps: c.maxSteps } as MlDebugEvent);
                    this.updateSummary(key, { status: "running" });
                }
                return ok({ session: c.session, ...(c.maxSteps != null ? { maxSteps: c.maxSteps } : {}) });
            }
            case "session.delete":
                this.deleteSession(key);
                return ok({});
            case "session.rename": {
                if (!key || !h) return fail("not-found", "no such session");
                const title = capTitle(c.title ?? "");
                this.updateSummary(key, title ? { title, renamed: true } : { title: SIDE_REPLIES.title, renamed: undefined });
                return ok({ title });
            }
            case "session.pin":
                if (!key || !h) return fail("not-found", "no such session");
                this.updateSummary(key, c.pinned ? { pinned: true, saved: true } : { pinned: undefined });
                return ok({});
            default:
                return fail("unsupported", `the fake host does not do ${(c as Command).type}`);
        }
    }
}
