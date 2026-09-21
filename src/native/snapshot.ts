// snapshot.ts — WHAT THE PHONE APP'S CHROME SHOWS, computed page-side from the client's state: the open session's header,
// composer and waiting bar (`SessionChrome`), in the same words the web page uses. Pure, so the rules are unit-tested
// without a WebView, and the app never re-derives a grant or a status on its own (docs/spec/NATIVE_SHELL.md).

import type { AgentTarget, Principal, RuntimeInfo, SessionKey, SessionSummary } from "../session-host";
import { mayCommand, mayStart, resumableHere } from "../chat/grants";
import type { AttentionRow, SessionChrome } from "./bridge";
import { attentionCount, attentionItems } from "../chat/attention";

/** The chrome for one open session. `live` is the transcript's own view of it (a run in flight shows as `pending` there
 *  before the index says `running`); `pageOwnsModel` is true once the runtime refused a switch because a page script
 *  runs the session. Null when the session is not in the index. */
export function sessionChrome(key: SessionKey, summary: SessionSummary | undefined, rt: RuntimeInfo | undefined,
    self: Principal | undefined, live?: { pending: boolean; title?: string; gateAway?: boolean }, pageOwnsModel = false): SessionChrome | null {
    if (!summary) return null;
    const target = { key, summary };
    const drive = !!rt && mayCommand(rt, "session.send", target, self);
    const online = !!rt?.online;
    const canSend = online && drive;
    const readOnly = canSend ? undefined
        : !rt ? "This session's runtime is not listed."
        : !online ? `${rt.name} is offline. You can read this session, and send to it once it is back.`
        : `This device may watch sessions on ${rt.name}, not drive them.`;
    const offered = !!rt?.capabilities.switchModel;
    const maySwitch = !!rt && online && mayCommand(rt, "session.model", target, self);
    const switchNote = !offered ? "This runtime cannot switch a session's model. A new session can start on any of these."
        : pageOwnsModel ? "This session's model belongs to the page script that runs it, so it cannot be switched from here."
        : !online ? `${rt!.name} is offline.`
        : !maySwitch ? "This device may not switch this session's model." : undefined;
    return {
        key,
        kind: summary.kind,
        title: summary.title || live?.title || summary.task || "Session",
        status: summary.status,
        runtime: summary.id.runtime,
        runtimeName: rt?.name ?? summary.id.runtime,
        model: summary.model ?? null,
        pendingApprovals: rt && mayCommand(rt, "approval.answer", target, self) ? summary.pendingApprovals : 0,
        // The transcript says whether the card that answers is on screen; the app's bar is for when it is not.
        approvalOffscreen: !!live?.gateAway,
        canSend,
        ...(readOnly ? { readOnly } : {}),
        running: !!live?.pending || summary.status === "running",
        canSwitchModel: !switchNote,
        ...(switchNote ? { switchNote } : {}),
        // The same questions the page's row menu asks (row-menu.tsx): reachable, and holding the grant to ask.
        pinned: !!summary.pinned,
        canPin: online && mayCommand(rt, "session.pin", target, self),
        canRename: online && mayCommand(rt, "session.rename", target, self),
        canDelete: online && mayCommand(rt, "session.delete", target, self),
        // The page's own peek rule (chat-app.tsx `usePeek`): a tab still open, a runtime that captures, the grant to ask.
        canPeek: online && summary.page?.tabId != null && !!rt?.capabilities.screenshots && mayCommand(rt, "tab.screenshot", target, self),
        canResume: resumableHere(rt, key, summary, self),
    };
}

/**
 * What the runtimes need a hand with, for the phone's inbox, in the page's own words. Nothing is fixable FROM a phone:
 * every fix is a click in the runtime's own browser or its Settings, so each item says which device, and the app
 * offers no button that could not work. Dismissed suggestions are the app's to remember; it gets them all.
 */
export function attentionForApp(runtimes: readonly RuntimeInfo[]): { items: AttentionRow[]; count: number } {
    const items = attentionItems(runtimes, new Map(), () => false);
    return {
        items: items.map((i) => ({ key: i.key, runtime: i.runtime.id, runtimeName: i.runtime.name, level: i.level, title: i.title, detail: i.detail })),
        count: attentionCount(items),
    };
}

/** The runtimes this device may start each kind of session on, for the app's new-session screen: the page's rule, so
 *  the app never filters grants itself. */
export function startableFor(runtimes: readonly RuntimeInfo[]): { chat: string[]; agent: string[] } {
    return { chat: runtimes.filter((r) => mayStart(r, "chat")).map((r) => r.id), agent: runtimes.filter((r) => mayStart(r, "agent")).map((r) => r.id) };
}

/**
 * An agent's target as the app sent it, checked: a tab by a whole-number id, or a new tab at an http(s) page or at the
 * runtime's own start page. Anything else is null, and the start is refused rather than guessed at.
 */
export function agentTarget(t: unknown): AgentTarget | null {
    if (!t || typeof t !== "object") return null;
    const o = t as { kind?: unknown; tabId?: unknown; url?: unknown };
    if (o.kind === "tab") return Number.isInteger(o.tabId) ? { kind: "tab", tabId: o.tabId as number } : null;
    if (o.kind !== "blank") return null;
    if (o.url === undefined || o.url === "") return { kind: "blank" };
    if (typeof o.url !== "string") return null;
    try {
        const u = new URL(o.url);
        return u.protocol === "https:" || u.protocol === "http:" ? { kind: "blank", url: u.href } : null;
    } catch {
        return null;
    }
}
