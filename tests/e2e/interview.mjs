// interview.mjs — one INTERVIEW (a task, then follow-ups) put to a model: the parts converse, panel and the bench share.
//
// An interview file (tests/e2e/panel/*.json) is { task, asks?: string[], about?, surface?, sharedWatches?, watchNotes? };
// `<name>.interview.ts` is the same as code (`defineInterview`, bench/spec.ts), which adds checks on the answers
// (`expect`) and conditional follow-ups.
// What lives here: reading that file, the one-call probe that says whether a model can make a tool call at all, the
// per-turn report (`outbox/turn-<n>.md`, the file a model reads), the follow-up driver (runOnce's `nextTurn`), and the
// side-by-side `summary.md`. Nothing here starts a browser.

import fs from "node:fs";
import path from "node:path";

/** A model id as a directory name. */
export const modelSlug = (model) => model.replace(/[^\w.-]+/g, "_");

/** The text an ask sends: an ask is a string or `{ ask, expect?, why? }`. */
export const askText = (a) => (typeof a === "string" ? a : a?.ask ?? "");

/** Whether a path names an interview (a panel JSON, or `<name>.interview.ts`) rather than a bench spec. */
export const isInterviewFile = (file) => file.endsWith(".json") || /\.interview\.[cm]?[jt]s$/.test(file);

/**
 * Read an interview of either kind: a JSON file (`loadInterview`), or a `.interview.ts` module whose default export is
 * `defineInterview(...)`. Named after the file either way.
 */
export async function loadInterviewFile(file) {
    if (file.endsWith(".json")) return loadInterview(file);
    const { pathToFileURL } = await import("node:url");
    const mod = await import(pathToFileURL(path.resolve(file)).href);
    const iv = mod.default;
    if (iv?.kind !== "interview") throw new Error(`interview: ${file} does not export defineInterview(...) as its default`);
    return { ...iv, asks: iv.asks ?? [], name: path.basename(file).replace(/\.interview\.[cm]?[jt]s$/, "") };
}

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
    // With a plan, the interview's own turns by their place in it (a follow-up between two shifts the numbers), each
    // with its check.
    const plan = readPlan(dir);
    if (plan) {
        const out = [];
        for (const p of plan.filter((p) => p.kind === "fixed")) {
            if (p.index >= max) break;
            const f = path.join(dir, "outbox", `turn-${p.n}.md`);
            if (!fs.existsSync(f)) break;
            out[p.index] = { ...parseTurnReport(fs.readFileSync(f, "utf8")), ...(p.expect != null ? { expect: p.expect } : {}), ...(p.why ? { why: p.why } : {}), ...(p.expectError ? { expectError: p.expectError } : {}), ...(p.n !== p.index + 1 ? { n: p.n } : {}) };
        }
        return out;
    }
    const turns = [];
    for (let n = 1; n <= max; n++) {
        const p = path.join(dir, "outbox", `turn-${n}.md`);
        if (!fs.existsSync(p)) break;
        turns.push(parseTurnReport(fs.readFileSync(p, "utf8")));
    }
    return turns;
}

/**
 * The turns someone added to a run after its own (a held bench run, bench/hold.mjs, logs each in `continued.jsonl`): what
 * was asked and when, with the turn's answer read back from its outbox report. [] when there are none.
 * @returns {{ turn: number, ask: string, at: string, answer: string, tools: string[], capped: boolean }[]}
 */
export function readContinued(dir) {
    let lines;
    try { lines = fs.readFileSync(path.join(dir, "continued.jsonl"), "utf8").split("\n").filter(Boolean); } catch { return []; }
    return lines.flatMap((l) => {
        let c; try { c = JSON.parse(l); } catch { return []; }
        const p = path.join(dir, "outbox", `turn-${c.turn}.md`);
        const t = fs.existsSync(p) ? parseTurnReport(fs.readFileSync(p, "utf8")) : { answer: "", tools: [], capped: false };
        return [{ turn: c.turn, ask: String(c.ask ?? ""), at: c.at ?? null, ...t }];
    });
}

/**
 * Keep each run's added turns (`continued`, readContinued) current: read now for every run with a directory, then every
 * `ms` for the runs held open, calling `onChange` when one changed. `runs` are page run states (`path` relative to
 * `sweepDir`, `held` set while held); the list is read afresh each time, so a run held later is followed too.
 * @returns {() => void} stops following
 */
export function followContinued(sweepDir, runs, onChange, ms = 1500) {
    const seen = new Map();
    const look = (all) => {
        let changed = false;
        for (const r of runs()) {
            if (!r.path || (!all && !r.held)) continue;
            const dir = path.join(sweepDir, r.path);
            let m = 0; try { m = fs.statSync(path.join(dir, "continued.jsonl")).mtimeMs; } catch { /* none yet */ }
            if (seen.get(dir) === m) continue;
            seen.set(dir, m);
            const c = readContinued(dir);
            if (c.length || r.continued) { r.continued = c; changed = true; }
        }
        if (changed) onChange();
    };
    look(true);
    const timer = setInterval(() => look(false), ms);
    timer.unref?.();
    return () => clearInterval(timer);
}

/**
 * The interview driver: a runOnce `nextTurn` that writes `outbox/turn-<n>.md` and `status` after each turn, runs that
 * turn's check (`expect`), and answers with the next turn: a follow-up whose `when` holds for the fixed turn just
 * answered, else the next of `asks`, else null. A turn that produced no answer of its own (it timed out) ends the
 * interview, since asking the next question of a model still busy with the last measures nothing. Every turn is
 * recorded in `turns.json` (`{ n, kind: "fixed" | "followUp", index, ask, expect, why? }`, `index` the fixed turn, 0 the
 * task, a follow-up carrying the one it followed), which is how the readers tell the interview's turns from follow-ups.
 * @param {{ asks: (string | { ask: string, expect?: Function, why?: string })[], dir: string, task?: string,
 *   expect?: Function, why?: string, followUps?: object[], model?: string | null }} opts
 * @returns {{ nextTurn: Function, statuses: string[] }} `statuses`: one line per turn, as `status` said it
 */
export function interviewDriver({ asks, dir, task = "", expect = null, why = null, followUps = [], model = null }) {
    const outbox = path.join(dir, "outbox");
    fs.mkdirSync(outbox, { recursive: true });
    const statuses = [];
    const status = (s) => { statuses.push(s); fs.writeFileSync(path.join(dir, "status"), s + "\n"); };
    const fixed = [{ ask: task, expect, why }, ...asks.map((a) => (typeof a === "string" ? { ask: a } : a))];
    const plan = [], views = [];
    const fired = new Set();
    let lastTs = 0, now = { kind: "fixed", index: 0, ask: task }, anchor = null;
    const nextTurn = async ({ turn, result, events }) => {
        const answered = events.filter((e) => e.kind === "agent-result").length >= turn;
        const md = turnReport(turn, events, lastTs, answered ? result : null);
        fs.writeFileSync(path.join(outbox, `turn-${turn}.md`), md);
        const steps = events.filter((e) => e.kind === "agent-step" && !e.pending && e.tool && (e.ts ?? 0) > lastTs)
            .map((e) => ({ tool: e.tool, arguments: e.arguments, result: e.result }));
        lastTs = Math.max(lastTs, ...events.map((e) => e.ts ?? 0));
        const view = { n: turn, ask: now.ask, answered, ...parseTurnReport(md), steps };
        if (!answered) view.answer = "";
        views.push(view);
        const run = { model, turns: views };
        const entry = { n: turn, kind: now.kind, index: now.index, ask: now.ask, expect: null };
        if (now.kind === "fixed") {
            anchor = view;
            const def = fixed[now.index];
            if (def.why) entry.why = def.why;
            if (def.expect) {
                try { entry.expect = !!def.expect(view, run); }
                catch (e) { entry.expect = false; entry.expectError = String(e?.message ?? e).slice(0, 300); }
            }
        }
        plan.push(entry);
        fs.writeFileSync(path.join(dir, "turns.json"), JSON.stringify(plan, null, 2));
        if (!answered) { status(`timed out in turn ${turn}`); return null; }
        status(`turn ${turn} done (outbox/turn-${turn}.md)${entry.expect == null ? "" : entry.expect ? ", as expected" : ", NOT as expected"}`);
        // A follow-up for the fixed turn last answered, asked once, when its `when` holds for that turn.
        const at = now.index;   // the fixed turn this one was, or followed
        for (const [i, f] of followUps.entries()) {
            if (fired.has(i) || (f.after != null && f.after !== at + 1)) continue;
            let yes = false;
            try { yes = !!f.when(anchor, run); } catch { /* a `when` that throws asks nothing */ }
            if (!yes) continue;
            fired.add(i);
            const ask = typeof f.ask === "function" ? String(f.ask(anchor, run)) : f.ask;
            now = { kind: "followUp", index: at, ask };
            return ask;
        }
        if (at + 1 >= fixed.length) return null;
        now = { kind: "fixed", index: at + 1, ask: fixed[at + 1].ask };
        return now.ask;
    };
    return { nextTurn, statuses };
}

/** Whether a bench task is an interview: it has asks, follow-ups or a check on its answer, so a driver runs its turns. */
export const isInterviewTask = (t) => !!(t?.asks?.length || t?.followUps?.length || t?.expect);

/** The driver for a bench task's interview, in `dir`, against `model` (what its checks are told). */
export const driverFor = (t, dir, model = null) => interviewDriver({ asks: t.asks ?? [], dir, task: t.task, expect: t.expect ?? null, why: t.why ?? null, followUps: t.followUps ?? [], model });

/** A session directory's turn plan (`turns.json`, interviewDriver), or null when it predates one. */
function readPlan(dir) {
    try { return JSON.parse(fs.readFileSync(path.join(dir, "turns.json"), "utf8")); } catch { return null; }
}

/** The follow-ups a session asked, each under the fixed turn it followed (`after`, 1 is the task), with its answer. */
export function readFollowUps(dir) {
    return (readPlan(dir) ?? []).filter((p) => p.kind === "followUp").flatMap((p) => {
        const f = path.join(dir, "outbox", `turn-${p.n}.md`);
        return fs.existsSync(f) ? [{ after: p.index + 1, n: p.n, ask: p.ask, ...parseTurnReport(fs.readFileSync(f, "utf8")) }] : [];
    });
}

/** How many of a run's checked turns came out as expected, or null when none was checked. */
export function expectTally(turns) {
    const checked = (turns ?? []).filter((t) => t?.expect != null);
    return checked.length ? { passed: checked.filter((t) => t.expect).length, total: checked.length } : null;
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
    const checked = results.some((r) => expectTally(r.turns));
    L.push(`| model | calls per turn | ended | prompt chars |${checked ? " as expected |" : ""}`, `| --- | --- | --- | --- |${checked ? " --- |" : ""}`);
    for (const r of results) {
        const calls = r.turns.map((t) => `${t.tools.length}${t.capped ? " (cap)" : ""}`).join(" / ") || "none";
        const ended = r.turns.length === r.expected ? "all turns" : `after turn ${r.turns.length}: ${r.statuses.at(-1) ?? "no turn"}`;
        const tally = expectTally(r.turns);
        L.push(`| \`${r.model}\` | ${calls} | ${ended} | ${r.prompt} |${checked ? ` ${tally ? `${tally.passed}/${tally.total}` : "none"} |` : ""}`);
    }
    const asks = [askText(iv.task), ...(iv.asks ?? []).map(askText)];
    asks.forEach((q, i) => {
        L.push("", `## Turn ${i + 1}`, "", `> ${q.replace(/\n+/g, " ").slice(0, 400)}`, "");
        for (const r of results) {
            const t = r.turns[i];
            L.push(`### ${r.model}`, "", t ? `*${t.tools.length} call(s): ${t.tools.join(", ") || "none"}${t.capped ? ", stopped at the step cap" : ""}*` : "*no turn*", "");
            // Quoted, so a model's own headings stay inside its answer instead of joining the summary's outline.
            if (t) L.push((t.answer || "(no answer)").split("\n").map((l) => `> ${l}`).join("\n"), "");
            if (t?.expect != null) L.push(`- ${t.expect ? "as expected" : "NOT as expected"}${t.why ? `: ${t.why}` : ""}${t.expectError ? ` (the check threw: ${t.expectError})` : ""}`, "");
            // A follow-up this answer called for, asked of this model only.
            for (const f of (r.followUps ?? []).filter((f) => f.after === i + 1)) {
                L.push(`- follow-up (turn ${f.n}): ${f.ask.replace(/\s+/g, " ").slice(0, 300)}`, "", (f.answer || "(no answer)").split("\n").map((l) => `> ${l}`).join("\n"), "");
            }
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
            id: iv.name, task: askText(iv.task), asks: iv.asks, start: iv.start ?? "/step3",
            ...(typeof iv.task === "object" && iv.task.expect ? { expect: iv.task.expect, why: iv.task.why } : {}),
            ...(iv.followUps?.length ? { followUps: iv.followUps } : {}),
            surface: s && s !== "console" ? s : null,
            ...(iv.sharedWatches ? { sharedWatches: iv.sharedWatches } : {}),
            ...(iv.watchNotes ? { watchNotes: iv.watchNotes } : {}),
            ...(iv.hold != null ? { hold: iv.hold } : {}),
            ...(iv.holdIdleMinutes != null ? { holdIdleMinutes: iv.holdIdleMinutes } : {}),
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
