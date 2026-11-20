// files-source.ts — the offscreen document's FilesSource: a session's attachments asked of the service worker, their bytes read from the document's own value store.

import type { AttachedFile, FilesSource } from "../session/ranged-reader";
import type { ValueRow } from "../pointers/value-store";

/** What the source needs of the value store: one row's bytes and the rows' metadata. */
export interface FilesSourceStore {
    get(key: string): Promise<{ row: ValueRow; blob: Blob }>;
    rows(): Promise<ValueRow[]>;
}

/** What the source needs of the world: the value store, and a way to ask the service worker (`chrome.runtime.sendMessage`). */
export interface FilesSourceDeps {
    store: () => FilesSourceStore;
    send: (message: { type: "FILES_ATTACHED"; session: string }) => Promise<unknown>;
}

/**
 * The `/files` reader's source. `attached` asks the service worker (FILES_ATTACHED) and stamps each file with its value
 * row's `createdAt`; a failed ask lists nothing. `blob` hands out a held row of THIS session only: a key another session
 * holds, an unheld row or a missing one throws.
 * @param deps the store and the ask
 * @returns the source
 */
export function createFilesSource(deps: FilesSourceDeps): FilesSource {
    // A row's `createdAt` never changes, so the store's rows are scanned only when a key not seen before is listed:
    // the reader asks for the list at every path it resolves.
    const created = new Map<string, number>();   // state: cache — value-store key → its row's createdAt
    return {
        async attached(session): Promise<readonly AttachedFile[]> {
            let answer: unknown;
            try { answer = await deps.send({ type: "FILES_ATTACHED", session }); } catch { return []; }
            const list = (answer as { files?: unknown } | undefined)?.files;
            if (!Array.isArray(list)) return [];
            if (list.some((f) => typeof f?.key === "string" && !created.has(f.key))) {
                try { for (const r of await deps.store().rows()) created.set(r.key, r.createdAt); } catch { /* no times */ }
            }
            return list.flatMap((f): AttachedFile[] => {
                if (!f || typeof f.handle !== "string" || typeof f.name !== "string" || typeof f.key !== "string") return [];
                return [{ handle: f.handle, name: f.name, key: f.key, bytes: Number(f.bytes) || 0, sha256: String(f.sha256 ?? ""), attachedMs: created.get(f.key) ?? 0 }];
            });
        },
        async blob(key, session): Promise<Blob> {
            const { row, blob } = await deps.store().get(key);
            if (row.held !== true || !row.sessions.includes(session)) throw new Error("not a file of this session");
            return blob;
        },
    };
}
