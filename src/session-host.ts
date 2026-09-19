// THE SESSION CONTRACT: what a session source offers a client. One interface, `SessionHost`, implemented by the
// chat page's local host (this extension's own messaging) and by the hub host (a relay to remote runtimes), and
// encoded by the hub as its `Command` / `SessionEvent` / `Capability` messages. Prose, rules and rationale:
// docs/spec/SESSION_CONTRACT.md.
//
// Types plus two pure helpers, no `chrome.*`, so the sidebar bundle, a plain web page (a phone) and an agent client
// can all import it. Every value arriving through it is UNTRUSTED input to the client: strings render as escaped
// text, and an unknown kind, command or version is skipped, never guessed at.
import type { JsonSchema } from "./contract";
import type { ElementContext } from "./contract-run";
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
export type Scope = "view" | "drive" | "approve" | "screen" | "desktop" | "admin";

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
    /**
     * The runtime's settings can be edited from this client. Local by design, not only today: the settings include
     * the backend URL, the API key and `modelFilter`, and a setting that repoints where this runtime sends its
     * traffic is not something a remote client may change, whatever scopes it holds. A remote runtime never sets it.
     */
    localSettings?: boolean;
    /** `device.*`: this runtime holds paired devices and can list, renew, revoke and re-scope them */
    devices?: boolean;
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
    /**
     * The session's title: generated by the runtime once it has something to summarise, or set by `session.rename`.
     * The runtime's, so every device shows the same one. Absent until one exists; a client falls back to `task`.
     */
    title?: string;
    /** set by `session.rename`: the runtime never re-titles a session someone named */
    renamed?: true;
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
    /**
     * Kept whatever the runtime's caps and retention would otherwise drop, set by `session.pin`. Pinning also saves
     * the session, since a pin on something that dies with the worker keeps nothing. Absent: not pinned.
     */
    pinned?: boolean;
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
    /**
     * This event's position in the session's history, counted the way `session.backfill` counts it (0 is its first
     * event). A cursor is a position in a STREAM and says nothing about how much of the session came before it; this
     * does. Absent when the runtime cannot say. A transport that replays a short ring reads it to tell a client
     * where paging back starts.
     */
    pos?: number;
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
        /**
         * Where the contiguous run of events this subscription ended with begins in the session's history: a client
         * asks `session.backfill { before: from }` for what precedes it. 0 when the stream starts at the session's
         * first event. Events at lower positions may have been sent as well: a runtime keeps a session's START in a
         * short ring, because without it a reducer has nothing to hang the rest on, so a client drops by `pos` what a
         * page repeats. Absent when the runtime cannot say, or on a resume (the client keeps what it had), and then a
         * client offers no paging from this subscription.
         */
        from?: number;
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
    /**
     * Keep a session, or stop keeping it. It is the runtime's because eviction is: a pin kept only on one device
     * cannot stop the runtime dropping the session. Unpinning leaves the session saved, and subject to the usual caps
     * and retention again. The runtime bounds how many sessions may be pinned and answers `conflict` past it.
     */
    | { type: "session.pin"; session: SessionId; pinned: boolean }
    /**
     * Name a session. The runtime trims and caps the title and emits the row as an `upsert`. An empty title returns
     * the session to a generated one. A renamed session is never re-titled by the runtime.
     */
    | { type: "session.rename"; session: SessionId; title: string }
    /** The models a runtime would accept for `chat.start` / `agent.start`: after its own whitelist, so the whitelist
     *  holds over the contract too. */
    | { type: "models.list"; runtime: RuntimeId }
    /**
     * Sessions a page at a time, newest activity first: those whose `lastTs` is before `before` (exclusive), so a
     * client pages by handing back the last row's `lastTs`. Archived sessions are included, marked, unless `archived`
     * says only them (true) or none of them (false). What the index snapshot holds is the recent part; this reaches
     * the rest.
     */
    | { type: "sessions.list"; runtime: RuntimeId; before?: number; limit?: number; archived?: boolean }
    /** Sessions matching a query, in the same rows and paging as `sessions.list`: every word an archived session's
     *  events hold, and a live session's title, task and page title. */
    | { type: "sessions.search"; runtime: RuntimeId; query: string; before?: number; limit?: number }
    /** Bring an archived session back into the live store, so it can be opened, resumed, pinned or deleted like any
     *  other. Its row then arrives by `upsert`. A session that is not archived answers ok and changes nothing. */
    | { type: "session.unarchive"; session: SessionId }
    /** Where the runtime's saved-session storage goes, now and day by day: what the Storage page draws. */
    | { type: "storage.stats"; runtime: RuntimeId }
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
    /**
     * Pick a SAVED session up again on another page. From the agent's side this is a navigation — everything in its
     * context describes the page it last ran on — so it names a target the way `agent.start` does rather than going
     * through `session.send`, which would reach a page that no longer holds it.
     *
     * The hash does not change: it stays one conversation on every surface, and the result says so by answering
     * with the same id. What the session keeps and what it loses is in `CHAT_PAGE.md` §Resuming, and the runtime
     * says which in the `session-resumed` event that opens the new turn.
     */
    | { type: "session.resume"; session: SessionId; target: AgentTarget; idempotencyKey?: IdempotencyKey }
    /**
     * What a runtime IS, asked of the runtime itself.
     *
     * A transport cannot answer this. A hub carries identity and liveness and deliberately nothing else — the moment
     * it holds a claim about what a runtime can do, a client is trusting it for something other than routing — so the
     * four fields here have to come from the runtime, over the same authenticated channel as every other command.
     *
     * A client asks once when a runtime appears and again when it reconnects, because a runtime that restarted may
     * have been upgraded under it.
     */
    /**
     * A page of one session's events, from the runtime itself.
     *
     * A subscription resumes from a position, and a relay's ring is short: a client that subscribes to a session
     * from last Tuesday is answered `truncated` and has nowhere to read the rest. Locally the index serves that
     * in-process, which is why the contract has never needed it; across a relay there is no in-process.
     *
     * It reads the page of events ENDING just before `before`, so a transcript fills upwards the way a person
     * scrolls back. Paged, because one session's events include screenshots and a whole run does not belong in one
     * answer.
     *
     * `before` is a position in the SESSION'S OWN HISTORY — 0 is its first event ever — and is deliberately NOT the
     * stream cursor: a cursor counts across every session on a runtime and is not kept for an event once it is on
     * disk. Absent means "from the end". A client pages by passing back the `from` it was given.
     */
    | { type: "session.backfill"; session: SessionId; before?: number; limit?: number }
    | { type: "runtime.info"; runtime: RuntimeId }
    | { type: "tabs.list"; runtime: RuntimeId }
    /** The devices paired with this runtime's account, as a person manages them. Needs `admin`, which is granted at
     *  the runtime and never passed on. */
    | { type: "device.list"; runtime: RuntimeId }
    /** Issue a fresh certificate for a device that still holds a valid one. A device past its expiry cannot be
     *  renewed — it can no longer prove who it is — and pairs again instead; the runtime answers `conflict`. */
    | { type: "device.renew"; runtime: RuntimeId; principal: PrincipalId; idempotencyKey?: IdempotencyKey }
    /** Unpair a device: it stops being answered at once, and the stream keys it held are rotated. Revoking the
     *  device this client IS logs this client out, which a UI says before it happens. */
    | { type: "device.revoke"; runtime: RuntimeId; principal: PrincipalId; idempotencyKey?: IdempotencyKey }
    /** Narrow or widen what a device may do, never beyond what this client holds.
     *
     *  `approve`, `control` and `admin` are granted at the runtime alone, so a command carrying one is refused with
     *  `forbidden` — the client asked for something it may not ask for — rather than being silently dropped from the
     *  list. Scopes are an open enumeration, and these are the members that must never be settable over the wire. */
    | { type: "device.scopes"; runtime: RuntimeId; principal: PrincipalId; scopes: Scope[] }
    /**
     * Bring a tab, and the window holding it, to the front. What a person at the machine is LOOKING AT, which is why
     * it is `drive` and not `view`: watching a runtime should not be able to move its windows.
     *
     * Only a tab `tabs.list` would show, i.e. an http(s) one. A client can only have GUESSED any other id, so it is
     * answered `not-found` rather than `forbidden`, which would confirm that the tab exists.
     */
    | { type: "tab.focus"; runtime: RuntimeId; tabId: number }
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
    "session.pin": "drive",
    "session.rename": "drive",
    "models.list": "view",
    "storage.stats": "view",
    "sessions.list": "view",
    "sessions.search": "view",
    "session.unarchive": "drive",
    "approval.answer": "approve",
    "chat.start": "drive",
    "agent.start": "drive",
    "session.resume": "drive",
    "session.backfill": "view",
    "runtime.info": "view",
    "tabs.list": "drive",
    "device.list": "admin",
    "device.renew": "admin",
    "device.revoke": "admin",
    "device.scopes": "admin",
    "tab.focus": "drive",
    "tab.screenshot": "screen",
    "page.highlight": "drive",
    "side.call": "drive",
};

/** A principal's id: SHA-256 of its identity public key, as LOWERCASE hex. Stable across renewal, because a renewed
 *  certificate is a new certificate over the SAME key — so a client tells its own row from the others by comparing
 *  this with the id it computes from its own key, and a row that vanishes and reappears is a device that regenerated
 *  its key rather than a rename the list failed to notice.
 *
 *  The case is part of the contract because that comparison is `===`: a runtime sending `0A3F…` to a client holding
 *  `0a3f…` shows no "this device" row and no logout warning, with nothing wrong to see in either value. */
export type PrincipalId = string;

/**
 * Is this runtime id ABSOLUTE — one that denotes the same machine wherever it is read?
 *
 * A principal id is SHA-256 of an identity key, so it does. `local` does not: it is the one RELATIVE name in this
 * namespace, and it means whoever is holding it. That is harmless while it stays on one machine and is a name
 * collision the moment it does not — two browsers each holding `local:a1b2c3d4` are two different sessions with one
 * name, and the runtime id is the thing that was supposed to prevent exactly that (a hash is 8 hex and unique only
 * within its runtime).
 */
export const isAbsoluteRuntimeId = (id: unknown): boolean => typeof id === "string" && /^[0-9a-f]{64}$/.test(id);

/**
 * May this session key LEAVE the machine that minted it — into a signed grant, a lineage another runtime walks, or a
 * link somebody opens elsewhere?
 *
 * Aliases are RECOGNISED, never emitted. A runtime answers to every name it has had, because a page open across a
 * pairing and a key kept on disk still use the old one; but what it writes down is always the absolute id. Without
 * that rule the alias stops being a migration that drains and becomes a second name that accumulates users.
 *
 * The three places this protects, none of which is built yet, which is why the rule is written now:
 * - `Grant.sessions`: a session list inside a SIGNED certificate, read by a different device and un-editable for up
 *   to the certificate's life. A relative name in a capability means one session to the granter and something else
 *   to the holder.
 * - `Lineage.parent`, which the contract says may be on another runtime, and which the runtime WALKS to decide
 *   whether a `started` grant covers a session. A stale `local:` fails that walk on a runtime now called something
 *   else — access denied where it should be granted, which is the safe direction and still a bug — while a matching
 *   one grants access across a name collision, which is not the safe direction.
 * - Anything meant to be opened elsewhere: `#s=local:<hash>` on a phone names the phone.
 */
export const isPortableSessionKey = (key: string): boolean => {
    const id = parseSessionKey(key);
    return !!id && isAbsoluteRuntimeId(id.runtime) && !!id.hash;
};

/** Is this the same principal? The contract says lowercase hex, and this compares as though it might not be: the one
 *  place the answer matters is "is this row the device I am using", where being wrong hides a logout warning and
 *  shows nothing wrong in either value. Strict in what a runtime sends, forgiving in what a client believes. */
export const samePrincipal = (a: PrincipalId | undefined, b: PrincipalId | undefined): boolean =>
    !!a && !!b && a.toLowerCase() === b.toLowerCase();

/** What a device still owes, for a list that has to be honest about a revocation that has not finished.
 *
 *  Revoking rotates the stream keys the device held, which the RUNTIME does, so a runtime that is offline has not
 *  done it yet. Both numbers are the runtime's own state, not the relay's. */
export interface RotationOwed {
    /** streams whose keys have not been rotated away from this device yet */
    streams: number;
    /** epoch ms ON THE RUNTIME'S CLOCK when the oldest of them became owed */
    oldestOwedMs: number;
}

/** One device paired with a runtime's account.
 *
 *  There is deliberately no "may this client administer" field: that is `COMMAND_SCOPE` against the grants the
 *  runtime already reported, which is the one table both sides read. Two answers to one question disagree
 *  eventually, and a `forbidden` from `device.*` should stay a bug rather than becoming a normal answer. */
export interface DeviceInfo {
    principal: PrincipalId;
    /** what a person called this device when pairing it (untrusted text) */
    label: string;
    /** OPEN on the wire: a runtime may report a role this client does not know, rendered as a generic device */
    role: "client" | "runtime" | "box-connector";
    kind: "browser" | "phone" | "desktop" | "headless";
    scopes: Scope[];
    /** May this device issue certificates of its own — pair another device, by itself, without `admin` and without
     *  asking the runtime? It is a field of the certificate rather than a scope, so `scopes` cannot carry it, and it
     *  is the distinction a person revoking a device most needs: a phone that can pair another phone is not the same
     *  thing as a phone that can drive a run. Absent means no. */
    mayPair?: boolean;
    /**
     * May this device SIGN revocations for the account? Held by exactly one principal at a time, granted at the
     * root, and never delegable.
     *
     * A list shows it because revoking this row removes the account's ability to revoke ANYTHING until the root
     * grants the power again — so it is not "this device has a power", it is "do not revoke this one casually, and
     * fetch the root device first if you mean to". It is not a flag that is always true of the same row either: the
     * reason for holding it here rather than holding the root is that a lost laptop is survivable, and surviving
     * one means the root moves this to another runtime.
     */
    mayRevoke?: boolean;
    /** epoch ms, the runtime's clock. A device past this cannot renew itself and pairs again. */
    notAfterMs: number;
    /** epoch ms, the runtime's clock. The only thing that makes a forgotten device visible, since a runtime renews
     *  everything on its allowlist: expiry therefore bounds "this runtime stopped running", not "somebody forgot
     *  this device". Absent: never seen since pairing. */
    lastSeenMs?: number;
    /** the principal that issued this device's certificate, so a delegated device shows whose it is */
    grantedBy?: PrincipalId;
    /** absent when nothing is owed */
    rotation?: RotationOwed;
}

/** A browser tab on a runtime. */
export interface TabInfo {
    tabId: number;
    url: string;
    title: string;
    active: boolean;
    windowId?: number;
    /** its position in its window's tab strip */
    index?: number;
    /** the tab group it is in; absent when it is in none. Names and colours come in `tabs.list`'s `groups`. */
    groupId?: number;
    /**
     * A small icon as a `data:image/…` URL the RUNTIME fetched, never the site's own icon URL: a client loading that
     * would tell each site, and the client's network, what the runtime has open. Absent when there is none.
     */
    favicon?: string;
}

/** A tab group, for a picker that draws tabs the way the browser's strip does. */
export interface TabGroupInfo {
    id: number;
    title?: string;
    /** the browser's colour name (`blue`, `red`, …); a client maps it to its own palette */
    color?: string;
}

export type { StorageReport, StorageSnapshot } from "./session-storage-stats";
import type { StorageReport } from "./session-storage-stats";

/** A session as a paged list or a search shows it: its index row, marked when it is in the long-term archive. */
export type ListedSession = SessionSummary & {
    /** in the archive, not the live store: `session.unarchive` brings it back before it is opened */
    archived?: true;
    /** on a search: where it matched, plain text, the match in «guillemets» */
    match?: { snippet: string };
};

/** One model a runtime offers, for a picker. */
export interface ModelChoice {
    id: string;
    kinds?: string[];
    default?: true;
    /** where it runs: on the runtime's own Ollama, or a cloud model its backend passes through. Absent: not known */
    where?: "local" | "cloud";
}

/** What a successful command returns, by type. */
export interface CommandResultData {
    /** `steer`: queued into the running loop; `turn`: started the next turn */
    "session.send": { mode: "steer" | "turn" };
    "session.cancel": Record<string, never>;
    "session.continue": Record<string, never>;
    "session.delete": Record<string, never>;
    /** the row changes through the index, as an `upsert`, like every other change to a session */
    "session.pin": Record<string, never>;
    /** the title as the runtime stored it (trimmed and capped); empty when it went back to being generated */
    "session.rename": { title: string };
    /**
     * Each model the runtime would accept. `kinds` are its capabilities where the backend reports them
     * (`completion`, `tools`, `vision`, `thinking`, `embedding`), absent when unknown, which is not "none". `default`
     * marks the one a start command gets when it names no model. Empty when the backend could not be reached: a
     * picker then shows the default and sends no `model`.
     */
    /** `filtered`: the runtime's model access filter is on and hid `hidden` of its backend's models. Only that it is
     *  on and how many, never the filter itself, which no client reads. */
    "models.list": { models: ModelChoice[]; filtered?: { hidden: number } };
    /** `unsupported` from a runtime that saves nothing. Sizes are serialized bytes, the measure the budget uses. */
    "storage.stats": StorageReport;
    /** `more`: another page exists below this one */
    "sessions.list": { sessions: ListedSession[]; more: boolean };
    "sessions.search": { sessions: ListedSession[]; more: boolean };
    "session.unarchive": { session: SessionId };
    /** `false`: the gate was already closed (answered on another surface, or the run was cancelled). Not an error:
     *  every surface shows the outcome from the session's events either way. */
    "approval.answer": { resolved: boolean };
    "chat.start": { session: SessionId };
    "agent.start": { session: SessionId };
    /** the same session, because resuming is not starting a new one */
    "session.resume": { session: SessionId };
    /**
     * Older events, OLDEST-FIRST within the page so a client applies them in stream order, from a page that ends
     * just before `before`.
     *
     * `from` is this page's first event's position, which is what a client passes back as the next `before`.
     * `epoch` is the runtime's, and a client holding a different one throws away what it has rather than stitching
     * two histories together. `more` says another page exists BELOW this one; `truncated` says it does not exist
     * anywhere any more, which is a different sentence and the one a reader has to be told.
     */
    "session.backfill": { session: SessionId; epoch: string; events: MlDebugEvent[]; from: number; more: boolean; truncated: boolean };
    /** What a transport cannot know about a runtime, from the runtime. `nowMs` is its OWN clock at the moment it
     *  answered, which is how `clockOffsetMs` is estimated: the round trip bounds the error. */
    "runtime.info": { kind: RuntimeInfo["kind"]; contractVersion: number; capabilities: RuntimeCapabilities; nowMs: number };
    /** Windows in order, the focused one first; each window's tabs in strip order. `groups` only where the runtime
     *  can name them (in this browser, after the optional `tabGroups` permission was granted). */
    "tabs.list": { tabs: TabInfo[]; groups?: TabGroupInfo[] };
    "device.list": { devices: DeviceInfo[] };
    /** the new window, so a list can say when it next needs attention without asking again */
    "device.renew": { notAfterMs: number };
    "device.revoke": Record<string, never>;
    "device.scopes": { scopes: Scope[] };
    "tab.focus": Record<string, never>;
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
