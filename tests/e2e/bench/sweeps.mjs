// sweeps.mjs — which version of the spec each sweep ran, who started it, and what changed since the sweep before.
//
// An agent iterating on the bench edits the bench itself: a task's wording, a predicate, a dimension. Its RESULTS then
// differ, and a reader comparing two sweeps has to know whether the models changed or the question did. So every sweep
// appends one record to `<sweepDir>/sweeps.jsonl`, carrying the spec file's text as it ran, and the page (a Spec card),
// spec.md and page.json show that version, who ran it, and the diff against the previous sweep's.
//
// Only the spec FILE is recorded: a module it imports (a shared predicate) is covered by the build fingerprint, which
// hashes the whole tree's uncommitted diff, not by this.

import { readFile, appendFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { codeDiff, diffStat } from "../../../src/diff.ts";

/** Short content hash of a spec's text: equal hashes mean the same question was asked. */
export const specHash = (source) => createHash("sha256").update(source).digest("hex").slice(0, 12);

/**
 * Every sweep record of a sweep directory, oldest first. A line that does not parse is skipped: a torn last line is what
 * an interrupted append leaves.
 */
export async function readSweeps(sweepDir) {
    let text = "";
    try { text = await readFile(path.join(sweepDir, "sweeps.jsonl"), "utf8"); } catch { return []; }
    const out = [];
    for (const line of text.split("\n")) {
        if (!line.trim()) continue;
        try { const r = JSON.parse(line); if (r?.op === "sweep") out.push(r); } catch { /* torn line */ }
    }
    return out;
}

/**
 * Append this sweep's record (APPEND-ONLY, one line per sweep, never a rewrite) and return every record so far.
 *
 * @param {{ specPath: string, source: string, fingerprint: string, dirty: boolean, by: string }} sweep
 */
export async function recordSweep(sweepDir, { specPath, source, fingerprint, dirty, by }) {
    const rec = { op: "sweep", at: new Date().toISOString(), by: String(by).slice(0, 200), spec: specPath, specHash: specHash(source), fingerprint, dirty: !!dirty, specSource: source };
    await appendFile(path.join(sweepDir, "sweeps.jsonl"), JSON.stringify(rec) + "\n");
    return readSweeps(sweepDir);
}

/**
 * What the page and spec.md show about the spec, from the log: the LAST record is this sweep. `previous` is the sweep
 * before it, and `diff` its spec against this one (null when unchanged, or `tooBig` when past what a diff is read for).
 */
export function specProvenance(sweeps) {
    const cur = sweeps.at(-1);
    if (!cur) return null;
    const prev = sweeps.at(-2) ?? null;
    const changed = prev ? prev.specHash !== cur.specHash : null;
    const rows = changed ? codeDiff(prev.specSource ?? "", cur.specSource ?? "") : null;
    const brief = (r) => ({ at: r.at, by: r.by, specHash: r.specHash, fingerprint: r.fingerprint, dirty: r.dirty, spec: r.spec });
    return {
        ...brief(cur),
        source: cur.specSource ?? "",
        sweeps: sweeps.length,
        previous: prev ? brief(prev) : null,
        changed,
        diff: rows,
        tooBig: !!changed && !rows,
        stat: rows ? diffStat(rows) : null,
        history: sweeps.map(brief),
    };
}

/** spec.md: the same as the page's Spec card, as text. */
export function specText(p) {
    if (!p) return "# Spec\n\nNo sweep has been recorded.\n";
    const lines = [`# Spec`, "", `This sweep ran \`${p.spec}\` (spec ${p.specHash}), started by ${p.by} at ${p.at}, on build ${p.fingerprint}${p.dirty ? " (uncommitted changes)" : ""}.`, ""];
    lines.push("## Since the previous sweep", "");
    if (!p.previous) lines.push("This is the first sweep recorded here.");
    else {
        lines.push(`Previous: spec ${p.previous.specHash}, started by ${p.previous.by} at ${p.previous.at}, on build ${p.previous.fingerprint}.`, "");
        if (!p.changed) lines.push("The spec is unchanged.");
        else if (p.tooBig) lines.push("The spec changed; it is too long to diff here.");
        else {
            lines.push(`The spec changed: ${p.stat.added} line(s) added, ${p.stat.removed} removed.`, "", "```diff");
            for (const r of p.diff) lines.push(r.kind === "gap" ? `@@ ${r.skipped} unchanged line(s) @@` : `${r.kind === "add" ? "+" : r.kind === "del" ? "-" : " "}${r.text}`);
            lines.push("```");
        }
    }
    lines.push("", "## Every sweep of this spec", "", "| started | by | spec | build |", "| --- | --- | --- | --- |");
    for (const h of p.history) lines.push(`| ${h.at} | ${h.by} | ${h.specHash} | ${h.fingerprint}${h.dirty ? " (dirty)" : ""} |`);
    const fence = p.source.includes("```") ? "````" : "```";
    lines.push("", "## The spec as it ran", "", `${fence}${path.extname(p.spec).slice(1)}`, p.source.replace(/\n$/, ""), fence, "");
    return lines.join("\n");
}
