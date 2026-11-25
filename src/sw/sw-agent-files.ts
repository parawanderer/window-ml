// sw-agent-files.ts — the service worker's side of the files a session's runs keep under `/files/agent/`: deleting them
// with their session, and declaring them to the state inspector. The offscreen document writes them (agent-files.ts).

import { AgentFiles } from "../session/agent-files";
import { recordHousekeeping } from "./sw-housekeeping";
import { defineState } from "../state-registry";

let files: AgentFiles | null = null;   // state: plumbing — a handle to the ml-agent-files database, declared as session.files
const agentFiles = (): AgentFiles => files ??= new AgentFiles();

defineState({
    id: "session.files", scope: "session", realm: "worker", audience: "human", lostOn: [],
    describe: "The files this session's runs wrote under /files/agent/ (path, kind, size), and the writes discarded before they landed (path, time). Deleted with the session; kept when it is archived.",
    read: async ({ runId }) => {
        if (!runId) return undefined;
        const [nodes, lost] = await Promise.all([agentFiles().all(runId), agentFiles().lost(runId)]);
        if (!nodes.length && !lost.length) return undefined;
        return { files: nodes.map((n) => ({ path: `agent/${n.path}`, kind: n.kind, size: n.size })), lost: lost.map((l) => ({ path: l.path, at: l.at })) };
    },
});

/**
 * Delete every file a session's runs wrote, and its discard notes: the session was deleted (by the person, or by the
 * store's eviction with nothing archived). Never at a run's end, and not when the session is archived. A failure is a
 * housekeeping record, never a thrown error: the session's delete goes on without it.
 * @param hash the session
 */
export async function forgetAgentFiles(hash: string): Promise<void> {
    try {
        const n = await agentFiles().forgetSession(hash);
        if (n) recordHousekeeping({ subsystem: "files", kind: "delete", key: hash, detail: { nodes: n } });
    } catch (e) {
        recordHousekeeping({ subsystem: "files", kind: "delete-failed", key: hash, detail: { error: String((e as Error)?.message ?? e) } });
    }
}
