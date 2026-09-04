// Running ONE OpenWebUI-configured tool ourselves, in our own loop, with the arguments we chose — the
// other shape from upstream's `tool_ids` + `function_calling` loop, which hands the whole loop to a model.
//
// Lives in the service worker because the fetch is privileged: it goes to the configured backend with the
// user's API key, which a page cannot do. The frame semantics are NOT here — `createToolStream` in
// tool-protocol.ts owns those, shared with every other source — so this module is the transport and
// nothing else.
//
// Contract: docs/spec/REMOTE_TOOL_EXECUTION.md. Endpoint: parawanderer/open-webui, ml/tool-execute-api.
import { getConfig, authHeaders } from "./sw-llm";
import { createToolStream, type ToolFrame, type ToolStreamEnd } from "./tool-protocol";

export interface ServerToolCall {
    /** The tool BUNDLE's id, as `ml.serverTools()` lists it. */
    toolId: string;
    /** The function within that bundle — the same pair a model emits as a tool call. */
    name: string;
    args: Record<string, unknown>;
    /** Live frames as they arrive, for a caller streaming output. `at` is when the frame was PRODUCED,
     *  anchored from the executor's own offsets — see tool-protocol.ts. */
    onFrame?: (frame: ToolFrame, at: number) => void;
    signal?: AbortSignal;
}

/**
 * Execute a server-side tool and stream its frames.
 *
 * Errors are split the way the rest of this codebase splits them, because the model can act on one kind
 * and not the other. A tool that THREW comes back as a successful stream whose result frame carries
 * `error` — a normal step outcome. Anything that stopped the stream from being read at all — a non-200, a
 * dead connection, a body that ended without a result frame — comes back `ok: false`, and a caller must
 * not report that to the model as a tool that returned nothing.
 */
export async function executeServerTool({ toolId, name, args, onFrame, signal }: ServerToolCall): Promise<ToolStreamEnd> {
    const config = await getConfig();
    const origin = new URL(config.chatUrl).origin;
    const stream = createToolStream(onFrame);

    let res: Response;
    try {
        res = await fetch(`${origin}/api/v1/tools/id/${encodeURIComponent(toolId)}/execute`, {
            method: "POST",
            headers: { ...authHeaders(config), "Content-Type": "application/json" },
            body: JSON.stringify({ name, arguments: args, stream: true }),
            signal,
        });
    } catch (e) {
        return { ok: false, transportError: `could not reach the tool endpoint: ${(e as Error).message}`, state: stream.state() };
    }

    if (!res.ok) {
        // Everything decided BEFORE the first byte: unknown tool, no access, malformed body. The body is
        // usually the server's own explanation, and truncating it to a length a human reads is better than
        // a bare status.
        const body = await res.text().catch(() => "");
        return {
            ok: false,
            transportError: `the tool endpoint returned ${res.status}${body ? `: ${body.slice(0, 300)}` : ""}`,
            state: stream.state(),
        };
    }
    // An endpoint that does not stream still answers — a single JSON object rather than NDJSON frames. Read
    // it as one `result` frame rather than failing, so a server without the streaming patch degrades to
    // working-without-liveness instead of not working.
    const ctype = res.headers.get("content-type") || "";
    if (!/ndjson/i.test(ctype)) {
        const body = await res.text().catch(() => "");
        let obj: Record<string, unknown> | null = null;
        try { obj = JSON.parse(body); } catch { /* not JSON either */ }
        if (!obj || typeof obj !== "object") {
            return { ok: false, transportError: `the tool endpoint answered ${ctype || "an unknown type"}, not a tool stream`, state: stream.state() };
        }
        stream.push(JSON.stringify({ type: "result", ...obj }) + "\n");
        return stream.end();
    }
    if (!res.body) return { ok: false, transportError: "the tool endpoint returned no body", state: stream.state() };

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            stream.push(decoder.decode(value, { stream: true }));
        }
    } catch (e) {
        // An aborted read is a CANCEL, not a failure to report to the model: the run asked for it.
        if (signal?.aborted) return { ok: false, transportError: "cancelled", state: stream.state() };
        return { ok: false, transportError: `the tool stream broke: ${(e as Error).message}`, state: stream.state() };
    }
    return stream.end();
}
