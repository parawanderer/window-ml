// sinks.mjs — one walk over a sweep's results, rendered through a small SEMANTIC vocabulary.
//
// The same shape the session exports use: `writeReport` walks the results once and emits meanings
// (`heading` / `note` / `table` / `list`), and each sink decides how that meaning looks. A third format —
// an HTML page, a CSV for a spreadsheet — is a third sink, not a third walker.
//
// The vocabulary is deliberately about MEANING, never appearance: there is no "bold this". A terminal sink
// can afford colour and column alignment; a markdown sink cannot; neither has to know about the other.

import { COLUMNS } from "./metrics.mjs";
import { comboLabel } from "./cells.mjs";

/** Format one aggregated number as `mean ±sd`, or `—` when nothing was measured. */
export function fmt(agg, digits = 2) {
    if (!agg || agg.mean == null) return "—";
    const m = agg.mean.toFixed(digits);
    if (agg.sd == null || agg.n < 2) return m;
    return `${m} ±${agg.sd.toFixed(digits)}`;
}

/** A markdown sink: accumulates GFM and hands back the document. */
export function mdSink() {
    const out = [];
    return {
        heading: (text, level = 2) => out.push(`${"#".repeat(level)} ${text}`),
        note: (text) => out.push(text),
        list: (items) => out.push(items.map((i) => `- ${i}`).join("\n")),
        // ONE block, not one push per row: the sink joins its blocks with a blank line, and a blank line
        // between rows is no longer a GFM table.
        table: (headers, rows) => out.push([
            `| ${headers.join(" | ")} |`,
            `| ${headers.map(() => "---").join(" | ")} |`,
            ...rows.map((r) => `| ${r.join(" | ")} |`),
        ].join("\n")),
        done: () => out.join("\n\n") + "\n",
    };
}

/**
 * A terminal sink: prints as it goes, and ALIGNS its columns.
 *
 * Alignment is right here and absent from the markdown sink for a reason — this text is read by a human
 * scanning a matrix, where padding earns its cost. (The opposite rule governs anything a MODEL reads.)
 */
export function terminalSink(write = (s) => console.log(s)) {
    return {
        heading: (text, level = 2) => write(`\n${level <= 1 ? text.toUpperCase() : text}\n${"─".repeat(Math.min(72, text.length))}`),
        note: (text) => write(text),
        list: (items) => items.forEach((i) => write(`  • ${i}`)),
        table: (headers, rows) => {
            const w = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i]).length)));
            const line = (cells) => "  " + cells.map((c, i) => (i === 0 ? String(c).padEnd(w[i]) : String(c).padStart(w[i]))).join("  ");
            write(line(headers));
            write("  " + w.map((n) => "─".repeat(n)).join("  "));
            for (const r of rows) write(line(r));
        },
        done: () => "",
    };
}

/**
 * Walk a sweep's aggregated rows once, emitting through `sink`.
 *
 * @param {object} sweep  { spec, fingerprint, rows, cells, started, finished, errors }
 * @param {object} sink   one of the sinks above
 */
export function writeReport(sweep, sink) {
    const { spec, rows, fingerprint, started, finished, cached = 0, ran = 0 } = sweep;
    sink.heading(spec.name, 1);
    if (spec.description) sink.note(spec.description);

    const mins = ((finished - started) / 60000).toFixed(1);
    sink.note(`${ran + cached} runs (${ran} run, ${cached} cached) · ${mins} min · build ${fingerprint.slice(0, 12)}${sweep.dirty ? " (DIRTY TREE)" : ""}`);
    if (sweep.dirty) sink.note("The working tree had uncommitted changes: these numbers are not reproducible from a commit.");
    if (sweep.jobs > 1) sink.note(`Ran ${sweep.jobs} browsers in parallel — the wall-time columns (secs) are NOT comparable across a parallel sweep.`);

    const dims = Object.keys(spec.dimensions || {});
    const headers = [...dims, "task", "runs", ...COLUMNS.map((c) => c.label)];
    const body = rows.map((row) => [
        ...dims.map((d) => String(row.combo[d])),
        row.taskId,
        `${row.agg.runs - row.agg.errors}/${row.agg.runs}`,
        ...COLUMNS.map((c) => fmt(row.agg[c.key], c.digits)),
    ]);
    sink.heading("Results");
    sink.table(headers, body);
    sink.note("Each figure is the mean over the cell's repeats, ± the sample standard deviation. `—` means nothing was measured (an unscored task, or a metric the run never exercised).");

    const failed = rows.filter((r) => r.agg.errors > 0);
    if (failed.length) {
        sink.heading("Runs that did not complete");
        sink.list(failed.map((r) => `${comboLabel(r.combo)} · ${r.taskId} — ${r.agg.errors} of ${r.agg.runs}: ${r.firstError || "unknown"}`));
    }

    // Every run, individually. The aggregate above says which CELL is worth opening; this says which of
    // its repeats — a mean of five hides the one that went wrong, which is usually the one to read.
    sink.heading("Runs");
    const dimCols = dims.length ? dims : [];
    sink.table([...dimCols, "task", "run", "outcome", "steps", "artifacts"],
        (sweep.runs || []).map((r) => [
            ...dimCols.map((d) => String(r.combo[d])),
            r.taskId,
            `r${r.repeat}`,
            !r.ok ? "FAILED" : r.succeeded === null ? "ok" : r.succeeded ? "ok · correct" : "ok · WRONG",
            String(r.steps),
            r.path,
        ]));
    sink.note(`Each directory holds \`run.md\` (the transcript to read), \`run.json\` (the machine-readable export — diff two runs with this, not the markdown), \`events.json\`, \`transcript.txt\` and a screenshot per step.${sweep.pdf ? " `--pdf` also wrote `run.html` + `run.pdf`." : " Add `--pdf` for `run.html` + `run.pdf` as well."}`);
    return sink.done();
}
