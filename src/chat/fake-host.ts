// A SCRIPTED `SessionHost`, for developing and testing the chat core with no extension and no hub
// (docs/spec/CHAT_PAGE.md §Testing both places). It keeps real per-session event logs with an epoch and cursors, so
// the stream rules are exercised as a real host would exercise them: resume from a position, `reset` after a restart
// that kept history, `backfilled` truncated after one that did not, `gone` on delete. Commands are checked against
// the runtime's grants and capabilities, recorded, and answered with plausible events.
//
// Development only. It ships in the web build until `HubHost` exists (slice 6) and never in the extension.
import type { MlDebugEvent } from "../contract";
import {
    COMMAND_SCOPE, SESSION_CONTRACT_VERSION, sessionKey,
    type Command, type CommandResult, type HostStatus, type Principal, type RuntimeId, type RuntimeInfo, type SessionHost,
    type SessionId, type SessionIndexUpdate, type SessionKey, type SessionStreamMessage, type SessionSummary, type StreamPosition, type Unsubscribe,
} from "../session-host";
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
const DEMO_TABS = [
    { tabId: 11, url: "https://news.example/front", title: "The front page", active: true, windowId: 1 },
    { tabId: 12, url: "https://docs.example/api/tables", title: "Tables — API reference", active: false, windowId: 1 },
    { tabId: 13, url: "https://mail.example/inbox", title: "Inbox (3)", active: false, windowId: 2 },
];

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

    constructor(opts: { self?: Principal; runtimes: RuntimeInfo[]; sessions?: { summary: SessionSummary; events?: MlDebugEvent[] }[]; latencyMs?: number }) {
        this.self = opts.self ?? { id: "fake-device", kind: "device", name: "This device" };
        this._runtimes = opts.runtimes;
        this.latencyMs = opts.latencyMs ?? 0;
        for (const s of opts.sessions ?? []) this.addSession(s.summary, s.events);
    }

    /** delay before every delivery and command result, to see loading states */
    latencyMs: number;

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
        return { type: "event", v: SESSION_CONTRACT_VERSION, session: h.summary.id, epoch: h.epoch, cursor: e.cursor, event: e.event };
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
        const from = resumable ? since!.cursor : -Infinity;
        for (const e of h.log) if (e.cursor > from) out.push(this.envelope(h, e));
        out.push({ type: "backfilled", session: h.summary.id, epoch, cursor: h.log.at(-1)?.cursor ?? 0, truncated: h.lostBefore > 0 && !resumable });
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
                return caps.tabs ? ok({ tabs: DEMO_TABS }) : fail("unsupported", "this runtime has no tabs");
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
                const hash = newHash();
                const key = sessionKey({ runtime: rt.id, hash });
                this.addSession({ id: { runtime: rt.id, hash }, kind: "agent", status: "running", createdTs: Date.now(), lastTs: Date.now(), pendingApprovals: 0, saved: !c.ephemeral, task: c.task });
                this.emit(key, { id: hash, ts: Date.now(), save: !c.ephemeral, session: { hash, turn: 0 }, kind: "agent", task: c.task, model: c.model ?? "fake", maxSteps: c.maxSteps ?? 10, config: undefined as never } as MlDebugEvent);
                return ok({ session: { runtime: rt.id, hash } });
            }
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
            case "session.cancel":
                if (h.summary.kind === "agent") this.emit(key, { ...base, kind: "agent-result", summary: "", steps: 0, hitCap: false, cancelled: true });
                this.updateSummary(key, { status: "cancelled", pendingApprovals: 0 });
                return ok({});
            case "session.continue":
                if (h.summary.status !== "capped") return fail("conflict", "only a run stopped at its step cap can continue");
                this.updateSummary(key, { status: "running" });
                return ok({});
            case "session.delete":
                this.deleteSession(key);
                return ok({});
            default:
                return fail("unsupported", `the fake host does not do ${(c as Command).type}`);
        }
    }
}
