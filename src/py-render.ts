// HOW A PYTHON RESULT IS DRAWN — one decision, for the model's `python_exec` step in the log and for the bench.
//
// Both surfaces already draw through the same renderers (the `python-out` sections in render-panel.tsx). What
// they did NOT share was the step before: turning the sandbox's result into that descriptor. The bench had its
// own copy, and it drifted — a sympy return was typeset in the log and shown as raw `\frac{x^{2}}{2}` in the
// bench, because only the tool's copy read the sandbox's `render` hint. This is that decision, lifted out of
// the tool so there is one of it. What stays in each caller is what genuinely differs: the tool's model-facing
// text (hints, clipping, `cast` to a point) and the bench's pretty-printed JSON.

import type { RenderDescriptor } from "./contract";

/** A string that IS LaTeX even without the sandbox's hint — a model that returns `sympy.latex(expr)` (a string)
 *  rather than the expression. A braced sub/superscript or a LaTeX command: specific enough to skip prose. */
export const LOOKS_LATEX = /[\^_]\{|\\(frac|sqrt|left|right|cdot|times|div|sum|prod|int|sin|cos|tan|log|ln|exp|lim|infty|partial|nabla|alpha|beta|gamma|delta|theta|lambda|mu|sigma|pi|begin)\b/;

/** The parts of a `python-out` descriptor that depend on what the script RETURNED (not its stdout). */
export type PyValueParts = Pick<Extract<RenderDescriptor, { type: "python-out" }>, "image" | "value" | "df" | "latex">;

/**
 * What a successful run's return value draws as: an image, a DataFrame, typeset LaTeX, or plain text.
 *
 * @param v the returned value, as the sandbox serialized it (an image arrives as a `data:image/…` string).
 * @param hints the sandbox's `render` hint from the return TYPE, and the structured table for a DataFrame.
 * @param text how this surface writes a value as text — the tool clips it to the model's budget, the bench
 *   pretty-prints it. Returning undefined draws no value section at all.
 */
export function pyValueParts(
    v: unknown,
    hints: { render?: "latex" | "img"; table?: { columns: string[]; rows: (string | number | null)[][] } },
    text: (v: unknown) => string | undefined,
): PyValueParts {
    // An image return is unambiguous, whatever else is set.
    if (typeof v === "string" && /^data:image\//.test(v)) return { image: v };
    const t = text(v);
    if (hints.table) return { ...(t != null ? { value: t } : {}), df: hints.table };
    // Typeset without a `| latex` cast: the sandbox saw a sympy TYPE, or the string is LaTeX itself.
    if (t != null && (hints.render === "latex" || (typeof v === "string" && LOOKS_LATEX.test(v)))) return { value: t, latex: true };
    return t != null ? { value: t } : {};
}
