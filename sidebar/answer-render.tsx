// Answer + @tool-citation rendering — the agent's final answer with its `@tool` citations resolved to the
// actual (focused) tool output, the provenance jump (click a citation → its source step, pulsed green), and
// the bottom-of-answer Result / Feedback / Reused blocks. Extracted from app.tsx; sits above ./render-panel.
import type { ComponentChildren } from "preact";
import type { RenderDescriptor, ToolFeedback, ReusedGrant } from "../contract";
import { splitAnswer, hasTokens, resolveTokenStep } from "../answer-tokens";
import type { AnswerSegment } from "../answer-tokens";
import type { Session, AgentStep } from "./store";
import { cardShowWorkHash, revealSeq } from "./store";
import { pretty, markdown } from "./format";
import { IconChevron, IconEye, IconCheck } from "./icons";
import { ClickableImg, Code, SheetChip } from "./ui-kit";
import { RenderPanel, PyDfTable } from "./render-panel";

// Scroll the transcript to the step that minted a @tool token + pulse it green — the provenance click. In the
// HUD it first EXPANDS "Show work" (the step row is otherwise not rendered); in a MULTI-TASK run the step also
// lives inside a per-task BLOCK that may be collapsed, so it sets `revealSeq` to force THAT block open too (the
// bug: it only worked when the run wasn't segmented into blocks). Then it retries the scroll for a few frames,
// since the block open → re-render → paint is async.
export function scrollToStepSeq(seq?: number, hash?: string): void {
    if (seq == null) return;
    if (hash) cardShowWorkHash.value = hash;   // open the HUD "Show work" so the step exists to scroll to
    revealSeq.value = seq;                      // force-open the per-task block that holds this step (if collapsed)
    const doScroll = (): boolean => {
        const el = document.querySelector(`[data-astep-seq="${seq}"]`);
        if (!el) return false;
        el.scrollIntoView({ block: "center", behavior: "smooth" });
        el.classList.add("astep-pulse");
        setTimeout(() => el.classList.remove("astep-pulse"), 1400);
        return true;
    };
    // Retry across a handful of frames: expanding Show-work AND a collapsed block are async re-renders, so the
    // row may not exist on the first (or second) tick.
    let tries = 0;
    const attempt = (): void => { if (doScroll() || tries++ > 8) { return; } requestAnimationFrame(attempt); };
    attempt();
    // Release the force-open after the pulse so the user can re-collapse the block, and a RE-click of the same
    // token (same seq) re-triggers the block's open effect (a stale value would make the dep look unchanged).
    setTimeout(() => { if (revealSeq.value === seq) revealSeq.value = null; }, 1700);
}

// A JSON value → pretty-printed, so a computed dict/list reads as a block instead of one dense line; null if it
// isn't JSON.
const tryPrettyJson = (t: string): string | null => {
    const s = (t || "").trim();
    if (!(s.startsWith("{") || s.startsWith("["))) return null;
    try { const v = JSON.parse(s); if (v && typeof v === "object") return JSON.stringify(v, null, 2); } catch { /* not json */ }
    return null;
};

// A `| img` citation renders the tool's OWN image bytes — a RASTER `data:image` URL or a bare base64 blob
// (safe: no network, no script). Deliberately STRICT to keep a model-controlled value from becoming an
// attack: only png/jpeg/gif/webp with clean base64 (no `svg` — an <svg> is script-inert in an <img> but
// still an unnecessary surface; no `data:text/html`; no `javascript:`; no external http(s) URL that would
// beacon the viewer). The clean-base64 tail also blocks any `"`/`<`/space attribute-breakout. Anything else
// returns null → the citation falls back to its normal (text) render, never an <img>.
const dataImageFrom = (t: string): string | null => {
    const s = (t || "").trim();
    if (/^data:image\/(?:png|jpe?g|gif|webp);base64,[A-Za-z0-9+/]+={0,2}$/i.test(s)) return s;
    const b = s.replace(/\s+/g, "");
    if (/^[A-Za-z0-9+/]+={0,2}$/.test(b) && b.length > 64) return `data:image/png;base64,${b}`;
    return null;
};

// The tool-name-ALIAS gate for splitAnswer/hasTokens: a non-hex `@tool:<name>` is a real citation only when this
// run actually has a tokened step for that tool (so `@tool:python_exec` resolves; a garbled `@tool:nothex` stays
// prose). Custom tools are covered for free — it reads the run's own steps.
export const aliasOf = (run: Session) => (name: string): boolean => (run.steps || []).some(s => s.tool === name && !!s.token);

// A FOCUSED, answer-appropriate render of a cited slot: the CODE for :in, the table/image/value for :out — NOT
// the full tool-step In/Out render (which carries debug chrome, e.g. python's input table). Reuses RenderPanel
// ONLY for pure data (image/table/elements), so the tool-step rendering is untouched (the constraint).
function tokenRender(d: RenderDescriptor | undefined, rawText: string): { node: ComponentChildren; block: boolean } {
    switch (d?.type) {
        case "image": case "table": case "elements": return { node: <RenderPanel d={d} />, block: true };
        case "look": return { node: <ClickableImg src={d.image} alt={d.label || "look"} />, block: true };
        case "code": return { node: <Code text={d.text} lang={d.lang} format={d.format} />, block: true };
        case "python-in": return { node: <Code text={d.code} lang="python" />, block: true };   // just the code, not the input table
        case "python-out":
            // Use the SAME rich DataFrame renderer the python step shows (index gutter / sort / resize /
            // copy-CSV / hide), not the bare RenderTable — a cited/auto-appended df should read identically
            // to its step's Out, so the bottom-of-answer table keeps its affordances.
            if (d.df) return { node: <PyDfTable columns={d.df.columns} rows={d.df.rows} />, block: true };
            if (d.image) return { node: <ClickableImg src={d.image} alt="output" />, block: true };
            rawText = d.value ?? d.stdout ?? rawText; break;
    }
    const j = tryPrettyJson(rawText);
    if (j) return { node: <Code text={j} lang="json" />, block: true };
    const block = !!rawText && (rawText.length > 80 || /\n/.test(rawText));
    return { node: block ? <Code text={rawText} lang="text" /> : <code class="tok-val">{rawText}</code>, block };
}

// One embedded @tool citation, resolved to the step it cites — rendered as the ACTUAL (focused) output, with a
// caption (the model's link text) and a provenance click (deterministic; opens "Show work" at that step + green
// pulse). An unresolvable id → a visible chip, never a crash.
// `scope` narrows which steps a tool-name ALIAS (`@tool:python_exec`) resolves against — pass a single
// turn/block's steps so a PRIOR answer's alias points at THAT turn's call, not a later turn's (an exact hex
// id is anchored per-step and needs no scoping). Defaults to the whole run (correct for the latest answer).
function TokenRef({ seg, run, scope }: { seg: Extract<AnswerSegment, { kind: "token" }>; run: Session; scope?: readonly AgentStep[] }) {
    const step = resolveTokenStep(seg.id, scope ?? run.steps ?? []) as AgentStep | null;
    if (!step) return <span class="tok-ref tok-unresolved" title={`No step in this run produced @tool:${seg.id} — the model may have invented it.`}>⟨unresolved @tool:{seg.id}⟩</span>;
    const jump = () => scrollToStepSeq(step.seq, run.hash);
    const provenance = `Click to see the exact operation that produced this — step ${step.localStep ?? step.step} · ${step.tool || "tool"}`;
    // LINK form `[label](@tool:…)` — a clickable JUMP to the output (the source step), NOT an inline expansion
    // (that's the `![…]` embed form below). `label` is the link text.
    if (!seg.embed) {
        const linkLabel = seg.label && seg.label.trim() ? seg.label.trim() : `@tool:${seg.id}`;
        return <a class="tok-link" role="button" tabIndex={0} title={provenance}
            onClick={(e) => { e.preventDefault(); jump(); }} onKeyDown={(e) => { if (e.key === "Enter") jump(); }}>{linkLabel}</a>;
    }
    const d = seg.slot === "in" ? step.renderIn : step.renderOut;
    // The clean textual value of the cited slot. For a python-out SCALAR, prefer the descriptor's `value`/`stdout`
    // over `step.result` — the result string carries a model-facing prelude ("[loaded, reference directly] … df.")
    // that must NOT leak into an inline value or (worse) a `| latex` render (it isn't valid LaTeX).
    const rawText = seg.slot === "in" ? (step.arguments ? pretty(step.arguments) : "")
        : (d?.type === "python-out" ? (d.value ?? d.stdout ?? step.result ?? "") : (step.result ?? ""));
    // The model's caption. INLINE citation (the value is shown in-line) → the label goes in the TOOLTIP; BLOCK
    // citation (a table/image/code) → the label is a CAPTION under the render, like a figure caption on the web.
    const label = seg.label && seg.label.trim() && seg.label.trim() !== rawText.trim() ? seg.label.trim() : "";
    const isLatex = seg.fmt === "latex" && !!rawText;
    const isRaw = seg.fmt === "raw" && !!rawText;   // `| raw` — force the literal value, no table/image/latex render
    // `| img` — render the tool's OWN image output (the descriptor's captured image, else a data:/base64 value).
    // An external http(s) URL is deliberately NOT turned into an <img> (that would beacon the viewer); it falls
    // through to the normal render. So `| img` only ever shows extension-produced pixels.
    const descImg = d?.type === "image" ? d.src : (d?.type === "python-out" || d?.type === "look") ? d.image : undefined;
    const imgSrc = seg.fmt === "img" ? (descImg || dataImageFrom(rawText)) : null;
    const { node, block } = imgSrc
        ? { node: <ClickableImg src={imgSrc} alt={label || "image"} />, block: true }
        : isRaw
            ? { node: <Code text={rawText} lang="text" />, block: true }
            : isLatex
                // Use EXPLICIT `\(…\)` delimiters, not `$…$` — single-`$` inline math only typesets when the content
                // carries a math signal (`\`/`^`/`_`), so a bare value like `5` would render as the literal text "$5$".
                // An EMBED (`![…]`) renders as a BLOCK so it gets the green tool-output marker + its label caption
                // (like a non-latex output); a link-form citation stays inline in the prose.
                ? { node: <span dangerouslySetInnerHTML={{ __html: markdown(`\\(${rawText}\\)`, { math: true }) }} />, block: seg.embed }
                : tokenRender(d, rawText);
    const tip = (label && !block ? `${label} · ` : "") + provenance;   // inline → prepend the label to the tooltip
    return <span class={`tok-ref ${block ? "tok-block" : "tok-inline"}`} role="button" tabIndex={0}
        onClick={jump} onKeyDown={(e) => { if (e.key === "Enter") jump(); }}>
        {node}
        {block && label ? <div class="tok-anno">{label}</div> : null}
        <span class="tok-tip" role="tooltip">{tip}</span>
    </span>;
}

// The agent's final ANSWER, with @tool citations RESOLVED to the actual (focused) tool output inline. NO toggle
// — the HUD is a minimal surface; the raw markdown stays available in the DevTools bubble's [raw] and the
// export's disclosure. No tokens → plain markdown.
export function AnswerBody({ text, run, cls = "card-answer", scope }: { text: string; run: Session; cls?: string; scope?: readonly AgentStep[] }) {
    const mdHtml = (t: string) => ({ __html: markdown(t, { math: true }) });
    // Between citations: strip a lone wrapping <p> so an inline citation flows in the same line — but markdown
    // trims a paragraph's boundary whitespace, so RE-ADD a space when the prose had one (else "table" + inline
    // token collide as "tablenull"). A multi-paragraph chunk keeps its <p>s (block structure around a block token).
    const proseHtml = (t: string) => {
        const h = markdown(t, { math: true });
        const m = h.match(/^<p>([\s\S]*)<\/p>\s*$/);
        return { __html: m ? (/^\s/.test(t) ? " " : "") + m[1] + (/\s$/.test(t) ? " " : "") : h };
    };
    if (!hasTokens(text, aliasOf(run))) return <div class={`${cls} md`} dangerouslySetInnerHTML={mdHtml(text)} />;
    return <div class={`${cls} md answer-rendered`}>{splitAnswer(text, aliasOf(run)).map((seg, i) => seg.kind === "prose"
        ? <span key={i} dangerouslySetInnerHTML={proseHtml(seg.text)} />
        : <TokenRef key={i} seg={seg} run={run} scope={scope} />)}</div>;
}

// The bottom-of-answer RESULT block: the run's designated (ml.answer) + auto-appended tool outputs, rendered
// UNDER the model's prose reply. Shared by the HUD completion card AND the DevTools/sidebar reply bubble so the
// two stay in parity (same "one render, both surfaces" rule as everything else). Only shows when the answer set
// carries a @tool OUTPUT (a table/image/value the prose can't render) — a text-only set would just echo the prose.
// The label is chrome (muted + uppercase), so it reads as an extension-added section, not the model's own words.
export function ResultBlock({ run }: { run: Session }) {
    if (!run.answer || !hasTokens(run.answer, aliasOf(run))) return null;
    return <div class="card-result"><div class="result-label">Result</div><AnswerBody text={run.answer} run={run} /></div>;
}

// "Sent to the model" — what a tool fed straight INTO the model's context (locate's snap-inject: a
// marked crop for a vision driver, a delegated description for a text-only one), plus WHY it was sent
// (a point is automatic; a selector/@box only with verify:true). This is distinct from Out (which the
// model also gets): it spotlights the extra VISUAL/DESCRIPTION payload the model received in-turn.
export function FeedbackBlock({ fb }: { fb: ToolFeedback }) {
    // Collapsed by default — the injected crop is usually the same image already shown in the Out
    // locate render above, so it's visually redundant; the summary (what + why) is the useful part.
    return (
        <details class="astep-feedback">
            <summary class="feedback-head"><span class="tri" aria-hidden="true"><IconChevron /></span><IconEye /><span class="feedback-title">Sent to the model</span><span class="feedback-why">{fb.reason}</span></summary>
            <div class="feedback-body">
                {fb.image ? <ClickableImg src={fb.image} alt={fb.label || "located crop"} /> : null}
                {fb.via === "text" && fb.prompt
                    ? <details class="r-py-sec r-look-prompt-sec"><summary class="r-py-lbl">prompt sent</summary><div class="r-look-prompt">{fb.prompt}</div></details>
                    : null}
                {fb.via === "text" && fb.text
                    ? <div class="feedback-desc">{fb.image ? "The reader's description of the crop (this is the text the model actually received — it can't see the image):" : ""}<div class="feedback-desc-text">{fb.text}</div></div>
                    : null}
            </div>
        </details>
    );
}

// "Reused a grant you approved" — why an approval-gated step auto-ran with no prompt: it re-used a resource
// you already OK'd (a cached ml.fetch URL a read-only exec re-read; an already-approved Google Sheet a
// python_exec reused). Collapsed by default; the summary is deterministic (kind + count), expand for the
// exact items. Generic over `kind` so future grant kinds render here with no layout change.
const REUSED_KIND: Record<string, { noun: string; nounN: string }> = {
    "fetch-url": { noun: "URL", nounN: "URLs" },
    sheet: { noun: "sheet", nounN: "sheets" },
};
export function ReusedBlock({ reused }: { reused: ReusedGrant[] }) {
    // Summarise per-kind (e.g. "2 URLs · 1 sheet") — deterministic, no payload.
    const byKind = new Map<string, ReusedGrant[]>();
    for (const g of reused) { if (!byKind.has(g.kind)) byKind.set(g.kind, []); byKind.get(g.kind)!.push(g); }
    const summary = [...byKind.entries()].map(([k, gs]) => { const n = REUSED_KIND[k]; return `${gs.length} ${gs.length === 1 ? n?.noun || k : n?.nounN || k}`; }).join(" · ");
    return (
        <details class="astep-reused">
            <summary class="reused-head"><span class="tri" aria-hidden="true"><IconChevron /></span><IconCheck /><span class="reused-title">Reused a grant you approved</span><span class="reused-why">{summary} · no prompt needed</span></summary>
            <ul class="reused-list">{reused.map((g, i) => <li key={i}>{g.kind === "sheet" ? <SheetChip id={g.detail} /> : <code>{g.detail}</code>}</li>)}</ul>
        </details>
    );
}
