// sw-backup.ts — the service worker's side of backup and restore: the real `BackupDeps` and the one `BACKUP` action dispatch.

/**
 * `backup-run.ts` is the sequence with every outside thing injected; this binds it to the worker's session store, the
 * archive worker (`archiveCall`) and `chrome.storage`, and checks what an extension page sends. Passphrase set-up and
 * change are not here: the page reaches the keyring in IndexedDB directly.
 */
import { BackupError, type Secret } from "../backup/backup-format";
import type { BackupForm } from "../backup/backup-file";
import { chromeStorageWriter, type StorageSnapshot } from "../backup/backup-settings";
import { createBackup, offerRestore, restoreBackup, type BackupDeps } from "../backup/backup-run";
import { archiveCall, scheduleFolderSync } from "./sw-archive";
import { sessionStore } from "./sw-sessions";
import { siteSchemaReady } from "./sw-site-access";

const FORMS: readonly BackupForm[] = ["plain", "gzip", "encrypted"];

/** The real dependencies: the archive worker, the saved-session store and the three storage areas. */
function realDeps(): BackupDeps {
    const area = async (a: "sync" | "local" | "session") => (await chrome.storage[a]?.get(null)) ?? {};
    return {
        call: archiveCall,
        liveRows: async () => (sessionStore ? sessionStore.open() : []),
        readEvents: async (hash) => (sessionStore ? sessionStore.read(hash) : []),
        storage: async (): Promise<StorageSnapshot> => ({ sync: await area("sync"), local: await area("local"), session: await area("session") }),
        writer: chromeStorageWriter(chrome.storage),
    };
}

function secretOf(v: unknown): Secret | undefined {
    if (v == null) return undefined;
    const s = v as Record<string, unknown>;
    if (typeof s.passphrase === "string") return { passphrase: s.passphrase };
    if (typeof s.recoveryKey === "string") return { recoveryKey: s.recoveryKey };
    throw new Error("the secret must be a passphrase or a recovery key");
}

/**
 * The BACKUP message from an extension page: `create`, `offer` or `restore` (the payload shapes are in `backup-run.ts`).
 * A BackupError keeps its `reason` on the thrown error, for `backupFailure` to hand the page.
 * @throws on an unknown action or a malformed payload
 */
export async function backupAction(payload: unknown, deps: BackupDeps = realDeps()): Promise<unknown> {
    const p = (payload ?? {}) as Record<string, unknown>;
    switch (p.action) {
        case "create": {
            if (!FORMS.includes(p.form as BackupForm)) throw new Error("the backup form must be plain, gzip or encrypted");
            return createBackup(deps, { form: p.form as BackupForm, includeApiKey: p.includeApiKey === true });
        }
        case "offer": return offerRestore(deps, secretOf(p.secret));
        case "restore": {
            const secret = secretOf(p.secret);
            const sessions = p.sessions === true, settings = p.settings === true;
            // The worker reads the file and the storage again and uses ITS offer: its own digest, its own session hashes and
            // its own plan. From the page it takes only which settings keys the person accepted, and, as a check, the digest
            // the person previewed (a different file in the slot is refused, never imported).
            const offer = await offerRestore(deps, secret);
            if (typeof p.digest === "string" && p.digest !== offer.contents.digest) throw new BackupError("changed", "the backup file changed since it was previewed; read it again");
            if (settings && offer.plan) {
                const accepted = new Set(((p.plan as { changes?: { area?: unknown; key?: unknown }[] } | null)?.changes ?? []).map((c) => `${c?.area}\0${c?.key}`));
                offer.plan = { ...offer.plan, changes: offer.plan.changes.filter((c) => accepted.has(`${c.area}\0${c.key}`)) };
            }
            if (settings) await siteSchemaReady();   // a later site-access migration must not undo the lists written here
            const done = await restoreBackup(deps, { offer, sessions, settings, secret });
            if (done.sessionsAdded > 0) scheduleFolderSync();
            return done;
        }
        default: throw new Error("unknown backup action");
    }
}

/** The BACKUP response for a failure: the message, and a BackupError's `reason` (`needs-key`, `wrong-secret`, …). */
export function backupFailure(e: unknown): { error: string; reason?: string } {
    const reason = e instanceof BackupError ? e.reason : (e as { reason?: unknown } | null)?.reason;
    return { error: String((e as Error)?.message || e), ...(typeof reason === "string" ? { reason } : {}) };
}
