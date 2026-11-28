// sw-files-list.ts — the worker's side of the `files.list` command: one directory of a session's `/files/`, asked of the offscreen document's reader (files-list-serve.ts) under the session the command handler resolved.

// The session is the handler's, checked against this runtime's index (session-commands.ts), never a field a client or
// the offscreen answer chose. An answer that is not the server's shape is treated as no answer, so nothing else the
// offscreen document could say reaches a client.

import { ensureOffscreen } from "./sw-offscreen";
import type { FileListEntry, FilesListing } from "../session/session-host";
import { noteFilesListed } from "./sw-files-hide";

/** How the worker reaches the offscreen document; replaced in tests. */
export interface FilesListDeps { send: (msg: unknown) => Promise<unknown> }

const defaultDeps: FilesListDeps = { send: async (msg) => { await ensureOffscreen(); return chrome.runtime.sendMessage(msg); } };

/** The answer as the command handler takes it: a page, or the command's failure kind and its sentence. */
export type FilesListAnswer = { ok: FilesListing } | { fail: "invalid" | "not-found"; message: string };

/** Is `v` one page as the server answers it: entries with exactly the listed fields, an optional string cursor and count. */
function isPage(v: unknown): v is FilesListing {
    const p = v as FilesListing;
    if (!p || typeof p !== "object" || !Array.isArray(p.entries)) return false;
    if (p.next !== undefined && typeof p.next !== "string") return false;
    if (p.count !== undefined && (typeof p.count?.attached !== "number" || (p.count.agent !== undefined && typeof p.count.agent !== "number"))) return false;
    return p.entries.every((e) => !!e && typeof e.name === "string" && (e.kind === "file" || e.kind === "dir") && typeof e.size === "number"
        && typeof e.mtimeMs === "number" && typeof e.hidden === "boolean" && typeof e.readonly === "boolean");
}

/** An entry's detail fields, each only in its shape: the stored name, and a hidden entry's deciding rule with its way out. */
function detailOf(e: FileListEntry): Pick<FileListEntry, "realName" | "hiddenBy" | "unhide"> {
    return {
        ...(typeof e.realName === "string" && e.realName !== "" && e.realName !== e.name ? { realName: e.realName } : {}),
        ...(e.hidden && typeof e.hiddenBy === "string" && (e.unhide === "remove" || e.unhide === "show") ? { hiddenBy: e.hiddenBy, unhide: e.unhide } : {}),
    };
}

/**
 * One page of one directory of a session's files.
 * @param hash the session, as the command handler resolved it
 * @param path the directory, session-relative
 * @param opts the cursor and the page size, checked by the handler; `detail` (the stored names and the deciding rules)
 *  only for a command from this browser's own pages, which the handler decides
 * @param deps how to reach the offscreen document
 * @returns the page, the reader's refusal, or a throw when the offscreen document gave no usable answer
 */
export async function listSessionFiles(hash: string, path: string, opts: { cursor?: string; limit?: number; detail?: boolean }, deps: FilesListDeps = defaultDeps): Promise<FilesListAnswer> {
    const { detail, ...page } = opts;
    // Listed now, so a change to the session's hiding rules from here on sends its watchers a hint (sw-files-hide.ts).
    noteFilesListed(hash);
    const r = await deps.send({ type: "FILES_LIST", session: hash, path, ...page, ...(detail === true ? { detail: true } : {}) }) as { ok?: unknown; fail?: unknown; message?: unknown } | undefined;
    if (r && isPage(r.ok)) {
        // Only the listed fields go on: a page is rebuilt, never passed through.
        const { entries, next, count } = r.ok;
        return { ok: {
            entries: entries.map((e) => ({ name: e.name, kind: e.kind, size: e.size, mtimeMs: e.mtimeMs, hidden: e.hidden, readonly: e.readonly, ...(detail === true ? detailOf(e) : {}) })),
            ...(next !== undefined ? { next } : {}),
            ...(detail === true ? { detail: true as const } : {}),
            ...(count ? { count: { attached: count.attached, ...(count.agent !== undefined ? { agent: count.agent } : {}) } } : {}),
        } };
    }
    if (r && (r.fail === "invalid" || r.fail === "not-found") && typeof r.message === "string") return { fail: r.fail, message: r.message };
    throw new Error("the offscreen document gave no listing");
}
