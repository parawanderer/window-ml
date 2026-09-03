// A vector, with the one operation anyone actually wants from it. Pure — no chrome, no fetch, no config.
//
// The class exists so that "how similar are these two things" is one call that cannot be got subtly wrong.
// Cosine similarity is a dot product ONLY for unit vectors, and every embedding model measured here returns
// unit vectors — which is exactly the condition that invites code to assume it. A model that does not (or a
// truncated Matryoshka prefix, which is NOT unit-length after slicing) would then produce similarities that
// are wrong but plausible: never an error, just quietly mis-ranked results. So vectors are normalised on
// construction and the invariant is enforced rather than trusted.

/** Anything below this and the vector carries no direction to compare — an all-zero or denormal embedding,
 *  which means the model failed rather than that the text was meaningless. */
const MIN_NORM = 1e-8;

export class Embedding {
    /** Unit-length, always: `dot` is cosine BY CONSTRUCTION rather than by assumption. */
    readonly values: readonly number[];

    private constructor(values: readonly number[]) { this.values = values; }

    /** Wrap a raw vector, normalising it. Throws on input that cannot be a direction — an empty vector, a
     *  NaN or Infinity (which would silently poison every later comparison), or an all-zero vector. */
    static from(raw: readonly number[] | Float32Array): Embedding {
        const v = Array.from(raw, Number);
        if (!v.length) throw new Error("Embedding: empty vector (the model returned no dimensions).");
        let sum = 0;
        for (let i = 0; i < v.length; i++) {
            if (!Number.isFinite(v[i])) throw new Error(`Embedding: non-finite value at index ${i} (${v[i]}) — a NaN here silently poisons every later comparison.`);
            sum += v[i] * v[i];
        }
        const norm = Math.sqrt(sum);
        if (norm < MIN_NORM) throw new Error("Embedding: zero-length vector — the model returned no direction to compare.");
        // Already unit-length (every model measured here is) → keep the values EXACTLY, so a round trip
        // through this class cannot perturb them; otherwise scale once.
        return new Embedding(Math.abs(norm - 1) < 1e-6 ? v : v.map((x) => x / norm));
    }

    get dims(): number { return this.values.length; }

    /** Cosine similarity in −1..1. Mismatched dimensions THROW rather than comparing a prefix: two models'
     *  vectors are different geometries, and a number computed across them is meaningless in a way no caller
     *  could detect downstream. */
    dot(other: Embedding): number {
        if (other.dims !== this.dims) {
            throw new Error(`Embedding: dimension mismatch (${this.dims} vs ${other.dims}). These came from different models; a similarity between them means nothing.`);
        }
        let sum = 0;
        for (let i = 0; i < this.values.length; i++) sum += this.values[i] * other.values[i];
        // Floating-point drift can push a self-comparison a hair past 1.0; clamp so callers can compare
        // against thresholds without defending against 1.0000000000000002.
        return sum > 1 ? 1 : sum < -1 ? -1 : sum;
    }

    /** Rank `candidates` against this vector, most similar first. The shape every caller wants: not "which is
     *  closest" but "which are closest, and by how much" — because the useful guard is the MARGIN between the
     *  best and the runner-up, not the best score alone. */
    rank<T>(candidates: readonly { key: T; embedding: Embedding }[]): { key: T; score: number }[] {
        return candidates
            .map((c) => ({ key: c.key, score: this.dot(c.embedding) }))
            .sort((a, b) => b.score - a.score);
    }
}
