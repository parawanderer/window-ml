// RenderDescriptor renderers — a serializable RenderDescriptor → a debug panel. The
// registry (RenderPanel) is keyed by `type`; a tool supplies one (page-side) or we
// auto-derive image/elements, else the default In:/Out: renders the raw result.
// Extracted from app.tsx; leans on the shared primitives in ./ui-kit.
import type { ComponentChildren } from "preact";
import { GLYPH, RESOLVED_LABEL, rungLabel, rungMeta } from "./fetch-ladder";
import { useState, useRef, useEffect, useMemo } from "preact/hooks";
import { signal } from "@preact/signals";
import type { RenderDescriptor, LocateSubstep, TableSource } from "../contract";
import { elementReference } from "../dom";
import { rev, view, sessionMap, outMaxH, showOutTimes } from "./store";
import { timeForOffset, alignedMarks, elideHour, hhmmss, hhmmssms, fmtDelta, hourNow, armHourTick, dayBreaks } from "./timestamps";
import { markdown, truncate, pretty } from "./format";
import {
    openCtxMenu, copyText, ClickableImg, Code, SheetChip, inlineText,
    highlightToken, highlightEl, clearHighlight, tokenHover, pickedHover,
} from "./ui-kit";

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
                        title={isTok ? undefined : "right-click to copy a reference"}
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
const csvField = (v: string | number | null): string => {
    const s = v == null ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
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
                                <th key={j} style={widths[j] ? { width: `${widths[j]}px` } : undefined} onClick={() => cycleSort(j)} title="click to sort">
                                    {c}{sort && sort.c === j ? <span class="r-df-sort">{sort.dir === 1 ? " ▲" : " ▼"}</span> : null}
                                    <span class="r-df-resize" title="drag to resize" onPointerDown={(e: any) => startResize(j, e)} onClick={(e: any) => e.stopPropagation()} />
                                </th>
                            ))}
                        </tr></thead>
                        <tbody>{shown.map(([origIdx, row], i) => (
                            <tr key={i}>
                                <td class="r-df-idx">{origIdx}</td>
                                {cols.map((_, j) => { const c = row[j]; return <td key={j} class={typeof c === "number" ? "r-td-num" : (c == null ? "r-td-nan" : undefined)}>{c == null ? "NaN" : String(c)}</td>; })}
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
function PythonInRender({ d }: { d: Extract<RenderDescriptor, { type: "python-in" }> }) {
    return (
        <div class="r-python r-py-in">
            <div class="r-py-mode">Mode: <span class="tt"><span class="r-py-modeval">{PY_MODE[d.mode].label}</span><span class="tt-pop left" role="tooltip">{PY_MODE[d.mode].tip}</span></span></div>
            {d.image ? <div class="r-image r-py-img"
                {...(d.imageToken ? { onPointerEnter: () => highlightToken(d.imageToken!), onPointerLeave: clearHighlight } : {})}>
                <ClickableImg src={d.image} alt="input image" /><div class="r-image-label">input image (img / img_np){d.imageToken ? " — hover to locate on page" : ""}</div></div> : null}
            {(d.tables || []).map((t, i) => {
                const src = tableSourceDesc(t.source);
                const cols = t.columns?.length || t.rows?.[0]?.length || 0;
                return <div key={i} class="r-py-table">
                    <div class="r-py-lbl">
                        input table → <b class="r-py-var">{t.name}</b>{t.rows ? ` (${t.rows.length} × ${cols})` : ""}
                        {" · "}
                        {t.source.kind === "sheet-external"
                            ? <SheetChip id={t.source.label} label={t.source.name || undefined} />   /* id → a friendly chip; name = the real sheet title */
                            : <span class="tt r-py-src"><span class="r-py-srcval">{src.short}</span><span class="tt-pop left" role="tooltip">{src.tip}</span></span>}
                    </div>
                    {t.rows ? <PyDfTable columns={t.columns || []} rows={t.rows} />
                        : <div class="dim r-py-more">loaded via pd.read_html (no clean row preview)</div>}
                </div>;
            })}
            <Code text={d.code} lang="python" />
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
                <span class={`r-ts${tip ? " hoverable" : ""}`} title={tip}>{repeat ? "" : label}</span>
                <span class="r-ts-line">{line}</span>
            </div>,
        );
    });
    return <div class={`code r-timed${short ? " short" : ""}`}>{rows}</div>;
}

export function SeenSplit({ text, seen, live, marks }: { text: string; seen?: number; live?: boolean; marks?: [number, number][] }) {
    if (seen == null || seen >= text.length) return <TimedOutput text={text} marks={marks} />;
    return (
        <>
            <TimedOutput text={text.slice(0, seen)} marks={marks} />
            {/* While the tool is still RUNNING we already know where the model's cut will fall, so mark it as it
                streams rather than springing it on you at the end — greyed, with a "?" that explains why. */}
            <div class={`r-unseen-lbl${live ? " live" : ""}`}
                title={live
                    ? "Past this point the output is beyond the model's per-call output cap — it is still being captured for you, but it will NOT be part of the result sent to the model."
                    : "The tool captured this, but it was clipped out of the result sent to the model (its output cap). The model never read it."}>
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
                    <button class={`r-find-case${cs ? " on" : ""}`} title="Match case" aria-pressed={cs}
                        onClick={() => { setIdx(0); setCs(v => !v); }}>Aa</button>
                    <span class="r-find-n">{q ? (count ? `${Math.min(idx, Math.max(count - 1, 0)) + 1} of ${count}` : "No results") : ""}</span>
                    <button class="r-find-nav" title="Previous match" onClick={() => jump(-1)} disabled={!count}>↑</button>
                    <button class="r-find-nav" title="Next match" onClick={() => jump(1)} disabled={!count}>↓</button>
                    <button class="r-find-x" title="Close (Esc)" onClick={closeFind}>✕</button>
                </div>
            ) : null}
            <div class="r-outscroll" ref={box} tabIndex={0} onKeyDown={onKey} onScroll={onScroll}
                style={cap > 0 ? { maxHeight: `${cap}px` } : undefined}>{children}</div>
            {overflows || dragH != null ? <div class="r-outgrip" role="separator" aria-label="Drag to resize this output" title="Drag to resize this output" onPointerDown={onGrab} /> : null}
        </div>
    );
}

// A collapsible section of the python-out block (stdout / value / error / token). Same disclosure
// pattern as the In:/Out: blocks — open by default, its label is the summary. A big stdout can be
// folded away to get to the value.
function PyOutSection({ label, cls, children }: { label: string; cls: string; children: ComponentChildren }) {
    return <details class={`r-py-sec ${cls}`} open><summary class="r-py-lbl">{label}</summary>{children}</details>;
}
// `python_exec`'s Out slot: captured stdout, then one of a returned image / a minted
// @pt·@box token / the raw value / a Python traceback.
function PythonOutRender({ d, marks }: { d: Extract<RenderDescriptor, { type: "python-out" }>; marks?: [number, number][] }) {
    return (
        <div class="r-python r-py-out">
            {/* Only the captured OUTPUT scrolls (and hosts the find bar) — the returned value/table/image sit
                below it, always visible, like a notebook cell's result. */}
            {d.stdout ? <PyOutSection label="stdout" cls="r-py-stdout"><OutputCell><SeenSplit text={d.stdout} seen={d.seen} marks={alignedMarks(marks, d.stdout)} /></OutputCell></PyOutSection> : null}
            {d.image ? <div class="r-image"><ClickableImg src={d.image} alt="output image" /><div class="r-image-label">returned image</div></div> : null}
            {d.token ? <PyOutSection label="token" cls="r-py-token"><code class="r-hoverable" onPointerEnter={() => highlightToken(d.token!)} onPointerLeave={clearHighlight}>{d.token}</code></PyOutSection> : null}
            {d.error ? <PyOutSection label="error" cls="r-py-err"><Code text={d.error} lang="text" /></PyOutSection> : null}
            {d.df && !d.error ? <PyOutSection label="value (DataFrame)" cls="r-py-val"><PyDfTable columns={d.df.columns} rows={d.df.rows} /></PyOutSection> : null}
            {/* A sympy return auto-flagged `latex` → typeset the value (display mode), not a raw code block. */}
            {d.latex && d.value != null && !d.image && !d.token && !d.error && !d.df ? <PyOutSection label="value (LaTeX)" cls="r-py-val"><div class="md" dangerouslySetInnerHTML={{ __html: markdown(`\\[${d.value}\\]`, { math: true }) }} /></PyOutSection> : null}
            {d.value != null && !d.latex && !d.image && !d.token && !d.error && !d.df ? <PyOutSection label="value" cls="r-py-val"><Code text={d.value} lang="json" /></PyOutSection> : null}
        </div>
    );
}

// `exec`'s Out slot — the JS twin of PythonOutRender, so a JS run reads like the same notebook cell:
// captured console output, then the returned value (or the thrown error). Reuses PyOutSection so both
// tools share one look; "console" (not "stdout") because that's what the JS side actually captured.
function ExecOutRender({ d, marks }: { d: Extract<RenderDescriptor, { type: "exec-out" }>; marks?: [number, number][] }) {
    return (
        <div class="r-python r-py-out">
            {d.stdout ? <PyOutSection label="console" cls="r-py-stdout"><OutputCell><SeenSplit text={d.stdout} seen={d.seen} marks={alignedMarks(marks, d.stdout)} /></OutputCell></PyOutSection> : null}
            {d.token ? <PyOutSection label="token" cls="r-py-token"><code class="r-hoverable" onPointerEnter={() => highlightToken(d.token!)} onPointerLeave={clearHighlight}>{d.token}</code></PyOutSection> : null}
            {d.error ? <PyOutSection label="error" cls="r-py-err"><Code text={d.error} lang="text" /></PyOutSection> : null}
            {d.value != null && !d.error ? <PyOutSection label="value" cls="r-py-val"><Code text={d.value} lang="json" /></PyOutSection> : null}
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

export function RenderPanel({ d, marks }: { d: RenderDescriptor; marks?: [number, number][] }) {
    switch (d.type) {
        case "image": {
            // If the label references an @pt/@box (e.g. look's `element "@pt:…"`), hovering the shot
            // outlines that point/region on the page — same overlay setup.
            const th = tokenHover(d.label);
            return <div class={`r-image${th.onPointerEnter ? " r-hoverable" : ""}`} {...th}>
                <ClickableImg src={d.src} alt={d.label || "image"} />{d.label ? <div class="r-image-label">{d.label}</div> : null}</div>;
        }
        case "code": return (<>
            {/* Said out loud, because the rendered text is not always what the caller typed: `exec` expands
                pointer macros before running, so a reader comparing this against the raw args would
                otherwise conclude the log is lying to them. */}
            {d.note ? <div class="rp-note">{d.note}</div> : null}
            <Code text={d.text} lang={d.lang} format={d.format} marks={d.marks} />
        </>);
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
                            <span class="r-action-target" title="right-click to open or copy"
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
        case "python-in": return <PythonInRender d={d} />;
        case "python-out": return <PythonOutRender d={d} marks={marks} />;
        case "exec-out": return <ExecOutRender d={d} marks={marks} />;
        case "look": return <LookRender d={d} />;
        default: return <Code text={pretty(d)} lang="json" />;   // unknown type → dump it
    }
}
