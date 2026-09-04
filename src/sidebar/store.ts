// Shared state for the debug sidebar app: the session model (a Map + a version
// signal), the view/config/model signals, and the storage-key constants. Every
// view module imports from here — extracted from app.tsx so the components can
// live in their own files while still reading one source of truth.
import { signal } from "@preact/signals";
import type { DebugSessionConfig, DebugAgentConfig, MlConfig, LoadedModel, ExtendProfile, RenderDescriptor, ToolFeedback, TokenUsage, SubcallUsage, AnswerMedia, PersistGrant, ReusedGrant, GenPhase, RemoteTiming } from "../contract";
import { DEFAULT_CONFIG } from "../contract";

export const FONT_KEY = "ml_debug_fontscale";
export const BASE_FS = 12, MIN_FS = 0.8, MAX_FS = 1.6;   // font-scale bounds (× BASE_FS px)
// Sidebar-only code-block display prefs (storage.local, like fontScale — not part
// of the ml config the popup/background share).
export const WRAP_KEY = "ml_debug_codewrap";     // true = break-line (default); false = horizontal scroll
export const LINES_KEY = "ml_debug_codelines";   // line-number gutter on code blocks
export const STATS_TOKENS_KEY = "ml_debug_stats_tokens";   // DevTools run-stats bar: cumulative in/out tokens (default on)
export const STATS_TPS_KEY = "ml_debug_stats_tps";         // DevTools run-stats bar: generation tok/s (default off)
export const OUTTS_KEY = "ml_debug_outts";                 // show per-line timestamps on streamed tool output
export const OUTMAX_KEY = "ml_debug_outmax";               // max height (px) of a tool OUTPUT cell before it scrolls
// How much history the resource chart DRAWS, in seconds. Kept separate from how much is retained: 30 minutes
// squeezed into ~300px is a smear, so the window is short by default and the samples behind it stay in memory.
// How tall the VRAM/resource panel is. It sits above the session list and competes with it for height, so
// which one you want more of depends on what you are doing — hence draggable, and remembered.
export const VRAMH_KEY = "ml_vram_h";
export const RESWIN_KEY = "ml_res_window";
export const RESWIN_DEFAULT = 300;                         // 5 minutes — readable at this width

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
export interface AgentStep { step: number; localStep?: number; seq?: number; toolMs?: number; approveMs?: number; remoteMs?: RemoteTiming; ts?: number; pending?: boolean; awaitingApproval?: boolean; thought?: string; reasoning?: string | null; tool?: string; arguments?: Record<string, unknown>; result?: string; modelResult?: string; streamOutput?: string; streamMarks?: [number, number][]; token?: string; elements?: number; renderIn?: RenderDescriptor; renderOut?: RenderDescriptor; feedback?: ToolFeedback; argIssues?: string[]; approval?: "readonly" | "sandbox" | "same-origin" | "consented" | "self-source" | "user" | "denied" | "skipped" | "cancelled"; usage?: TokenUsage | null; subUsage?: SubcallUsage; grants?: PersistGrant[]; reused?: ReusedGrant[]; }

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
    // What this session IS. `agent` is an ml.agent run — a task, a list of steps, a final summary. `embed`
    // is `ml.embed()`, which reports through the chat events (a model call is a model call) but is not a
    // chat. ABSENT means an ordinary `ml.chat()`.
    kind?: "agent" | "embed";
    task?: string;
    taskImages?: string[];   // composer attachments the user pasted with the initial task (data URLs)
    pageUrl?: string;        // the page the run STARTED on (a run that navigates ends elsewhere)
    pageTitle?: string;
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
    /** A model call is in flight RIGHT NOW: when it started, and (streamed runs) what it has been emitting.
     *  Transient like {@link liveStream} — cleared the moment the step lands — and the only thing that lets a
     *  timeline draw a generation while it happens instead of back-dating the finished block. */
    liveTurn?: { step: number; localStep?: number; startedTs: number; phases?: GenPhase[] };
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
export const showStatsTokens = signal(true);   // DevTools run-stats bar: cumulative in/out tokens (default on)
export const showStatsTps = signal(false);     // DevTools run-stats bar: generation tok/s (default off)
export const OUTMAX_DEFAULT = 260;             // px — roughly 14 lines; enough to read, small enough not to bury the page
export const showOutTimes = signal(true);      // render the timestamp gutter on streamed output (default on)
export const vramH = signal(0);   // px; 0 = size to content (the default)
// A drag-selected time range on the resource chart (Grafana-style), or null for "the whole window". Held in
// the store rather than the component because EVERY track and the event lane must draw the same selection —
// while it is being drawn, and after.
export const zoomRange = signal<{ from: number; to: number } | null>(null);
/** The drag in progress, as fractions of the plot's width, so every track can mirror it live. */
export const brush = signal<{ from: number; to: number } | null>(null);
/** Where the pointer is on the time axis, for the crosshair every track draws. `frac` positions it, `t` is
 *  the moment it names — one signal, so the line appears on all the graphs at once and they cannot disagree
 *  about which instant is being pointed at. */
// What the event lane draws. Kinds are an EXCLUSION list (see LaneFilter) and are remembered; the session
// SCOPE is not — it follows what you are looking at, and a stored scope would silently hide another run's
// events on a later visit for a reason nothing on screen explains.
export const LANE_HIDDEN_KEY = "ml_lane_hidden";
export const laneHidden = signal<string[]>([]);
/** Restrict the lane to the session being read. ON by default and remembered: the lane sits above a
 *  transcript, and events from runs you are not reading are noise against it. With nothing open there is
 *  nothing to scope to, so the overview shows no run events at all — turn this off to see every session's. */
export const LANE_SCOPE_KEY = "ml_lane_scope";
export const laneScoped = signal(true);
// The panel's two SECTIONS, remembered. Both compete with the chart for whatever height the panel has been
// dragged to, and which of the three you want depends on what you are doing: reading a run's shape wants the
// lane, watching memory move wants the plot, deciding what to evict wants the model list. Hidden, not
// removed — the data behind each keeps being collected either way.
/** The step seqs lit by whatever is hovered in the event lane, or null when nothing is. The lane already
 *  dims its own bars by lineage; this carries the same focus into the transcript, so hovering a block says
 *  which part of the log it is about. Seqs rather than event ids, because the log is keyed by step. */
export const laneLitSeqs = signal<Set<number> | null>(null);
export const SECTIONS_KEY = "ml_res_sections";
export const showLane = signal(true);
export const showModels = signal(true);
export const crosshair = signal<{ frac: number; t: number | null; msPerPx?: number } | null>(null);
export const resWindowS = signal(RESWIN_DEFAULT);  // seconds of history the resource chart shows (Settings → Appearance)
export const outMaxH = signal(OUTMAX_DEFAULT); // max height of a tool output cell (Settings → Appearance); 0 = uncapped
export const config = signal<MlConfig>(DEFAULT_CONFIG);   // live mirror of chrome.storage.sync
export const models = signal<string[]>([]);               // server model ids (for the datalists)
// Each model's capabilities, when the picker asked for them (LIST_MODELS `kinds: true`). Empty until then,
// and a model missing from it is UNKNOWN — which `generatesText` treats as "show it", so a slow or failed
// capability lookup can never silently empty a picker.
export const modelKinds = signal<Record<string, string[] | null>>({});
// Output dimensions per model, from the same /api/show lookup. Shown beside a CHOSEN embedding model; never
// used to classify one, since chat models report an embedding_length too (it is their hidden size).
export const embedDims = signal<Record<string, number | null>>({});
export const ollamaIds = signal<string[] | null>(null);   // subset that's Ollama-backed (null = can't tell → skip cloud detection)
export const vramOpen = signal(false);                    // VRAM monitor panel toggled on?
export const sidebarOpen = signal(false);                 // is the shell slid open? (gates polling)
// The last BACKEND-UNREACHABLE error message (empty = the backend is reachable / unknown). Set when a run or
// chat fails to reach the server, cleared on any successful call. Drives the devtools-panel offline banner +
// the HUD card's distinct "backend unreachable" treatment, so a dead box reads at a glance in both surfaces.
export const backendError = signal("");
export const loadedModels = signal<LoadedModel[] | null>(null);   // OLLAMA_PS resident set (null until first poll)
export const psError = signal<string | null>(null);               // OLLAMA_PS failure (no Ollama backend)

// --- cross-surface HUD signals (read by the answer-render provenance jump AND the HUD card) ---
// "Show work" open-state, keyed by the run's HASH (not a global boolean). A new run's hash won't match, so
// its trace is COLLAPSED by default with NO post-render reset — the reset-as-effect was why a fast/quiet run
// first painted with the PREVIOUS run's trace expanded (tall) then collapsed (the "opens huge then shrinks"
// glitch). "" = nothing open. Also naturally scopes to the active run once the card has tabs.
export const cardShowWorkHash = signal<string>("");
// A provenance click (a @tool citation → its source step) sets this to the target step's `seq`, so the per-task
// BLOCK that holds it force-opens even if collapsed (scrollToStepSeq). Cleared shortly after the scroll.
export const revealSeq = signal<number | null>(null);
// Whether the detail log is scrolled to the bottom (stick-to-bottom intent). Module-level so the per-step
// approval reveal (agent-detail's ToolStep) and App's scroll logic share ONE truth — a single App instance.
export const atBottom = { v: true };
// Which surface this app instance is rendering as: the full "panel" (overlay / DevTools) or the off-mode
// "card" (a transparent, curated HUD). The shell sets it via __mlSidebarSurface; components read it to drop
// debug chrome in the card. Cross-cutting (read by the agent-detail views + the HUD), so it lives here.
export const surface = signal<"panel" | "card">("panel");
