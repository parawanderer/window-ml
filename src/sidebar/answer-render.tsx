// Answer + @tool-citation rendering — the agent's final answer with its `@tool` citations resolved to the
// actual (focused) tool output, the provenance jump (click a citation → its source step, pulsed green), and
// the bottom-of-answer Result / Feedback / Reused blocks. Extracted from app.tsx; sits above ./render-panel.
import type { ComponentChildren } from "preact";
import { h } from "preact";
import type { RenderDescriptor, ToolFeedback, ReusedGrant } from "../contract";
import { splitAnswer, hasTokens, resolveTokenStep, answerWithoutShown } from "../answer-tokens";
import type { AnswerSegment } from "../answer-tokens";
import type { Session, AgentStep } from "./store";
import { cardShowWorkHash, revealSeq } from "./store";
import { pretty, markdown, inlineMarkdown } from "./format";
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
    // Opening the step is done by pressing its OWN opener, once, rather than through a signal the row reads:
    // subscribing a step to a signal that changes on click re-rendered the answer subtree around it and left
    // a citation without its run, which threw from inside the very click meant to navigate. Borrowing the
    // affordance also means this cannot desync from what the toggle means.
    const pulse = (el: Element): void => {
        el.classList.add("astep-pulse");
        setTimeout(() => el.classList.remove("astep-pulse"), 1400);
    };
    const doScroll = (): boolean => {
        const found = document.querySelector(`[data-astep-seq="${seq}"]`);
        if (!found) return false;
        // OPEN it FIRST, if it is collapsed. Scrolling to a row that merely pulses shows you where the step
        // is and not what it was, which is the thing you clicked for.
        //
        // Pressing the row's own opener rather than reading a signal inside the row: subscribing a step to a
        // signal that changes on click re-rendered the answer subtree around it and left a citation without
        // its run, which threw from inside the very click meant to navigate. Borrowing the affordance also
        // means this cannot desync from what the toggle means.
        //
        // Before the pulse, not after, because the toggle re-renders the row and Preact rewrites an
        // element's class list from its own vdom when it does — a class added first is wiped by it. The
        // element is then RE-QUERIED for the same reason: the node that comes back need not be the one we
        // pressed.
        const collapsed = !found.classList.contains("open");
        if (collapsed) (found.querySelector(".astep-head") as HTMLElement | null)?.click();
        const el = document.querySelector(`[data-astep-seq="${seq}"]`) ?? found;
        el.scrollIntoView({ block: "center", behavior: "smooth" });
        pulse(el);
        // The toggle's re-render lands in a microtask and rewrites the row's class list from its own vdom,
        // wiping the pulse we just added. So re-apply it on a MACROTASK, which runs after that — and
        // re-query, because the node that comes back need not be the one we pressed.
        if (collapsed) setTimeout(() => {
            const again = document.querySelector(`[data-astep-seq="${seq}"]`);
            if (again && !again.classList.contains("astep-pulse")) pulse(again);
        }, 0);
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
function TokenRef({ seg, run, scope, standalone }: { seg: Extract<AnswerSegment, { kind: "token" }>; run: Session; scope?: readonly AgentStep[]; standalone?: boolean }) {
    // Exact hex → the WHOLE run (a hex anchors a specific step in ANY turn); a tool-name alias → `scope` (this
    // turn's steps) so it doesn't drift to a later call. Passing scope as run.steps here was the bug that made a
    // prior turn's hex citation show "unresolved" in the per-turn-scoped surfaces (the DevTools reply).
    const step = resolveTokenStep(seg.id, run.steps ?? [], scope) as AgentStep | null;
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
    // A python_exec that returned a sympy expression auto-flags `latex` on the descriptor (python-runtime
    // detected the type), so a plain `:out` citation typesets WITHOUT a `| latex` cast. An explicit fmt wins.
    const autoLatex = !seg.fmt && d?.type === "python-out" && !!d.latex;
    const isLatex = (seg.fmt === "latex" || autoLatex) && !!rawText;
    const isRaw = seg.fmt === "raw" && !!rawText;   // `| raw` — force the literal value, no table/image/latex render
    // `| img` — render the tool's OWN image output (the descriptor's captured image, else a data:/base64 value).
    // An external http(s) URL is deliberately NOT turned into an <img> (that would beacon the viewer); it falls
    // through to the normal render. So `| img` only ever shows extension-produced pixels.
    const descImg = d?.type === "image" ? d.src : (d?.type === "python-out" || d?.type === "look") ? d.image : undefined;
    const imgSrc = seg.fmt === "img" ? (descImg || dataImageFrom(rawText)) : null;
    // `| raw` follows the same inline/block heuristic as a plain value: a STANDALONE (own-line) or long/multiline
    // value is a code BLOCK; a short mid-sentence one stays inline `<code>` (so `the result is ![v](…|raw).` flows
    // in the sentence instead of breaking to a boxed block).
    const rawBlock = !!standalone || rawText.length > 80 || /\n/.test(rawText);
    const { node, block } = imgSrc
        ? { node: <ClickableImg src={imgSrc} alt={label || "image"} />, block: true }
        : isRaw
            ? { node: rawBlock ? <Code text={rawText} lang="text" /> : <code class="tok-val">{rawText}</code>, block: rawBlock }
            : isLatex
                // Use EXPLICIT delimiters, not `$…$` — single-`$` inline math only typesets when the content
                // carries a math signal, so a bare value like `5` would render as the literal text "$5$". The
                // model's POSITION is the intent: a citation ALONE on its own line/paragraph is a standalone
                // formula → a green tool-output BLOCK in DISPLAY mode (`\[…\]`, centered, full-size); one written
                // mid-sentence stays INLINE (`\(…\)`). Use inlineMarkdown so the lone wrapping <p> is STRIPPED —
                // that block-level <p> was forcing an inline formula onto its own line (the "inline is broken" bug).
                ? { node: <span dangerouslySetInnerHTML={{ __html: inlineMarkdown(standalone ? `\\[${rawText}\\]` : `\\(${rawText}\\)`) }} />, block: !!standalone }
                : tokenRender(d, rawText);
    const tip = (label && !block ? `${label} · ` : "") + provenance;   // inline → prepend the label to the tooltip
    return <span class={`tok-ref ${block ? "tok-block" : "tok-inline"}`} role="button" tabIndex={0}
        onClick={jump} onKeyDown={(e) => { if (e.key === "Enter") jump(); }}>
        {node}
        {/* The caption is model-authored prose — render it as markdown+math (a lone wrapping <p> stripped) so a
            model that writes inline `$…$`/`\(…\)` in the label typesets it. markdown() escapes HTML, so this is
            as safe as the answer prose. */}
        {block && label ? <div class="tok-anno" dangerouslySetInnerHTML={{ __html: inlineMarkdown(label) }} /> : null}
        <span class="tok-tip" role="tooltip">{tip}</span>
    </span>;
}

// The agent's final ANSWER, with @tool citations RESOLVED to the actual (focused) tool output inline. NO toggle
// — the HUD is a minimal surface; the raw markdown stays available in the DevTools bubble's [raw] and the
// export's disclosure. No tokens → plain markdown.
export function AnswerBody({ text, run, cls = "card-answer", scope }: { text: string; run: Session; cls?: string; scope?: readonly AgentStep[] }) {
    const mdHtml = (t: string) => ({ __html: markdown(t, { math: true }) });
    if (!hasTokens(text, aliasOf(run))) return <div class={`${cls} md`} dangerouslySetInnerHTML={mdHtml(text)} />;
    const segs = splitAnswer(text, aliasOf(run));
    // A citation is STANDALONE (a display block) when it sits ALONE on its own source line — only whitespace
    // between it and a newline/boundary on each side. A citation that SHARES its line with prose
    // (`the result is ![x].`, or a list item `- foo ![x].`) is mid-sentence → INLINE. This mirrors exactly what
    // the line-based markdown() does with the token below: an own-line token becomes the sole child of its own
    // <p> (block); a token sharing a line flows inside that line's <p>/<li> (inline). No blank-line heuristic —
    // the model's line placement IS the intent ("on its own line → block; in a sentence → inline").
    const standaloneAt = (i: number): boolean => {
        const prev = i === 0 ? "" : (segs[i - 1].kind === "prose" ? (segs[i - 1] as { text: string }).text : null);
        const next = i === segs.length - 1 ? "" : (segs[i + 1].kind === "prose" ? (segs[i + 1] as { text: string }).text : null);
        const aloneBefore = prev === "" || (prev != null && /\n[ \t]*$/.test(prev));
        const aloneAfter = next === "" || (next != null && /^[ \t]*\n/.test(next));
        return aloneBefore && aloneAfter;
    };
    // ONE markdown pass over the whole answer, tokens spliced back in as real components. Each token is
    // replaced in the source by a private-use SENTINEL that survives markdown escaping (it's not `&<>`); we then
    // render, parse the HTML, and walk only the subtrees that contain a sentinel — so a list / blockquote /
    // paragraph that CONTAINS a citation stays intact (the old split-per-fragment approach rendered each prose
    // run as its OWN markdown block, which closed a list before the token and orphaned the trailing text).
    const toks: { seg: Extract<AnswerSegment, { kind: "token" }>; standalone: boolean }[] = [];
    let src = "";
    segs.forEach((seg, i) => {
        if (seg.kind === "prose") { src += seg.text; return; }
        toks.push({ seg, standalone: standaloneAt(i) });
        src += `${toks.length - 1}`;
    });
    return <div class={`${cls} md answer-rendered`}>{hydrateAnswer(markdown(src, { math: true }), toks, run, scope)}</div>;
}

// Splice real <TokenRef> components into rendered answer markdown at the sentinel positions its tokens left
// behind. Parses the HTML into a template and walks it: a TEXT node is split on any sentinels into
// text-run + <TokenRef> pieces; an ELEMENT with NO sentinel anywhere below is kept as raw innerHTML (cheap, and
// preserves KaTeX / nested markup verbatim); an element that DOES contain one is recreated as a vnode with its
// children walked. Because a <TokenRef> is always a <span>, splicing it inside a <p>/<li> is valid nesting.
// The parsed HTML is our OWN markdown() output (user content already escaped), so recreating tags + copying
// attributes introduces no injection surface.
const SENTINEL_RE = /(\d+)/g;
function hydrateAnswer(html: string, toks: { seg: Extract<AnswerSegment, { kind: "token" }>; standalone: boolean }[], run: Session, scope?: readonly AgentStep[]): ComponentChildren {
    const tmpl = document.createElement("template");
    tmpl.innerHTML = html;
    let key = 0;
    const conv = (node: Node): ComponentChildren => {
        if (node.nodeType === 3) {   // text — cut out any sentinels, replacing each with its TokenRef
            const text = node.nodeValue ?? "";
            if (!text.includes("")) return text;
            const out: ComponentChildren[] = [];
            let last = 0; let m: RegExpExecArray | null; SENTINEL_RE.lastIndex = 0;
            while ((m = SENTINEL_RE.exec(text))) {
                if (m.index > last) out.push(text.slice(last, m.index));
                const t = toks[Number(m[1])];
                if (t) out.push(<TokenRef key={key++} seg={t.seg} run={run} scope={scope} standalone={t.standalone} />);
                last = m.index + m[0].length;
            }
            if (last < text.length) out.push(text.slice(last));
            return out;
        }
        if (node.nodeType !== 1) return null;
        const el = node as Element;
        const props: Record<string, unknown> = { key: key++ };
        for (const a of Array.from(el.attributes)) props[a.name] = a.value;
        // No token below → keep the whole subtree as raw HTML (preserves KaTeX etc. without re-vnoding it).
        if (!(el.textContent || "").includes("")) { props.dangerouslySetInnerHTML = { __html: el.innerHTML }; return h(el.tagName.toLowerCase(), props); }
        return h(el.tagName.toLowerCase(), props, Array.from(el.childNodes).map(conv));
    };
    return Array.from(tmpl.content.childNodes).map(conv);
}

// The bottom-of-answer RESULT block: the run's designated (ml.answer) + auto-appended tool outputs, rendered
// UNDER the model's prose reply. Shared by the HUD completion card AND the DevTools/sidebar reply bubble so the
// two stay in parity (same "one render, both surfaces" rule as everything else). Only shows when the answer set
// carries a @tool OUTPUT (a table/image/value the prose can't render) — a text-only set would just echo the prose.
// The label is chrome (muted + uppercase), so it reads as an extension-added section, not the model's own words.
export function ResultBlock({ run, shownIn }: { run: Session; shownIn?: string }) {
    if (!run.answer) return null;
    // Anything the model already QUOTED inline must not also be appended here. It routinely does both —
    // embeds the table mid-sentence and calls `answer` with the same output — and the result was the table
    // rendered twice. Identity is the resolved STEP, so a hex citation inline and a tool-name alias in the
    // answer set are recognised as the same output.
    const alias = aliasOf(run);
    const md = shownIn
        ? answerWithoutShown(run.answer, shownIn, (id) => resolveTokenStep(id, run.steps || []), alias)
        : run.answer;
    if (!hasTokens(md, alias)) return null;
    return <div class="card-result"><div class="result-label">Result</div><AnswerBody text={md} run={run} /></div>;
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
