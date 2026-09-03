// cells.mjs — expand a spec into the runs it describes, and give each one a stable identity.
//
// Pure: no browser, no disk. That is what lets `--dry` print the exact matrix before an hours-long sweep
// commits to it, and lets the expansion be unit-tested rather than trusted.

import { createHash } from "node:crypto";

/** Filesystem- and table-safe form of a dimension value or task id. */
export const slug = (v) => String(v).replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "x";

/** The cartesian product of the named axes, in declaration order. */
export function combos(dimensions) {
    const keys = Object.keys(dimensions || {});
    if (!keys.length) return [{}];
    return keys.reduce((acc, k) => acc.flatMap((c) => dimensions[k].map((v) => ({ ...c, [k]: v }))), [{}]);
}

/**
 * Parse `--only k=v` / `--skip k=v` selectors. Values are compared as strings, so `--only repeat=0` works
 * alongside `--only model=gemma4:31b`, and `task` selects by task id.
 */
export function parseSelector(list) {
    const out = [];
    for (const s of list || []) {
        const i = String(s).indexOf("=");
        if (i > 0) out.push({ key: s.slice(0, i), value: s.slice(i + 1) });
    }
    return out;
}

/** Does this cell match every `--only` (if any) and no `--skip`? */
export function selected(cell, only, skip) {
    const field = (k) => (k === "task" ? cell.task.id : k === "repeat" ? String(cell.repeat) : cell.combo[k]);
    const eq = (s) => String(field(s.key) ?? "") === s.value;
    if (only.length && !only.every(eq)) return false;
    if (skip.some(eq)) return false;
    return true;
}

/**
 * Expand a spec into one cell per (combination x task x repeat).
 *
 * A cell carries everything needed to run it — the resolved effects, the task, the repeat index — so the
 * runner never consults the spec again. That keeps scheduling (and caching, and resume) a function of the
 * cell alone.
 */
export function expandCells(spec, { only = [], skip = [], repeats } = {}) {
    const n = repeats ?? spec.repeats ?? 5;
    const cells = [];
    for (const combo of combos(spec.dimensions)) {
        let effects = {};
        if (typeof spec.apply === "function") effects = spec.apply(combo) || {};
        for (const task of spec.tasks) {
            for (let repeat = 0; repeat < n; repeat++) {
                const cell = { combo, task, repeat, effects };
                if (selected(cell, only, skip)) cells.push(cell);
            }
        }
    }
    return cells;
}

/** A short, readable label for one combination: `idFormat=label model=gemma4-31b`. */
export function comboLabel(combo) {
    const parts = Object.entries(combo).map(([k, v]) => `${k}=${v}`);
    return parts.length ? parts.join(" ") : "(single)";
}

/** The artifact path for a cell, relative to the sweep root. */
export function cellPath(cell) {
    const c = Object.entries(cell.combo).map(([k, v]) => `${slug(k)}-${slug(v)}`).join("_") || "base";
    return `${slug(cell.task.id)}/${c}/r${cell.repeat}`;
}

/**
 * The cache key: everything that could change the result.
 *
 * The build FINGERPRINT is in the key on purpose. A sweep's cells are only comparable if they ran against
 * the same code, so an edit to the extension must invalidate what was already measured rather than let a
 * report silently mix two builds. Uncommitted changes are part of the fingerprint for the same reason.
 */
export function cellKey(cell, fingerprint) {
    const material = JSON.stringify({
        fingerprint,
        combo: cell.combo,
        repeat: cell.repeat,
        effects: cell.effects,
        task: {
            id: cell.task.id, task: cell.task.task, start: cell.task.start ?? null,
            tools: cell.task.tools ?? null, python: !!cell.task.python, toolTokens: !!cell.task.toolTokens,
            followup: cell.task.followup ?? "", seed: cell.task.seed ? { task: cell.task.seed.task, script: String(cell.task.seed.script) } : null,
            script: cell.task.script ? String(cell.task.script) : null,
            agentOptions: cell.task.agentOptions ?? null,
        },
    });
    return createHash("sha256").update(material).digest("hex").slice(0, 16);
}

/** Group cells by the variant build they need, so each distinct build is produced once. */
export function buildGroups(cells) {
    const groups = new Map();
    for (const cell of cells) {
        const defines = cell.effects.defines || {};
        const id = Object.keys(defines).length
            ? createHash("sha256").update(JSON.stringify(Object.entries(defines).sort())).digest("hex").slice(0, 12)
            : "default";
        if (!groups.has(id)) groups.set(id, { id, defines, cells: [] });
        groups.get(id).cells.push(cell);
    }
    return [...groups.values()];
}
