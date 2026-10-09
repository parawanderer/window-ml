// sweeps.mjs — which version of the spec each sweep ran, who started it, and what changed since the sweep before.
//
// An agent iterating on the bench edits the bench itself: a task's wording, a predicate, a dimension. Its RESULTS then
// differ, and a reader comparing two sweeps has to know whether the models changed or the question did. So every sweep
// appends one record to `<sweepDir>/sweeps.jsonl`, carrying the spec file's text as it ran, and the page (a Spec card),
// spec.md and page.json show that version, who ran it, and the diff against the previous sweep's.
//
// Only the spec FILE is recorded: a module it imports (a shared predicate) is covered by the build fingerprint, which
// hashes the whole tree's uncommitted diff, not by this.

import { readFile, appendFile, readdir, rename, mkdir, stat } from "node:fs/promises";
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
export async function recordSweep(sweepDir, { specPath, onDisk = null, source, fingerprint, dirty, by }) {
    // `onDisk`: where the file was on the machine that ran the sweep, so a reader can open it; `spec` stays the path in
    // the repo, which is what means the same thing on another clone.
    const rec = { op: "sweep", at: new Date().toISOString(), by: String(by).slice(0, 200), spec: specPath, ...(onDisk ? { onDisk } : {}), specHash: specHash(source), fingerprint, dirty: !!dirty, specSource: source };
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
    // A record from before `onDisk` was kept has none, and is shown by its repo path.
    const brief = (r) => ({ at: r.at, by: r.by, specHash: r.specHash, fingerprint: r.fingerprint, dirty: r.dirty, spec: r.spec, onDisk: r.onDisk ?? null });
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
    const lines = [`# Spec`, "", `This sweep ran \`${p.onDisk ?? p.spec}\` (spec ${p.specHash}), started by ${p.by} at ${p.at}, on build ${p.fingerprint}${p.dirty ? " (uncommitted changes)" : ""}.`, ""];
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

/** Where a sweep keeps the runs a later run of the same cell replaced: `history/<cell path>/<when>-<key>/`. */
export const HISTORY = "history";

/**
 * Move a cell's earlier run out of the way before the cell runs again in place (a new spec or build changed its key,
 * `--no-cache`, an errored run retried), instead of deleting it: `history/<cell path>/<when>-<key>/`. A measured run is
 * often the only copy (a sweep before the store, or with sync off), and a re-run under the same sweep name replaced it
 * without a word. Resolves the path it moved to, relative to the sweep, or null when there was no run there.
 */
export async function keepEarlierRun(sweepDir, cellRel) {
    const dir = path.join(sweepDir, cellRel);
    let saved = null, when;
    try {
        when = (await stat(path.join(dir, "cell.json"))).mtime;
        saved = JSON.parse(await readFile(path.join(dir, "cell.json"), "utf8"));
    } catch {
        // No cell.json: a run that never finished. Kept too when it left a transcript, which is all there is of it.
        try { when = (await stat(path.join(dir, "run.md"))).mtime; } catch { return null; }
    }
    const stamp = when.toISOString().replace(/[:.]/g, "-");
    // The key's first characters name which version it was; filesystem-safe, so a key is never a path.
    const tag = saved?.key ? String(saved.key).replace(/[^\w-]+/g, "").slice(0, 8) || "nokey" : "unfinished";
    const rel = path.join(HISTORY, cellRel, `${stamp}-${tag}`);
    await mkdir(path.dirname(path.join(sweepDir, rel)), { recursive: true });
    await rename(dir, path.join(sweepDir, rel));
    return rel;
}

/** Every run kept in a sweep's history: `{ rel, cellPath }`, `rel` its directory relative to the sweep. */
export async function historyRuns(sweepDir) {
    const out = [];
    const walk = async (rel) => {
        let entries;
        try { entries = await readdir(path.join(sweepDir, rel), { withFileTypes: true }); } catch { return; }
        if (entries.some((e) => e.isFile() && (e.name === "cell.json" || e.name === "run.md"))) {
            out.push({ rel, cellPath: path.dirname(path.relative(HISTORY, rel)) });
            return;
        }
        for (const e of entries) if (e.isDirectory()) await walk(path.join(rel, e.name));
    };
    await walk(HISTORY);
    return out.sort((a, b) => a.rel.localeCompare(b.rel));
}
