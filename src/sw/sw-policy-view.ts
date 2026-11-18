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
    /** Whose policies the removal changes: `session` this session's alone, `all` a global row's, which every session loses. */
    reach: "session" | "all";
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

/** Whether row `a` beats row `b` on a call both match: the order a consumer's own judge applies. */
export type Precedence = (a: PolicyEntry, b: PolicyEntry) => boolean;

/** The order `judgeCall` applies to a policy consumer: the strictest effect decides. */
const byStrictness: Precedence = (a, b) => STRICT[a.effect] > STRICT[b.effect];

const orders = new Map<string, Precedence>();   // state: plumbing — registered by a consumer's module at load

/**
 * Give a consumer its own order, where its judge is not "the strictest effect decides" (the files host's most-specific-wins, a tie
 * hides). `wins`, `overrides`, `overriddenBy` and a removal's `exposes` all follow it, so a consumer registers the order its judge
 * applies and runs the enumeration test against that judge.
 * @param consumer the consumer's name
 * @param fn whether the first entry beats the second, on a call both match
 */
export function registerPrecedence(consumer: string, fn: Precedence): void { orders.set(consumer, fn); }

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
 * so "overrides" follows strictness, or the order a consumer registered (`registerPrecedence`); a layer only decides which of two
 * rows of the same effect is named.
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
    const beatsFor = (consumer: string): Precedence => orders.get(consumer) ?? byStrictness;
    return placed.map((r) => {
        const beats = beatsFor(r.consumer);
        const mates = placed.filter((o) => o.consumer === r.consumer && o !== r);
        const overrides = r.layer === "default" ? [] : mates.filter((o) => o.layer !== "default" && beats(r.entry, o.entry)).map((o) => o.entry.id);
        const overriddenBy = mates.filter((o) => beats(o.entry, r.entry)).map((o) => o.entry.id);
        const row: PolicyRow = { consumer: r.consumer, layer: r.layer, entry: r.entry, wins: !mates.some((o) => beats(o.entry, r.entry)), overrides, overriddenBy };
        if (r.layer !== "default") row.removal = removal(r, mates, beats);
        return row;
    });
}

/** A stored policy as the entry a row shows: only the fields the read carries. */
function entryOf(p: PolicyInput): PolicyEntry {
    return { id: p.id, label: p.label, source: p.source, effect: p.effect, ...(p.origin ? { origin: p.origin } : {}), ...(p.created !== undefined ? { created: p.created } : {}), ...(p.broken ? { broken: p.broken } : {}) };
}

/** What removing `r` does, given the other rows of its consumer. */
function removal(r: { consumer: string; layer: PolicyLayer; entry: PolicyEntry }, mates: { layer: PolicyLayer; entry: PolicyEntry }[], beats: Precedence): PolicyRemoval {
    const cls = (classifiers.get(r.consumer) ?? byEffect)(r.entry);
    const reach = r.layer === "global" ? "all" : "session";
    if (cls === "narrows") return { class: "narrows", exposes: [], reach };
    // The rows left to decide what this one decided: the ones it beats that nothing else remaining beats.
    const exposes = mates
        .filter((o) => beats(r.entry, o.entry) && !mates.some((x) => x !== o && beats(x.entry, o.entry)))
        .map((o) => ({ id: o.entry.id, label: o.entry.label, effect: o.entry.effect }));
    return { class: "widens", exposes, reach };
}
