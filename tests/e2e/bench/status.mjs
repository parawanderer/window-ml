// status.mjs — the sweep's state as files a model reads from the CLI, from the SAME object the page renders (run.mjs's
// push): `status.md` (text) and `status.json` (that object, less the timeline and the box's samples, which have files of
// their own), rewritten at most every `everyMs` while the sweep runs and once more at its end. A model that started the
// sweep in the background reads these instead of opening the page: how far along it is, what is running, what it has
// spent and is estimated to spend by its end, what the bench holds in memory against its budget (with the chart's
// readings as a table), the held runs with the commands for each, and whether it paused. Nothing here waits on anything:
// a read is a file read.

import { writeFileSync, renameSync } from "node:fs";
import path from "node:path";
import { fmtBytes, limitWhence } from "./memory-budget.mjs";
import { spendLine } from "./live-spend.mjs";
import { forecastText } from "./spend-predict.mjs";

/** What status.json keeps of the page's state: everything but the timeline and the box's samples (timeline.md, memory.md). */
export const statusJson = ({ timeline: _t, resources: _r, ...s }) => s;

/** At most `n` evenly spread readings of a history, the first and the last always among them. */
function spread(h, n) {
    if (h.length <= n) return h;
    return Array.from({ length: n }, (_, i) => h[Math.round((i * (h.length - 1)) / (n - 1))]);
}

/** The page's state as text: progress, running cells, spend, memory and held runs, pause. */
export function statusText(s, now = Date.now()) {
    const runs = s.runs ?? [];
    const done = runs.filter((r) => r.state === "done").length;
    const running = runs.filter((r) => r.state === "running");
    const failed = runs.filter((r) => r.state === "done" && !r.ok).length;
    const clock = (t) => new Date(t).toISOString().slice(11, 19);
    const out = [`# ${s.name}: ${s.finished ? "finished" : "running"}`, "",
        `${done} of ${runs.length} runs done${failed ? `, ${failed} failed` : ""}${s.memory?.paused ? "; PAUSED at the memory budget" : ""}. Written ${new Date(now).toISOString()}${s.finished ? "" : ", rewritten every few seconds while the sweep runs"}.`, ""];
    if (running.length) {
        out.push("## Running now", "");
        for (const r of running) out.push(`- ${r.taskId} · ${Object.values(r.combo ?? {}).join(" · ")} · r${r.repeat}${r.live?.step != null ? `: step ${r.live.step}${r.live.maxSteps ? ` of ${r.live.maxSteps}` : ""}` : ""}${r.live?.last ? ` (${r.live.last})` : ""}`);
        out.push("");
    }
    if (s.spend) {
        const money = (x) => `${x.toFixed(4)} ${s.spend.currency}`;
        out.push("## Spend (this invocation, priced as each call came in)", "", spendLine(s.spend), "", "| driver | calls | computed (calls) | reported (calls) | local | unpriced | waiting |", "| --- | --- | --- | --- | --- | --- | --- |");
        for (const [m, t] of Object.entries(s.spend.models ?? {})) out.push(`| ${m} | ${t.calls} | ${t.computedCalls ? `${money(t.computed)} (${t.computedCalls})` : ""} | ${t.reportedCalls ? `${money(t.reported)} (${t.reportedCalls})` : ""} | ${t.local || ""} | ${t.unpriced || ""} | ${t.pending || ""} |`);
        out.push("", "Computed: each call's tokens at the rates of the price snapshot it ran under. Reported: the provider's own figure. scores.md prices the logged calls the same way.", "");
    }
    if (s.forecast?.left) out.push("## Spend estimate (narrows as runs finish)", "", ...forecastText(s.forecast).map((l) => l.replace(/^ {2}/, "")), "");
    const m = s.memory;
    if (m && (m.active || m.groups?.length)) {
        out.push("## Memory (everything the bench holds on this machine, every clone's)", "",
            `${fmtBytes(m.used)} of a ${fmtBytes(m.limit)} limit (${limitWhence({ source: m.limitSource ?? "auto", by: m.limitBy, at: m.limitAt })}; change it machine-wide, running sweeps included: \`node --import tsx tests/e2e/bench/hold.mjs --limit 12G\`); ${fmtBytes(m.available)} available${m.reserve ? `, ${fmtBytes(m.reserve)} kept free` : ", no reserve (a limit set by hand)"}; room for ${fmtBytes(m.room)}. At the limit: ${m.whenFull}.`,
            ...Object.entries(m.byKind ?? {}).map(([k, v]) => `- ${k}: ${fmtBytes(v)}${k === "runner" && m.runner?.heap ? ` (node heap ${fmtBytes(m.runner.heap)})` : ""}`), "");
        if (m.paused) out.push(`PAUSED: ${m.paused}`, `Resume: ${m.resume}`, "");
        const h = m.history ?? [];
        if (h.length >= 2) {
            const kinds = [...new Set(h.flatMap((p) => Object.keys(p.values)))];
            const total = (p) => Object.values(p.values).reduce((a, b) => a + b, 0);
            const peak = h.reduce((a, p) => (total(p) > total(a) ? p : a));
            out.push(`Over the sweep (the page's chart; ${h.length} readings, peak ${fmtBytes(total(peak))} at ${clock(peak.t)}):`, "",
                `| time | ${kinds.join(" | ")} | total | room |`, `| --- | ${kinds.map(() => "---").join(" | ")} | --- | --- |`,
                ...spread(h, 12).map((p) => `| ${clock(p.t)} | ${kinds.map((k) => fmtBytes(p.values[k] ?? 0)).join(" | ")} | ${fmtBytes(total(p))} | ${fmtBytes(p.room)} |`), "");
        }
        if (m.groups?.length) {
            out.push("Held open, by model · task · failure:", "");
            for (const g of m.groups) {
                out.push(`- ${g.count} × ${g.key} (${fmtBytes(g.rss)}${g.sweeps?.length ? `, ${g.sweeps.join(", ")}` : ""})`,
                    `  - attach to one: \`${g.commands.attach}\``,
                    ...(g.commands.keepOne ? [`  - keep one, release the rest: \`${g.commands.keepOne}\``] : []),
                    `  - release ${g.count === 1 ? "it" : `all ${g.count}`}: \`${g.commands.release}\``);
            }
            out.push("", ...(m.hints ?? []).map((x) => `- ${x}`), "");
        }
        if (m.wouldHold?.length) out.push("Not held (the budget had no room):", "", ...m.wouldHold.map((w) => `- ${w.cell} (${w.failure}): ${w.dir}`), "");
        out.push("Any time, from any clone: `node --import tsx tests/e2e/bench/hold.mjs --menu` (held runs and their commands), `--ledger` (every bench process and its memory).", "");
    }
    return out.join("\n");
}

/** Write status.md and status.json into `dir` now, each replaced whole (a reader never sees half a file). */
export function writeStatus(dir, state, now = Date.now()) {
    for (const [f, text] of [["status.md", statusText(state, now)], ["status.json", JSON.stringify(statusJson(state), null, 2)]]) {
        const p = path.join(dir, f), tmp = `${p}.${process.pid}`;
        writeFileSync(tmp, text);
        renameSync(tmp, p);
    }
}

/** A writer that writes at most every `everyMs`, the latest state always landing (a trailing write), and `flush()` now.
 *  `update` takes the state or a function that builds it, called only when a write happens, so a sweep with nobody
 *  reading pays for one build every `everyMs`, not one per event. */
export function statusWriter(dir, { everyMs = 2000, write = writeStatus } = {}) {
    let last = 0, timer = null, pending = null;
    const go = () => {
        timer = null; last = Date.now();
        const s = pending; pending = null;
        try { write(dir, typeof s === "function" ? s() : s); } catch { /* the next one */ }
    };
    return {
        update(state) {
            pending = state;
            if (timer) return;
            const wait = Math.max(0, last + everyMs - Date.now());
            timer = setTimeout(go, wait);
            timer.unref?.();
        },
        flush(state) { if (timer) clearTimeout(timer); timer = null; pending = state ?? pending; if (pending) go(); },
    };
}
