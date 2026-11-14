// pkg-install-test.ts — the cell python_install's candidate worker runs: each new distribution's top-level modules imported in turn, stopping at the first that fails, as JSON.

// docs/plan/repl/PACKAGES_INSTALL.md, slice 4, item 2. Run as a hardened cell (offscreen.ts `installTest`), so a package's
// import-time code runs locked down, like any cell's. It catches BaseException, since a module may exit at import.

/** The candidate's cell: refuse a module the standard library already names (the wheel's would be shadowed, never
 *  imported), then import each, stop at the first failure, and say which module a missing one was. */
export function importTestCode(modules: string[]): string {
    return `import importlib, json, sys
_r = None
for _m in ${JSON.stringify(modules)}:
    if _m in sys.stdlib_module_names:
        _r = {"module": _m, "collision": True, "error": f"{_m} is a standard-library module"}
        break
    try:
        importlib.import_module(_m)
    except ModuleNotFoundError as _e:
        _r = {"module": _m, "missing": _e.name, "error": f"{type(_e).__name__}: {_e}"}
        break
    except BaseException as _e:
        _r = {"module": _m, "error": f"{type(_e).__name__}: {_e}"}
        break
json.dumps(_r)`;
}
