// cell-gate.ts — what a Python cell handed to JavaScript, revoked when the cell's result is about to return.

// A cell can schedule Python past asyncio, where the cancel's task and Handle sweep never sees it: a callable it
// hands to a JS registry the lockdown keeps (`setTimeout`, `queueMicrotask`, `Promise.then`, Pyodide's own
// `scheduleCallback`) fires after the result (docs/plan/repl/PYTHON_CANCEL_GAPS.md, gap 1). Every way a Python
// callable becomes something JavaScript can call later is one of three Pyodide doors, so the gate sits on those
// doors, never on the registries:
//
// - a PyProxy: every one is made by `Module.pyproxy_new`. Revoked by pointing the proxy at an inert callable, so
//   every trap (call, get, has) runs no Python of the cell's.
// - a once-callable (`create_once_callable`, which `webloop.call_later` uses too): made inside the core, but each
//   one registers with `Module.finalizationRegistry` and calls through `Module.callPyObject[MaybePromising]`.
//   Revoked by blocking its object's pointer there, with a reference held so the pointer cannot be reused.
// - a promise handle (`.then`/`.catch`/`.finally_` of a JS promise with a Python callable): made inside the core,
//   no registration, and its success path calls the core directly. It reaches JavaScript only through
//   `Promise.prototype.then`/`finally`, which are wrapped (before `lockdown()` freezes them) while a cell is open.
//
// `destroy()` is NOT the revocation: a destroyed proxy THROWS when the registry fires it, and a throw in the worker
// kills it (offscreen.ts `w.onerror`), after every cell that cancelled a `call_later`. A revoked callable that fires
// is a silent no-op, counted (`cellDropped()`, which the worker reports to the run log). A cell that hands the SAME object
// to a registry again while an earlier cell's revoked wrapper of it lives is refused at once, in that cell.
//
// The window: the wrapper calls `begin()` as the script starts (idempotent) and `revoke()` in its cancel and again
// at its end; `revoke()` covers everything made since `begin()`, so a cell that calls either itself only revokes
// its own work early. Only the JS side (`cellBoundary`, between cells) closes the window: Python cannot.

/** The gate's two Python-facing calls, and the JS side's boundary. */
export type CellGate = {
    /** Open the window for the cell about to run; a no-op while one is open. */
    begin(): void;
    /** Revoke everything the open window recorded that is not revoked yet; the window stays open. */
    revoke(): void;
    /** Close the window, between cells (JS only). */
    boundary(): void;
    /** How many revoked callables fired (and did nothing) since the last call; zeroes the count. */
    takeDropped(): number;
    /** The cell's cancel started spending its tasks: tell the host (`onSpending`), so a kill that lands now is named. */
    spending(): void;
};

/** The Pyodide internals the gate hooks; the gate refuses to install without every one (a Pyodide upgrade must say so). */
export const GATE_INTERNALS = ["pyproxy_new", "finalizationRegistry", "callPyObject", "callPyObjectMaybePromising", "PyProxy_getAttrsQuiet", "_Py_IncRef", "_Py_DecRef"] as const;

/** Why a later cell's schedule is refused, as the cell sees it. */
export const REFUSED_RESCHEDULE = "refused: an earlier cell scheduled this same callable for JavaScript to call after its result; that call was revoked and is still pending, so this cell cannot hand the object to JavaScript again";

let current: CellGate | null = null;   // state: plumbing — the realm's gate; one interpreter per realm (per-principal workers)
let spendingHook: (() => void) | null = null;   // state: plumbing — the worker's post for the spend's mark, set once at boot

/**
 * Who hears that a cell's cancel started spending its tasks (`CellGate.spending`): the worker, which tells the offscreen
 * document, so a kill during the spend says a leftover task would not stop rather than blaming the cell's computation.
 * @param fn the hook, or null to clear it
 */
export function onSpending(fn: (() => void) | null): void {
    spendingHook = fn;
}

/**
 * Close the realm's cell window, between cells. Called by `injectInputs` and the worker before every run: a window
 * left open would let the next cell's revoke reach the runner's own proxies, made before its script started.
 */
export function cellBoundary(): void {
    current?.boundary();
}

/**
 * How many callables a cell handed to JavaScript fired after the cell revoked them, since the last call. They ran
 * nothing; the count is what says they were there.
 *
 * @returns the count, then zero (0 with no gate)
 */
export function cellDropped(): number {
    return current ? current.takeDropped() : 0;
}

/** A record of one thing the open window saw cross to JavaScript. */
type Item =
    | { kind: "proxy"; ref: WeakRef<object>; done?: boolean }
    | { kind: "once"; ref: WeakRef<object>; ptr: number; done?: boolean }
    | { kind: "handle"; f: any; revoked: boolean; done?: boolean };

/**
 * Hook Pyodide's three doors on `py` and return the gate. Must run BEFORE `lockdown()`: it wraps
 * `Promise.prototype.then`/`finally`, which `lockdown()` freezes. Every hook is defined non-writable and
 * non-configurable, since a cell can reach `Module` (`pyodide_js._module`).
 *
 * @param py the booted Pyodide interpreter
 * @returns the gate; also the realm's `current`, which `cellBoundary` closes
 */
export function installCellGate(py: any): CellGate {
    if (current) throw new Error("cell gate: already installed in this realm (one interpreter per realm)");
    const M = py._module;
    const missing = GATE_INTERNALS.filter((k) => M?.[k] === undefined);
    if (missing.length) throw new Error(`cell gate: this Pyodide lacks ${missing.join(", ")}`);
    if (Object.isFrozen(Promise.prototype)) throw new Error("cell gate: Promise.prototype is already frozen (install before lockdown())");

    const items: Item[] = [];
    let open = false;
    let dropped = 0;
    // A revoked once-callable's object pointer → the revoked wrappers of it still alive. The gate holds one
    // reference per pointer while it is here, so the pointer is never reused by another object.
    const blocked = new Map<number, WeakRef<object>[]>();
    const consumed = new WeakSet<object>();
    const inert = py.runPython("def _ml_inert(*_a, **_k):\n    return None\n_ml_inert");
    const inertPtr: number = M.PyProxy_getAttrsQuiet(inert).shared.ptr;
    const isPyProxy = (f: unknown) => { try { return f instanceof py.ffi.PyProxy; } catch { return false; } };

    const isBlocked = (ptr: number): boolean => {
        const refs = blocked.get(ptr);
        if (!refs) return false;
        return refs.some((r) => { const w = r.deref(); return w !== undefined && !consumed.has(w); });
    };
    // Drop the pointers no live revoked wrapper holds any more. Between cells only: a decref may run Python.
    const prune = () => {
        for (const [ptr, refs] of blocked) {
            if (!isBlocked(ptr)) { blocked.delete(ptr); M._Py_DecRef(ptr); continue; }
            blocked.set(ptr, refs.filter((r) => r.deref() !== undefined));
        }
    };
    const fix = (obj: any, name: string, value: unknown) =>
        Object.defineProperty(obj, name, { value, writable: false, configurable: false, enumerable: true });

    // Door 1: every PyProxy.
    const pyproxyNew = M.pyproxy_new;
    fix(M, "pyproxy_new", function (this: unknown, ptr: number, ...rest: unknown[]) {
        if (open && isBlocked(ptr)) throw new Error(REFUSED_RESCHEDULE);
        const p = pyproxyNew.call(this, ptr, ...rest);
        if (open) items.push({ kind: "proxy", ref: new WeakRef(p) });
        return p;
    });
    // Door 2: every once-callable registers its wrapper here, with the object's pointer as the held value.
    const registry = M.finalizationRegistry;
    const register = registry.register.bind(registry);
    fix(registry, "register", (target: any, held: any, token?: unknown) => {
        if (open && typeof target === "function" && typeof target.destroy === "function" && typeof held?.ptr === "number") {
            if (isBlocked(held.ptr)) throw new Error(REFUSED_RESCHEDULE);
            // The wrapper calls its own `destroy` once it has run: that is how a revoked one is known to be spent.
            const destroy = target.destroy;
            target.destroy = function (this: unknown, ...a: unknown[]) { consumed.add(target); return destroy.apply(this, a); };
            items.push({ kind: "once", ref: new WeakRef(target), ptr: held.ptr });
        }
        return register(target, held, token);
    });
    fix(M, "finalizationRegistry", registry);
    for (const name of ["callPyObject", "callPyObjectMaybePromising"] as const) {
        const call = M[name];
        const quiet = name === "callPyObject" ? undefined : Promise.resolve(undefined);
        fix(M, name, function (this: unknown, ptr: number, args: unknown[]) {
            if (ptr === inertPtr || isBlocked(ptr)) { dropped++; return quiet; }
            return call.call(this, ptr, args);
        });
    }
    // Door 3: a promise handle (or any Python-backed function: they all carry `destroy`) given to a promise.
    const guard = (f: any) => {
        if (!open || typeof f !== "function" || typeof f.destroy !== "function") return f;
        const item: Item = { kind: "handle", f, revoked: false };
        items.push(item);
        return function (this: unknown, ...a: unknown[]) {
            if (item.revoked) { dropped++; return undefined; }
            return f.apply(this, a);
        };
    };
    const then = Promise.prototype.then;
    const fin = Promise.prototype.finally;
    fix(Promise.prototype, "then", function then_(this: Promise<unknown>, a?: any, b?: any) { return then.call(this, guard(a), guard(b)); });
    fix(Promise.prototype, "finally", function finally_(this: Promise<unknown>, f?: any) { return fin.call(this, guard(f)); });

    const gate: CellGate = {
        begin() {
            if (open) return;
            items.length = 0;
            open = true;
        },
        revoke() {
            if (!open) return;
            for (const it of items) {
                if (it.done) continue;
                it.done = true;
                if (it.kind === "proxy") {
                    const p = it.ref.deref();
                    if (!p) continue;
                    const shared = M.PyProxy_getAttrsQuiet(p).shared;
                    if (!shared.ptr || shared.ptr === inertPtr) continue;   // destroyed (a borrowed proxy), or done
                    // Point it at the inert callable. Its finalizer would release the OLD pointer, so release that
                    // here and unregister; a later destroy() releases the inert one, so take a reference for it.
                    if (shared.gcRegistered) { registry.unregister(shared); shared.gcRegistered = false; }
                    const old = shared.ptr;
                    shared.ptr = inertPtr;
                    M._Py_IncRef(inertPtr);
                    M._Py_DecRef(old);
                } else if (it.kind === "once") {
                    const w = it.ref.deref();
                    if (!w || consumed.has(w)) continue;
                    if (!blocked.has(it.ptr)) { blocked.set(it.ptr, []); M._Py_IncRef(it.ptr); }
                    blocked.get(it.ptr)!.push(new WeakRef(w));
                } else {
                    it.revoked = true;
                    // A promise handle holds its Python callables until it is called; release them now. A
                    // PyProxy's own destroy would throw at its other holders: door 1 swapped it already.
                    if (!isPyProxy(it.f)) { try { it.f.destroy(); } catch { /* spent, or a once-callable: door 2 */ } }
                }
            }
        },
        boundary() {
            open = false;
            items.length = 0;
            prune();
        },
        takeDropped() {
            const n = dropped;
            dropped = 0;
            return n;
        },
        spending() {
            try { spendingHook?.(); } catch { /* a log, never worth failing the cancel over */ }
        },
    };
    current = gate;
    return gate;
}
