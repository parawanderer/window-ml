// STARTING A SESSION FROM THE CHAT PAGE: the list header's `+`, and the small form behind it
// (docs/spec/CHAT_PAGE.md). Until this, every session in the list had been started somewhere else — a console call, a
// page script, the HUD — and the page could only answer what already existed.
//
// Rendered by capability, like everything else here: a runtime offers "new chat" only where `capabilities.chat` says
// it can, "new agent run" only where `capabilities.agent` does, and the tab picker only where `capabilities.tabs`
// does. A phone talking to a headless box gets a chat form and no tabs, without this file knowing what a box is.
import { useEffect, useState } from "preact/hooks";
import type { AgentTarget, RuntimeInfo, TabInfo } from "../session-host";
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

/** The list header's `+`: what can be started, or nothing at all when no runtime offers either. */
export function StartMenu({ store, onPick }: { store: ChatStore; onPick: (kind: StartKind) => void }) {
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
        return <button class="chat-start hbtn" aria-label={kinds[0] === "chat" ? "New chat" : "New agent run"} onClick={() => onPick(kinds[0])}>+</button>;
    }
    const pick = (k: StartKind) => { setOpen(false); onPick(k); };
    return (
        <span class="chat-start menuwrap">
            <button class={`hbtn${open ? " on" : ""}`} aria-label="New session" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>+</button>
            {open ? (
                <div class="menu" role="menu">
                    <button class="menu-item" role="menuitem" onClick={() => pick("chat")}>New chat<span class="menu-hint">a conversation, no tools</span></button>
                    <button class="menu-item" role="menuitem" onClick={() => pick("agent")}>New agent run<span class="menu-hint">on a page, with tools</span></button>
                </div>
            ) : null}
        </span>
    );
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
    const [where, setWhere] = useState<"tab" | "blank">("tab");
    const [tabId, setTabId] = useState<number | null>(null);
    const [url, setUrl] = useState("");
    const [tabs, setTabs] = useState<TabInfo[] | null>(null);
    const [busy, setBusy] = useState(false);

    // The tabs are the runtime's, so they are asked for per runtime and re-asked when it changes. A runtime with no
    // tabs at all (a box) never gets the question, and its form offers no tab to run on.
    const wantsTabs = kind === "agent" && !!rt?.capabilities?.tabs;
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

    if (!rt) return null;
    const ready = !!text.trim() && !busy && (kind === "chat" || where === "blank" || tabId != null);

    const start = async (): Promise<void> => {
        if (!ready) return;
        setBusy(true);
        try {
            const r = kind === "chat"
                ? await store.send({ type: "chat.start", runtime: rt.id, text: text.trim() })
                : await store.send({ type: "agent.start", runtime: rt.id, task: text.trim(), target: target() });
            // A refusal is already on screen as a notice (the store raises one), so the form stays as it is with
            // what was typed still in it: the person changes the target or the wording and tries again.
            if (r.ok) onStarted(`${r.data.session.runtime}:${r.data.session.hash}`);
        } finally { setBusy(false); }
    };
    const target = (): AgentTarget =>
        where === "tab" && tabId != null ? { kind: "tab", tabId } : { kind: "blank", ...(url.trim() ? { url: url.trim() } : {}) };

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

                {kind === "agent" ? (
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
                ) : null}

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
