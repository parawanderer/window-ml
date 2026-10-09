// interview.mjs — one INTERVIEW (a task, then follow-ups) put to a model: the parts converse, panel and the bench share.
//
// An interview file (tests/e2e/panel/*.json) is { task, asks?: string[], about?, surface?, sharedWatches?, watchNotes? }.
// What lives here: reading that file, the one-call probe that says whether a model can make a tool call at all, the
// per-turn report (`outbox/turn-<n>.md`, the file a model reads), the follow-up driver (runOnce's `nextTurn`), and the
// side-by-side `summary.md`. Nothing here starts a browser.

import fs from "node:fs";
import path from "node:path";

/** A model id as a directory name. */
export const modelSlug = (model) => model.replace(/[^\w.-]+/g, "_");

/**
 * Read an interview file and check its shape.
 * @returns {{ name: string, task: string, asks: string[], about?: string, surface?: string, sharedWatches?: string[], watchNotes?: Record<string,string> }}
 */
export function loadInterview(file) {
    const iv = JSON.parse(fs.readFileSync(file, "utf8"));
    if (typeof iv.task !== "string" || !iv.task.trim()) throw new Error(`interview: ${file} has no "task"`);
    if (iv.asks != null && (!Array.isArray(iv.asks) || iv.asks.some((a) => typeof a !== "string"))) throw new Error(`interview: ${file} "asks" is not a list of strings`);
    return { ...iv, asks: iv.asks ?? [], name: path.basename(file).replace(/\.json$/, "") };
}

/**
 * Can this model make a tool call through the configured backend? One small request, so a broken connection or a
 * model without tool support is named up front instead of read later as a model that ignored the task.
 * @returns {Promise<string | null>} null when it can, else why not
 */
export async function probe(backend, model) {
    try {
        const r = await fetch(backend.chatUrl, {
            method: "POST",
            headers: { "content-type": "application/json", ...(backend.key ? { authorization: `Bearer ${backend.key}` } : {}) },
            body: JSON.stringify({ model, messages: [{ role: "user", content: "Call the exec tool with js set to 1+1." }],
                tools: [{ type: "function", function: { name: "exec", description: "run JS", parameters: { type: "object", properties: { js: { type: "string" } }, required: ["js"] } } }] }),
            signal: AbortSignal.timeout(120_000),
        });
        const text = await r.text();
        let d; try { d = JSON.parse(text); } catch { return `HTTP ${r.status}, not JSON: ${text.slice(0, 120)}`; }
        if (!r.ok || !d.choices) return `HTTP ${r.status}: ${JSON.stringify(d).slice(0, 160)}`;
        return d.choices[0]?.message?.tool_calls?.length ? null : "answered without a tool call";
    } catch (e) { return String(e?.message || e); }
}

/** One turn's steps, as text an agent reads: what was called, with what, what came back, and who approved it. */
export function turnReport(n, events, fromTs, result) {
    // By time, not `seq`: a reasoning step carries none.
    const steps = events.filter((e) => e.kind === "agent-step" && !e.pending && (e.ts ?? 0) > fromTs);
    const clip = (v, n) => { const s = typeof v === "string" ? v : JSON.stringify(v); return s && s.length > n ? s.slice(0, n) + " …" : s; };
    const lines = [`# Turn ${n}`, "", "## Answer", "", result?.summary ?? "(no answer: the turn did not finish)", "", "## Steps", ""];
    for (const s of steps) {
        if (!s.tool) { const t = s.thought || s.reasoning; if (t) lines.push(`- thought: ${clip(t, 600)}`); continue; }
        lines.push(`- **${s.tool}**${s.approval ? ` (${s.approval})` : ""} ${clip(s.arguments, 800)}`, `  → ${clip(s.result, 1200)}`);
    }
    return lines.join("\n") + "\n";
}

/** What one turn did, parsed back out of its report: the answer, the tools called in order, and whether it hit the cap. */
export function parseTurnReport(md) {
    const answer = (md.split("## Answer")[1] ?? "").split("\n## Steps")[0].trim();
    const tools = [...md.matchAll(/^- \*\*([A-Za-z_][\w.-]*)\*\*/gm)].map((m) => m[1]);
    return { answer, tools, capped: /Stopped at the \d+-step cap/.test(answer) };
}

/** Turns 1..max of a session directory, from its outbox, stopping at the first one not written. */
export function readTurns(dir, max = Infinity) {
    const turns = [];
    for (let n = 1; n <= max; n++) {
        const p = path.join(dir, "outbox", `turn-${n}.md`);
        if (!fs.existsSync(p)) break;
        turns.push(parseTurnReport(fs.readFileSync(p, "utf8")));
    }
    return turns;
}

/**
 * The follow-up driver: a runOnce `nextTurn` that writes `outbox/turn-<n>.md` and `status` after each turn and answers
 * with the next of `asks`, then null. A turn that produced no answer of its own (it timed out) ends the interview,
 * since asking the next question of a model still busy with the last measures nothing.
 * @param {{ asks: string[], dir: string }} opts
 * @returns {{ nextTurn: Function, statuses: string[] }} `statuses`: one line per turn, as `status` said it
 */
export function interviewDriver({ asks, dir }) {
    const outbox = path.join(dir, "outbox");
    fs.mkdirSync(outbox, { recursive: true });
    const statuses = [];
    const status = (s) => { statuses.push(s); fs.writeFileSync(path.join(dir, "status"), s + "\n"); };
    let lastTs = 0;
    const nextTurn = async ({ turn, result, events }) => {
        const answered = events.filter((e) => e.kind === "agent-result").length >= turn;
        fs.writeFileSync(path.join(outbox, `turn-${turn}.md`), turnReport(turn, events, lastTs, answered ? result : null));
        lastTs = Math.max(lastTs, ...events.map((e) => e.ts ?? 0));
        if (!answered) { status(`timed out in turn ${turn}`); return null; }
        status(`turn ${turn} done (outbox/turn-${turn}.md)`);
        return turn <= asks.length ? asks[turn - 1] : null;
    };
    return { nextTurn, statuses };
}

/** The prompt size a session's run.md states, or "?". */
export function promptChars(dir) {
    const p = path.join(dir, "run.md");
    const md = fs.existsSync(p) ? fs.readFileSync(p, "utf8") : "";
    return /System prompt \(([\d,]+) chars/.exec(md)?.[1] ?? "?";
}

/**
 * The panel's summary: one line per model, then each turn's answers side by side.
 * @param {Array<{ model: string, turns: object[], statuses: string[], prompt: string, expected: number, checks?: object[] }>} results
 */
export function panelSummary(name, iv, results, skipped, surface) {
    const L = [`# Panel: ${name}`, "", ...(iv.about ? [iv.about, ""] : []), `${new Date().toISOString()} · surface: ${surface ?? "console"} · ${results.length} model(s)`, ""];
    if (skipped.length) { L.push("Skipped (failed the tool-call probe):", ""); for (const s of skipped) L.push(`- \`${s.model}\`: ${s.why}`); L.push(""); }
    L.push("| model | calls per turn | ended | prompt chars |", "| --- | --- | --- | --- |");
    for (const r of results) {
        const calls = r.turns.map((t) => `${t.tools.length}${t.capped ? " (cap)" : ""}`).join(" / ") || "none";
        const ended = r.turns.length === r.expected ? "all turns" : `after turn ${r.turns.length}: ${r.statuses.at(-1) ?? "no turn"}`;
        L.push(`| \`${r.model}\` | ${calls} | ${ended} | ${r.prompt} |`);
    }
    const asks = [iv.task, ...(iv.asks ?? [])];
    asks.forEach((q, i) => {
        L.push("", `## Turn ${i + 1}`, "", `> ${q.replace(/\n+/g, " ").slice(0, 400)}`, "");
        for (const r of results) {
            const t = r.turns[i];
            L.push(`### ${r.model}`, "", t ? `*${t.tools.length} call(s): ${t.tools.join(", ") || "none"}${t.capped ? ", stopped at the step cap" : ""}*` : "*no turn*", "");
            // Quoted, so a model's own headings stay inside its answer instead of joining the summary's outline.
            if (t) L.push((t.answer || "(no answer)").split("\n").map((l) => `> ${l}`).join("\n"), "");
            // A person's marks from an earlier read (the bench's page): whether this answer still says the marked line.
            for (const c of (r.checks ?? []).filter((c) => c.turn === i + 1 && c.still != null)) {
                const what = c.here ? "marked wrong" : c.still ? "still says a line marked wrong" : "no longer says a line marked wrong";
                L.push(`- ${what}${c.quote ? `: "${c.quote.replace(/\s+/g, " ").slice(0, 200)}"` : ""}${c.note ? ` (${c.note.replace(/\s+/g, " ").slice(0, 200)})` : ""}${c.by ? `, marked by ${c.by}` : ""}`);
            }
            if ((r.checks ?? []).some((c) => c.turn === i + 1 && c.still != null)) L.push("");
        }
    });
    return L.join("\n") + "\n";
}

/**
 * An interview as a bench spec: one task over a `model` dimension, one run each, no predicate. What the bench adds over
 * panel.mjs is the page (`--serve`): the answers side by side, and an answer a person marks wrong.
 * @param {ReturnType<typeof loadInterview>} iv
 * @param {string[]} models
 * @param {{ surface?: string|null, turnMinutes?: number }} [opts] `surface` overrides the file's, as panel.mjs's does
 */
export function interviewBench(iv, models, { surface, turnMinutes = 15 } = {}) {
    const s = surface !== undefined ? surface : (iv.surface ?? null);
    return {
        name: `panel-${iv.name}`,
        description: iv.about,
        repeats: 1,
        timeoutMs: turnMinutes * 60_000,   // per turn: each follow-up gets its own deadline
        dimensions: { model: models },
        apply: (combo) => ({ backend: { model: combo.model } }),
        tasks: [{
            id: iv.name, task: iv.task, asks: iv.asks, start: "/step3",
            surface: s && s !== "console" ? s : null,
            ...(iv.sharedWatches ? { sharedWatches: iv.sharedWatches } : {}),
            ...(iv.watchNotes ? { watchNotes: iv.watchNotes } : {}),
        }],
    };
}

/**
 * Markdown syntax, whitespace and case folded, so a quote selected out of a RENDERED answer (where `**`, backticks,
 * list markers and link targets are gone) still matches the raw text the model sent. Applied to both sides, so a quote
 * taken from the raw text matches too.
 */
export const fold = (s) => String(s ?? "")
    .replace(/\[([^\]]*)\]\([^)\s]*\)/g, "$1")             // [text](url) -> text
    .replace(/^[ \t]*(?:#{1,6}|>|[-*+]|\d+[.)])[ \t]+/gm, "")  // heading, quote and list markers at a line's start
    .replace(/[*_`|]/g, "")                                  // emphasis, code spans and fences, table pipes
    .replace(/\s+/g, " ").trim().toLowerCase();

/**
 * Turn a person's marks into CHECKS on a run's answers. A mark says "this answer, from this model at this turn, is
 * wrong", with the line it quoted; on any later run of the same model and turn the check is whether the answer still
 * says that line. It is the bridge from a panel (read by a person) back to something scored: crude, since a model
 * can restate a wrong claim in new words, but a quote that comes back verbatim (markdown syntax, case and spacing aside: `fold`) is the same claim.
 *
 * @param {{ taskId: string, who: string, hash?: string|null, turns: { answer: string }[] }} run `who` is what a mark
 *   names the run by (the `model` value when the sweep has one, else its whole combination)
 * @param {Array<{ id: string, taskId: string, who: string, turn: number, quote: string, note?: string, hash?: string|null }>} marks
 * @returns {Array<{ id: string, turn: number, quote: string, note: string, by: string, at: string | null, here: boolean, still: boolean | null }>}
 *   `here`: the mark was made on THIS run; `still`: the answer still contains the quote (null: that turn has no answer)
 */
export function checkMarks(run, marks) {
    const out = [];
    for (const m of marks) {
        if (m.taskId !== run.taskId || m.who !== run.who) continue;
        const t = run.turns?.[m.turn - 1];
        const here = !!m.hash && m.hash === run.hash;
        out.push({ id: m.id, turn: m.turn, quote: m.quote, note: m.note ?? "", by: m.by ?? "unknown", at: m.at ?? null, here,
            still: t ? (m.quote ? fold(t.answer).includes(fold(m.quote)) : true) : null });
    }
    return out;
}

/**
 * A mark as it arrives from the page, checked: the fields a check needs, of the right type and a bounded size.
 * @returns {object | null} the mark to store, or null if it is not one
 */
export function validMark(body) {
    const str = (v, max) => typeof v === "string" && v.length <= max;
    if (!body || typeof body !== "object") return null;
    if (!str(body.taskId, 200) || !body.taskId || !str(body.who, 400) || !body.who) return null;
    if (!Number.isInteger(body.turn) || body.turn < 1 || body.turn > 1000) return null;
    if (!str(body.quote ?? "", 4000) || !str(body.note ?? "", 4000) || !(body.quote || body.note)) return null;
    if (body.hash != null && !str(body.hash, 100)) return null;
    return { taskId: body.taskId, who: body.who, turn: body.turn, quote: body.quote ?? "", note: body.note ?? "",
        hash: body.hash ?? null };
}
