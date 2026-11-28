// files-list-serve.ts — the offscreen document's side of the `files.list` command: one page of one directory of a session's `/files/`, read through the one ranged reader (SESSION_CONTRACT.md, "Commands"; FILE_ATTACHMENTS.md, "The file browser shows the mounts, and its menu sends commands").

// The worker names the session from its own record (session-commands.ts checks the command's sender and session first);
// this side opens a channel, sets that session, lists one directory and disposes of the channel, so nothing is held
// between requests. Names are the reader's own, which are the SHOWN names; no bytes of any file are read.

import { DIR_PAGE_MAX } from "./ranged-reader";
import type { DirPage, FilesChannel } from "../python/files-reader";

/** The most bytes of JSON one page's entries may take: what fits a sealed hub message with room for the envelope. */
export const FILES_LIST_PAGE_BYTES = 256 * 1024;

/** One row of a listing, as the command answers it: the reader's stat less what a browser does not show. */
export interface FilesListEntry {
    /** The SHOWN name; two entries of one directory may share it. */
    name: string;
    kind: "file" | "dir";
    size: number;
    mtimeMs: number;
    hidden: boolean;
    readonly: boolean;
    /** with `detail` only: the stored name where it differs, and a hidden entry's deciding rule and way out (DirEntryDetail) */
    realName?: string;
    hiddenBy?: string;
    unhide?: "remove" | "show";
}

/** One page: its entries, the cursor of the next, and at the root how many files the session holds. */
export interface FilesListPage {
    entries: FilesListEntry[];
    next?: string;
    /** set when the page was listed with `detail`: its entries carry the stored names and the deciding rules */
    detail?: true;
    count?: { attached: number; agent?: number };
}

/** An answer: the page, or the command's own failure kind with the sentence a person reads. */
export type FilesListAnswer = { ok: FilesListPage } | { fail: "invalid" | "not-found"; message: string };

/** What the server needs: a fresh channel on the `files` volume, and the two counts for the root. */
export interface FilesListDeps {
    open: () => FilesChannel;
    /** How many files the person attached to the session. */
    attachedCount: (session: string) => Promise<number>;
    /** How many files the session's runs made (AgentFiles.stats); a rejection leaves `agent` out of the count. */
    agentCount?: (session: string) => Promise<number>;
}

/** Is `p` a path inside the mount: "" or segments with no empty, `.` or `..` one, no leading or trailing slash, no NUL. */
function inMount(p: unknown): p is string {
    if (typeof p !== "string" || p.length > 4096 || p.includes("\0")) return false;
    return p === "" || p.split("/").every((seg) => seg !== "" && seg !== "." && seg !== "..");
}

/** The reader's refusal as the command's: the codes `opendir` can answer, each to a sentence. */
function refusal(code: unknown): FilesListAnswer {
    switch (code) {
        case "ENOENT": return { fail: "not-found", message: "no such directory" };
        case "ENOTDIR": return { fail: "invalid", message: "not a directory" };
        case "EACCES": return { fail: "invalid", message: "this directory cannot be listed: its name is shared by two entries, or it is hidden" };
        case "EINVAL": return { fail: "invalid", message: "the cursor or the page size is not one this runtime gave" };
        default: return { fail: "invalid", message: "the directory could not be listed" };
    }
}

/** The detail fields the reader gave, each only where it is the reader's shape: nothing else of an entry passes. */
function detailOf(e: DirPage["entries"][number]): Pick<FilesListEntry, "realName" | "hiddenBy" | "unhide"> {
    return {
        ...(typeof e.realName === "string" ? { realName: e.realName } : {}),
        ...(e.hidden && typeof e.hiddenBy === "string" && (e.unhide === "remove" || e.unhide === "show") ? { hiddenBy: e.hiddenBy, unhide: e.unhide } : {}),
    };
}

/**
 * The server for `files.list`.
 * @param deps the channel opener and the counts
 * @returns `list`, which answers one request
 */
export function filesListServer(deps: FilesListDeps) {
    const server = {
        /**
         * One page of one directory.
         * @param session the session's hash, as the worker resolved it
         * @param path the directory, session-relative ("" for the root, `attached/<handle>`, `agent/…`)
         * @param opts `cursor` from a previous page, `limit` at most `DIR_PAGE_MAX`; `detail` for the person's own browser on
         *  this device, which the worker sets only for a command from this browser's pages
         */
        async list(session: unknown, path: unknown, opts: { cursor?: unknown; limit?: unknown; detail?: boolean } = {}): Promise<FilesListAnswer> {
            if (typeof session !== "string" || !session) return { fail: "invalid", message: "no session" };
            if (!inMount(path)) return { fail: "invalid", message: "path is a directory under /files/, written without a leading slash (\"\" for the root)" };
            if (opts.cursor !== undefined && typeof opts.cursor !== "string") return refusal("EINVAL");
            const limit = opts.limit === undefined ? DIR_PAGE_MAX : opts.limit;
            if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > DIR_PAGE_MAX) return { fail: "invalid", message: `limit is a whole number from 1 to ${DIR_PAGE_MAX}` };
            const ch = deps.open();
            try {
                ch.setSession(session);
                const cursor = opts.cursor as string | undefined;
                let page;
                const detail = opts.detail === true;
                try { page = await ch.opendir(path, { limit, ...(cursor !== undefined ? { cursor } : {}), ...(detail ? { detail } : {}) }); }
                catch (e) { return refusal((e as { code?: unknown })?.code); }
                const entries: FilesListEntry[] = page.entries.map((e) => ({ name: e.name, kind: e.kind, size: e.size, mtimeMs: e.mtimeMs, hidden: e.hidden, readonly: e.readonly, ...(detail ? detailOf(e) : {}) }));
                // A page past the byte bound is listed again shorter: the reader's cursor is opaque, so the server
                // never cuts a page itself. A name is at most 255 characters, so 500 rows fit and this is a guard.
                if (JSON.stringify(entries).length > FILES_LIST_PAGE_BYTES && limit > 1) {
                    return server.list(session, path, { cursor, limit: Math.max(1, Math.floor(limit / 2)), detail });
                }
                const out: FilesListPage = { entries, ...(page.next !== undefined ? { next: page.next } : {}), ...(detail ? { detail: true as const } : {}) };
                if (path === "" && cursor === undefined) {
                    let attached: number;
                    try { attached = await deps.attachedCount(session); } catch { return refusal("EIO"); }
                    let agent: number | undefined;
                    try { agent = deps.agentCount ? await deps.agentCount(session) : undefined; } catch { agent = undefined; }
                    out.count = { attached, ...(agent !== undefined ? { agent } : {}) };
                }
                return { ok: out };
            } finally {
                try { ch.dispose(); } catch { /* the reader is gone too */ }
            }
        },
    };
    return server;
}

/**
 * A channel that reports each commit that landed: `commitTx` resolves, then `onCommit` hears the session the channel
 * serves. Once per commit, never per file, which is what bounds `files-changed`. A failed commit reports nothing.
 * @param ch the channel, as the reader opened it
 * @param onCommit told the session's hash after each commit
 * @returns the same channel, its `setSession` and `commitTx` observed
 */
export function notifyingCommits(ch: FilesChannel, onCommit: (session: string) => void): FilesChannel {
    let session: string | null = null;
    const setSession = ch.setSession.bind(ch), commitTx = ch.commitTx.bind(ch);
    ch.setSession = (hash, opts) => { session = hash; setSession(hash, opts); };
    ch.commitTx = async (txn) => {
        const r = await commitTx(txn);
        if (session) { try { onCommit(session); } catch { /* a listener's failure is not the commit's */ } }
        return r;
    };
    return ch;
}
