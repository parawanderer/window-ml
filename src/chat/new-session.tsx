// STARTING OR RESUMING A SESSION FROM THE CHAT PAGE: the list header's `+`, the small form behind it, and the same
// form with the message taken out for picking a saved run back up (docs/spec/CHAT_PAGE.md). Until this, every session
// in the list had been started somewhere else — a console call, a page script, the HUD — and the page could only
// answer what already existed.
//
// Starting and resuming ask the same question about WHERE, which is why the picker is one component: a resume is a
// navigation from the agent's side, so offering it a different set of places to go than a fresh run would be a
// difference with nothing behind it.
//
// Rendered by capability, like everything else here: a runtime offers "new chat" only where `capabilities.chat` says
// it can, "new agent run" only where `capabilities.agent` does, and the tab picker only where `capabilities.tabs`
// does. A phone talking to a headless box gets a chat form and no tabs, without this file knowing what a box is.
import type { ComponentChildren } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import type { AgentTarget, Principal, RuntimeInfo, SessionKey, SessionSummary, TabGroupInfo, TabInfo } from "../session-host";
import { truncate } from "../sidebar/format";
import type { ChatStore } from "./chat-store";
import type { ChatExtras } from "./extras";
import { mayCommand } from "./grants";
import { TabPicker } from "./tab-picker";

/** What a new session can be. */
export type StartKind = "chat" | "agent";

/** The runtimes this device may start `kind` on: it can, and this client is allowed to ask. */
export function startableOn(store: ChatStore, kind: StartKind): RuntimeInfo[] {
    const command = kind === "chat" ? "chat.start" : "agent.start";
    return store.runtimes.value.filter((rt) => rt.online && !!rt.capabilities?.[kind] && mayCommand(rt, command));
}

/** The compose button, in the list's header and on the rail: it opens the start page (start-page.tsx), on Agent
 *  where some runtime can run one. Nothing at all where no runtime offers either kind. `icon` replaces the `+`. */
export function StartMenu({ store, onPick, icon }: { store: ChatStore; onPick: (kind: StartKind) => void; icon?: ComponentChildren }) {
    const kinds: StartKind[] = (["agent", "chat"] as const).filter((k) => startableOn(store, k).length > 0);
    if (!kinds.length) return null;
    return (
        <button class="tt chat-start hbtn" aria-label="New session" onClick={() => onPick(kinds[0])}>
            {icon ?? "+"}<span class="tt-pop" role="tooltip">New session</span>
        </button>
    );
}

/** Where a run goes: an open tab, or a new one. Shared by a fresh run and a resume, which ask the same question. */
export interface TargetPick {
    /** the command's `target`, built from whatever is currently chosen */
    target(): AgentTarget;
    /** is there something to go to? (a tab chosen, or a new tab, which always is) */
    ready: boolean;
    /** the form rows, to drop into a form */
    fields: preact.JSX.Element | null;
    /** the same choice as one compact control (and a URL box when a new tab is picked), for a composer's row */
    inline: preact.JSX.Element | null;
}

/**
 * The WHERE half of both forms. A runtime with no tabs at all (a box) is never asked the question, and its form
 * offers no tab to run on: the tabs are the runtime's, so they are asked for per runtime and re-asked when it changes.
 */
export function useTargetPick(store: ChatStore, rt: RuntimeInfo | undefined, enabled: boolean, extras?: ChatExtras): TargetPick {
    const [where, setWhere] = useState<"tab" | "blank">("tab");
    const [tabId, setTabId] = useState<number | null>(null);
    const [url, setUrl] = useState("");
    const [tabs, setTabs] = useState<TabInfo[] | null>(null);
    const [groups, setGroups] = useState<TabGroupInfo[]>([]);
    const [withheld, setWithheld] = useState(0);
    const wantsTabs = enabled && !!rt?.capabilities?.tabs;
    // Asked when the runtime changes, and again each time the picker opens: tabs open and close while this page sits,
    // and an icon that was still on its way the first time is there the second. A refresh keeps the list it has on
    // screen until the new one lands, rather than flashing "Loading".
    const seq = useRef(0);
    const load = (fresh: boolean) => {
        if (!wantsTabs || !rt) { setTabs(null); return; }
        const n = ++seq.current;
        if (fresh) setTabs(null);
        void store.send({ type: "tabs.list", runtime: rt.id }, { quiet: true }).then((r) => {
            if (n !== seq.current) return;
            if (!r.ok && !fresh) return;   // a refresh that failed leaves the last good list
            const list = r.ok ? r.data.tabs : [];
            setGroups(r.ok ? r.data.groups ?? [] : []);
            setWithheld(r.ok ? r.data.withheld ?? 0 : 0);
            setTabs(list);
            // The first list picks the tab showing in the first window. A refresh NEVER moves a choice: a chosen tab
            // that has closed stays chosen and says so (`closed`), because silently switching to whichever tab is in
            // front would start an agent on a page nobody picked.
            setTabId((id) => (id != null && (!fresh || list.some((t) => t.tabId === id)) ? id : list.find((t) => t.active)?.tabId ?? list[0]?.tabId ?? null));
            if (fresh && !list.length) setWhere("blank");
        });
    };
    useEffect(() => { load(true); return () => { seq.current++; }; }, [rt?.id, wantsTabs]);

    const closed = where === "tab" && tabId != null && !!tabs && !tabs.some((t) => t.tabId === tabId);
    return {
        target: () => (where === "tab" && tabId != null ? { kind: "tab", tabId } : { kind: "blank", ...(url.trim() ? { url: url.trim() } : {}) }),
        ready: where === "blank" || (tabId != null && !closed),
        fields: enabled ? (
            <>
                <label class="chat-new-field" data-field="where"><span>Where</span>
                    <select value={where} onChange={(e: any) => setWhere(e.target.value)}>
                        <option value="tab" disabled={!tabs?.length}>{tabs?.length ? "An open tab" : "An open tab (none)"}</option>
                        <option value="blank">A new tab</option>
                    </select>
                </label>
                {where === "tab" ? (
                    <label class="chat-new-field" data-field="tab"><span>Tab</span>
                        <select value={tabId ?? ""} onChange={(e: any) => setTabId(Number(e.target.value))} disabled={!tabs}>
                            {tabs === null ? <option>Loading…</option>
                                : tabs.map((t) => <option key={t.tabId} value={t.tabId}>{truncate(t.title || t.url, 70)}</option>)}
                        </select>
                    </label>
                ) : (
                    <label class="chat-new-field" data-field="page"><span>Page</span>
                        <input type="url" value={url} placeholder="https://… (or the runtime's own start page)"
                            onInput={(e: any) => setUrl(e.target.value)} />
                    </label>
                )}
            </>
        ) : null,
        inline: enabled ? (
            <>
                <TabPicker tabs={tabs} groups={groups} value={where === "tab" && tabId != null ? tabId : "blank"}
                    onOpen={() => load(false)}
                    runtime={rt?.id}
                    groupsGrant={rt ? extras?.fix?.(rt.id, "tab-groups") : null}
                    withheld={withheld}
                    sitesGrant={rt ? extras?.fix?.(rt.id, "site-access") : null}
                    groupsHint="Group names and colours need a browser permission, given on the computer these tabs are on."
                    onChange={(v) => { if (v === "blank") setWhere("blank"); else { setWhere("tab"); setTabId(v); } }} />
                {where === "blank" ? (
                    <input class="chat-pick-url" type="url" value={url} aria-label="Page to open" placeholder="https://… (optional)"
                        onInput={(e: any) => setUrl(e.target.value)} />
                ) : null}
            </>
        ) : null,
    };
}

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

/**
 * Pick a saved run back up on a page. The same WHERE the start form asks, with the message taken out: resuming takes
 * no turn, so there is nothing to type. What it will LOSE is said before it happens rather than reported after — the
 * runtime writes the same list into the transcript, and a person deciding where to resume wants it first.
 */
export function ResumeSession({ store, rt, session, onResumed, onCancel }: {
    store: ChatStore;
    rt: RuntimeInfo;
    session: { runtime: string; hash: string };
    onResumed: () => void;
    onCancel: () => void;
}) {
    const [busy, setBusy] = useState(false);
    const pick = useTargetPick(store, rt, true);
    const resume = async (): Promise<void> => {
        if (!pick.ready || busy) return;
        setBusy(true);
        try {
            // A refusal is already on screen as a notice, so the form stays as it is: pick somewhere else and retry.
            const r = await store.send({ type: "session.resume", session, target: pick.target() });
            if (r.ok) onResumed();
        } finally { setBusy(false); }
    };
    return (
        <main class="chat-main chat-new">
            <div class="head">
                <b>Resume this run</b>
                <span class="sp" />
                <button class="hbtn" onClick={onCancel} aria-label="Close">×</button>
            </div>
            <div class="view chat-new-body">
                {pick.fields}
                <p class="chat-resume-lost" data-field="lost">
                    It carries on from what it had said, on the page you pick. It does not carry over live references
                    to elements on the old page, that page's state, cached fetches, tools a page script defined, or
                    approval grants: consent belongs to the tab it was given in, and is asked again.
                </p>
                <div class="chat-new-foot">
                    <span class="chat-new-hint">The same run, not a new one: it keeps its hash and its history.</span>
                    <button class="btn primary" disabled={!pick.ready || busy} onClick={() => void resume()}>{busy ? "Resuming…" : "Resume"}</button>
                </div>
            </div>
        </main>
    );
}
