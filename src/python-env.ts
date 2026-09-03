// Single source of truth for the python_exec sandbox's third-party packages. Adding one
// entry here updates ALL of: the offscreen loadPackage() call, the prelude's imports, the
// tool description's "in scope" list, AND the offline wheel fetch (scripts/fetch-pyodide-
// wheels.mjs greps the `load:` values) — so a new package is one edit, not several that
// drift. (Pure constants, no imports, so it bundles into both offscreen.js and injected.js
// without pulling anything else in.) `load` is the Pyodide package name; `prelude` is the
// import line executed before user code (empty = load-only, imported lazily elsewhere);
// `label` is what the model sees in the tool description (empty = hidden, e.g. a parser dep).
export interface PyPackage { load: string; prelude: string; label: string; }

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
];

export const PY_PACKAGE_LOADS: string[] = PY_PACKAGES.map(p => p.load);
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

const PY_IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const PY_RESERVED = new Set(PY_RESERVED_NAMES);
/** Validate a user-supplied `python_exec` `tables` variable name (it becomes a sandbox global):
 *  must be a valid Python identifier and must not clobber a preloaded name. Returns an error
 *  message, or null if the name is OK. */
export const pyVarNameError = (name: string): string | null =>
    !PY_IDENT_RE.test(name) ? `"${name}" isn't a valid Python variable name.`
    : PY_RESERVED.has(name) ? `"${name}" is a preloaded/reserved name — pick another.`
    : null;
