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
    // Load-only + hidden: pandas.read_html needs a parser for the `table` DOM→df HTML
    // fallback. bs4 + html5lib are pure-Python (light) vs lxml's heavy WASM C-extension.
    { load: "beautifulsoup4", prelude: "", label: "" },
    { load: "html5lib", prelude: "", label: "" },
];

export const PY_PACKAGE_LOADS: string[] = PY_PACKAGES.map(p => p.load);
export const PY_PRELUDE_IMPORTS: string = PY_PACKAGES.filter(p => p.prelude).map(p => p.prelude).join("\n");
export const PY_PACKAGE_LABELS: string = PY_PACKAGES.filter(p => p.label).map(p => p.label).join(", ");
