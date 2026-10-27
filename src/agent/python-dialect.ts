// python-dialect.ts — whether a python_exec cell is INSIDE the read-only Python dialect, the one question that replaced `mode`.

/**
 * Whether a python_exec cell may be treated as inside the read-only Python dialect without running it (docs/spec/
 * PYTHON_DIALECT.md, "Membership replaces `mode`"). FALSE FOR EVERY CELL, by design: membership is decided by the
 * fork's gate AS THE CELL RUNS (`restricted.run_cell`), never by its source alone, since `check()` admits an `import`
 * or a call that only the gate refuses. So a cell runs unasked only through the host's inside try (`tryPythonInside`,
 * sw-run-host.ts), and every path that has not run it treats it as outside: it asks and runs as full Python with the
 * gated `ml`, in the same hardened worker.
 * @param code the cell's source
 * @returns true when the cell is inside the dialect
 */
export function pythonCellInDialect(code: string): boolean {
    return membership(code);
}

// state: test — the verdict, replaceable so the inside-the-dialect paths stay testable; the real one answers false
let membership: (code: string) => boolean = () => false;

/**
 * Test seam: stand in for the membership verdict, or restore the real one with null. Used only by tests, so the paths
 * that read an INSIDE verdict (a grant's prefix, the read-only `ml` slice) stay covered.
 * @param fn the stand-in verdict, or null for the real one
 */
export function setPythonDialectForTest(fn: ((code: string) => boolean) | null): void {
    membership = fn ?? (() => false);
}

/**
 * Why a python_exec cell asks, for the approval card and the model: where the inside try left the dialect (the fork's
 * refusal, naming the module, call, attribute or node, and the line when it knows it), or why it was not tried. A
 * cell with no recorded reason (an edited cell, or one the try never saw) is outside all the same.
 * @param where the fork's refusal or the reason the cell was not tried, if any
 * @param bridged an earlier cell of the run ran with the JavaScript bridges lifted (`AskWhy.bridged`)
 * @returns the why-asks line and the sentence the model reads with the result
 */
export function pythonOutsideWhy(where: string | undefined, bridged = false): import("../contract").AskWhy {
    const at = (where ?? "").replace(/^not in dialect:\s*/, "").trim();
    return {
        line: at ? `Outside the read-only Python dialect: ${at}` : "Outside the read-only Python dialect",
        detail: `This cell asked because it is outside the read-only Python dialect${at ? ` (${at})` : ""}. A cell inside it runs without asking.`,
        cause: "outside-dialect",
        ...(bridged ? { bridged: true as const } : {}),
    };
}
