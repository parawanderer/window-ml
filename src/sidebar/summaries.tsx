// Utility-model summaries + code/intent helpers — the plain-English glosses shown above an approval's
// code or intent (ApprovalBody) and the on-demand "Explain this code" button in the Show-work trace
// (ToolStep). Extracted from app.tsx so both the HUD-card and the agent-detail views can share it
// without a cycle. Depends only on store / ui-kit / format.
import { config, rev, noteAside } from "./store";
import type { AgentStep } from "./store";
import { stepKey } from "./ui-kit";
import { truncate } from "./format";
import { NOTES_SCHEMA, notesMessages, parseNotes, type LineNote } from "./annotate";

// Utility-model auto-summaries (card title, code/action approval summaries) are gated on BOTH a
// configured utility model AND the "summarise with the utility model" toggle (config.autoTitles).
export const utilitySummariesOn = () => config.value.autoTitles && !!config.value.utilityModel.trim();

// Plain-English summary of a CODE approval's snippet, via the utility model — so the human reads "sums
// every quarter and finds the top rep" ABOVE the actual code (which still shows, as the consent
// surface). Keyed per step; opt-in on a utility model, best-effort (the code alone suffices without).
export const codeSummaries = new Map<string, string>();
/** Steps we have already asked the utility model to gloss — one attempt each, success or not, so a
 *  refusal is not retried on every render. */
export const codeSummaryTried = new Set<string>();
// The actual fetch — needs only a utility model (used directly by the on-demand "Explain" button in the
// Show-work trace, which the user explicitly clicked, so it isn't gated on the auto-summarise toggle).
// `output` (present only in the Show-work trace, where the code has ALREADY run) lets the gloss describe
// what it actually DID/found, not just what it would do — the approval-card path passes none (pre-run).
export function fetchCodeSummary(hash: string, seq: number, lang: string, code: string, output?: string): void {
    if (!config.value.utilityModel.trim() || !code.trim()) return;
    const key = stepKey(hash, seq);
    if (codeSummaryTried.has(key)) return;
    codeSummaryTried.add(key);
    const messages = output && output.trim()
        ? [
            { role: "system", content: "You explain what a code snippet DID in ONE plain-English sentence (≤ 22 words) for a non-programmer, USING its output to say what it found/produced. State the effect and the result. No preamble, no code, no restating the language." },
            { role: "user", content: `Explain what this ${lang} code did.\n\nCode:\n${truncate(code, 1200)}\n\nOutput:\n${truncate(output, 400)}` },
        ]
        : [
            { role: "system", content: "You explain what a code snippet DOES in ONE plain-English sentence (≤ 22 words) for a non-programmer about to approve running it. State the effect and any data it touches. No preamble, no code, no restating the language." },
            { role: "user", content: `Explain what this ${lang} code does:\n\n${truncate(code, 1400)}` },
        ];
    fetchUtilityLine(messages, key);
}
// AUTO path (the approval card's gloss) — additionally gated on the auto-summarise toggle.
export function ensureCodeSummary(hash: string, seq: number, lang: string, code: string): void {
    if (utilitySummariesOn()) fetchCodeSummary(hash, seq, lang, code);
}
// The on-demand "Explain this Python/JS" affordance in the Show-work trace (card surface only). Lazy —
// ONE utility-model call, only when clicked; shows the gloss inline once it lands.
export function CodeExplain({ hash, seq, lang, code, result }: { hash: string; seq: number; lang: string; code: string; result?: string }) {
    const rv = rev.value;   // subscribe: the gloss lands on a rev bump (ToolStep is signal-memoized → won't); retained via data-rev
    const summary = codeSummaries.get(stepKey(hash, seq));
    if (summary) return <div class="step-explain ml-reveal" data-rev={rv}><span class="step-explain-ic" aria-hidden="true">💡</span><span>{summary}</span></div>;
    if (!code.trim()) return null;
    return <button class="step-explain-btn" data-rev={rv} onClick={() => fetchCodeSummary(hash, seq, lang, code, result)}>💡 Explain this {lang === "python" ? "Python" : "JavaScript"}</button>;
}
// ---------------------------------------------------------------- line notes
// The "Explain" affordance on a rendered code block: a utility model annotates the interesting LINES and
// the panel draws each note in the margin beside its line (never inserted — see annotate.ts). Opt-in per
// block, never automatic: it spends tokens, and unlike the approval gloss nobody is waiting on it to
// decide anything.
export const codeNotes = new Map<string, LineNote[]>();
/** "loading" while the call is out, "error" when it came back with nothing usable. A block with neither
 *  and no notes has simply never been asked. */
export const notesState = new Map<string, "loading" | "error">();
/** Blocks whose notes are currently hidden (the show/hide toggle). Hidden, not discarded — turning them
 *  back on must not cost a second call. */
export const notesHidden = new Set<string>();

/** Ask for the notes on one block. `src` MUST be the text as drawn (reflowed), because the model keys its
 *  answer to the line numbers it is given and the panel draws them against what is on screen. */
export function fetchLineNotes(key: string, lang: string, src: string, output?: string): void {
    if (!config.value.utilityModel.trim() || !src.trim()) return;
    if (notesState.get(key) === "loading" || codeNotes.has(key)) return;
    notesState.set(key, "loading");
    notesHidden.delete(key);
    rev.value++;
    const lineCount = src.split("\n").length;
    // ON THE TIMELINE, as an ASIDE. It spent tokens on this box and it takes visible time, so hiding it
    // would be dishonest — but it is not the agent's work, and charging it to the run would make two runs
    // incomparable on the strength of how much someone poked at one. Recorded on the SESSION, with no
    // usage, so the run's own totals are untouched. See store.ts `Aside`.
    const [hash, seqStr] = key.split(":");
    const started = Date.now();
    chrome.runtime.sendMessage(
        { type: "FETCH_LLM", payload: { messages: notesMessages(lang, src, output), extend: "utility", schema: NOTES_SCHEMA, maxTokens: 700, think: false } },
        (resp: any) => {
            const notes = chrome.runtime.lastError || !resp || resp.error ? [] : parseNotes(String(resp.data ?? ""), lineCount);
            notesState.delete(key);
            // No usable notes is an ERROR STATE, not an empty success: a button that visibly does nothing
            // reads as broken, and the reader has no way to tell a model that declined from a call that
            // never went out.
            if (notes.length) codeNotes.set(key, notes); else notesState.set(key, "error");
            noteAside(hash, { t: started, ms: Date.now() - started, label: "annotating the code",
                              model: config.value.utilityModel || undefined, seq: Number(seqStr) });
            rev.value++;
        },
    );
}

/** Show/hide without re-asking. */
export function toggleLineNotes(key: string): void {
    if (notesHidden.has(key)) notesHidden.delete(key); else notesHidden.add(key);
    rev.value++;
}

// A tool with NO deterministic intent (a custom approval-gated tool, no `action` render) still gets a
// human description — the utility model paraphrases the call. Same cache/plumbing as the code summary.
export function ensureActionSummary(hash: string, seq: number, tool: string, args: Record<string, unknown>): void {
    if (!utilitySummariesOn() || !tool) return;
    const key = stepKey(hash, seq);
    if (codeSummaryTried.has(key)) return;
    codeSummaryTried.add(key);
    const messages = [
        { role: "system", content: "In ONE short plain-English sentence (≤ 18 words), tell a non-programmer what this tool call will DO, so they can approve it. State the effect. No preamble, no JSON, no tool name." },
        { role: "user", content: `Tool: ${tool}\nArguments: ${truncate(JSON.stringify(args ?? {}), 800)}` },
    ];
    fetchUtilityLine(messages, key);
}
// Shared: run a short utility-model call and store the one-line reply as the step's summary.
export function fetchUtilityLine(messages: { role: string; content: string }[], key: string): void {
    const started = Date.now();
    chrome.runtime.sendMessage(
        { type: "FETCH_LLM", payload: { messages, extend: "utility", maxTokens: 70, think: false } },
        (resp: any) => {
            if (chrome.runtime.lastError || !resp || resp.error) return;
            const line = String(resp.data || "").trim().split("\n").map(s => s.trim()).filter(Boolean)[0] || "";
            const s = truncate(line.replace(/^["'`*]+|["'`*]+$/g, "").trim(), 160);
            const [h, sq] = key.split(":");
            if (h) noteAside(h, { t: started, ms: Date.now() - started, label: "summarising",
                                  model: config.value.utilityModel || undefined, seq: Number(sq) });
            if (s) { codeSummaries.set(key, s); rev.value++; }
        },
    );
}

// A pending call's INTENT: prefer the tool-provided `action` descriptor (deterministic; custom tools
// too), else a name-based verb for built-ins, else nothing (→ utility-model description).
export const CODE_LANG: Record<string, string> = { exec: "javascript", python_exec: "python" };
export interface Intent { verb: string; kind?: string; target?: string; selector?: string; input?: string; note?: string; submit?: boolean; crossOrigin?: string; offMachine?: string; link?: boolean; }
/** WHAT THIS CALL WILL DO, for the approval card — deterministic, from the tool's own `action` render
 *  rather than from a model's description of itself. Null when the tool supplies none, which is when the
 *  utility model is asked to paraphrase instead. */
export function intentFor(st: AgentStep): Intent | null {
    // Whether a `type` will ALSO press Enter — a materially bigger action (it submits the form/search), so the
    // approval must call it out. Read from the raw args (the ground truth), regardless of the render path.
    const submit = st.tool === "type" ? !!st.arguments?.submit : undefined;
    const ri = st.renderIn;
    // `link` renders the target as a significant URL (warm-yellow + dotted, like navigate/submit) rather than
    // "the element …" — a fetch's URL is leaving-the-page-worthy, so style it the same as navigate's.
    if (ri && ri.type === "action") return { verb: ri.verb, kind: ri.kind, target: ri.target, selector: ri.selector, input: ri.input, note: ri.note, submit, crossOrigin: ri.crossOrigin, offMachine: ri.offMachine, link: st.tool === "navigate" || st.tool === "fetch_url" };
    if (ri && ri.type === "elements" && ri.items[0])   // an older/other target render still gives a target + selector
        return { verb: st.tool === "click" ? "Click" : st.tool === "type" ? "Type" : `Run ${st.tool}`, target: ri.items[0].text || ri.items[0].path, selector: ri.items[0].path, submit };
    const sel = typeof st.arguments?.selector === "string" ? (st.arguments.selector as string) : undefined;
    if (st.tool === "click") return { verb: "Click", selector: sel };
    if (st.tool === "type") return { verb: "Type", selector: sel, input: String(st.arguments?.text ?? ""), submit };
    return null;
}
// For a CODE tool, the actual source — the consent surface (you can't approve code you can't see).
export function codeOf(st: AgentStep): { text: string; lang: string } | null {
    const lang = CODE_LANG[st.tool || ""];
    if (!lang) return null;
    const ri = st.renderIn;
    if (ri && ri.type === "code" && typeof ri.text === "string") return { text: ri.text, lang };
    if (ri && ri.type === "python-in" && typeof ri.code === "string") return { text: ri.code, lang };
    const a = st.arguments || {};
    const src = typeof a.js === "string" ? a.js : typeof a.code === "string" ? a.code : "";
    return { text: src, lang };
}
