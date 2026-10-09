// mark.mjs — mark an interview answer wrong from the command line: what the page's "mark wrong" button does, for a model
// (or a person) driving the bench from a terminal. The mark goes through the same check as the page's (`validMark`) into
// the same log, the sweep's marks.jsonl (append-only, each record saying who made it), and every later run of that
// model at that turn is checked for the marked line (the result is in summary.md under the answer, and on the page).
// Pass `--by "<who you are>"` (or set BENCH_BY): a mark says whose claim it is.
//
//   node tests/e2e/bench/mark.mjs tests/e2e/artifacts/bench/panel-bloat --model deepseek.deepseek-v4-pro --turn 2 \
//       --quote "the snapshot excludes the current call" --note "it includes it"
//   node tests/e2e/bench/mark.mjs <sweep dir> --list          the marks so far
//
// `--task <id>` is needed only when the sweep has more than one interview; `--model` names the run as the page does
// (the `model` value, else the whole combination as `k=v k=v`). `--hash` ties the mark to one run (it then shows as
// "marked wrong" on that run and as a check on every other).

import { readFile, appendFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { validMark } from "../interview.mjs";

/** Who an edit from this process is by, when the caller does not say: `--by`, else `BENCH_BY`, else the command line. */
export const defaultBy = () => process.env.BENCH_BY || "command line";

/**
 * Add a mark to a sweep's log, validated as the page's are; returns the stored record.
 *
 * APPEND-ONLY: one JSON line, written with one append, never a read-modify-write of the whole file, so a person marking
 * on the page while an agent marks from a terminal cannot lose either. Each record says who made it and when; a
 * correction is a new record, never an edit of an old one (the rule window.ml's session history follows).
 *
 * @param {string} by who made it: "person (page)", or the agent ("claude-code 3bdb7a23", …)
 */
export async function addMark(sweepDir, fields, by = defaultBy()) {
    const m = validMark(fields);
    if (!m) throw new Error("not a mark: it needs --task (or a sweep with one interview), --model, --turn N, and --quote or --note");
    const at = new Date().toISOString();
    const rec = { op: "mark", id: createHash("sha256").update(JSON.stringify(m) + at + Math.random()).digest("hex").slice(0, 10), ...m, by: String(by).slice(0, 200), at };
    await appendFile(path.join(sweepDir, "marks.jsonl"), JSON.stringify(rec) + "\n");
    return rec;
}

/**
 * Every mark of a sweep, oldest first: the log (`marks.jsonl`), after any written by the bench before it was a log
 * (`marks.json`, an array with no author, read as by "unknown"). A line that does not parse is skipped, not fatal: a
 * torn last line is what an interrupted append leaves.
 */
export async function readMarks(sweepDir) {
    const out = [];
    try {
        for (const m of JSON.parse(await readFile(path.join(sweepDir, "marks.json"), "utf8"))) out.push({ op: "mark", by: "unknown", ...m });
    } catch { /* no legacy file */ }
    let text = "";
    try { text = await readFile(path.join(sweepDir, "marks.jsonl"), "utf8"); } catch { /* none yet */ }
    for (const line of text.split("\n")) {
        if (!line.trim()) continue;
        try { const r = JSON.parse(line); if (r?.op === "mark") out.push(r); } catch { /* torn line */ }
    }
    return out;
}

async function main(argv) {
    const [dir, ...rest] = argv;
    if (!dir || dir.startsWith("--")) throw new Error("usage: mark.mjs <sweep dir> --model <who> --turn <n> --quote <line> [--note <why>] [--task <id>] [--hash <run hash>] [--by <who you are>] | --list");
    const opt = {};
    for (let i = 0; i < rest.length; i++) {
        const k = rest[i].replace(/^--/, "");
        if (k === "list") opt.list = true; else opt[k] = rest[++i];
    }
    if (opt.list) {
        const marks = await readMarks(dir);
        if (!marks.length) return console.log("no marks yet");
        for (const m of marks) console.log(`${m.id}  ${m.taskId}  ${m.who}  turn ${m.turn}${m.hash ? `  run ${m.hash.slice(0, 12)}` : ""}  by ${m.by}${m.at ? ` ${m.at}` : ""}\n    "${m.quote}"${m.note ? `  (${m.note})` : ""}`);
        return;
    }
    let taskId = opt.task;
    if (!taskId) {
        // The sweep's interviews are in page.json; with exactly one, it is the one meant.
        try {
            const ids = Object.keys(JSON.parse(await readFile(path.join(dir, "page.json"), "utf8")).interviews || {});
            if (ids.length === 1) taskId = ids[0];
            else if (ids.length > 1) throw new Error(`this sweep has ${ids.length} interviews (${ids.join(", ")}): say which with --task`);
        } catch (e) { if (/interviews/.test(String(e))) throw e; }
    }
    const mark = await addMark(dir, { taskId, who: opt.model, turn: Number(opt.turn), quote: opt.quote ?? "", note: opt.note ?? "", hash: opt.hash ?? null }, opt.by || defaultBy());
    console.log(`marked ${mark.id} by ${mark.by}: ${mark.who} turn ${mark.turn} (${path.join(dir, "marks.jsonl")}); the next run of that model is checked for it`);
}

if (import.meta.url === `file://${process.argv[1]}`) main(process.argv.slice(2)).catch((e) => { console.error(String(e?.message || e)); process.exit(1); });
