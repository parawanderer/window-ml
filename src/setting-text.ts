// setting-text.ts — each setting's name and tooltip, the one table the Settings panel renders its rows from.

import type { MlConfig } from "./contract/contract-config";

/** The words a setting is shown with: its `name` (the row label) and an optional `tip` (the hover tooltip). */
export interface SettingText { name: string; tip?: string }

/**
 * The DevTools Settings name and tooltip of each setting that has a labelled row, so the panel and any other surface
 * (an approval card) show the same words. A key absent here has no labelled row; `serverToolsOff` and
 * `commanderServerTools` are named here though only their section draws them.
 */
export const SETTING_TEXT: Readonly<Partial<Record<keyof MlConfig, SettingText>>> = {
    siteRequests: { name: "Let sites ask for access" },
    // These two have no row of their own: one checkbox per bundle or function in the "Server-side tools" section edits them.
    serverToolsOff: { name: "Server-side tools turned off", tip: "A function turned off is not given to a run at all, so it never reaches a prompt; a run can still ask for its bundle." },
    commanderServerTools: { name: "Server-side tool bundles for Commander runs", tip: "Give this bundle to every run started from the HUD/Commander bar. A run driven from there has no code to ask for it." },
    cdp: { name: "Enable debugger-based actions (CDP)", tip: "Use chrome.debugger (CDP) for two things a normal page context can't do: (1) CLICK surfaces a synthetic click can't reach — cross-origin iframes and declarative/native closed shadow roots; (2) run imperative `exec` on strict-CSP / Trusted-Types pages (GitHub, Google apps) where main-world eval is blocked. The debugger is exempt from the page's CSP/TT, so it's the only mechanism that works. The `debugger` permission is declared at install; this toggle gates USAGE (the API stays unused until it's on AND the model hits a reserved surface). Still gated by the per-action approval. Attaching flashes Chrome's \"is debugging this browser\" banner — only for these reserved actions, so the flash marks the risk. On by default; while off, a reserved click / a blocked exec just reports an actionable error and the agent falls back to read-only / ml.fetch." },
    chatUrl: { name: "Chat completions URL" },
    apiKey: { name: "API key" },
    apiFormat: { name: "API format", tip: "Request and response shape — match it to the URL above." },
    model: { name: "Default model", tip: "The model list loads automatically — start typing to pick one." },
    ocrModel: { name: "Vision model (optional)", tip: "Vision model ml.read() uses for OCR and for other vision subtasks — kept separate from the chat model." },
    defaultModelVision: { name: "Default model is vision capable?", tip: "Whether the default model sees images natively. Auto-detect probes Ollama; set Yes/No only for a cloud model the probe can't read (e.g. GPT-4o) — declaring Yes lets the agent use its own model to see (HUD native vision) instead of delegating to the OCR model. For an Ollama model we detect the real answer, so this override is ignored (and flagged)." },
    agentStepMaxTokens: { name: "Max tokens per agent step", tip: "The most tokens one agent step may generate, thinking included. Empty sends no cap. A model that loops in its thinking otherwise runs until its context window is full, which on a local model can take the better part of an hour. A step that hits the cap ends with what it has." },
    modelFilter: { name: "Allowed models (regex whitelist)", tip: "Optional regex WHITELIST. When set, only models whose id matches are callable via window.ml, and pages (ml.models()) never even see the others — a guard against a page invoking, e.g., an expensive cloud model. Applies to every resolved model (main/OCR/grounding/utility). Blank = no restriction. Example: ^(qwen|gemma) to allow only local families." },
    utilityModel: { name: "Utility model (optional)", tip: "A small, cheap model for side tasks like session-title summaries. Leave blank to reuse the main model. Suggestions: qwen3.5:0.8b for an average machine, a gemma4:e2b-class model for a beefier one." },
    utilityNumCtx: { name: "Utility model context size", tip: "Context window (num_ctx) for the utility model. Summarising needs little context — keep it small on modest hardware; larger just uses more KV-cache memory. Only used when a utility model is set." },
    utilityForceCpu: { name: "Force utility onto CPU", tip: "Run the utility model on CPU (num_gpu: 0) so it never competes with your main model for VRAM. Only used when a utility model is set." },
    autoTitles: { name: "Auto-summarise with the utility model", tip: "Let the utility model write short summaries for you: debug session titles, and the plain-English gloss above a code approval / the description of a custom tool call in the off-mode card. Off = titles fall back to the first prompt and the card shows no summary. Only runs when a utility model is set." },
    embeddingModel: { name: "Embedding model", tip: "Model used for ml.embed — comparing text by MEANING rather than spelling. Only models reporting the `embedding` capability are offered; an embedding model cannot generate text, so it never appears in the chat/utility/vision pickers either." },
    embeddingKeepAlive: { name: "Keep loaded (no expiry)", tip: "Keep the embedding model loaded with no expiry. ON by default because of the ACCESS PATTERN, not the size: a cold embed measured 2726ms against 95ms warm, and a model used rarely and unpredictably would sit past Ollama's 5-minute expiry almost every time, so it would be cold nearly always. Evicting it from the VRAM panel still works — the next call simply loads it again and re-pins it." },
    embeddingForceCpu: { name: "Run on CPU (uses no VRAM)", tip: "Run the embedding model on CPU instead of the GPU. ON by default: measured 33ms slower warm (128 vs 95), FASTER cold (1628 vs 2726, since nothing is copied to VRAM), and it uses no VRAM at all — which the chat model wants. Turn it off only if you pick an embedding model large enough that CPU inference stops being cheap." },
    groundingEnabled: { name: "Enable visual grounding model", tip: "Experimental. When on, ml.agent's `locate` tool asks a grounding VLM for bounding-box coordinates. This loads an extra model into VRAM — leave off if memory is tight. Off = locate still works via the Set-of-Marks screenshot tool, which needs no extra model." },
    groundingModel: { name: "Grounding model", tip: "A vision model that outputs coordinates (recommended qwen2.5vl:7b, or :3b for lower latency). Blank auto-detects a qwen2.5vl on your server. Real-world grounding accuracy is unproven." },
    groundingRange: { name: "Coordinate range", tip: "The coordinate scale the model outputs (the divisor for its x,y). The screenshot is sent as a square, so one number covers every convention: 1000 (0-1000 normalized OR qwen2.5vl absolute pixels), 100 (Molmo percent), 1024 (PaliGemma tokens), 1 (0.0-1.0 fractions). Leave at 1000 unless your model uses a different range." },
    theme: { name: "Theme" },
    debugMode: { name: "Debug panel" },
    listPageSessions: { name: "List console and page-script sessions in the chat page when the debug panel is off" },
    persistUiRuns: { name: "Keep runs started from this browser's own UI" },
    sessionRetentionDays: { name: "Keep unpinned sessions for (days)" },
    sessionStoreBudgetMB: { name: "Saved session storage (MB)" },
    agentStartPage: { name: "Blank-tab start page" },
    priceSnapshotUrl: { name: "Price service", tip: "Your model box's price service, for spend. Empty (the default) fetches nothing. Set, each model call records the price snapshot it ran under (by hash), and the worker keeps each snapshot once for up to 30 days after its last use." },
    electricityPerKwh: { name: "Electricity price (per kWh)", tip: "What a kWh costs you, for the electricity your LOCAL models use. Empty is unset. Each model call records the price set when it ran, so a change does not reprice old runs." },
    electricityOffPeakPerKwh: { name: "Off-peak price (per kWh)", tip: "For a two-rate tariff: the off-peak price per kWh, all-in. Empty is a single rate: the price above always applies. Each call records which rate it ran under." },
    electricityOffPeakHours: { name: "Off-peak hours", tip: "The off-peak hours on this device's clock, from-to in whole hours; \"23-7\" runs past midnight. Public holidays are not counted." },
    electricityOffPeakWeekends: { name: "Weekends are off-peak all day", tip: "Saturday and Sunday count as off-peak all day, as most two-rate tariffs have it." },
    electricityCurrency: { name: "Currency", tip: "The currency of the electricity price, as a code (EUR, USD)." },
    sessionArchive: { name: "Archive sessions instead of deleting them" },
    cardCorner: { name: "Card corner" },
    agentHud: { name: "Agent HUD progress indicator visibility" },
    agentHudInDevtools: { name: "Also show the HUD alongside the DevTools panel" },
    exportToolDefs: { name: "Include tool definitions in run exports" },
    autoApproveReadonly: { name: "Auto-approve read-only exec calls", tip: "Experimental. Run read-only exec surveys (querySelectorAll → filter → map, no mutation) without an approval prompt, via a mediated interpreter that can't reach window, makes no requests of its own and never eval()s a string. Anything that mutates or isn't recognised still asks. Also lets these surveys run on Trusted-Types pages where eval is blocked. The agent can likewise read its own setup without asking — ml.getModel/config/models/capabilities/ps/serverTools, the same non-secret values any page can read — and call ml.embed, which sends text from the page to your configured embedding model with no prompt: at most 500,000 characters in 32 calls per survey. Every other ml method still prompts." },
    labelMatch: { name: "Label matching", tip: "How a pointer LABEL is matched when it isn't recalled exactly. A near match is only ever used when it clearly beats the runner-up, and is always reported — but WHICH metric ranks the candidates is genuinely undecided, so it is exposed here. hybrid (default): the better of trigram and word-overlap; handles both rewording and typos. tokenset: word overlap only — perfect on reordering, blind to typos. trigram: character-level, survives both without excelling. edit: Levenshtein — best on typos, but it ranks a DIFFERENT label above the correct one reworded, so it is here to be measured against, not recommended." },
    valueStoreBudgetMB: { name: "Stored table budget (MB)", tip: "Disk for fetched tables too large to show whole. The table a pointer names is kept on disk, so a later step can read every row rather than the preview. Past this size, the one read longest ago is dropped first, and a step that then reads it is told to fetch it again. A value no one has read in a day is dropped regardless, and the browser's own storage quota caps this further (at most half of it). 0 stores nothing." },
    autoApprovePython: { name: "Auto-approve readonly python_exec calls", tip: "Experimental, off by default while the Python sandbox is being hardened. Run a run's python_exec cells that the read-only Python dialect covers without an approval prompt. Python a page starts by itself always asks, and so does every cell outside the dialect (until dialect membership ships, that is every cell). Code with hidden/bidi characters also still asks." },
    pythonIdleMinutes: { name: "Python namespace idle limit (minutes)" },
    detachedTaskMaxMin: { name: "Detached task limit (minutes)" },
    taskNotifyOnly: { name: "Finished tasks only notify" },
    taskTurnChainMax: { name: "Turns finished tasks may start in a row" },
    autoApproveSelfSource: { name: "Auto-approve reading the agent's own repo source", tip: "Default ON. Auto-approve an UNCREDENTIALED fetch_url/ml.fetch of the agent's OWN repo source — committed files (raw.githubusercontent.com) or structural/code API endpoints (api.github.com/repos/<owner>/<repo>/…), locked to this build's repoUrl — so it can read the code it's running to explain/debug itself. NEVER auto-approves user-generated PROSE endpoints (issues/pulls/comments/discussions/reviews/releases — a prompt-injection surface), a credentialed fetch, or a rendered load; those still ask. Public, read-only, uncredentialed → near-zero risk." },
    agentSeesFocus: { name: "Tell the agent where you are", tip: "Default ON. When you are not on the agent's tab, chat_metadata says where you are: the chat page (reading this run or not), another tab, or away from the browser. A run started from the extension's UI also gets that tab's site and title; a page-started run only \"another tab\". Never a full URL, never a private window. Off: nothing about where you are." },
    scrubPersonInput: { name: "Take registered secrets out of what you send", tip: "Default ON. A registered secret's value, and the extension's own saved API key, in a message you send, a paste or an attached file's text reaches the model and the stored session as [REDACTED:<NAME>], with a line telling the model a secret was redacted. Off: what you send reaches the model as typed. A run cannot change this setting." },
    selfIntrospection: { name: "Let the agent read its own run (ml.current)", tip: "Default ON. The agent may read its own run with `ml.current` in a read-only exec the extension hosts (never on the page), and its system prompt tells it so. Off: `ml.current` is absent and the prompt says nothing about it." },
    protoStream: { name: "Wire format", tip: "Default AUTO. Ask for the streamed chat reply as varint-delimited PROTOBUF (Accept: application/protobuf) rather than OpenAI SSE, which re-sends the id/model/created/choices envelope for every token — measured here at 25x fewer bytes (7343 → 292). Self-negotiating, which is why asking by default is safe: the RESPONSE's content type picks the path, so a backend that doesn't serve it answers with the usual SSE and nothing breaks. ON sends the same request but REPORTS a reply that came back as SSE (once per URL, in the worker's console) — for when you believe your backend serves it; it never fails the call over it. OFF never sends the header. Tool calls and reasoning decode fine. Skipped for a call carrying toolIds, because OpenWebUI's source citations are emitted on a different route than protobuf is served over and would vanish silently. Saves BYTES, not time." },
    pierceClosedShadow: { name: "Pierce closed shadow roots", tip: "Let the DOM tools reach inside CLOSED shadow roots too (normally selector-invisible). A tiny script captures each closed root as the page builds it — the tools then treat it like an open root (same `host >>> inner` syntax). Closed shadow DOM is encapsulation, not a security boundary, so this doesn't cross any origin. On by default: the capture script wraps attachShadow on every page regardless of this setting (capture only — page behaviour is unchanged), so this just gates whether the tools use it. Turn it off to keep the tools' selector reach limited to open roots. Declarative/native closed roots still can't be captured; the agent falls back to visual locate/@pt for those." },
    execDefaultWorld: { name: "Where exec runs by default", tip: "Where the agent's approved `exec` runs when it does not say. **Page**: the page's own JavaScript world, where it sees the page's globals and the page's scripts can see it. **Isolated**: a world of its own on the page (user scripts, else the debugger), sharing the DOM but hidden from the page's scripts; the page's world when neither is available. **Build default**: what this build ships (page). The agent can still ask for a world per call, and an exec that reads `ml.current` or a pointer, or runs on a site you have not approved, is isolated whatever this says." },
    shellEnabled: { name: "Let scripts run programs (ml.sh)", tip: "Off by default. On: an approved exec may call ml.sh, and each call still asks you." },
    shellRoots: { name: "Workspace folders", tip: "Absolute paths, one per line. A call's working folder must be inside one; with the sandbox on, programs may write only inside them." },
    shellSandbox: { name: "Run programs under the OS sandbox", tip: "On by default. Each call runs under the OS sandbox: writes only inside the workspace folders, no network, credential folders hidden. Where no sandbox is available, every call's card says so." },
    shellPath: { name: "Program search path (optional)", tip: "Directories to look programs up in, in order, one per line. Empty: the host's default (your PATH plus the usual system folders)." },
    shellRevealsAllow: { name: "Programs that may show other processes", tip: "Programs such as ps, lsof and top show every process's command line, user and open files, including other programs' arguments. Their calls ask until the program is listed here, one per line; a listed program's calls that would otherwise run without asking then do. Only you change this list: here, or with \"Always allow\" on such a call's card." },
};

/**
 * A setting's value as a card shows it, one line per list entry and every entry in full: a flag as on or off, an empty
 * list or string as what it means. Never shortened, never a count (MODEL_SETTINGS.md, ruling 2).
 * @param v the value
 * @returns the lines to draw, in order
 */
export function settingValueLines(v: unknown): string[] {
    if (v === true) return ["on"];
    if (v === false) return ["off"];
    if (Array.isArray(v)) return v.length ? v.map((x) => String(x)) : ["(none)"];
    if (v === "") return ["(empty)"];
    return [typeof v === "string" ? v : JSON.stringify(v) ?? String(v)];
}
