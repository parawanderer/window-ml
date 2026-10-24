// dialect-data.ts — the read-only Python dialect's whitelist and manifests, as the Pyodide worker hands them to the fork's `load_manifests`.

import whitelist from "../../notebooks/python-dialect/data/whitelist.json";
import stdlib from "../../notebooks/python-dialect/data/manifest-stdlib.json";
import numpy from "../../notebooks/python-dialect/data/manifest-numpy.json";
import pandas from "../../notebooks/python-dialect/data/manifest-pandas.json";
import pil from "../../notebooks/python-dialect/data/manifest-pil.json";

/** The dialect's data files by the name `restricted.load_manifests` reads them under, each as JSON text. */
export const DIALECT_FILES: Record<string, string> = Object.fromEntries(Object.entries({
    "whitelist.json": whitelist, "manifest-stdlib.json": stdlib, "manifest-numpy.json": numpy,
    "manifest-pandas.json": pandas, "manifest-pil.json": pil,
}).map(([name, data]) => [name, JSON.stringify(data)]));

/** The AST node names a cell inside the dialect may use (whitelist.json "nodes", the one ratchet). */
export const DIALECT_NODES: string[] = (whitelist as { nodes: string[] }).nodes;

/** The modules a cell inside the dialect may import (whitelist.json "modules"): no library may take one of these names. */
export const DIALECT_MODULES: string[] = (whitelist as { modules: string[] }).modules;
