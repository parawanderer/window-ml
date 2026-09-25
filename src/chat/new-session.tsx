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
import { STEP_BUDGETS } from "../step-budget";
import { useEffect, useRef, useState } from "preact/hooks";
import type { AgentTarget, RuntimeInfo, TabGroupInfo, TabInfo } from "../session-host";
import { truncate } from "../sidebar/format";
import type { ChatStore } from "./chat-store";
import { Dialog } from "./dialog";
import type { ChatExtras } from "./extras";
import { mayStart } from "./grants";
import { TabPicker } from "./tab-picker";

/** What a new session can be. */
export type StartKind = "chat" | "agent";

/** The runtimes this device may start `kind` on: it can, and this client is allowed to ask. */
export function startableOn(store: ChatStore, kind: StartKind): RuntimeInfo[] {
    return store.runtimes.value.filter((rt) => mayStart(rt, kind));
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
    /** is a NEW tab what is currently chosen? (the one target whose page has to be opened, and so permitted) */
    blank: boolean;
    /** the page a new tab would open, where one was NAMED here. Empty means "whatever the runtime's setting says",
     *  which is the only case a client can be told about in advance. */
    url: string;
    /** point a new-tab run at `url`. For an answer to "that page cannot be opened": the chooser picks another. */
    useUrl(url: string): void;
    /** send the chooser back to the runtime's open tabs, which need no page opened and so no permission. */
    useTabs(): void;
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
    // A TAB BELONGS TO ONE MACHINE, so nothing about the target survives a change of device. Keeping the id meant the
    // pill read "That tab closed · pick another" about a tab that is open and perfectly fine on the machine you had
    // just left — and on a runtime with no tabs at all there was no list coming that could ever clear it. It goes back
    // to a new tab rather than to that device's active tab: picking one machine's foreground page because you chose
    // the machine is a second choice nobody made. What was TYPED stays, since a URL is not a tab.
    const lastRt = useRef<string | undefined>(rt?.id);
    useEffect(() => {
        if (lastRt.current !== rt?.id) { lastRt.current = rt?.id; setWhere("blank"); setTabId(null); }
        load(true);
        return () => { seq.current++; };
    }, [rt?.id, wantsTabs]);

    const closed = where === "tab" && tabId != null && !!tabs && !tabs.some((t) => t.tabId === tabId);
    return {
        target: () => (where === "tab" && tabId != null ? { kind: "tab", tabId } : { kind: "blank", ...(url.trim() ? { url: url.trim() } : {}) }),
        ready: where === "blank" || (tabId != null && !closed),
        blank: where === "blank",
        url: url.trim(),
        useUrl: (u) => { setWhere("blank"); setUrl(u); },
        useTabs: () => { setWhere("tab"); },
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
                    loading={wantsTabs && tabs === null}
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
 * Pick a saved run back up on a page. The same WHERE the start form asks, with the message taken out: resuming takes
 * no turn, so there is nothing to type. What it will LOSE is said before it happens rather than reported after — the
 * runtime writes the same list into the transcript, and a person deciding where to resume wants it first.
 *
 * It is a DIALOG over the session rather than a screen replacing it: this is a question about the run you are reading,
 * and the form used to take the transcript away to ask it — so deciding meant leaving, and changing your mind meant
 * finding the ×. It leaves the same way every other dialog here does (Escape, the backdrop, Cancel).
 */
export function ResumeSession({ store, rt, session, onResumed, onCancel }: {
    store: ChatStore;
    rt: RuntimeInfo;
    session: { runtime: string; hash: string };
    onResumed: () => void;
    onCancel: () => void;
}) {
    const [busy, setBusy] = useState(false);
    // The budget it carries on with. A resume that re-homes a run and leaves it stopped is two presses for one
    // intention — you came here to make it go — so the form asks how far, and the answer is what makes it go.
    const [steps, setSteps] = useState<number>(STEP_BUDGETS[1]);
    const pick = useTargetPick(store, rt, true);
    const resume = async (): Promise<void> => {
        if (!pick.ready || busy) return;
        setBusy(true);
        try {
            // A refusal is already on screen as a notice, so the form stays as it is: pick somewhere else and retry.
            const r = await store.send({ type: "session.resume", session, target: pick.target(), maxSteps: steps });
            if (r.ok) onResumed();
        } finally { setBusy(false); }
    };
    return (
        <Dialog onClose={onCancel} labelledBy="chat-res-h" describedBy="chat-res-p" wide>
            <h2 id="chat-res-h">Resume this run</h2>
            {/* `inline`, not `fields`: the same pickers the start page uses, with the page's own icon on a tab and the
                group rail down its list. The `fields` pair is a native `<select>` each, which reads as a different
                product's form the moment it sits beside them. */}
            <div class="chat-dialog-form">
                <div class="chat-dialog-pick"><span class="chat-dialog-lead">Resume on</span>{pick.inline}</div>
                <div class="chat-dialog-pick"><span class="chat-dialog-lead">And give it</span>
                    <div class="chat-seg" role="radiogroup" aria-label="Steps to carry on with">
                        {STEP_BUDGETS.map((n) => (
                            <button key={n} type="button" role="radio" aria-checked={steps === n}
                                class={`chat-seg-opt${steps === n ? " on" : ""}`} onClick={() => setSteps(n)}>{n} steps</button>
                        ))}
                    </div>
                </div>
                <p id="chat-res-p" class="chat-resume-lost" data-field="lost">
                    The same run, not a new one: it keeps its hash and its history, and carries straight on from what
                    it had said, on the page you pick. It does not carry over live references to elements on the old page,
                    that page's state, cached fetches, tools a page script defined, or approval grants: consent
                    belongs to the tab it was given in, and is asked again.
                </p>
            </div>
            <div class="chat-dialog-actions">
                <button class="btn" onClick={onCancel}>Cancel</button>
                <button class="btn primary" disabled={!pick.ready || busy} onClick={() => void resume()}>{busy ? "Resuming…" : "Resume and go"}</button>
            </div>
        </Dialog>
    );
}
