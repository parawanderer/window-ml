// backup-opfs.ts — the two files that carry a backup between the page and the archive worker: the one being written, and the one being restored.

/**
 * A backup can be hundreds of megabytes, and extension messaging is JSON: it cannot carry them. The page and the archive
 * worker share an origin, so they share its origin-private file system: the worker writes the finished file to `out`
 * and the page streams it to wherever the person chose to save it; the page copies a picked file into `in` and the worker
 * reads it. Only these two names exist, so a message cannot make the worker read or write any other file.
 *
 * Works in a page and in a dedicated worker (`createWritable` and `getFile` are both available in either); chrome-free.
 */

/** Which of the two files: `out` is a backup just built, `in` is one to restore. */
export type BackupSlot = "out" | "in";

/** The file name of each slot. */
const NAMES: Readonly<Record<BackupSlot, string>> = Object.freeze({ out: "wml-backup-out.tmp", in: "wml-backup-in.tmp" });

const root = (): Promise<FileSystemDirectoryHandle> => navigator.storage.getDirectory();

/** Replace a slot's file with these bytes; the old file stays until the new one is complete. */
export async function writeBackupSlot(slot: BackupSlot, bytes: Uint8Array<ArrayBuffer>): Promise<void> {
    const handle = await (await root()).getFileHandle(NAMES[slot], { create: true });
    const w = await handle.createWritable();
    try { await w.write(bytes); await w.close(); }
    catch (e) { await w.abort().catch(() => {}); throw e; }
}

/** A slot's file as a `File` (a `Blob` the page can stream out), or null when there is none. */
export async function backupSlotFile(slot: BackupSlot): Promise<File | null> {
    try { return await (await (await root()).getFileHandle(NAMES[slot])).getFile(); }
    catch (e) { if ((e as DOMException)?.name === "NotFoundError") return null; throw e; }
}

/** A slot's bytes, or null when there is no file. */
export async function readBackupSlot(slot: BackupSlot): Promise<Uint8Array<ArrayBuffer> | null> {
    const f = await backupSlotFile(slot);
    return f ? new Uint8Array(await f.arrayBuffer()) : null;
}

/** Delete a slot's file; nothing when there is none. A backup holds whole transcripts, so it is not left lying around. */
export async function removeBackupSlot(slot: BackupSlot): Promise<void> {
    try { await (await root()).removeEntry(NAMES[slot]); }
    catch (e) { if ((e as DOMException)?.name !== "NotFoundError") throw e; }
}
