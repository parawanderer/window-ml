// limits.ts — the read-only exec dialect's refusals (`NotInDialect`, `Denied`, `NeedsPage`) and its halting bounds:
// the step budget, the size caps, the call depth, and the regex backtracking check.

/** The script uses a shape outside the dialect: the caller falls back to the human approval path. */
export class NotInDialect extends Error {}

/** The script reached for something the dialect refuses (a denied property, an effectful call): falls back to approval. */
export class Denied extends Error {}

/** The survey reached for the PAGE while being evaluated in the worker, which has none. Not a refusal of the script:
 *  the caller retries it on the page, where it has a DOM and no run context. A subclass of {@link NotInDialect} on
 *  purpose, so it inherits every guarantee a refusal has: a script's `try/catch` cannot swallow it, the evaluator
 *  rolls back on it, and a caller that does not know this class treats it as a refusal and asks the human, which is
 *  the safe reading. */
export class NeedsPage extends NotInDialect {}

// HALTING. Two properties, deliberately kept apart (docs/dev/readonly-exec.md, "Halting"):
//
//   A. HALTING BY CONSTRUCTION, a property of the language. No script can express an infinite loop: there is no
//      `while`/`for(;;)`/generator/custom iterator, a collection cannot change while it is being iterated (so a
//      loop's trip count is fixed when it starts), and calls nest at most MAX_CALL_DEPTH deep (so recursion is a
//      tree of bounded depth whose every node does finitely much, which is finite). The collection rule went
//      missing when script-created containers became mutable, and `for (const x of a) a.push(x)` ran forever.
//   B. BOUNDED COST, a resource policy. A script that halts can still take very long. The step budget and the size
//      caps below send it to the human gate instead of freezing the page's main thread, and a regex that could
//      backtrack catastrophically (one host call, unbounded) is refused before it runs.

/** Evaluation steps one survey may take: every AST node evaluated and every element iterated costs one. Measured at
 *  about 3.2 million steps a second (M-series laptop), so a runaway holds the page's main thread for under a second,
 *  while a filter-and-map survey over 20,000 table rows uses 207k steps, 7% of it. Deterministic: the same script on
 *  the same page always gets the same answer. */
export const STEP_BUDGET = 3_000_000;

/** The largest array, Set or Map one step may produce. A single host call (`Array(n).join()`, `concat`, `Array.from
 *  ({ length })`) does O(n) work without the budget seeing it, so its size is what bounds its cost. */
export const MAX_COLLECTION = 1_000_000;

/** The most cells one script may read out of STORED tables in total (each read is a request over the whole table). */
export const MAX_STORED_CELLS = 5_000_000;

/** The longest string one step may produce, for the same reason (`repeat`, `padStart`, doubling by `+`). */
export const MAX_STRING = 10_000_000;

/** How deep calls may nest. Recursion is allowed, the way `ml.range` allows a loop: bounded. Deep enough to walk
 *  any real DOM or JSON tree, and far below where the JS stack itself would overflow, so the cap is what stops a
 *  runaway rather than a RangeError a dialect `try` could catch. */
export const MAX_CALL_DEPTH = 256;

/** Characters of pipe INPUT that cost one step. `ml.pipe` is one host call doing work proportional to its input, which
 *  the step budget never sees, so each stage is charged for what it reads. Measured (M-series laptop, 1 MB of mixed
 *  config and prose lines): `sort` is the slowest stage at ~200M chars/s, `sed` 260M, `grep -E` 510M, `head` 2.7G.
 *  At ~3.2M steps/s that makes 64 chars a step for the slowest, so a whole budget spent on pipes is about a second of
 *  sorting, the same bound the budget sets on everything else, and every faster stage is charged MORE than it costs. */
export const PIPE_CHARS_PER_STEP = 64;

/** A regex that can backtrack exponentially: a REPEATED group that itself contains a quantifier or an alternation
 *  (`(a+)+`, `(\w+\s?)*`, `(a|a)+`). V8 has no match timeout, so one `.test()` of such a pattern on a 40-character
 *  string runs for hours in a single host call, where no budget can reach it. Conservative by design: a refused
 *  pattern goes to the human, and `(?:x|y)+` is refused along with the dangerous ones. Returns why, or null. */
export function riskyRegex(source: string): string | null {
    // One frame per open group: whether a quantifier or `|` appears anywhere inside it.
    const stack: { quant: boolean; alt: boolean }[] = [];
    const isRepeat = (s: string, i: number): boolean => {
        const c = s[i];
        if (c === "*" || c === "+") return true;
        if (c !== "{") return false;
        const m = /^\{(\d+)(,(\d*))?\}/.exec(s.slice(i));
        return !!m && (m[2] !== undefined ? (m[3] === "" || Number(m[3]) > 1) : Number(m[1]) > 1);
    };
    const mark = (k: "quant" | "alt") => { for (const f of stack) f[k] = true; };
    for (let i = 0; i < source.length; i++) {
        const c = source[i];
        if (c === "\\") { i++; continue; }
        if (c === "[") {   // a class is one atom: skip to its close
            for (i++; i < source.length && source[i] !== "]"; i++) if (source[i] === "\\") i++;
            continue;
        }
        if (c === "(") {
            stack.push({ quant: false, alt: false });
            // A group's own prefix (`?:`, `?=`, `?!`, `?<=`, `?<!`, `?<name>`) is syntax, not a quantifier.
            if (source[i + 1] === "?") {
                if (source[i + 2] === "<" && source[i + 3] !== "=" && source[i + 3] !== "!") i = source.indexOf(">", i);
                else i += source[i + 2] === "<" ? 3 : 2;
                if (i < 0) return null;
            }
            continue;
        }
        if (c === "|") { mark("alt"); continue; }
        if (c === ")") {
            const g = stack.pop();
            if (g && isRepeat(source, i + 1) && (g.quant || g.alt))
                return g.quant ? "a repeated group that contains a quantifier" : "a repeated group that contains an alternation";
            if (g && isRepeat(source, i + 1)) mark("quant");
            continue;
        }
        if (isRepeat(source, i) || c === "?") mark("quant");
    }
    return null;
}
