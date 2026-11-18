// sw-policy-view.ts — the effective policies of one session as rows: which entry wins over which, and what taking one away would change.
//
// docs/spec/POLICIES.md, "The effective view". PURE: it takes the lists and answers rows, so the store (sw-policies.ts) and a test
// feed it the same way, and nothing here names a consumer. A row is {consumer, layer, entry, wins, ...}; a consumer that does not
// exist yet (the files host's hide and show) needs only a removal class registered here, not a change to the read.

import type { PolicyEffect } from "../readonly-exec";

/** Where a row sits: the built-in default under everything, then the person's global policies, then the session's own. */
export type PolicyLayer = "default" | "global" | "session";

/** What a row shows of one policy: its words and its verdict, nothing a call carried (the read has no value field). */
export interface PolicyEntry { id: string; label: string; source: string; effect: PolicyEffect; origin?: string; created?: number; broken?: string }

/** What removing a row does to what runs without asking. */
export interface PolicyRemoval {
    /** `narrows`: only fewer calls run unasked (an allow goes), one gesture. `widens`: more calls may run (a deny or an ask goes), the page confirms first. */
    class: "narrows" | "widens";
    /** For a widening removal, the rows that would decide the calls this one decided: what becomes reachable. */
    exposes: Pick<PolicyEntry, "id" | "label" | "effect">[];
}

/** One policy, placed among the others of its consumer. */
export interface PolicyRow {
    consumer: string;
    layer: PolicyLayer;
    entry: PolicyEntry;
    /** No other row of this consumer is stricter, so on a call this row matches, it decides (or ties with a row of its own effect). */
    wins: boolean;
    /** The ids of the rows this one beats on a call both match: stricter effects only. Never the default. */
    overrides: string[];
    /** The ids of the rows that beat this one on a call both match. */
    overriddenBy: string[];
    /** Absent on the default row, which cannot be removed. */
    removal?: PolicyRemoval;
}

/** The strictness `judgeCall` applies across every scope: a `deny` refuses, then an `ask` asks, then an `allow` lets it run. */
const STRICT: Record<PolicyEffect, number> = { deny: 3, ask: 2, allow: 1 };

/** The id of the default row. */
export const DEFAULT_ROW_ID = "builtin";

/** Decides whether removing a policy of a consumer narrows or widens. */
export type RemovalClassifier = (p: PolicyEntry) => "narrows" | "widens";

const classifiers = new Map<string, RemovalClassifier>();   // state: plumbing — registered by a consumer's module at load

/** The rule every consumer starts with: an allow removed narrows, a deny or an ask removed widens. */
const byEffect: RemovalClassifier = (p) => (p.effect === "allow" ? "narrows" : "widens");

/**
 * Give a consumer its own removal classes, where the default (by effect) is not the whole story.
 * @param consumer the consumer's name
 * @param fn the classifier for an entry of that consumer
 */
export function registerRemovalClass(consumer: string, fn: RemovalClassifier): void { classifiers.set(consumer, fn); }

/** The input to {@link effectiveRows}: a stored policy, in the shape the store keeps. */
export interface PolicyInput extends PolicyEntry { consumer: string }

/**
 * The session's effective rows: the default row of every consumer that has a policy, the global rows, then the session's, each
 * placed against the others of its consumer. The layers never change a verdict (`judgeCall` takes the strictest across them),
 * so "overrides" follows strictness alone; a layer only decides which of two rows of the same effect is named.
 * @param globals the person's global policies, in the store's order
 * @param session the session's own policies, in the store's order
 * @param builtin the default policy's words
 * @returns the rows, default first
 */
export function effectiveRows(globals: readonly PolicyInput[], session: readonly PolicyInput[], builtin: { label: string; source: string }): PolicyRow[] {
    const placed: { consumer: string; layer: PolicyLayer; entry: PolicyEntry }[] = [];
    const consumers = [...new Set([...globals, ...session].map((p) => p.consumer))];
    for (const consumer of consumers) placed.push({ consumer, layer: "default", entry: { id: DEFAULT_ROW_ID, label: builtin.label, source: builtin.source, effect: "allow" } });
    for (const p of globals) placed.push({ consumer: p.consumer, layer: "global", entry: entryOf(p) });
    for (const p of session) placed.push({ consumer: p.consumer, layer: "session", entry: entryOf(p) });
    const beats = (a: PolicyEntry, b: PolicyEntry): boolean => STRICT[a.effect] > STRICT[b.effect];
    return placed.map((r) => {
        const mates = placed.filter((o) => o.consumer === r.consumer && o !== r);
        const overrides = r.layer === "default" ? [] : mates.filter((o) => o.layer !== "default" && beats(r.entry, o.entry)).map((o) => o.entry.id);
        const overriddenBy = mates.filter((o) => beats(o.entry, r.entry) && (o.layer !== "default")).map((o) => o.entry.id);
        const row: PolicyRow = { consumer: r.consumer, layer: r.layer, entry: r.entry, wins: !mates.some((o) => beats(o.entry, r.entry)), overrides, overriddenBy };
        if (r.layer !== "default") row.removal = removal(r, mates);
        return row;
    });
}

/** A stored policy as the entry a row shows: only the fields the read carries. */
function entryOf(p: PolicyInput): PolicyEntry {
    return { id: p.id, label: p.label, source: p.source, effect: p.effect, ...(p.origin ? { origin: p.origin } : {}), ...(p.created !== undefined ? { created: p.created } : {}), ...(p.broken ? { broken: p.broken } : {}) };
}

/** What removing `r` does, given the other rows of its consumer. */
function removal(r: { consumer: string; entry: PolicyEntry }, mates: { layer: PolicyLayer; entry: PolicyEntry }[]): PolicyRemoval {
    const cls = (classifiers.get(r.consumer) ?? byEffect)(r.entry);
    if (cls === "narrows") return { class: "narrows", exposes: [] };
    // The rows left to decide what this one decided: the ones it beats that nothing else remaining is stricter than.
    const left = mates;
    const exposes = left
        .filter((o) => STRICT[r.entry.effect] > STRICT[o.entry.effect] && !left.some((x) => x !== o && STRICT[x.entry.effect] > STRICT[o.entry.effect]))
        .map((o) => ({ id: o.entry.id, label: o.entry.label, effect: o.entry.effect }));
    return { class: "widens", exposes };
}
