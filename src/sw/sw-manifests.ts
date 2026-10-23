// sw-manifests.ts — the program manifests stored beside the shipped ones (PROGRAM_MANIFEST.md, "Registering a program",
// root K slice b): global ones for every workspace, and each workspace's own, keyed by its root's realpath.

// Kept in `chrome.storage.local`, never `sync`: a manifest pins a binary on THIS machine by its fingerprint, which means
// nothing on another. What may be stored, and what a call's facts must bear out before an entry describes it, is the
// pure `src/shell/stored-manifests.ts`. Only an extension page changes the store (`MANIFESTS` in background.ts); a page
// never registers anything, and nothing here reaches one.

import { defineState } from "../state-registry";
import { SHIPPED_MANIFESTS } from "../shell/sh-call";
import { storeRefusal, validStored, type ManifestRequest, type StoredManifest } from "../shell/stored-manifests";

/** The storage key of the global manifests. */
export const GLOBAL_MANIFESTS_KEY = "ml_manifests_global";
/** The storage key of every workspace's manifests, by the root's realpath. */
export const WORKSPACE_MANIFESTS_KEY = "ml_manifests_workspace";
/** At most this many entries in each scope's list: past it, an add is refused rather than an old entry dropped. */
export const MANIFESTS_MAX = 200;

const globals: StoredManifest[] = [];
const byRoot = new Map<string, StoredManifest[]>();

defineState({
    id: "manifests.global", scope: "browser", realm: "worker", audience: "human", lostOn: [],
    describe: "Program manifests the person registered or approved for every workspace: how ml.sh describes a program the extension ships no manifest for. A description, never a permission.",
    read: () => (globals.length ? globals.map((s) => ({ ...s })) : undefined),
});
defineState({
    id: "manifests.workspace", scope: "browser", realm: "worker", audience: "human", lostOn: [],
    describe: "Program manifests registered for one workspace root (its scripts, a tool inside it), by the root's realpath: they describe a call only while that root is configured.",
    read: () => (byRoot.size ? Object.fromEntries([...byRoot].map(([r, l]) => [r, l.map((s) => ({ ...s }))])) : undefined),
});

/** Whether storage has been read. Until then no stored entry describes anything, so a call it would describe asks. */
let loaded = false;   // state: plumbing — set once per worker by the read below

/** Storage has been read. A change waits for it, so an add made before the read is not overwritten by it. */
export const manifestsReady: Promise<void> = (() => {
    try {
        return chrome.storage.local.get([GLOBAL_MANIFESTS_KEY, WORKSPACE_MANIFESTS_KEY]).then((got) => {
            const g = got?.[GLOBAL_MANIFESTS_KEY];
            globals.splice(0, globals.length, ...(Array.isArray(g) ? g.filter((s) => validStored(s, "global")) : []));
            const w = (got?.[WORKSPACE_MANIFESTS_KEY] ?? {}) as Record<string, unknown>;
            for (const [root, list] of Object.entries(w)) {
                const kept = Array.isArray(list) ? list.filter((s): s is StoredManifest => validStored(s, "workspace") && s.root === root) : [];
                if (kept.length) byRoot.set(root, kept);
            }
        }).catch(() => { /* storage unavailable: nothing stored describes anything, so those calls ask */ }).finally(() => { loaded = true; });
    } catch { loaded = true; return Promise.resolve(); }   // no storage (a test harness)
})();

/** Whether every stored manifest is known. */
export const manifestsLoaded = (): boolean => loaded;

function save(): void {
    try { void chrome.storage.local.set({ [GLOBAL_MANIFESTS_KEY]: globals, [WORKSPACE_MANIFESTS_KEY]: Object.fromEntries(byRoot) }).catch(() => {}); } catch { /* storage unavailable */ }
}

let seq = 0;   // state: plumbing — makes ids unique within one worker; the time prefix covers the rest
const newId = (): string => `man-${Date.now().toString(36)}-${(seq++).toString(36)}`;

/** Every stored entry, as copies: what a call's description reads (`manifestsFor` picks the ones that apply). */
export function storedManifests(): StoredManifest[] {
    return [...globals, ...[...byRoot.values()].flat()].map((s) => ({ ...s }));
}

/**
 * Store a manifest, once storage has been read; refused with the reason when the store may not keep it.
 * @param r the entry
 * @returns the stored entry, or why not
 */
export async function addManifest(r: ManifestRequest): Promise<StoredManifest | { refused: string }> {
    await manifestsReady;
    const all = storedManifests();
    const why = storeRefusal(r, all, SHIPPED_MANIFESTS);
    if (why) return { refused: why };
    const list = r.scope === "global" ? globals : byRoot.get(r.root!) ?? [];
    if (list.length >= MANIFESTS_MAX) return { refused: `${MANIFESTS_MAX} manifests are already stored ${r.scope === "global" ? "globally" : `for ${r.root}`}` };
    const entry: StoredManifest = { id: newId(), scope: r.scope, ...(r.root !== undefined ? { root: r.root } : {}), manifest: r.manifest, origin: r.origin, created: Date.now(), ...(r.pin ? { pin: { ...r.pin } } : {}) };
    list.push(entry);
    if (r.scope === "workspace") byRoot.set(r.root!, list);
    save();
    return { ...entry };
}

/**
 * Remove a stored manifest by id, once storage has been read.
 * @param id the entry's id
 * @returns whether there was one
 */
export async function removeManifest(id: string): Promise<boolean> {
    await manifestsReady;
    const i = globals.findIndex((s) => s.id === id);
    if (i >= 0) { globals.splice(i, 1); save(); return true; }
    for (const [root, list] of byRoot) {
        const j = list.findIndex((s) => s.id === id);
        if (j < 0) continue;
        list.splice(j, 1);
        if (!list.length) byRoot.delete(root);
        save();
        return true;
    }
    return false;
}

/** What the registration page shows: the stored entries by scope, and the shipped programs a stored one cannot replace. */
export async function manifestView(): Promise<{ global: StoredManifest[]; workspace: { root: string; manifests: StoredManifest[] }[]; shipped: string[] }> {
    await manifestsReady;
    return {
        global: globals.map((s) => ({ ...s })),
        workspace: [...byRoot].map(([root, l]) => ({ root, manifests: l.map((s) => ({ ...s })) })),
        shipped: Object.keys(SHIPPED_MANIFESTS).sort(),
    };
}
