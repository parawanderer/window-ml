// The debug event stream + shared runtime state for window.ml. Lives in the page
// main world (bundled into injected.js); owns the sidebar handshake, the replay
// ring, the in-agent-run depth counter (so a tool's internal ml.chat doesn't spawn
// orphan sessions), and the same-tab session registry.

import type { MlDebugEvent, MlHistory } from "./contract";

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
const DEBUG_RING_MAX = 200;
const debugRing: MlDebugEvent[] = [];
window.addEventListener("message", (event) => {
    const d = event.source === window && event.data && event.data.__mlSidebar;
    if (d === "present") { sidebarPresent = true; }
    else if (d === "ready") {
        sidebarPresent = debugEnabled = true;
        for (const ev of debugRing) { try { window.postMessage({ __mlDebug: ev }, "*"); } catch { /* non-cloneable — ignore */ } }
    } else if (d === "gone") {
        // The sidebar was switched OFF (shell unmounted). Stop emitting AND drop the
        // ring — otherwise we'd keep building events and retaining up to 200 prompts
        // and replies in memory for a UI that no longer exists, until a page reload.
        // Turning the sidebar off must return us to the same zero-cost state as
        // never having turned it on.
        sidebarPresent = debugEnabled = false;
        debugRing.length = 0;
    }
});

// >0 while inside an ml.agent run, so chat calls the agent makes internally (e.g.
// the auto-wired `look` vision tool) don't spawn their own orphan sessions — their
// result already shows as the agent's tool step.
let inAgentRun = 0;
export const enterAgentRun = (): void => { inAgentRun++; };
export const exitAgentRun = (): void => { inAgentRun--; };

/** Emit a debug event to the sidebar via postMessage. No-op when there's no
 *  sidebar; buffered (not live) until the app handshakes; catches non-cloneable. */
export const emitDebug = (event: MlDebugEvent): void => {
    if (!sidebarPresent) return;   // no sidebar → do nothing (disabled = zero cost)
    if (inAgentRun && event.kind.startsWith("chat")) return;   // never buffer/emit orphan internal chats
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
