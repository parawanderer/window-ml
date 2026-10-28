// contract-debug.ts — the DEBUG EVENT STREAM: every shape the core emits about a session as it runs.
//
// One event per thing that happened, each extending DebugBase, together forming the MlDebugEvent union. This
// is what the sidebar, the DevTools panel, the chat page and the session index all read, and what `run.json`
// carries as `session.events` — so a field added here is a field four surfaces may render and an export may
// promise. Types only; erased at build. Re-exported from contract.ts, which stays the address everything
// imports from.
// Type-only, so the cycle with contract.ts (which re-exports this file) erases at build entirely.
import type { JsonSchema } from "../contract";
import type { ExtendProfile, NeutralMessage, TokenUsage, GenPhase } from "./contract-chat";
import type { RemoteToolTarget, RemoteTiming, ShCallSpan, PersistGrant, ReusedGrant, StartAsk } from "./contract-agent";
import type { RenderDescriptor, ToolFeedback, AnswerMedia } from "./contract-render";

/** Groups turns of one createChat conversation; `turn` is the 0-based index. */
export interface SessionRef {
    hash: string;
    turn: number;
}

/** What was ASKED of the model on one chat turn, as the sidebar and the exports replay it: the messages that
 *  went out, the images with them, and which model was named before the config resolved it. */
export interface DebugChatRequest {
    model: string | null;
    /** so a pending turn can resolve its model from the config before the result lands */
    extend: ExtendProfile | null;
    messages: NeutralMessage[];
    images: string[] | null;
    toolIds: string[] | null;
    schema: boolean;
    think: boolean | null;
    maxTokens: number | null;
}

/** The session's creation config — the options passed to createChat (à la
 *  `ml.createChat({ think: true })`). This is what the sidebar shows as the
 *  "options" block, kept distinct from the per-turn request + message history
 *  (full history is a separate export feature). */
/** @unstable INTERNAL, and reachable from the published JSON export — a new variant/member may
 *  appear in any release, so the generated `docs/spec/export.schema.json` marks it open rather
 *  than pinning it. Adding to it is NOT a breaking export change. */
export interface DebugSessionConfig {
    system: string | null;
    model: string | null;
    think: boolean | null;
    schema: boolean;
    toolIds: string[] | null;
    maxTokens: number | null;
    save: boolean;
}

interface DebugBase {
    /** correlates start ↔ result/error */
    id: string;
    ts: number;
    save: boolean;
    session: SessionRef;
}

/** A chat turn STARTED. Emitted before the request goes out, so a turn is visible while it is still running
 *  and a run that never returns still shows what it was doing. */
export interface DebugChatStart extends DebugBase {
    kind: "chat"; streaming: boolean; request: DebugChatRequest; config: DebugSessionConfig;
    /** how the user message is shown when attached files were folded into it (contract-run.ts); the message itself,
     *  in `request.messages`, stays exactly what the model got */
    display?: import("./contract-run").PromptDisplay;
    /** What KIND of call this session holds, when it is not an ordinary chat. `ml.embed()` reports through
     *  this same event — it is a model call that occupies VRAM and takes time, and reusing the machinery
     *  costs no new event kind — but it is not a chat, and labelling it one is a claim about something that
     *  never happened. Absent means chat. */
    sessionKind?: "embed";
}

/** A chat turn ANSWERED. Carries the resolved model (not the one requested) and the usage, which is the only
 *  place a delegated sub-call's token spend can be counted -- the agent loop never sees these. */
export interface DebugChatResult extends DebugBase { kind: "chat-result"; content: string; sources: unknown[] | null; structured: boolean; model: string | null; extend: ExtendProfile | null; reasoning: string | null; usage: TokenUsage | null; }

/** A chat turn FAILED. The turn is terminal either way, so a reader that saw the `chat` is not left waiting. */
export interface DebugChatError extends DebugBase { kind: "chat-error"; error: string; }

/** A chat turn's reply SO FAR, while it streams (a `chat` with `streaming: true`). The chat counterpart of
 *  `agent-stream`: `id` is the turn's, and `content`/`reasoning` are ACCUMULATED, so a surface REPLACES rather than
 *  appends and a dropped or repeated event still converges. Transient: the turn's `chat-result` or `chat-error`
 *  supersedes every one of them and carries the authoritative text. */
export interface DebugChatStream extends DebugBase { kind: "chat-stream"; content?: string; reasoning?: string;
    /** Characters dropped from the FRONT of `reasoning` and `content` together by a hub's live preview, exactly as
     *  on `agent-stream`. Absent means nothing was dropped. */
    elided?: number; }

/** ml.agent runs: a run-start, one event per step (a thought OR a tool call +
 *  result), then a result. `elements` is a COUNT — real DOM nodes can't cross the
 *  window bus (they reach the console via onStep instead). */
/** The agent run's resolved setup — for the sidebar's "agent options" block. */
/** @unstable INTERNAL, and reachable from the published JSON export — a new variant/member may
 *  appear in any release, so the generated `docs/spec/export.schema.json` marks it open rather
 *  than pinning it. Adding to it is NOT a breaking export change. */
export interface DebugAgentConfig {
    /** the resolved system prompt the model actually received */
    system: string;
    /** caller supplied their own `system` (vs the built-in preamble) */
    customSystem: boolean;
    /** description/parameters let the sidebar show the FULL tool definitions (a JSON tree), not just names. */
    /** The run's resolved toolset. `remote` is present when a tool dispatches somewhere else — the single
     *  most important fact about one in a RECORD of a run, since an export listing it beside the local tools
     *  cannot otherwise say that its arguments left the machine. */
    tools: { name: string; requiresApproval: boolean; vision?: boolean; description?: string; parameters?: JsonSchema; summary?: string; remote?: RemoteToolTarget }[];
    maxSteps: number;
    think: boolean | null;
    env: boolean;
    /** the `vision` option AS PASSED (true=forced native · false=off · string=forced reader · null=auto) */
    vision: boolean | string | null;
    /** RESOLVED: does the driver's own model see the pixels natively this run (native vs delegated look)? */
    driverSees?: boolean;
    /** RESOLVED: the vision reader a delegated sub-call uses (equals the driver when native; null = none) */
    visionModel?: string | null;
    systemAppend: string | null;
    /** scripting run: kept out of the in-page HUD (the card reads this to stay hidden) */
    silent?: boolean;
    /** headless run: approval-gated calls are refused (no human to approve) */
    unattended?: boolean;
    /** may this run navigate to other pages (the `navigate` tool + cross-page persistence)? false = off */
    navigate?: boolean;
    /** may this run navigate to OTHER SITES (different origins)? true only when opted in */
    crossOrigin?: boolean;
    /** where privileged gates are resolved: "ui" (default) · "both" (UI + __mlApprovals IPC) · "external" (IPC only) */
    approvalRouting?: "ui" | "both" | "external";
    /** did this run STREAM the model's thinking/reply live (opt-in `stream:true`)? Shown in the agent-options
     *  block so you can tell whether a step's "thinking" was live or only landed at the turn's end. */
    stream?: boolean;
}

/** Live model output DURING a step, before the turn resolves — only when the run opted into `stream:true`.
 *  Carries the ACCUMULATED-so-far reasoning/content (the UI REPLACES, not appends, so a dropped/duplicated
 *  event still converges). Lets a long "thinking" phase show its text live instead of a frozen token count. */
export interface DebugAgentStream extends DebugBase { kind: "agent-stream"; step: number; localStep?: number; reasoning?: string; content?: string;
    /** The ENGINE's running count of tokens generated so far this call — thinking, answer and a tool call's
     *  arguments alike. Absent when the server does not send one (then a surface estimates from the text). */
    tokens?: number;
    /** The same running count, frozen when the call LEFT its thinking phase: how many tokens the thinking took.
     *  Present once a count arrived during thinking; it stops moving when the answer or a tool call starts. */
    reasoningTokens?: number;
    /** Characters dropped from the FRONT of `reasoning` and `content` together, because this event crossed a HUB: a
     *  remote live preview carries a bounded tail rather than everything so far (`LivePreview`, session-relay.ts).
     *  Absent means nothing was dropped, which is every event on the runtime's own surfaces. A reader shows what it
     *  has and says it is a tail; the authoritative text arrives in the step, as it always did. */
    elided?: number;
    /** Tool calls the model is still WRITING, as far as their arguments have arrived, in call order. Display only:
     *  what runs is the parsed call in the step that follows, and a call that never completes simply disappears with
     *  this preview. Absent while no call has begun, and on a wire that delivers calls whole. */
    calls?: LiveToolCall[]; }

/** One tool call as far as the model has written it: its name, once the stream has said it, and the argument TEXT so
 *  far, which is JSON cut off anywhere (`parseLooseJson` with `keepOpenString` reads it). */
export interface LiveToolCall {
    /** Its position among the turn's calls. */
    index: number;
    /** The tool, once its first fragment has named it. */
    name?: string;
    /** The argument text so far. Absent when a hub left it out to bound the preview (`chars` still says how much). */
    args?: string;
    /** How many characters of arguments have arrived. */
    chars: number;
}

/** A model call is UNDERWAY. Emitted the instant the turn's request goes out, and again whenever the
 *  generation changes phase, so a surface can draw the call while it is happening instead of back-dating a
 *  finished block over memory it already drew.
 *
 *  Its own event rather than a flag on `agent-stream`, for two reasons. It must fire on a NON-streaming run
 *  too (there is otherwise no stamp anywhere for "the model started"), and a turn that emits only a tool call
 *  produces no content or reasoning deltas at all — so `agent-stream` never fires and the longest span on a
 *  local box would stay invisible. `ts` is when the call started; a later event for the same `step`
 *  supersedes the earlier one. Cleared when the step lands. */
export interface DebugAgentTurn extends DebugBase { kind: "agent-turn"; step: number; localStep?: number; phases?: GenPhase[]; }

/** `pageUrl`/`pageTitle` are where the run STARTED. Recorded because "which page" is close to a primary
 *  key when comparing runs, and was otherwise recoverable only by regexing it back out of the system
 *  prompt — prose, and only present when `env` was on. A run that navigates ends somewhere else. */
export interface DebugAgentStart extends DebugBase { kind: "agent"; task: string; images?: string[]; /** how the task is shown when it is not what the person typed (contract-run.ts) */ display?: import("./contract-run").PromptDisplay; model: string | null; maxSteps: number; config: DebugAgentConfig; resumed?: boolean; pageUrl?: string; pageTitle?: string; }

/** Where a nested ask stands. `unattended`: the run had nobody to ask, so it was refused at once; `timeout`: nobody
 *  answered in time; `ended`: the run's turn ended while it waited; `limit`: the step had already asked too often. */
export type AskState = "pending" | "allowed" | "denied" | "cancelled" | "timeout" | "unattended" | "ended" | "limit";

/** Why a call asks: a policy that used to cover it is gone, or a Python cell is outside the read-only dialect. `line` for
 *  the approval card, `detail` the sentence the model read in the tool result (so the tooltip and the export show what
 *  the model saw). */
export interface AskWhy {
    line: string;
    detail: string;
    /** Why it asks, as a slug: why the policy is gone (`archived`, `removed`, `narrowed`), `outside-dialect`, `ask-policy`
     *  (an `ask` policy matched, and the card offers no "remember"), `nav-only` (a read of an origin a policy lets the run go
     *  to, not read), or `start-left` (a read of the start origin once the tab has left it). */
    cause: string;
    /** The gone policy's label, or for `ask-policy` the policy that asks; absent when no policy is involved. */
    policy?: string;
    /** `outside-dialect` only: an earlier cell of the run ran with the JavaScript bridges lifted, so this cell's namespace
     *  can hold what it took (the card shows `JS_BRIDGE_KEPT_LINE`). */
    bridged?: true;
}

/** The ask a run raises when its tab arrives on a page an `ask` policy asks about (src/sw/nav-arrival.ts): Approve lets
 *  the run act on the page, Deny takes the tab back. */
export const ARRIVAL_ASK = "arrival";
/** The ask a run raises when its tab arrives on a page a `deny` policy denies: its two answers are Go back (allowed) and
 *  End run (denied). */
export const ARRIVAL_DENIED = "arrival-denied";

/** One nested ask as a step event carries it (docs/spec/ML_WIRE.md, "Per-call asking"). Plain data: every surface draws
 *  it, both exports record it, and its `facts` are the policy's `c` for the call. */
export interface StepAsk {
    id: string;
    /** What kind of call (`sh`), which picks how a surface draws `facts`; an unknown kind is drawn as its facts. */
    kind: string;
    /** The policy's `c` for the call, built in the worker from what it resolved, never from what a script or page said. */
    facts: Record<string, unknown>;
    state: AskState;
    /** Why the call asks when a policy that used to allow it is gone; text only, as on a gate's step. */
    why?: AskWhy;
    raisedAt: number;
    answeredAt?: number;
    /** The person's note on a denial, or why the ask ended without them. */
    note?: string;
    /** The run routes approvals to the external channel only: surfaces show the ask without buttons. */
    external?: true;
    /** What an allowed call reported once it ran, as its consumer recorded it (`sh`: the sandbox applied and the
     *  protected names that changed during it, `ShOutcome`); absent until it ran, or when it reported nothing. */
    outcome?: Record<string, unknown>;
}

/** ONE step of an agent run: a thought, or a tool call together with its result. One event, not three -- the
 *  phases inside it are how the event lane draws where the time went, and splitting them is the arithmetic
 *  that comes out wrong in three places every time. */
export interface DebugAgentStep extends DebugBase {
    kind: "agent-step"; step: number;
    /** The PER-TURN step number (1-based, resets each run()), for the "STEP x/maxSteps" display — `step`
     *  is offset cumulatively across turns so the sidebar's turn groups don't collide, but maxSteps is a
     *  per-turn budget, so the pill must show this local count (turn 2 starts at 1/N again, not 18/20). */
    localStep?: number;
    /** How long the tool itself RAN, in ms — measured around the dispatch, so it excludes the approval gate
     *  (a human deciding is not the tool being slow). Absent when nothing was executed: a denial, a
     *  doomed-action skip, or a step that only carried a thought. */
    toolMs?: number;
    /** How long the approval gate was OPEN, in ms — a human deciding, which is the step's wall time but not
     *  the machine's work. Absent when nothing was gated (auto-approved, read-only, denied without a prompt). */
    approveMs?: number;
    /** PLUMBING: the gap between the model call returning and the tool starting, in ms — parsing the call,
     *  validating its arguments, building the context, the hop to the page on a delegated run. Excludes the
     *  approval gate, which is `approveMs` and its own phase; counting it here would draw the same seconds
     *  twice. It exists because the timeline reconstructs a block's start by subtracting the parts it knows
     *  about, so an unmeasured part does not merely go unlabelled — it shifts the whole block later than the
     *  work happened, against an axis shared with the memory trace. */
    dispatchMs?: number;
    /** A REMOTE executor's own measurement, when the tool ran somewhere else. `toolMs` above is OUR wall
     *  clock around the whole dispatch, so it contains the network and the far end's overhead too; this is
     *  what lets the timeline draw those apart instead of charging the difference to the tool. */
    remoteMs?: RemoteTiming;
    /** The `ml.sh` calls this step made, in the order they finished. Absent when it made none. */
    shCalls?: ShCallSpan[];
    /** A monotonic id per TOOL-call step in a run, so the sidebar can correlate the in-flight START
     *  (pending: true, no result yet) with the completed DONE and patch the row in place. Thoughts
     *  have no seq. `pending` marks the START (render "running…" until the DONE arrives). */
    seq?: number; pending?: boolean;
    /** Design A: a pending step whose background-hosted tool is BLOCKED on the human gate. The sidebar
     *  renders approve/deny controls (instead of "running…") and posts the decision back via SET_APPROVAL. */
    awaitingApproval?: boolean;
    /** `thought` = the assistant's user-facing PROSE (content); `reasoning` = its separate thinking
     *  channel (reasoning_content / message.thinking), rendered as a collapsible "think" section. */
    thought?: string; reasoning?: string | null; tool?: string; arguments?: Record<string, unknown>; result?: string;
    /** What the model ACTUALLY saw as the tool result when it differs from `result` — i.e. `result` PLUS an
     *  appended `@tool:<id>` token line. Kept so the log's raw view stays complete (the AGENTS raw-view rule);
     *  the pretty Out shows `result`, a collapsed "raw · as the model saw it" shows this. */
    modelResult?: string;
    /** LIVE partial output streamed by the tool as it runs (`ctx.stream` — console.log / print), for the
     *  in-flight Jupyter-style Out. A delta emit carries ONLY `{ step, seq, streamOutput }` (no `tool`) so the
     *  reducer patches it additively onto the pending row; the DONE (with `result`) supersedes it. */
    streamOutput?: string;
    /** When each streamed chunk was PRODUCED, as `[offsetInStreamOutput, epochMs]` marks — supplied by the
     *  executor (see ToolContext.stream), never inferred here. The UI reads the mark at or before a line's
     *  offset to show its time; absent → no timestamps to show (a non-streamed result has none). */
    streamMarks?: [number, number][];
    /** the `@tool:<id>` this step was MINTED (opt-in `token:true` on a citable call). The answer renderer matches
     *  it EXACTLY to resolve a `[label](@tool:<id>)` citation — no re-derivation, so it can't drift. */
    token?: string;
    elements?: number;
    /** rich render for the In slot (the call) — else the raw args */
    renderIn?: RenderDescriptor;
    /** rich render for the Out slot (the result) — else the raw result */
    renderOut?: RenderDescriptor;
    /** what this tool fed into the model's context (locate's snap-inject) — the sidebar + export show a
     *  "sent to the model" section (the crop / description + why) */
    feedback?: ToolFeedback;
    /** JSON-Schema mismatches between the args and the tool's parameters */
    argIssues?: string[];
    /** How an approval-gated tool call was decided (undefined for tools that don't
     *  require approval). The sidebar renders it as a green/red provenance badge —
     *  and it's the slot a future interactive-approval control resolves into. */
    approval?: "readonly" | "sandbox" | "same-origin" | "consented" | "self-source" | "user" | "denied" | "skipped" | "cancelled";
    /** button #3: the persistable egress grants this call would establish (its `ml.fetch` literal URLs),
     *  extracted background-side. Present on a pending approval step when there's ≥1 — the surface showing it then
     *  offer an "Approve + remember" control and unfurl exactly this list (what's shown IS what persists). */
    grants?: PersistGrant[];
    /** On a pending approval step: why this call asks when a policy that used to allow it is gone (archived, removed,
     *  edited). Text for the card; it never changed the decision. */
    askWhy?: AskWhy;
    /** NESTED ASKS: calls made from inside this step while it ran that needed the person (an `ml.sh` from an approved
     *  exec), each answered like a gate under `${runId}:${seq}#${id}` (src/sw/sw-asks.ts). Every event of the step
     *  from the first ask on carries the whole list, its history included, so the DONE keeps what was asked. */
    asks?: StepAsk[];
    /** transparency: prior grants this step REUSED (so it auto-ran without a prompt) — a cached `ml.fetch`
     *  URL a read-only `exec` re-read, an already-approved Google Sheet a `python_exec` reused. The sidebar
     *  shows a collapsed "reused a grant you approved" note in the In area, so a no-prompt run explains itself. */
    reused?: ReusedGrant[];
    /** Token counts for this step's driver call, when the server reports them. Each
     *  step re-sends the full growing history, so the LATEST step's usage is the run's
     *  current context occupancy (not a sum across steps — see TokenUsage). */
    usage?: TokenUsage | null;
    /** Running tally (this turn) of tokens spent by DELEGATED vision sub-calls — the auto-wired
     *  look/locate/verify make their own ml.chat() calls the loop never sees. Separate SPEND, not
     *  context occupancy (a different context, gone after the call). Shown beside the UI usage bar. */
    subUsage?: SubcallUsage;
}

/** Delegated-sub-call token tally (look/locate/verify's own vision calls). See DebugAgentStep.subUsage.
 *  `byModel` breaks the aggregate down per vision model, for chat_metadata's "which model cost what". */
export interface SubcallUsageByModel { model: string; prompt: number; completion: number; calls: number; }

/** ONE delegated sub-call: a vision reader, or (when it lands) a background embedding. `ts` is when it
 *  FINISHED and `ms` how long it took, so it can be drawn as a span nested under the step that spawned it —
 *  a total tells you what the reader cost, but not when, or inside which step. */
export interface SubcallRecord { model: string; ts: number; ms: number; prompt: number; completion: number;
    /** What spend needs beyond the counts, as the call's own usage carried it (`TokenUsage`): the server's numbers
     *  verbatim, the price snapshot and the electricity price. Absent where the call reported none. */
    raw?: import("./contract-chat").TokenUsage["raw"];
    prices?: import("./contract-chat").TokenUsage["prices"];
    electricity?: import("./contract-chat").TokenUsage["electricity"]; }

/** What a run spent on model calls it made on its own behalf (a delegated look, locate or verify), totalled,
 *  and optionally broken down by model and by individual call. Separate from the run's own usage because the
 *  loop never sees these turns, so nothing else can add them up. */
export interface SubcallUsage { prompt: number; completion: number; calls: number; byModel?: SubcallUsageByModel[];
    /** The individual calls behind `byModel`. Named `calls_` because `calls` is already the COUNT. */
    calls_?: SubcallRecord[]; }

/** An agent run ENDED, and how: an answer, the step cap, a cancel, or an error. Every run emits exactly one,
 *  which is what lets a reader tell a finished run from one whose page went away. */
export interface DebugAgentResult extends DebugBase { kind: "agent-result"; summary: string; steps: number; hitCap: boolean; cancelled?: boolean; error?: string | null; answerMedia?: AnswerMedia[];
    /** the curated answer SET resolved to markdown (AgentResult.answer) — the card renders it when it carries a
     *  `@tool:` citation (a designated tool output, e.g. a table/image), which the plain summary can't show. */
    answer?: string; }

/** A handle raised the step cap mid-run (a.maxSteps = N) — every surface showing the run updates its
 *  "STEP x/N" display. */
export interface DebugAgentCap extends DebugBase { kind: "agent-cap"; maxSteps: number; }

/** The worker's record of what a page-built run sends the model: the system prompt and tools after its own rewrite (a
 *  tool named like a builtin gets the extension's texts), which the page's `agent` start event cannot know. Folded over
 *  the session's `agentConfig`, so the tool cards and both exports carry what the model saw. */
export interface DebugAgentConfigWire extends DebugBase { kind: "agent-config"; config: Pick<DebugAgentConfig, "system" | "tools">; }

/** A handle inserted a user message into a RUNNING loop (a.say(text)) — shown immediately (pending), even
 *  though the model only sees it at the next step boundary. */
export interface DebugAgentSay extends DebugBase { kind: "agent-say"; text: string; images?: string[]; sayId?: string; /** how `text` is shown when it is not what the person typed */ display?: import("./contract-run").PromptDisplay; }

/** The agent's loop DRAINED a queued steer at a step boundary — flips the bubble's "seen" indicator.
 *  Keyed by `sayId` to the originating `agent-say`; may arrive before OR after it (cross-page replay
 *  reorders), so the reducer converges either way. */
export interface DebugAgentSaySeen extends DebugBase { kind: "agent-say-seen"; sayId: string; }

/** The event stream injected.js emits over window.postMessage for the sidebar. */
/**
 * A saved session picked up again on a different page (`session.resume`). The FIRST event of the new turn, and a
 * fact about the session rather than something anybody said: the log draws it as a divider, and the model is told
 * the same thing in its own transcript, because everything in its context describes the old page.
 *
 * It is SESSION-level rather than chat- or agent-level, and it is the only kind that is: a chat and a run resume
 * for the same reasons and lose the same things. That is also why it never creates a session — a note about a
 * session nobody holds is not a session, and the index refuses it.
 */
export interface DebugSessionResumed extends DebugBase {
    kind: "session-resumed";
    /** the page it is resuming ON */
    url: string;
    /** the page it last ran on, when that is known */
    fromUrl?: string;
    /** how long it had been idle, in ms, so a reader sees "after two days" rather than doing arithmetic */
    afterMs: number;
    /** what did not survive, in words a person reads (the divider, the exports; never sent to the model): "the page's state object", "cached fetches",
     *  "tools a page script defined", "approval grants". Never empty — something is always dropped. */
    dropped: string[];
    /** The run's policies the session carried across the resume, by label (sw-policies.ts). Absent when none. */
    kept?: string[];
}

/** Every event the debug stream carries about a session: a chat's turns, an agent run's lifecycle and live previews. */
export type MlDebugEvent = DebugChatStart | DebugChatResult | DebugChatError | DebugChatStream
    | DebugAgentStart | DebugAgentStep | DebugAgentResult | DebugAgentCap | DebugAgentConfigWire | DebugAgentSay | DebugAgentSaySeen | DebugAgentStream | DebugAgentTurn
    | DebugSessionResumed;

/** A site asks the person to start, widen or keep driving its agent (docs/spec/SITE_ACCESS_SLICE3.md 1.1): the start
 *  card. Worker-only: a page may never write it (event-admission.ts `WORKER_ONLY_KINDS`). */
export interface DebugStartAsk extends DebugBase { kind: "agent-start-ask"; ask: StartAsk; }

/** A start ask was answered, or will never be: the card clears, or shows "expired". */
export interface DebugStartDecided extends DebugBase { kind: "agent-start-decided"; requestId: string; outcome: "allowed" | "denied" | "expired"; }

/** This run was started by a site (`site` is its origin): its page-sent turns carry that name, and its tool gates take no
 *  focus and no Enter shortcut of their own (Q15). */
export interface DebugAgentSite extends DebugBase { kind: "agent-site"; site: string; }

/** This run was started by the PERSON (built by the worker): its tool gates may take the card's focus and Enter. */
export interface DebugAgentPerson extends DebugBase { kind: "agent-person"; }

/** The site ended its turn waiting for the person (Q2b): the reply box opens under its prompt, labelled as the site's. */
export interface DebugAgentWait extends DebugBase { kind: "agent-wait"; prompt: string; site: string; }

/** A page-sent turn of a site's run, shown with the site's name (Q2a). */
export interface DebugAgentSiteSay extends DebugBase { kind: "agent-site-say"; text: string; site: string; sayId?: string; }

/** One quiet line in a run's step list, written by the worker: a start a page this run opened asked for (Q17). */
export interface DebugAgentNote extends DebugBase { kind: "agent-note"; text: string; site?: string; }

/** The events only the worker writes about a site's agent. Kept out of `MlDebugEvent`: they are live notices for the
 *  surfaces that show the run (the HUD card, the overlay, the DevTools panel), never kept in the session index or an
 *  export. */
export type SiteRunEvent = DebugStartAsk | DebugStartDecided | DebugAgentSite | DebugAgentPerson | DebugAgentWait | DebugAgentSiteSay | DebugAgentNote;

/** Window-bus envelopes between the core (main world) and the sidebar. */
export interface MlDebugMessage { __mlDebug: MlDebugEvent; }

/** The sidebar app saying it has mounted and will now receive events live. Until it does, the core BUFFERS
 *  rather than dropping, so a run started before the panel opened is not half-missing from the transcript. */
export interface MlSidebarReady { __mlSidebar: "ready"; }
