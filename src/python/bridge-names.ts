// bridge-names.ts — the modules a Python cell may not import unless its approval card said so, the line that says so, and
// whether a cell's code names one. Shared by the approval card, the worker that lifts the refusal, and the gate itself.

/** The line an approval card shows for a cell that names a bridge (approved by Shane, 2026-10-27). */
export const JS_BRIDGE_LINE = "This code reaches the browser's JavaScript from Python (`js`, `pyodide.ffi`). Approve only if you expected that.";

/** A cell's code naming a bridge: an import of `js`, a refused module, or `run_js` (which imports `js` when called). */
const NAMES_BRIDGE = /\bimport\s+(?:[\w.]+(?:\s+as\s+\w+)?\s*,\s*)*js\b|\bfrom\s+js\b[\w.]*\s+import\b|\bpyodide\.(?:ffi|webloop|code|_package_loader)\b|\bfrom\s+pyodide\s+import\s+[^\n]*\b(?:ffi|webloop|code)\b|\b_pyodide(?:_core|\._importhook|\._core_docs)?\b|\brun_js\b/;

/**
 * Whether a cell's code names one of the bridges, so its approval card shows `JS_BRIDGE_LINE` and, approved by a person,
 * it runs with the refusal lifted. Read from the text: a name the code builds at run time (`__import__("j" + "s")`) is not
 * seen, so that cell gets no line and stays refused.
 *
 * @param code the cell's source
 * @returns true when the code names a bridge
 */
export function namesJsBridge(code: string): boolean {
    return NAMES_BRIDGE.test(code);
}

/**
 * The modules a cell may not import in the readonly worker: the one that reaches the browser's JavaScript (`js`), and
 * every module that holds `pyodide.ffi`'s functions (`create_proxy`, `create_once_callable`, `run_sync`, `to_js`,
 * `register_js_module`), measured on the pinned core, so `import _pyodide_core` is not a way around `pyodide.ffi`.
 * Ruled 2026-10-27 (PYODIDE_LOCKDOWN.md step 2): refused by the CALLER, so packages that use them keep working.
 */
export const REFUSED_BRIDGES: readonly string[] = Object.freeze([
    "js", "pyodide.ffi", "pyodide.ffi.wrappers", "pyodide.webloop",
    "_pyodide_core", "_pyodide._importhook", "_pyodide._core_docs", "pyodide._package_loader",
]);
