// snapshot.ts — WHAT THE PHONE APP'S CHROME SHOWS, computed page-side from the client's state: the open session's header,
// composer and waiting bar (`SessionChrome`), in the same words the web page uses. Pure, so the rules are unit-tested
// without a WebView, and the app never re-derives a grant or a status on its own (docs/spec/NATIVE_SHELL.md).

import type { Principal, RuntimeInfo, SessionKey, SessionSummary } from "../session-host";
import { mayCommand } from "../chat/grants";
import type { SessionChrome } from "./bridge";

/** The chrome for one open session. `live` is the transcript's own view of it (a run in flight shows as `pending` there
 *  before the index says `running`); `pageOwnsModel` is true once the runtime refused a switch because a page script
 *  runs the session. Null when the session is not in the index. */
export function sessionChrome(key: SessionKey, summary: SessionSummary | undefined, rt: RuntimeInfo | undefined,
    self: Principal | undefined, live?: { pending: boolean; title?: string }, pageOwnsModel = false): SessionChrome | null {
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
        canSend,
        ...(readOnly ? { readOnly } : {}),
        running: !!live?.pending || summary.status === "running",
        canSwitchModel: !switchNote,
        ...(switchNote ? { switchNote } : {}),
    };
}
