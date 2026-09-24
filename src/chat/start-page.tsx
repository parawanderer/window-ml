// start-page.tsx — WHAT THE PAGE SHOWS WITH NOTHING OPEN: a box to start the next session in, Gemini's empty screen
// without the greeting. This is a brainstorming tool, and the first thing on it is somewhere to put a thought.
//
// It replaced "Pick a session." and the separate start form: the compose button in the list and the rail now come
// here. Agent is the default, because a run on a page is what this page is for; the pill's row says which device it
// runs on (with more than one to choose from), where the run goes (an open tab, or a new one), and the model (that
// device's own list, `models.list`, its default first) — device before model, since the device decides the list.
// What starts here is saved (the start commands save unless told otherwise), so it is in the list the moment the
// runtime answers.
//
// Rendered by capability like the rest: only the kinds some runtime offers and this client may start, the "where"
// only on a runtime with tabs, and nothing at all (the old sentence) when nothing can be started.
import { useEffect, useRef, useState } from "preact/hooks";
import type { ModelChoice, RuntimeInfo } from "../session-host";
import { loadDraft, saveDraft } from "../sidebar/drafts";
import { IconAgent, IconChat, IconSend, IconWarn } from "../sidebar/icons";
import type { ChatStore } from "./chat-store";
import type { ChatExtras } from "./extras";
import { mayCommand } from "./grants";
import { ModelPicker } from "./model-picker";
import { KindPicker } from "./kind-picker";
import { DevicePicker } from "./device-picker";
import { blankStartState } from "./blank-start";
import { BlankStartDialog } from "./blank-start-dialog";
import { startableOn, useTargetPick, type StartKind } from "./new-session";

/** Each runtime's model list as last answered, for the page's life: a start page opened again draws it at once. */
const modelCache = new Map<string, ModelChoice[]>();

/** How long a runtime that dropped away still keeps the start page drawn: the extension's worker is stopped by the
 *  browser whenever it idles (about every 30 seconds) and is back within a second, and redrawing the page from
 *  nothing each time read as the page reloading on its own. */
export const START_GRACE_MS = 5000;

/**
 * `on`, held true for `ms` after it last was. For what should survive a reconnect without pretending to be up: the
 * caller still reads the live state for anything that acts.
 */
export function useHeldTrue(on: boolean, ms: number): boolean {
    const [held, setHeld] = useState(on);
    useEffect(() => {
        if (on) { setHeld(true); return; }
        const t = setTimeout(() => setHeld(false), ms);
        return () => clearTimeout(t);
    }, [on, ms]);
    return on || held;
}

/** The start page: a pill to type in, and the choices a start needs on one row inside it. */
export function StartPage({ store, onStarted, initialKind, extras, narrow, back }: { store: ChatStore; onStarted: (key: string) => void; initialKind?: StartKind; extras?: ChatExtras; narrow?: boolean;
    /** the way back, on a phone: drawn as the first thing in the top bar, beside the model */
    back?: preact.ComponentChildren }) {
    // Kept through a reconnect like the runtime below, or the Agent/Chat switch would vanish and come back with it.
    const liveKinds = (["agent", "chat"] as const).filter((k) => startableOn(store, k).length > 0);
    const lastKinds = useRef<StartKind[]>(liveKinds);
    if (liveKinds.length) lastKinds.current = liveKinds;
    const kinds = liveKinds.length ? liveKinds : lastKinds.current;
    const [kindPick, setKind] = useState<StartKind>(initialKind ?? "agent");
    const kind: StartKind = kinds.includes(kindPick) ? kindPick : kinds[0] ?? "agent";
    const runtimes = startableOn(store, kind);
    const [runtimeId, setRuntimeId] = useState("");
    // The runtime last drawn is kept while it reconnects (START_GRACE_MS), so the choices below, the tab list and the
    // models already asked for, stay as they were instead of being dropped and asked for again. It cannot start
    // anything until it is back: `ready` reads `online`.
    const last = useRef<string>("");
    const live: RuntimeInfo | undefined = runtimes.find((r) => r.id === runtimeId) ?? runtimes[0];
    const kept = useHeldTrue(!!live, START_GRACE_MS);
    const rt: RuntimeInfo | undefined = live ?? (kept ? store.runtimes.value.find((r) => r.id === last.current) : undefined);
    if (live) last.current = live.id;
    // Saved as typed (drafts.ts) and kept until a start succeeds: leaving the page or losing the app loses nothing.
    const [text, setText] = useState(() => loadDraft("start"));
    const [busy, setBusy] = useState(false);
    const [askingPage, setAskingPage] = useState(false);
    const pick = useTargetPick(store, rt, kind === "agent", extras);
    // The chosen runtime's models, asked once per runtime (the first answer costs it a capability probe per model,
    // cached after). "" is the runtime's own default, which sends no `model` at all, so its choice stands.
    // The last list each runtime gave is drawn at once and refreshed behind it, so only the first open of the page
    // waits (with a placeholder pill the real one fades into, rather than a pill that jumps into the row).
    const [models, setModels] = useState<ModelChoice[] | null>(() => (rt ? modelCache.get(rt.id) ?? null : null));
    const [model, setModel] = useState("");
    // Whether a placeholder was drawn: only then does the real pill animate in (a cached list is simply there).
    const waited = useRef(false);
    if (models === null) waited.current = true;
    const canList = !!rt && mayCommand(rt, "models.list");
    useEffect(() => {
        setModels(rt ? modelCache.get(rt.id) ?? null : null); setModel("");
        if (!rt || !canList) return;
        let live = true;
        const id = rt.id;
        void store.send({ type: "models.list", runtime: id }, { quiet: true }).then((r) => {
            // An embedding model cannot chat or run an agent. Absent kinds mean UNKNOWN (a cloud model), never "none",
            // so only a model that says it embeds is left out.
            const list = r.ok ? r.data.models.filter((m) => !m.kinds?.includes("embedding")) : [];
            if (r.ok) modelCache.set(id, list);
            if (live) setModels(list);
        });
        return () => { live = false; };
    }, [rt?.id, canList]);
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
    // CAN a new tab even be opened here? The runtime answers (`blankStart`), so this is known before anyone presses
    // send rather than after the start is refused — and it is re-answered the moment a grant lands, with no polling.
    const grantOrigin = extras?.grantOrigin?.bind(extras);
    const canGrant = !!grantOrigin?.(rt.id, "https://x/*");
    // Only where the run would use the RUNTIME'S OWN default page. Once a URL is named here the question has been
    // answered — by picking one of the sites it already holds, or by someone typing one deliberately — and going on
    // blocking it would make the way out unreachable, which is what the first version of this did.
    const blocked = kind === "agent" && pick.blank && !pick.url ? blankStartState(rt, canGrant) : { kind: "ok" as const };
    const ready = !!text.trim() && !busy && rt.online && (kind === "chat" || (pick.ready && blocked.kind === "ok"));
    const start = async (): Promise<void> => {
        if (!ready) return;
        setBusy(true);
        try {
            const r = kind === "chat"
                ? await store.send({ type: "chat.start", runtime: rt.id, text: text.trim(), ...(model ? { model } : {}) })
                : await store.send({ type: "agent.start", runtime: rt.id, task: text.trim(), target: pick.target(), ...(model ? { model } : {}) });
            // A refusal is already a notice; what was typed stays, to be changed and tried again.
            if (r.ok) { saveDraft("start", ""); onStarted(`${r.data.session.runtime}:${r.data.session.hash}`); }
        } finally { setBusy(false); }
    };
    // THE MODEL: in the box's row where the page is wide enough to hold it, at the TOP of the page on a phone. There the
    // row keeps only what this start needs (the kind, the tab, send) and fits on one line; the top bar has the room.
    // In that bar it is a HEADING (`head`), which is what a session's own header makes of the model — a solid pill
    // sitting alone under a back arrow read as a control that had been left there rather than as the bar's title.
    const modelAs = (head: boolean) => (models && models.length
        ? <ModelPicker models={models} value={model} onChange={setModel} arrived={waited.current} head={head} />
        : models === null && canList ? <span class={`tp-pill tp-pill-model${head ? " chat-head-model" : ""} tp-pill-wait`} role="status" aria-label="Loading models" /> : null);
    const modelTop = modelAs(false);
    const modelHead = modelAs(true);
    return (
        <>
        {/* ONE ROW, not a button floating over a bar that was padded to dodge it. The back button and the model are
            the same kind of thing here — where you came from, and what this will run on — and a session's own header
            already reads `‹ <model>`, so a new one that reads differently is a second grammar for the same bar. It is
            that same bar now, markup and all (`head chat-head`, `chat-head-title`): the rule under it, the round back
            button, the model as the heading. It had been a bare pill on an empty page, which read as a stray control. */}
        {narrow && (back || modelHead) ? (
            <div class="head chat-head chat-start-top">
                {back}
                <span class="chat-head-title">{modelHead}</span>
                <span class="sp" />
            </div>
        ) : null}
        <div class="chat-start-page">
            <div class="chat-start-col">
                <div class="chat-start-box">
                    <textarea ref={box} rows={1} value={text} aria-label={kind === "agent" ? "Task" : "Message"}
                        placeholder={kind === "agent" ? "What should the agent do?" : "Start a chat"}
                        onInput={(e: any) => { setText(e.target.value); saveDraft("start", e.target.value); }}
                        onKeyDown={(e: KeyboardEvent) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void start(); } }} />
                    <div class="chat-start-row">
                        {kinds.length > 1 && narrow ? <KindPicker kinds={kinds} value={kind} onChange={setKind} />
                            : kinds.length > 1 ? (
                            <div class="chat-seg" role="radiogroup" aria-label="Kind">
                                {kinds.map((k) => (
                                    <button key={k} role="radio" aria-checked={k === kind} class={`chat-seg-opt${k === kind ? " on" : ""}`}
                                        onClick={() => setKind(k)}>{k === "agent" ? <IconAgent /> : <IconChat />}{k === "agent" ? "Agent" : "Chat"}</button>
                                ))}
                            </div>
                        ) : null}
                        {/* The device comes BEFORE the model, because it is what decides which models there are: picking
                            a machine after its model list would be choosing from a list the next choice replaces. */}
                        {runtimes.length > 1 ? <DevicePicker runtimes={runtimes} value={rt.id} onChange={setRuntimeId} /> : null}
                        {pick.inline}
                        {narrow ? null : modelTop}
                        {!rt.online ? <span class="chat-start-wait">Reconnecting…</span> : null}
                        {/* Said in the row rather than only on send: the choice is already made by the time anyone
                            types, and a send button that simply will not go is the thing this replaces. */}
                        {blocked.kind !== "ok" ? (
                            <button class="chat-start-blocked" onClick={() => setAskingPage(true)}>
                                <IconWarn />New tab needs permission
                            </button>
                        ) : null}
                        <span class="sp" />
                        <button class="tt cbtn csend chat-start-send" disabled={!ready} onClick={() => void start()} aria-label={kind === "agent" ? "Start the run" : "Start the chat"}>
                            <IconSend /><span class="tt-pop above" role="tooltip">{busy ? "Starting…" : kind === "agent" ? "Start the run" : "Start the chat"}</span>
                        </button>
                    </div>
                </div>
                {askingPage && blocked.kind !== "ok" ? (
                    <BlankStartDialog state={blocked} onClose={() => setAskingPage(false)}
                        onUrl={(u) => pick.useUrl(u)} onTabs={() => { pick.useTabs(); setAskingPage(false); }}
                        {...(canGrant && grantOrigin ? { grant: (o: string) => (grantOrigin(rt.id, o) ?? (async () => false))() } : {})} />
                ) : null}
                <div class="chat-start-hint">Enter to start · Shift+Enter for a new line · saved to the list as it starts</div>
            </div>
        </div>
        </>
    );
}
