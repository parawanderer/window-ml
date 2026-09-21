// What this client may offer on a runtime, read from its grants (docs/spec/SESSION_CONTRACT.md). Presentation only:
// the runtime checks every command against its own copy, so a wrong answer here costs a greyed-out button or a
// `forbidden` result, never access.
import { COMMAND_SCOPE, SESSION_CONTRACT_VERSION, type CommandType, type Principal, type RuntimeInfo, type Scope, type SessionKey, type SessionSummary } from "../session-host";

/** Does `runtime` grant `scope` over this session (or over the runtime as a whole, when `session` is absent)? An
 *  expired grant holds nothing. `started` covers only sessions this client's principal started. */
export function holds(runtime: RuntimeInfo | undefined, scope: Scope, session?: { key: SessionKey; summary?: SessionSummary }, self?: Principal, now = Date.now()): boolean {
    if (!runtime) return false;
    return runtime.grants.some((g) => {
        if (g.scope !== scope) return false;
        if (g.expires != null && g.expires <= now) return false;
        const covers = g.sessions ?? "all";
        if (covers === "all" || !session) return true;
        if (covers === "started") return !!self && session.summary?.startedBy?.id === self.id;
        return covers.includes(session.key);
    });
}

/** May this client send a command of this type about the session? The scope comes from `COMMAND_SCOPE`, the one
 *  table the runtime enforces too. */
export const mayCommand = (runtime: RuntimeInfo | undefined, type: CommandType, session?: { key: SessionKey; summary?: SessionSummary }, self?: Principal): boolean =>
    holds(runtime, COMMAND_SCOPE[type], session, self);

/** A runtime this client can render: it speaks a contract major version the client knows. Anything else is listed
 *  and explained, never rendered half-understood. */
export const speaksOurContract = (runtime: RuntimeInfo): boolean => runtime.contractVersion === SESSION_CONTRACT_VERSION;

/** May this device start a `kind` session on `runtime`? Online, offering that kind, and holding the grant to ask. The
 *  one rule the page's start form and the phone's new-session screen both follow. */
export const mayStart = (runtime: RuntimeInfo, kind: "chat" | "agent"): boolean =>
    runtime.online && !!runtime.capabilities?.[kind] && mayCommand(runtime, kind === "chat" ? "chat.start" : "agent.start");

/**
 * May this session be picked up on a page from here? A run, saved, not going, and this client allowed to ask.
 *
 * `page.tabId` absent is the tell that the tab it ran on has closed: that is when the composer cannot reach it, and
 * offering a resume beside a composer that already works would be two ways to do one thing.
 */
export function resumableHere(rt: RuntimeInfo | undefined, key: SessionKey, summary: SessionSummary | undefined, self?: Principal): boolean {
    if (!rt?.online || !summary || summary.kind !== "agent" || !summary.saved) return false;
    if (summary.status === "running" || summary.status === "waiting") return false;
    if (summary.page?.tabId != null) return false;
    return mayCommand(rt, "session.resume", { key, summary }, self);
}
