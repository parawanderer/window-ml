// page-relay.ts — every message a web PAGE can make the extension's background receive, in one place.
//
// The page reaches the background only through the content script, and the content script relays only what is listed
// here: the request/response pairs in `HANDLE_MAP`, and the few fire-and-forget types it sends on the page's behalf.
// The background gates every one of them by the sending page's origin (sw-site-access.ts), and the red-team tests
// enumerate this module rather than a copy of it, so a type added here is gated and tested without anyone editing
// either (docs/spec/SITE_ACCESS.md, slice 1).

import type { BackgroundMessageType, PageRequestType } from "./contract/contract-messages";

interface RelayEntry { type: BackgroundMessageType; responseType: string; }

// Page request type → background message type + the response type to post back.
export const HANDLE_MAP: Partial<Record<PageRequestType, RelayEntry>> = {
    LLM_REQUEST: { type: "FETCH_LLM", responseType: "LLM_RESPONSE" },
    B64_REQUEST: { type: "FETCH_IMAGE_B64", responseType: "B64_RESPONSE" },
    LIST_MODELS_REQUEST: { type: "LIST_MODELS", responseType: "LIST_MODELS_RESPONSE" },
    GET_MODEL_REQUEST: { type: "GET_MODEL", responseType: "GET_MODEL_RESPONSE" },
    SET_MODEL_REQUEST: { type: "SET_MODEL", responseType: "SET_MODEL_RESPONSE" },
    CAPS_REQUEST: { type: "MODEL_CAPS", responseType: "CAPS_RESPONSE" },
    EMBED_REQUEST: { type: "EMBED", responseType: "EMBED_RESPONSE" },
    LIST_SERVER_TOOLS_REQUEST: { type: "LIST_SERVER_TOOLS", responseType: "LIST_SERVER_TOOLS_RESPONSE" },
    INFO_REQUEST: { type: "OLLAMA_INFO", responseType: "INFO_RESPONSE" },
    USER_FOCUS_REQUEST: { type: "USER_FOCUS", responseType: "USER_FOCUS_RESPONSE" },
    CONFIG_REQUEST: { type: "GET_CONFIG", responseType: "CONFIG_RESPONSE" },
    INVOCATION_REQUEST: { type: "GET_INVOCATION", responseType: "INVOCATION_RESPONSE" },
    PS_REQUEST: { type: "OLLAMA_PS", responseType: "PS_RESPONSE" },
    // ml.__events() — the debug dump (see the background's DUMP_EVENTS).
    DUMP_EVENTS_REQUEST: { type: "DUMP_EVENTS", responseType: "DUMP_EVENTS_RESPONSE" },
    // ml.__loads() — the per-load records kept for tuning the VRAM predictor (see the background's DUMP_LOADS).
    DUMP_LOADS_REQUEST: { type: "DUMP_LOADS", responseType: "DUMP_LOADS_RESPONSE" },
    // ml.__housekeeping() and page-side reports into it (see the background's DUMP_HOUSEKEEPING/HOUSEKEEPING_REPORT).
    DUMP_HOUSEKEEPING_REQUEST: { type: "DUMP_HOUSEKEEPING", responseType: "DUMP_HOUSEKEEPING_RESPONSE" },
    HOUSEKEEPING_REPORT_REQUEST: { type: "HOUSEKEEPING_REPORT", responseType: "HOUSEKEEPING_REPORT_RESPONSE" },
    PYTHON_PREWARM_REQUEST: { type: "PYTHON_PREWARM", responseType: "PYTHON_PREWARM_RESPONSE" },
    UNLOAD_REQUEST: { type: "OLLAMA_UNLOAD", responseType: "UNLOAD_RESPONSE" },
    CAPTURE_TAB_REQUEST: { type: "CAPTURE_TAB", responseType: "CAPTURE_TAB_RESPONSE" },
    SAVE_SESSION_REQUEST: { type: "SAVE_SESSION", responseType: "SAVE_SESSION_RESPONSE" },
    GET_SESSION_REQUEST: { type: "GET_SESSION", responseType: "GET_SESSION_RESPONSE" },
    PYTHON_EXEC_REQUEST: { type: "PYTHON_EXEC", responseType: "PYTHON_EXEC_RESPONSE" },
    SERVER_TOOL_REQUEST: { type: "SERVER_TOOL_EXEC", responseType: "SERVER_TOOL_RESPONSE" },
    FETCH_SHEET_REQUEST: { type: "FETCH_SHEET", responseType: "FETCH_SHEET_RESPONSE" },
    FETCH_URL_REQUEST: { type: "FETCH_URL", responseType: "FETCH_URL_RESPONSE" },
    CDP_SHADOW_RESOLVE_REQUEST: { type: "CDP_SHADOW_RESOLVE", responseType: "CDP_SHADOW_RESOLVE_RESPONSE" },
    // Design A: kick off a background-hosted ml.agent loop. The single response carries the final
    // AgentResult (the run's debug events stream separately via ML_DEBUG_TO_PAGE, below).
    START_RUN_REQUEST: { type: "START_RUN", responseType: "START_RUN_RESPONSE" },
    RESUME_RUN_REQUEST: { type: "RESUME_RUN", responseType: "RESUME_RUN_RESPONSE" },
    INJECT_MESSAGE_REQUEST: { type: "INJECT_MESSAGE", responseType: "INJECT_MESSAGE_RESPONSE" },
};

/** Background message types the content script sends on a page's behalf OUTSIDE `HANDLE_MAP`: a page's own cancel
 *  of its run and abort of a request, and the shell's forwards of the page's own debug and session events. */
export const PAGE_RELAYED_EXTRA = ["PAGE_CANCEL_RUN", "ABORT_TASK", "ML_DEBUG_EVENT", "ML_SESSION_EVENT"] as const;

/** Every background message type a page can start: what the origin gate applies to. */
export const PAGE_STARTED_TYPES: ReadonlySet<string> = new Set<string>([
    ...Object.values(HANDLE_MAP).map((e) => e!.type),
    ...PAGE_RELAYED_EXTRA,
]);

/** The page-started types that START, CONTINUE, STEER or STOP a run. Never allowed from an unapproved page, not even
 *  one a run is currently on: the other page-started types are, until delegation tokens replace that allowance
 *  (sw-site-access.ts, slice 2). */
export const RUN_CONTROL_TYPES: ReadonlySet<string> = new Set<string>(["START_RUN", "RESUME_RUN", "INJECT_MESSAGE", "PAGE_CANCEL_RUN"]);

/** What a tab HOSTING a background run may send from its top frame whatever its origin: what that run's own tools send
 *  while they run in the page (a vision tool's model call and screenshot, `fetch_url`, `python_exec`, a sheet, a server
 *  tool, a shadow root's CDP resolve, the config a vision tool or an exec reads, and the abort of one of those requests).
 *  Nothing that changes the model, unloads it, saves or reads sessions, embeds, or dumps a log: a page a run visits
 *  gains only what the run itself needs there. It shrinks as tools move to the worker (docs/spec/SITE_ACCESS.md slice
 *  2) and goes when none run in the page. */
export const RUN_TAB_TYPES: ReadonlySet<string> = new Set<string>([
    "FETCH_LLM", "ABORT_TASK", "MODEL_CAPS", "GET_MODEL", "GET_CONFIG",
    "CAPTURE_TAB", "FETCH_IMAGE_B64", "FETCH_URL", "PYTHON_EXEC", "FETCH_SHEET",
    "LIST_SERVER_TOOLS", "SERVER_TOOL_EXEC", "CDP_SHADOW_RESOLVE",
]);
