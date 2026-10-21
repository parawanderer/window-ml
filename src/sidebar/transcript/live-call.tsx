// live-call.tsx — a tool call the model is still WRITING, drawn as the start of the step it will become: the tool's
// name, and its code, Markdown or argument tree growing with a caret where the text arrives. A liveness signal, like a
// tool's streamed output: a long script or document passed as an argument used to show nothing until the model
// stopped. Display only; the step that replaces it is drawn from the parsed call.

import { useLayoutEffect, useRef } from "preact/hooks";
import { Code, Dot } from "../ui-kit";
import { markdown } from "../format";
import { closeStreaming } from "./stream-close";
import { JsonNode } from "./json-tree";
import { liveCallView } from "./live-call-view";
import type { LiveToolCall } from "../../contract";

/** "1.2k chars" for a count of characters. */
const chars = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(1)}k chars` : `${n} chars`);

/**
 * A tool call still being written, open, in the shape of a pending `.astep` so the step that lands in its place does
 * not jump: the name once the stream has said it, how much has arrived, and the arguments so far.
 *
 * @gallery {"call":{"index":0,"name":"python_exec","args":"{\"code\": \"import math\\nfor i in range(3):\\n    print(math.sqrt(i))\\nprint(\\\"do","chars":78}}
 * @group transcript
 */
export function LiveCall({ call }: { call: LiveToolCall }) {
    const v = liveCallView(call);
    // FOLLOW THE TEXT, like a terminal: past its height cap the body scrolls, and the line being written is the one to
    // see. Until the reader scrolls up to read an earlier line, which stops the follow; scrolling back down resumes it.
    const body = useRef<HTMLDivElement>(null);
    const follow = useRef(true);
    useLayoutEffect(() => { const el = body.current; if (el && follow.current) el.scrollTop = el.scrollHeight; });
    const onScroll = (): void => { const el = body.current; if (el) follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 8; };
    return (
        <div class="astep tool pending open live-call" data-live-call={call.index}>
            <div class="astep-head">
                <Dot status="pending" />
                <span class="tool-name">{call.name ?? "tool call"}</span>
                <span class="astep-preview dim">writing… {chars(call.chars)}</span>
            </div>
            <div class="astep-body" ref={body} onScroll={onScroll}>
                {v.kind === "text" && v.as !== "markdown"
                    ? <div class={`live-call-code${v.writing ? " writing" : ""}`}><Code text={v.text} lang={v.as} /></div>
                    : v.kind === "text"
                        ? <div class={`md live-call-md${v.writing ? " writing" : ""}`} dangerouslySetInnerHTML={{ __html: markdown(closeStreaming(v.text) || "\u200b", { math: true }) }} />
                        : v.kind === "tree"
                            ? <div class="jt-args">
                                <JsonNode v={v.value} allOpen defaultOpen />
                                {v.writing ? <span class="live-caret" aria-hidden="true" /> : null}
                              </div>
                            : v.kind === "raw"
                                ? <div class="live-call-code writing"><Code text={v.text} lang="text" /></div>
                                : <span class="dim">The arguments appear here once the call is complete.</span>}
            </div>
        </div>
    );
}
