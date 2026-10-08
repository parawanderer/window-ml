// state-watch.ts — WATCHES over a run's state (docs/spec/STATE_INSPECTOR.md, "Watches"): an expression you pin in the
// Run state panel, re-read with it. Pure, so the worker evaluates it beside the snapshot it reads and a test enumerates it.
//
// A watch is the same expression the panel names a member by, and that "Copy path" copies: `inspector.run.init.task`,
// `ml.current.messages[0].text`. Under it is RFC 9535 JSONPath over one tree built from the snapshot (`{ ml: { current },
// inspector }`), so a watch may also be any JSONPath (`$.inspector.run.pointers[?@.rows > 1000].label`). No evaluator of
// its own and no `eval`: the JSONPath module is the one the read-only dialect hands a model, with the same two bounds,
// every node visited charged to a budget, and a regex that could backtrack for hours refused before it is compiled.

import { mlJsonPath, type JsonPathNode } from "./json-path";
import { riskyRegex } from "./readonly-exec/limits";
import type { StateEntry, StateMember } from "./state-registry";

/** How many watches a panel may ask for at once: a list a person keeps, not a script. */
export const MAX_WATCHES = 32;
/** The longest watch expression accepted: a path or a query, never a program. */
export const MAX_WATCH_CHARS = 1024;
/** Nodes one watch may visit before it is stopped. A path visits a handful; `$..*` over a big context visits them all. */
export const WATCH_NODE_BUDGET = 200_000;

/** One watch's answer: what it matched (each with its normalized path), or why it could not be read. */
export interface WatchResult {
    expr: string;
    nodes?: JsonPathNode[];
    error?: string;
}

/** The roots a watch may start from. Anything else is a typo, said as one rather than evaluated as "no match". */
const ROOTS = /^(?:ml\.current|inspector)(?:$|[.[])/;

/**
 * The query a watch expression stands for: a panel path gets `$.` in front, a JSONPath is itself.
 * @param expr what was typed or copied
 * @returns the JSONPath, or an error sentence
 */
export function watchQuery(expr: string): { query: string } | { error: string } {
    const e = expr.trim();
    if (!e) return { error: "an empty watch" };
    if (e.length > MAX_WATCH_CHARS) return { error: `longer than ${MAX_WATCH_CHARS} characters` };
    if (e.startsWith("$")) return { query: e };
    if (ROOTS.test(e)) return { query: `$.${e}` };
    return { error: "a watch starts at inspector. or ml.current. (as the panel names its members), or is a JSONPath starting at $" };
}

/**
 * The one tree every watch reads: each member's value placed at its expression's path. A member's id is dotted
 * (`run.init`), so it nests (`inspector.run.init`); one the model reads sits under `ml.current` instead.
 * @param members the members to place
 * @param entries what they hold
 */
export function stateTree(members: readonly StateMember[], entries: readonly StateEntry[]): Record<string, unknown> {
    const tree: Record<string, unknown> = { ml: { current: {} }, inspector: {} };
    const byId = new Map(entries.map((e) => [e.id, e]));
    for (const m of members) {
        const e = byId.get(m.id);
        if (!e || e.error) continue;
        const keys = (m.exposedAs ?? `inspector.${m.id}`).split(".");
        let at = tree;
        for (const k of keys.slice(0, -1)) at = (at[k] ??= {}) as Record<string, unknown>;
        at[keys[keys.length - 1]] = e.value;
    }
    // JSON, as a watch reads it: a member's `undefined` fields are left out (the evaluator takes JSON only), exactly
    // as copying the member would leave them out.
    return JSON.parse(JSON.stringify(tree)) as Record<string, unknown>;
}

/**
 * Evaluate one watch over the tree, bounded as the dialect bounds a model's `ml.jsonPath`.
 * @param tree from {@link stateTree}
 * @param expr the watch
 */
export function evalWatch(tree: Record<string, unknown>, expr: string): WatchResult {
    const q = watchQuery(expr);
    if ("error" in q) return { expr, error: q.error };
    let spent = 0;
    try {
        const nodes = mlJsonPath(tree, q.query, { paths: true }, {
            charge: (n) => { if ((spent += n) > WATCH_NODE_BUDGET) throw new Error(`stopped after visiting ${WATCH_NODE_BUDGET.toLocaleString("en")} values: narrow it`); },
            onPattern: (src) => { const why = riskyRegex(src); if (why) throw new Error(`the pattern ${JSON.stringify(src)} has ${why}, which can run for hours`); },
        }) as JsonPathNode[];
        return { expr, nodes };
    } catch (e) {
        return { expr, error: e instanceof Error ? e.message : String(e) };
    }
}

/**
 * The watches a panel sent, made safe to evaluate: strings only, at most {@link MAX_WATCHES}, duplicates dropped.
 * @param raw the payload's `watches`
 */
export function watchList(raw: unknown): string[] {
    if (!Array.isArray(raw)) return [];
    const out: string[] = [];
    for (const w of raw) if (typeof w === "string" && !out.includes(w) && out.length < MAX_WATCHES) out.push(w);
    return out;
}

/**
 * A normalized path (`$['ml']['current']['messages'][0]`) written the way the panel names things
 * (`ml.current.messages[0]`), so a row inside a watch copies and watches like any other row.
 * @param normalized an RFC 9535 normalized path, as a match reports it
 */
export function panelPath(normalized: string): string {
    let out = "";
    for (const m of normalized.slice(1).matchAll(/\['((?:[^'\\]|\\.)*)'\]|\[(\d+)\]/g)) {
        if (m[2] != null) { out += `[${m[2]}]`; continue; }
        const key = m[1].replace(/\\(.)/g, "$1");
        out += /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) ? `${out ? "." : ""}${key}` : `[${JSON.stringify(key)}]`;
    }
    return out;
}
