// RenderDescriptor renderers — a serializable RenderDescriptor → a debug panel. The
// registry (RenderPanel) is keyed by `type`; a tool supplies one (page-side) or we
// auto-derive image/elements, else the default In:/Out: renders the raw result.
// Extracted from app.tsx; leans on the shared primitives in ./ui-kit.
import type { ComponentChildren } from "preact";
import { useState } from "preact/hooks";
import type { RenderDescriptor, LocateSubstep, TableSource } from "../contract";
import { elementReference } from "../dom";
import { rev, view, sessionMap } from "./store";
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
// A collapsible section of the python-out block (stdout / value / error / token). Same disclosure
// pattern as the In:/Out: blocks — open by default, its label is the summary. A big stdout can be
// folded away to get to the value.
function PyOutSection({ label, cls, children }: { label: string; cls: string; children: ComponentChildren }) {
    return <details class={`r-py-sec ${cls}`} open><summary class="r-py-lbl">{label}</summary>{children}</details>;
}
// `python_exec`'s Out slot: captured stdout, then one of a returned image / a minted
// @pt·@box token / the raw value / a Python traceback.
function PythonOutRender({ d }: { d: Extract<RenderDescriptor, { type: "python-out" }> }) {
    return (
        <div class="r-python r-py-out">
            {d.stdout ? <PyOutSection label="stdout" cls="r-py-stdout"><Code text={d.stdout} lang="text" /></PyOutSection> : null}
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

export function RenderPanel({ d }: { d: RenderDescriptor }) {
    switch (d.type) {
        case "image": {
            // If the label references an @pt/@box (e.g. look's `element "@pt:…"`), hovering the shot
            // outlines that point/region on the page — same overlay setup.
            const th = tokenHover(d.label);
            return <div class={`r-image${th.onPointerEnter ? " r-hoverable" : ""}`} {...th}>
                <ClickableImg src={d.src} alt={d.label || "image"} />{d.label ? <div class="r-image-label">{d.label}</div> : null}</div>;
        }
        case "code": return <Code text={d.text} lang={d.lang} format={d.format} />;
        case "table": return <RenderTable columns={d.columns} rows={d.rows} />;
        case "keyval": return <div class="r-keyval">{d.pairs.map(([k, v], i) => <div class="r-kv" key={i}><span class="r-k">{k}</span><span class="r-v">{v}</span></div>)}</div>;
        case "elements": return <RenderElements items={d.items} />;
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
        case "python-out": return <PythonOutRender d={d} />;
        case "look": return <LookRender d={d} />;
        default: return <Code text={pretty(d)} lang="json" />;   // unknown type → dump it
    }
}
