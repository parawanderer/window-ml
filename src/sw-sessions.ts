// The background's session index, as the chat page's local host sees it: one `SessionIndex` for this worker's life,
// served over the `ml-sessions` port to extension pages (session-server.ts). background.ts feeds it from the same
// places that feed the DevTools panel, so the index holds what a panel would show for every tab at once
// (docs/dev/chat-page.md §The local index).
import type { MlDebugEvent } from "./contract";
import { SESSION_CONTRACT_VERSION, type Command, type CommandResult, type CommandType, type RuntimeInfo } from "./session-host";
import { SessionIndex, type IngestSource } from "./session-index";
import { SESSIONS_PORT, SessionServer } from "./session-server";

/** This browser's runtime id until the extension has a key to derive one from (docs/spec/SESSION_CONTRACT.md). */
export const LOCAL_RUNTIME = "local";

/** A new value per worker life, so a stream position from an evicted worker never resumes. */
const spawn = (() => {
    try { const b = new Uint8Array(4); crypto.getRandomValues(b); return [...b].map((x) => x.toString(16).padStart(2, "0")).join(""); }
    catch { return Math.random().toString(16).slice(2, 10); }
})();

/** The local runtime as the chat page sees it. Capabilities are added as each command lands. */
function localRuntime(): RuntimeInfo {
    return {
        id: LOCAL_RUNTIME, name: "This browser", kind: "browser", online: true, contractVersion: SESSION_CONTRACT_VERSION,
        capabilities: {},
        // This browser's own pages hold every scope.
        grants: [{ scope: "view" }, { scope: "drive" }, { scope: "approve" }, { scope: "screen" }],
    };
}

async function runCommand(command: Command): Promise<CommandResult<CommandType>> {
    return { ok: false, error: { code: "unsupported", message: `${command.type} is not available on this browser yet` } };
}

/** The index and its server, for this worker's life. */
export const sessionServer = new SessionServer(new SessionIndex({ runtime: LOCAL_RUNTIME, spawn }), { runtime: localRuntime, command: runCommand });

/** Fold one debug event into the index. Never throws: a malformed event must not break the relay it rides beside. */
export function ingestSessionEvent(event: unknown, source: IngestSource): void {
    try { sessionServer.ingest(event as MlDebugEvent, source); } catch { /* refused */ }
}

/** The sender tab's URL and title, as the browser reports them. */
export function senderPage(tab: chrome.tabs.Tab | undefined): IngestSource["page"] {
    return tab?.url ? { url: tab.url, ...(tab.title ? { title: tab.title } : {}) } : undefined;
}

/** Serve an `ml-sessions` port, if an extension page opened it. A content script's sender URL is its page's, so this
 *  refuses every page: the index spans every tab, and a page's main world is hostile. */
export function serveSessionsPort(port: chrome.runtime.Port): void {
    if (port.name !== SESSIONS_PORT) return;
    if (!(port.sender?.url || "").startsWith(chrome.runtime.getURL(""))) {
        try { port.disconnect(); } catch { /* already gone */ }
        return;
    }
    sessionServer.attach(port);
}
