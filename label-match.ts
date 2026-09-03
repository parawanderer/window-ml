// Lexical similarity between a reference a model wrote and a label it wrote earlier. Pure: no DOM, no
// config, no I/O — the metric is chosen by the caller so it can be A/B'd.
//
// Levenshtein alone is a poor fit for this particular problem. The strings being compared are short natural
// phrases the model authored itself, and the way it misremembers them is by REWORDING — dropping an article,
// reordering, swapping a near-synonym — not by mistyping characters. Edit distance punishes a word moving
// almost as hard as a word changing, so "the table of sales" scores terribly against "sales table" even
// though a human would call them the same thing.
//
// All three return a SIMILARITY in 0..1 (1 = identical), so they are directly comparable and a threshold
// means the same thing whichever is selected.
import { editDistance } from "./token-pipe";

export const LEXICAL_METRICS = ["hybrid", "edit", "trigram", "tokenset"] as const;
export type LexicalMetric = (typeof LEXICAL_METRICS)[number];

/** Case and whitespace are not what the model was trying to communicate. */
const norm = (s: string): string => s.trim().toLowerCase().replace(/\s+/g, " ");

/** Levenshtein, scaled to 0..1 by the longer string. Good at typos, poor at rewording. */
export function editSimilarity(a: string, b: string): number {
    const x = norm(a), y = norm(b);
    if (!x && !y) return 1;
    const longest = Math.max(x.length, y.length);
    return longest ? 1 - editDistance(x, y) / longest : 0;
}

/** Jaccard over character TRIGRAMS. Order-insensitive enough to survive reordering, but still character-level,
 *  so it degrades gracefully on a typo — the middle ground between the other two. */
export function trigramJaccard(a: string, b: string): number {
    const grams = (s: string): Set<string> => {
        const p = `  ${norm(s)} `;
        const out = new Set<string>();
        for (let i = 0; i < p.length - 2; i++) out.add(p.slice(i, i + 3));
        return out;
    };
    const A = grams(a), B = grams(b);
    if (!A.size && !B.size) return 1;
    let shared = 0;
    for (const g of A) if (B.has(g)) shared++;
    return shared / (A.size + B.size - shared);
}

/** Jaccard over WORD sets, ignoring stopwords. Completely order-insensitive and blind to typos — the right
 *  choice when the model rewords but spells correctly, which is the common case for a phrase it authored. */
const STOP = new Set(["the", "a", "an", "of", "for", "to", "in", "on", "and", "with", "my", "our", "this", "that"]);
export function tokenSetOverlap(a: string, b: string): number {
    const words = (s: string): Set<string> => {
        const all = norm(s).split(/[^a-z0-9]+/).filter(Boolean);
        const kept = all.filter((w) => !STOP.has(w));
        return new Set(kept.length ? kept : all);   // never let stopword-stripping empty a label entirely
    };
    const A = words(a), B = words(b);
    if (!A.size && !B.size) return 1;
    let shared = 0;
    for (const w of A) if (B.has(w)) shared++;
    return shared / (A.size + B.size - shared);
}

/** The better of trigram and token-set, and the default. Measured on the motivating cases, neither single
 *  metric wins: token-set is perfect on rewording ("sales table" vs "the table of sales" = 1.00) and blind to
 *  typos (0.33), while trigram survives a typo (0.68) and only half-handles rewording (0.48). Taking the max
 *  scores every CORRECT match high (1.00 / 0.68 / 1.00) and every wrong one low (0.36 / 0.36 / 0.11), where
 *  plain edit distance actually INVERTS: it ranks "the pricing table" (a different table, 0.59) above "the
 *  table of sales" (the right one, reworded, 0.33). */
export const hybridSimilarity = (a: string, b: string): number => Math.max(trigramJaccard(a, b), tokenSetOverlap(a, b));

const IMPLS: Record<LexicalMetric, (a: string, b: string) => number> = {
    hybrid: hybridSimilarity,
    edit: editSimilarity,
    trigram: trigramJaccard,
    tokenset: tokenSetOverlap,
};

/** Similarity under the selected metric. An unknown metric falls back to the default rather than throwing —
 *  a stale config value must not break pointer resolution. */
export function lexicalSimilarity(metric: LexicalMetric | string | undefined, a: string, b: string): number {
    return (IMPLS[metric as LexicalMetric] ?? IMPLS.hybrid)(a, b);
}
