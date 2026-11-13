// mount-judge.ts — the built-in default over a mounted folder's facts: whether a cell's read, write, delete or rename
// in a mount runs free, asks the person, or is refused, and the whole-file read and write that carry the judged basis.

// docs/spec/FILE_ATTACHMENTS.md, "What window-ml-host must do for mounts" (H1 to H8, the table "What runs free, what
// asks, what is refused"). The host resolves the facts (`stat`) and holds the hard refusals; this module is the worker's
// half: rows compose and the most restrictive decides, refused over asks over free. The basis a verdict rests on comes
// from the host's `stat`, is kept here, and is sent back with the operation, never taken from the cell.

import { bytesOf, HostError, READ_CHUNK, type HostBasis, type HostClient, type HostMountFacts } from "./host-protocol";
import { base64Of } from "./sh-put";

/** What a cell asks of a mounted path. */
export type MountOp = "read" | "write" | "delete" | "rename";

/** A verdict, ordered: a later one is more restrictive. */
export type MountVerdict = "free" | "ask" | "refused";

/** One row of the default that applied, with the fact behind it, for the card and the run log. */
export interface MountRow { verdict: MountVerdict; why: string; fact: string }

/** The verdict over a request's facts, every row that applied, and the basis the operation must carry. */
export interface MountJudgment { op: MountOp; verdict: MountVerdict; rows: MountRow[]; basis: HostBasis | null }

const RANK: Record<MountVerdict, number> = { free: 0, ask: 1, refused: 2 };

/**
 * Judge one request by the built-in default over the host's facts.
 *
 * In the uploads folder outside `attached/` a write or delete is free whatever git says (the folder is ignored by
 * design, so `gitUndoable` would always be false there): the uploads row stands in for the git rows, and the other rows
 * (secret, read-only, protected, hard link) still compose with it.
 * @param op what the cell asks
 * @param facts the host's `stat` of the path (for a rename, the source)
 * @param to for a rename, the host's `stat` of the target
 */
export function judgeMount(op: MountOp, facts: HostMountFacts, to?: HostMountFacts): MountJudgment {
    const rows: MountRow[] = [];
    const row = (verdict: MountVerdict, why: string, fact: string) => rows.push({ verdict, why, fact });
    if (!facts.inMount) row("refused", "the path is outside the mount", "inMount");
    if (op === "read") {
        if (!facts.exists) row("refused", "there is no such file", "exists");
        else if (facts.kind !== "file") row("refused", `it is a ${facts.kind}, not a file`, "kind");
        else row("free", "a read in a mount", "inMount");
        if (facts.secret) row("ask", "it looks like a secret", "secret");
    } else {
        writeRows(op, facts, row);
        if (op === "rename") {
            if (!to) row("refused", "the target was not looked at", "to");
            else {
                if (!to.inMount) row("refused", "the target is outside the mount", "inMount");
                // A rename never crosses mounts (it would be a copy and a delete), and the target's mount bounds it too.
                if (to.mount !== facts.mount) row("refused", "the target is in another mount", "mount");
                if (to.mode === "ro") row("refused", "the target's folder is mounted read-only", "mode");
                if (to.exists) row("refused", "the target exists: a rename never replaces a file", "exists");
                if (to.inAttached) row("refused", "attached/ holds the uploads as they were given", "inAttached");
                if (to.protected) row("refused", "the target is a protected name", "protected");
                if (to.secret) row("ask", "the target name looks like a secret", "secret");
                if (!to.exists && !to.inAttached) row("free", "a new name", "exists");
            }
        }
    }
    const verdict = rows.reduce<MountVerdict>((v, r) => (RANK[r.verdict] > RANK[v] ? r.verdict : v), "free");
    return { op, verdict, rows, basis: facts.basis };
}

/** The rows of a write, a delete, or a rename's source. */
function writeRows(op: Exclude<MountOp, "read">, f: HostMountFacts, row: (v: MountVerdict, why: string, fact: string) => void): void {
    if (f.mode === "ro") row("refused", "the folder is mounted read-only", "mode");
    if (f.protected) row("refused", "a protected name: no write may touch it", "protected");
    if (f.exists && f.kind !== "file") row("refused", `it is a ${f.kind}, not a file`, "kind");
    if (op !== "write" && !f.exists) row("refused", "there is no such file", "exists");
    if (f.secret) row("ask", "the name looks like a secret", "secret");
    if (f.inAttached) {
        // A store, or a rename out, is the host's refusal too; a delete is the person's to allow.
        if (op === "delete") row("ask", "a delete in attached/, the uploads as they were given", "inAttached");
        else row("refused", "attached/ holds the uploads as they were given", "inAttached");
        return;
    }
    if (f.exists && f.hardLinked && op === "write") row("refused", "the file has another name a write would change too", "hardLinked");
    if (!f.exists) { row("free", "a new file", "exists"); return; }
    if (f.inUploads) { row("free", "in the uploads folder", "inUploads"); return; }
    if (f.gitUndoable === true) row("free", "git can undo it", "gitUndoable");
    else if (f.gitUndoable === false) row("ask", "git cannot undo it (untracked, ignored, or with uncommitted changes)", "gitUndoable");
    else row("ask", "git cannot be asked whether it can undo it", "gitUndoable");
}

/** A mounted file as the worker addresses it: the session's stamp, the host's mount id, the path inside it. */
export interface MountPath { session: string; mount: string; path: string }

/**
 * Read a whole file whose basis is `basis`, chunk by chunk, each chunk carrying the basis (a change between chunks is
 * `ChangedSinceJudged`). A file over `cap` is `EFBIG` before a byte is read.
 * @param host the connected host
 * @param at where the file is
 * @param basis the basis the read was judged on, from `stat`
 * @param cap the most bytes this read may return
 */
export async function fetchWhole(host: HostClient, at: MountPath, basis: HostBasis, cap: number): Promise<Uint8Array> {
    if (basis.size > cap) throw new HostError("EFBIG", `${at.path} is ${basis.size} bytes, over the cap of ${cap}`, { size: basis.size, cap });
    const out = new Uint8Array(basis.size);
    let offset = 0;
    while (offset < basis.size) {
        const r = await host.fetch({ ...at, basis, offset, length: READ_CHUNK, cap });
        const bytes = bytesOf(r.data);
        if (r.size !== basis.size || offset + bytes.length > basis.size || (!bytes.length && !r.eof)) {
            throw new HostError("ChangedSinceJudged", `${at.path} changed while it was read`);
        }
        out.set(bytes, offset);
        offset += bytes.length;
        if (r.eof) break;
    }
    if (offset !== basis.size) throw new HostError("ChangedSinceJudged", `${at.path} changed while it was read`);
    return out;
}

/**
 * Write a whole file: `store` with the judged basis (absent for a new file), the bytes in chunks, then the commit,
 * which compares the basis again. A failure between chunks discards the store, so no temp file is left.
 * @param host the connected host
 * @param at where the file goes
 * @param bytes what it will hold
 * @param basis the existing file's basis as judged, or null for a new file
 * @param cap the most bytes this write may send
 */
export async function storeWhole(host: HostClient, at: MountPath, bytes: Uint8Array, basis: HostBasis | null, cap: number) {
    const s = await host.store({ ...at, size: bytes.length, cap, ...(basis ? { basis } : {}) });
    try {
        for (let off = 0; off < bytes.length; off += READ_CHUNK) {
            await host.write(s.id, off, { $bytes: base64Of(bytes.subarray(off, off + READ_CHUNK)) });
        }
    } catch (e) {
        await host.discard(s.id).catch(() => { /* gone already: the TTL or the port */ });
        throw e;
    }
    return host.commitStore(s.id);
}
