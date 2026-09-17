// SEVERAL HOSTS AS ONE: the chat page takes exactly one `SessionHost`, so showing this browser's sessions and hub
// runtimes together is a host too (docs/spec/CHAT_PAGE.md §Two sources).
//
// - `runtimes()` concatenates the hosts' lists. When two hosts report the SAME runtime id (this browser, seen directly
//   and through the hub), the host given first wins and the other copy is hidden: pass the direct path first.
// - `sessions()` forwards each host's updates for the runtimes that host owns. The contract sends one snapshot per
//   runtime, so nothing needs reconciling.
// - `events()` and `send()` go to the host that owns the session's or the command's runtime.
// - `status()` is online when any host is: the page keeps working on local sessions while the hub is down, and says so
//   per runtime (`RuntimeInfo.online`) rather than for the whole page.
import type { Command, CommandResult, HostStatus, Principal, RuntimeId, RuntimeInfo, SessionHost, SessionId, SessionIndexUpdate, SessionStreamMessage, StreamPosition, Unsubscribe } from "../session-host";

/** The runtime a command is for: named directly (`chat.start`, `side.call`, …) or through its session. */
const runtimeOf = (c: Command): RuntimeId => ("runtime" in c ? c.runtime : c.session.runtime);

/** A `SessionHost` over several, in priority order. */
export class CompositeHost implements SessionHost {
    readonly self: Principal;
    private lists: RuntimeInfo[][];
    private statuses: HostStatus[];
    /** runtime id → index of the host that owns it */
    private owner = new Map<RuntimeId, number>();
    private runtimeListeners = new Set<(r: RuntimeInfo[]) => void>();
    private statusListeners = new Set<(s: HostStatus) => void>();
    /** re-evaluated whenever ownership changes: event subscriptions waiting for their runtime to appear */
    private waiting = new Set<() => void>();
    private offs: Unsubscribe[] = [];

    constructor(private readonly hosts: SessionHost[]) {
        if (!hosts.length) throw new Error("CompositeHost needs at least one host");
        this.self = hosts[0].self;
        this.lists = hosts.map(() => []);
        this.statuses = hosts.map(() => ({ state: "connecting" }) as HostStatus);
        hosts.forEach((h, i) => {
            this.offs.push(
                h.runtimes((list) => { this.lists[i] = list; this.recompute(); }),
                h.status((s) => { this.statuses[i] = s; this.emitStatus(); }),
            );
        });
    }

    /** Stop listening to the inner hosts. */
    dispose(): void {
        for (const off of this.offs.splice(0)) off();
    }

    private merged(): RuntimeInfo[] {
        const out: RuntimeInfo[] = [];
        this.hosts.forEach((_, i) => { for (const r of this.lists[i]) if (this.owner.get(r.id) === i) out.push(r); });
        return out;
    }

    private recompute(): void {
        const owner = new Map<RuntimeId, number>();
        this.lists.forEach((list, i) => { for (const r of list) if (!owner.has(r.id)) owner.set(r.id, i); });
        this.owner = owner;
        const merged = this.merged();
        for (const l of this.runtimeListeners) l(merged);
        for (const w of [...this.waiting]) w();
    }

    private aggregate(): HostStatus {
        if (this.statuses.some((s) => s.state === "online")) return { state: "online" };
        if (this.statuses.some((s) => s.state === "connecting")) return { state: "connecting" };
        return this.statuses[0];
    }

    private emitStatus(): void {
        const s = this.aggregate();
        for (const l of this.statusListeners) l(s);
    }

    status(listener: (status: HostStatus) => void): Unsubscribe {
        this.statusListeners.add(listener);
        let live = true;
        queueMicrotask(() => { if (live) listener(this.aggregate()); });
        return () => { live = false; this.statusListeners.delete(listener); };
    }

    runtimes(listener: (runtimes: RuntimeInfo[]) => void): Unsubscribe {
        this.runtimeListeners.add(listener);
        let live = true;
        queueMicrotask(() => { if (live) listener(this.merged()); });
        return () => { live = false; this.runtimeListeners.delete(listener); };
    }

    sessions(listener: (update: SessionIndexUpdate) => void, opts?: { runtime?: RuntimeId }): Unsubscribe {
        const offs = this.hosts.map((h, i) => h.sessions((u) => {
            const rt = u.type === "snapshot" ? u.runtime : u.type === "upsert" ? u.session.id.runtime : u.type === "remove" ? u.id.runtime : null;
            // An update for a runtime another host owns is the shadowed copy; one for a runtime not listed yet is let
            // through, because the index and the runtime list race and dropping a snapshot would lose it for good.
            const own = rt == null ? undefined : this.owner.get(rt);
            if (own !== undefined && own !== i) return;
            listener(u);
        }, opts));
        return () => { for (const off of offs) off(); };
    }

    events(session: SessionId, listener: (message: SessionStreamMessage) => void, opts?: { since?: StreamPosition }): Unsubscribe {
        let off: Unsubscribe | null = null;
        let done = false;
        // The runtime list may not have arrived yet (a page opened straight onto a session), so wait for an owner.
        const attach = () => {
            if (done || off) return;
            const i = this.owner.get(session.runtime);
            if (i === undefined) return;
            this.waiting.delete(attach);
            off = this.hosts[i].events(session, listener, opts);
        };
        this.waiting.add(attach);
        attach();
        return () => { done = true; this.waiting.delete(attach); off?.(); };
    }

    async send<C extends Command>(command: C, opts?: { signal?: AbortSignal }): Promise<CommandResult<C["type"]>> {
        const i = this.owner.get(runtimeOf(command));
        if (i === undefined) return { ok: false, error: { code: "not-found", message: "no connected host has that runtime" } };
        return this.hosts[i].send(command, opts);
    }
}
