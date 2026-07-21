// Agent approval gate + step/args formatting for window.ml. The default confirm()
// approval, the onStep console tracer, approval-decision normalisation, and the
// read-only-exec result envelope. Extracted from injected.ts — these close over
// only imported dom/security helpers, no bus/ml state.

import type { ApprovalRequest, ApprovalDecision } from "./contract";
import { clip, elPath } from "./dom";
import { suspiciousArgsWarning } from "./security";

export const renderArgs = (args: unknown): string => Object.entries(args || {})
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
export function formatReadonlyExec(result: unknown, logs: string[]): { result: string; elements?: Node[] } {
    const logged = logs.length ? `console:\n${clip(logs.join("\n"), 500)}` : "";
    const withLogs = (value: string) => logged ? `${logged}\n\nvalue: ${value}` : value;
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
    let value: string;
    if (result === undefined) value = "(undefined)";
    else if (typeof result === "object") { try { value = clip(JSON.stringify(result), 500); } catch { value = clip(String(result), 500); } }
    else value = clip(String(result), 500);
    return { result: withLogs(value) };
}
