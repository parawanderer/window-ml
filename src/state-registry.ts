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
    realm: StateRealm;
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
 * @param realm only the stores this realm holds. A module shared between bundles (util.ts) declares in each, and only
 *   the realm that actually holds the store has anything to say about it.
 */
export async function readState(key: StateKey, audience: "model" | "human", realm?: StateRealm): Promise<StateEntry[]> {
    const out: StateEntry[] = [];
    for (const d of declaredState()) {
        if (!d.read || d.audience === "never" || (audience === "model" && d.audience !== "model")) continue;
        if (realm && d.realm !== realm) continue;
        const base = { id: d.id, realm: d.realm, scope: d.scope, audience: d.audience, lostOn: [...d.lostOn], describe: d.describe };
        try {
            const value = await d.read(key);
            if (value !== undefined) out.push({ ...base, value: structuredClone(value) });
        } catch (e) {
            out.push({ ...base, value: undefined, error: e instanceof Error ? e.message : String(e) });
        }
    }
    return out;
}

/** A declared member a person may see, whether or not it holds anything for a run, so a reader can show an empty one
 *  as empty rather than leave it out. */
export interface StateMember {
    id: string;
    realm: StateRealm;
    scope: StateScope;
    audience: "model" | "human";
    lostOn: StateLoss[];
    describe: string;
}

/** Every readable member one realm declares, in id order. */
export const readableMembers = (realm: StateRealm): StateMember[] => declaredState()
    .filter((d) => d.read && d.audience !== "never" && d.realm === realm)
    .map((d) => ({ id: d.id, realm: d.realm, scope: d.scope, audience: d.audience as "model" | "human", lostOn: [...d.lostOn], describe: d.describe }));

/** Forget every declaration. Tests only: a module's declarations run once per load. */
export function resetStateRegistry(): void { registry.clear(); }

const MEMBER_ID = /^[a-z][\w.-]{0,63}$/;

const SCOPES: readonly StateScope[] = ["run", "session", "tab", "page", "browser"];

const LOSSES: readonly StateLoss[] = ["worker-eviction", "navigation", "offscreen-close", "browser-restart", "turn-end"];

/**
 * A page's answer to RUN_STATE_IN_PAGE, made safe to show. THE PAGE IS NOT TRUSTED: a hostile page answers this itself,
 * so whatever it says is labelled as the page's (realm `page`, forced here), a member id must be a plain dotted name
 * and may not shadow one of the worker's, and a description is capped. Values pass as they came: they reached the
 * worker as structured-clone data, and the pane draws them as a JSON tree, never as markup.
 * @param raw the page's reply
 * @param taken the worker's own member ids
 * @returns the page's members and entries, or null when the reply is not one
 */
export function pageStateFrom(raw: unknown, taken: ReadonlySet<string>): { members: StateMember[]; entries: StateEntry[] } | null {
    const r = raw as { members?: unknown; entries?: unknown } | null;
    if (!r || !Array.isArray(r.members) || !Array.isArray(r.entries)) return null;
    const members: StateMember[] = [];
    for (const m of r.members.slice(0, 32) as Partial<StateMember>[]) {
        if (!m || typeof m.id !== "string" || !MEMBER_ID.test(m.id) || taken.has(m.id) || members.some((x) => x.id === m.id)) continue;
        members.push({
            id: m.id, realm: "page",
            scope: SCOPES.includes(m.scope as StateScope) ? m.scope as StateScope : "page",
            audience: m.audience === "human" ? "human" : "model",
            lostOn: Array.isArray(m.lostOn) ? m.lostOn.filter((l): l is StateLoss => LOSSES.includes(l as StateLoss)) : ["navigation"],
            describe: typeof m.describe === "string" ? m.describe.slice(0, 300) : "",
        });
    }
    const byId = new Map(members.map((m) => [m.id, m]));
    const entries: StateEntry[] = [];
    for (const e of r.entries as Partial<StateEntry>[]) {
        const m = e && typeof e.id === "string" ? byId.get(e.id) : undefined;
        if (!m || entries.some((x) => x.id === m.id)) continue;
        entries.push({ ...m, value: e.value, ...(typeof e.error === "string" ? { error: e.error.slice(0, 300) } : {}) });
    }
    return { members, entries };
}
