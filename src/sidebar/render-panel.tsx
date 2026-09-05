// RenderDescriptor renderers — a serializable RenderDescriptor → a debug panel. The
// registry (RenderPanel) is keyed by `type`; a tool supplies one (page-side) or we
// auto-derive image/elements, else the default In:/Out: renders the raw result.
// Extracted from app.tsx; leans on the shared primitives in ./ui-kit.
import type { ComponentChildren } from "preact";
import { GLYPH, RESOLVED_LABEL, rungLabel, rungMeta } from "./fetch-ladder";
import { IconChevron } from "./icons";
import { scrollToStepSeq } from "./answer-render";
import { useState, useRef, useEffect, useMemo } from "preact/hooks";
import { signal } from "@preact/signals";
import type { RenderDescriptor, LocateSubstep, TableSource, CodeRevision } from "../contract";
import { codeDiff, diffStat } from "../diff";
import { elementReference } from "../dom";
import { pyFormat, lineChanged } from "../py-format";
import { lineMapBetween } from "../line-map";
import { rev, view, sessionMap, outMaxH, showOutTimes, focusMode, config, lsSet, BENCH_CODE_KEY, surface, codeLineNumbers, openBench } from "./store";
import { timeForOffset, alignedMarks, elideHour, hhmmss, hhmmssms, fmtDelta, fmtDur, hourNow, armHourTick, dayBreaks } from "./timestamps";
import { markdown, truncate, pretty, highlight } from "./format";
import { codeNotes, notesState, notesHidden, fetchLineNotes, toggleLineNotes } from "./summaries";
import { Prose } from "./prose";
import { notesByLine } from "./annotate";
import {
    openCtxMenu, copyText, ClickableImg, Code, SheetChip, inlineText, stepKey, displaySource, cursorTipOn, PointerChip, TipText,
    highlightToken, highlightEl, clearHighlight, tokenHover, pickedHover,
} from "./ui-kit";

/** A tool's returned DOM ELEMENTS, as a hoverable list. Each row carries the same stateless
 *  `clickSelector` the model was handed, so hovering outlines the node on the page and "copy reference"
 *  yields something that actually resolves. */
export function RenderElements({ items }: { items: { path: string; text?: string; index?: number }[] }) {
    const single = items.length === 1;   // one element → the #0 badge is noise; just show the element
    return (
        <div class="r-elements">
            {items.map((it, i) => {
                // Hover → outline it on the page (DevTools-style). A path that's an @pt/@box highlights
                // the point/region (via injected); a CSS selector highlights the element. Right-click a
                // selector row → a menu to copy a JS reference (nothing sensible for an @pt/@box).
                const isTok = /^@(?:pt|box):[0-9a-f]+$/.test(it.path);
                const menu = (e: MouseEvent) => openCtxMenu(e, [
                    { label: "Copy document.querySelector(…)", run: () => copyText(elementReference(it.path, it.index)) },
                    { label: "Copy selector", run: () => copyText(it.path) },
                ]);
                return (
                    <div class="r-el" key={it.index ?? i}
                        {...(isTok ? {} : cursorTipOn("Right-click to copy a document.querySelector(…) for this element."))}
                        onPointerEnter={() => (isTok ? highlightToken(it.path) : highlightEl(it.path))} onPointerLeave={clearHighlight}
                        onContextMenu={isTok ? undefined : menu}>
                        {single ? null : <span class="r-el-idx">#{it.index ?? i}</span>}
                        {it.text ? <span class="r-el-text">«{it.text}»</span> : null}
                        <code class="r-el-path">{it.path}</code>
                    </div>
                );
            })}
        </div>
    );
}
/** A plain TABLE from a `table` render descriptor — the simple one. A DataFrame gets `PyDfTable`
 *  instead, which is the spreadsheet-shaped view with sorting, resizing and an index gutter. */
export function RenderTable({ columns, rows }: { columns: string[]; rows: (string | number | null)[][] }) {
    return (
        <div class="r-table-wrap">
            <table class="r-table">
                <thead><tr>{columns.map((c, i) => <th key={i}>{c}</th>)}</tr></thead>
                <tbody>{rows.map((row, i) => <tr key={i}>{row.map((c, j) => <td key={j} class={typeof c === "number" ? "r-td-num" : undefined}>{c == null ? "" : String(c)}</td>)}</tr>)}</tbody>
            </table>
        </div>
    );
}
// The `locate` debug view: model + mode header, then (grounding) the VLM prompt, the
// square the model saw with its box, and the element-location pass; (marks) just the
// badged shot. Picked element at the bottom.
// One substep of a locate run: a vision sub-call (its own In-prompt / image / Out-reply,
// with a raw⇄visualise image toggle) or a DOM snap (just a labelled image). The [N] badge
// numbers it; hovering explains what kind of step it is.
function LocateSubstepView({ s, n }: { s: LocateSubstep; n: number }) {
    const [raw, setRaw] = useState(false);   // "visualise" (the human overlay) by default
    const kind = s.prompt ? "a vision sub-call — its own prompt + reply, run standalone" : "a DOM hit-test — no model call";
    return (
        <div class="r-loc-sub">
            {s.note ? <div class="r-loc-note">{s.note}</div> : null}
            <div class="r-loc-subhead">
                <span class="tt r-loc-numtt"><span class="r-loc-num">{n}</span><span class="tt-pop left" role="tooltip">Sub-step {n}: {kind}.</span></span> {s.label}
            </div>
            {s.prompt ? <details class="io r-loc-io"><summary class="io-label">In (prompt): <span class="io-preview">{inlineText(s.prompt)}</span></summary><div class="io-body"><Code text={s.prompt} lang="text" /></div></details> : null}
            {s.image ? <div class="r-loc-stage">
                <ClickableImg src={raw && s.rawImage ? s.rawImage : s.image} alt={s.label} />
                {s.rawImage ? <div class="rr-toggle r-loc-viz">
                    <button class={raw ? "" : "on"} onClick={() => setRaw(false)}>visualise</button>
                    <button class={raw ? "on" : ""} onClick={() => setRaw(true)}>raw</button>
                </div> : null}
            </div> : null}
            {s.output != null && s.output !== "" ? <details class="io r-loc-io"><summary class="io-label">Out: <span class="io-preview">{inlineText(s.output)}</span></summary><div class="io-body"><Code text={s.output} lang="text" /></div></details> : null}
        </div>
    );
}

function LocateRender({ d }: { d: Extract<RenderDescriptor, { type: "locate" }> }) {
    // Is this vision sub-call's model the SAME as the agent driver's? If so, flag that
    // it still ran standalone (its image + reply never entered the driver's context) —
    // otherwise the matching name reads as if the driver itself saw and answered.
    rev.value;   // reactive: re-read when sessions change
    const driverModel = view.value.name === "detail" ? sessionMap.get(view.value.hash)?.model : undefined;
    const sameAsDriver = !!driverModel && d.model === driverModel;
    return (
        <div class="r-locate">
            <div class="r-loc-head">
                {d.mode === "grounding" ? "Grounding" : d.mode === "grid-grounding" ? "Grid → Grounding" : d.mode === "grid" ? "Grid" : "Set-of-Marks"} · <b>{d.model}</b>
                {sameAsDriver ? <span class="tt r-loc-delegated"> (standalone sub-call · not in the agent's context)<span class="tt-pop left" role="tooltip">This vision sub-call ran on its own — its image and reply were NOT added to the agent driver's conversation, even though it's the same model.</span></span> : null}
            </div>
            {d.substeps.map((s, i) => <LocateSubstepView key={i} s={s} n={i + 1} />)}
            <div class="r-loc-picked">
                <span class="tt">{d.pickedBy === "model" ? "Model picked" : "Snapped to"}<span class="tt-pop left" role="tooltip">{d.pickedBy === "model" ? "The model chose this by badge number (Set-of-Marks)." : d.pickedBy === "snap" ? "The model localized a region; the DOM hit-test chose this actual element." : "No element was selected."}</span></span>: {d.picked ? <code class="r-hoverable" {...pickedHover(d.picked)}>{d.picked}</code> : <span class="dim">(none)</span>}
            </div>
        </div>
    );
}

// `python_exec`'s In slot: a notebook-cell header — the run mode (hover explains what
// `script`/`cast:pt`/`cast:box` mean), the input screenshot the script saw, and the source.
const PY_MODE = {
    script: { label: "script", tip: "General scripting — the return comes back as text." },
    pt: { label: "cast: pt", tip: "The return is validated as a point ([x,y]/{x,y}) and minted as a clickable @pt." },
    box: { label: "cast: box", tip: "The return is validated as a box and minted as an @box region." },
} as const;
// A Jupyter/DataFrame-style preview of the injected `df`: a numbered index gutter, sticky
// header, zebra rows + vertical rules, right-aligned monospace numbers — plus click-to-sort
// (cycles asc→desc→none, preserving the pandas index), drag-to-resize columns, collapse, and
// copy-CSV. Zero-dep (no grid library — it's a capped debug preview). Human-only, so it shows
// up to PY_DF_ROWS rows, not the model's cap.
const PY_DF_ROWS = 200;
/** One DataFrame cell as text. A pandas column can legitimately hold a dict or a list — `dict(per_q)` in a
 *  cell is an ordinary thing to write — and `String()` renders those as `[object Object]`, which is a wrong
 *  answer printed in the place the reader is looking for the right one. Serialised as JSON instead, which is
 *  what the value IS by the time it reaches here (the sandbox returns through `json.dumps`).
 *
 *  Exported and pure so it is testable: this shipped for as long as it did because nothing asserted on the
 *  text of a non-scalar cell. */
/** The producer's marker for a cell it could not represent — set in python-runtime.ts, where the real type
 *  is still known. Without it an arbitrary object arrives from pandas as `{}`, which is a PLAUSIBLE value
 *  and so reads as the truth. */
const UNRENDERABLE = "__ml_unrenderable__";
const markedType = (v: unknown): string | null => {
    const rec = v as Record<string, unknown> | null;
    return rec && typeof rec === "object" && typeof rec[UNRENDERABLE] === "string" ? (rec[UNRENDERABLE] as string) : null;
};

/** ONE DATAFRAME CELL as text — or NULL when it has no honest representation, which the table draws as a
 *  marker naming the type. `[object Object]` and a bare `{}` are both a wrong fact printed exactly where
 *  the reader is looking for the right one. The CSV copy goes through this too, so what you paste cannot
 *  disagree with what you saw. */
export const dfCell = (v: unknown): string | null => {
    if (v == null) return "NaN";
    if (typeof v === "object") {
        if (markedType(v)) return null;                              // named by the producer, not guessed
        // `null` means "no text for this" — NOT the string "null", which would be a value that isn't there.
        // The caller renders a marker; the CSV writes an empty field, since a CSV has no way to say this.
        let j: string | undefined;
        try { j = JSON.stringify(v); } catch { return null; }        // circular
        if (j === undefined) return null;                             // a function, a symbol
        // AN EMPTY OBJECT FOR SOMETHING THAT IS NOT ONE. `Map`, `Set` and `Error` all stringify to `{}` —
        // and unlike a function they survive a structured clone, so they genuinely arrive here. Printing
        // `{}` for a Map of five entries is the same wrong-fact-in-the-right-place as `[object Object]`,
        // just quieter. A plain `{}` or `[]` is left alone: there it is the truth.
        const empty = j === "{}" || j === "[]";
        // REALM-SAFE. `v.constructor === Object` is false for a plain object that came from another realm —
        // an iframe, a jsdom window — which is precisely where this runs, so it would mark every ordinary
        // `{}` as unrenderable. The brand check has no such problem.
        const brand = Object.prototype.toString.call(v);
        const plain = brand === "[object Object]" || brand === "[object Array]";
        if (empty && !plain) return null;
        return j;
    }
    return String(v);
};

/** What went wrong with a cell we could not render, and what it WAS — a type is most of the answer when the
 *  question is "why is my column empty". Kept next to `dfCell` so the two cannot disagree about which values
 *  are unrenderable. */
export const dfCellType = (v: unknown): string => {
    const marked = markedType(v);
    if (marked) return marked;      // the Python type name, carried across from the sandbox
    if (Array.isArray(v)) return "list";
    if (v instanceof Date) return "datetime";
    const ctor = (v as { constructor?: { name?: string } })?.constructor?.name;
    return ctor && ctor !== "Object" ? ctor : typeof v;
};
const csvField = (v: unknown): string => {
    // The same coercion as the table, or the copied CSV disagrees with what is on screen.
    const s = v == null ? "" : (dfCell(v) ?? "");
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
/** A pandas DataFrame, drawn as JUPYTER draws one: numbered index gutter, sticky header, zebra rows,
 *  right-aligned monospace numbers, NaN styling — plus click-to-sort, drag-to-resize, collapse and
 *  copy-CSV. Zero-dep, no grid library. A cell with no JSON form renders as a marker naming its type
 *  rather than as `[object Object]`. */
export function PyDfTable({ columns, rows }: { columns: string[]; rows: (string | number | null)[][] }) {
    const cols = columns.length ? columns : (rows[0] || []).map((_, i) => String(i));
    const [collapsed, setCollapsed] = useState(false);
    const [sort, setSort] = useState<{ c: number; dir: 1 | -1 } | null>(null);
    const [widths, setWidths] = useState<Record<number, number>>({});
    const [copied, setCopied] = useState(false);

    // Sort a [originalIndex, row] view so the gutter keeps the pandas index (like sort_values);
    // numbers compare numerically, strings by locale, nulls (NaN) always sink to the bottom.
    let view = rows.map((r, i) => [i, r] as [number, (string | number | null)[]]);
    if (sort) view = [...view].sort(([, a], [, b]) => {
        const x = a[sort.c], y = b[sort.c];
        if (x == null) return y == null ? 0 : 1;
        if (y == null) return -1;
        return (typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y))) * sort.dir;
    });
    const shown = view.slice(0, PY_DF_ROWS);

    const cycleSort = (c: number) => setSort(s => !s || s.c !== c ? { c, dir: 1 } : s.dir === 1 ? { c, dir: -1 } : null);
    const copyCsv = () => {
        const csv = [cols.map(csvField).join(","), ...rows.map(r => cols.map((_, j) => csvField(r[j])).join(","))].join("\n");
        navigator.clipboard?.writeText(csv).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1200); }, () => {});
    };
    const startResize = (c: number, e: any) => {
        e.preventDefault(); e.stopPropagation();
        const th = (e.currentTarget as HTMLElement).parentElement as HTMLElement;
        const startX = e.clientX, startW = widths[c] ?? th.offsetWidth;
        const onMove = (ev: PointerEvent) => setWidths(w => ({ ...w, [c]: Math.max(40, startW + ev.clientX - startX) }));
        const onUp = () => { window.removeEventListener("pointermove", onMove); window.removeEventListener("pointerup", onUp); };
        window.addEventListener("pointermove", onMove); window.addEventListener("pointerup", onUp);
    };

    return (
        <div class="r-df">
            <div class="r-df-bar">
                <button class="r-df-btn" onClick={() => setCollapsed(v => !v)}>{collapsed ? "▸ show table" : "▾ hide table"}</button>
                {!collapsed ? <button class="r-df-btn" onClick={copyCsv}>{copied ? "copied ✓" : "copy CSV"}</button> : null}
            </div>
            {collapsed ? null : <>
                <div class="r-df-scroll">
                    <table class="r-df-table">
                        <thead><tr>
                            <th class="r-df-idx"></th>
                            {cols.map((c, j) => (
                                <th key={j} style={widths[j] ? { width: `${widths[j]}px` } : undefined} onClick={() => cycleSort(j)} {...cursorTipOn("Click to sort by this column.")}>
                                    {c}{sort && sort.c === j ? <span class="r-df-sort">{sort.dir === 1 ? " ▲" : " ▼"}</span> : null}
                                    <span class="r-df-resize" aria-label="Drag to resize this column" {...cursorTipOn("Drag to resize this column.")} onPointerDown={(e: any) => startResize(j, e)} onClick={(e: any) => e.stopPropagation()} />
                                </th>
                            ))}
                        </tr></thead>
                        <tbody>{shown.map(([origIdx, row], i) => (
                            <tr key={i}>
                                <td class="r-df-idx">{origIdx}</td>
                                {cols.map((_, j) => {
                                    const c = row[j];
                                    const text = dfCell(c);
                                    // A value with NO text is not an empty cell and must not look like one:
                                    // `[object Object]` was the old answer and it is a wrong fact printed
                                    // exactly where the reader is looking for the right one. The same marker
                                    // an unresolvable pointer uses, because it is the same situation — we
                                    // know something is there and cannot show it — and it says what it was.
                                    return <td key={j} class={typeof c === "number" ? "r-td-num" : (c == null ? "r-td-nan" : undefined)}>
                                        {/* Two different situations, and the tooltip says which: a value the
                                            SANDBOX marked (it has no JSON form at all, and pandas would have
                                            flattened it to an empty object) versus one that arrived here and
                                            could not be serialised (circular, a Map, a Set). Naming the wrong
                                            cause sends the reader looking in the wrong half of the system. */}
                                        {text ?? <span class="tok-unresolved r-td-unrend"
                                            {...cursorTipOn(markedType(c)
                                                ? `This cell holds a ${dfCellType(c)}, which has no JSON form — without this marker it would show as an empty object, which is a value it is not. The run itself is unaffected; only this preview cannot show it.`
                                                : `This cell holds a ${dfCellType(c)} that could not be serialised for display (circular, or not JSON-representable). The model received the value itself; only this preview cannot show it.`)}>unrenderable {dfCellType(c)}</span>}
                                    </td>;
                                })}
                            </tr>
                        ))}</tbody>
                    </table>
                </div>
                {rows.length > PY_DF_ROWS ? <div class="dim r-py-more">… {rows.length - PY_DF_ROWS} more rows</div> : null}
            </>}
        </div>
    );
}
// A loaded DataFrame's provenance → a short source label + a hover tooltip clarifying where the
// data came from (so a multi-table run reads clearly, and the human knows what was fetched).
function tableSourceDesc(s: TableSource): { short: string; tip: string } {
    switch (s.kind) {
        case "sheet-external": return { short: `sheet ${s.label}`, tip: "This data was fetched from an EXTERNAL Google Sheet with your approval." };
        case "sheet-current": return { short: s.label, tip: "This data was fetched from the Google Sheet you're currently on." };
        default: return { short: s.label, tip: `This data was extracted from a table on the current page (${s.label}).` };
    }
}
/** One input dataframe, as a section that focus mode can fold once the step has settled. Its own component
 *  because the fold has to seed a `details`' state (see `useFocusFold`) and hooks cannot live inside a map. */
function PyInTable({ fold, label, children }: { fold: boolean; label: ComponentChildren; children: ComponentChildren }) {
    const [open, setOpen] = useFocusFold(fold);
    return (
        <details class={`r-py-table r-py-sec${fold ? " focus-fold" : ""}`} open={open}
            onToggle={(e: any) => setOpen(!!e.currentTarget.open)}>
            <summary class="r-py-lbl">{label}</summary>
            {children}
        </details>
    );
}

/** Which step a code block belongs to, and what it produced — everything the block needs to ask the
 *  utility model about ITSELF. Threaded down from the step because a RenderDescriptor is serializable
 *  data and knows nothing about the run it came from. Absent (the export, a preview) → no tools. */
export interface CodeCtx { hash: string; seq: number; result?: string; }

/** The affordances on a rendered code block: annotate it, show/hide those annotations, and get the source
 *  somewhere you can run it. Deliberately quiet — half-opacity until the block is hovered, because a
 *  toolbar competing with the code for attention is the opposite of what a code block is for. */
function CodeTools({ ctx, lang, src }: { ctx: CodeCtx; lang: string; src: string }) {
    const rv = rev.value;   // subscribe: notes land on a rev bump (the step is signal-memoized → won't)
    const [flash, setFlash] = useState("");
    const key = stepKey(ctx.hash, ctx.seq);
    const notes = codeNotes.get(key);
    const state = notesState.get(key);
    const hasUtility = !!config.value.utilityModel.trim();
    const say = (msg: string) => { setFlash(msg); setTimeout(() => setFlash(""), 1600); };
    // The HUD card is a READING surface — an answer and the steps behind it, over the page. The bench is a
    // debug tool on the panel's own navigation, which the card does not have: sending someone there from a
    // corner card would either do nothing or replace what they were reading. Explain stays, because
    // understanding the code IS what that card is for.
    const python = lang === "python" && surface.value !== "card";
    return (
        <div class="code-tools" data-rev={rv}>
            {flash ? <span class="code-tools-flash">{flash}</span> : null}
            {/* One button, two roles. Before there are notes it ASKS; once they exist there is nothing
                left to ask, so it becomes the show/hide the notes need. */}
            {notes
                ? <button class={`tt code-tool${notesHidden.has(key) ? "" : " on"}`} onClick={() => toggleLineNotes(key)}>
                    <span>💡 notes</span>
                    <span class="tt-pop wrap left" role="tooltip">{notesHidden.has(key) ? "Show" : "Hide"} the line notes. They are model-generated, so treat them as a gloss rather than an authority.</span>
                </button>
                : <button class="tt code-tool" disabled={!hasUtility || state === "loading"}
                    onClick={() => fetchLineNotes(key, lang, src, ctx.result)}>
                    <span>💡 {state === "loading" ? "reading…" : state === "error" ? "retry" : "explain"}</span>
                    <span class="tt-pop wrap left" role="tooltip">{!hasUtility
                        ? "Set a utility model in Settings to annotate code."
                        : state === "error"
                            ? "The utility model returned nothing usable. Ask again?"
                            : "Annotate the interesting lines with the utility model, given this code and what it printed. Model-generated and approximate — a good-enough gloss, not a precise explanation."}</span>
                </button>}
            {python
                /* The REFLOWED source, deliberately: it is the code that ran (py-format never changes a
                   token) and it is what you are looking at, so what lands in the bench is what you pressed
                   the button next to. `openBench` is shared with the toolbar button and honours the dock —
                   this used to go straight to the full page, which is exactly the trip the drawer exists to
                   stop, since you press this FROM a step in order to compare against that step. */
                ? <button class="tt code-tool" onClick={() => openBench(src)}>
                    <span>▶ bench</span>
                    <span class="tt-pop wrap left" role="tooltip">Open this script in the Python bench, where you can edit it and run it against the same sandbox. Replaces whatever is in the bench now.</span>
                </button>
                : <button class="tt code-tool" onClick={() => { void copyText(src); say("copied"); }}>
                    <span>copy</span>
                    <span class="tt-pop wrap left" role="tooltip">Copy the source exactly as shown here — reflowed for reading, with the same tokens that ran.</span>
                </button>}
        </div>
    );
}

/** The notes to draw on a block, or undefined when there are none / they are hidden. Reads `rev` so a
 *  landed annotation repaints. */
function notesForBlock(ctx: CodeCtx | undefined, rv: number): Map<number, string> | undefined {
    void rv;
    if (!ctx) return undefined;
    const key = stepKey(ctx.hash, ctx.seq);
    const notes = codeNotes.get(key);
    return notes && !notesHidden.has(key) ? notesByLine(notes) : undefined;
}

/** WHAT CHANGED SINCE THE CALL THIS REVISES. The commonest loop in a run is: a code tool fails, the model
 *  retries with a tweak, and the reader diffs two twenty-line blocks by eye to find the one line that moved.
 *
 *  Both sides are REFLOWED before comparing (the same `displaySource`/`pyFormat` the block itself draws
 *  through), or pure spacing differences drown the real change — a model writes dense on purpose, and two
 *  calls it wrote a minute apart are not spaced the same way.
 *
 *  The header says WHAT it is diffing against and takes you there, because a diff whose other side you
 *  cannot see is half an answer. The model's own account of the change sits BESIDE the diff, marked as its
 *  claim: it answers from what it MEANT to change, and the two disagree exactly when this is worth reading. */
function CodeDiff({ revision, after, lang, hash, failed }: { revision: CodeRevision; after: string; lang: string; hash?: string; failed?: boolean }) {
    // OPEN ONLY WHEN THE STEP FAILED. That is when "what did I change" is the question you are actually
    // asking — a retry that WORKED is a step whose output you want, and pinning a diff open above it pushes
    // that output out of the viewport to answer a question nobody asked. Collapsed it is one line, and the
    // line still says what it revises and by how much, so nothing is hidden.
    //
    // Focus mode folds it either way: it reads the run as a conversation, and this is a debugger's question
    // even on a failure. Seeded like every other focus fold (see useFocusFold) rather than bound to the
    // signal, so a diff you opened stays open through the next poll.
    // THE NUMBERS ONLY WHEN THEY LINE UP WITH SOMETHING. They earn their width because the new-side column
    // is the same numbering the code block below draws — so a diff row, a margin note and the failure mark
    // all name the same line and you can read straight down between them. With the block's own gutter off
    // they line up with nothing, and are just width taken in a narrow panel. A failure turns that gutter on
    // by itself (see `Code`), so the two can never disagree.
    const nums = codeLineNumbers.value || !!failed;
    const focus = focusMode.value;
    const [open, setOpen] = useState(!!failed && !focus);
    const seeded = useRef(focus);
    if (seeded.current !== focus) { seeded.current = focus; setOpen(!!failed && !focus); }
    const before = lang === "python" ? pyFormat(revision.before).text : displaySource(revision.before, lang, true);
    const rows = useMemo(() => codeDiff(before, after), [before, after]);
    // Nothing to show is not the same as nothing to say: a retry whose source is IDENTICAL is a fact worth
    // stating, since the model believes it changed something.
    const stat = rows ? diffStat(rows) : { added: 0, removed: 0 };
    return (
        <div class={`r-diff${open ? "" : " closed"}`}>
            <div class="r-diff-head">
                <button class={`r-diff-tri${open ? " open" : ""}`} onClick={() => setOpen(!open)} aria-expanded={open}>
                    <IconChevron />
                </button>
                <span class="r-diff-lbl">revises</span>
                {/* The pill IS the pointer, and it navigates — the same gesture a citation makes. The SHELL
                    is the shared PointerChip, so a reference reads the same here as it does under a step:
                    it was a CSS copy of that chip for a while, which is exactly how two surfaces start
                    drawing the same thing differently.
                    The LABEL is the model's own name for the output when it gave one, prefixed by the tool
                    so `the q1+q2 totals` is not mistaken for a step title — and the raw pointer when it did
                    not, because an id you can copy beats a name we invented. */}
                <PointerChip cls="r-diff-ref"
                    label={revision.label ? `${revision.tool}: ${revision.label}` : revision.ref}
                    onClick={() => scrollToStepSeq(revision.seq, hash, "in")}
                    tip={<>Go to the {revision.tool} call this revises{revision.label ? <> — the model called it "{revision.label}"</> : null}.</>} />
                {rows
                    ? <span class="r-diff-stat"><b class="r-diff-add">+{stat.added}</b> <b class="r-diff-del">−{stat.removed}</b></span>
                    : <span class="r-diff-same">no change — the source is identical</span>}
            </div>
            {/* The model's CLAIM, always marked as one. It is never a substitute for the rows below it, and it
                lives INSIDE the fold — collapsed, this has to be one line. */}
            {open && revision.claim
                ? <div class="r-diff-claim"{...cursorTipOn("The model's own account of what it changed. The diff below is computed from the two sources; this is not.")}>
                    <span class="r-diff-claim-tag">the model says:</span> <Prose md={revision.claim} steps={sessionMap.get(hash || "")?.steps} hash={hash} /></div>
                : null}
            {open && rows
                /* BOTH line numbers, old then new — the standard two-column gutter, and the reason it earns
                   its width here is that the NEW column is the same numbering the code block below this one
                   draws. So a diff row, a margin note and a failure mark all name the same line, and you can
                   read straight down between them instead of counting. A row that exists on only one side
                   leaves the other column blank, which is exactly the claim being made. */
                ? <pre class={`code r-diff-body${nums ? " numbered" : ""}`}><code class="hljs">{rows.map((r, i) => r.kind === "gap"
                    ? <span class="dline dline-gap" key={i}>{nums ? <><span class="dno" /><span class="dno" /></> : null}<span class="dsign" />
                        <span class="dtext">{`⋮ ${r.skipped} unchanged line${r.skipped === 1 ? "" : "s"}`}</span>{"\n"}</span>
                    : <span class={`dline dline-${r.kind}`} key={i}>
                        {nums ? <>
                            <span class="dno">{r.kind === "add" ? "" : r.a}</span>
                            <span class="dno">{r.kind === "del" ? "" : r.b}</span>
                        </> : null}
                        <span class="dsign">{r.kind === "add" ? "+" : r.kind === "del" ? "−" : " "}</span>
                        <span class="dtext" dangerouslySetInnerHTML={{ __html: highlight(r.text, lang) || "&nbsp;" }} />
                        {"\n"}
                    </span>)}</code></pre>
                : null}
        </div>
    );
}

function PythonInRender({ d, live, failLine, ctx, failed }: { d: Extract<RenderDescriptor, { type: "python-in" }>; live?: boolean; failLine?: number | null; ctx?: CodeCtx; failed?: boolean }) {
    const rv = rev.value;   // subscribe: a landed annotation repaints the block (retained via data-rev below)
    const fmt = useMemo(() => pyFormat(d.code), [d.code]);
    // WHERE IT BROKE, marked on the code rather than only in the traceback — the traceback tells you a
    // number, and the number is only useful once you have found the line it names. Mapped through the
    // formatter, so it survives the reflow.
    const failAt = failLine != null ? (fmt.map[failLine] ?? failLine) : null;
    const failNote = failLine != null && lineChanged(d.code, fmt, failLine)
        ? `This line failed. It is shown reflowed for reading — in the code as written it was one longer line.`
        : "This line failed.";
    return (
        <div class="r-python r-py-in">
            <div class="r-py-mode">Mode: <span class="tt"><span class="r-py-modeval">{PY_MODE[d.mode].label}</span><span class="tt-pop left" role="tooltip">{PY_MODE[d.mode].tip}</span></span></div>
            {d.image ? <div class="r-image r-py-img"
                {...(d.imageToken ? { onPointerEnter: () => highlightToken(d.imageToken!), onPointerLeave: clearHighlight } : {})}>
                <ClickableImg src={d.image} alt="input image" /><div class="r-image-label">input image (img / img_np){d.imageToken ? " — hover to locate on page" : ""}</div></div> : null}
            {(d.tables || []).map((t, i) => {
                const src = tableSourceDesc(t.source);
                const cols = t.columns?.length || t.rows?.[0]?.length || 0;
                // A SECTION, like the Out block's, so focus mode can fold the input data once the step has
                // settled — what a reader wants from a python step is the code and the answer, and the
                // dataframe that went in is the debugger's half. Open everywhere else, so nothing is hidden
                // from the view whose job is debugging.
                return <PyInTable key={i} fold={!live} label={<>
                        input table → <b class="r-py-var">{t.name}</b>{t.rows ? ` (${t.rows.length} × ${cols})` : ""}
                        {" · "}
                        {t.source.kind === "sheet-external"
                            ? <SheetChip id={t.source.label} label={t.source.name || undefined} />   /* id → a friendly chip; name = the real sheet title */
                            : <span class="tt r-py-src"><span class="r-py-srcval">{src.short}</span><span class="tt-pop left" role="tooltip">{src.tip}</span></span>}
                </>}>
                    {t.rows ? <PyDfTable columns={t.columns || []} rows={t.rows} />
                        : <div class="dim r-py-more">loaded via pd.read_html (no clean row preview)</div>}
                </PyInTable>;
            })}
            {/* The CITED cell for `:in`. A python step renders its inputs (image, dataframes) above the
                source, and a citation that scrolled to the top of the step landed the reader on a table when
                what they clicked was the code. The renderer declares it because only the renderer knows
                which of its sections is the answer. */}
            {/* REFLOWED for reading (see py-format.ts) — tokens untouched, so this is the code that ran. The
                line MAP is published on the element rather than passed between descriptors: the In and the
                Out are two independent RenderDescriptors rendered in two separate blocks, and threading one
                through the other would couple them for the sake of one number. */}
            {d.revision ? <CodeDiff revision={d.revision} after={fmt.text} lang="python" hash={ctx?.hash} failed={failed} /> : null}
            <div class="code-block" data-cite="in" data-rev={rv} data-py-map={fmt.changed ? JSON.stringify(fmt.map) : undefined}>
                {ctx ? <CodeTools ctx={ctx} lang="python" src={fmt.text} /> : null}
                <Code text={fmt.text} lang="python" lineIds="pyline" markLine={failAt} markTitle={failNote} notes={notesForBlock(ctx, rv)} />
            </div>
        </div>
    );
}
// How close to the bottom still counts as "parked there" (px) — tail-follow keeps working through a pixel
// of rounding / a fractional device-pixel scroll instead of silently detaching.
const FOLLOW_SLACK = 24;
/** Is this scroller parked at (or within a hair of) the bottom? Pure arithmetic, so it unit-tests directly. */
export const atBottomOf = (el: { scrollHeight: number; scrollTop: number; clientHeight: number }): boolean =>
    el.scrollHeight - el.scrollTop - el.clientHeight <= FOLLOW_SLACK;

/** Captured output, with the tail the MODEL NEVER RECEIVED marked. A tool clips its model-facing result to a
 *  context budget, but the UI keeps far more (UI_OUT_CAP) — so without this you'd read the surplus as "what the
 *  model saw". Everything past `seen` chars renders dimmed under an explicit label. Shared by python_exec and
 *  exec (and any future tool that reports a `seen` boundary). No boundary → plain output, unchanged. */
// The per-line timestamp helpers live in ./timestamps (pure — the exports read the same mapping). Re-exported
// here because this module is where they were first published and the standalone tests import them from it.
export { timeForOffset, alignedMarks, elideHour, fmtDelta } from "./timestamps";

/** Streamed output with a TIMESTAMP GUTTER — when each line was produced, per the executor's marks. The time
 *  is repeated only when it CHANGES, so a burst of lines reads as one moment rather than a wall of identical
 *  clocks. The gutter is its own element with `user-select: none`, so it is never part of the text you copy
 *  (and it was never part of what the model read). Falls back to a plain block when there are no marks or the
 *  gutter is switched off in Settings. */
export function TimedOutput({ text, marks }: { text: string; marks?: [number, number][] }) {
    if (!showOutTimes.value || !marks || !marks.length) return <Code text={text} lang="text" />;
    const lines = text.split("\n");
    // `hourNow` is a SIGNAL, not Date.now(): a single timer bumps it at each hour boundary, so every gutter on
    // screen widens from mm:ss to hh:mm:ss the moment eliding stops being true — a long session left open
    // across the hour would otherwise keep claiming the current hour. armHourTick is idempotent and re-arms
    // only from a render, so the timer stops itself once no timestamped output is mounted.
    armHourTick();
    const short = elideHour(marks, hourNow.value);   // current hour throughout → show mm:ss, not hh:mm:ss
    // The gutter is time-only, so a run crossing midnight would put 00:00:01 directly under 23:59:58 with
    // nothing marking the day. A divider row goes in at each change (and resets the repeat elision, so the
    // first stamp of the new day always prints).
    const breaks = dayBreaks(text, marks);
    let off = 0, shown = "", prevTs: number | null = null;
    const rows: preact.ComponentChild[] = [];
    lines.forEach((line, i) => {
        const day = breaks.get(i);
        if (day) { shown = ""; rows.push(<div class="r-ts-day" key={`d${i}`}><span class="r-ts-day-lbl">{day}</span></div>); }
        const ts = timeForOffset(marks, off);
        off += line.length + 1;
        const label = ts == null ? "" : (short ? hhmmss(ts).slice(3) : hhmmss(ts));
        const repeat = !!label && label === shown;
        if (label) shown = label;
        // Hover shows the exact instant (to the millisecond) and the gap since the previous timestamped line —
        // which is what you actually want when reading a loop's output ("where did the 4 seconds go?").
        const tip = ts == null ? undefined
            : `${hhmmssms(ts)}${prevTs != null && ts !== prevTs ? ` · +${fmtDelta(ts - prevTs)} since the previous line` : ""}`;
        if (ts != null) prevTs = ts;
        rows.push(
            <div class="r-ts-row" key={i}>
                <span class={`r-ts${tip ? " hoverable" : ""}`} {...(tip ? cursorTipOn(tip) : {})}>{repeat ? "" : label}</span>
                <span class="r-ts-line">{line}</span>
            </div>,
        );
    });
    return <div class={`code r-timed${short ? " short" : ""}`}>{rows}</div>;
}

/** Captured output with the tail the MODEL NEVER RECEIVED marked. A tool clips its model-facing result
 *  to a context budget while the UI keeps far more, so without this you would read the surplus as "what
 *  the model saw". Everything past `seen` renders dimmed under an explicit label. */
export function SeenSplit({ text, seen, live, marks }: { text: string; seen?: number; live?: boolean; marks?: [number, number][] }) {
    if (seen == null || seen >= text.length) return <TimedOutput text={text} marks={marks} />;
    return (
        <>
            <TimedOutput text={text.slice(0, seen)} marks={marks} />
            {/* While the tool is still RUNNING we already know where the model's cut will fall, so mark it as it
                streams rather than springing it on you at the end — greyed, with a "?" that explains why. */}
            <div class={`r-unseen-lbl${live ? " live" : ""}`}
                {...cursorTipOn(live
                    ? "Past this point the output is beyond the model's per-call output cap — it is still being captured for you, but it will NOT be part of the result sent to the model."
                    : "The tool captured this, but it was clipped out of the result sent to the model (its output cap). The model never read it.")}>
                {live ? "beyond the model's cutoff " : "↓ captured, but NOT sent to the model"}{live ? <span class="r-unseen-q">?</span> : null}
            </div>
            <div class="r-unseen"><TimedOutput text={text.slice(seen)} marks={marks?.map(([o, t]) => [o - seen, t] as [number, number])} /></div>
        </>
    );
}

/** Substring scan over the cell's text — deliberately NOT a regex: this exists to eyeball a script's output,
 *  and a regex box buys escaping bugs and pathological patterns for no gain. Returns [start, end) offsets.
 *  Pure, so the matching rules (case folding, overlap, empty query) unit-test without a DOM. */
export function findMatches(text: string, query: string, caseSensitive: boolean): [number, number][] {
    if (!query) return [];
    const hay = caseSensitive ? text : text.toLowerCase();
    const needle = caseSensitive ? query : query.toLowerCase();
    const out: [number, number][] = [];
    for (let i = hay.indexOf(needle); i !== -1; i = hay.indexOf(needle, i + needle.length)) out.push([i, i + needle.length]);
    return out;
}

// Which OutputCell currently owns the find UI. The CSS Custom Highlight registry is GLOBAL (one
// `::highlight(ml-find)` rule), so exactly one cell may search at a time — opening find in another closes this.
const findOwner = signal(0);
let nextCellId = 1;

/** Map match offsets over a container's concatenated text back onto real DOM Ranges, so matches can be painted
 *  with the CSS Custom Highlight API — no DOM surgery, so the syntax highlighting underneath is untouched. */
function rangesFor(root: HTMLElement, query: string, caseSensitive: boolean): Range[] {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const nodes: Text[] = [];
    let text = "";
    for (let n = walker.nextNode(); n; n = walker.nextNode()) { nodes.push(n as Text); text += (n as Text).data; }
    const ranges: Range[] = [];
    // Walk the node list once per match, tracking each node's start offset in the flattened text.
    const at = (off: number): { node: Text; offset: number } | null => {
        let base = 0;
        for (const n of nodes) {
            if (off <= base + n.data.length) return { node: n, offset: off - base };
            base += n.data.length;
        }
        return null;
    };
    for (const [s, e] of findMatches(text, query, caseSensitive)) {
        const a = at(s), b = at(e);
        if (!a || !b) continue;
        const r = document.createRange();
        try { r.setStart(a.node, a.offset); r.setEnd(b.node, b.offset); ranges.push(r); } catch { /* node went away mid-stream */ }
    }
    return ranges;
}

// Paint the matches (all + the current one) via the global highlight registry. A no-op where the API is
// missing (jsdom / older engines) — find still counts and scrolls, it just doesn't tint.
function paintFind(all: Range[], current: Range | null): void {
    const reg = (globalThis as any).CSS?.highlights;
    if (!reg) return;
    try {
        if (all.length) reg.set("ml-find", new (globalThis as any).Highlight(...all)); else reg.delete("ml-find");
        if (current) reg.set("ml-find-cur", new (globalThis as any).Highlight(current)); else reg.delete("ml-find-cur");
    } catch { /* registry unavailable → skip painting */ }
}
function clearFindPaint(): void {
    const reg = (globalThis as any).CSS?.highlights;
    try { reg?.delete("ml-find"); reg?.delete("ml-find-cur"); } catch { /* ignore */ }
}

/** The shared OUTPUT CELL every code-ish tool's Out renders into — python_exec and exec today, and any future
 *  tool (a `bash_exec`, say) for free: wrap your sections in it and you inherit the whole behaviour. Jupyter's
 *  output-area semantics:
 *   · capped height (Settings → Appearance) so a chatty run can't bury the transcript, then it SCROLLS;
 *   · drag the grip to resize THIS cell (bigger or smaller) without changing the global default;
 *   · TAIL-FOLLOW — while you're parked at the bottom, new streamed output scrolls into view; scroll up and
 *     it holds still so you can read, and resumes following the moment you return to the bottom.
 *  Deliberately children-based (not a section schema): each tool's sections legitimately differ (python has a
 *  DataFrame/LaTeX/image; exec has a console), while the CONTAINER behaviour is what's worth sharing. */
export function OutputCell({ children }: { children: ComponentChildren }) {
    const box = useRef<HTMLDivElement>(null);
    const follow = useRef(true);                       // tail-follow armed? (parked at the bottom)
    const [dragH, setDragH] = useState<number | null>(null);   // a drag pins THIS cell; null → the configured cap
    const id = useMemo(() => nextCellId++, []);
    const findOpen = findOwner.value === id;
    const [q, setQ] = useState("");
    const [cs, setCs] = useState(false);               // case-sensitive toggle (the "Aa" button)
    const [idx, setIdx] = useState(0);                 // which match is current
    const [count, setCount] = useState(0);
    const input = useRef<HTMLInputElement>(null);
    const cap = dragH ?? outMaxH.value;

    const [overflows, setOverflows] = useState(false);
    // Runs after EVERY render — i.e. on each streamed delta — so the newest line stays visible while following.
    useEffect(() => {
        const el = box.current;
        if (!el) return;
        if (follow.current) el.scrollTop = el.scrollHeight;
        // Only offer the resize grip once there's something to resize — this cell wraps EVERY tool's output,
        // and a one-line result shouldn't grow a drag handle.
        const over = el.scrollHeight - el.clientHeight > 2;
        if (over !== overflows) setOverflows(over);
    });
    // Re-run the search whenever the query/case changes — and on every render, so a STREAMING cell keeps its
    // match count honest as new output lands.
    useEffect(() => {
        if (!findOpen || !box.current) return;
        try {
            const rs = rangesFor(box.current, q, cs);
            setCount(rs.length);
            paintFind(rs, rs.length ? rs[Math.min(idx, rs.length - 1)] : null);
        } catch (e) { console.error("ml find:", e); setCount(0); }
    });
    useEffect(() => {
        const el = box.current;
        if (!findOpen || !q || !el) return;
        const rs = rangesFor(el, q, cs);
        const r = rs[Math.min(idx, Math.max(rs.length - 1, 0))];
        if (!r) return;
        follow.current = false;   // the reader is navigating; don't yank them back to the tail
        reveal(el, r);
    }, [q, cs, idx, findOpen]);
    useEffect(() => () => { if (findOwner.value === id) { findOwner.value = 0; clearFindPaint(); } }, []);   // unmount → drop the paint

    // Park a match about a third of the way down THIS container. scrollIntoView would also scroll the panel
    // and the page (and no-ops at `nearest` when the match is already visible), so do the arithmetic here.
    const reveal = (el: HTMLDivElement, r: Range): void => {
        // Purely an affordance: where there's no layout to measure (jsdom) or the range went stale mid-stream,
        // skip it. Never let it throw — the match is still painted and counted, and a broken reveal used to
        // take the whole search effect down with it (count stuck at 0).
        if (typeof (r as { getBoundingClientRect?: unknown }).getBoundingClientRect !== "function") return;
        try {
            const box0 = el.getBoundingClientRect(), hit = r.getBoundingClientRect();
            el.scrollTop += (hit.top - box0.top) - el.clientHeight / 3;
        } catch { /* detached range → nothing to scroll to */ }
    };
    const jump = (delta: number): void => {
        if (!count) return;
        setIdx((idx + delta + count) % count);   // the reveal effect below scrolls to whatever becomes current
    };
    const closeFind = (): void => { findOwner.value = 0; clearFindPaint(); setQ(""); setCount(0); setIdx(0); };
    const onKey = (e: any): void => {
        if ((e.ctrlKey || e.metaKey) && (e.key === "f" || e.key === "F")) {
            e.preventDefault(); e.stopPropagation();
            findOwner.value = id;
            // preventScroll: focusing normally makes the browser reveal the target by scrolling its
            // ANCESTORS — which yanks the panel around and then fights the tail-follow effect (the
            // "Ctrl+F randomly scrolls up and down" jitter). Opening find must never move the view.
            setTimeout(() => input.current?.focus({ preventScroll: true }), 0);
        } else if (e.key === "Escape" && findOpen) { e.preventDefault(); closeFind(); }
    };
    const onFindKey = (e: any): void => {
        if (e.key === "Enter") { e.preventDefault(); jump(e.shiftKey ? -1 : 1); }
        else if (e.key === "Escape") { e.preventDefault(); closeFind(); box.current?.focus({ preventScroll: true }); }
    };
    const onScroll = (): void => { const el = box.current; if (el) follow.current = atBottomOf(el); };
    const onGrab = (e: any): void => {
        e.preventDefault();
        const startY = e.clientY, start = box.current?.getBoundingClientRect().height ?? cap;
        const move = (ev: any): void => setDragH(Math.max(60, Math.round(start + (ev.clientY - startY))));
        const up = (): void => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); };
        window.addEventListener("pointermove", move);
        window.addEventListener("pointerup", up);
    };
    return (
        <div class="r-outcell">
            {/* Ctrl/Cmd+F opens an in-cell find (the cell is focusable so the shortcut is scoped to it, not the page). */}
            {findOpen ? (
                <div class="r-find" role="search">
                    <input ref={input} class="r-find-q" value={q} placeholder="Find" spellcheck={false}
                        onInput={(e: any) => { setIdx(0); setQ(e.target.value); }} onKeyDown={onFindKey} />
                    <button class={`r-find-case${cs ? " on" : ""}`} aria-label="Match case" {...cursorTipOn("Match case")} aria-pressed={cs}
                        onClick={() => { setIdx(0); setCs(v => !v); }}>Aa</button>
                    <span class="r-find-n">{q ? (count ? `${Math.min(idx, Math.max(count - 1, 0)) + 1} of ${count}` : "No results") : ""}</span>
                    <button class="r-find-nav" aria-label="Previous match" {...cursorTipOn("Previous match")} onClick={() => jump(-1)} disabled={!count}>↑</button>
                    <button class="r-find-nav" aria-label="Next match" {...cursorTipOn("Next match")} onClick={() => jump(1)} disabled={!count}>↓</button>
                    <button class="r-find-x" aria-label="Close find" {...cursorTipOn("Close (Esc)")} onClick={closeFind}>✕</button>
                </div>
            ) : null}
            <div class="r-outscroll" ref={box} tabIndex={0} onKeyDown={onKey} onScroll={onScroll}
                style={cap > 0 ? { maxHeight: `${cap}px` } : undefined}>{children}</div>
            {overflows || dragH != null ? <div class="r-outgrip" role="separator" aria-label="Drag to resize this output" {...cursorTipOn("Drag to resize this output")} onPointerDown={onGrab} /> : null}
        </div>
    );
}

/** A python traceback, with its user frames turned into links.
 *
 *  A traceback's whole content is a line number, so it is the one thing that must survive the rendered view
 *  reflowing the code. Each `File "<python_exec>", line N` is mapped through the formatter's line map and
 *  becomes a click target: it scrolls to the In block and pulses that line, the same green flash a cited
 *  step gets, because it is the same gesture — "show me the thing this is about".
 *
 *  The DEEPEST user frame is where the failure actually happened, so it is marked; the frames above it are
 *  the call path. Frames in `<exec>` are the prelude's own call site and are about nothing the user wrote —
 *  they are dimmed rather than dropped, because the RAW view must stay recoverable and quietly deleting a
 *  line of what the model received is exactly what the raw-view rule forbids.
 *
 *  The text itself is never rewritten. This is a rendering of it. */
/** The In block's line map — original line → the line the READER sees, after the reflow that block draws.
 *  ONE implementation, because there are now three consumers (the mark on the code, the number a JS failure
 *  reports, and every frame of a python traceback) and three copies of this arithmetic would be three
 *  chances to disagree about which line a failure was on. Null when nothing moved, which is also the answer
 *  for a descriptor that is not code. */
export function inLineMap(d: RenderDescriptor | undefined): number[] | null {
    if (!d) return null;
    if (d.type === "python-in") { const f = pyFormat(d.code); return f.changed ? f.map : null; }
    if (d.type === "code") {
        const shown = displaySource(d.text, d.lang, d.format, d.marks);
        return shown === d.text ? null : lineMapBetween(d.text, shown);
    }
    return null;
}
/** The row a source line is drawn on. Identity when nothing moved — never null, because "we could not map
 *  it" and "it did not move" produce the same right answer here. */
export const shownLine = (map: number[] | null | undefined, line: number): number => map?.[line] ?? line;

/** Show the line a failure NAMES, in the code block above it — the same gesture (and the same pulse) a
 *  citation makes, because it is the same intent: show me the thing this is about. Lifted out of the python
 *  traceback so a JS failure, which reports exactly one line and has no traceback to render, lands
 *  identically instead of growing a second near-copy of this. */
const jumpToLine = (line: number, isFail: boolean, from: Element) => {
    // The map lives on the In block, published by the renderer that reflowed the code — so a line number
    // written against the ORIGINAL source lands on the line that is actually on screen.
    // Scoped from the CLICKED BUTTON, not from a ref on the block: the ref is null at click time here
    // and a null scope silently falls back to the document, which is the bug being fixed wearing a
    // disguise. The event's own target cannot be null — it is what was clicked.
    const scope: Element | Document = from.closest(".astep") ?? from.closest(".bench-out") ?? document;
    const holder = scope.querySelector("[data-py-map], [data-cite='in']");
    const raw = holder?.getAttribute("data-py-map");
    let shown = line;
    if (raw) { try { const m = JSON.parse(raw) as number[]; if (m[line]) shown = m[line]; } catch { /* unmapped */ } }
    const el = holder?.querySelector(`.cline[data-line="${shown}"]`);
    if (!el) return;
    // MARK FIRST, then scroll. The mark is the answer; the scroll is a convenience — and doing it the
    // other way round means any environment where `scrollIntoView` is missing (jsdom, and anything
    // embedding this in a stripped DOM) loses the answer to a failed nicety.
    // RED for the line that failed, green for the rest of the call path. Green means "here is the thing
    // you asked for"; on the failing line it would be the one colour the line is not, flashing over the
    // red mark already there and saying the opposite of it.
    const cls = isFail ? "cline-pulse-fail" : "cline-pulse";
    el.classList.add(cls);
    setTimeout(() => el.classList.remove(cls), 1400);
    try { el.scrollIntoView({ block: "center", behavior: "smooth" }); } catch { /* not every DOM has it */ }
};

function Traceback({ text, map }: { text: string; map?: number[] | null }) {
    // SCOPED TO ITS OWN STEP, found by walking up from this element. A document-wide lookup finds the FIRST
    // In block on the page, so with two failing steps open both tracebacks jumped into the first one's code —
    // confidently, and at a line number that meant nothing there. Walking up needs no prop threaded through
    // two renderers that otherwise know nothing about each other.
    const rows = text.split("\n");
    // Which rows name a user line, so the last of them can be called out as the failure.
    const userRows = rows.map((r, i) => (/File "<python_exec>", line (\d+)/.test(r) ? i : -1)).filter((i) => i >= 0);
    const deepest = userRows.length ? userRows[userRows.length - 1] : -1;
    const jump = jumpToLine;
    return (
        <pre class="code tb"><code class="hljs">{rows.map((r, i) => {
            // `_user` is the name of the wrapper the sandbox indents the code into — an implementation
            // detail, and one that makes a perfectly correct frame read as nonsense ("line 5, in _user"
            // looks like it is pointing at something internal, so the reader distrusts the number too).
            // Renamed HERE and not in the traceback text: the raw view and the model's copy stay verbatim.
            const r0 = r.replace(/, in _user$/, ", at the top level of your code");
            // Split so the CONTROL is the whole frame reference — `File "<python_exec>", line 9` — and not
            // the bare number. Two characters is a poor hit target, and the reference is the semantic unit:
            // what you are clicking is the FRAME, so that is what should look clickable.
            const m = /^(\s*)(File "<python_exec>", line )(\d+)(.*)$/.exec(r0);
            if (!m) return <span class={`tbline${/File "<exec>"/.test(r) ? " dim" : ""}`} key={i}>{r0}{"\n"}</span>;
            const line = Number(m[3]);
            // As DRAWN, for the same reason ExecError does it: the block above is reflowed, so the
            // traceback's own number names a row that is not the one it means. The raw view keeps the
            // traceback verbatim — this is a rendering of it, and remapping the number is the whole
            // difference between a rendering that helps and one that misdirects.
            const at = shownLine(map, line);
            return (
                <span class={`tbline${i === deepest ? " tb-fail" : ""}`} key={i}>
                    {m[1]}
                    {/* The panel's own tooltip, not the native one: `title` waits about a second before it
                        appears, which on something you are hovering to decide whether to click is long
                        enough to have moved on. */}
                    <span class="tt tb-line-wrap">
                        <button class="tb-line" onClick={(e: MouseEvent) => jump(line, i === deepest, e.currentTarget as Element)}>{m[2]}{at}</button>
                        <span class="tt-pop wrap" role="tooltip">{(i === deepest
                            ? `Line ${at} — where it failed. Click to show it in the code above.`
                            : `Line ${at}. Click to show it in the code above.`)
                            + (at !== line ? ` The model wrote it as line ${line}; the code is reflowed for reading here.` : "")}</span>
                    </span>
                    {m[4]}{"\n"}
                </span>
            );
        })}</code></pre>
    );
}

/** HOW LONG IT RAN, under the output. A script's elapsed time is the one thing about it you cannot read off
 *  the transcript — the timestamps either side include the model's own turn — and while it is still going it
 *  is the difference between "slow" and "stuck".
 *
 *  Live, it ticks; finished, it is what the loop measured (`toolMs`, the tool's own wall clock, which is not
 *  the step's: a human at an approval gate is the step's time and none of the machine's work). */
/** A COLLAPSED step's live elapsed time. "running…" says a thing is alive; it does not say whether it has
 *  been alive for two seconds or two minutes, which is the difference between waiting and going to look.
 *  Silent under half a second, so an ordinary fast tool does not flash a number on its way past. */
export function RunningFor({ since }: { since?: number }) {
    const [now, setNow] = useState(() => Date.now());
    useEffect(() => {
        if (since == null) return;
        // A tenth of a second, like the Out footer: visibly moving, and cleared on unmount or the interval
        // keeps a jsdom window alive and the test runner never exits.
        const id = setInterval(() => setNow(Date.now()), 100);
        return () => clearInterval(id);
    }, [since]);
    const ms = since == null ? 0 : Math.max(0, now - since);
    if (ms < 500) return null;
    return <span class="astep-elapsed"> ({fmtDur(ms)})</span>;
}

/** HOW LONG A SCRIPT RAN, under its output — ticking while it is in flight, settled once it lands. A
 *  first `python_exec` splits its COLD START from the script, because one figure would charge the code
 *  for the seconds spent fetching a runtime. */
export function RanFor({ live, ms, since, remote }: { live?: boolean; ms?: number; since?: number; remote?: { durationMs: number; bootMs?: number } | null }) {
    const [now, setNow] = useState(() => Date.now());
    useEffect(() => {
        if (!live || since == null) return;
        // A tenth of a second: fast enough that the number is visibly moving (which is the point — it says
        // the thing is alive), slow enough to cost nothing. Cleared on unmount, or the interval keeps a
        // jsdom window alive and the test runner never exits.
        const id = setInterval(() => setNow(Date.now()), 100);
        return () => clearInterval(id);
    }, [live, since]);
    if (live && since != null) return <div class="r-ranfor live">running… {fmtDur(Math.max(0, now - since))}</div>;
    if (ms == null) return null;
    // A COLD START is not the script. The first python_exec of a session spends seconds fetching Pyodide and
    // its wheels before a line of the code runs, and a single figure charges the script for time it never
    // spent — the same confusion a model's `load_duration` exists to settle. Shown only when this call is
    // the one that paid for it: every later run is warm and has nothing to explain.
    const boot = remote?.bootMs;
    if (boot != null) return (
        <div class="r-ranfor" {...cursorTipOn(`${fmtDur(boot)} starting the Python sandbox (downloading the runtime and its packages — once per session), then ${fmtDur(remote!.durationMs)} actually running your code. This call paid for the cold start; later ones will not.`)}>
            ran in {fmtDur(ms)} — <b class="r-ranfor-part">{fmtDur(boot)}</b> cold start,{" "}
            <b class="r-ranfor-part">{fmtDur(remote!.durationMs)}</b> script
        </div>
    );
    return <div class="r-ranfor">ran in {fmtDur(ms)}</div>;
}

// A collapsible section of the python-out block (stdout / value / error / token). Same disclosure
// pattern as the In:/Out: blocks — open by default, its label is the summary. A big stdout can be
// folded away to get to the value.
/** Should this section start folded? Focus mode reads the run as a conversation, so a SETTLED python step's
 *  inputs and its captured output fold — but the reader must still be able to open one, which rules out the
 *  CSS hide the rest of focus mode uses. So it seeds the `details`' own state.
 *
 *  Re-seeded when the MODE changes and not on every render: binding `open` straight to the signal would slam
 *  a section you had just opened shut on the panel's next poll, and never re-seeding would leave the fold not
 *  applying until the step was re-mounted. */
function useFocusFold(fold: boolean | undefined): [boolean, (v: boolean) => void] {
    const focus = focusMode.value;
    const [open, setOpen] = useState(!(fold && focus));
    const seeded = useRef(focus);
    if (seeded.current !== focus) { seeded.current = focus; if (fold) setOpen(!focus); }
    return [open, setOpen];
}

function PyOutSection({ label, cls, children, cite, open = true, foldInFocus }: { label: string; cls: string; children: ComponentChildren; cite?: "in" | "out"; open?: boolean; foldInFocus?: boolean }) {
    // `foldInFocus` is a CLASS, not a different `open`: focus mode is a CSS-only hide everywhere else (see
    // the FOCUS MODE block), so the section keeps one real open/closed state and turning the mode off
    // restores exactly what you left. A `details` whose openness depended on the mode would forget it.
    const [shown, setShown] = useFocusFold(foldInFocus);
    const isOpen = foldInFocus ? shown : open;
    return <details class={`r-py-sec ${cls}${foldInFocus ? " focus-fold" : ""}`} open={isOpen}
        onToggle={(e: any) => foldInFocus && setShown(!!e.currentTarget.open)}
        {...(cite ? { "data-cite": cite } : {})}><summary class="r-py-lbl">{label}</summary>{children}</details>;
}
// `python_exec`'s Out slot: captured stdout, then one of a returned image / a minted
// @pt·@box token / the raw value / a Python traceback.
function PythonOutRender({ d, marks, live, ranMs, ranSince, lineMap, remoteMs }: { d: Extract<RenderDescriptor, { type: "python-out" }>; marks?: [number, number][]; live?: boolean; ranMs?: number; ranSince?: number; lineMap?: number[] | null; remoteMs?: { durationMs: number; bootMs?: number } | null }) {
    return (
        <div class="r-python r-py-out">
            {/* Only the captured OUTPUT scrolls (and hosts the find bar) — the returned value/table/image sit
                below it, always visible, like a notebook cell's result. */}
            {/* FOCUS MODE folds stdout — but only once the step has SETTLED. While it is still streaming the
                output is the thing proving the run is alive, which is exactly what a reading mode should not
                hide; `live` is what tells the two apart. Outside focus mode nothing folds: there you are
                reading the console on purpose. */}
            {/* The stdout section is NOT always there — it renders only when something was printed — so the
                elapsed footer goes INSIDE it when it exists and after the last section when it does not.
                Never both, and never an empty section conjured up to hold it: a container that exists only
                to carry a footer is chrome pretending to be output. */}
            {d.stdout ? <PyOutSection label="stdout" cls="r-py-stdout" foldInFocus={!live}>
                <OutputCell><SeenSplit text={d.stdout} seen={d.seen} marks={alignedMarks(marks, d.stdout)} /></OutputCell>
                <RanFor live={live} ms={ranMs} since={ranSince} remote={remoteMs} />
            </PyOutSection> : null}
            {d.image ? <div class="r-image"><ClickableImg src={d.image} alt="output image" /><div class="r-image-label">returned image</div></div> : null}
            {d.token ? <PyOutSection label="token" cls="r-py-token"><code class="r-hoverable" onPointerEnter={() => highlightToken(d.token!)} onPointerLeave={clearHighlight}>{d.token}</code></PyOutSection> : null}
            {d.error ? <PyOutSection label="error" cls="r-py-err" cite="out"><OutputCell><Traceback text={d.error} map={lineMap} /></OutputCell></PyOutSection> : null}
            {d.df && !d.error ? <PyOutSection label="value (DataFrame)" cls="r-py-val" cite="out"><PyDfTable columns={d.df.columns} rows={d.df.rows} /></PyOutSection> : null}
            {/* A sympy return auto-flagged `latex` → typeset the value (display mode), not a raw code block. */}
            {d.latex && d.value != null && !d.image && !d.token && !d.error && !d.df ? <PyOutSection label="value (LaTeX)" cls="r-py-val" cite="out"><div class="md" dangerouslySetInnerHTML={{ __html: markdown(`\\[${d.value}\\]`, { math: true }) }} /></PyOutSection> : null}
            {/* In the same cell as the output above it: a returned value can be as long as anything printed
                on the way there, and it is the half you most often want to search. Capped, scrollable and
                Ctrl+F-able for free by being wrapped, rather than each section inventing its own. */}
            {d.value != null && !d.latex && !d.image && !d.token && !d.error && !d.df ? <PyOutSection label="value" cls="r-py-val" cite="out"><OutputCell><Code text={d.value} lang="json" /></OutputCell></PyOutSection> : null}
            {/* No console to hang it off — so it goes after the last section instead. */}
            {!d.stdout ? <RanFor live={live} ms={ranMs} since={ranSince} remote={remoteMs} /> : null}
        </div>
    );
}

// `exec`'s Out slot — the JS twin of PythonOutRender, so a JS run reads like the same notebook cell:
// captured console output, then the returned value (or the thrown error). Reuses PyOutSection so both
// tools share one look; "console" (not "stdout") because that's what the JS side actually captured.
/** A `code` In block — `exec`'s beautified JS, and anything else that renders as source. It publishes the
 *  same `data-cite` anchor and `data-py-map` the Python one does, so a stack trace beside it maps and jumps
 *  identically: the mapping is a property of SHOWING REFORMATTED CODE, not of the language. */
function CodeRender({ d, failLine, ctx, failed }: { d: Extract<RenderDescriptor, { type: "code" }>; failLine?: number | null; ctx?: CodeCtx; failed?: boolean }) {
    const rv = rev.value;   // subscribe: a landed annotation repaints the block (retained via data-rev below)
    const [map, setMap] = useState<number[] | null>(null);
    const shownFail = failLine != null ? (map?.[failLine] ?? failLine) : null;
    // The annotator has to number the lines the READER sees, and `Code` beautifies JS internally — so the
    // source it will draw is derived here rather than assumed to be `d.text`.
    const shown = displaySource(d.text, d.lang, d.format, d.marks);
    return (
        <div class="code-block" data-cite="in" data-rev={rv} data-py-map={map ? JSON.stringify(map) : undefined}>
            {d.revision ? <CodeDiff revision={d.revision} after={shown} lang={d.lang === "python" ? "python" : "javascript"} hash={ctx?.hash} failed={failed} /> : null}
            {ctx ? <CodeTools ctx={ctx} lang={d.lang === "python" ? "python" : "javascript"} src={shown} /> : null}
            {/* Said out loud, because the rendered text is not always what the caller typed: `exec` expands
                pointer macros before running, so a reader comparing this against the raw args would
                otherwise conclude the log is lying to them. */}
            {d.note ? <div class="rp-note">{d.note}</div> : null}
            {/* The same caveat the python side carries, and for the same reason: a beautifier breaks one
                statement across several rows, so the marked row is where the statement STARTS and the token
                that actually threw can be a few lines down. Said only when the line really moved — an
                unconditional caveat is noise that undermines the times it is true. */}
            <Code text={d.text} lang={d.lang} format={d.format} marks={d.marks} onMap={setMap}
                lineIds="line" markLine={shownFail}
                markTitle={shownFail != null && shownFail !== failLine
                    ? "This line failed. It is shown reflowed for reading — in the code as written this was one line, so the failure is somewhere in the statement starting here."
                    : "This line failed."}
                notes={notesForBlock(ctx, rv)} />
        </div>
    );
}

/** A JS failure, with the LINE it happened on made clickable — the counterpart to a python traceback frame.
 *  JS gives us one line and no call path (an evaluated script's stack is mostly the wrapper), so there is
 *  nothing to render as a traceback; the number is marked in place, in the message text the model also
 *  received. No line → the message verbatim, which is what it always was. */
function ExecError({ text, line, map }: { text: string; line?: number; map?: number[] | null }) {
    const m = line != null ? /^([\s\S]*)\(line (\d+)\)([\s\S]*)$/.exec(text) : null;
    if (!m) return <Code text={text} lang="text" />;
    // THE NUMBER SHOWN IS THE ROW ABOVE. The model was told its own line, and that is what the raw view (and
    // its context) keeps — but the block beside this one is REFLOWED, so repeating the model's number here
    // points the reader at a line that is not the one that failed. The remap belongs to the human-facing
    // render and nowhere else; the tooltip says both numbers so the two views cannot look like a
    // contradiction.
    const at = shownLine(map, line!);
    return (
        <pre class="code tb"><code class="hljs"><span class="tbline tb-fail">
            {m[1]}
            <span class="tt tb-line-wrap">
                {/* The whole `(line 9)`, for the same reason the python frame is: the number alone is a
                    two-character target, and what you are clicking is the reference. */}
                <button class="tb-line" onClick={(e: MouseEvent) => jumpToLine(line!, true, e.currentTarget as Element)}>(line {at})</button>
                <span class="tt-pop wrap" role="tooltip">Line {at} — where it failed. Click to show it in the code above.{at !== line ? ` The model wrote it as line ${line}; the code is reflowed for reading here.` : ""}</span>
            </span>
            {m[3]}
        </span></code></pre>
    );
}

function ExecOutRender({ d, marks, live, ranMs, ranSince, lineMap, remoteMs }: { d: Extract<RenderDescriptor, { type: "exec-out" }>; marks?: [number, number][]; live?: boolean; ranMs?: number; ranSince?: number; lineMap?: number[] | null; remoteMs?: { durationMs: number; bootMs?: number } | null }) {
    return (
        <div class="r-python r-py-out">
            {/* "console" for exec, but a REMOTE tool's streamed frames are not a console — the section is the
                same shape (progress produced as it worked) and only the word differs. */}
            {/* Inside the console when there IS one, after the last section when there is not — see the note
                in PythonOutRender. */}
            {d.stdout ? <PyOutSection label={d.stdoutLabel ?? "console"} cls="r-py-stdout" foldInFocus={!live}>
                <OutputCell><SeenSplit text={d.stdout} seen={d.seen} marks={alignedMarks(marks, d.stdout)} /></OutputCell>
                <RanFor live={live} ms={ranMs} since={ranSince} remote={remoteMs} />
            </PyOutSection> : null}
            {d.token ? <PyOutSection label="token" cls="r-py-token"><code class="r-hoverable" onPointerEnter={() => highlightToken(d.token!)} onPointerLeave={clearHighlight}>{d.token}</code></PyOutSection> : null}
            {d.error ? <PyOutSection label="error" cls="r-py-err"><OutputCell><ExecError text={d.error} line={d.errorLine} map={lineMap} /></OutputCell></PyOutSection> : null}
            {d.value != null && !d.error ? <PyOutSection label="value" cls="r-py-val"><OutputCell><Code text={d.value} lang="json" /></OutputCell></PyOutSection> : null}
            {!d.stdout ? <RanFor live={live} ms={ranMs} since={ranSince} remote={remoteMs} /> : null}
        </div>
    );
}

// A DELEGATED look's Out: the exact image the reader saw + which model read it + its text output —
// so it reads like a locate sub-call, not the weird auto-derived element text it used to show.
function LookRender({ d }: { d: Extract<RenderDescriptor, { type: "look" }> }) {
    return (
        <div class="r-look">
            <div class="r-image">
                <ClickableImg src={d.image} alt={d.label || "look"} />
                <div class="r-image-label">{d.label ? `${d.label} · ` : ""}viewed by <b>{d.model || "default"}</b></div>
            </div>
            {/* The exact prompt the reader was asked over the image — collapsed by default (secondary), but
                there so you can see WHY the VLM answered as it did (e.g. the click-mark annotation note). */}
            {d.prompt ? <details class="r-py-sec r-look-prompt-sec"><summary class="r-py-lbl">prompt sent</summary>
                <div class="r-look-prompt">{d.prompt}</div></details> : null}
            {/* The reader's output can be long → collapsible (open by default), same disclosure as python-out. */}
            <details class="r-py-sec r-look-out-sec" open>
                <summary class="r-py-lbl">model output</summary>
                <div class="r-look-out md" dangerouslySetInnerHTML={{ __html: markdown(d.output, { math: true }) }} />
            </details>
        </div>
    );
}

/** `lineMap` is the IN block's reflow map, handed to the OUT block so a failure can name the row the
 *  reader is actually looking at. The two are separate descriptors that cannot see each other; only the
 *  step holds both, so it is the step that passes this across. */
export function RenderPanel({ d, marks, live, failLine, ranMs, ranSince, ctx, lineMap, remoteMs, failed }: { d: RenderDescriptor; marks?: [number, number][]; live?: boolean; failLine?: number | null; ranMs?: number; ranSince?: number; ctx?: CodeCtx; lineMap?: number[] | null; remoteMs?: { durationMs: number; bootMs?: number } | null; failed?: boolean }) {
    switch (d.type) {
        case "image": {
            // If the label references an @pt/@box (e.g. look's `element "@pt:…"`), hovering the shot
            // outlines that point/region on the page — same overlay setup.
            const th = tokenHover(d.label);
            return <div class={`r-image${th.onPointerEnter ? " r-hoverable" : ""}`} {...th}>
                <ClickableImg src={d.src} alt={d.label || "image"} />{d.label ? <div class="r-image-label">{d.label}</div> : null}</div>;
        }
        case "code": return <CodeRender d={d} failLine={failLine} ctx={ctx} failed={failed} />;
        case "table": return <RenderTable columns={d.columns} rows={d.rows} />;
        case "keyval": return <div class="r-keyval">{d.pairs.map(([k, v], i) => <div class="r-kv" key={i}><span class="r-k">{k}</span><span class="r-v">{v}</span></div>)}</div>;
        case "elements": return <RenderElements items={d.items} />;
/** The Markdown ladder as a resolution TREE: what was tried, what worked, what was never needed. Every rung is
 *  drawn, dimmed when unused, so the protocol is legible from any single render rather than having to be
 *  inferred across several. The failures it exists to expose are invisible in the body alone — a stub twin is
 *  a valid 200 Markdown document that is simply the wrong page. */
function FetchLadder({ attempts, resolvedBy }: { attempts: import("../contract").FetchAttempt[]; resolvedBy?: string }): preact.JSX.Element {
    return (
        <div class="r-lad">
            {attempts.map((a, i) => {
                const last = i === attempts.length - 1;
                const meta = rungMeta(a);
                return (
                    <div class={`r-lad-row${a.outcome === "skipped" ? " r-lad-unused" : ""}`} key={`${a.strategy}-${i}`}>
                        <span class="r-lad-rail">{last ? "└─" : "├─"}</span>
                        <span class={`r-lad-glyph r-lad-${a.outcome}`}>{GLYPH[a.outcome] || "·"}</span>
                        <span class="r-lad-label">{rungLabel(a)}</span>
                        {meta ? <span class="r-lad-meta">{meta}</span> : null}
                        {a.note ? <span class="r-lad-note">{a.note}</span> : null}
                    </div>
                );
            })}
            {resolvedBy ? <div class="r-lad-by"><b>resolved by</b> {RESOLVED_LABEL[resolvedBy as import("../contract").FetchAttempt["strategy"]] || resolvedBy}</div> : null}
        </div>
    );
}

        case "action":
            // DEBUG In view (overlay/devtools + HUD "show work"): a hoverable ELEMENT reference when the action
            // targets a page element (selector — hover → outline, right-click → copy a reference); otherwise a
            // clean verb + URL line for a navigate/fetch (NOT raw JSON, and NOT the card's "Agent wants to …"
            // sentence — that's ApprovalBody's job; the log stays a plain debugging view).
            if (d.selector) return <RenderElements items={[{ path: d.selector, ...(d.target ? { text: d.target } : {}) }]} />;
            if (d.target) {
                const target = d.target;
                return (
                    <div class="r-action">
                        <div>
                            <span class="r-action-verb">{d.verb}</span>{" "}
                            {d.input ? <><b class="r-action-input">“{truncate(d.input, 120)}”</b>{" "}</> : null}
                            <span class="r-action-target" {...cursorTipOn("Right-click to open this or copy it.")}
                                onContextMenu={e => openCtxMenu(e, [
                                    { label: "Open in new tab", run: () => { try { window.open(target, "_blank", "noopener"); } catch { /* popup blocked */ } } },
                                    { label: "Copy URL", run: () => { try { void navigator.clipboard?.writeText(target); } catch { /* no clipboard */ } } },
                                ])}>{target}</span>
                            {d.note ? <span class="r-action-note"> · {d.note}</span> : null}
                        </div>
                        {/* The Markdown ladder — which URL these bytes actually came from, and whether the
                            Markdown is the site's own or ours. Absent unless negotiation ran. */}
                        {d.attempts?.length ? <FetchLadder attempts={d.attempts} resolvedBy={d.resolvedBy} /> : null}
                        {/* fetch `ask` mode: the question gets its own line (FULL, never truncated), then who answered
                            it + the tokens that reader sub-call spent — so the distill is legible, not a squeezed note. */}
                        {d.ask ? <div class="r-action-ask"><b>Asked:</b> {d.ask}</div> : null}
                        {d.answeredBy ? <div class="r-action-meta">Answered by: <span class="r-action-model">{d.answeredBy}</span>{d.tokens ? <> · {d.tokens.toLocaleString()} tokens</> : null}</div> : null}
                        {/* The in-the-middle step: the RAW content the reader model actually saw before answering.
                            Collapsed (it can be large), like locate's per-substep prompt — open it to audit the distill. */}
                        {d.askBody ? <details class="r-py-sec r-action-body-sec"><summary class="r-py-lbl">content read by the model{d.askBodyTruncated ? " (truncated)" : ""} · {d.askBody.length.toLocaleString()} chars</summary>
                            <Code text={d.askBody} lang={d.askBodyLang || "text"} /></details> : null}
                        {/* fetch_url `pipe`: the shell pipeline the fetched text was scanned through — shown as the
                            interpreted `bash` command it is, so it reads as code, not a note. */}
                        {d.pipe ? <div class="r-action-pipe"><div class="r-py-lbl">piped through</div><Code text={d.pipe} lang="bash" /></div> : null}
                    </div>
                );
            }
            return <Code text={pretty(d)} lang="json" />;
        case "locate": return <LocateRender d={d} />;
        case "python-in": return <PythonInRender d={d} live={live} failLine={failLine} ctx={ctx} failed={failed} />;
        case "python-out": return <PythonOutRender d={d} marks={marks} live={live} ranMs={ranMs} ranSince={ranSince} lineMap={lineMap} remoteMs={remoteMs} />;
        case "exec-out": return <ExecOutRender d={d} marks={marks} live={live} ranMs={ranMs} ranSince={ranSince} lineMap={lineMap} remoteMs={remoteMs} />;
        case "look": return <LookRender d={d} />;
        default: return <Code text={pretty(d)} lang="json" />;   // unknown type → dump it
    }
}
