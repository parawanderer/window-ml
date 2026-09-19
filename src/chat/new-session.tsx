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
import { useEffect, useState } from "preact/hooks";
import type { AgentTarget, Principal, RuntimeInfo, SessionKey, SessionSummary, TabInfo } from "../session-host";
import { truncate } from "../sidebar/format";
import type { ChatStore } from "./chat-store";
import { mayCommand } from "./grants";

/** What a new session can be. */
export type StartKind = "chat" | "agent";

/** The runtimes this device may start `kind` on: it can, and this client is allowed to ask. */
export function startableOn(store: ChatStore, kind: StartKind): RuntimeInfo[] {
    const command = kind === "chat" ? "chat.start" : "agent.start";
    return store.runtimes.value.filter((rt) => rt.online && !!rt.capabilities?.[kind] && mayCommand(rt, command));
}

/** The list header's `+`: what can be started, or nothing at all when no runtime offers either. `icon` replaces the
 *  `+` (the rail draws a compose glyph there). */
export function StartMenu({ store, onPick, icon }: { store: ChatStore; onPick: (kind: StartKind) => void; icon?: ComponentChildren }) {
    const [open, setOpen] = useState(false);
    const kinds: StartKind[] = (["chat", "agent"] as const).filter((k) => startableOn(store, k).length > 0);
    useEffect(() => {
        if (!open) return;
        const onDown = (e: Event) => { if (!(e.target as HTMLElement)?.closest?.(".chat-start")) setOpen(false); };
        const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
        document.addEventListener("pointerdown", onDown);
        document.addEventListener("keydown", onKey);
        return () => { document.removeEventListener("pointerdown", onDown); document.removeEventListener("keydown", onKey); };
    }, [open]);
    if (!kinds.length) return null;
    // One kind needs no menu: the button is that kind.
    if (kinds.length === 1) {
        return <button class="chat-start hbtn" aria-label={kinds[0] === "chat" ? "New chat" : "New agent run"} onClick={() => onPick(kinds[0])}>{icon ?? "+"}</button>;
    }
    const pick = (k: StartKind) => { setOpen(false); onPick(k); };
    return (
        <span class="chat-start menuwrap">
            <button class={`hbtn${open ? " on" : ""}`} aria-label="New session" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>{icon ?? "+"}</button>
            {open ? (
                <div class="menu" role="menu">
                    <button class="menu-item" role="menuitem" onClick={() => pick("chat")}>New chat<span class="menu-hint">a conversation, no tools</span></button>
                    <button class="menu-item" role="menuitem" onClick={() => pick("agent")}>New agent run<span class="menu-hint">on a page, with tools</span></button>
                </div>
            ) : null}
        </span>
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
}

/**
 * The WHERE half of both forms. A runtime with no tabs at all (a box) is never asked the question, and its form
 * offers no tab to run on: the tabs are the runtime's, so they are asked for per runtime and re-asked when it changes.
 */
export function useTargetPick(store: ChatStore, rt: RuntimeInfo | undefined, enabled: boolean): TargetPick {
    const [where, setWhere] = useState<"tab" | "blank">("tab");
    const [tabId, setTabId] = useState<number | null>(null);
    const [url, setUrl] = useState("");
    const [tabs, setTabs] = useState<TabInfo[] | null>(null);
    const wantsTabs = enabled && !!rt?.capabilities?.tabs;
    useEffect(() => {
        if (!wantsTabs || !rt) { setTabs(null); return; }
        let live = true;
        setTabs(null);
        void store.send({ type: "tabs.list", runtime: rt.id }, { quiet: true }).then((r) => {
            if (!live) return;
            const list = r.ok ? r.data.tabs : [];
            setTabs(list);
            setTabId((id) => (id != null && list.some((t) => t.tabId === id) ? id : list.find((t) => t.active)?.tabId ?? list[0]?.tabId ?? null));
            if (!list.length) setWhere("blank");
        });
        return () => { live = false; };
    }, [rt?.id, wantsTabs]);

    return {
        target: () => (where === "tab" && tabId != null ? { kind: "tab", tabId } : { kind: "blank", ...(url.trim() ? { url: url.trim() } : {}) }),
        ready: where === "blank" || tabId != null,
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
    };
}

/** The form. It closes itself once the runtime answers with a session, which the caller then opens. */
export function NewSession({ store, kind, onStarted, onCancel }: {
    store: ChatStore;
    kind: StartKind;
    onStarted: (key: string) => void;
    onCancel: () => void;
}) {
    const runtimes = startableOn(store, kind);
    const [runtimeId, setRuntimeId] = useState(runtimes[0]?.id ?? "");
    const rt = runtimes.find((r) => r.id === runtimeId) ?? runtimes[0];
    const [text, setText] = useState("");
    const [busy, setBusy] = useState(false);
    const pick = useTargetPick(store, rt, kind === "agent");

    if (!rt) return null;
    const ready = !!text.trim() && !busy && (kind === "chat" || pick.ready);

    const start = async (): Promise<void> => {
        if (!ready) return;
        setBusy(true);
        try {
            const r = kind === "chat"
                ? await store.send({ type: "chat.start", runtime: rt.id, text: text.trim() })
                : await store.send({ type: "agent.start", runtime: rt.id, task: text.trim(), target: pick.target() });
            // A refusal is already on screen as a notice (the store raises one), so the form stays as it is with
            // what was typed still in it: the person changes the target or the wording and tries again.
            if (r.ok) onStarted(`${r.data.session.runtime}:${r.data.session.hash}`);
        } finally { setBusy(false); }
    };
    return (
        <main class="chat-main chat-new">
            <div class="head">
                <b>{kind === "chat" ? "New chat" : "New agent run"}</b>
                <span class="sp" />
                <button class="hbtn" onClick={onCancel} aria-label="Close">×</button>
            </div>
            <div class="view chat-new-body">
                {runtimes.length > 1 ? (
                    <label class="chat-new-field" data-field="runtime"><span>On</span>
                        <select value={runtimeId} onChange={(e: any) => setRuntimeId(e.target.value)}>
                            {runtimes.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
                        </select>
                    </label>
                ) : null}

                {pick.fields}

                <label class="chat-new-field tall" data-field="text"><span>{kind === "chat" ? "Message" : "Task"}</span>
                    <textarea rows={4} value={text} autofocus
                        placeholder={kind === "chat" ? "Ask anything…" : "What should it do on that page?"}
                        onInput={(e: any) => setText(e.target.value)}
                        onKeyDown={(e: KeyboardEvent) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void start(); }} />
                </label>

                <div class="chat-new-foot">
                    <span class="chat-new-hint">{kind === "agent" ? "It can act on that page, and asks before anything that matters." : "A plain conversation: no tools, no page."}</span>
                    <button class="btn primary" disabled={!ready} onClick={() => void start()}>{busy ? "Starting…" : "Start"}</button>
                </div>
            </div>
        </main>
    );
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
