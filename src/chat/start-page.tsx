// start-page.tsx — WHAT THE PAGE SHOWS WITH NOTHING OPEN: a box to start the next session in, Gemini's empty screen
// without the greeting. This is a brainstorming tool, and the first thing on it is somewhere to put a thought.
//
// It replaced "Pick a session." and the separate start form: the compose button in the list and the rail now come
// here. Agent is the default, because a run on a page is what this page is for; the pill's row says where the run
// goes (an open tab, or a new one), the model (that runtime's own list, `models.list`, the runtime's default first)
// and, with more than one, on which runtime. What starts here is saved (the start
// commands save unless told otherwise), so it is in the list the moment the runtime answers.
//
// Rendered by capability like the rest: only the kinds some runtime offers and this client may start, the "where"
// only on a runtime with tabs, and nothing at all (the old sentence) when nothing can be started.
import { useEffect, useRef, useState } from "preact/hooks";
import type { ModelChoice, RuntimeInfo } from "../session-host";
import { IconSend } from "../sidebar/icons";
import type { ChatStore } from "./chat-store";
import { mayCommand } from "./grants";
import { startableOn, useTargetPick, type StartKind } from "./new-session";

/** The start page: a pill to type in, and the choices a start needs on one row inside it. */
export function StartPage({ store, onStarted, initialKind }: { store: ChatStore; onStarted: (key: string) => void; initialKind?: StartKind }) {
    const kinds = (["agent", "chat"] as const).filter((k) => startableOn(store, k).length > 0);
    const [kindPick, setKind] = useState<StartKind>(initialKind ?? "agent");
    const kind: StartKind = kinds.includes(kindPick) ? kindPick : kinds[0] ?? "agent";
    const runtimes = startableOn(store, kind);
    const [runtimeId, setRuntimeId] = useState("");
    const rt: RuntimeInfo | undefined = runtimes.find((r) => r.id === runtimeId) ?? runtimes[0];
    const [text, setText] = useState("");
    const [busy, setBusy] = useState(false);
    const pick = useTargetPick(store, rt, kind === "agent");
    // The chosen runtime's models, asked once per runtime (the first answer costs it a capability probe per model,
    // cached after). "" is the runtime's own default, which sends no `model` at all, so its choice stands.
    const [models, setModels] = useState<ModelChoice[] | null>(null);
    const [model, setModel] = useState("");
    const canList = !!rt && mayCommand(rt, "models.list");
    useEffect(() => {
        setModels(null); setModel("");
        if (!rt || !canList) return;
        let live = true;
        void store.send({ type: "models.list", runtime: rt.id }, { quiet: true }).then((r) => {
            // An embedding model cannot chat or run an agent. Absent kinds mean UNKNOWN (a cloud model), never "none",
            // so only a model that says it embeds is left out.
            if (live) setModels(r.ok ? r.data.models.filter((m) => !m.kinds?.includes("embedding")) : []);
        });
        return () => { live = false; };
    }, [rt?.id, canList]);
    const dflt = models?.find((m) => m.default);
    const box = useRef<HTMLTextAreaElement>(null);
    useEffect(() => { box.current?.focus(); }, [kind]);
    useEffect(() => { if (initialKind) setKind(initialKind); }, [initialKind]);
    // The box grows with what is typed, to a cap, like the session composer.
    useEffect(() => {
        const el = box.current;
        if (!el) return;
        el.style.height = "auto";
        el.style.height = `${Math.min(el.scrollHeight, 280)}px`;
    }, [text]);

    if (!rt) return null;
    const ready = !!text.trim() && !busy && (kind === "chat" || pick.ready);
    const start = async (): Promise<void> => {
        if (!ready) return;
        setBusy(true);
        try {
            const r = kind === "chat"
                ? await store.send({ type: "chat.start", runtime: rt.id, text: text.trim(), ...(model ? { model } : {}) })
                : await store.send({ type: "agent.start", runtime: rt.id, task: text.trim(), target: pick.target(), ...(model ? { model } : {}) });
            // A refusal is already a notice; what was typed stays, to be changed and tried again.
            if (r.ok) onStarted(`${r.data.session.runtime}:${r.data.session.hash}`);
        } finally { setBusy(false); }
    };
    return (
        <div class="chat-start-page">
            <div class="chat-start-col">
                <div class="chat-start-box">
                    <textarea ref={box} rows={1} value={text} aria-label={kind === "agent" ? "Task" : "Message"}
                        placeholder={kind === "agent" ? "What should the agent do?" : "Start a chat"}
                        onInput={(e: any) => setText(e.target.value)}
                        onKeyDown={(e: KeyboardEvent) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void start(); } }} />
                    <div class="chat-start-row">
                        {kinds.length > 1 ? (
                            <div class="chat-seg" role="radiogroup" aria-label="Kind">
                                {kinds.map((k) => (
                                    <button key={k} role="radio" aria-checked={k === kind} class={`chat-seg-opt${k === kind ? " on" : ""}`}
                                        onClick={() => setKind(k)}>{k === "agent" ? "Agent" : "Chat"}</button>
                                ))}
                            </div>
                        ) : null}
                        {pick.inline}
                        {models && models.length ? (
                            <select class="chat-pick-rt chat-pick-model" aria-label="Model" value={model} onChange={(e: any) => setModel(e.target.value)}>
                                {/* The runtime's default, by name when it is in the list: it may not be (filtered out, or
                                    gone from the server), and then it is just "Default" and no model is sent. */}
                                <option value="">{dflt ? `Default · ${dflt.id}` : "Default"}</option>
                                {models.filter((m) => !m.default).map((m) => <option key={m.id} value={m.id}>{m.id}</option>)}
                            </select>
                        ) : null}
                        {runtimes.length > 1 ? (
                            <select class="chat-pick-rt" aria-label="Runtime" value={rt.id} onChange={(e: any) => setRuntimeId(e.target.value)}>
                                {runtimes.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
                            </select>
                        ) : null}
                        <span class="sp" />
                        <button class="tt cbtn csend chat-start-send" disabled={!ready} onClick={() => void start()} aria-label={kind === "agent" ? "Start the run" : "Start the chat"}>
                            <IconSend /><span class="tt-pop above" role="tooltip">{busy ? "Starting…" : kind === "agent" ? "Start the run" : "Start the chat"}</span>
                        </button>
                    </div>
                </div>
                <div class="chat-start-hint">Enter to start · Shift+Enter for a new line · saved to the list as it starts</div>
            </div>
        </div>
    );
}
