// python-dialect.ts — whether a python_exec cell is INSIDE the read-only Python dialect, the one question that replaced `mode`.

/**
 * Whether a python_exec cell is inside the read-only Python dialect (docs/spec/PYTHON_DIALECT.md, "Membership replaces
 * `mode`"): inside runs with no card and the read-only slice of `ml`; outside goes to the person and runs as full Python
 * with the gated `ml` callback, in the same hardened worker. FALSE FOR EVERY CELL until the Pyodide build of the
 * restricted CPython carries a membership predicate (lane 5): a cell not known to be inside asks, so removing `mode`
 * never lets a cell that asked yesterday run unasked today. The predicate plugs in HERE and nowhere else.
 * @param code the cell's source
 * @returns true when the cell is inside the dialect
 */
export function pythonCellInDialect(code: string): boolean {
    return membership(code);
}

// state: test — the verdict, replaceable so the inside-the-dialect paths stay testable while no real predicate exists
let membership: (code: string) => boolean = () => false;

/**
 * Test seam: stand in for the membership predicate, or restore the real one with null. Used only by tests, so the paths
 * that need an INSIDE verdict (auto-approve, the read-only `ml` slice) are covered before the real predicate ships.
 * @param fn the stand-in verdict, or null for the real one
 */
export function setPythonDialectForTest(fn: ((code: string) => boolean) | null): void {
    membership = fn ?? (() => false);
}

/**
 * The reason a cell is outside the dialect, for the approval card; null when it is inside.
 * @param code the cell's source
 * @returns the verdict's reason, or null
 */
export function pythonDialectVerdict(code: string): string | null {
    return pythonCellInDialect(code) ? null : "Python dialect membership is not available yet, so every cell is treated as outside it";
}
