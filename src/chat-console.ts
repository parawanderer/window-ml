// chat-console.ts — `ml` in the chat page's own DevTools console: the chat and model members of window.ml, for poking
// at the box from the page you are already on.
//
// The extension's chat page is an extension page, not a site, so it gets no injected.js and no content script. This
// builds the members that do not touch a page (a chat, the model list, the server's facts) out of the same `ml-*`
// modules window.ml is made of, and relays their messages itself, the way content.js does for a site. Nothing here
// widens what the page may do: the worker already treats an extension page as the person's own surface
// (`isExtensionSender`), and its console already has `chrome.runtime`. What is left out is what needs a page under it
// or would start a run on a page we own (`AGENT_START_PAGE`): `agent`, `step`, the DOM tools, `look`, `fetch`.
//
// Extension-only, so it sits beside chat-ext.tsx rather than under `src/chat/`, which must build for a phone.
// Its console chats are not recorded as sessions: the debug events they emit have no listener on this side.

import "./page-world-isolated";   // FIRST: both ends of the page channel in this one world (page-channel.ts)
import { offIsolated, onPage, toPage, type ChannelMessage } from "./page-channel";
import { HANDLE_MAP } from "./page-relay";
import type { PageRequestType } from "./contract";
import { chat, createChat, resumeChat } from "./ml/ml-chat";
import { capabilities, config, embed, execServerTool, getModel, info, models, ps, serverTools, setModel, unload } from "./ml/ml-server";
import { mlSchema } from "./ml/ml-schema";

/** The members `ml` has on the chat page, by the names window.ml gives them. */
export const CONSOLE_MEMBERS = ["chat", "createChat", "resumeChat", "schema", "models", "serverTools", "execServerTool", "info", "capabilities", "getModel", "embed", "config", "setModel", "ps", "unload"] as const;

interface StreamMsg { type: "chunk" | "done" | "error"; delta?: string; content?: string; sources?: unknown; model?: string; reasoning?: string; usage?: unknown; error?: string }
interface BgResponse { data?: unknown; sources?: unknown; model?: unknown; reasoning?: unknown; usage?: unknown; error?: string }

/** Live streaming ports by request id, so an abort disconnects the one it is for. */
const streamPorts = new Map<string, chrome.runtime.Port>();   // state: plumbing

/**
 * One message from the `ml` side, relayed to the worker and its answer sent back: the subset of content.js's relay
 * that the members above use (a one-shot request through `HANDLE_MAP`, a streamed chat, an abort).
 * @param e the channel message
 */
function relay(e: ChannelMessage): void {
    const data = e.data as { type?: string; requestId?: string; payload?: unknown } | null;
    if (!data || typeof data.type !== "string") return;
    const requestId = data.requestId ?? "";
    if (data.type === "LLM_STREAM_REQUEST") {
        const port = chrome.runtime.connect({ name: "LLM_STREAM" });
        streamPorts.set(requestId, port);
        const end = () => { streamPorts.delete(requestId); port.disconnect(); };
        port.onMessage.addListener((m: StreamMsg) => {
            if (m.type === "chunk") toPage({ type: "LLM_STREAM_CHUNK", requestId, delta: m.delta });
            else if (m.type === "done") { toPage({ type: "LLM_STREAM_DONE", requestId, content: m.content, sources: m.sources, model: m.model, reasoning: m.reasoning, usage: m.usage }); end(); }
            else if (m.type === "error") { toPage({ type: "LLM_STREAM_ERROR", requestId, error: m.error }); end(); }
        });
        port.postMessage({ payload: data.payload });
        return;
    }
    if (data.type === "ABORT_REQUEST") {
        const port = streamPorts.get(requestId);
        if (port) { streamPorts.delete(requestId); port.disconnect(); }
        else chrome.runtime.sendMessage({ type: "ABORT_TASK", payload: { requestId } });
        return;
    }
    const entry = HANDLE_MAP[data.type as PageRequestType];
    if (!entry) return;   // a debug event, or a type no member here sends
    chrome.runtime.sendMessage({ type: entry.type, payload: data.payload, requestId }, (r: BgResponse | undefined) => {
        const lastErr = chrome.runtime.lastError;
        const error = r?.error || (!r ? `${lastErr?.message ? lastErr.message + " — " : ""}the extension background didn't respond. Try again.` : undefined);
        toPage({ type: entry.responseType, requestId, result: r?.data, sources: r?.sources, model: r?.model, reasoning: r?.reasoning, usage: r?.usage, error });
    });
}

/**
 * Put `ml` on this page's window, with the members in `CONSOLE_MEMBERS`, and say so once in the console.
 * @param target the global to define it on (the page's window)
 */
export function installConsoleMl(target: Record<string, unknown> = globalThis as unknown as Record<string, unknown>): void {
    onPage(relay);
    // Open the channel now: in this world that joins both ends in-process and disarms the isolated side, which until
    // then would take the first port any `ml-page-port` event on this window handed it.
    offIsolated(relay);
    const ml: Record<string, unknown> = {
        chat, createChat, resumeChat, schema: mlSchema,
        models, serverTools, execServerTool, info, capabilities, getModel, embed, config, setModel, ps, unload,
    };
    ml.ready = Promise.resolve(ml);
    target.ml = Object.freeze(ml);
    console.log(`window.ml (chat page): ${CONSOLE_MEMBERS.join(", ")}. ml.agent and the page tools need a site's page.`);
}
