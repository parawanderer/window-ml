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

/** Where a cell's run starts: the cell's `surface` (null forces the console), else the task's, else the console. */
export const cellSurface = (cell) => (cell.effects.surface !== undefined ? cell.effects.surface : (cell.task.surface ?? null));

/**
 * Whether a cell's run streams its model turns: the cell's `stream`, then its `agentOptions.stream`, then the task's
 * the same two ways; unset, what the run's starting point sends (a UI surface streams, as the HUD does; a console
 * `ml.agent` does not, its default).
 */
export function cellStream(cell) {
    const e = cell.effects, t = cell.task;
    const v = [e.stream, e.agentOptions?.stream, t.stream, t.agentOptions?.stream].find((x) => typeof x === "boolean");
    return v ?? !!cellSurface(cell);
}

/**
 * The runOnce options a cell runs with, so the sweep and a held cell's own process (hold.mjs) run it the same way.
 * `env` is what the sweep decided for every cell: `backend`, `dist`, `capture`, `warm`, the spec's `approve` and
 * `timeoutMs`; `extra` adds the caller's hooks (`nextTurn`, `onEvent`, `keep`).
 */
export function runConfig(cell, env, dir, extra = {}) {
    const t = cell.task, e = cell.effects;
    return {
        task: t.task,
        followup: t.followup || "",
        start: t.start || "/step3",
        tools: e.tools !== undefined ? e.tools : (t.tools ?? null),
        python: e.python ?? !!t.python,
        toolTokens: e.toolTokens ?? !!t.toolTokens,
        agentOptions: { ...(t.agentOptions || {}), ...(e.agentOptions || {}) },
        stream: cellStream(cell),
        seed: t.seed || null,
        ...(t.script ? { script: t.script } : {}),
        surface: cellSurface(cell),
        sharedWatches: t.sharedWatches ?? [], watchNotes: t.watchNotes ?? {},
        backend: e.backend ? { ...(env.backend || {}), ...e.backend } : env.backend,
        dist: env.dist ?? null,
        artDir: dir,
        approve: env.approve || "auto",
        capture: env.capture,
        timeoutMs: t.timeoutMs ?? env.timeoutMs ?? 180000,
        // A sweep is a machine reading a matrix: no sidebar to focus, no browser to hold open, and the per-event chatter
        // would bury the progress line.
        focusSidebar: false,
        hold: false,
        warm: env.warm,
        log: () => {},
        ...extra,
    };
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
        // Only when on, so a cache written before streaming was a knob (every run non-streamed) stays valid.
        ...(cellStream(cell) ? { stream: true } : {}),
        task: {
            id: cell.task.id, task: cell.task.task, start: cell.task.start ?? null,
            tools: cell.task.tools ?? null, python: !!cell.task.python, toolTokens: !!cell.task.toolTokens,
            followup: cell.task.followup ?? "", seed: cell.task.seed ? { task: cell.task.seed.task, script: String(cell.task.seed.script) } : null,
            script: cell.task.script ? String(cell.task.script) : null,
            agentOptions: cell.task.agentOptions ?? null,
            // Only when set, so adding these fields left every cache written before them valid.
            ...Object.fromEntries(["asks", "surface", "sharedWatches", "watchNotes"]
                .filter((k) => cell.task[k] != null).map((k) => [k, cell.task[k]])),
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
