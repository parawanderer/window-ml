// state-rows.ts — the rows the state inspector shows for a run's messages and pointers, shaped one way whichever realm
// hosts the run (the worker's registry in sw-runs.ts, the page's in page-run-state.ts), so a page-hosted run reads like a
// background one.

import type { NeutralMessage } from "../contract";
import type { TokenValue } from "../pointers/token-pipe";

/** How much of each message's text the inspector is handed: enough to recognise it, never the whole context. */
const MESSAGE_PREVIEW = 160;

/**
 * A message as `ml.current.messages` holds it, with its text cut to a preview (`…` where it was cut). The SAME field
 * names and nothing added, so a path copied from the panel names what the model reads. A tool call keeps its name; its
 * arguments are in the transcript.
 * @param m the message
 */
export const messageRow = (m: NeutralMessage) => {
    const c = typeof m.content === "string" ? m.content : "";
    return {
        role: m.role,
        content: c.length > MESSAGE_PREVIEW ? `${c.slice(0, MESSAGE_PREVIEW)}…` : c,
        ...(m.tool_calls?.length ? { tool_calls: m.tool_calls.map((t) => ({ name: t.name })) } : {}),
        ...(m.tool_call_id ? { tool_call_id: m.tool_call_id } : {}),
    };
};

/**
 * One `@tool:` value as the inspector lists it: what it is and how big, never the value itself.
 * @param v the value
 * @param text the run's context as text, or null when it cannot be read
 */
export const pointerRow = (v: TokenValue, text: string | null) => ({
    id: v.id, tool: v.tool, kind: v.kind, label: v.label ?? null, step: v.step, seq: v.seq ?? null, ts: v.t,
    chars: (v.full ?? v.out).length, shownChars: v.out.length, rows: v.table?.shape?.[0] ?? null,
    image: !!v.image,
    // The value-store key of its whole body, when the pointer holds only a preview (`run.values` has the row).
    stored: v.value ?? null,
    // Whether the context the next model call gets still MENTIONS it. Null when that context cannot be read.
    linked: text == null ? null : text.includes(v.id),
});

/** A context's messages as one text, for finding which pointers it still mentions. */
export const contextTextOf = (msgs: readonly NeutralMessage[]): string =>
    msgs.map((m) => `${typeof m.content === "string" ? m.content : ""}${m.tool_calls ? JSON.stringify(m.tool_calls) : ""}`).join("\n");
