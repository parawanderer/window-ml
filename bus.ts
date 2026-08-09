// The debug event stream + shared runtime state for window.ml. Lives in the page
// main world (bundled into injected.js); owns the sidebar handshake, the replay
// ring, the in-agent-run depth counter (so a tool's internal ml.chat doesn't spawn
// orphan sessions), and the same-tab session registry.

import type { AgentResult, MlDebugEvent, MlHistory, MlAgentHandle } from "./contract";

// ---- Debug sidebar event stream (see sidebar app) ----
// The opt-in sidebar lives in the isolated content-script world; it can't read
// this main-world `ml` state directly, so we push a one-way event stream to it via
// window.postMessage. Emission is gated on a handshake: the shell posts `"present"`
// the moment it mounts (only when config.sidebar is on), then `"ready"` once the
// iframe app is listening. `sidebarPresent` gates ALL buffering, so a disabled
// sidebar stays truly zero-cost. Ring buffer: the app handshakes only after it
// finishes loading, so ml calls in that window were emitted into the void — we
// buffer from "present" and REPLAY on "ready" (each event lands exactly once).
let debugEnabled = false;    // live emission (after the iframe app handshakes)
let sidebarPresent = false;  // a sidebar shell exists at all
let replayed = false;        // the ring was replayed this present-session (guards a double handshake)
const DEBUG_RING_MAX = 200;
const debugRing: MlDebugEvent[] = [];
// Guarded so the module can be imported under Node (tests import it transitively via run-delegation) —
// no window there. In the page main world (its real home) window always exists.
if (typeof window !== "undefined") window.addEventListener("message", (event) => {
    const d = event.source === window && event.data && event.data.__mlSidebar;
    if (d === "present") { sidebarPresent = true; }
    else if (d === "ready") {
        sidebarPresent = debugEnabled = true;
        // Replay the buffered ring ONCE per session — a re-handshake (below) must not re-emit
        // events that already went out (the sidebar/panel append, they don't dedup).
        if (!replayed) { replayed = true; for (const ev of debugRing) { try { window.postMessage({ __mlDebug: ev }, "*"); } catch { /* non-cloneable — ignore */ } } }
    } else if (d === "gone") {
        replayed = false;
        // The sidebar was switched OFF (shell unmounted). Stop emitting AND drop the
        // ring — otherwise we'd keep building events and retaining up to 200 prompts
        // and replies in memory for a UI that no longer exists, until a page reload.
        // Turning the sidebar off must return us to the same zero-cost state as
        // never having turned it on.
        sidebarPresent = debugEnabled = false;
        debugRing.length = 0;
    }
});

// Announce that injected.js is loaded and listening. A page-load RACE otherwise loses the
// handshake: the shell reads config and posts `present`/`ready` — and in devtools mode it
// posts `ready` immediately (no iframe app to wait for) — but injected.js is added as an
// async <script>, so if the shell got there first its handshake landed before this listener
// existed and we'd never go live (until a settings toggle re-posted it). The shell re-sends
// the handshake on `hello`, so it no longer matters who loaded first.
try { window.postMessage({ __mlSidebar: "hello" }, "*"); } catch { /* pre-DOM / cross-origin — ignore */ }

// >0 while inside an ml.agent run, so chat calls the agent makes internally (e.g.
// the auto-wired `look` vision tool) don't spawn their own orphan sessions — their
// result already shows as the agent's tool step.
let inAgentRun = 0;
export const enterAgentRun = (): void => { inAgentRun++; };
export const exitAgentRun = (): void => { inAgentRun = Math.max(0, inAgentRun - 1); };

// The DELEGATED-sub-call token meter. The auto-wired `look`/`locate`/`verify` tools make their OWN
// ml.chat() vision calls; those emit chat-result events we SUPPRESS below (they're not real sessions).
// But their tokens are real spend the main loop never sees (a separate context, gone after the call) —
// so we tally them HERE, at the exact point we throw the event away, and the agent's meta tool + the UI
// report the otherwise-invisible cost. Per-turn (reset by injected.ts's drive), matching `genTotal`.
let subUsage = { prompt: 0, completion: 0, calls: 0 };
export const resetSubcallUsage = (): void => { subUsage = { prompt: 0, completion: 0, calls: 0 }; };
export const subcallUsage = (): { prompt: number; completion: number; calls: number } => ({ ...subUsage });

/** Emit a debug event to the sidebar via postMessage. No-op when there's no
 *  sidebar; buffered (not live) until the app handshakes; catches non-cloneable. */
export const emitDebug = (event: MlDebugEvent): void => {
    if (inAgentRun && event.kind.startsWith("chat")) {
        // An internal sub-call (delegated look/locate/verify) during an agent run. We DON'T surface it as
        // its own session — but meter its token spend first (the loop never sees these, so this is the only
        // place they can be counted). `chat-result` carries the resolved usage; a `chat`/`chat-error` doesn't.
        const u = (event as { usage?: { promptTokens?: number; completionTokens?: number } | null }).usage;
        if (event.kind === "chat-result" && u) {
            subUsage.prompt += u.promptTokens || 0;
            subUsage.completion += u.completionTokens || 0;
            subUsage.calls += 1;
        }
        return;   // never buffer/emit orphan internal chats
    }
    if (!sidebarPresent) return;   // no sidebar → do nothing (disabled = zero cost)
    debugRing.push(event);
    if (debugRing.length > DEBUG_RING_MAX) debugRing.shift();
    if (!debugEnabled) return;
    try { window.postMessage({ __mlDebug: event }, "*"); } catch (e) { /* non-cloneable — ignore */ }
};

/** Short unique id from timestamp + random bits — labels individual chat requests. */
export const debugId = (): string => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

/** Stable short hex id per session (crypto.getRandomValues, Math.random fallback).
 *  Shown in the sidebar and used to resume a conversation. */
export const shortHash = (): string => {
    try {
        const b = new Uint8Array(4); crypto.getRandomValues(b);
        return [...b].map(x => x.toString(16).padStart(2, "0")).join("");
    } catch { return Math.random().toString(16).slice(2, 10); }
};

// Live registry of this tab's chat sessions (by hash) so ml.resumeChat can continue
// one without a reload. Cross-reload/tab resume goes through storage ({ save:true }
// only). In-memory → cleared on reload.
export const sessionRegistry = new Map<string, MlHistory>();

/** A resumable ml.agent run held in this tab. `resume(task)` appends a follow-up user
 *  turn and re-enters the run's loop under the SAME hash — so the sidebar/HUD append to
 *  the existing session. In-memory (this tab, this page-life) like sessionRegistry; the
 *  page-loop path registers a live one here. (Background-hosted runs resume via a later
 *  RESUME_RUN round-trip — the messages live in the service worker, not here.) */
export interface AgentRunHandle {
    hash: string;
    resume(task: string): Promise<AgentResult>;
}
export const agentRegistry = new Map<string, AgentRunHandle>();

/** Live ml.createAgent handles by session hash, so a sidebar/HUD composer can drive a session it only
 *  knows by hash — say() to steer/append, run() a follow-up turn, cancel(). Registered by the handle when
 *  its run mints the hash; this tab, this page-life. Only handle-backed sessions (createAgent) appear —
 *  a one-shot ml.agent() run has no handle to steer. */
export const handleRegistry = new Map<string, MlAgentHandle>();
