// policy-valid.ts — what makes a stored policy well-formed, and where the global ones are kept, shared by the worker's read of storage and a backup's restore.

import type { PolicyConsumer, StoredPolicy } from "./sw-policies";

/** The storage key of the global policies. */
export const GLOBAL_POLICIES_KEY = "ml_policies_global";

/** Every consumer, for checking what storage held. */
export const CONSUMERS: ReadonlySet<string> = new Set<PolicyConsumer>(["fetch", "sh"]);

/** Keep only well-formed policies of a scope from what storage held; anything else is dropped, never guessed at. */
export function validList(v: unknown, scope: StoredPolicy["scope"]): StoredPolicy[] {
    if (!Array.isArray(v)) return [];
    return v.filter((p): p is StoredPolicy => !!p && typeof p === "object"
        && typeof p.id === "string" && typeof p.source === "string" && typeof p.label === "string"
        && (p.effect === "allow" || p.effect === "deny" || p.effect === "ask") && CONSUMERS.has(p.consumer) && p.scope === scope);
}
