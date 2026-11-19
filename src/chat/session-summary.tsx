// session-summary.tsx — the session summary page: what one session is and what it holds, opened from its "..." menu.
//
// docs/spec/SESSION_SUMMARY.md. The page READS: every line comes from a source that answers it for this session, and a
// field with no source, or whose source answers "unknown", draws NOTHING (no zero, no "idle", no dash). This shell draws
// the summary tab from the index row (`SessionSummary`) and the runtime (`RuntimeInfo`) only; the other tabs say in one
// line what they would hold, until their PRs mount what fills them.

import { signal } from "@preact/signals";
import { useEffect, useState } from "preact/hooks";
import type { RuntimeInfo, SessionKey, SessionKind, SessionStatus, SessionSummary } from "../session/session-host";
import type { ChatStore } from "./chat-store";
import { Dialog } from "../sidebar/dialog";
import { fmtAge } from "../sidebar/timestamps";
import { truncate } from "../sidebar/format";
import { approvalsPending, STATUS_LABEL } from "./status-words";

/** The session whose summary is open, by key, or null. One at a time, drawn by `SessionSummaryDialog`, which reads the
 *  row and the runtime LIVE from the store so the page follows the session while it is open. */
export const summaryFor = signal<SessionKey | null>(null);   // state: ui — which summary page is open

/** The summary tab's words for a status: the list's words where it has them, and the two the list leaves unsaid. */
const STATE_WORDS = { running: "running", done: "finished", ...STATUS_LABEL } satisfies Partial<Record<SessionStatus, string>>;

/** The summary tab's word for each kind of session. Total, so a new kind fails to compile here rather than read as a chat. */
const KIND_WORDS = { chat: "Chat", agent: "Agent run", embed: "Embed" } satisfies Record<SessionKind, string>;

/** One line of the summary tab: a label and its value. `key` names the field, for a test and a stable list key. */
export interface SummaryLine { key: string; label: string; value: string }

/**
 * The summary tab's lines for one session, in the spec's order, each only where its source answers it.
 *
 * Absent sources are ABSENT lines: no `model` (or `null`, "not known"), no `startedBy`, no `page`. Open asks are
 * drawn only above zero: zero is the ordinary case, and a session waiting on a person already says so in its state.
 * A runtime's timestamps are put on this client's clock through `clockOffsetMs` before they are aged.
 * @param s the index row
 * @param rt the runtime the session is on
 * @param now this client's clock, epoch ms
 */
export function summaryLines(s: SessionSummary, rt: RuntimeInfo, now: number): SummaryLine[] {
    const off = rt.clockOffsetMs ?? 0;
    const local = (ts: number) => ts - off;
    const out: SummaryLine[] = [];
    const state = STATE_WORDS[s.status];
    if (state) out.push({ key: "state", label: "State", value: state });
    if (s.pendingApprovals > 0) out.push({ key: "asks", label: "Open asks", value: approvalsPending(s.pendingApprovals) });
    if (Number.isFinite(s.lastTs)) out.push({ key: "last", label: "Last activity", value: `${fmtAge(Math.max(0, now - local(s.lastTs)))} ago` });
    out.push({ key: "kind", label: "Kind", value: KIND_WORDS[s.kind] });
    if (typeof s.model === "string" && s.model) out.push({ key: "model", label: "Model", value: s.model });
    out.push({ key: "runtime", label: "Runtime", value: rt.online ? rt.name : `${rt.name} (offline)` });
    // The page it STARTED on: the index has no current page, so the label says which one this is.
    if (s.page?.url) out.push({ key: "page", label: "Started on", value: s.page.title ? `${s.page.title} — ${s.page.url}` : s.page.url });
    if (Number.isFinite(s.createdTs)) {
        const when = new Date(local(s.createdTs)).toLocaleString();
        const by = s.startedBy?.name;
        out.push({ key: "started", label: "Started", value: by ? `${when}, by ${by}` : when });
    }
    return out;
}

/** The page's tabs, in the spec's order. The summary is home. */
export const SUMMARY_TABS = ["summary", "resources", "files", "access"] as const;
/** One of the summary page's tabs, by name. */
export type SummaryTab = typeof SUMMARY_TABS[number];

const TAB_NAME: Record<SummaryTab, string> = { summary: "Summary", resources: "Resources", files: "Files", access: "Access" };

/** What a tab with nothing drawn yet says, in one line: what it would hold, and why it is empty. */
const EMPTY_TAB: Record<Exclude<SummaryTab, "summary">, string> = {
    resources: "This session's share of the machine, and its usage over time. Not drawn here yet.",
    files: "This session's files. There is no file store yet.",
    access: "What this session may reach: its policies, the shell host, the page's origin. Not drawn here yet.",
};

/**
 * One session's summary page: its title and id, a tab strip, and the open tab. Drawn inside whatever frame the
 * surface gives it (the dialog below; the gallery draws it bare).
 * @gallery {"s":{"id":{"runtime":"local","hash":"a1b2c3d4"},"kind":"agent","status":"waiting","title":"Plot the fare prices","model":"qwen3:32b","createdTs":1795100000000,"lastTs":1795103000000,"pendingApprovals":2,"saved":true,"page":{"url":"https://flights.example/search","title":"Flights AMS → LIS"},"startedBy":{"id":"local","kind":"local","name":"This browser"}},"rt":{"id":"local","name":"This browser","kind":"browser","online":true,"contractVersion":1,"capabilities":{},"grants":[]},"title":"Plot the fare prices","now":1795103120000}
 * @group chat
 */
export function SessionSummaryPage({ s, rt, title, now = Date.now() }: { s: SessionSummary; rt: RuntimeInfo; title: string; now?: number }) {
    const [tab, setTab] = useState<SummaryTab>("summary");
    return (
        <div class="sum-page">
            <h2 id="sum-h" class="sum-title">{truncate(title, 120)}</h2>
            <div class="sum-hash">{s.id.hash}</div>
            <div class="sum-tabs" role="tablist" aria-label="Summary sections">
                {SUMMARY_TABS.map((t) => (
                    <button type="button" role="tab" id={`sum-tab-${t}`} aria-selected={tab === t} aria-controls="sum-panel"
                        class={`sum-tab${tab === t ? " on" : ""}`} onClick={() => setTab(t)}>{TAB_NAME[t]}</button>
                ))}
            </div>
            <div id="sum-panel" role="tabpanel" aria-labelledby={`sum-tab-${tab}`} class="sum-panel">
                {tab === "summary"
                    ? <dl class="sum-lines">{summaryLines(s, rt, now).map((l) => <div class="sum-line" key={l.key} data-field={l.key}><dt>{l.label}</dt><dd>{l.value}</dd></div>)}</dl>
                    : <p class="sum-empty">{EMPTY_TAB[tab]}</p>}
            </div>
        </div>
    );
}

/** The summary page as a modal card, mounted once by each surface beside its other dialogs. Over a phone it is the
 *  dismissable overlay the spec asks for: closing it leaves the transcript where it was. A session that leaves the
 *  index while open (deleted, its runtime gone) closes it.
 *  @gallery none draws only while `summaryFor` names a session; the page it frames is `SessionSummaryPage` */
export function SessionSummaryDialog({ store }: { store: ChatStore }) {
    const key = summaryFor.value;
    const s = key ? store.index.value.get(key) : undefined;
    const rt = s ? store.runtimes.value.find((r) => r.id === s.id.runtime) : undefined;
    const gone = !!key && (!s || !rt);
    useEffect(() => { if (gone) summaryFor.value = null; }, [gone]);
    if (!s || !rt) return null;
    const close = () => (summaryFor.value = null);
    return (
        <Dialog onClose={close} labelledBy="sum-h" wide>
            <SessionSummaryPage s={s} rt={rt} title={s.title || s.task || "Session"} />
            <div class="chat-dialog-actions">
                <button type="button" class="btn" onClick={close}>Close</button>
            </div>
        </Dialog>
    );
}
