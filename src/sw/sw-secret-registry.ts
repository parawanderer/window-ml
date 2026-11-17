// sw-secret-registry.ts — the worker's store of the values the person registered as secret, read once into memory and kept current, and the substitutions every crossing into a script or a model scrubs with (SECRET_HANDLES.md, "The scrub as built").

import { defineState } from "../state-registry";
import { entryRefusal, registrySubs, type RegistryEntry, type RegistrySub } from "../secret-registry";

/** The `chrome.storage.local` key the entries live under: never sync, never a key of `MlConfig`, never in `GET_CONFIG`
 *  or a backup (MODEL_SETTINGS.md, "Not settings, never writable"). */
export const SECRET_REGISTRY_KEY = "ml_secret_registry";

/** The entries, as stored. */
let entries: RegistryEntry[] = [];   // state: declared below as "secrets.registry"
/** Their substitutions, built once per change: the scrub runs on every delta of a live output. */
let subs: RegistrySub[] = [];   // state: declared below as "secrets.registry"
/** The first read, awaited by the crossings so a tool result the worker produces right after it starts is never let
 *  through unscrubbed. */
let loaded: Promise<void> | null = null;   // state: plumbing — the first read, awaited by the crossings
/** Whether the entries in memory are the stored ones: false until a read or a change succeeds. A crossing never reads
 *  an empty registry as "no secrets" while this is false. */
let ready = false;   // state: plumbing — set by the first read, never unset
/** How many changes `storage.onChanged` has delivered: a read that started before one does not adopt over it. */
let changes = 0;   // state: plumbing — orders a read against the changes that arrive while it is in flight

defineState({
    id: "secrets.registry", scope: "browser", realm: "worker", audience: "human", lostOn: [],
    describe: "The secrets the person registered (Settings, Secrets): each one's NAME, never its value. Every text that crosses from the worker into a script or the model has their values replaced by [REDACTED:NAME].",
    read: () => ({ names: entries.map((e) => e.name), count: entries.length }),
});

/**
 * A stored value, as entries: anything that is not a `{ name, value }` pair of strings is dropped, entry by entry.
 * @param v what storage held
 * @returns the entries
 */
function parse(v: unknown): RegistryEntry[] {
    if (!Array.isArray(v)) return [];
    return v.filter((e): e is RegistryEntry => !!e && typeof e === "object" && typeof (e as RegistryEntry).name === "string" && typeof (e as RegistryEntry).value === "string");
}

/**
 * Takes the entries in, and rebuilds their substitutions.
 * @param next the entries
 */
function adopt(next: RegistryEntry[]): void {
    entries = next;
    subs = registrySubs(next);
}

/**
 * The first read of the stored entries, started once; later changes arrive through `storage.onChanged`.
 * @returns when the entries are in memory; it rejects when the store could not be read, and the next call reads again
 */
export function registryReady(): Promise<void> {
    if (!loaded) {
        const read = (async () => {
            if (typeof chrome === "undefined" || !chrome.storage?.local) { ready = true; return; }
            const seen = changes;
            const got = await chrome.storage.local.get({ [SECRET_REGISTRY_KEY]: [] });
            // A change that arrived while the read was in flight is the later state: the read's list is older than it.
            if (changes === seen) adopt(parse(got[SECRET_REGISTRY_KEY]));
            ready = true;
        })();
        loaded = read;
        read.catch(() => { if (loaded === read) loaded = null; });
    }
    return loaded;
}

/**
 * Whether the stored entries are in memory, for a crossing that cannot wait: before they are, it holds its text back
 * rather than read an empty registry as "no secrets".
 * @returns true once a read or a change has succeeded
 */
export function registryIsReady(): boolean {
    return ready;
}

// Guarded: a module imported outside the worker (a test, a page bundle) has no `chrome` at import. The first read
// starts here, so a crossing that cannot wait finds it done in all but the worker's first moments.
if (typeof chrome !== "undefined") {
    chrome.storage?.onChanged?.addListener((changed, area) => {
        if (area === "local" && SECRET_REGISTRY_KEY in changed) { changes++; adopt(parse(changed[SECRET_REGISTRY_KEY].newValue)); ready = true; }
    });
    void registryReady().catch(() => { /* read again by the first crossing that awaits it */ });
}

/**
 * The substitutions now, for a crossing that cannot wait (a live output's delta); empty before the first read.
 * @returns the substitutions
 */
export function registrySubsNow(): readonly RegistrySub[] {
    return subs;
}

/** What an extension page is told about the registry: its names and a count, never a value. */
export interface RegistryView { names: string[]; count: number }

/**
 * The view of the entries now.
 * @returns names and a count
 */
function view(): RegistryView {
    return { names: entries.map((e) => e.name), count: entries.length };
}

/**
 * The `SECRET_REGISTRY` message, from an extension page only (the router checks the sender): `list`, `add` an entry
 * (one with the same name replaces it) or `remove` one by name. Every answer is the view: names and a count.
 * @param p the payload: `op`, and `name` (and `value` for an add)
 * @returns the view, or why the change was refused
 */
export async function secretRegistryOp(p: { op?: unknown; name?: unknown; value?: unknown }): Promise<{ data: RegistryView } | { error: string }> {
    await registryReady();
    if (p.op === undefined || p.op === "list") return { data: view() };
    if (typeof p.name !== "string") return { error: "a secret is named by a string" };
    let next: RegistryEntry[];
    if (p.op === "add") {
        if (typeof p.value !== "string") return { error: "a secret's value is a string" };
        const e = { name: p.name, value: p.value };
        const why = entryRefusal(entries, e);
        if (why) return { error: why };
        next = [...entries.filter((x) => x.name !== e.name), e];
    } else if (p.op === "remove") {
        if (!entries.some((x) => x.name === p.name)) return { error: "no such secret" };
        next = entries.filter((x) => x.name !== p.name);
    } else return { error: "unknown op" };
    await chrome.storage.local.set({ [SECRET_REGISTRY_KEY]: next });
    adopt(next);
    return { data: view() };
}

/**
 * For tests: the entries, set directly, as if read from storage.
 * @param next the entries
 */
export function _setRegistryForTest(next: RegistryEntry[]): void {
    loaded = Promise.resolve();
    ready = true;
    adopt(next);
}

/** For tests: the registry as a cold worker has it, nothing read yet. */
export function _coldRegistryForTest(): void {
    loaded = null;
    ready = false;
    adopt([]);
}
