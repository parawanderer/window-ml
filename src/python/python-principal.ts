// python-principal.ts — one Python interpreter per PRINCIPAL, never shared: a principal change is a new interpreter.
// The interpreter-level rule behind PYODIDE_LOCKDOWN.md step 1 ("one worker per PRINCIPAL, respawned on principal
// change"), in chrome-free form so the vectors can assert it and the worker host can apply the same rule to workers.

// A PRINCIPAL is who the run is for: a worker-hosted run, a page, `full`. The old model had one interpreter for
// every principal, with `harden()`/`unharden()` swapping a deny list between runs — so a patch one principal left
// in module state (a monkeypatched `json.loads`, a `builtins.__import__` hook) was still there for the next, and
// module state survives the per-run RESET (which only clears non-underscore NAMESPACE names). The defence is the
// split: each principal gets its own interpreter, and a principal change is a new one. This module is that rule's
// store — a Map from principal to its interpreter, created on demand and never reused across principals. The
// worker host applies the same rule one level up (one Worker per principal); the vectors call this.

/**
 * The interpreter `principal`'s runs use: created on demand by `spawn`, cached for that principal only, and never
 * handed to a different one. `spawn` builds an interpreter (load Pyodide, load the packages, `lockdownReadonly`).
 *
 * @param principal who the run is for — a worker-hosted run, a page, `full`
 * @param spawn builds a fresh interpreter the first time this principal is seen
 */
export function interpreterForPrincipal(principal: string, spawn: () => Promise<any>): Promise<any> {
    let p = byPrincipal.get(principal);
    if (!p) {
        p = spawn();
        byPrincipal.set(principal, p);
        // A failed spawn must not poison the cache: drop it so a later run retries.
        p.catch(() => { if (byPrincipal.get(principal) === p) byPrincipal.delete(principal); });
    }
    return p;
}

/**
 * Drop one principal's interpreter (its worker is going away), so a later run of the same principal gets a fresh
 * one. The housekeeping record the worker host writes on respawn reads the loss this way: the kept namespace is
 * gone with the interpreter.
 */
export function dropPrincipal(principal: string): void {
    byPrincipal.delete(principal);
}

/** Principals seen this worker-host lifetime. `// state: plumbing` — a run's own state is the interpreter's. */
const byPrincipal = new Map<string, Promise<any>>();   // state: plumbing — one interpreter per principal
