// sw-policies.ts — the person's policies, by scope, and the one function that judges a gated call against them.
//
// docs/spec/POLICIES.md. A policy is a script of the read-only dialect's policy realm (`evalPolicy`) over one call's
// resolved facts, answering allow, deny or nothing. Two scopes live here: GLOBAL ones the person set, and a RUN's, keyed
// by its session hash, which survive a resume (the hash is the same) and go when the session is deleted. A fork built
// by a page inherits nothing (POLICIES.md, "Scopes"). Both are kept in `chrome.storage.local`, never `sync`: a policy
// about this browser's backend has no business following someone to another machine, and a sync quota would cap it.
//
// The first consumer is `fetch_url` on a worker-hosted run: "Approve + remember these URLs" on an `exec` card adds one
// run policy per URL the person saw, `(c) => c.kind === "fetch" && c.url === "<literal>"` (`rememberFetchUrls`).

import { evalPolicy, PolicyEffect } from "../readonly-exec";
import { fromFetch, free, boundFor, EffectsData } from "../effects";
import { defineState } from "../state-registry";
import type { AskWhy, PersistGrant } from "../contract";
import { validList, CONSUMERS, GLOBAL_POLICIES_KEY, POLICY_LABEL_MAX } from "./policy-valid";

/** Which kind of call a policy is about; a policy is only ever evaluated over calls of its own consumer. `sh` is
 *  `ml.sh` (docs/spec/SHELL.md), whose facts its own consumer builds. */
export type PolicyConsumer = "fetch" | "sh";

/** Where a policy came from: written by the person, added by answering an approval card, or proposed by the model and
 *  approved by the person on its own card (`propose_policy`). */
export type PolicyOrigin = "person" | "card" | "proposed";

/** One stored policy. `source` is the dialect script; `label` the line the policy page shows. */
export interface StoredPolicy {
    id: string;
    scope: "global" | "run";
    consumer: PolicyConsumer;
    effect: PolicyEffect;
    source: string;
    label: string;
    origin: PolicyOrigin;
    created: number;
    /** Set on the rows of one multi-rule proposal, the same id on each, so the policy page can show them together. */
    proposal?: string;
}

/** What judging one call decided: the answer, the policy that gave it, and every policy that broke on the way.
 *  `"ask"` with no `by` means the saved policies are not read yet; with `by` an `ask` policy matched. Either way the call
 *  goes to the person and nothing below the judge (a remembered consent, a free tier) may answer for them. */
export interface PolicyJudgement {
    decision: PolicyEffect | undefined;
    /** Set only when `decision` is `undefined`: a policy that would have allowed this call is gone, and why. TEXT for the
     *  ask, never an input to the decision (a reason never re-allows). */
    lapsed?: LapsedAsk;
    /** The policy that decided, or `"builtin"` for the built-in default (the effect algebra's free tier). Absent on the
     *  `"ask"` of a store not loaded yet. */
    by?: StoredPolicy | "builtin";
    broken: { policy: StoredPolicy; reason: string }[];
}

/** Why an allowing policy is gone: the archive took it, the person removed it, or they edited it (`narrowed`: it no longer
 *  allows what it did). `expired` is reserved for a policy with a lifetime; none has one yet. */
export type LapseCause = "archived" | "removed" | "narrowed" | "expired";

/** What an ask says about the policy that used to cover it. */
export interface LapsedAsk { id: string; scope: StoredPolicy["scope"]; label: string; cause: LapseCause; at: number }

/** A policy that allowed calls and is gone, kept with its source so a later ask can tell whether it would have covered it. */
interface LapsedPolicy extends LapsedAsk { consumer: PolicyConsumer; source: string }

/** The storage key of the global policies (declared in policy-valid.ts, which a backup reads without this module). */
export { GLOBAL_POLICIES_KEY };
/** The storage key of every session's run policies, by session hash. */
export const RUN_POLICIES_KEY = "ml_policies_run";
/** The storage key of what each ARCHIVED session lost: when its run policies were removed, and their labels. */
export const ARCHIVED_POLICIES_KEY = "ml_policies_archived";
/** The storage key of the allowing policies that went (removed, narrowed, archived), by session hash, `*` for global ones. */
export const LAPSED_POLICIES_KEY = "ml_policies_lapsed";
/** Lapsed policies kept per key; past it the oldest go. */
const LAPSED_PER_KEY_MAX = 20;
const GLOBAL_LAPSED = "*";
/** Sessions whose run policies are kept; past it the oldest go. Deleted sessions take theirs with them first. */
const RUN_POLICY_SESSIONS_MAX = 500;

const globals: StoredPolicy[] = [];
const byRun = new Map<string, StoredPolicy[]>();
defineState({
    id: "policies.global", scope: "browser", realm: "worker", audience: "model", lostOn: [],
    exposedAs: "ml.current.policies",
    describe: "The policies the person set for every run: calls they allow or refuse without being asked.",
    read: () => (globals.length ? globals.map((p) => ({ ...p })) : undefined),
});
defineState({
    id: "policies.run", scope: "session", realm: "worker", audience: "model", lostOn: [],
    exposedAs: "ml.current.policies",
    describe: "The run's own policies, from an approval card's \"remember\" or set by the person: kept across a resume, gone when the session is deleted (from the live store or the archive), and not inherited by a fork a page builds.",
    read: ({ runId }) => { const l = runId ? byRun.get(runId) : undefined; return l?.length ? l.map((p) => ({ ...p })) : undefined; },
});

/** Run policies removed when their session was archived, by hash: said when the session comes back, never silent. */
const archivedLoss = new Map<string, { at: number; labels: string[]; told?: true }>();
defineState({
    id: "policies.archived", scope: "session", realm: "worker", audience: "model", lostOn: [],
    exposedAs: "ml.current.policiesRemoved",
    describe: "The run policies a session lost when it was archived, and when: told to the person and the model when it is resumed.",
    read: ({ runId }) => { const l = runId ? archivedLoss.get(runId) : undefined; return l ? { ...l, labels: [...l.labels] } : undefined; },
});

/** The allowing policies that went, by session hash (`*`: global): only so an ask can say why it is asking. */
const lapsed = new Map<string, LapsedPolicy[]>();
defineState({
    id: "policies.lapsed", scope: "session", realm: "worker", audience: "model", lostOn: [],
    exposedAs: "the reason in a tool result when a call asks",
    describe: "Allowing policies that were removed, edited or archived, kept so the next call they would have covered says why it asks. Text only: it never allows anything.",
    read: ({ runId }) => { const l = [...(lapsed.get(GLOBAL_LAPSED) ?? []), ...(runId ? lapsed.get(runId) ?? [] : [])]; return l.length ? l.map(({ source: _s, ...rest }) => rest) : undefined; },
});

/** Remember an allowing policy that went; a deny going widens nothing, so it needs no reason. */
function noteLapsed(key: string, p: StoredPolicy, cause: LapseCause): void {
    if (p.effect !== "allow") return;
    const l = (lapsed.get(key) ?? []).filter((x) => !(x.source === p.source && x.consumer === p.consumer));
    l.push({ id: p.id, scope: p.scope, label: p.label, cause, at: Date.now(), consumer: p.consumer, source: p.source });
    lapsed.delete(key);
    lapsed.set(key, l.slice(-LAPSED_PER_KEY_MAX));
}

/** Called after every change to any policy, so a card already showing is judged again (`rejudgePending`). */
const changeListeners = new Set<() => void>();   // state: plumbing — the worker's own subscribers, registered at load

/** Run `fn` after every change to any policy; returns the unsubscribe. */
export function onPoliciesChanged(fn: () => void): () => void {
    changeListeners.add(fn);
    return () => changeListeners.delete(fn);
}

function changed(): void {
    for (const fn of changeListeners) { try { fn(); } catch { /* one listener's failure is not the store's */ } }
}

/** Why each policy last broke, by id: shown against it on the policy page. */
const brokenWhy = new Map<string, string>();   // state: cache — recomputed on the next evaluation

/** Whether storage has been read. Until it has, a `deny` the person saved is not known yet, so a consumer must ASK
 *  rather than let a free tier answer (`fetchPolicy` in sw-run-host.ts). True only once memory holds the merge below. */
let loaded = false;   // state: plumbing — set once per worker by the read below

/** How the one storage read went: `failed` means the saved lists are unknown, so no save may replace them. */
let readState: "pending" | "read" | "failed" = "pending";   // state: plumbing — set once per worker by the read below
/** Saves asked for before the read finished, issued right after it (a save writes the whole in-memory state). */
const owed = { globals: false, runs: false };   // state: plumbing — drained once by the read below
/** Sessions forgotten before the read: replayed after it, or the merge would bring their saved policies back. */
const forgottenEarly: [string, "deleted" | "archived"][] = [];   // state: plumbing — drained once by the read below

/** Whether every saved policy is known. */
export const policiesLoaded = (): boolean => loaded;

/** The read's result merged into what was added meanwhile: the stored entries first, then each early one whose id is not
 *  stored (and, for `dup`, that does not duplicate a stored one: `addRunPolicy`'s own dedupe). */
function mergeEarly<T extends { id: string }>(stored: T[], early: T[], dup: (a: T, b: T) => boolean = () => false): T[] {
    return [...stored, ...early.filter((e) => !stored.some((s) => s.id === e.id || dup(s, e)))];
}
const sameRunPolicy = (a: StoredPolicy, b: StoredPolicy): boolean => a.source === b.source && a.effect === b.effect && a.consumer === b.consumer;

/** Fill memory from what storage held, keeping what was added before it answered (POLICIES add before the read, "Approve +
 *  remember" on a card). Synchronous, so no judgement sees a half-filled store. */
function mergeStored(got: Record<string, unknown> | undefined): void {
    const early = { globals: globals.slice(), runs: new Map(byRun), lapsed: new Map(lapsed) };
    globals.splice(0, globals.length, ...mergeEarly(validList(got?.[GLOBAL_POLICIES_KEY], "global"), early.globals));
    const runs = (got?.[RUN_POLICIES_KEY] ?? {}) as Record<string, unknown>;
    byRun.clear();
    for (const [hash, list] of Object.entries(runs)) if (!early.runs.has(hash)) byRun.set(hash, validList(list, "run"));
    for (const [hash, mine] of early.runs) byRun.set(hash, mergeEarly(validList(runs[hash], "run"), mine, sameRunPolicy));   // re-inserted last, as `addRunPolicy` does
    const lost = (got?.[ARCHIVED_POLICIES_KEY] ?? {}) as Record<string, { at?: unknown; labels?: unknown; told?: unknown }>;
    for (const [hash, l] of Object.entries(lost))
        if (!archivedLoss.has(hash) && typeof l?.at === "number" && Array.isArray(l.labels) && l.labels.every((x) => typeof x === "string"))
            archivedLoss.set(hash, { at: l.at, labels: l.labels as string[], ...((l as { told?: unknown }).told === true ? { told: true as const } : {}) });
    const gone = (got?.[LAPSED_POLICIES_KEY] ?? {}) as Record<string, unknown>;
    lapsed.clear();
    for (const [key, list] of Object.entries(gone)) if (!early.lapsed.has(key) && Array.isArray(list)) lapsed.set(key, list.filter(validLapsed).slice(-LAPSED_PER_KEY_MAX));
    for (const [key, mine] of early.lapsed) {
        const stored = Array.isArray(gone[key]) ? (gone[key] as unknown[]).filter(validLapsed) : [];
        lapsed.set(key, mergeEarly(stored, mine).slice(-LAPSED_PER_KEY_MAX));
    }
}

/** Storage has been read, so a judgement made now sees every saved policy. Until then a call asks (fails closed). A policy
 *  added before this resolves is merged in, not dropped, and its save waits for the read (`saveGlobals`, `saveRuns`). */
export const policiesReady: Promise<void> = (() => {
    try {
        return chrome.storage.local.get([GLOBAL_POLICIES_KEY, RUN_POLICIES_KEY, ARCHIVED_POLICIES_KEY, LAPSED_POLICIES_KEY]).then((got) => {
            mergeStored(got);
            readState = "read";
            loaded = true;   // after the merge, in the same turn: no judgement sees `loaded` with memory unfilled
            for (const [runId, why] of forgottenEarly.splice(0)) forgetRunPolicies(runId, why);
            const { globals: g, runs: r } = owed;
            owed.globals = owed.runs = false;
            // Through the saves, not the writes: the merge can hold more sessions than the cap, which `saveRuns` trims.
            if (g) saveGlobals();
            if (r) saveRuns();
        }).catch(() => {
            /* storage unavailable: nothing saved is known, so every call asks (`judgeCall`), save one an add made meanwhile
               denies; and no save may replace the lists we could not read with a partial one */
            if (readState === "pending") readState = "failed";
            loaded = true;
        });
    } catch { readState = "read"; loaded = true; return Promise.resolve(); }   // no storage (a test harness): nothing saved to wait for
})();

/** Whether storage held a well-formed lapsed policy. */
function validLapsed(p: unknown): p is LapsedPolicy {
    const q = p as LapsedPolicy | null;
    return !!q && typeof q === "object" && typeof q.id === "string" && typeof q.label === "string" && typeof q.source === "string"
        && typeof q.at === "number" && CONSUMERS.has(q.consumer) && (q.scope === "global" || q.scope === "run")
        && (q.cause === "archived" || q.cause === "removed" || q.cause === "narrowed" || q.cause === "expired");
}

function writeGlobals(): void {
    try { void chrome.storage.local.set({ [GLOBAL_POLICIES_KEY]: globals, [LAPSED_POLICIES_KEY]: Object.fromEntries(lapsed) }).catch(() => {}); } catch { /* storage unavailable */ }
}
function writeRuns(): void {
    try { void chrome.storage.local.set({ [RUN_POLICIES_KEY]: Object.fromEntries(byRun), [ARCHIVED_POLICIES_KEY]: Object.fromEntries(archivedLoss), [LAPSED_POLICIES_KEY]: Object.fromEntries(lapsed) }).catch(() => {}); } catch { /* storage unavailable */ }
}
/** A save writes the whole in-memory state, so before the read it would replace the stored lists with a partial one: it is
 *  owed until the read merges (`policiesReady`), and dropped for good when the read failed. */
function saveGlobals(): void {
    if (readState === "pending") owed.globals = true; else if (readState === "read") writeGlobals();
    changed();
}
function saveRuns(): void {
    while (byRun.size > RUN_POLICY_SESSIONS_MAX) byRun.delete(byRun.keys().next().value!);
    while (archivedLoss.size > RUN_POLICY_SESSIONS_MAX) archivedLoss.delete(archivedLoss.keys().next().value!);
    while (lapsed.size > RUN_POLICY_SESSIONS_MAX + 1) { const k = [...lapsed.keys()].find((x) => x !== GLOBAL_LAPSED); if (k === undefined) break; lapsed.delete(k); }
    if (readState === "pending") owed.runs = true; else if (readState === "read") writeRuns();
    changed();
}

let seq = 0;   // state: plumbing — makes ids unique within one worker; the time prefix covers the rest
const newId = (): string => `pol-${Date.now().toString(36)}-${(seq++).toString(36)}`;

/** The global policies, as copies. */
export function globalPolicies(): StoredPolicy[] { return globals.map((p) => ({ ...p })); }

/** A run's own policies, as copies. */
export function runPolicies(runId: string): StoredPolicy[] { return (byRun.get(runId) ?? []).map((p) => ({ ...p })); }

/** Why a policy last broke, or undefined while it has not. */
export function brokenReason(id: string): string | undefined { return brokenWhy.get(id); }

/** Add a policy to a run, unless the run already has one with the same source and effect; returns the run's copy. */
export function addRunPolicy(runId: string, p: Pick<StoredPolicy, "consumer" | "effect" | "source" | "label" | "origin"> & { proposal?: string }): StoredPolicy {
    const list = byRun.get(runId) ?? [];
    const same = list.find((q) => q.source === p.source && q.effect === p.effect && q.consumer === p.consumer);
    if (same) return { ...same };
    const made: StoredPolicy = { ...p, id: newId(), scope: "run", created: Date.now() };
    byRun.delete(runId);   // re-inserted last, so the cap drops the oldest session rather than this one
    byRun.set(runId, [...list, made]);
    saveRuns();
    return { ...made };
}

/** Add a global policy (the person, in Settings); returns it. */
export function addGlobalPolicy(p: Pick<StoredPolicy, "consumer" | "effect" | "source" | "label">): StoredPolicy {
    const made: StoredPolicy = { ...p, origin: "person", id: newId(), scope: "global", created: Date.now() };
    globals.push(made);
    saveGlobals();
    return { ...made };
}

/** Remove one policy by id, from whichever scope holds it; true when it existed. */
export function removePolicy(id: string): boolean {
    brokenWhy.delete(id);
    const g = globals.findIndex((p) => p.id === id);
    if (g >= 0) { noteLapsed(GLOBAL_LAPSED, globals[g], "removed"); globals.splice(g, 1); saveGlobals(); return true; }
    for (const [hash, list] of byRun) {
        const i = list.findIndex((p) => p.id === id);
        if (i < 0) continue;
        noteLapsed(hash, list[i], "removed");
        const rest = list.filter((_, k) => k !== i);
        if (rest.length) byRun.set(hash, rest); else byRun.delete(hash);
        saveRuns();
        return true;
    }
    return false;
}

/** Forget a session's run policies: the session was deleted, archived or evicted (POLICIES.md, "Scopes": removed when
 *  the session is archived, so an archived session that comes back has none). An ARCHIVED session's loss is recorded,
 *  with the time, so its resume says so (`archivedPolicyLoss`); a deleted session's record goes with it. */
export function forgetRunPolicies(runId: string, why: "deleted" | "archived" = "deleted"): void {
    if (readState === "pending") forgottenEarly.push([runId, why]);
    const list = byRun.get(runId);
    if (why === "deleted") { archivedLoss.delete(runId); lapsed.delete(runId); }
    if (!list) { if (why === "deleted") saveRuns(); return; }
    for (const p of list) { brokenWhy.delete(p.id); if (why === "archived") noteLapsed(runId, p, "archived"); }
    byRun.delete(runId);
    if (why === "archived" && list.length) archivedLoss.set(runId, { at: Date.now(), labels: list.map((p) => p.label) });
    saveRuns();
}

/** What an archived session lost, and when, or undefined when it lost nothing. */
export function archivedPolicyLoss(runId: string): { at: number; labels: string[] } | undefined {
    const l = archivedLoss.get(runId);
    return l ? { at: l.at, labels: [...l.labels] } : undefined;
}

/** Whether an edit changed what an allowing policy says (its source or its effect), so the old one may have covered calls the new one does not. */
const narrowedBy = (was: StoredPolicy, now: StoredPolicy): boolean => was.effect === "allow" && (was.source !== now.source || now.effect !== "allow");

/** The one-time sentence for a session that comes back after an archive took its run policies (POLICIES.md, "Scopes"):
 *  returned the first time only, then marked told in storage, so a later resume does not repeat it. The first ask that
 *  one of those policies would have covered says so again, with its cause (`judgeCall`'s `lapsed`). */
export function takeArchiveNotice(runId: string): string | undefined {
    const l = archivedLoss.get(runId);
    if (!l || l.told) return undefined;
    l.told = true;
    saveRuns();
    return `window.ml note (from the extension, not from the person): this session was archived on ${new Date(l.at).toISOString()} and its run policies were removed then (${l.labels.map(speakable).join("; ")}). Calls those policies allowed without asking will ask the person again.`;
}

/** Change a policy's source, effect or label in place (the policy page); returns it, or undefined when there is none. */
export function editPolicy(id: string, patch: Partial<Pick<StoredPolicy, "source" | "effect" | "label">>): StoredPolicy | undefined {
    const at = (list: StoredPolicy[]): number => list.findIndex((p) => p.id === id);
    const apply = (p: StoredPolicy): StoredPolicy => ({
        ...p,
        ...(typeof patch.source === "string" ? { source: patch.source } : {}),
        ...(patch.effect === "allow" || patch.effect === "deny" || patch.effect === "ask" ? { effect: patch.effect } : {}),
        ...(typeof patch.label === "string" ? { label: patch.label } : {}),
    });
    brokenWhy.delete(id);
    const g = at(globals);
    if (g >= 0) { const was = globals[g]; globals[g] = apply(was); if (narrowedBy(was, globals[g])) noteLapsed(GLOBAL_LAPSED, was, "narrowed"); saveGlobals(); return { ...globals[g] }; }
    for (const [hash, list] of byRun) {
        const i = at(list);
        if (i < 0) continue;
        const next = list.map((p, k) => (k === i ? apply(p) : p));
        if (narrowedBy(list[i], next[i])) noteLapsed(hash, list[i], "narrowed");
        byRun.set(hash, next);
        saveRuns();
        return { ...next[i] };
    }
    return undefined;
}

/** The built-in default policy, as the policy page shows it: one rule over the effect algebra, as code. */
export const BUILTIN_POLICY = Object.freeze({
    label: "Built-in: a call whose effects are inside what its placement bounds runs without asking",
    source: "(c) => c.effects ⊆ B(placement) ∪ { read(fs(p)) : p in a root, not secret }   // free(), src/effects.ts",
});

/** Everything the policy page lists: the global policies, each session's, the built-in default, and why any broke. */
export function policyView(): { global: StoredPolicy[]; runs: { hash: string; policies: StoredPolicy[] }[]; builtin: typeof BUILTIN_POLICY; broken: Record<string, string> } {
    return {
        global: globalPolicies(),
        runs: [...byRun].filter(([, l]) => l.length).map(([hash, l]) => ({ hash, policies: l.map((p) => ({ ...p })) })),
        builtin: BUILTIN_POLICY,
        broken: Object.fromEntries(brokenWhy),
    };
}

/**
 * Judge one call against the global policies and the run's. The strictest answer wins across both scopes: `deny`, then
 * `ask`, then `allow`; a policy that breaks is no opinion (and recorded). An `ask` puts the call to the person where an
 * `allow` or the built-in default would have run it. With no person's answer, the built-in default allows a call whose
 * effects are inside what its placement bounds (`free`, effects.ts) and otherwise the tiers above decide (`undefined`).
 *
 * Two rules every consumer keeps (docs/spec/POLICIES.md, "A change takes effect at once"):
 * - **A store not yet loaded means ASK, free tiers included.** Until the saved policies are read after a worker wake
 *   this returns `"ask"` (no `by`), and the consumer must put the call to the person without letting any free tier of
 *   its own answer: an unloaded `deny` is an unenforced one. A matching `ask` policy returns the same `"ask"` WITH `by`,
 *   and the consumer treats it the same way, adding the policy's label to the card (`askWhyOf`). A read that FAILED
 *   keeps this for good in that worker: a policy added since may deny, but nothing else answers without the person.
 *   This function carries the rule so a consumer cannot forget it.
 * - **Judge again at the choke point.** A consumer whose call runs somewhere other than its gate (the worker's fetch,
 *   the host's process start) calls this again there, over the same facts, rather than trusting the gate's answer.
 * @param runId the run's session hash, or undefined for a call no run made
 * @param consumer the kind of call
 * @param facts the call's resolved facts, with `effects` the call's effect set
 * @param placement where the call runs, for the built-in default's bound
 */
export function judgeCall(runId: string | undefined, consumer: PolicyConsumer, facts: Record<string, unknown> & { effects: EffectsData },
    placement: Parameters<typeof boundFor>[0] = "worker-survey"): PolicyJudgement {
    if (!loaded) return { decision: "ask", broken: [] };
    const all = [...globals, ...(runId ? byRun.get(runId) ?? [] : [])].filter((p) => p.consumer === consumer);
    const broken: PolicyJudgement["broken"] = [];
    let allow: StoredPolicy | undefined, ask: StoredPolicy | undefined;
    for (const p of all) {
        const r = evalPolicy(p.source, facts, p.effect);
        if (r.broken) { brokenWhy.set(p.id, r.broken); broken.push({ policy: { ...p }, reason: r.broken }); continue; }
        brokenWhy.delete(p.id);
        if (r.decision === "deny") return { decision: "deny", by: { ...p }, broken };
        if (r.decision === "ask" && !ask) ask = p;
        if (r.decision === "allow" && !allow) allow = p;
    }
    if (ask) return { decision: "ask", by: { ...ask }, broken };
    // The read failed: a saved `deny` may be missing, so nothing short of an added one's deny answers without the person.
    if (readState === "failed") return { decision: "ask", broken };
    if (allow) return { decision: "allow", by: { ...allow }, broken };
    if (free(facts.effects, boundFor(placement))) return { decision: "allow", by: "builtin", broken };
    const gone = lapsedCover(runId, consumer, facts);
    return { decision: undefined, broken, ...(gone ? { lapsed: gone } : {}) };
}

/** The most recent gone policy that would have allowed this call, or undefined. Evaluated like a live one, but its answer
 *  only becomes text on the ask: nothing here is read by the decision. */
function lapsedCover(runId: string | undefined, consumer: PolicyConsumer, facts: Record<string, unknown>): LapsedAsk | undefined {
    const gone = [...(lapsed.get(GLOBAL_LAPSED) ?? []), ...(runId ? lapsed.get(runId) ?? [] : [])].filter((p) => p.consumer === consumer);
    for (const p of gone.sort((a, b) => b.at - a.at)) {
        const r = evalPolicy(p.source, facts, "allow");
        if (!r.broken && r.decision === "allow") return { id: p.id, scope: p.scope, label: p.label, cause: p.cause, at: p.at };
    }
    return undefined;
}

/** A policy's label made safe to quote inside the worker's own sentence: no double quote, no control or line-separator
 *  character (a label can come from a URL the model wrote or from a proposal), one line, at most `POLICY_LABEL_MAX`. */
export function speakable(label: string): string {
    const one = label.replace(/["\p{Cc}\p{Zl}\p{Zp}]+/gu, (m) => (m.includes('"') ? "'" : " ")).replace(/\s+/g, " ").trim();
    return one.length > POLICY_LABEL_MAX ? `${one.slice(0, POLICY_LABEL_MAX - 1)}…` : one;
}

const CAUSE_TEXT: Record<LapseCause, string> = {
    archived: "was removed when this session was archived",
    removed: "was removed by the person",
    narrowed: "was edited and no longer covers this call",
    expired: "expired",
};

/** The one sentence the model reads when a call asks because a policy that used to cover it is gone. */
export function lapsedSentence(l: LapsedAsk): string {
    return `This call needed approval because the policy "${speakable(l.label)}", which allowed calls like it, ${CAUSE_TEXT[l.cause]} (${new Date(l.at).toISOString()}); the call itself did not change.`;
}

/** The `AskWhy.cause` of a call that asks because an `ask` policy matched it. */
export const ASK_POLICY_CAUSE = "ask-policy";

/** Whether a call asks because an `ask` policy matched it, so its card offers no "remember" (an `allow` the `ask` overrides). */
export const askedByPolicy = (why: AskWhy | undefined): boolean => why?.cause === ASK_POLICY_CAUSE;

/** The `AskWhy.cause` of a read of an origin an `allow` row let the run navigate to, and no more (POLICIES.md, ruling (b)). */
export const NAV_ONLY_CAUSE = "nav-only";

/**
 * Why a read of an origin consented for navigation only asks (POLICIES.md, "Ruled 2026-10-27"): the card's line is the
 * ruled public string, with the origin's host substituted.
 * @param origin the origin the run may go to but not read
 */
export function navOnlyWhy(origin: string): AskWhy {
    const host = hostOf(origin);
    return { line: `Your policy lets the run go to ${host}. Reading pages there is a separate permission: allow this read, or add a read rule to the policy.`,
        detail: `This call needed approval because a policy lets the run navigate to ${host} but not read it; reading there is a separate permission.`,
        cause: NAV_ONLY_CAUSE };
}

/** The `AskWhy.cause` of an uncredentialed read of the run's start origin once its tab has left (POLICIES.md, "Ruled 2026-10-27"). */
export const START_LEFT_CAUSE = "start-left";

/**
 * Why an uncredentialed read of the origin the run started on asks once the tab has left it: the ruled public string,
 * with the origin's host substituted.
 * @param origin the run's start origin
 */
export function startLeftWhy(origin: string): AskWhy {
    const host = hostOf(origin);
    return { line: `The run started on ${host}. Reading pages there once the tab has left is a separate permission: allow this read, or add a read rule to the policy.`,
        detail: `This call needed approval because the run started on ${host} but its tab has left; reading there is a separate permission.`,
        cause: START_LEFT_CAUSE };
}

/** An origin's host for a card line, or the origin as given when it does not parse. */
function hostOf(origin: string): string {
    try { return new URL(origin).host; } catch { return origin; }
}

/**
 * Why a judged call asks, as text for the card and the model: the `ask` policy that matched it, or the gone policy that
 * used to allow it. Undefined when neither applies (an unloaded store, or no policy involved). Text only: it never
 * changes the decision.
 * @param j the judgement
 */
export function askWhyOf(j: PolicyJudgement): AskWhy | undefined {
    if (j.decision === "ask" && j.by && j.by !== "builtin")
        return { line: `Asking because the policy "${speakable(j.by.label)}" asks about calls like this.`,
            detail: `This call needed approval because the policy "${speakable(j.by.label)}" asks the person about calls like it; the call itself did not change.`,
            cause: ASK_POLICY_CAUSE, policy: speakable(j.by.label) };
    return j.lapsed ? { line: lapsedLine(j.lapsed), detail: lapsedSentence(j.lapsed), cause: j.lapsed.cause, policy: j.lapsed.label } : undefined;
}

/**
 * The grants a card may offer to remember, less the URLs an `ask` policy matches: remembering one makes an `allow` the `ask`
 * overrides, so offering it would promise a free pass the next call does not get. The card says which policy that is.
 * @param runId the run
 * @param grants what the call's arguments would have the person remember
 * @returns the grants still offered (a grant left with no URL is dropped), and why any URL was left out
 */
export function withoutAsked(runId: string, grants: PersistGrant[]): { grants: PersistGrant[]; why?: AskWhy } {
    let why: AskWhy | undefined;
    const kept: PersistGrant[] = [];
    for (const g of grants) {
        if (g.kind !== "fetch-url") { kept.push(g); continue; }
        const urls = g.urls.filter((u) => {
            // A grant carries no options, so an `ask` about a rendered fetch counts as well as one about a plain fetch.
            const w = [false, true].map((rendered) => judgeCall(runId, "fetch", fetchFacts(u, { credentials: false, rendered })))
                .map((j) => (j.decision === "ask" ? askWhyOf(j) : undefined)).find(Boolean);
            if (w) why ??= w;
            return !w;
        });
        if (urls.length) kept.push({ ...g, urls });
    }
    return { grants: kept, ...(why ? { why } : {}) };
}

/** The same, short, for the approval card's line. */
export function lapsedLine(l: LapsedAsk): string {
    return `Asking because the policy "${speakable(l.label)}" ${CAUSE_TEXT[l.cause]}.`;
}

/** The facts a `fetch_url` call gives a policy: what it fetches, how, and its effects. A `navigate`, and a page the run's
 *  tab arrives on, is the same read in its interactive mode (`interactive: true`, always credentialed and rendered). */
export function fetchFacts(url: string, opts: { credentials?: boolean; rendered?: boolean; interactive?: boolean } = {}): Record<string, unknown> & { effects: EffectsData } {
    let host = "";
    try { host = new URL(url).hostname.toLowerCase(); } catch { /* no host: the effects say unknown */ }
    return { kind: "fetch", url, host, method: "GET", credentials: !!opts.credentials, rendered: !!opts.rendered, interactive: !!opts.interactive, effects: fromFetch({ url }) };
}

/** The facts of a navigation to `url`, the run's own `navigate` or a page its tab arrived on: a fetch as you, rendered,
 *  that the run then acts in (docs/spec/POLICIES.md, "Navigate is a fetch"). */
export const navigateFacts = (url: string): ReturnType<typeof fetchFacts> => fetchFacts(url, { credentials: true, rendered: true, interactive: true });

/** The policy that allows exactly one URL a person saw on a card, as code (`JSON.stringify` makes the literal). */
export function fetchUrlPolicySource(url: string): string {
    return `(c) => c.kind === "fetch" && c.url === ${JSON.stringify(url)}`;
}

/** "Approve + remember these URLs": one run policy per URL the person saw, never the page's word for it. */
export function rememberFetchUrls(runId: string, urls: readonly string[]): StoredPolicy[] {
    return urls.map((url) => addRunPolicy(runId, { consumer: "fetch", effect: "allow", source: fetchUrlPolicySource(url), label: speakable(`fetch ${url}`), origin: "card" }));
}

/** The snapshot with the policies that apply to the run added, on a copy, when there are any, and what an archive took
 *  from it when it lost some. */
export function withPolicies<T extends object>(current: T, runId: string): T & { policies?: ReturnType<typeof policiesForModel>; policiesRemoved?: { at: string; labels: string[] } } {
    const policies = policiesForModel(runId);
    const lost = archivedLoss.get(runId);
    return {
        ...current,
        ...(policies.length ? { policies } : {}),
        ...(lost ? { policiesRemoved: { at: new Date(lost.at).toISOString(), labels: [...lost.labels] } } : {}),
    };
}

/** A run's policies as the model reads them (`ml.current.policies`): what each allows or refuses, as written. */
export function policiesForModel(runId: string): { scope: StoredPolicy["scope"]; effect: PolicyEffect; label: string; source: string }[] {
    return [...globals, ...(byRun.get(runId) ?? [])].map((p) => ({ scope: p.scope, effect: p.effect, label: p.label, source: p.source }));
}
