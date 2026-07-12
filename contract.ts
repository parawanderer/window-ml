// Shared interfaces for window.ml — the contracts the main-world primitive
// (injected), the content-script relay (content), the background worker
// (background), and the debug sidebar all agree on. Types only; erased at build.
// Import with `import type { ... } from "./contract"` so nothing survives to JS.

/* ------------------------------- config ------------------------------- */

export type ApiFormat = "openai" | "ollama";
export type Theme = "auto" | "dark" | "light";

/** Full config held in chrome.storage.sync (background + popup own it). */
export interface MlConfig {
    chatUrl: string;
    apiKey: string;
    model: string;
    apiFormat: ApiFormat;
    ocrModel: string;
    sidebar: boolean;
    theme: Theme;
}

/** The non-secret subset GET_CONFIG exposes to the page (never the URL/key). */
export type MlPublicConfig = Pick<MlConfig, "model" | "ocrModel" | "apiFormat">;

/* --------------------------- chat wire shapes -------------------------- */

export type Role = "system" | "user" | "assistant" | "tool";

/** Neutral message shape; each API format converts it to its wire form. */
export interface NeutralMessage {
    role: Role;
    content: string | null;
    images?: string[];              // full data URLs
    tool_calls?: ToolCall[];
    tool_call_id?: string;
    sources?: unknown[];            // OpenWebUI tool/RAG provenance
}

/** Normalized tool call — `{ id, name, arguments }` regardless of backend. */
export interface ToolCall {
    id: string;
    name: string;
    arguments: Record<string, unknown> | string;
}

export interface LlmResult {
    content: string;
    sources?: unknown[] | null;
}

/* ----------------------------- tools / agent --------------------------- */

export interface JsonSchema {
    type?: string;
    properties?: Record<string, unknown>;
    required?: string[];
    enum?: unknown[];
    [k: string]: unknown;
}

/** A tool's return: a string, or an envelope also carrying live DOM nodes
 *  (`elements`, debug-only) and/or a screenshot (`image`, inline vision). */
export interface ToolResult {
    content: string;
    elements?: Node[];
    image?: string;
    imageLabel?: string;
}

export interface MlTool {
    name: string;
    description: string;
    parameters: JsonSchema;
    run: (args: Record<string, any>) => string | ToolResult | Promise<string | ToolResult>;
    requiresApproval: boolean;
    capabilities: string[];         // e.g. "vision" | "answer"
}

export interface ApprovalRequest {
    tool: string;
    arguments: Record<string, unknown>;
}

/** The approval-gate contract: a boolean, or a rich object that can feed a
 *  rejection comment back to the model and/or edit the args before running. */
export type ApprovalDecision =
    | boolean
    | { approved: boolean; feedback?: string; arguments?: Record<string, unknown> };

export interface AgentTranscriptEntry {
    thought?: string;
    tool?: string;
    arguments?: Record<string, unknown>;
    result?: string;
    elements?: Node[];
}

export interface AgentResult {
    summary: string;
    steps: number;
    transcript: AgentTranscriptEntry[];
    elements: Node[];               // nodes designated via an answer-capable tool
    hitCap?: boolean;
}

/* ----------------------------- call options ---------------------------- */

export interface ChatOptions {
    system?: string | null;
    model?: string | null;
    think?: boolean | null;
    cleanup?: boolean;
    images?: (string | HTMLImageElement)[];
    schema?: JsonSchema | null;
    toolIds?: string[] | null;
    maxTokens?: number | null;
    save?: boolean;
    onToken?: (delta: string, full: string) => void;
}

/** A stateful multi-turn chat (the object ml.createChat returns). Its methods'
 *  `this` is the history object itself — annotate ml.createChat's return type as
 *  `MlHistory` so `this.model` / `this.messages` resolve (do NOT rewrite `this`
 *  to the captured `ml`; that's window.ml, a different object). */
export interface MlHistory {
    messages: NeutralMessage[];
    hash: string;
    model: string | null;
    think: boolean | null;
    cleanup: boolean;
    schema: JsonSchema | null;
    toolIds: string[] | null;
    maxTokens: number | null;
    save: boolean;
    chat(this: MlHistory, prompt: string, opts?: ChatOptions): Promise<string | Record<string, unknown>>;
    fork(this: MlHistory): MlHistory;
}

/* ------------------- relay contract (page ⇄ content ⇄ background) ------------------- */

/** Page-side request types posted over window.postMessage (content.js maps
 *  each to its BackgroundMessageType counterpart via HANDLE_MAP). */
export type PageRequestType =
    | "LLM_REQUEST" | "LLM_STREAM_REQUEST" | "B64_REQUEST" | "LIST_MODELS_REQUEST"
    | "GET_MODEL_REQUEST" | "CONFIG_REQUEST" | "SET_MODEL_REQUEST" | "CAPS_REQUEST"
    | "PS_REQUEST" | "UNLOAD_REQUEST" | "CAPTURE_TAB_REQUEST";

/** Message types the background worker's onMessage listener handles. */
export type BackgroundMessageType =
    | "FETCH_LLM" | "FETCH_IMAGE_B64" | "LIST_MODELS" | "GET_MODEL" | "GET_CONFIG"
    | "SET_MODEL" | "MODEL_CAPS" | "OLLAMA_PS" | "OLLAMA_UNLOAD" | "CAPTURE_TAB";

/** FETCH_LLM payload (the main one). `save` is sidebar-only and stays page-side. */
export interface FetchLlmPayload {
    messages: NeutralMessage[];
    model?: string | null;
    think?: boolean | null;
    schema?: JsonSchema | null;
    toolIds?: string[] | null;
    maxTokens?: number | null;
    tools?: unknown[];
    raw?: boolean;
    ocr?: boolean;
}

/** A model loaded in VRAM, from OLLAMA_PS. */
export interface LoadedModel {
    model: string;
    vramGB: number | null;
    expiresAt: string | null;
}

/* ------------------- debug sidebar contract (core → sidebar, window bus) ------------------- */

/** Groups turns of one createChat conversation; `turn` is the 0-based index. */
export interface SessionRef {
    hash: string;
    turn: number;
}

export interface DebugChatRequest {
    model: string | null;
    messages: NeutralMessage[];
    images: string[] | null;
    toolIds: string[] | null;
    schema: boolean;
    think: boolean | null;
    maxTokens: number | null;
}

interface DebugBase {
    id: string;                     // correlates start ↔ result/error
    ts: number;
    save: boolean;
    session: SessionRef;
}
export interface DebugChatStart extends DebugBase { kind: "chat"; streaming: boolean; request: DebugChatRequest; }
export interface DebugChatResult extends DebugBase { kind: "chat-result"; content: string; sources: unknown[] | null; structured: boolean; }
export interface DebugChatError extends DebugBase { kind: "chat-error"; error: string; }

/** The event stream injected.js emits over window.postMessage for the sidebar. */
export type MlDebugEvent = DebugChatStart | DebugChatResult | DebugChatError;

/** Window-bus envelopes between the core (main world) and the sidebar. */
export interface MlDebugMessage { __mlDebug: MlDebugEvent; }
export interface MlSidebarReady { __mlSidebar: "ready"; }

/* --------------------------- global augmentation -------------------------- */
// injected.js defines window.ml (the whole public API) on the page's main world.
// Typed `any` for now — a precise `MlApi` interface is a separate deliverable;
// this just lets injected.ts reference window.ml without an error.
declare global {
    interface Window { ml: any; }
}
export {};
