// Single source of truth for the python_exec sandbox's third-party packages. Adding one
// entry here updates ALL of: the offscreen loadPackage() call, the prelude's imports, the
// tool description's "in scope" list, AND the offline wheel fetch (scripts/fetch-pyodide-
// wheels.mjs greps the `load:` values) — so a new package is one edit, not several that
// drift. (Pure constants, no imports, so it bundles into both offscreen.js and injected.js
// without pulling anything else in.) `load` is the Pyodide package name; `prelude` is the
// import line executed before user code (empty = load-only, imported lazily elsewhere);
// `label` is what the model sees in the tool description (empty = hidden, e.g. a parser dep).
// `lazy` = the wheel is FETCHED (so it works offline) but not loaded at sandbox start and never offered to
// the model: tooling the bench loads on first use, so a `python_exec` pays nothing for it.
// `prepare` = Python run ONCE when the sandbox starts, after the packages load and UNHARDENED, before any script
// (or the prelude) imports anything — for a package that cannot be imported cold inside a hardened run.
export interface PyPackage { load: string; prelude: string; label: string; lazy?: boolean; prepare?: string; }

/** pyarrow's one-time preparation (see its entry). `import pyarrow` imports `unix_timezones`, which does `import js`
 *  to read the browser's timezone — and a `readonly` run has no `js`, while the prelude's `import pandas` imports
 *  pyarrow. So it is imported here first, where `js` exists; every later import hits the module cache. The `js` it
 *  bound is then DELETED from that module, or `unix_timezones.js` would hand a hardened script the JavaScript
 *  global scope hardening removed (`tests/python.test.mjs` has the escape test). */
const PYARROW_PREPARE = `import pyarrow
import unix_timezones as _ml_utz
_ml_utz.__dict__.pop('js', None)
del _ml_utz`;

export const PY_PACKAGES: PyPackage[] = [
    { load: "numpy", prelude: "import numpy as np", label: "numpy (np)" },
    { load: "pillow", prelude: "from PIL import Image", label: "PIL (Image)" },
    { load: "pandas", prelude: "import pandas as pd", label: "pandas (pd)" },
    // scipy: loaded + advertised, but NOT pre-imported (heavy — the model does
    // `from scipy import ndimage` etc. only when it needs it, e.g. connected-components /
    // blob detection over a screenshot, so a quick coord/table run pays nothing).
    { load: "scipy", prelude: "", label: "scipy (import scipy)" },
    // sympy: loaded + advertised, NOT pre-imported (heavy import). The natural source for a `| latex`
    // citation — `import sympy; sympy.latex(expr)` turns a symbolic result (a solved equation, an exact
    // root, a simplified expression) into a LaTeX string you embed with `![…](@tool:…:out | latex)`.
    { load: "sympy", prelude: "", label: "sympy (symbolic math; `import sympy; sympy.latex(expr)` → a `| latex` string)" },
    // Load-only + hidden: pandas.read_html needs a parser for the `table` DOM→df HTML
    // fallback. bs4 + html5lib are pure-Python (light) vs lxml's heavy WASM C-extension.
    { load: "beautifulsoup4", prelude: "", label: "" },
    { load: "html5lib", prelude: "", label: "" },
    // The bench EDITOR's completion (static analysis of the script being typed, plus a live namespace once
    // one persists). Lazy: loaded the first time someone asks for a completion, never at start-up, and
    // hidden from the model — it is not something a script is meant to import. Pulls in parso via the lock.
    { load: "jedi", prelude: "", label: "", lazy: true },
    // pyarrow: Parquet, Feather and Arrow IPC for pandas, and the columnar format pointer values are stored in
    // (docs/spec/POINTER_VALUES.md). Loaded at START, not on first use, although it is 10 MB and ~1.5 s of cold
    // start: pandas decides whether pyarrow exists when pandas is IMPORTED, and caches it in a dozen modules and
    // in which of its own modules it imported, so pyarrow arriving after the prelude's `import pandas` left pandas
    // half-switched (`to_parquet` failing in `unregister_extension_type`, then `NameError: pa`). The pre-warm
    // absorbs most cold starts. Not pre-imported by the prelude beyond what pandas does itself.
    { load: "pyarrow", prelude: "", label: "pyarrow (pd.read_parquet / to_parquet / read_feather; Arrow IPC via pyarrow.ipc)", prepare: PYARROW_PREPARE },
];

/** Loaded when the sandbox STARTS. Lazy tooling is excluded: see `PY_LAZY_LOADS`. */
export const PY_PACKAGE_LOADS: string[] = PY_PACKAGES.filter(p => !p.lazy).map(p => p.load);
/** Fetched with the rest but loaded on first use — the bench editor's completion engine. */
export const PY_LAZY_LOADS: string[] = PY_PACKAGES.filter(p => p.lazy).map(p => p.load);
/** The start-up packages' `prepare` code, joined: run once, unhardened, right after they load. */
export const PY_STARTUP_PREPARE: string = PY_PACKAGES.filter(p => !p.lazy && p.prepare).map(p => p.prepare).join("\n");

export const PY_PRELUDE_IMPORTS: string = PY_PACKAGES.filter(p => p.prelude).map(p => p.prelude).join("\n");
export const PY_PACKAGE_LABELS: string = PY_PACKAGES.filter(p => p.label).map(p => p.label).join(", ");

// The variable a prelude import line binds ("import numpy as np" → np; "from PIL import Image"
// → Image; "import pandas as pd" → pd), or null for a load-only ("") package.
const preludeBinding = (line: string): string | null => {
    const m = /\bimport\s+\w+\s+as\s+(\w+)/.exec(line) || /\bfrom\s+\S+\s+import\s+(\w+)/.exec(line) || /\bimport\s+(\w+)/.exec(line);
    return m ? m[1] : null;
};

// Globals the offscreen PRELUDE binds — a `python_exec` `tables` variable name must not clobber
// these (it would shadow pd/np/img/etc. and break the run with a confusing error). Lives HERE,
// beside the package + prelude source, so it can't drift: the library names (np/Image/pd) are
// DERIVED from PY_PACKAGES; the rest are the prelude's fixed bindings — the stdlib imports
// (`io, base64, sys, contextlib`), the injected-image vars (`img`/`img_np`/`H`/`W`), the
// `to_base64` helper, and the `result` return-capture global. Keep in sync with offscreen.ts's
// PRELUDE if you add a fixed binding there. (`df` is intentionally NOT reserved — a tables entry
// may name one `df`, overriding the single-source default.)
export const PY_RESERVED_NAMES: string[] = [
    "io", "base64", "sys", "contextlib", "to_base64", "img", "img_np", "H", "W", "result", "tables",
    ...PY_PACKAGES.map(p => preludeBinding(p.prelude)).filter((n): n is string => !!n),
];

/** What the persistent bench's OWN prelude binds (`PRELUDE_BASE`): the stdlib imports, the library aliases and
 *  `to_base64`, plus `result`. Everything else in a bench namespace is the user's, which is how the bench
 *  lists "your variables". Narrower than PY_RESERVED_NAMES on purpose: the bench injects no image or tables,
 *  so `img`/`df`/`tables`/`H`/`W` are ordinary names a user may bind there. */
export const PY_BENCH_BASE_NAMES: string[] = [
    "io", "base64", "sys", "contextlib", "to_base64", "result",
    ...PY_PACKAGES.map(p => preludeBinding(p.prelude)).filter((n): n is string => !!n),
];

const PY_IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const PY_RESERVED = new Set(PY_RESERVED_NAMES);
/** Validate a user-supplied `python_exec` `tables` variable name (it becomes a sandbox global):
 *  must be a valid Python identifier and must not clobber a preloaded name. Returns an error
 *  message, or null if the name is OK. */
export const pyVarNameError = (name: string): string | null =>
    !PY_IDENT_RE.test(name) ? `"${name}" isn't a valid Python variable name.`
    : PY_RESERVED.has(name) ? `"${name}" is a preloaded/reserved name — pick another.`
    : null;
