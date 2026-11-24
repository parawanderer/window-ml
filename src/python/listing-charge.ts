// listing-charge.ts — charge a directory listing to the cell running inside the dialect, before the listing is built
// (rulings 105/106: a lifted leaf's C work is paid for before it runs).

// Every listing a cell makes reaches one of two readdirs, whoever calls it: os.listdir and os.scandir directly, and
// glob, os.walk, Path.iterdir and rglob from inside a lifted call the gate never sees again. So the charge sits there,
// in the file system, not on the Python calls. os.listdir releases the GIL around its readdir, so the hook cannot call
// Python; it re-attaches the thread state and calls the fork's C charge itself. Outside a run that charge is nothing.

/** What the hooks need from the Pyodide module: the thread-state calls and the fork's exported charge. */
interface ChargeModule {
    _PyThreadState_GetUnchecked(): number;
    _PyGILState_GetThisThreadState(): number;
    _PyEval_RestoreThread(ts: number): void;
    _PyEval_SaveThread(): number;
    _PyErr_Clear(): void;
    __PyRestricted_Charge?(ts: number, n: bigint): number;
}

/**
 * The charge a listing hook calls: spend `steps` of the running cell's budget, or report that it cannot.
 * @param mod Pyodide's module (`pyodide._module`)
 * @returns charge(steps), true when paid or when no cell is running; null on a core without the fork's charge
 */
export function restrictedCharge(mod: ChargeModule): ((steps: number) => boolean) | null {
    const charge = mod.__PyRestricted_Charge;
    if (typeof charge !== "function") return null;
    return (steps) => {
        const held = mod._PyThreadState_GetUnchecked();
        const ts = held || mod._PyGILState_GetThisThreadState();
        if (!held) mod._PyEval_RestoreThread(ts);
        try {
            if (charge.call(mod, ts, BigInt(steps)) >= 0) return true;
            // The run is tripped (it refuses however it ends), so the exception is not needed to carry it, and a
            // posix call that fails with one already set raises SystemError instead of its OSError.
            mod._PyErr_Clear();
            return false;
        } finally { if (!held) mod._PyEval_SaveThread(); }
    };
}

/**
 * Charge every MEMFS directory listing `steps(names)` steps, before it is built. MEMFS directories share one ops
 * table, so the hook covers every directory, made before or after. A listing the budget cannot pay fails with EIO.
 * @param FS Emscripten's FS
 * @param errno Emscripten's errno table
 * @param charge from {@link restrictedCharge}
 * @param steps the steps a listing of so many names costs (`listingSteps`)
 */
export function chargeMemfsListings(FS: any, errno: Record<string, number>, charge: (steps: number) => boolean, steps: (names: number) => number): void {
    const ops = FS.filesystems.MEMFS.ops_table.dir.node;
    const real = ops.readdir;
    ops.readdir = function (node: any) {
        if (!charge(steps(Object.keys(node.contents).length))) throw new FS.ErrnoError(errno.EIO);
        return real.call(this, node);
    };
}
