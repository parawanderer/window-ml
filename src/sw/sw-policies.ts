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

/** Which kind of call a policy is about; a policy is only ever evaluated over calls of its own consumer. `sh` is
 *  `ml.sh` (docs/spec/SHELL.md), whose facts its own consumer builds. */
export type PolicyConsumer = "fetch" | "sh";

/** Every consumer, for checking what storage held. */
const CONSUMERS: ReadonlySet<string> = new Set<PolicyConsumer>(["fetch", "sh"]);

/** Where a policy came from: written by the person, or added by answering an approval card. */
export type PolicyOrigin = "person" | "card";

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
}

/** What judging one call decided: the answer, the policy that gave it, and every policy that broke on the way.
 *  `"ask"` means the saved policies are not read yet: nothing below a policy may answer for the person either. */
export interface PolicyJudgement {
    decision: PolicyEffect | "ask" | undefined;
    /** The policy that decided, or `"builtin"` for the built-in default (the effect algebra's free tier). */
    by?: StoredPolicy | "builtin";
    broken: { policy: StoredPolicy; reason: string }[];
}

/** The storage key of the global policies. */
export const GLOBAL_POLICIES_KEY = "ml_policies_global";
/** The storage key of every session's run policies, by session hash. */
export const RUN_POLICIES_KEY = "ml_policies_run";
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

/** Why each policy last broke, by id: shown against it on the policy page. */
const brokenWhy = new Map<string, string>();   // state: cache — recomputed on the next evaluation

/** Whether storage has been read. Until it has, a `deny` the person saved is not known yet, so a consumer must ASK
 *  rather than let a free tier answer (`fetchPolicy` in sw-run-host.ts). */
let loaded = false;   // state: plumbing — set once per worker by the read below

/** Whether every saved policy is known. */
export const policiesLoaded = (): boolean => loaded;

/** Storage has been read, so a judgement made now sees every saved policy. Until then a call asks (fails closed). */
export const policiesReady: Promise<void> = (() => {
    try {
        return chrome.storage.local.get([GLOBAL_POLICIES_KEY, RUN_POLICIES_KEY]).finally(() => { loaded = true; }).then((got) => {
            globals.splice(0, globals.length, ...validList(got?.[GLOBAL_POLICIES_KEY], "global"));
            const runs = (got?.[RUN_POLICIES_KEY] ?? {}) as Record<string, unknown>;
            for (const [hash, list] of Object.entries(runs)) if (!byRun.has(hash)) byRun.set(hash, validList(list, "run"));
        }).catch(() => { /* storage unavailable: nothing saved is honoured, so every call asks */ });
    } catch { loaded = true; return Promise.resolve(); }   // no storage (a test harness): nothing saved to wait for
})();

/** Keep only well-formed policies of a scope from what storage held; anything else is dropped, never guessed at. */
function validList(v: unknown, scope: StoredPolicy["scope"]): StoredPolicy[] {
    if (!Array.isArray(v)) return [];
    return v.filter((p): p is StoredPolicy => !!p && typeof p === "object"
        && typeof p.id === "string" && typeof p.source === "string" && typeof p.label === "string"
        && (p.effect === "allow" || p.effect === "deny") && CONSUMERS.has(p.consumer) && p.scope === scope);
}

function saveGlobals(): void {
    try { void chrome.storage.local.set({ [GLOBAL_POLICIES_KEY]: globals }).catch(() => {}); } catch { /* storage unavailable */ }
}
function saveRuns(): void {
    while (byRun.size > RUN_POLICY_SESSIONS_MAX) byRun.delete(byRun.keys().next().value!);
    try { void chrome.storage.local.set({ [RUN_POLICIES_KEY]: Object.fromEntries(byRun) }).catch(() => {}); } catch { /* storage unavailable */ }
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
export function addRunPolicy(runId: string, p: Pick<StoredPolicy, "consumer" | "effect" | "source" | "label" | "origin">): StoredPolicy {
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
    if (g >= 0) { globals.splice(g, 1); saveGlobals(); return true; }
    for (const [hash, list] of byRun) {
        const i = list.findIndex((p) => p.id === id);
        if (i < 0) continue;
        const rest = list.filter((_, k) => k !== i);
        if (rest.length) byRun.set(hash, rest); else byRun.delete(hash);
        saveRuns();
        return true;
    }
    return false;
}

/** Forget a session's run policies: the session was deleted, archived or evicted (POLICIES.md, "Scopes": removed when
 *  the session is archived, so an archived session that comes back has none). */
export function forgetRunPolicies(runId: string): void {
    const list = byRun.get(runId);
    if (!list) return;
    for (const p of list) brokenWhy.delete(p.id);
    byRun.delete(runId);
    saveRuns();
}

/**
 * Judge one call against the global policies and the run's. `deny` wins over `allow` across both scopes; a policy that
 * breaks is no opinion (and recorded); with no person's answer, the built-in default allows a call whose effects are
 * inside what its placement bounds (`free`, effects.ts) and otherwise the tiers above decide (`undefined`).
 *
 * Two rules every consumer keeps (docs/spec/POLICIES.md, "A change takes effect at once"):
 * - **A store not yet loaded means ASK, free tiers included.** Until the saved policies are read after a worker wake
 *   this returns `"ask"`, and the consumer must put the call to the person without letting any free tier of its own
 *   answer: an unloaded `deny` is an unenforced one. This function carries the rule so a consumer cannot forget it.
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
    let allow: StoredPolicy | undefined;
    for (const p of all) {
        const r = evalPolicy(p.source, facts, p.effect);
        if (r.broken) { brokenWhy.set(p.id, r.broken); broken.push({ policy: { ...p }, reason: r.broken }); continue; }
        brokenWhy.delete(p.id);
        if (r.decision === "deny") return { decision: "deny", by: { ...p }, broken };
        if (r.decision === "allow" && !allow) allow = p;
    }
    if (allow) return { decision: "allow", by: { ...allow }, broken };
    if (free(facts.effects, boundFor(placement))) return { decision: "allow", by: "builtin", broken };
    return { decision: undefined, broken };
}

/** The facts a `fetch_url` call gives a policy: what it fetches, how, and its effects. */
export function fetchFacts(url: string, opts: { credentials?: boolean; rendered?: boolean } = {}): Record<string, unknown> & { effects: EffectsData } {
    let host = "";
    try { host = new URL(url).hostname.toLowerCase(); } catch { /* no host: the effects say unknown */ }
    return { kind: "fetch", url, host, method: "GET", credentials: !!opts.credentials, rendered: !!opts.rendered, effects: fromFetch({ url }) };
}

/** The policy that allows exactly one URL a person saw on a card, as code (`JSON.stringify` makes the literal). */
export function fetchUrlPolicySource(url: string): string {
    return `(c) => c.kind === "fetch" && c.url === ${JSON.stringify(url)}`;
}

/** "Approve + remember these URLs": one run policy per URL the person saw, never the page's word for it. */
export function rememberFetchUrls(runId: string, urls: readonly string[]): StoredPolicy[] {
    return urls.map((url) => addRunPolicy(runId, { consumer: "fetch", effect: "allow", source: fetchUrlPolicySource(url), label: `fetch ${url}`, origin: "card" }));
}

/** The snapshot with the policies that apply to the run added, on a copy, when there are any. */
export function withPolicies<T extends object>(current: T, runId: string): T & { policies?: ReturnType<typeof policiesForModel> } {
    const policies = policiesForModel(runId);
    return policies.length ? { ...current, policies } : current;
}

/** A run's policies as the model reads them (`ml.current.policies`): what each allows or refuses, as written. */
export function policiesForModel(runId: string): { scope: StoredPolicy["scope"]; effect: PolicyEffect; label: string; source: string }[] {
    return [...globals, ...(byRun.get(runId) ?? [])].map((p) => ({ scope: p.scope, effect: p.effect, label: p.label, source: p.source }));
}
