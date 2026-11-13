// sw-pkg-installs.ts — the packages each run installed with python_install: the record its every readonly cell carries, so the run's worker, and any worker that replaces it, unpacks them before the cell.

// docs/plan/repl/PACKAGES_INSTALL.md, slice 4, items 3 and 8. An install belongs to one run (ruled 2026-11-13, Q4). The
// record is in chrome.storage.session because the next cell must find it after a worker eviction; it is lost on a
// browser restart, after which the run's cells no longer find the package (a new card shows its files as `mirror`, with
// no download). Dropped with the run's namespace (`deletePythonRun`).

import { defineState } from "../state-registry";

/** The storage.session key holding every run's install record, by run id. */
export const PKG_INSTALLS_KEY = "ml_pkginstalls";

/** One installed wheel: what the card showed, and the import names it took. */
export interface InstalledWheel {
    name: string;
    version: string;
    /** `pypi` or `mirror`, as the card showed it. */
    source: string;
    filename: string;
    sha256: string;
    /** Its top-level import names (`pkg-archive.ts`), which no later install of the run may take. */
    topLevel: string[];
}

defineState({
    id: "python.run-installs", scope: "run", realm: "worker", audience: "model", lostOn: ["browser-restart"],
    describe: "The Python packages this run installed with python_install, by name, version and sha256: importable in the run's python_exec cells.",
    read: async ({ runId }) => {
        const rows = runId ? (await readAll())[runId] : undefined;
        return rows?.length ? rows.map(({ name, version, source, sha256 }) => ({ name, version, source, sha256 })) : undefined;
    },
});

// Every write is a read-modify-write of one key, so the writes go one after another or two at once lose one.
let queue: Promise<unknown> = Promise.resolve();   // state: plumbing — orders this worker's writes to PKG_INSTALLS_KEY

/** Every run's record. */
async function readAll(): Promise<Record<string, InstalledWheel[]>> {
    try {
        const got = (await chrome.storage.session.get(PKG_INSTALLS_KEY))[PKG_INSTALLS_KEY];
        return got && typeof got === "object" ? got as Record<string, InstalledWheel[]> : {};
    } catch { return {}; }
}

/** Apply `change` to every run's record and store it, after the writes before it. */
function edit(change: (all: Record<string, InstalledWheel[]>) => void): Promise<void> {
    const next = queue.then(async () => {
        const all = await readAll();
        change(all);
        await chrome.storage.session.set({ [PKG_INSTALLS_KEY]: all });
    });
    queue = next.catch(() => { /* the next write starts from what is stored */ });
    return next;
}

/**
 * The wheels a run installed, in the order it installed them.
 * @param runId the run
 */
export async function runInstalls(runId: string): Promise<InstalledWheel[]> {
    await queue;
    return (await readAll())[runId] ?? [];
}

/**
 * Add one install call's wheels to the run's record, after the candidate passed.
 * @param runId the run
 * @param wheels the call's wheels
 */
export function recordInstalls(runId: string, wheels: InstalledWheel[]): Promise<void> {
    return edit((all) => { all[runId] = [...(all[runId] ?? []), ...wheels]; });
}

/**
 * Forget a run's record, with its namespace.
 * @param runId the run
 */
export function dropRunInstalls(runId: string): Promise<void> {
    return edit((all) => { delete all[runId]; }).catch(() => { /* no session storage: there was nothing to drop */ });
}
