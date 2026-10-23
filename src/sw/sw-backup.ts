// sw-backup.ts — the service worker's side of backup and restore: the real `BackupDeps` and the one `BACKUP` action dispatch.

/**
 * `backup-run.ts` is the sequence with every outside thing injected; this binds it to the worker's session store, the
 * archive worker (`archiveCall`) and `chrome.storage`, and checks what an extension page sends. Passphrase set-up and
 * change are not here: the page reaches the keyring in IndexedDB directly.
 */
import { BackupError, type Secret } from "../backup/backup-format";
import type { BackupForm } from "../backup/backup-file";
import { chromeStorageWriter, type RestorePlan, type StorageSnapshot } from "../backup/backup-settings";
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
            // The page's plan is only a list of the keys the person accepted: the worker computes the plan again from the
            // file and the storage as they are now, and writes the changes of its own plan whose keys the page also lists.
            let plan: RestorePlan | null = null;
            if (settings) {
                const accepted = new Set(((p.plan as { changes?: { area?: unknown; key?: unknown }[] } | null)?.changes ?? []).map((c) => `${c?.area}\0${c?.key}`));
                const fresh = (await offerRestore(deps, secret)).plan;
                if (fresh) plan = { ...fresh, changes: fresh.changes.filter((c) => accepted.has(`${c.area}\0${c.key}`)) };
            }
            if (settings) await siteSchemaReady();   // a later site-access migration must not undo the lists written here
            const done = await restoreBackup(deps, { plan, sessions, settings, secret });
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
