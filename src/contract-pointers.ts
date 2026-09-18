// contract-pointers.ts — reading a stored tool output by POINTER, and how much of it the model gets.
//
// A `@tool:<id>` names an output the run captured; DerefValue is what comes back from resolving one, and
// DerefMeta/DerefRead describe it without spending the whole thing. The output cap lives here rather than
// with the tools because it is the same question from the other side: a pointer exists so a large result
// need not sit in the context window, and OUTPUT_CAP is what decides how much of one does. Raising a cap
// costs the agent its own context, which is why outputCapEscalated exists and why that always asks.
// Type-only, so the cycle with contract.ts (which re-exports this file) erases at build entirely.
import type { TableLike, Table } from "./contract-fetch";
import type { TokenKind } from "./contract-render";

/** The pointer's metadata, travelling BESIDE the text so a script can branch on what it got rather than
 *  guessing from the bytes. Every field is JSON-serializable: the same read crosses the page↔background
 *  relay when the run is background-hosted. */
export interface DerefMeta {
    /** The stable id, even when the read came in through a tool-name alias. */
    id: string;
    tool: string;
    kind: TokenKind;
    /** The step that captured it — with the reader's own step, this is the value's age. */
    step: number;
    /** The model's own short name for it, when it gave one. A claim, not a fact. */
    label?: string;
    /** The structural value, when the step produced a grid — no need to reparse a rendered table. A full
     *  {@link TableLike}, so a dereferenced table describes itself exactly as a fetched one does: `shape`,
     *  `columns`, `dtypes`, `rows`. The read-only dialect can traverse it as plain data. */
    table?: TableLike;
    /** The value-store key of the WHOLE table when `table` is only its preview. Present only for a run that holds it. */
    value?: string;
    /** A `data:image/…;base64,…` URL when the step produced an image. */
    image?: string;
    latex?: string;
}

// `readColumns` is attached PAGE-SIDE by the resolver of a background-hosted run when `meta.value` names a stored table;
// it never crosses a message boundary. It is what turns the pointer's table facade into a stored one (asTable).
export interface DerefRead { value: string; warning?: string; meta?: DerefMeta; readColumns?: import("./table-data").StoredColumnReader }

/**
 * What `ml.dereference` resolves to: the pointer's text, with what the loop knows about it attached.
 *
 * It IS a string at runtime (a `String` subclass), so everything that worked when this returned a bare
 * string still does — `JSON.parse(await ml.dereference(id))`, template literals, `.split`, `.length`. The
 * metadata rides along for the cases that had to guess before: whether a value is JSON worth parsing,
 * whether it is an image rather than text, how old it is.
 *
 * The one behaviour that changes: `typeof` is `"object"`, so a `typeof x === "string"` check now fails.
 * Compare `x.text`, or call `String(x)`.
 */
export interface DerefValue extends String {
    /** The text, explicitly — the same string the previous contract returned. */
    readonly text: string;
    /** What this is, from the capturing step's render descriptor. */
    readonly type: TokenKind;
    readonly id: string;
    readonly tool: string;
    readonly step: number;
    readonly label?: string;
    /** The parsed body when the text is JSON, else undefined. Parsed once, lazily. */
    readonly json?: unknown;
    readonly table?: Table;
    readonly image?: string;
    readonly latex?: string;
    /** Reduce it further through the text-pipe dialect, resolving to a new value. */
    pipe(stages: string | string[]): Promise<DerefValue>;
    /** The TS-like shape of it: for a TABLE its `shape` + `dtypes` (the frame without the rows), else the
     *  JSON shape (see `ml.schema`). Throws only on a body that is neither. */
    schema(): string;
}

/** Per-tool output truncation limits. The agent alone is capped at `default` (so it can't spam its own
 *  context); a human can unlock up to `ceiling` for one call, never past it. */
export const OUTPUT_CAP = {
    exec: { default: 500, ceiling: 8000 },
    python_exec: { default: 2000, ceiling: 20000 },
} as const;

/** A tool that HAS an output cap, derived from OUTPUT_CAP so the two cannot drift. Deriving it is the point:
 *  a tool added to the table becomes capped automatically, rather than compiling fine and silently having no
 *  ceiling. */
export type OutputCapTool = keyof typeof OUTPUT_CAP;

/** Resolve a tool call's effective output cap and whether RAISING it is an escalation that needs the human
 *  gate + a justification. `requested` is the call's `maxChars` arg (undefined → the default). A value at or
 *  below the tool default is free — a smaller cap is harmless, so it never escalates. A value above the
 *  default is clamped to the ceiling and flagged `escalated`; `reasonMissing` is true until the model gives a
 *  non-empty `reason`. Pure — unit-tested. The escalation decision is enforced in the trusted world (the
 *  readonly try for exec, autoApprovePython for python), so a page can't forge "this raise is fine". */
export function resolveOutputCap(
    tool: OutputCapTool,
    requested?: unknown,
    reason?: unknown,
): { cap: number; escalated: boolean; reasonMissing: boolean; clamped: boolean; def: number; ceiling: number } {
    const { default: def, ceiling } = OUTPUT_CAP[tool];
    const n = typeof requested === "number" && isFinite(requested) ? Math.floor(requested) : null;
    if (n == null || n <= def) {
        // Absent/invalid → default; a positive smaller value is honored (a tighter cap is always allowed).
        return { cap: n != null && n > 0 ? n : def, escalated: false, reasonMissing: false, clamped: false, def, ceiling };
    }
    const cap = Math.min(n, ceiling);
    const hasReason = typeof reason === "string" && reason.trim().length > 0;
    return { cap, escalated: true, reasonMissing: !hasReason, clamped: n > ceiling, def, ceiling };
}

/** True when a call's `maxChars` raises the cap above the tool default (→ must not auto-approve). */
export function outputCapEscalated(tool: OutputCapTool, args: Record<string, unknown>): boolean {
    return resolveOutputCap(tool, (args as { maxChars?: unknown }).maxChars, (args as { maxCharsReason?: unknown }).maxCharsReason).escalated;
}

/** The precheck error shown when a raise lacks its required justification (→ the loop skips the gate and the
 *  model retries WITH a reason, so the human sees the justification on the approval card). Null when fine. */
export function outputCapPrecheck(tool: OutputCapTool, args: Record<string, unknown>): string | null {
    const c = resolveOutputCap(tool, (args as { maxChars?: unknown }).maxChars, (args as { maxCharsReason?: unknown }).maxCharsReason);
    if (c.escalated && c.reasonMissing) return `Error: raising the output limit to ${c.cap} chars needs a justification. Pass \`maxCharsReason\` explaining why THIS call needs more than the default ${c.def} chars — the human sees it when approving. (Prefer returning a filtered summary instead.)`;
    return null;
}
