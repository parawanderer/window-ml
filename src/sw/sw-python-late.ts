// sw-python-late.ts — a detached cell's result, formatted by the service worker that did not start the cell.

// A cell's result normally becomes a task's text through python_exec's own formatter (python-tool.ts `format`), a closure the
// worker that sent the cell holds. A worker started since (the old one was evicted while the cell ran) has no such closure,
// so the result it fetches from the offscreen document (`PY_RESULT`) is read here, plainly: the output cap the tool uses,
// then the value or the error, with a sentence saying the formatting is the plain one. The tool's casts, its table notes and
// the panel's render are not available; the model reads what the cell printed and returned.

import { clipOut } from "../dom/dom";
import { OUTPUT_CAP } from "../contract/contract-pointers";
import type { TaskOutcome } from "./sw-tasks";

/** The sentence a plainly formatted result ends with. */
export const PLAIN_NOTE = "(formatted after the service worker restarted: casts and table notes were not applied.)";

/**
 * A raw cell result as a task's outcome, by the plain rules.
 * @param r the offscreen document's answer for the cell (`{ ok, stdout, value, error, render }`)
 */
export function plainPyOutcome(r: unknown): TaskOutcome {
    const x = (r && typeof r === "object" ? r : {}) as { ok?: unknown; stdout?: unknown; value?: unknown; error?: unknown; render?: unknown };
    const cap = OUTPUT_CAP.python_exec.default;
    const stdout = typeof x.stdout === "string" ? clipOut(x.stdout, cap).replace(/\s+$/, "") : "";
    const pre = stdout ? `stdout:\n${stdout}\n\n` : "";
    if (x.ok === false) return { status: "failed", result: null, text: `${pre}Python error: ${clipOut(String(x.error ?? "unknown error"), cap)}\n${PLAIN_NOTE}` };
    const v = x.value;
    const image = typeof v === "string" && /^data:image\//.test(v) && (x.render === "img" || x.render === "figure") ? v : undefined;
    const body = image ? "Returned an image."
        : v === undefined || v === null ? "(no value returned)"
            : clipOut(typeof v === "string" ? v : (() => { try { return JSON.stringify(v) ?? String(v); } catch { return String(v); } })(), cap);
    return { status: "done", result: null, text: `${pre}${body}\n${PLAIN_NOTE}`, ...(image ? { image } : {}) };
}
