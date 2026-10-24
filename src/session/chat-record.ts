// chat-record.ts — putting a chat's `ml_session_<hash>` record back from the history an archive or a backup carries.

/**
 * `ml.resumeChat` and a worker-hosted chat after an eviction read only the `ml_session_<hash>` record in
 * `chrome.storage.local`. The archive keeps the same `StoredSession` as the session's `history` (`{ kind: "chat" }`), but
 * nothing wrote the record back when a session came out of the archive, so a restored chat read fine and could not be
 * resumed. This writes it, and never over a record that exists: a live record is the newer one.
 */
import type { StoredSession } from "../contract";
import type { SessionHistory } from "./session-store";

/** The storage key of a chat's resumable record. */
export const chatRecordKey = (hash: string): string => `ml_session_${hash}`;

/** The two storage calls this needs, so it runs in Node against a map. */
export interface RecordStore {
    get(key: string): Promise<unknown>;
    set(key: string, value: StoredSession): Promise<void>;
}

/**
 * Write the chat's record from its history when there is none.
 * @param history what the archive held for the session
 * @returns whether a record was written
 */
export async function restoreChatRecord(hash: string, history: SessionHistory | null, store: RecordStore): Promise<boolean> {
    if (history?.kind !== "chat" || !Array.isArray(history.session?.messages)) return false;
    const key = chatRecordKey(hash);
    if ((await store.get(key)) != null) return false;
    await store.set(key, { ...history.session, hash });
    return true;
}
