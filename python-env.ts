// Single source of truth for the python_exec sandbox's third-party packages. Adding one
// entry here updates ALL of: the offscreen loadPackage() call, the prelude's imports, and
// the tool description's "in scope" list — so a new package (e.g. pandas) is one edit, not
// three that drift. (Pure constants, no imports, so it bundles into both offscreen.js and
// injected.js without pulling anything else in.) `load` is the Pyodide package name;
// `prelude` is the import line executed before user code; `label` is what the model sees.
export interface PyPackage { load: string; prelude: string; label: string; }

export const PY_PACKAGES: PyPackage[] = [
    { load: "numpy", prelude: "import numpy as np", label: "numpy (np)" },
    { load: "pillow", prelude: "from PIL import Image", label: "PIL (Image)" },
    // Add here to extend the sandbox, e.g.:
    // { load: "pandas", prelude: "import pandas as pd", label: "pandas (pd)" },
];

export const PY_PACKAGE_LOADS: string[] = PY_PACKAGES.map(p => p.load);
export const PY_PRELUDE_IMPORTS: string = PY_PACKAGES.map(p => p.prelude).join("\n");
export const PY_PACKAGE_LABELS: string = PY_PACKAGES.map(p => p.label).join(", ");
