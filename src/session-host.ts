// THE SESSION CONTRACT: what a session source offers a client. One interface, `SessionHost`, implemented by the
// chat page's local host (this extension's own messaging) and by the hub host (a relay to remote runtimes), and
// encoded by the hub as its `Command` / `SessionEvent` / `Capability` messages. Prose, rules and rationale:
// docs/spec/SESSION_CONTRACT.md.
//
// Types plus two pure helpers, no `chrome.*`, so the sidebar bundle, a plain web page (a phone) and an agent client
// can all import it. Every value arriving through it is UNTRUSTED input to the client: strings render as escaped
// text, and an unknown kind, command or version is skipped, never guessed at.
import type { ElementContext, JsonSchema } from "./contract";
import type { NeutralMessage, TokenUsage } from "./contract-chat";
import type { MlDebugEvent } from "./contract-debug";

/* ------------------------------ versioning ------------------------------ */

/** The contract's MAJOR version. Bumped only by a breaking change (a field removed, renamed or re-typed, or a
 *  meaning changed). Adding an optional field, an event kind, a command type or a capability is NOT a bump: an
 *  older peer ignores what it does not know, and a newer client learns what a runtime offers from its
 *  {@link RuntimeCapabilities}, never by comparing version numbers. Every envelope carries it as `v`. */
export const SESSION_CONTRACT_VERSION = 1;

/* ------------------------------ identity ------------------------------ */

/** A runtime's id: opaque to the client. On the hub it is derived from the runtime's public key, so it is unique
 *  across every account and hub, and a client that merges several hosts cannot collide two runtimes. Contains no
 *  `:`. The local host uses the extension's key-derived id once it has one, and `"local"` until then. */
export type RuntimeId = string;

/** A session's global identity. A session hash (8 hex) is unique only within its runtime, so a hash alone never
 *  names a session outside it. */
export interface SessionId {
    runtime: RuntimeId;
    hash: string;
}

/** `runtime:hash`, the string form of a {@link SessionId}: a map key, and the form lane ids are namespaced by
 *  (`run:<runtime:hash>:<i>`, docs/spec/RUNTIME_HUB.md §Rendering a subagent). */
export type SessionKey = string;

/** The {@link SessionKey} for an id. */
export function sessionKey(id: SessionId): SessionKey {
    return `${id.runtime}:${id.hash}`;
}

/** Parse a {@link SessionKey}; null when it is not one. Splits on the LAST `:`, so it holds however a runtime id is
 *  spelled as long as the hash has no `:`. */
export function parseSessionKey(key: string): SessionId | null {
    const i = key.lastIndexOf(":");
    if (i <= 0 || i === key.length - 1) return null;
    return { runtime: key.slice(0, i), hash: key.slice(i + 1) };
}

/** Who a client, or the author of a session or decision, is. On the hub a principal IS a key: `id` is derived from
 *  it. Several people can share one account (a lab), so a person's device and an agent client are told apart by
 *  `kind`, and `name` is a label they chose, never proof of anything. */
export interface Principal {
    id: string;
    /** `local`: this browser's own surfaces (the sidebar, the chat page). `device`: a person's paired device.
     *  `agent`: an agent acting as a client (an orchestrator). `runtime`: a runtime acting on its own. */
    kind: "local" | "device" | "agent" | "runtime";
    name?: string;
}

/* ------------------------------ grants and capabilities ------------------------------ */

/** What a principal may do on a runtime (docs/spec/RUNTIME_HUB.md §Principals and scopes). `approve` is its own
 *  scope and is never implied by `drive`. */
export type Scope = "view" | "drive" | "approve" | "screen" | "desktop";

/** One scope held by THIS client on a runtime, possibly narrowed. Grants are attenuated when passed on, never
 *  widened. The runtime checks every command against its own copy; a client reads these only to decide what to
 *  offer, so a wrong grant here costs a greyed-out button or a `forbidden` result, never access. */
export interface Grant {
    scope: Scope;
    /** Which sessions it covers. `all` (the default when absent), `started`, or an explicit list.
     *
     *  `started` is TRANSITIVE: the sessions this principal started AND every session descended from one of them
     *  through `lineage`, on any runtime. A coordinator's subagent that starts its own subagents (a browser opening
     *  dedicated tabs) stays visible and steerable to the coordinator. The runtime checks it by walking the
     *  session's lineage up to a session the principal started. */
    sessions?: "all" | "started" | SessionKey[];
    /** Epoch ms after which the grant no longer holds. Absent: until unpaired. */
    expires?: number;
}

/** A GPU box a runtime sends model requests to. Its telemetry is a separate feed, not part of this contract. */
export interface BoxRef {
    id: string;
    name?: string;
}

/** What a runtime can do, so a client renders by capability and never by assuming a browser. Every flag means
 *  ABSENT = NO: a runtime built before a capability existed does not offer it, and a client that does not know a
 *  capability ignores it. */
export interface RuntimeCapabilities {
    /** plain chats (`chat.start`) */
    chat?: boolean;
    /** agent runs (`agent.start`) */
    agent?: boolean;
    /** has browser tabs: `tabs.list`, and `agent.start` on a tab or a blank tab */
    tabs?: boolean;
    /** `tab.screenshot` */
    screenshots?: boolean;
    /** `page.highlight`: outline an element or point on the page a session runs on */
    highlight?: boolean;
    /** saved sessions survive a restart of the runtime */
    persistence?: boolean;
    /** `side.call`: small utility-model calls on the client's behalf */
    sideCalls?: boolean;
    /** a Python bench the client can open against this runtime */
    pythonBench?: boolean;
    /** box telemetry is available for the resource panel */
    resourcePanel?: boolean;
    /** the runtime's settings can be edited from this client (the local host only, today) */
    localSettings?: boolean;
    /** RESERVED: `agent.start` with a headless target. False on every runtime today. */
    headless?: boolean;
    /** RESERVED: accepts `agent.start` with `lineage` (a subagent started by another agent). False today. */
    lineage?: boolean;
    /** the boxes this runtime uses */
    boxes?: BoxRef[];
}

/** A runtime as a client sees it. */
export interface RuntimeInfo {
    id: RuntimeId;
    /** a label the runtime's owner chose (untrusted text) */
    name: string;
    /** OPEN on the wire: a runtime may report a kind this client does not know (an app with accessibility APIs, a
     *  CAD wrapper), and the client renders it as a generic runtime. */
    kind: "browser" | "desktop" | "headless";
    online: boolean;
    /** epoch ms, client clock, of the last traffic seen from it; absent for the local host */
    lastSeen?: number;
    /** the MAJOR contract version the runtime speaks. A client skips a runtime whose version it does not know,
     *  and says so, rather than rendering it half-understood. */
    contractVersion: number;
    capabilities: RuntimeCapabilities;
    /** what THIS client holds on it. The local host holds every scope. */
    grants: Grant[];
    /** estimated `runtime clock - client clock`, in ms; subtract it from a runtime timestamp to place it on the
     *  client's clock. Absent: same clock (the local host) or not yet estimated. */
    clockOffsetMs?: number;
}

/* ------------------------------ the session index ------------------------------ */

export type SessionKind = "chat" | "agent" | "embed";

/** Where a session is, for a list. `waiting` is blocked on an approval gate; `capped` stopped at its step cap and
 *  can be continued; `interrupted` stopped without finishing (the runtime restarted under it).
 *
 *  OPEN on the wire: a client reads a status it does not know as `running` (in progress, not finished), so a later
 *  status (a session blocked on a question) degrades to "working" rather than to "done". */
export type SessionStatus = "running" | "waiting" | "done" | "error" | "cancelled" | "capped" | "interrupted";

/** Links a session to the step of another session that started it: the agent-to-agent tree. `parent` may be on
 *  another runtime. `seq` is the spawning step's seq in the parent, which names the step (`step:<parent key>:<seq>`)
 *  its lane bar hangs under; `request` is the spawning call's request id. */
export interface Lineage {
    parent: SessionId;
    seq?: number;
    request?: string;
}

/** One row of the session index. Timestamps are the RUNTIME's clock (see {@link RuntimeInfo.clockOffsetMs}). */
export interface SessionSummary {
    id: SessionId;
    kind: SessionKind;
    status: SessionStatus;
    /** the generated title, once one exists */
    title?: string;
    /** an agent's initial task, or a chat's first message; capped by the runtime */
    task?: string;
    model?: string | null;
    createdTs: number;
    lastTs: number;
    /** open approval gates, so a list can badge a session that is waiting on a person */
    pendingApprovals: number;
    /** the page the session started on; absent for a chat with no page */
    page?: { url: string; title?: string; tabId?: number };
    /** survives a restart of the runtime; false for an ephemeral console or page-script session */
    saved: boolean;
    /** who started it. Absent: not known (a console call, a page script). */
    startedBy?: Principal;
    /** set when another session started this one */
    lineage?: Lineage;
}

/** A change to the index. A subscription opens with one `snapshot` per runtime it covers, then streams changes.
 *  A `snapshot` REPLACES everything the client holds for that runtime (sent again after a reconnect). */
export type SessionIndexUpdate =
    | { type: "snapshot"; runtime: RuntimeId; sessions: SessionSummary[] }
    | { type: "upsert"; session: SessionSummary }
    | { type: "remove"; id: SessionId };

/* ------------------------------ session events ------------------------------ */

/** A position in one session's event stream, to resume a subscription from. */
export interface StreamPosition {
    /** changes whenever the runtime's history for the session was rebuilt (a restart that re-hydrated it); a
     *  cursor means nothing under a different epoch */
    epoch: string;
    /** the last cursor the client applied */
    cursor: number;
}

/** One session event. The payload is the SAME `MlDebugEvent` every surface already reduces (no second event
 *  format), wrapped with a version, the session's global id and a position. A client drops an envelope whose
 *  `event.session.hash` differs from `session.hash`, so no runtime can write into another session's record. */
export interface SessionEventEnvelope {
    v: number;
    session: SessionId;
    epoch: string;
    /** strictly increasing within one epoch, not necessarily contiguous */
    cursor: number;
    event: MlDebugEvent;
}

/** What a session subscription delivers.
 *
 *  Opening one (or re-opening it with `since`) always runs the same sequence: an optional `reset`, the backfill as
 *  `event`s, one `backfilled`, then live `event`s. The events after `since` are sent when the runtime still holds
 *  them; otherwise it sends `reset` and everything it holds. `reset` is sent ONLY when the runtime has history to
 *  replace the client's with: a runtime that has lost a session's history (an ephemeral session after a restart)
 *  sends `backfilled` with `truncated: true` and no `reset`, and the client keeps what it already shows.
 *
 *  Delivery may repeat or reorder events around a reconnect, so a client reduces them with a reducer that
 *  converges regardless of order, as the sidebar's does. */
export type SessionStreamMessage =
    | ({ type: "event" } & SessionEventEnvelope)
    | { type: "reset"; session: SessionId; epoch: string }
    | {
        type: "backfilled"; session: SessionId; epoch: string;
        /** the newest cursor sent so far */
        cursor: number;
        /** older events than the first one sent no longer exist on the runtime */
        truncated: boolean;
    }
    /** the session was deleted; the subscription ends */
    | { type: "gone"; session: SessionId };

/* ------------------------------ commands ------------------------------ */

/** Where an agent runs. A tab id is local to its runtime. OPEN on the wire: a runtime answers a target kind it does
 *  not offer (a desktop window, an app) with `unsupported`. */
export type AgentTarget =
    | { kind: "tab"; tabId: number }
    | { kind: "blank"; url?: string }
    /** RESERVED: requires `capabilities.headless` */
    | { kind: "headless" };

/** A client-chosen key that makes a command safe to retry. A runtime that has already carried out a command with
 *  this key from the same principal (within its dedupe window, at least ten minutes) returns that first result again
 *  and does nothing else. It exists for commands whose repeat would do something twice: starting a session, or
 *  delivering a message. A caller that retries after `aborted` or a dropped connection reuses the key; a new intent
 *  gets a new one. A relay carries it unchanged. */
export type IdempotencyKey = string;

/** An image a client sends: a `data:image/*` URL. Runtimes cap the count and size and drop anything else. */
export type ImageDataUrl = string;

/** Every command a client can send, by `type`. A runtime answers a type it does not know with `unsupported`, so a
 *  newer client talking to an older runtime degrades to a message, never to a guess. The scope each needs is in
 *  {@link COMMAND_SCOPE}. */
export type Command =
    /** A message to a session: steers a running agent (seen at its next step boundary), or starts the next turn of
     *  an idle agent or chat. Text, images, or both. */
    | { type: "session.send"; session: SessionId; text: string; images?: ImageDataUrl[]; elementContext?: ElementContext; idempotencyKey?: IdempotencyKey }
    | { type: "session.cancel"; session: SessionId }
    /** continue an agent that stopped at its step cap, with a fresh step budget */
    | { type: "session.continue"; session: SessionId }
    | { type: "session.delete"; session: SessionId }
    /** Answer an open approval gate, keyed by the pending step's `seq`. Handed to the runtime's one
     *  `resolveApproval`; nothing new decides a gate. `persist` also remembers the call's egress grants, which the
     *  runtime re-derives from the call itself. */
    | { type: "approval.answer"; session: SessionId; seq: number; decision: "approve" | "deny"; persist?: boolean; feedback?: string }
    | {
        type: "chat.start"; runtime: RuntimeId; text: string; images?: ImageDataUrl[];
        model?: string; system?: string; think?: boolean | null;
        /** absent: the session is saved */
        ephemeral?: true;
        idempotencyKey?: IdempotencyKey;
    }
    | {
        type: "agent.start"; runtime: RuntimeId; task: string; images?: ImageDataUrl[]; target: AgentTarget;
        model?: string; maxSteps?: number;
        /** `true` forces native vision on the agent's own model (ml.agent's `vision: true`) */
        vision?: true;
        /** stream the model's thinking and reply live */
        stream?: true;
        /** absent: the session is saved */
        ephemeral?: true;
        /** RESERVED: requires `capabilities.lineage` */
        lineage?: Lineage;
        idempotencyKey?: IdempotencyKey;
    }
    | { type: "tabs.list"; runtime: RuntimeId }
    /** A screenshot on demand, never streamed. `maxBytes` is a ceiling the runtime may lower. */
    | { type: "tab.screenshot"; runtime: RuntimeId; target: { tabId: number } | { session: SessionId }; maxBytes?: number }
    /** Outline an element (`selector`) or a canvas point/box (`token`) on the session's page; `null` clears it. */
    | { type: "page.highlight"; session: SessionId; ref: { selector: string } | { token: string } | null }
    /** A small model call on the client's behalf, for work the UI does about a session: its title, a block
     *  summary, `explain` notes. The runtime always uses its UTILITY model profile and caps `maxTokens`; the client
     *  cannot choose a model, so this cannot become a way to run arbitrary generations on someone's main model. */
    | {
        type: "side.call"; runtime: RuntimeId; purpose: "title" | "summary" | "explain";
        /** the session the call is about, recorded on the request hint */
        session?: SessionId;
        messages: NeutralMessage[]; schema?: JsonSchema; maxTokens: number;
    };

export type CommandType = Command["type"];

/** The scope each command needs. The runtime enforces this; a client uses it to decide what to offer. */
export const COMMAND_SCOPE: { readonly [T in CommandType]: Scope } = {
    "session.send": "drive",
    "session.cancel": "drive",
    "session.continue": "drive",
    "session.delete": "drive",
    "approval.answer": "approve",
    "chat.start": "drive",
    "agent.start": "drive",
    "tabs.list": "drive",
    "tab.screenshot": "screen",
    "page.highlight": "drive",
    "side.call": "drive",
};

/** A browser tab on a runtime. */
export interface TabInfo {
    tabId: number;
    url: string;
    title: string;
    active: boolean;
    windowId?: number;
}

/** What a successful command returns, by type. */
export interface CommandResultData {
    /** `steer`: queued into the running loop; `turn`: started the next turn */
    "session.send": { mode: "steer" | "turn" };
    "session.cancel": Record<string, never>;
    "session.continue": Record<string, never>;
    "session.delete": Record<string, never>;
    /** `false`: the gate was already closed (answered on another surface, or the run was cancelled). Not an error:
     *  every surface shows the outcome from the session's events either way. */
    "approval.answer": { resolved: boolean };
    "chat.start": { session: SessionId };
    "agent.start": { session: SessionId };
    "tabs.list": { tabs: TabInfo[] };
    "tab.screenshot": { image: ImageDataUrl; width: number; height: number; ts: number };
    "page.highlight": Record<string, never>;
    /** `structured` is the parsed JSON when a `schema` was sent */
    "side.call": { content: string; structured?: unknown; usage?: TokenUsage | null };
}

export interface CommandError {
    /**
     * - `unsupported`: the runtime does not know or offer this command (or this option, such as a headless target)
     * - `forbidden`: this client lacks the scope, or the grant does not cover the session
     * - `not-found`: no such session, gate, tab or runtime
     * - `invalid`: malformed arguments
     * - `conflict`: not possible in the session's current state (continue on a run that is not capped)
     * - `unavailable`: the runtime is offline or unreachable
     * - `aborted`: the caller's signal fired first; the command may still have been delivered
     * - `failed`: it ran and failed; `message` says why
     */
    code: "unsupported" | "forbidden" | "not-found" | "invalid" | "conflict" | "unavailable" | "aborted" | "failed";
    /** untrusted text from the runtime */
    message: string;
}

export type CommandResult<T extends CommandType> =
    | { ok: true; data: CommandResultData[T] }
    | { ok: false; error: CommandError };

/* ------------------------------ the host ------------------------------ */

export type Unsubscribe = () => void;

/** The host's own connection. The local host is always `online`. */
export type HostStatus =
    | { state: "connecting" }
    | { state: "online" }
    | { state: "offline"; reason?: string; retryAt?: number };

/** A source of sessions. The chat page's local host and the hub host implement it; the UI depends on nothing else.
 *
 *  Subscriptions deliver their current state first and then changes. A listener is never called synchronously
 *  from inside the subscribing call, and never again after its `Unsubscribe` returns. */
export interface SessionHost {
    /** who this client is to the runtimes it reaches */
    readonly self: Principal;
    status(listener: (status: HostStatus) => void): Unsubscribe;
    /** every runtime this client can see, as a whole list on each change (it is short) */
    runtimes(listener: (runtimes: RuntimeInfo[]) => void): Unsubscribe;
    /** the session index, for every runtime or one */
    sessions(listener: (update: SessionIndexUpdate) => void, opts?: { runtime?: RuntimeId }): Unsubscribe;
    /** one session's events, from `since` when the client already holds part of the stream */
    events(session: SessionId, listener: (message: SessionStreamMessage) => void, opts?: { since?: StreamPosition }): Unsubscribe;
    /** Send a command. Never rejects: every failure, abort included, resolves as `{ ok: false }`. */
    send<C extends Command>(command: C, opts?: { signal?: AbortSignal }): Promise<CommandResult<C["type"]>>;
}
