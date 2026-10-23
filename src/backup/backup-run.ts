// backup-run.ts — making a backup and restoring from one: the order of the steps across storage, the live session store and the archive worker.

/**
 * The pieces are elsewhere (`backup-settings.ts` decides what is in a backup and what a restore changes,
 * `backup-file.ts` builds and reads the file, `archive-worker.ts` holds the SQLite); this is the sequence, with every
 * outside thing injected so it runs in Node against a fake worker and in the service worker against the real one.
 *
 * The file travels between the page and the archive worker through the origin-private file system (`backup-opfs.ts`):
 * a finished backup is waiting in the `out` slot for the page to save, and a file to restore is put in the `in` slot by
 * the page first. Messages carry only small things.
 */
import type { ArchiveOp } from "../archive/archive-worker";
import type { ArchiveInput } from "../archive/db";
import type { MlDebugEvent } from "../contract/contract-debug";
import type { StoredSessionRow } from "../session/session-store";
import type { BackupContents, BackupForm } from "./backup-file";
import type { Secret } from "./backup-format";
import { SettingsError, applyRestore, collectSettings, planRestore, type RestorePlan, type StorageSnapshot, type StorageWriter } from "./backup-settings";

/** What the sequence needs from the extension. */
export interface BackupDeps {
    /** one archive worker op (`archiveCall`) */
    call<T>(op: ArchiveOp["op"], args?: ArchiveOp["args"]): Promise<T>;
    /** the live session store's rows, and one session's events (`SessionStore.open`, `.read`) */
    liveRows(): Promise<StoredSessionRow[]>;
    readEvents(hash: string): Promise<MlDebugEvent[]>;
    /** the three storage areas, read now */
    storage(): Promise<StorageSnapshot>;
    writer: StorageWriter;
}

/** What a finished backup tells the person. */
export interface BackupResult {
    /** bytes of the file waiting in the `out` slot */
    size: number;
    sessions: number;
    form: BackupForm;
    /** the API key is set and was left out because the file is not encrypted */
    apiKeyOmitted: boolean;
    /** storage keys no one classified, left out: a build that added a key without deciding */
    unclassified: { area: "sync" | "local"; key: string }[];
}

/**
 * Build a backup into the `out` slot: the settings, every archived session, then every live one.
 * @param o.form `encrypted` needs the install's passphrase set up first (the worker refuses before reading anything)
 * @param o.includeApiKey for a plain file: the person ticked the box
 */
export async function createBackup(deps: BackupDeps, o: { form: BackupForm; includeApiKey?: boolean }): Promise<BackupResult> {
    const settings = collectSettings(await deps.storage(), { encrypted: o.form === "encrypted", includeApiKey: o.includeApiKey });
    await deps.call("backupBegin");
    try {
        for (const row of await deps.liveRows()) {
            const input: ArchiveInput = { summary: row.summary, events: await deps.readEvents(row.hash), history: row.history ?? null, split: row.split, bytes: row.bytes };
            await deps.call("backupPut", { input });
        }
    } catch (e) {
        await deps.call("backupAbort").catch(() => { /* the worker is gone: nothing to abort */ });
        throw e;
    }
    const done = await deps.call<{ size: number; sessions: number; form: BackupForm }>("backupFinish", { settings: JSON.stringify(settings.payload), form: o.form });
    return { ...done, apiKeyOmitted: settings.apiKeyOmitted, unclassified: settings.unclassified };
}

/** What a file in the `in` slot holds, and what restoring it would change here. Nothing is changed by asking. */
export interface RestoreOffer {
    contents: BackupContents;
    /** the settings preview, or null when the file carries none or they could not be read (`settingsError` says which) */
    plan: RestorePlan | null;
    settingsError?: string;
}

/**
 * Open the file in the `in` slot and preview a restore of it.
 * @param secret the passphrase or recovery key, when the file is encrypted by another install
 * @throws with `reason: "needs-key"` when a secret is needed, `"wrong-secret"` when it was wrong
 */
export async function offerRestore(deps: BackupDeps, secret?: Secret): Promise<RestoreOffer> {
    const contents = await deps.call<BackupContents>("restoreInspect", { secret });
    if (contents.settings == null) return { contents, plan: null };
    try { return { contents, plan: planRestore(contents.settings, await deps.storage()) }; }
    catch (e) {
        if (e instanceof SettingsError) return { contents, plan: null, settingsError: e.message };
        throw e;
    }
}

/**
 * Restore: sessions into the ARCHIVE (new ones only), and the settings the preview listed. Either half can be skipped.
 * The `in` file is removed afterwards.
 * @param plan the preview the person saw; exactly its changes are written
 */
export async function restoreBackup(deps: BackupDeps, o: { plan: RestorePlan | null; sessions: boolean; settings: boolean; secret?: Secret }): Promise<{ sessionsAdded: number; written: { sync: string[]; local: string[] } }> {
    try {
        const sessionsAdded = o.sessions ? (await deps.call<{ imported: number }>("restoreSessions", { secret: o.secret })).imported : 0;
        const written = o.settings && o.plan ? await applyRestore(o.plan, deps.writer) : { sync: [], local: [] };
        return { sessionsAdded, written };
    } finally { await deps.call("backupFileRemove", { slot: "in" }).catch(() => { /* already gone */ }); }
}
