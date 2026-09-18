// Agent approval gate + step/args formatting for window.ml. The default confirm()
// approval, the onStep console tracer, approval-decision normalisation, and the
// read-only-exec result envelope. Extracted from injected.ts — these close over
// only imported dom/security helpers, no bus/ml state.

import type { ApprovalRequest, ApprovalDecision, RenderDescriptor } from "./contract";
import { UI_OUT_CAP } from "./contract";
import { NotInDialect, Denied } from "./readonly-exec";
import { clipOut, clipValue, elPath } from "./dom";
import { suspiciousArgsWarning } from "./security";

// In an approval prompt the DATA SOURCE (which sheet/table/image/url this call touches) is what
// the human most needs to see — but a long `code`/`js` blob renders first by insertion order and
// pushes it off-screen. Rank context keys to the top and the code blob to the bottom (stable sort
// keeps everything else in insertion order), so "which sheet is it pulling?" is the first line.
const ARG_FRONT = ["tables", "url", "image", "selector", "index", "mode", "cast", "tableRaw"];
const ARG_BACK = ["code", "js"];
const argRank = (k: string): number => {
    const f = ARG_FRONT.indexOf(k);
    return f !== -1 ? f : ARG_BACK.includes(k) ? 1000 : 500;
};
/**
 * Render a tool's arguments for an approval prompt.
 * String values shown raw (real newlines — so an exec `js` blob is readable, not escaped JSON),
 * others as compact JSON.
 *
 * @param {Object} args The arguments to render.
 * @returns {string} The rendered arguments string.
 */
export const renderArgs = (args: unknown): string => Object.entries(args || {})
    .sort((a, b) => argRank(a[0]) - argRank(b[0]))
    .map(([k, v]) => `${k}:\n${typeof v === "string" ? v : JSON.stringify(v)}`)
    .join("\n\n");

/**
 * Built-in onStep tracer for ml.agent({ logDebug: true }).
 * One console line per event — the model's reasoning, or a tool call with its args, result,
 * and any live DOM nodes (logged as real objects so they're hoverable in devtools).
 * Exposed as ml._logStep so you can also pass it as onStep yourself.
 *
 * @param {{step: number, thought?: string, tool?: string, arguments?: Object, result?: string, elements?: Node[]}} ev The event data.
 */
export const logStep = (ev: { step: number; thought?: string; tool?: string; arguments?: unknown; result?: string; elements?: Node[] }) => ev.thought
    ? console.log(`#${ev.step} 💭`, ev.thought)
    : console.log(`#${ev.step} ${ev.tool}`, ev.arguments, "→", String(ev.result), ...(ev.elements || []));

/**
 * Default approval gate for tools flagged requiresApproval (e.g. exec).
 * A blocking page confirm() showing the tool and its arguments. Console-first,
 * so a native prompt is the right "pause and force approval". If confirm
 * isn't available (non-interactive context) it fails safe to DENY — pass a
 * custom `approve` to ml.agent for headless/automated use.
 *
 * @param {{tool: string, arguments: Object}} req The approval request.
 * @returns {boolean} True if approved, false otherwise.
 */
export const defaultApprove = ({ tool, arguments: args }: ApprovalRequest): boolean => {
    if (typeof window.confirm !== "function") return false;
    return window.confirm(
        `${suspiciousArgsWarning(args)}window.ml agent wants to run "${tool}":\n\n${renderArgs(args)}\n\nAllow this?`
    );
};

/**
 * Normalize what an `approve` gate returned into { approved, feedback, arguments }.
 * The contract accepts a plain boolean OR a rich object so an approval UI can:
 *   • feed a rejection COMMENT back to the model (`feedback`) instead of the
 *     fixed "Denied" string, and
 *   • EDIT the arguments before the tool runs (`arguments`, only on approval).
 * `orig` is the model-proposed arguments — the fallback when none were edited.
 *
 * @param {boolean|{approved: boolean, feedback?: string, arguments?: Object}} result The approval result.
 * @param {Object} orig The original arguments.
 * @returns {{approved: boolean, feedback: string|null, arguments: Object}} Normalized approval result.
 */
export const normalizeApproval = (result: ApprovalDecision, orig: Record<string, unknown>): { approved: boolean; feedback: string | null; arguments: Record<string, unknown> } => {
    if (result && typeof result === "object") {
        const edited = result.approved && result.arguments && typeof result.arguments === "object";
        return {
            approved: !!result.approved,
            feedback: typeof result.feedback === "string" && result.feedback.trim() ? result.feedback.trim() : null,
            arguments: edited && result.arguments ? result.arguments : orig
        };
    }
    return { approved: !!result, feedback: null, arguments: orig };
};

/** Format a read-only interpreter result the same way the `exec` tool does
 * (console-prefix + value / element-count envelope), for the auto-approve
 * fast-path in the agent loop.
 */
/** Did the read-only attempt fail because the DIALECT refused, or because the SCRIPT was wrong?
 *
 *  The distinction decides whether a human is interrupted. A refusal (`NotInDialect` / `Denied`) means the
 *  script asked for a real capability the dialect withholds — `input.select()`, a `while` loop, a token spend
 *  — and approving it is a decision a person can meaningfully make, so the attempt falls through to the gate.
 *
 *  Anything else is the script throwing: a method that does not exist, a null receiver, a bad regex, a pandas
 *  reach on a table facade. No approval can fix any of those — the approved run throws the same error a
 *  moment later, having spent a human interrupt on a typo. Those are REPORTED to the model instead, which can
 *  read the error and try again, and nothing unsafe has run either way: every effect is gated before it
 *  happens, and `evalReadonly` restores the answer set when an attempt fails.
 *
 *  Kept here, beside the shared result formatter, because the page loop and the background loop both have to
 *  answer it the same way — and it is exactly the sort of policy that rots when it lives in two catch blocks. */
export function readonlyRefused(e: unknown): boolean {
    return e instanceof NotInDialect || e instanceof Denied;
}

/** A read-only survey's result, twice: the model-facing string (`console:` then `value:`, clipped to the
 *  dialect's 500-character budget) and the UI's `exec-out` descriptor, which an approved `exec` has always
 *  had — console and value as their own sections, the rendered⇄raw toggle, and `seen` marking where the
 *  model's view of the console ended. Without it an auto-approved survey rendered as one raw blob beside an
 *  approved one's cell. The model's string is byte-identical either way (the raw-view rule).
 *
 *  An ELEMENT result keeps no descriptor here: the caller's `descriptorFor` draws it as the hoverable
 *  element list, which is more use than its path as text. */
export function formatReadonlyExec(result: unknown, logs: string[]): { result: string; elements?: Node[]; render?: RenderDescriptor } {
    const MODEL_CAP = 500;
    const joined = logs.join("\n");
    const logged = logs.length ? `console:\n${clipOut(joined, MODEL_CAP)}` : "";
    const withLogs = (value: string) => logged ? `${logged}\n\nvalue: ${value}` : value;
    // The panel keeps more of the value than the model's 500 characters, and marks where the model's copy ended.
    const render = (v: { ui: string; seen?: number }): RenderDescriptor => ({
        type: "exec-out",
        ...(logs.length ? { stdout: clipOut(joined, UI_OUT_CAP), seen: Math.min(joined.length, MODEL_CAP) } : {}),
        value: v.ui,
        ...(v.seen != null ? { valueSeen: v.seen } : {}),
    });
    if (typeof Element !== "undefined" && result instanceof Element) {
        return { result: withLogs(elPath(result)), elements: [result] };
    }
    const isNodes = !!result && (
        (typeof NodeList !== "undefined" && result instanceof NodeList) ||
        (typeof HTMLCollection !== "undefined" && result instanceof HTMLCollection) ||
        (Array.isArray(result) && result.length > 0 && result.every((n: unknown) => typeof Element !== "undefined" && n instanceof Element))
    );
    if (isNodes) {
        const nodes = Array.from(result as ArrayLike<Node>);
        return { result: withLogs(`${nodes.length} element(s)`), elements: nodes.slice(0, 50) };
    }
    let full: string;
    if (result === undefined) full = "(undefined)";
    else if (typeof result === "object") { try { full = JSON.stringify(result); } catch { full = String(result); } }
    else full = String(result);
    const v = clipValue(full, MODEL_CAP, UI_OUT_CAP);
    return { result: withLogs(v.model), render: render(v) };
}
