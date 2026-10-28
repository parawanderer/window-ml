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
import type { ModelChoice, RuntimeInfo } from "../session/session-host";
import { loadDraft, loadDraftFiles, loadDraftImages, saveDraft, saveDraftFiles, saveDraftImages } from "../sidebar/drafts";
import { IconEye, IconEyeOff, IconSend, IconWarn } from "../sidebar/icons";
import { FileStrip, ThumbStrip, useImageAttach } from "../sidebar/transcript/composer";
import { cursorTipOn } from "../sidebar/ui-kit";
import type { ChatStore } from "./chat-store";
import type { ChatExtras } from "./extras";
import { mayCommand } from "./grants";
import { ModelPicker } from "./model-picker";
import { KindPicker } from "./kind-picker";
import { DevicePicker } from "./device-picker";
import { blankStartState } from "./blank-start";
import { BlankStartDialog } from "./blank-start-dialog";
import { startableOn, useTargetPick, type StartKind } from "./new-session";
import { onOpenGround, startField } from "./start-field";
import { keyUse, knowsKeys, noteKeyUse } from "./view-mode";

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

/**
 * The dot field behind the start page (start-field.ts), calm around the box `boxOf` finds. A canvas fixed over the
 * whole window, under everything (the list draws over it), that takes no pointer events: a press on the page's open
 * ground stirs it. Not on a phone, where it would only cost battery behind a page that is all box.
 * @gallery none a WebGL animation behind the start page; seen with `node tests/e2e/chat-shots.mjs`
 */
function StartField({ boxOf }: { boxOf: () => Element | null }) {
    const canvas = useRef<HTMLCanvasElement>(null);
    useEffect(() => (canvas.current ? startField(canvas.current, boxOf, (t) => onOpenGround(t, ".chat-start-page")) ?? undefined : undefined), []);
    return <canvas class="chat-start-field" ref={canvas} aria-hidden="true" />;
}

/** The start page: a pill to type in, and the choices a start needs on one row inside it. */
export function StartPage({ store, onStarted, initialKind, initialRuntime, extras, narrow, back }: { store: ChatStore; onStarted: (key: string) => void; initialKind?: StartKind;
    /** the device to arrive on, where the start began at one (a runtime's `+` in the list). Ignored where that
     *  runtime cannot start this kind: the page falls back to one that can, rather than offering a dead choice. */
    initialRuntime?: string; extras?: ChatExtras; narrow?: boolean;
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
    const [runtimeId, setRuntimeId] = useState(initialRuntime ?? "");
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
    // Images and text files attached the way the session composer takes them (its own hook and strips), kept under the
    // same draft key (drafts.ts), so they survive leaving the page, a refused start and a reload.
    const att = useImageAttach(() => loadDraftImages("start"), {
        files: { target: () => kind, accepts: () => !!rt?.capabilities.attachFiles, initial: () => loadDraftFiles("start") },
    });
    useEffect(() => { saveDraftImages("start", att.imgs); }, [att.imgs]);
    useEffect(() => { saveDraftFiles("start", att.docs.filter(d => d.text !== undefined).map(d => ({ name: d.name, type: d.type, text: d.text! }))); }, [att.docs]);
    const [busy, setBusy] = useState(false);
    const [askingPage, setAskingPage] = useState(false);
    const pick = useTargetPick(store, rt, kind === "agent", extras, true);
    // The chosen runtime's models, asked once per runtime (the first answer costs it a capability probe per model,
    // cached after). "" is the runtime's own default, which sends no `model` at all, so its choice stands.
    // The last list each runtime gave is drawn at once and refreshed behind it, so only the first open of the page
    // waits (with a placeholder pill the real one fades into, rather than a pill that jumps into the row).
    const [models, setModels] = useState<ModelChoice[] | null>(() => (rt ? modelCache.get(rt.id) ?? null : null));
    const [model, setModel] = useState("");
    // NATIVE VISION for this run, as the Commander's eye toggle has it: offered only for a model the runtime says is a
    // CLOUD one (an Ollama model's vision is probed, and an unknown provenance gets no toggle), and dropped whenever
    // the model or the device changes, so a choice made for one model never rides along to another.
    const [vision, setVision] = useState(false);
    useEffect(() => { setVision(false); }, [model, rt?.id]);
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
    // The key hint is drawn only to a device that has not yet shown it knows the keys (`knowsKeys`), and one that
    // learns them while it is up watches it go (`.retired`) rather than having it cut away.
    const learned = knowsKeys(keyUse.value);
    const [hintDrawn] = useState(() => !learned);
    useEffect(() => { box.current?.focus(); }, [kind]);
    useEffect(() => { if (initialKind) setKind(initialKind); }, [initialKind]);
    useEffect(() => { if (initialRuntime) setRuntimeId(initialRuntime); }, [initialRuntime]);
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
    // STREAM THE THINKING, always. It used to be a choice on a runtime reached over a wire, because every
    // `agent-stream` event carried the whole answer so far rather than the part that is new — a five-minute turn
    // was 118 MB. A remote preview now carries a bounded tail at a fixed rate (hub #330), which measured 1.70 MB
    // for the same turn and does not grow with it, so there is nothing left to choose between. Only an agent asks:
    // a chat the worker hosts always streams (`chat-stream`, sw-chat.ts), so `chat.start` has no option to send.
    const streaming = kind === "agent";
    // Text, or an image or a file alone: the start commands accept any of them (session-commands.ts).
    const ready = (!!text.trim() || att.imgs.length > 0 || att.sendable.length > 0) && !busy && rt.online && (kind === "chat" || (pick.ready && blocked.kind === "ok"));
    const start = async (): Promise<void> => {
        if (!ready) return;
        setBusy(true);
        const images = att.imgs, files = att.sendable;
        try {
            const r = kind === "chat"
                ? await store.send({ type: "chat.start", runtime: rt.id, text: text.trim(), ...(images.length ? { images } : {}), ...(files.length ? { files } : {}), ...(model ? { model } : {}) })
                : await store.send({ type: "agent.start", runtime: rt.id, task: text.trim(), ...(images.length ? { images } : {}), ...(files.length ? { files } : {}), target: pick.target(), ...(model ? { model } : {}), ...(vision && cloud ? { vision: true as const } : {}), ...(streaming ? { stream: true as const } : {}) });
            // A refusal is already a notice; what was typed stays, to be changed and tried again.
            if (r.ok) { saveDraft("start", ""); saveDraftImages("start", []); saveDraftFiles("start", []); att.clear(); onStarted(`${r.data.session.runtime}:${r.data.session.hash}`); }
        } finally { setBusy(false); }
    };
    // THE MODEL: in the box's row where the page is wide enough to hold it, at the TOP of the page on a phone. There the
    // row keeps only what this start needs (the kind, the tab, send) and fits on one line; the top bar has the room.
    // In that bar it is a HEADING (`head`), which is what a session's own header makes of the model — a solid pill
    // sitting alone under a back arrow read as a control that had been left there rather than as the bar's title.
    const modelAs = (head: boolean) => (models && models.length
        // KEYED ON THE KIND so it arrives with the pills beside it. The model list is per RUNTIME, not per kind, so
        // this pill is the one that does not unmount when the kind changes — and a one-shot animation only plays on
        // mount. Device and tab both come and go with the kind, so without this the row half faded and half popped.
        ? <ModelPicker key={`${kind}-${rt.id}`} models={models} value={model} onChange={setModel} head={head} />
        : models === null && canList ? <span class={`tp-pill tp-pill-model${head ? " chat-head-model" : ""} tp-pill-wait`} role="status" aria-label="Loading models" /> : null);
    const chosen = models?.find((m) => (model ? m.id === model : m.default));
    const cloud = kind === "agent" && chosen?.where === "cloud";
    const visionToggle = cloud ? (
        <button class={`cmp-vis${vision ? " on" : ""}`} type="button" aria-pressed={vision}
            aria-label={vision ? "Native vision on for this run" : "Native vision off for this run"}
            {...cursorTipOn(vision
                ? "This run: the model sees images itself (native vision). Click to turn off."
                : "This run: no native vision, so images go to the reader model. Click to turn on for a cloud model that can see.")}
            onClick={() => setVision((v) => !v)}>{vision ? <IconEye /> : <IconEyeOff />}</button>
    ) : null;
    const modelTop = modelAs(false);
    const modelHead = modelAs(true);
    // The session composer's own button and tooltip. On a wide page the row's first control; on a phone, at the foot beside send, where the row has no room for a 40px target.
    const attachButton = (
        <button class="tt cbtn chat-start-attach" type="button" onClick={() => att.fileRef.current?.click()} aria-label={att.canFiles ? "Attach a file" : "Attach an image"}>＋<span class="tt-pop left above" role="tooltip">{att.canFiles ? "Attach an image or a text file (or paste or drop one)" : "Attach an image (or paste one into the box)"}</span></button>
    );
    const sendButton = (
        <button class="tt cbtn csend chat-start-send" disabled={!ready} onClick={() => void start()} aria-label={kind === "agent" ? "Start the run" : "Start the chat"}>
            <IconSend /><span class="tt-pop above" role="tooltip">{busy ? "Starting…" : kind === "agent" ? "Start the run" : "Start the chat"}</span>
        </button>
    );
    // THE CHOICES, as pills, at every width. The kind was a segmented control on a wide page, which spends the room
    // of two pills permanently showing the option you did not pick — and once a new tab's URL box joins the row, that
    // is paid for by the device, the tab and the model, all three cut to "D…". One idiom, and the same one the phone
    // has always used.
    const row = (
        <div class="chat-start-row">
            {narrow ? null : attachButton}
            {kinds.length > 1 ? <KindPicker kinds={kinds} value={kind} onChange={setKind} /> : null}
            {/* The device comes BEFORE the model, because it is what decides which models there are: picking
                a machine after its model list would be choosing from a list the next choice replaces. */}
            {runtimes.length > 1 ? <DevicePicker runtimes={runtimes} value={rt.id} onChange={setRuntimeId} /> : null}
            {pick.inline}
            {narrow ? null : modelTop}
            {visionToggle}
            {!rt.online ? <span class="chat-start-wait">Reconnecting…</span> : null}
            {/* Said in the row rather than only on send: the choice is already made by the time anyone
                types, and a send button that simply will not go is the thing this replaces. */}
            {blocked.kind !== "ok" ? (
                <button class="chat-start-blocked" onClick={() => setAskingPage(true)}>
                    <IconWarn />New tab needs permission
                </button>
            ) : null}
            {narrow ? null : <><span class="sp" />{sendButton}</>}
        </div>
    );
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
            {narrow ? null : <StartField boxOf={() => box.current?.closest(".chat-start-box") ?? null} />}
            <div class="chat-start-col">
                {/* NARROW: the choices sit OUTSIDE the box, above it and across the full width, as the phone app's
                    own start screen has them. Inside it they read as part of the message being composed; they are not
                    — they are what the message will be sent AS, and they outlive it. A row under a growing textarea
                    is also pushed about by what is typed. Ordered in the DOM rather than with `order`, so the
                    keyboard walks them in the order they are drawn. */}
                {narrow ? <div class="chat-start-above">{row}{pick.urlField}</div> : null}
                <div class="chat-start-box" onDragOver={att.onDragOver} onDrop={att.onDrop}>
                    <ThumbStrip imgs={att.imgs} loading={att.loading} onRemove={att.remove} />
                    <FileStrip docs={att.docs} reasons={att.reasons} onRemove={att.removeDoc} />
                    <input ref={att.fileRef} type="file" accept={att.fileAccept} multiple style="display:none" aria-hidden="true" tabIndex={-1}
                        onChange={(e) => { att.addFiles((e.target as HTMLInputElement).files); (e.target as HTMLInputElement).value = ""; }} />
                    <textarea ref={box} rows={1} value={text} aria-label={kind === "agent" ? "Task" : "Message"}
                        placeholder={kind === "agent" ? "What should the agent do?" : "Start a chat"}
                        onPaste={att.onPaste}
                        onInput={(e: any) => { setText(e.target.value); saveDraft("start", e.target.value); }}
                        onKeyDown={(e: KeyboardEvent) => {
                            if (e.key !== "Enter") return;
                            if (e.shiftKey) { noteKeyUse("newline"); return; }
                            e.preventDefault();
                            if (ready) noteKeyUse("send");
                            void start();
                        }} />
                    {narrow ? <div class="chat-start-foot">{attachButton}{sendButton}</div> : <>{row}{pick.urlField}</>}
                </div>
                {askingPage && blocked.kind !== "ok" ? (
                    <BlankStartDialog state={blocked} onClose={() => setAskingPage(false)}
                        onUrl={(u) => pick.useUrl(u)} onTabs={() => { pick.useTabs(); setAskingPage(false); }}
                        {...(canGrant && grantOrigin ? { grant: (o: string) => (grantOrigin(rt.id, o) ?? (async () => false))() } : {})} />
                ) : null}
                {hintDrawn ? <div class={`chat-start-hint${learned ? " retired" : ""}`} aria-hidden={learned ? true : undefined}>Enter to start · Shift+Enter for a new line</div> : null}
            </div>
        </div>
        </>
    );
}
