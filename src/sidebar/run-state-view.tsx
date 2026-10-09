// run-state-view.tsx — the RUN STATE panel (the state inspector's first step, docs/spec/STATE_INSPECTOR.md): what the
// run being read holds right now, member by member, as the worker's state registry declares it.
//
// It is a snapshot of something mutable, not a replay of events, so it says when it was taken and re-reads on a
// short interval while open. Every declared member is listed, including one holding nothing for this run: an absent
// row would read as "this kind of state does not exist", which is the question the panel is for.
import { signal } from "@preact/signals";
import { Fragment } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { JsonNode, copyableValue } from "./transcript/json-tree";
import { PanelHead } from "./panel-head";
import { TipText, cursorTipOn, type CtxItem } from "./ui-kit";
import { useCopy } from "./copy-hash";
import { MAX_CONSOLE_CHARS, MAX_NOTE_CHARS, MAX_SHARED_WATCHES, MAX_WATCH_CHARS, MAX_WATCHES, SHARED_WATCHES_KEY, WATCH_NOTES_KEY, panelPath, shareable, watchNotes, type ConsoleResult, type WatchResult, type WatchShape } from "../state-watch";
import { completeWatch, type WatchCompletion } from "../watch-complete";
import { IconCheck, IconChevron, IconCopy, IconEye, IconClose } from "./icons";
import type { RunStateDump, RunStateMember } from "../sw/sw-run-state";
import type { StateEntry, StateLoss } from "../state-registry";

/** How often an open panel re-reads. A read is a message to the worker and a walk over a dozen maps: cheap. */
export const RUN_STATE_POLL_MS = 2000;

/** What empties a member, as a short phrase for the tooltip's "lost when" row. */
const LOSS: Record<StateLoss, string> = {
    "worker-eviction": "the service worker stops (after ~30 s idle)",
    navigation: "the tab navigates",
    "offscreen-close": "the Python sandbox closes",
    "browser-restart": "the browser restarts",
    "turn-end": "the turn ends",
};

/** How long a member lives, by its scope, for the tooltip's "lives for" row. */
const SCOPE: Record<RunStateMember["scope"], string> = {
    run: "this run", session: "this session, every turn", tab: "this tab", page: "this page, until it navigates", browser: "this browser",
};

/** Which bundle holds a member, for the tooltip's "held by" row. */
const REALM: Record<RunStateMember["realm"], string> = { worker: "the service worker", page: "the page", offscreen: "the Python sandbox" };

/** Who reads a member, in a sentence: the model at a path it really has, the model not yet, or only you. */
function readerOf(m: RunStateMember): string {
    if (m.audience === "human") return "Only you see this: the model is not given it.";
    return m.exposedAs ? `The model reads this as ${m.exposedAs}.` : "Meant for the model, and not given to it yet: no ml.current path reaches it.";
}

/** A short tooltip from this pane, marked so it is drawn at the docked panels' size like the rest of the pane's tips. */
const paneTip = (text: string) => <span class="rstate-tip">{text}</span>;

/** The tooltip on a member's name: what it holds, then under a rule, one fact per row (who reads it, how long it
 *  lives, what holds it, what loses it, and its path), laid out like the resource panel's tips. */
function memberTip(m: RunStateMember) {
    const reader = m.audience === "human" ? "only you" : m.exposedAs ? "the model" : "meant for the model, not yet";
    return <span class="rstate-tip">
        {/* A declaration's sentence is written in markdown (backticked names), so it is drawn as markdown. */}
        <span class="rstate-tip-desc"><TipText md={m.describe} /></span>
        <span class="rstate-tip-sect">
            <span class="rc-tip-line"><span class="rstate-tip-k">read by</span><span>{reader}</span></span>
            <span class="rc-tip-line"><span class="rstate-tip-k">lives for</span><span>{SCOPE[m.scope]}</span></span>
            <span class="rc-tip-line"><span class="rstate-tip-k">held by</span><span>{REALM[m.realm]}</span></span>
            <span class="rc-tip-line"><span class="rstate-tip-k">lost when</span><span>{m.lostOn.length ? m.lostOn.map((l) => LOSS[l]).join(", or ") : "kept in storage"}</span></span>
            <span class="rc-tip-line"><span class="rstate-tip-k">path</span><code>{memberPath(m)}</code></span>
        </span>
    </span>;
}

/** The root of every member the model does not read: `inspector.<id>`. A prefix that is plainly not the model's, so the
 *  name alone says who can reach it; the read-only console will expose the same root. */
export const INSPECTOR_ROOT = "inspector";

/** The expression a member's value is reached by: where the model reads it when it does (`ml.current.messages`), and
 *  `inspector.<id>` otherwise. Its rows' "Copy path" extends it, so a copied path pastes into a watch or the console. */
export const memberPath = (m: RunStateMember): string => m.exposedAs ?? `${INSPECTOR_ROOT}.${m.id}`;

/** A member's name as the row shows it: its expression, with a root the model does not have drawn dimmed. */
function MemberName({ m }: { m: RunStateMember }) {
    if (m.exposedAs) return <>{m.exposedAs}:</>;
    return <><span class="rstate-root">{INSPECTOR_ROOT}.</span>{m.id}:</>;
}

/** The member's value, copied whole. Beside the name, because a right-click on the row is not where a hand goes first. */
function CopyValue({ v }: { v: unknown }) {
    const { copied, copy } = useCopy();
    return <button class="rstate-copy" aria-label="Copy the value" onClick={(e) => { e.stopPropagation(); copy(copyableValue(v)); }}
        {...cursorTipOn(paneTip("Copy the value. Right-click any row for its value or its path."))}>{copied ? <IconCheck /> : <IconCopy />}</button>;
}

/** One member, on ONE LINE until it is opened: its name, what it holds folded to a preview, and who sees it. */
function Member({ m, e }: { m: RunStateMember; e: StateEntry | undefined }) {
    const label = <span class="rstate-key" {...cursorTipOn(memberTip(m))}><MemberName m={m} /></span>;
    // An empty member has nothing to open: the chevron's width, kept blank, so its name lines up with the rest.
    const spacer = <span class="tri jt-tri-space" aria-hidden="true"><IconChevron /></span>;
    const chips = <span class="rstate-trail">
        {/* Only the person's own state is marked: that is a decision. A model member not given to the model yet is a
            gap that closes member by member, and its dimmed `inspector.` root and its tooltip already say so. */}
        {m.audience === "human" ? <span class="rstate-aud" {...cursorTipOn(paneTip(readerOf(m)))}>you only</span> : null}
        {/* The PAGE answered for this one, and a hostile page answers whatever it likes: said, not hidden. */}
        {m.realm === "page" || e?.realm === "page" ? <span class="rstate-aud rstate-page" {...cursorTipOn(paneTip("Reported by the page the run is on. A page can put anything here, so read it as the page's word."))}>from the page</span> : null}
        {e && !e.error ? <CopyValue v={e.value} /> : null}
    </span>;
    return (
        <div class={`rstate-member${e ? "" : " rstate-empty"}`} data-member={m.id}>
            {!e ? <div class="jt-row">{spacer}{label}<span class="rstate-none">none</span>{chips}</div>
                : e.error ? <div class="jt-row">{spacer}{label}<span class="hint err">could not read: {e.error}</span>{chips}</div>
                    : <JsonNode v={e.value} defaultOpen={false} path={memberPath(m)} label={label} trail={chips} times menuExtra={watchItem} />}
        </div>
    );
}

/** Groups folded on this device, by name. A module signal, so closing and reopening the panel keeps them folded. */
const folded = signal<ReadonlySet<string>>(new Set());
const FOLDED_KEY = "ml_runstate_folded";
let foldedRead = false;

/** Fold or unfold a group, and remember it on this device. */
function toggleGroup(g: string): void {
    const next = new Set(folded.value);
    if (next.has(g)) next.delete(g); else next.add(g);
    folded.value = next;
    try { chrome.storage.local.set({ [FOLDED_KEY]: [...next] }); } catch { /* no storage: it still folds, it just does not stick */ }
}

/** One group of members, under a heading that folds it. Folded, it says how many members it has and how many hold
 *  something, so a folded group still answers "is anything here". */
function Group({ g, ms, byId }: { g: string; ms: RunStateMember[]; byId: Map<string, StateEntry> }) {
    const shut = folded.value.has(g);
    const holding = ms.filter((m) => byId.has(m.id)).length;
    return (
        <section class={`rstate-group${shut ? " shut" : ""}`} data-group={g}>
            <button class="rstate-group-head" aria-expanded={!shut} onClick={() => toggleGroup(g)}>
                {g}
                {/* The fold control at the END of the heading's line, where the eye goes after reading what it heads. */}
                <span class="rstate-group-end">
                    {shut ? <span class="rstate-count">{ms.length} member{ms.length === 1 ? "" : "s"} · {holding} holding something</span> : null}
                    <span class={`tri${shut ? "" : " open"}`} aria-hidden="true"><IconChevron /></span>
                </span>
            </button>
            {shut ? null : ms.map((m) => <Member key={m.id} m={m} e={byId.get(m.id)} />)}
        </section>
    );
}

/** The watches, kept on this device for every run (a debugger's watch list is yours, not the program's), in the order
 *  they were added. A module signal, so they outlive the panel being closed. */
export const watches = signal<readonly string[]>([]);
const WATCHES_KEY = "ml_runstate_watches";

/** Add a watch, unless it is already watched; remember the list. */
export function addWatch(expr: string): void {
    const e = expr.trim();
    if (!e || watches.value.includes(e) || watches.value.length >= MAX_WATCHES) return;
    setWatches([...watches.value, e]);
}

/** Stop watching one expression, and stop sharing it; its note goes with it. */
function removeWatch(expr: string): void {
    setWatches(watches.value.filter((w) => w !== expr));
    if (shared.value.includes(expr)) setShared(shared.value.filter((w) => w !== expr));
    if (expr in notes.value) setNote(expr, "");
}

/** The person's note on each shared watch, by expression: why they shared it, handed to the model with the value. */
export const notes = signal<Readonly<Record<string, string>>>({});

/** Set or clear (an empty text) one watch's note, and remember it. */
export function setNote(expr: string, text: string): void {
    const t = text.trim().slice(0, MAX_NOTE_CHARS);
    const next = { ...notes.value };
    if (t) next[expr] = t; else delete next[expr];
    notes.value = next;
    try { chrome.storage.local.set({ [WATCH_NOTES_KEY]: next }); } catch { /* no storage: the note lasts until the page closes */ }
}

/** The line under a SHARED watch where the person says why they shared it. Saved on Enter or when it loses focus. */
function NoteLine({ expr }: { expr: string }) {
    const [draft, setDraft] = useState(notes.value[expr] ?? "");
    const save = () => { if (draft.trim() !== (notes.value[expr] ?? "")) setNote(expr, draft); };
    return (
        <div class="jt-row rstate-watch-note" data-note-for={expr}>
            <span class="tri jt-tri-space" aria-hidden="true"><IconChevron /></span>
            <input class="rstate-note-input" type="text" spellcheck={true} maxLength={MAX_NOTE_CHARS} value={draft}
                aria-label={`Note for the model on ${expr}`} placeholder="note for the model: why you shared this (optional)"
                onInput={(e) => setDraft((e.target as HTMLInputElement).value)}
                onBlur={save}
                onKeyDown={(e) => { if (e.key === "Enter") { save(); (e.target as HTMLInputElement).blur(); } if (e.key === "Escape") setDraft(notes.value[expr] ?? ""); }}
                {...cursorTipOn(paneTip("The model reads this beside the watch's value, in `ml.current.debug.userWatches`."))} />
        </div>
    );
}

/** The watches SHARED with the model (`ml.current.debug.userWatches`), a subset of {@link watches}, kept beside them. */
export const shared = signal<readonly string[]>([]);

/** Share a watch with the model, or stop sharing it. A watch over `inspector.` is never shared, and past
 *  {@link MAX_SHARED_WATCHES} nothing more is. */
export function toggleShared(expr: string): void {
    if (shared.value.includes(expr)) return setShared(shared.value.filter((w) => w !== expr));
    if (shareable(expr) && shared.value.length < MAX_SHARED_WATCHES) setShared([...shared.value, expr]);
}

function setShared(next: readonly string[]): void {
    shared.value = next;
    try { chrome.storage.local.set({ [SHARED_WATCHES_KEY]: [...next] }); } catch { /* no storage: the worker sees no shares */ }
}

/** The share toggle's tooltip: what sharing does, or why this watch cannot be shared. */
function shareTip(expr: string, on: boolean): string {
    if (on) return "Shared with the model: it reads this watch's value at `ml.current.debug.userWatches`. Click to stop sharing.";
    if (!shareable(expr)) return "Only a watch over `ml.current` can be shared: `inspector.` is your half of the state, which the model does not read.";
    if (shared.value.length >= MAX_SHARED_WATCHES) return `${MAX_SHARED_WATCHES} watches are shared already, the most the model is given.`;
    return "Share with the model: it reads this watch's value at `ml.current.debug.userWatches`, while a turn runs.";
}

function setWatches(next: readonly string[]): void {
    watches.value = next;
    try { chrome.storage.local.set({ [WATCHES_KEY]: [...next] }); } catch { /* no storage: the list lasts until the page closes */ }
}

/** The right-click item every row with a path gets: pin that path as a watch. */
const watchItem = (path: string): CtxItem[] => [{ label: "Watch this", icon: <IconEye />, run: () => addWatch(path) }];

/** A watch's or a console entry's answer, on one line until opened: `label` and `trail` frame it, as a member's name and
 *  chips frame its value. Not read yet, refused, or matching nothing each stay on that one line. */
function ResultBody({ r, label, trail }: { r: WatchResult | undefined; label: preact.ComponentChildren; trail?: preact.ComponentChildren }) {
    const spacer = <span class="tri jt-tri-space" aria-hidden="true"><IconChevron /></span>;
    if (!r) return <div class="jt-row">{spacer}{label}<span class="rstate-none">…</span>{trail}</div>;
    if (r.error) return <div class="jt-row">{spacer}{label}<span class="rstate-watch-err">{r.error}</span>{trail}</div>;
    // A JS answer is one value, at its own path when it is a plain path (`inspector.run.init.task`), so its rows copy and
    // watch like a member's; a computed one (`….length`) has no path, so its rows copy values only.
    if (!r.nodes) return r.value === undefined
        ? <div class="jt-row">{spacer}{label}<span class="rstate-none">undefined</span>{trail}</div>
        : <JsonNode v={r.value} defaultOpen={false} label={label} trail={trail} times {...(r.at ? { path: r.at, menuExtra: watchItem } : {})} />;
    const nodes = r.nodes;
    if (!nodes.length) return <div class="jt-row">{spacer}{label}<span class="rstate-none">no match</span>{trail}</div>;
    // One match is that value, at the path it was found at, so its rows copy and watch like any member's. Several are a
    // list of what matched; a list of matches has no single path, so its rows copy values only.
    return nodes.length === 1
        ? <JsonNode v={nodes[0].value} defaultOpen={false} path={panelPath(nodes[0].path)} label={label} trail={trail} times menuExtra={watchItem} />
        : <JsonNode v={nodes.map((n) => n.value)} defaultOpen={false} label={label} trail={trail} times />;
}

/** One watch, on one line until opened: its expression, what it matched, the eye that shares it and the ✕ that stops
 *  watching it. */
function WatchRow({ expr, r }: { expr: string; r: WatchResult | undefined }) {
    const label = <span class="rstate-key rstate-watch-key" {...cursorTipOn(paneTip(expr))}>{expr}:</span>;
    const on = shared.value.includes(expr);
    const trail = <span class="rstate-trail">
        <button class={`rstate-share${on ? " on" : ""}`} aria-pressed={on} aria-label={on ? `Stop sharing ${expr} with the model` : `Share ${expr} with the model`}
            disabled={!on && (!shareable(expr) || shared.value.length >= MAX_SHARED_WATCHES)}
            onClick={(e) => { e.stopPropagation(); toggleShared(expr); }} {...cursorTipOn(paneTip(shareTip(expr, on)))}><IconEye /></button>
        <button class="rstate-unwatch" aria-label={`Stop watching ${expr}`} onClick={(e) => { e.stopPropagation(); removeWatch(expr); }}
            {...cursorTipOn(paneTip("Stop watching this"))}><IconClose /></button>
    </span>;
    const empty = !!r?.nodes && !r.nodes.length;
    return <div class={`rstate-member rstate-watch${empty ? " rstate-empty" : ""}`} data-watch={expr}><ResultBody r={r} label={label} trail={trail} /></div>;
}

/**
 * The line an expression is typed on, completing against the shape of what it reads (watch-complete.ts): the watch
 * group's and the console's. Tab takes the highlighted row; Enter takes it only after the arrows were used, so Enter
 * still submits what was typed. With no list open, the arrows recall `recall`'s history, when there is one.
 */
function ExprInput({ shape, onSubmit, recall, label, placeholder, maxLength, cls = "", inputCls = "rstate-watch-input" }: {
    shape: WatchShape | undefined;
    /** Called with what was typed; the line is cleared afterwards. */
    onSubmit: (text: string) => void;
    /** The entry `dir` steps back (-1 is older) from the one shown, or undefined at either end. */
    recall?: (dir: -1 | 1) => string | undefined;
    label: string;
    placeholder: string;
    maxLength?: number;
    cls?: string;
    inputCls?: string;
}) {
    const [draft, setDraft] = useState("");
    const [caret, setCaret] = useState(0);
    // The list is open while typing, shut by Escape, a blur or a pick; `hot` is the highlighted row and `chosen` says the
    // arrows were used, which is what lets Enter take a row rather than submit what was typed.
    const [listing, setListing] = useState(false);
    const [hot, setHot] = useState(0);
    const [chosen, setChosen] = useState(false);
    const input = useRef<HTMLInputElement>(null);
    const listId = useRef(`rstate-complete-${++completeIds}`).current;
    const items = listing ? completeWatch(draft, caret, shape) : [];
    const edit = (v: string, at: number) => { setDraft(v); setCaret(at); setHot(0); setChosen(false); };
    const put = (v: string, at: number) => { edit(v, at); requestAnimationFrame(() => input.current?.setSelectionRange(at, at)); };
    const submit = () => { onSubmit(draft); edit("", 0); setListing(false); };
    const take = (c: WatchCompletion) => {
        // A method is taken with its parenthesis open: what comes next is its arguments.
        const ins = c.insert + (c.kind === "method" ? "(" : "");
        const v = draft.slice(0, c.from) + ins + draft.slice(caret);
        put(v, c.from + ins.length);
        setListing(c.kind !== "method");
    };
    const onKey = (e: KeyboardEvent) => {
        const el = e.target as HTMLInputElement;
        if (items.length && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
            e.preventDefault();
            setHot((hot + (e.key === "ArrowDown" ? 1 : items.length - 1)) % items.length);
            setChosen(true);
        } else if (recall && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
            e.preventDefault();
            const v = recall(e.key === "ArrowUp" ? -1 : 1);
            if (v !== undefined) put(v, v.length);
        } else if (items.length && (e.key === "Tab" || (e.key === "Enter" && chosen))) { e.preventDefault(); take(items[Math.min(hot, items.length - 1)]); }
        else if (e.key === "Enter") submit();
        else if (e.key === "Escape") { if (items.length) setListing(false); else edit("", 0); }
        else if (e.key === "ArrowLeft" || e.key === "ArrowRight" || e.key === "Home" || e.key === "End")
            requestAnimationFrame(() => setCaret(el.selectionStart ?? el.value.length));
    };
    return (
        <div class={`jt-row rstate-watch-add${cls ? ` ${cls}` : ""}`}>
            <span class="tri jt-tri-space" aria-hidden="true"><IconChevron /></span>
            <input ref={input} class={inputCls} type="text" spellcheck={false} aria-label={label} value={draft} maxLength={maxLength}
                role="combobox" aria-autocomplete="list" aria-expanded={items.length > 0} aria-controls={listId}
                aria-activedescendant={items.length ? `${listId}-${Math.min(hot, items.length - 1)}` : undefined}
                placeholder={placeholder}
                onInput={(e) => { const el = e.target as HTMLInputElement; edit(el.value, el.selectionStart ?? el.value.length); setListing(true); }}
                onClick={(e) => setCaret((e.target as HTMLInputElement).selectionStart ?? 0)}
                onBlur={() => setListing(false)}
                onKeyDown={onKey} />
            {items.length ? (
                <ul class="rstate-complete" id={listId} role="listbox" aria-label="Completions">
                    {items.map((c, i) => (
                        <li key={c.label} id={`${listId}-${i}`} role="option" aria-selected={i === Math.min(hot, items.length - 1)}
                            class={`rstate-complete-row ${c.kind}`}
                            // pointerdown, not click: a click lands after the input's blur has closed the list.
                            onPointerDown={(e) => { e.preventDefault(); take(c); }}>
                            <span class="rstate-complete-label">{c.label}</span>
                            {c.detail ? <span class="rstate-complete-detail">{c.detail}</span> : null}
                        </li>))}
                </ul>) : null}
        </div>
    );
}

/** Ids for each {@link ExprInput}'s list, so two on one panel do not share one. */
let completeIds = 0;

/** The watch group: every watch over this run's snapshot, then a line to add one. Shown first, since a watch is what
 *  you pinned because you came back for it. */
function WatchGroup({ results, shape }: { results: WatchResult[] | undefined; shape: WatchShape | undefined }) {
    const shut = folded.value.has("watch");
    const byExpr = new Map((results ?? []).map((r) => [r.expr, r]));
    return (
        <section class={`rstate-group rstate-watches${shut ? " shut" : ""}`} data-group="watch">
            <button class="rstate-group-head" aria-expanded={!shut} onClick={() => toggleGroup("watch")}>
                watch
                <span class="rstate-group-end">
                    {shut ? <span class="rstate-count">{watches.value.length} watch{watches.value.length === 1 ? "" : "es"}</span> : null}
                    <span class={`tri${shut ? "" : " open"}`} aria-hidden="true"><IconChevron /></span>
                </span>
            </button>
            {shut ? null : <>
                {watches.value.map((w) => <Fragment key={w}>
                    <WatchRow expr={w} r={byExpr.get(w)} />
                    {shared.value.includes(w) ? <NoteLine expr={w} /> : null}
                </Fragment>)}
                <ExprInput shape={shape} onSubmit={addWatch} label="Add a watch"
                    placeholder={watches.value.length ? "add a watch" : "add a watch: a JS expression (inspector.…, ml.current.…) or JSONPath ($..)"} />
            </>}
        </section>
    );
}

/** One console entry as it ran: what was typed, against which run, and its answer once the worker sent it. */
export interface ConsoleEntry {
    run: string;
    code: string;
    /** Absent while it runs. */
    r?: ConsoleResult;
}

/** The console's entries this browser session, every run's, newest last; a run's panel shows its own. A module signal, so
 *  closing the panel keeps them, and replaced rather than mutated, which a signal would not see. */
export const consoleEntries = signal<readonly ConsoleEntry[]>([]);
/** Entries kept, across runs: past it the oldest go. */
export const MAX_CONSOLE_ENTRIES = 100;

/** What was typed into the console, newest last and without repeats, kept on this device for the arrow keys. */
export const consoleHistory = signal<readonly string[]>([]);
const CONSOLE_HISTORY_KEY = "ml_runstate_console";
/** Lines of history kept. */
export const MAX_CONSOLE_HISTORY = 50;

/** Run one console entry against a run: once, through the worker (DUMP_RUN_STATE's `console`), over the snapshot it reads
 *  at that moment. Not re-run: a watch is what re-reads. */
export function runConsole(run: string, code: string): void {
    const c = code.trim();
    if (!c) return;
    const hist = [...consoleHistory.value.filter((h) => h !== c), c].slice(-MAX_CONSOLE_HISTORY);
    consoleHistory.value = hist;
    try { chrome.storage.local.set({ [CONSOLE_HISTORY_KEY]: hist }); } catch { /* no storage: the history lasts until the page closes */ }
    const entry: ConsoleEntry = { run, code: c };
    consoleEntries.value = [...consoleEntries.value, entry].slice(-MAX_CONSOLE_ENTRIES);
    const settle = (r: ConsoleResult) => { consoleEntries.value = consoleEntries.value.map((e) => (e === entry ? { ...e, r } : e)); };
    chrome.runtime.sendMessage({ type: "DUMP_RUN_STATE", payload: { run, console: c } },
        (a: { data?: { console?: ConsoleResult }; error?: string } | undefined) => {
            if (!a) settle({ expr: c, error: chrome.runtime.lastError?.message || "no answer from the service worker" });
            else if (a.error) settle({ expr: c, error: a.error });
            else settle(a.data?.console ?? { expr: c, error: "the service worker did not run it" });
        });
}

/** One console entry: the line as typed, what it printed, and what it answered. Its answer copies and watches like a
 *  watch's; the line itself can be pinned as a watch when it is short enough to be one. */
function ConsoleRow({ e }: { e: ConsoleEntry }) {
    const pinnable = e.code.length <= MAX_WATCH_CHARS && !watches.value.includes(e.code);
    return (
        <div class="rstate-console-entry">
            <div class="jt-row rstate-console-code">
                <span class="rstate-console-prompt" aria-hidden="true">›</span>
                <code class="rstate-console-text">{e.code}</code>
                <span class="rstate-trail">
                    {pinnable ? <button class="rstate-copy" aria-label={`Watch ${e.code}`} onClick={() => addWatch(e.code)}
                        {...cursorTipOn(paneTip("Watch this: re-read it every two seconds, above"))}><IconEye /></button> : null}
                </span>
            </div>
            {(e.r?.logs ?? []).map((l, i) => <div key={i} class="jt-row rstate-console-log"><span class="tri jt-tri-space" aria-hidden="true"><IconChevron /></span>{l}</div>)}
            <ResultBody r={e.r} label={<span class="rstate-key rstate-console-out" aria-label="Result">‹</span>} />
        </div>
    );
}

/** The CONSOLE (spec, "A console beside it"): the watch's language as a program, run once when Enter is pressed, against
 *  this run's state. Read-only, so it asks no one: it cannot write, reach the page, fetch or spend tokens. */
function ConsoleGroup({ run, shape }: { run: string; shape: WatchShape | undefined }) {
    const shut = folded.value.has("console");
    const mine = consoleEntries.value.filter((e) => e.run === run);
    // Where the arrows are in the history: 0 is the line being typed, 1 the newest entry, and so on back.
    const back = useRef(0);
    const recall = (dir: -1 | 1): string | undefined => {
        const h = consoleHistory.value;
        const next = back.current + (dir === -1 ? 1 : -1);
        if (next < 0 || next > h.length) return undefined;
        back.current = next;
        return next === 0 ? "" : h[h.length - next];
    };
    return (
        <section class={`rstate-group rstate-console${shut ? " shut" : ""}`} data-group="console">
            <button class="rstate-group-head" aria-expanded={!shut} onClick={() => toggleGroup("console")}>
                console
                <span class="rstate-group-end">
                    {shut ? <span class="rstate-count">{mine.length} entr{mine.length === 1 ? "y" : "ies"}</span> : null}
                    <span class={`tri${shut ? "" : " open"}`} aria-hidden="true"><IconChevron /></span>
                </span>
            </button>
            {shut ? null : <>
                {mine.map((e, i) => <ConsoleRow key={i} e={e} />)}
                <ExprInput shape={shape} cls="rstate-console-add" inputCls="rstate-console-input" label="Run in the console" maxLength={MAX_CONSOLE_CHARS}
                    onSubmit={(code) => { back.current = 0; runConsole(run, code); }} recall={recall}
                    placeholder={mine.length ? "run" : "run read-only JS against this run: inspector.…, ml.current.…, statements, console.log"} />
                {mine.length ? <button class="rstate-console-clear" onClick={() => { consoleEntries.value = consoleEntries.value.filter((e) => e.run !== run); }}>clear</button> : null}
            </>}
        </section>
    );
}

/**
 * The RUN STATE view for one run. Read through the worker (DUMP_RUN_STATE) on mount and every
 * {@link RUN_STATE_POLL_MS} while open.
 *
 * @param run the open session's hash, which is also the run's id; null with nothing open
 */
export function RunStateView({ run }: { run: string | null }) {
    const [dump, setDump] = useState<RunStateDump | null>(null);
    const [error, setError] = useState<string | null>(null);
    const askNow = useRef<(() => void) | null>(null);

    useEffect(() => {
        let live = true;
        setDump(null);
        setError(null);
        // The watch list is read at each ask, not captured: adding one re-asks at once (below) without resetting the dump.
        const ask = () => chrome.runtime.sendMessage({ type: "DUMP_RUN_STATE", payload: { ...(run ? { run } : {}), watches: [...watches.value] } },
            (r: { data?: RunStateDump; error?: string } | undefined) => {
                if (!live) return;
                if (!r) setError(chrome.runtime.lastError?.message || "no answer from the service worker");
                else if (r.error) setError(r.error);
                else { setError(null); setDump(r.data ?? null); }
            });
        ask();
        askNow.current = ask;
        const t = setInterval(() => { if (document.visibilityState === "visible") ask(); }, RUN_STATE_POLL_MS);
        return () => { live = false; clearInterval(t); askNow.current = null; };
    }, [run]);
    // A watch added or removed is answered now, not at the next tick.
    const list = watches.value;
    const asked = useRef(list);
    useEffect(() => {
        if (asked.current === list) return;   // the mount's own read already carried this list
        asked.current = list;
        askNow.current?.();
    }, [list]);

    useEffect(() => {
        if (foldedRead) return;
        foldedRead = true;
        try {
            chrome.storage.local.get([FOLDED_KEY, WATCHES_KEY, SHARED_WATCHES_KEY, WATCH_NOTES_KEY, CONSOLE_HISTORY_KEY], (d: Record<string, unknown>) => {
                const v = d?.[FOLDED_KEY];
                if (Array.isArray(v)) folded.value = new Set(v.filter((x): x is string => typeof x === "string"));
                const w = d?.[WATCHES_KEY];
                if (Array.isArray(w)) watches.value = w.filter((x): x is string => typeof x === "string").slice(0, MAX_WATCHES);
                const sh = d?.[SHARED_WATCHES_KEY];
                if (Array.isArray(sh)) shared.value = sh.filter((x): x is string => typeof x === "string" && watches.value.includes(x)).slice(0, MAX_SHARED_WATCHES);
                notes.value = watchNotes(d?.[WATCH_NOTES_KEY]);
                const h = d?.[CONSOLE_HISTORY_KEY];
                if (Array.isArray(h)) consoleHistory.value = h.filter((x): x is string => typeof x === "string").slice(-MAX_CONSOLE_HISTORY);
            });
        } catch { /* no storage here: nothing is folded */ }
    }, []);

    const byId = new Map((dump?.entries ?? []).map((e) => [e.id, e]));
    // NOTHING LIVE: the session is open, but nothing this browser holds IN MEMORY is about its run. Records kept in
    // storage (its execution log) and its name do not count: they outlive the run by design. Said in a sentence, because
    // a column of "none" reads the same as a panel that cannot see the run at all.
    const inMemory = (e: StateEntry) => e.id !== "session.title" && e.lostOn.some((l) => l !== "browser-restart");
    const nothingLive = !!run && !!dump && !dump.pageError && !(dump.entries ?? []).some(inMemory);
    const groups = new Map<string, RunStateMember[]>();
    for (const m of dump?.members ?? []) {
        const g = m.id.slice(0, m.id.indexOf(".")) || m.id;
        groups.set(g, [...(groups.get(g) ?? []), m]);
    }

    return (
        <div class="rstate">
            <PanelHead>
                {dump ? <span class="rstate-asof" {...cursorTipOn(paneTip(`Read from the service worker, and from the page the run is on, every ${RUN_STATE_POLL_MS / 1000} s while this panel is open.`))}>
                    as of {new Date(dump.ts).toLocaleTimeString()}</span> : <span />}
            </PanelHead>
            {error ? <div class="hint err">could not read the run's state: {error}</div>
                : !run ? <div class="hint">Open a session to see what its run holds.</div>
                    : dump == null ? null
                        : [...(dump.pageError ? [<div class="hint" key="page-error">The page's own state (its answer, its <code>@pt</code>/<code>@box</code> tokens) is not shown: {dump.pageError}.</div>] : []),
                            ...(nothingLive ? [<div class="hint rstate-idle" key="idle">This browser holds nothing live for this session. Its run has
                                ended and the service worker has restarted since, or it was a chat rather than an agent run. What the session kept is
                                its transcript and its execution log.</div>] : []),
                            <WatchGroup key="watch" results={dump.watches} shape={dump.shape} />,
                            <ConsoleGroup key="console" run={run} shape={dump.shape} />,
                            ...[...groups].map(([g, ms]) => <Group key={g} g={g} ms={ms} byId={byId} />)]}
        </div>
    );
}
