// Export a session in two shapes, from ONE traversal:
//   • Markdown  — run.md + real PNG sidecars, zipped (a coding assistant can open
//     a .png but can't "see" a base64 blob, so screenshots ship as files).
//   • PDF       — a self-contained printable HTML document rendered into a hidden
//     iframe, then window.print() → the user picks "Save as PDF". Images are
//     inlined (a print doc has nowhere to put sidecars).
// The two differ only in how each piece of the log is written down, so the walk
// over the Session lives in writeAgent/writeChat and emits through a `Sink`
// (markdown ⇄ HTML). Adding a third format means adding a sink, not a walker.
// Includes a tiny dependency-free store-method ZIP writer (PNGs are already
// deflated). Extracted from app.tsx.
import atomOneLight from "highlight.js/styles/atom-one-light.css";
import { sessionMap, turnsRun, config } from "./store";
import type { Session, AgentStep } from "./store";
import { pretty, fullStamp, beautifyJs, escapeHtml, highlight, markdown } from "./format";
import { splitAnswer, hasTokens, resolveTokenStep } from "../answer-tokens";
import { BUILD_INFO } from "../build-info.gen";

// A rough token estimate for a string — the ubiquitous ~4-chars/token heuristic (good enough to gauge how much
// of the context window the system prompt / tool schemas eat; it's labelled ~approx, not exact). Paired with the
// char count so a reader can judge the real cost of both export variants.
const estTokens = (s: string): number => Math.ceil(s.length / 4);
const sizeTag = (s: string): string => `(${s.length.toLocaleString()} chars, ~${estTokens(s).toLocaleString()} tokens)`;
// The build the run's extension was on. `-dirty` when it was built with uncommitted changes (so a bare short
// commit in a log is trustworthy only when it's absent) — the same provenance the agent reads via agent_api_docs.
const buildLabel = (): string => `${BUILD_INFO.shortCommit}${(BUILD_INFO as { dirty?: boolean }).dirty ? "-dirty (uncommitted changes)" : ""} · built ${fullStamp(Date.parse(BUILD_INFO.buildTime))}`;
import { annotatedConfig, resolveModel, shownModel } from "./model";

type Sidecar = { name: string; bytes: Uint8Array };

// --- the sink: the vocabulary the log is written in ------------------------
// Deliberately small and *semantic* (a note, a labelled block, a bit of prose) —
// never "bold this". Each sink then renders those meanings the way its medium
// wants: markdown emits `> _…_`, HTML emits `<p class="note">`.
interface Sink {
    title(text: string): void;                       // the document's one h1
    meta(pairs: [string, string][]): void;           // the header key/value list
    head(text: string): void;                        // section (step / turn / options)
    sub(text: string): void;                         // sub-heading (a locate substep)
    prose(text: string, muted?: boolean): void;      // free text — model/user markdown
    note(text: string, plain?: boolean): void;       // an aside (italic unless `plain`)
    code(text: string, lang?: string): void;         // a code block
    block(label: string, text: string, lang?: string): void;   // "In:" + a code block
    speech(who: string, paren: string | null, text: string, muted?: boolean): void;
    inline(label: string, value: string, opts?: { code?: boolean; muted?: boolean }): void;
    image(src: string, base: string, alt: string): void;       // `base` names the sidecar
    details(summary: string, body: () => void): void;          // collapsed disclosure
    table(columns: string[], rows: (string | number | null)[][]): void;   // a real data table (df preview)
    divider(text: string): void;                     // a labelled section break (a page-transition marker)
}

// Write an answer, resolving any `@tool:<id>` citation to the ACTUAL output of the step it references —
// inlined via the sink's own verbs (a real table/image/code), like the live card does with RenderPanel. A
// hallucinated / unresolvable id → a visible note (never dropped). Then, per the raw-view rule, a collapsed
// disclosure keeps the model's LITERAL answer (links unresolved) recoverable. No tokens → just the prose.
function writeAnswer(text: string, s: Session, d: Sink, muted = false, rawLabel = "Answer"): void {
    const isAlias = (name: string): boolean => (s.steps || []).some((st: AgentStep) => st.tool === name && !!st.token);
    if (!text || !hasTokens(text, isAlias)) { d.prose(text || "(no answer)", muted); return; }
    // Accumulate prose + INLINE (short-scalar / latex) citations into a running paragraph; FLUSH it before a
    // BLOCK citation (a table/image/code) so blocks stand alone while inline values flow in the sentence.
    let buf = "";
    const flush = () => { if (buf.trim()) d.prose(buf); buf = ""; };
    for (const seg of splitAnswer(text, isAlias)) {
        if (seg.kind === "prose") { buf += seg.text; continue; }
        const step = resolveTokenStep(seg.id, s.steps || []) as AgentStep | null;
        if (!step) { buf += ` ⟨unresolved @tool:${seg.id}⟩ `; continue; }
        // LINK form `[label](@tool:…)` — a jump-to-output in the live UI; a static export can't jump, so it
        // renders the label as plain text (the output itself is in the step trace, recoverable). Only the EMBED
        // form `![…]` expands the output here.
        if (!seg.embed) { buf += seg.label && seg.label.trim() ? seg.label.trim() : `@tool:${seg.id}`; continue; }
        const desc = seg.slot === "in" ? step.renderIn : step.renderOut;
        // Clean value of the slot — a python-out scalar's descriptor value, NOT `step.result` (which carries the
        // model-facing prelude). Mirrors the sidebar; keeps the prelude out of an inline value / `| latex` block.
        const raw = seg.slot === "in" ? (step.arguments ? pretty(step.arguments) : "")
            : (desc?.type === "python-out" ? (desc.value ?? desc.stdout ?? step.result ?? "") : (step.result ?? ""));
        if (seg.fmt === "latex" && raw) { buf += ` $${raw}$ `; continue; }   // static export: keep raw math notation
        if (desc && ["image", "look", "table", "code", "python-in", "python-out"].includes(desc.type)) {
            flush(); emitTokenBlock(step, seg.slot, d);
            if (seg.label && seg.label.trim()) d.note(seg.label.trim());   // the model's caption, like a figure caption
            continue;
        }
        if (raw && (raw.length > 80 || /\n/.test(raw))) { flush(); d.code(raw); continue; }   // long → its own block
        buf += "`" + raw + "`";   // short scalar → inline code, flows in the sentence
    }
    flush();
    d.details(`${rawLabel} · raw (as the model wrote it)`, () => d.prose(text));
}

// The bottom-of-answer RESULT block (the run's designated tool outputs) — mirrors the sidebar/HUD
// ResultBlock so the export carries the same deliverable. Only when the finalized answer set has a @tool output.
function writeResult(s: Session, d: Sink): void {
    const isAlias = (name: string): boolean => (s.steps || []).some((st: AgentStep) => st.tool === name && !!st.token);
    if (!s.answer || !hasTokens(s.answer, isAlias)) return;
    d.head("Result");
    writeAnswer(s.answer, s, d, false, "Result");
}

// A BLOCK citation: the cited step's In/Out as a real table / image / code.
function emitTokenBlock(step: AgentStep, slot: "in" | "out", d: Sink): void {
    const desc = slot === "in" ? step.renderIn : step.renderOut;
    const base = `tok-${step.step}`;
    if (desc?.type === "image") { d.image(desc.src, base, desc.label || `step ${step.step}`); return; }
    if (desc?.type === "look") { d.image(desc.image, base, desc.label || "look"); return; }
    if (desc?.type === "table") { d.table(desc.columns, desc.rows); return; }
    if (desc?.type === "code") { d.code(desc.format ? beautifyJs(desc.text) : desc.text, desc.lang || "javascript"); return; }
    if (desc?.type === "python-in") { d.code(desc.code, "python"); return; }   // just the code, not the input table
    if (desc?.type === "python-out" && desc.df) { d.table(desc.df.columns, desc.df.rows); return; }
    if (desc?.type === "python-out" && desc.image) { d.image(desc.image, base, "returned image"); return; }
    // A python-out SCALAR: render the CLEAN structured field (value/stdout), NOT `step.result` — the model-facing
    // result string carries a prelude ("[loaded, reference directly] a … DataFrame → `df`.") meant for the model,
    // which the descriptor's own `value`/`stdout` never contains. Mirrors the sidebar's tokenRender; using the
    // structured field (not a regex on the string) stays correct as more model-facing hints are added over time.
    if (desc?.type === "python-out" && (desc.value != null || desc.stdout != null)) { d.code(desc.value ?? desc.stdout ?? ""); return; }
    const raw = slot === "in" ? (step.arguments ? pretty(step.arguments) : "") : (step.result ?? "");
    if (raw) d.code(raw);
}

// A fenced block whose fence is longer than any backtick run inside it.
function fence(text: string, lang = ""): string {
    let n = 3;
    for (const run of text.match(/`+/g) || []) n = Math.max(n, run.length + 1);
    const f = "`".repeat(n);
    return `${f}${lang}\n${text}\n${f}`;
}

// data:<mime>;base64,<data> → raw bytes + a file extension.
function dataUrlToBytes(url: string): { bytes: Uint8Array; ext: string } | null {
    const m = /^data:([^;,]*)(;base64)?,([\s\S]*)$/.exec(url);
    if (!m) return null;
    const mime = m[1] || "";
    const ext = mime === "image/jpeg" ? "jpg" : mime === "image/webp" ? "webp" : mime === "image/gif" ? "gif" : "png";
    try {
        const bin = m[2] ? atob(m[3]) : decodeURIComponent(m[3]);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        return { bytes, ext };
    } catch { return null; }
}

// --- markdown sink ---------------------------------------------------------
// Screenshots become `images/…` sidecars; a data-URL that won't decode degrades
// to an italic placeholder, so a broken image never breaks the export.
function mdSink() {
    const o: string[] = [];
    const images: Sidecar[] = [];
    const em = (t: string, on?: boolean) => (on ? `_${t}_` : t);
    const sink: Sink = {
        title: (t) => o.push(`# ${t}`, ""),
        meta: (pairs) => { for (const [k, v] of pairs) o.push(`- **${k}:** ${v}`); o.push(""); },
        head: (t) => o.push(`## ${t}`, ""),
        sub: (t) => o.push(`**${t}**`, ""),
        prose: (t, muted) => o.push(em(t, muted), ""),
        note: (t, plain) => o.push(`> ${em(t, !plain)}`, ""),
        code: (t, lang) => o.push(fence(t, lang), ""),
        block: (label, t, lang) => o.push(`**${label}:**`, "", fence(t, lang), ""),
        // `**User:**` (colon inside the bold) vs `**Assistant** (model):` — the
        // model attribution isn't part of the speaker's name.
        speech: (who, paren, t, muted) => o.push(paren ? `**${who}** (${paren}):` : `**${who}:**`, "", em(t, muted), ""),
        inline: (label, v, opts) => o.push(`**${label}:** ${opts?.code ? `\`${v}\`` : em(v, opts?.muted)}`, ""),
        image: (src, base, alt) => {
            const dec = dataUrlToBytes(src);
            if (!dec) { o.push(`_🖼️ ${alt} (image unavailable)_`, ""); return; }
            const name = `images/${base}.${dec.ext}`;
            images.push({ name, bytes: dec.bytes });
            o.push(`![${alt}](${name})`, "");
        },
        details: (summary, body) => { o.push(`<details><summary>${summary}</summary>`, ""); body(); o.push("</details>", ""); },
        table: (columns, rows) => {
            const cols = columns.length ? columns : (rows[0] || []).map((_, i) => String(i));
            const esc = (s: unknown) => (s == null ? "" : String(s)).replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
            const line = (cells: unknown[]) => `| ${cells.map(esc).join(" | ")} |`;
            o.push(line(cols), `| ${cols.map(() => "---").join(" | ")} |`, ...rows.map(r => line(cols.map((_, j) => r[j]))), "");
        },
        divider: (t) => o.push("---", "", `**→ ${t}**`, ""),
    };
    return { sink, done: () => ({ md: o.join("\n"), images }) };
}

// --- HTML sink -------------------------------------------------------------
// Every dynamic string goes through escapeHtml / markdown() / highlight() — all
// three escape — so a hostile thought or tool result can't inject markup into a
// document that renders at the extension's origin. Disclosures are `open`, since
// a collapsed <details> prints as just its summary.
function htmlSink() {
    const o: string[] = [];
    const em = (t: string, on?: boolean) => (on ? `<em class="muted">${escapeHtml(t)}</em>` : escapeHtml(t));
    const pre = (t: string, lang?: string) => `<pre class="code"><code class="hljs">${highlight(t, lang)}</code></pre>`;
    const sink: Sink = {
        title: (t) => o.push(`<h1>${escapeHtml(t)}</h1>`),
        meta: (pairs) => o.push(`<dl class="meta">${pairs.map(([k, v]) => `<dt>${escapeHtml(k)}</dt><dd>${escapeHtml(v)}</dd>`).join("")}</dl>`),
        head: (t) => o.push(`<h2>${escapeHtml(t)}</h2>`),
        sub: (t) => o.push(`<h3>${escapeHtml(t)}</h3>`),
        prose: (t, muted) => o.push(muted ? `<p>${em(t, true)}</p>` : `<div class="md">${markdown(t)}</div>`),
        note: (t, plain) => o.push(`<p class="note">${plain ? escapeHtml(t) : `<em>${escapeHtml(t)}</em>`}</p>`),
        code: (t, lang) => o.push(pre(t, lang)),
        block: (label, t, lang) => o.push(`<p class="lbl">${escapeHtml(label)}:</p>`, pre(t, lang)),
        speech: (who, paren, t, muted) => {
            o.push(`<p class="lbl">${escapeHtml(who)}${paren ? ` <span class="dim">(${escapeHtml(paren)})</span>` : ""}:</p>`);
            sink.prose(t, muted);
        },
        inline: (label, v, opts) => o.push(`<p class="lbl">${escapeHtml(label)}: ${opts?.code ? `<code>${escapeHtml(v)}</code>` : `<span class="val">${em(v, opts?.muted)}</span>`}</p>`),
        image: (src, _base, alt) => o.push(`<img src="${escapeHtml(src)}" alt="${escapeHtml(alt)}">`),
        details: (summary, body) => { o.push(`<details open><summary>${escapeHtml(summary)}</summary>`); body(); o.push("</details>"); },
        table: (columns, rows) => {
            const cols = columns.length ? columns : (rows[0] || []).map((_, i) => String(i));
            const th = `<tr><th class="idx"></th>${cols.map(c => `<th>${escapeHtml(c)}</th>`).join("")}</tr>`;
            const tds = (r: (string | number | null)[]) => cols.map((_, j) => { const c = r[j]; return `<td class="${typeof c === "number" ? "num" : (c == null ? "nan" : "")}">${c == null ? "NaN" : escapeHtml(String(c))}</td>`; }).join("");
            o.push(`<table class="dftable"><thead>${th}</thead><tbody>${rows.map((r, i) => `<tr><td class="idx">${i}</td>${tds(r)}</tr>`).join("")}</tbody></table>`);
        },
        divider: (t) => o.push(`<div class="nav-divider"><span>→ ${escapeHtml(t)}</span></div>`),
    };
    return { sink, done: () => o.join("\n") };
}

// --- the walk (one per session kind), written through a Sink ---------------
function writeAgent(s: Session, d: Sink): void {
    d.title(`Agent run · ${s.model || "default"} · ${s.hash}`);
    d.meta([
        ["Task", s.task || ""],
        ["Started", fullStamp(s.createdTs)],
        ["Finished", fullStamp(s.lastTs)],
        ["Steps", `${turnsRun(s.steps)}${s.maxSteps ? ` / ${s.maxSteps}` : ""}`],
        ["Outcome", s.hitCap ? "stopped (step cap)" : s.status === "err" ? "error" : s.summary != null ? "answered" : "running"],
        // The build this run's extension was on — the SAME commit the agent reads via agent_api_docs, so an
        // exported log is pinnable to a build when reproducing behaviour.
        ["Build", buildLabel()],
    ]);
    // Composer attachments the user pasted with the initial task → PNG sidecars (as the sidebar shows them).
    (s.taskImages || []).forEach((img, j) => d.image(img, `task-img-${j + 1}`, `task image ${j + 1}`));
    const c = s.agentConfig;
    if (c) {
        const lines = [`model: ${s.model || "default"}`, `maxSteps: ${c.maxSteps}`];
        if (c.think != null) lines.push(`think: ${c.think}`);
        if (!c.env) lines.push("env: false");
        if (c.vision != null && c.vision !== true) lines.push(`vision: ${JSON.stringify(c.vision)}`);
        if (c.hints) lines.push(`hints: ${c.hints}`);
        lines.push(`tools (${c.tools.length}): ${c.tools.map(t => t.name + (t.requiresApproval ? " ⚠" : "")).join(", ")}`);
        d.head("Agent options");
        d.code(lines.join("\n"));
        // Annotate the system prompt with what it costs the context window every turn (chars + ~tokens).
        d.details(`System prompt${c.customSystem ? " (custom)" : ""} ${sizeTag(c.system)}`, () => d.code(c.system));
        // The FULL tool definitions (pretty JSON — name/summary/description/parameters, NOT the implementation),
        // gated on the "Include tool definitions in run exports" setting (off by default — ~thousands of tokens).
        // Annotated with the same char/token cost, since the schemas re-send on every turn alongside the prompt.
        if (config.value.exportToolDefs && c.tools.length) {
            const defs = c.tools.map(t => ({
                name: t.name,
                ...(t.summary ? { summary: t.summary } : {}),
                ...(t.requiresApproval ? { requiresApproval: true } : {}),
                ...(t.description ? { description: t.description } : {}),
                ...(t.parameters ? { parameters: t.parameters } : {}),
            }));
            const json = pretty(defs);
            d.details(`Tool definitions (${defs.length}) ${sizeTag(json)}`, () => d.code(json, "json"));
        }
    }
    // Follow-up user prompts (says) + each turn's answer, INTERLEAVED into the step walk by position —
    // otherwise a multi-turn session exports as one flat run with a single final answer, losing the "you
    // asked" / "answered" back-and-forth the sidebar shows. Ordered by step then timestamp (an answer lands
    // before the next turn's prompt at the same step). The LAST answer is the final one (Answer/Stopped).
    const answers = s.answers || [];
    const inter = [
        ...(s.says || []).map((x, j) => ({ pos: x.atStep || 0, ts: x.ts, say: x.text, sayImages: x.images, sayIdx: j })),
        ...answers.map((a, i) => ({ pos: a.atStep || 0, ts: a.ts, answer: a, last: i === answers.length - 1 })),
    ].sort((a, b) => (a.pos - b.pos)
        // At the SAME step (a turn that ran no tool steps keeps the prior step count), TIME is authoritative —
        // ordering answer-before-say by fiat mis-sorted a chat-style reply whose say arrived before it. Fall
        // back to answer-before-say only if the timestamps are identical.
        || (a.ts - b.ts) || ((("say" in a) ? 1 : 0) - (("say" in b) ? 1 : 0)));
    let ii = 0;
    const emitInter = (x: typeof inter[number]) => {
        // "User Asked" (not "you") — the export is shared with the DevTools panel; "you" is HUD-only.
        if ("say" in x) { d.head("User Asked"); (x.sayImages || []).forEach((img, k) => d.image(img, `say-${x.sayIdx}-img-${k + 1}`, `follow-up image ${k + 1}`)); d.prose(x.say || ""); return; }
        const a = x.answer;
        d.head(x.last ? (a.hitCap ? "Stopped (step cap)" : a.cancelled ? "Cancelled" : a.error ? "Error" : "Answer") : "Answered");
        if (a.error) d.prose(a.error);
        else writeAnswer(a.text || "(no answer)", s, d, !a.text);
        if (x.last && !a.error) writeResult(s, d);   // the bottom-of-answer tool outputs, after the latest answer
    };
    const flush = (before: number) => { while (ii < inter.length && inter[ii].pos < before) emitInter(inter[ii++]); };

    for (const st of s.steps || []) {
        flush(st.step || 0);   // any prior-turn answer / follow-up prompt that landed before this step
        // Skip a truly empty step — a usage-only emit (no prose/reasoning/tool, just a token
        // sample). Matches the sidebar's filter; otherwise it serialises a bare "Step N · ?" header.
        if (st.tool == null && !st.thought && !st.reasoning) continue;
        // A no-tool step is a pure prose/reasoning turn: the assistant's `content` (thought) shown
        // as prose, its `reasoning_content` as a collapsible "Thinking" section (like the chat export).
        if (st.tool == null) {
            d.head(`Step ${st.step} · thought`);
            if (st.reasoning) d.details("Thinking", () => d.prose(st.reasoning!));
            if (st.thought) d.prose(st.thought);
            continue;
        }
        d.head(`Step ${st.step} · ${st.tool || "?"}`);
        if (st.approval) d.note(st.approval === "readonly" ? "auto-approved (read-only)" : st.approval === "sandbox" ? "auto-approved (sandboxed python)" : st.approval === "user" ? "approved by user" : st.approval === "skipped" ? "skipped (target didn't resolve — would only fail)" : "denied by user");
        if (st.reasoning) d.details("Thinking", () => d.prose(st.reasoning!));
        if (st.thought) d.prose(st.thought);
        // In: a rendered view (when the tool supplies one) AND — always — the RAW args
        // the model emitted. The sidebar has a rendered⇄raw toggle; a static export can't
        // toggle, so it keeps both (the raw args are the ground truth the LLM produced).
        let renderedIn = false;
        if (st.renderIn && st.renderIn.type === "python-in") {
            // python_exec's notebook-cell In: mode + the input screenshot/table + the source.
            const pin = st.renderIn;
            d.note(`Mode: ${pin.mode}`);
            if (pin.image) d.image(pin.image, `step-${st.step}-in`, `step ${st.step} — input image`);
            for (const t of pin.tables || []) {
                const cols = t.columns?.length || t.rows?.[0]?.length || 0;
                const srcLabel = t.source.kind === "sheet-external" ? `external Google Sheet (${t.source.label}), fetched with your approval`
                    : t.source.kind === "sheet-current" ? `current Google Sheet — ${t.source.label}`
                    : `page table — ${t.source.label}`;
                if (t.rows) {
                    // Collapse the (potentially huge) df into a disclosure so it doesn't flood the
                    // .md — the summary carries the shape + source. `details` is collapsed in markdown
                    // but `<details open>` in the print HTML, so the PDF still shows the table.
                    d.details(`input table → ${t.name} (${t.rows.length} × ${cols}) · ${srcLabel}`, () => d.table(t.columns || [], t.rows!));
                } else {
                    d.note(`input table → ${t.name} · ${srcLabel} (loaded via pd.read_html)`, true);
                }
            }
            d.block("In", pin.code, "python");
            renderedIn = true;
        } else if (st.renderIn && st.renderIn.type === "code") {
            d.block("In", st.renderIn.format ? beautifyJs(st.renderIn.text) : st.renderIn.text, st.renderIn.lang || "javascript");
            renderedIn = true;
        } else if (st.renderIn && st.renderIn.type === "action" && st.renderIn.ask) {
            // fetch `ask` mode: a clean In — the URL, the FULL question, and who answered it + the tokens spent
            // (a static export can't hover the raw toggle, so it shows the distilled meta inline; render-in-both).
            const ri = st.renderIn;
            const lines = [`${ri.verb}${ri.target ? " " + ri.target : ""}${ri.note ? " · " + ri.note : ""}`, `Asked: ${ri.ask}`];
            if (ri.answeredBy) lines.push(`Answered by ${ri.answeredBy}${ri.tokens ? ` · ${ri.tokens.toLocaleString()} tokens` : ""}`);
            d.block("In", lines.join("\n"));
            // The in-the-middle step: the RAW content the reader saw. Collapsed (it can be large) — a disclosure,
            // like the python input table, so the .md stays readable but the PDF (<details open>) still shows it.
            if (ri.askBody) d.details(`content read by the model${ri.askBodyTruncated ? " (truncated)" : ""} · ${ri.askBody.length.toLocaleString()} chars`, () => d.code(ri.askBody!, ri.askBodyLang || "text"));
            if (ri.pipe) d.block("Piped through", ri.pipe, "bash");
            renderedIn = true;
        } else if (st.renderIn && st.renderIn.type === "action" && st.renderIn.pipe) {
            // fetch_url `pipe` (no ask): show the URL + the shell pipeline as a `bash` block, matching the sidebar.
            const ri = st.renderIn;
            d.block("In", `${ri.verb}${ri.target ? " " + ri.target : ""}`);
            d.block("Piped through", ri.pipe!, "bash");
            renderedIn = true;
        } else if (!st.renderIn && st.tool === "exec" && typeof st.arguments?.js === "string") {
            d.block("In", beautifyJs(st.arguments.js), "javascript");
            renderedIn = true;
        }
        if (st.arguments && Object.keys(st.arguments).length) {
            if (renderedIn) d.details("In · raw args (as sent by the model)", () => d.code(pretty(st.arguments), "json"));
            else d.block("In", pretty(st.arguments), "json");
        }
        if (st.argIssues && st.argIssues.length) d.note(`⚠ arg issues: ${st.argIssues.join("; ")}`, true);
        if (st.renderOut && st.renderOut.type === "image") {
            const label = st.renderOut.label ? ` — ${st.renderOut.label}` : "";
            d.image(st.renderOut.src, `step-${st.step}`, `step ${st.step}${label}`);
        } else if (st.renderOut && st.renderOut.type === "locate") {
            // The full locate debug view as substeps, mirroring the sidebar's render.
            const r = st.renderOut;
            // Flag a sub-call that ran on the SAME model as the driver — it was still
            // standalone (image + reply not in the driver's context).
            const delegated = r.model && r.model === s.model ? " · standalone sub-call (not in the agent's context)" : "";
            d.note(`${r.mode === "grounding" ? "Grounding" : r.mode === "grid-grounding" ? "Grid → Grounding" : r.mode === "grid" ? "Grid" : "Set-of-Marks"} · ${r.model}${delegated}`);
            r.substeps.forEach((sub, i) => {
                if (sub.note) d.note(sub.note);
                d.sub(`${i + 1} · ${sub.label}`);
                if (sub.prompt) d.details("In (prompt)", () => d.code(sub.prompt!));
                if (sub.image) d.image(sub.image, `step-${st.step}-sub${i + 1}`, `step ${st.step} sub-step ${i + 1}`);
                // The exact image sent to the model (raw), when it differs from the overlay.
                if (sub.rawImage && sub.rawImage !== sub.image)
                    d.details("raw (image sent to the model)", () => d.image(sub.rawImage!, `step-${st.step}-sub${i + 1}-raw`, `step ${st.step} sub-step ${i + 1} raw`));
                // Out: inline for a short, backtick-free one-liner; otherwise a block
                // (multi-line / long / contains backticks). The markdown sink sizes its
                // fence longer than any backtick run inside, so raw model output is
                // preserved verbatim — never stripped — which is the whole point of
                // showing Out in a debug view.
                if (sub.output != null && sub.output !== "") {
                    if (/[\n`]/.test(sub.output) || sub.output.length > 80) d.block("Out", sub.output);
                    else d.inline("Out", sub.output, { code: true });
                }
            });
            d.inline(r.pickedBy === "model" ? "Model picked" : "Snapped to", r.picked || "(none)", { muted: !r.picked });
        } else if (st.renderOut && st.renderOut.type === "python-out" && st.renderOut.image) {
            // A to_base64 image return — the stdout/value live in the result block below.
            d.image(st.renderOut.image, `step-${st.step}`, `step ${st.step} — returned image`);
        } else if (st.renderOut && st.renderOut.type === "python-out" && st.renderOut.df) {
            // A returned DataFrame → a real table (GFM / <table>), like the input-table render.
            const df = st.renderOut.df;   // local: TS drops the narrowing inside the closure otherwise
            d.details("value (DataFrame)", () => d.table(df.columns, df.rows));
        } else if (st.renderOut && st.renderOut.type === "look") {
            // A delegated look: the image the reader saw + which model + its output.
            const lk = st.renderOut;   // local: TS widens st.renderOut back to the union inside the closure
            d.image(lk.image, `step-${st.step}`, `step ${st.step} — ${lk.label || "look"} · viewed by ${lk.model || "default"}`);
            if (lk.prompt) d.details("prompt sent", () => d.prose(lk.prompt as string));
            if (lk.output) d.prose(lk.output);
        }
        if (st.result != null && st.result !== "") d.block("Out", st.result);
        else if (st.elements != null) d.inline("Out", `${st.elements} element(s)`);
        // The AGENTS raw-view rule: when the model was fed MORE than the clean Out (an appended `@tool:<id>`
        // token line), the exact text it saw must stay recoverable — a collapsed disclosure beside the clean Out.
        if (st.modelResult && st.modelResult !== st.result) d.details("Out · raw (as the model saw it)", () => d.block("", st.modelResult!));
        // What the tool fed straight INTO the model's context (locate's snap-inject) — a marked crop the
        // model SAW, or a delegated description it received. A static export can't toggle, so show both the
        // reason and the payload.
        if (st.feedback) {
            d.note(`Sent to the model (${st.feedback.reason})`);
            if (st.feedback.image) d.image(st.feedback.image, `step-${st.step}-feedback`, `step ${st.step} — sent to the model`);
            if (st.feedback.via === "text" && st.feedback.prompt) d.details("prompt sent", () => d.prose(st.feedback!.prompt as string));
            if (st.feedback.via === "text" && st.feedback.text) d.block("Description sent to the model", st.feedback.text);
        }
        // A page-transition marker after a SUCCESSFUL navigate step — the same run-log divider the sidebar
        // draws, so a run spanning pages reads the same in the export (skip a denied/errored nav — no change).
        if (st.tool === "navigate" && st.approval !== "denied" && st.result && !st.result.startsWith("Error")) {
            const url = (st.renderIn && st.renderIn.type === "action" && st.renderIn.target) || (typeof st.arguments?.url === "string" ? st.arguments.url : "");
            if (url) d.divider(`navigated to ${url} · session resumed`);
        }
    }
    flush(Infinity);   // trailing answer(s) + any follow-up prompt that landed after the last step
    // No per-turn answers recorded (a run still in flight, or an older session) → the single-answer tail.
    if (answers.length === 0) {
        d.head(s.hitCap ? "Stopped (step cap)" : "Answer");
        writeAnswer(s.summary || "(no answer — run did not complete)", s, d, !s.summary);
        writeResult(s, d);
    }
}

function writeChat(s: Session, d: Sink): void {
    d.title(`Chat · ${shownModel(s)} · ${s.hash}`);
    const meta: [string, string][] = [];
    if (s.title) meta.push(["Title", s.title]);
    meta.push(["Started", fullStamp(s.createdTs)], ["Last activity", fullStamp(s.lastTs)], ["Type", s.tag]);
    meta.push(["Build", buildLabel()]);
    d.meta(meta);
    d.head("Options");
    d.code(annotatedConfig(s.config), "javascript");
    s.turns.forEach((t, i) => {
        d.head(`Turn ${i + 1} · ${fullStamp(t.ts)}`);
        d.speech("User", null, t.user || "");
        (t.images || []).forEach((img, j) => d.image(img, `turn-${i + 1}-img-${j + 1}`, `turn ${i + 1} image ${j + 1}`));
        if (t.reasoning) d.details("Thinking", () => d.prose(t.reasoning!));
        if (t.status === "err") d.inline("Error", t.error || "(unknown)");
        else d.speech("Assistant", t.model || resolveModel(t.reqModel, t.extend), t.assistant || "(no reply)", !t.assistant);
        if (t.sources && t.sources.length) d.block(`Sources (${t.sources.length})`, pretty(t.sources), "json");
    });
}

const writeSession = (s: Session, d: Sink): void => (s.kind === "agent" ? writeAgent(s, d) : writeChat(s, d));

// Serialise a session to `{ md, images }` — the markdown references each image as
// `images/…`, and the bytes ride alongside as sidecars for the zip.
export function serializeSession(s: Session): { md: string; images: Sidecar[] } {
    const { sink, done } = mdSink();
    writeSession(s, sink);
    const { md, images } = done();
    return { md: md + "\n", images };
}

// --- printable document ----------------------------------------------------
// Standalone, self-contained (inline CSS, inline images) and light-themed — it's
// headed for paper/PDF, not the sidebar's dark panel. `@page` + the break rules
// are the whole reason this isn't just the sidebar's stylesheet: a screenshot or
// a code block split across a page boundary is unreadable.
const PRINT_CSS = `
@page { margin: 14mm; }
* { box-sizing: border-box; }
body { margin: 0; color: #18181b; background: #fff;
  font: 11pt/1.55 system-ui, -apple-system, "Segoe UI", sans-serif; }
.doc { max-width: 190mm; margin: 0 auto; padding: 8mm 0; }
h1 { font-size: 1.5em; margin: 0 0 .5em; }
h2 { font-size: 1.15em; margin: 1.5em 0 .4em; padding-top: .35em; border-top: 1px solid #d4d4d8; }
.nav-divider { display: flex; align-items: center; gap: 10px; margin: 14px 0; color: #71717a; font-size: .85em; break-inside: avoid; }
.nav-divider::before, .nav-divider::after { content: ""; flex: 1; height: 1px; background: #d4d4d8; }
.nav-divider span { flex: 0 0 auto; }
h3 { font-size: 1em; margin: 1.1em 0 .3em; color: #3f3f46; }
h1, h2, h3, .lbl, summary { break-after: avoid; }
p { margin: 0 0 .5em; }
dl.meta { margin: 0 0 1em; display: grid; grid-template-columns: max-content 1fr; gap: 2px 10px; }
dl.meta dt { color: #52525b; font-weight: 600; }
dl.meta dd { margin: 0; }
.lbl { margin: .8em 0 .25em; font-weight: 600; color: #3f3f46; }
.lbl .dim { font-weight: 400; color: #71717a; }
.note { margin: .4em 0; padding: .3em .6em; border-left: 3px solid #a1a1aa;
  background: #f4f4f5; color: #3f3f46; break-inside: avoid; }
.muted { color: #71717a; }
img { max-width: 100%; height: auto; margin: .4em 0; border: 1px solid #d4d4d8;
  border-radius: 3px; break-inside: avoid; }
code, pre { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
pre.code { margin: .3em 0 .7em; padding: .6em .7em; background: #f4f4f5; border: 1px solid #e4e4e7;
  border-radius: 4px; font-size: .85em; line-height: 1.45;
  white-space: pre-wrap; word-break: break-word; break-inside: avoid; }
:not(pre) > code { background: #f4f4f5; border-radius: 3px; padding: 0 3px; font-size: .9em; }
details { margin: .3em 0 .6em; }
summary { color: #52525b; cursor: default; }
.md > :first-child { margin-top: 0; }
.md ul { margin: .3em 0; padding-left: 1.2em; list-style: disc; }
.md ol { margin: .3em 0; padding-left: 1.4em; list-style: decimal; }
.md ul ul, .md ol ol, .md ul ol, .md ol ul { margin: 0; }
.md hr { border: none; border-top: 1px solid #ddd; margin: .8em 0; }
/* python_exec df preview — a real table (all rows), zebra + numeric alignment; rows may span pages. */
table.dftable { border-collapse: collapse; margin: .3em 0 .8em; font-size: .82em; }
table.dftable th, table.dftable td { border: 1px solid #d4d4d8; padding: 2px 8px; text-align: left; white-space: nowrap; }
table.dftable thead th { background: #f4f4f5; color: #3f3f46; font-weight: 600; }
table.dftable tbody tr:nth-child(even) { background: #fafafa; }
table.dftable td.num { text-align: right; font-variant-numeric: tabular-nums; font-family: ui-monospace, monospace; }
table.dftable td.nan { color: #a1a1aa; font-style: italic; }
table.dftable .idx { color: #a1a1aa; text-align: right; font-family: ui-monospace, monospace; background: #fafafa; }
table.dftable thead tr { break-inside: avoid; }
.md a { color: #4338ca; }
table { border-collapse: collapse; }
/* Long unbroken tokens (selectors, data URLs) must wrap, not overflow the page. */
.doc { overflow-wrap: break-word; }
`;

// A full standalone HTML document for the session. The <title> matters: Chrome
// seeds the "Save as PDF" filename from it.
export function sessionToHtml(s: Session, docTitle: string): string {
    const { sink, done } = htmlSink();
    writeSession(s, sink);
    return `<!doctype html>
<html><head><meta charset="utf-8"><title>${escapeHtml(docTitle)}</title>
<style>${atomOneLight}</style>
<style>${PRINT_CSS}</style>
</head><body><div class="doc">
${done()}
</div></body></html>`;
}

// --- minimal ZIP writer (store / no compression — PNGs are already deflated,
// so re-compressing is pointless; store keeps this dependency-free) -----------
const CRC_TABLE = /* @__PURE__ */ (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
        t[n] = c >>> 0;
    }
    return t;
})();
function crc32(bytes: Uint8Array): number {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
}
function zipStore(files: Sidecar[]): Blob {
    const enc = new TextEncoder();
    const u16 = (n: number) => [n & 0xFF, (n >>> 8) & 0xFF];
    const u32 = (n: number) => [n & 0xFF, (n >>> 8) & 0xFF, (n >>> 16) & 0xFF, (n >>> 24) & 0xFF];
    const parts: Uint8Array[] = [];
    const central: number[] = [];
    let offset = 0;
    for (const f of files) {
        const name = enc.encode(f.name);
        const crc = crc32(f.bytes), size = f.bytes.length;
        const header = [
            ...u32(0x04034b50), ...u16(20), ...u16(0), ...u16(0), ...u16(0), ...u16(0),
            ...u32(crc), ...u32(size), ...u32(size), ...u16(name.length), ...u16(0), ...name,
        ];
        parts.push(new Uint8Array(header), f.bytes);
        central.push(
            ...u32(0x02014b50), ...u16(20), ...u16(20), ...u16(0), ...u16(0), ...u16(0), ...u16(0),
            ...u32(crc), ...u32(size), ...u32(size), ...u16(name.length), ...u16(0), ...u16(0),
            ...u16(0), ...u16(0), ...u32(0), ...u32(offset), ...name,
        );
        offset += header.length + size;
    }
    const end = [
        ...u32(0x06054b50), ...u16(0), ...u16(0), ...u16(files.length), ...u16(files.length),
        ...u32(central.length), ...u32(offset), ...u16(0),
    ];
    parts.push(new Uint8Array(central), new Uint8Array(end));
    return new Blob(parts as BlobPart[], { type: "application/zip" });
}

// Trigger a client-side download (the iframe can't touch the filesystem).
function downloadBlob(name: string, blob: Blob): void {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = name;
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
}

const baseName = (s: Session): string => `ml-${s.kind === "agent" ? "agent" : "chat"}-${s.hash}`;

export function exportSession(hash: string): void {
    const s = sessionMap.get(hash);
    if (!s) return;
    const base = baseName(s);
    const { md, images } = serializeSession(s);
    if (!images.length) { downloadBlob(`${base}.md`, new Blob([md], { type: "text/markdown" })); return; }
    downloadBlob(`${base}.zip`, zipStore([{ name: "run.md", bytes: new TextEncoder().encode(md) }, ...images]));
}

// Print the session → the user chooses "Save as PDF" (or a real printer). We
// render into an offscreen iframe rather than printing the sidebar itself: the
// panel is a narrow dark scroll-box with collapsed disclosures, none of which
// belongs on paper. The doc is loaded from a Blob URL (a multi-megabyte srcdoc
// attribute of inlined screenshots is wasteful) — same-origin, so we can reach
// contentWindow.print(). Chrome's print() blocks until the dialog closes, but we
// clean up on `afterprint` (plus a long fallback) so a dismissed dialog can't
// leak the frame either way.
const PRINT_CLEANUP_MS = 120_000;
export function printSession(hash: string): void {
    const s = sessionMap.get(hash);
    if (!s) return;
    const html = sessionToHtml(s, baseName(s));
    // Print from a REAL browser tab via the background, NOT this app's own frame: window.print() is
    // suppressed for a frame inside DOCKED DevTools (the panel surface), so PDF export silently did nothing
    // there (markdown export worked — it downloads via <a download>). chrome.runtime.sendMessage reaches the
    // background from BOTH surfaces, so no surface detection is needed; the background opens print.html in a
    // normal tab that renders + prints + closes itself. Fall back to the in-frame print only if the runtime
    // channel is unavailable (e.g. a degraded/test context).
    if (typeof chrome !== "undefined" && chrome.runtime?.sendMessage) {
        try { chrome.runtime.sendMessage({ type: "PRINT_SESSION", payload: { html } }); return; }
        catch { /* fall through to the in-frame print */ }
    }
    printInFrame(html);
}
// The legacy in-frame print — render the doc into an offscreen iframe and print it. Works in the in-page
// overlay and an UNDOCKED DevTools window; kept as a fallback for when the background channel is absent.
function printInFrame(html: string): void {
    const url = URL.createObjectURL(new Blob([html], { type: "text/html" }));
    const frame = document.createElement("iframe");
    frame.className = "printframe";
    frame.setAttribute("aria-hidden", "true");
    let cleaned = false;
    const cleanup = () => {
        if (cleaned) return;
        cleaned = true;
        frame.remove();
        URL.revokeObjectURL(url);
    };
    frame.onload = () => {
        const w = frame.contentWindow;
        if (!w) { cleanup(); return; }
        setTimeout(cleanup, PRINT_CLEANUP_MS);
        w.addEventListener("afterprint", cleanup);
        try { w.focus(); w.print(); } catch { cleanup(); }
    };
    frame.src = url;
    document.body.append(frame);
}
