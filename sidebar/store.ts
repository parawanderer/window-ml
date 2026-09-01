// Shared state for the debug sidebar app: the session model (a Map + a version
// signal), the view/config/model signals, and the storage-key constants. Every
// view module imports from here — extracted from app.tsx so the components can
// live in their own files while still reading one source of truth.
import { signal } from "@preact/signals";
import type { DebugSessionConfig, DebugAgentConfig, MlConfig, LoadedModel, ExtendProfile, RenderDescriptor, ToolFeedback, TokenUsage, SubcallUsage, AnswerMedia, PersistGrant, ReusedGrant } from "../contract";
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
    usage?: TokenUsage | null;  // token counts for this turn, when the server reports them
}
export interface AgentStep { step: number; localStep?: number; seq?: number; pending?: boolean; awaitingApproval?: boolean; thought?: string; reasoning?: string | null; tool?: string; arguments?: Record<string, unknown>; result?: string; modelResult?: string; token?: string; elements?: number; renderIn?: RenderDescriptor; renderOut?: RenderDescriptor; feedback?: ToolFeedback; argIssues?: string[]; approval?: "readonly" | "sandbox" | "same-origin" | "consented" | "user" | "denied" | "skipped" | "cancelled"; usage?: TokenUsage | null; subUsage?: SubcallUsage; grants?: PersistGrant[]; reused?: ReusedGrant[]; }

// The agent's TURN count — the number of distinct `.step` values, NOT `steps.length`.
// One turn (one LLM call) emits several `AgentStep` events (its thought + one per tool
// call, all sharing the same `.step`), so `.length` over-counts and can exceed maxSteps.
// The loop caps `step` at maxSteps, so this is always ≤ maxSteps.
export const turnsRun = (steps?: AgentStep[]): number => new Set((steps || []).map(s => s.step)).size;
export interface Session {
    hash: string; model: string | null; tag: "session" | "saved";
    createdTs: number; lastTs: number; status: Status;
    config: DebugSessionConfig; turns: Turn[];
    title?: string;   // AI-summarised title (lazy; see title generation below)
    // ml.agent runs (kind === "agent"): a task + a list of steps + a final summary.
    kind?: "agent";
    task?: string;
    taskImages?: string[];   // composer attachments the user pasted with the initial task (data URLs)
    steps?: AgentStep[];
    summary?: string;
    answerMedia?: AnswerMedia[];   // serialized visuals of `answer`-designated elements → the HUD completion card (NOT the debug sidebar)
    answer?: string;   // the curated answer SET resolved to markdown — the card renders it when it cites a @tool output
    error?: string;   // a FATAL run error (model call failed / unexpected throw) — distinct from a tool's Error result
    hitCap?: boolean;
    cancelled?: boolean;   // the run was aborted (HUD "Cancel agent run" / opts.signal) — partial transcript kept

    maxSteps?: number;
    agentConfig?: DebugAgentConfig;
    resumed?: boolean;   // this run was RESURRECTED from storage after an SW eviction/respawn (visible + stoppable)
    // Live model output for the CURRENT step while it streams (opt-in stream:true) — the accumulated
    // reasoning/content so far, shown as a live "thinking" block until the step's real events land (which
    // clear it). Transient; not persisted in the transcript. See the agent-stream reducer + LiveStream UI.
    liveStream?: { step: number; localStep?: number; reasoning?: string; content?: string };
    // A turn's terminal agent-result SEALS the session so a STRAGGLER step — the in-flight tool's late DONE
    // that a background-hosted (design A) run keeps fanning after a cancel, arriving AFTER the page-emitted
    // cancelled result — can't resurrect it to "running". A genuine new turn (agent-say, or a step past
    // `endedStep`) unseals it. Without this the DevTools footer + composer stay stuck "running" post-cancel.
    ended?: boolean;
    endedStep?: number;
    // A multi-turn agent session renders as a CHAT LOG. Every user message — the initial task, a follow-up
    // run()'s task, and a mid-run say() — is a `say` (all rendered identically as "you"); every turn's final
    // answer is an `answer`. `atStep` is the cumulative step count when it arrived, so the render interleaves
    // them with the turn step-groups in order. (`summary` still holds the LATEST answer for the title/status.)
    says?: { text: string; ts: number; atStep: number; images?: string[]; id?: string; seen?: boolean }[];
    answers?: { text: string; ts: number; atStep: number; status: Status; hitCap?: boolean; cancelled?: boolean; error?: string }[];
}

// --- state: a Map (O(1) lookup) + a version signal to notify Preact of changes ---
export const sessionMap = new Map<string, Session>();
export const rev = signal(0);
export const view = signal<{ name: "list" } | { name: "detail"; hash: string } | { name: "settings" } | { name: "bench" }>({ name: "list" });
export const fontScale = signal(1);
export const codeWrap = signal(true);          // wrap long code lines vs. horizontal scroll
export const codeLineNumbers = signal(false);  // show a line-number gutter on code blocks
export const config = signal<MlConfig>(DEFAULT_CONFIG);   // live mirror of chrome.storage.sync
export const models = signal<string[]>([]);               // server model ids (for the datalists)
export const ollamaIds = signal<string[] | null>(null);   // subset that's Ollama-backed (null = can't tell → skip cloud detection)
export const vramOpen = signal(false);                    // VRAM monitor panel toggled on?
export const sidebarOpen = signal(false);                 // is the shell slid open? (gates polling)
// The last BACKEND-UNREACHABLE error message (empty = the backend is reachable / unknown). Set when a run or
// chat fails to reach the server, cleared on any successful call. Drives the devtools-panel offline banner +
// the HUD card's distinct "backend unreachable" treatment, so a dead box reads at a glance in both surfaces.
export const backendError = signal("");
export const loadedModels = signal<LoadedModel[] | null>(null);   // OLLAMA_PS resident set (null until first poll)
export const psError = signal<string | null>(null);               // OLLAMA_PS failure (no Ollama backend)
