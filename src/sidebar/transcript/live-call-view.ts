// live-call-view.ts — what a tool call still being WRITTEN is drawn as: its code growing, its Markdown growing, or the
// tree of the arguments so far. Pure, so the choice is tested without a DOM; `LiveCall` (live-call.tsx) draws it.

import type { LiveToolCall } from "../../contract";
import { parseLooseJson } from "../../json-repair";

/** The argument that IS the call, for the tools whose call is one long text: drawn as that text, not as JSON. */
export const LIVE_TEXT_FIELD: Record<string, { field: string; as: "javascript" | "python" | "markdown" }> = {
    exec: { field: "js", as: "javascript" },
    python_exec: { field: "code", as: "python" },
    answer: { field: "text", as: "markdown" },
};

/** One live call's view. `writing` is true while the text the view shows is the part still arriving, which is where
 *  the caret goes. */
export type LiveCallView =
    | { kind: "text"; as: "javascript" | "python" | "markdown"; text: string; writing: boolean }
    | { kind: "tree"; value: object; writing: boolean }
    | { kind: "raw"; text: string }
    | { kind: "size"; chars: number };

/**
 * How to draw `call` right now. A code tool's source (or `answer`'s Markdown) as it stands, once the stream has named
 * the tool; any other call as the tree of its arguments so far; text that is not JSON, verbatim. A preview a hub
 * left the arguments off is only its size.
 */
export function liveCallView(call: LiveToolCall): LiveCallView {
    if (call.args == null) return { kind: "size", chars: call.chars };
    const parsed = parseLooseJson(call.args, { keepOpenString: true });
    const spec = call.name ? LIVE_TEXT_FIELD[call.name] : undefined;
    const v = spec ? (parsed?.value as Record<string, unknown> | undefined)?.[spec.field] : undefined;
    // The text view while its field is a string, or may still become one (the call is unfinished and has not reached
    // it). A finished call without it (`answer` designating an element) is an ordinary tree.
    if (spec && (typeof v === "string" || (v == null && (!call.args.trim() || !!parsed?.repaired)))) {
        // Writing THIS field when the open string is it, or when nothing of it has arrived yet (the caret waits for it).
        // The open string is the root's LAST member: a parse keeps insertion order, and the cut is at the end.
        const writing = v == null || (!!parsed?.openString && parsed.cutPath?.length === 0 && Object.keys(parsed.value).at(-1) === spec.field);
        return { kind: "text", as: spec.as, text: typeof v === "string" ? v : "", writing };
    }
    if (parsed) return { kind: "tree", value: parsed.value, writing: !!parsed.repaired };
    return { kind: "raw", text: call.args };
}
