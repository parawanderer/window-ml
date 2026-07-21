// Shared state for the debug sidebar app: the session model (a Map + a version
// signal), the view/config/model signals, and the storage-key constants. Every
// view module imports from here — extracted from app.tsx so the components can
// live in their own files while still reading one source of truth.
import { signal } from "@preact/signals";
import type { DebugSessionConfig, DebugAgentConfig, MlConfig, LoadedModel, ExtendProfile, RenderDescriptor } from "../contract";
import { DEFAULT_CONFIG } from "../contract";

export const FONT_KEY = "ml_debug_fontscale";
export const BASE_FS = 12, MIN_FS = 0.8, MAX_FS = 1.6;   // font-scale bounds (× BASE_FS px)
// Sidebar-only code-block display prefs (storage.local, like fontScale — not part
// of the ml config the popup/background share).
export const WRAP_KEY = "ml_debug_codewrap";     // true = break-line (default); false = horizontal scroll
export const LINES_KEY = "ml_debug_codelines";   // line-number gutter on code blocks

export type Status = "pending" | "ok" | "err";
export interface Turn {
    id: string; ts: number; user: string; images: string[] | null;
    assistant?: string; sources?: unknown[] | null; structured?: boolean; error?: string; status: Status;
    reqModel?: string | null;   // the model the caller explicitly requested (null = fell back to default/utility)
    model?: string | null;      // the model that actually produced this reply (resolved server-side)
    extend?: ExtendProfile | null;  // which profile resolved it — marks (default) vs (utility)
    reasoning?: string | null;  // separate thinking/reasoning text, if the model produced any
}
export interface AgentStep { step: number; thought?: string; tool?: string; arguments?: Record<string, unknown>; result?: string; elements?: number; render?: RenderDescriptor; argIssues?: string[]; approval?: "readonly" | "user" | "denied"; }
export interface Session {
    hash: string; model: string | null; tag: "session" | "saved";
    createdTs: number; lastTs: number; status: Status;
    config: DebugSessionConfig; turns: Turn[];
    title?: string;   // AI-summarised title (lazy; see title generation below)
    // ml.agent runs (kind === "agent"): a task + a list of steps + a final summary.
    kind?: "agent";
    task?: string;
    steps?: AgentStep[];
    summary?: string;
    hitCap?: boolean;
    maxSteps?: number;
    agentConfig?: DebugAgentConfig;
}

// --- state: a Map (O(1) lookup) + a version signal to notify Preact of changes ---
export const sessionMap = new Map<string, Session>();
export const rev = signal(0);
export const view = signal<{ name: "list" } | { name: "detail"; hash: string } | { name: "settings" }>({ name: "list" });
export const fontScale = signal(1);
export const codeWrap = signal(true);          // wrap long code lines vs. horizontal scroll
export const codeLineNumbers = signal(false);  // show a line-number gutter on code blocks
export const config = signal<MlConfig>(DEFAULT_CONFIG);   // live mirror of chrome.storage.sync
export const models = signal<string[]>([]);               // server model ids (for the datalists)
export const ollamaIds = signal<string[] | null>(null);   // subset that's Ollama-backed (null = can't tell → skip cloud detection)
export const vramOpen = signal(false);                    // VRAM monitor panel toggled on?
export const sidebarOpen = signal(false);                 // is the shell slid open? (gates polling)
export const loadedModels = signal<LoadedModel[] | null>(null);   // OLLAMA_PS resident set (null until first poll)
export const psError = signal<string | null>(null);               // OLLAMA_PS failure (no Ollama backend)
