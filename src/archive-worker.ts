// archive-worker.ts — the session archive's SQLite, in a DEDICATED WORKER the offscreen document starts
// (offscreen.ts). The database lives in the origin-private file system through the `opfs-sahpool` VFS: its fast file
// handles exist only in a dedicated worker and only on OPFS (a folder a person picked has none), and unlike the plain
// `opfs` VFS it needs no cross-origin isolation, which an extension page cannot easily have.
//
// One connection, held for the worker's life: the pool VFS allows one per origin, and this worker is the only thing
// that opens it. Requests arrive as `{ id, op, args }` and are answered in order, so a write and the read after it can
// never race. The SQL is archive-db.ts, tested in Node; this file is the plumbing around it.
//
// chrome-free, like python-worker.ts: the wasm is found next to this script's own URL.
import sqlite3InitModule, { type Database } from "@sqlite.org/sqlite-wasm";
import { archiveStats, listArchived, migrate, prepareSession, readArchived, removeArchived, writeSession, type ArchiveInput } from "./archive-db";

/** The operations this worker answers, and what each takes. */
export type ArchiveOp =
    | { op: "put"; args: { input: ArchiveInput; archivedTs: number } }
    | { op: "list"; args: { before?: number; limit?: number; query?: string } }
    | { op: "read"; args: { hash: string } }
    | { op: "remove"; args: { hash: string } }
    | { op: "stats"; args?: undefined }
    | { op: "export"; args?: undefined };

let opened: Promise<{ db: Database; exportBytes: () => Uint8Array }> | null = null;

/** Open (once) the archive database, creating or upgrading its schema. */
function open(): Promise<{ db: Database; exportBytes: () => Uint8Array }> {
    opened ??= (async () => {
        // The runtime reads `locateFile` from its argument (its types omit it): this bundle is a classic script with
        // no `import.meta.url` to find the wasm from.
        const init = sqlite3InitModule as unknown as (o: { locateFile: (file: string) => string }) => ReturnType<typeof sqlite3InitModule>;
        const sqlite3 = await init({ locateFile: (file) => new URL(file, self.location.href).href });
        const pool = await sqlite3.installOpfsSAHPoolVfs({ name: "wml-archive" });
        const db = new pool.OpfsSAHPoolDb("/archive.sqlite");
        migrate(db);
        return { db, exportBytes: () => sqlite3.capi.sqlite3_js_db_export(db.pointer!) };
    })();
    // A failed open (no OPFS, a newer schema) is answered to every caller, then retried by the next request.
    opened.catch(() => { opened = null; });
    return opened;
}

/** One request, answered. */
async function run(req: ArchiveOp): Promise<unknown> {
    const { db, exportBytes } = await open();
    switch (req.op) {
        case "put": writeSession(db, await prepareSession(req.args.input), req.args.archivedTs); return true;
        case "list": return listArchived(db, req.args);
        case "read": return readArchived(db, req.args.hash);
        case "remove": return removeArchived(db, req.args.hash);
        case "stats": return archiveStats(db);
        case "export": return exportBytes();
    }
}

// In order: each request waits for the one before it.
let chain: Promise<unknown> = Promise.resolve();
self.onmessage = (e: MessageEvent<{ id: number } & ArchiveOp>) => {
    const { id, ...req } = e.data;
    chain = chain.then(() => run(req as ArchiveOp)).then(
        (result) => self.postMessage({ id, ok: true, result }),
        (err) => self.postMessage({ id, ok: false, error: String((err as Error)?.message || err) }),
    );
};
