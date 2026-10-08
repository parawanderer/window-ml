// state-registry.ts — every store that keeps a run's state across calls, declared next to the store, so the state
// inspector lists what is declared instead of a hand-kept member list (docs/dev/state.md, docs/spec/STATE_INSPECTOR.md).
//
// One registry per REALM: the worker's, the page's and the offscreen document's are separate module instances, since
// each realm is its own bundle. A snapshot asks the realm that holds the run; a member another realm holds is reached
// through that realm's own read, never by sharing memory. `scripts/check-state.mjs` is what keeps this complete: it asks
// every module-level Map/Set/signal/`let` a change ADDS to be declared here or marked as not run state.

/** Who outlives what. `run` ends with the run, `session` with the session (every turn of one conversation), `tab`
 *  with the tab, `page` with the document, `browser` with the profile. */
export type StateScope = "run" | "session" | "tab" | "page" | "browser";

/** Which bundle holds the store. */
export type StateRealm = "worker" | "page" | "offscreen";

/** Who may read it. `model`: `ml.current` and the inspector. `human`: the inspector only, until the model is given
 *  it on purpose. `never`: a secret, refused by construction (a declaration with this audience may not have `read`). */
export type StateAudience = "model" | "human" | "never";

/** What empties it without anyone asking. Absent from the list means it survives that event. */
export type StateLoss = "worker-eviction" | "navigation" | "offscreen-close" | "browser-restart" | "turn-end";

/** Which run (or tab) a read is for. A store keyed by something else ignores what it does not use. */
export interface StateKey {
    runId?: string;
    tabId?: number;
}

/** One store's declaration. */
export interface StateDecl {
    /** Dotted, unique within its realm: the member path the inspector draws it under (`run.pointers`). */
    id: string;
    scope: StateScope;
    realm: StateRealm;
    audience: StateAudience;
    lostOn: StateLoss[];
    /** One sentence saying what it holds, in words the person reading the inspector would use. */
    describe: string;
    /** Plain data for one run, or undefined when the store holds nothing for it. Never a live reference: the result is
     *  handed to a reader that must not be able to reach the store through it. A store kept in storage reads async. */
    read?: (key: StateKey) => unknown;
}

/** One member of a snapshot: the declaration's facts and what its read returned. */
export interface StateEntry {
    id: string;
    scope: StateScope;
    audience: Exclude<StateAudience, "never">;
    lostOn: StateLoss[];
    describe: string;
    value: unknown;
    /** The read threw: the member is shown as failed rather than dropped, since an absent member reads as empty. */
    error?: string;
}

const registry = new Map<string, StateDecl>(); // state: fixed

/**
 * Declare a store. Call it at module load, beside the store, so the declaration cannot drift from what it describes.
 * @param decl the declaration
 * @returns the same declaration
 */
export function defineState(decl: StateDecl): StateDecl {
    if (registry.has(decl.id)) throw new Error(`state ${decl.id} is declared twice`);
    if (decl.audience === "never" && decl.read) throw new Error(`state ${decl.id} is a secret and may not have a read`);
    registry.set(decl.id, decl);
    return decl;
}

/** Every declaration in this realm, in id order. */
export const declaredState = (): StateDecl[] => [...registry.values()].sort((a, b) => a.id.localeCompare(b.id));

/**
 * What every readable store holds for one run. A member whose read returns undefined is left out (it holds nothing
 * for this run); one whose read throws is kept with its error.
 * @param key the run (or tab) to read for
 * @param audience `model` for what the model may see; `human` for everything but secrets
 */
export async function readState(key: StateKey, audience: "model" | "human"): Promise<StateEntry[]> {
    const out: StateEntry[] = [];
    for (const d of declaredState()) {
        if (!d.read || d.audience === "never" || (audience === "model" && d.audience !== "model")) continue;
        const base = { id: d.id, scope: d.scope, audience: d.audience, lostOn: [...d.lostOn], describe: d.describe };
        try {
            const value = await d.read(key);
            if (value !== undefined) out.push({ ...base, value: structuredClone(value) });
        } catch (e) {
            out.push({ ...base, value: undefined, error: e instanceof Error ? e.message : String(e) });
        }
    }
    return out;
}

/** Forget every declaration. Tests only: a module's declarations run once per load. */
export function resetStateRegistry(): void { registry.clear(); }
