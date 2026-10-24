// library-proposal.ts — a tier 3 library the MODEL proposes (`propose_manifest` with `library`): its arguments checked, and the card's DERIVED note. No `chrome`.

// READONLY_LIBRARY_MANIFEST.md, "The runtime import loop", ruled 2026-10-24. The source is read by a RECORDED `ml.sh`
// call of `cat` on the one file, under cat's own manifest; the card's verdict is derived from that source with nothing
// run (the whitelist check and the module-shape rule, `libraryShape`); the load runs only after the person's yes, and
// its check is the enforce layer. The worker side is `src/sw/sw-library-proposal.ts`.

import { LIBRARY_MAX_BYTES, type LibraryName, type LibraryRequest } from "./stored-libraries";

/** A library draft as the model sent it, checked for shape. */
export interface LibraryDraft {
    /** The file, as the model named it: relative to the first workspace folder, or absolute under one. */
    path: string;
    module: string;
    /** The names it asked to admit; absent = every def and constant the module binds. */
    names?: string[];
}

const PLAIN = /^[A-Za-z][A-Za-z0-9_]*$/;

/**
 * Whether `args` propose a library rather than a program manifest.
 * @param args the model's arguments
 */
export const isLibraryDraft = (args: Record<string, unknown>): boolean => args.library !== undefined;

/**
 * The model's library draft, checked for shape; the error it reads when it is not one.
 * @param args `{ library: { path, module, names? }, scope? }`
 */
export function parseLibraryDraft(args: Record<string, unknown>): LibraryDraft | { error: string } {
    const l = args.library as Record<string, unknown> | null;
    if (!l || typeof l !== "object" || Array.isArray(l)) return { error: "Error: library is an object: {path, module, names?}." };
    if (args.manifest !== undefined) return { error: "Error: pass manifest for a program or library for a Python module, not both." };
    if (args.scope !== undefined && args.scope !== "global") return { error: "Error: a library is stored for every workspace (scope \"global\"); a workspace's own libraries are not built yet." };
    if (typeof l.path !== "string" || !l.path || l.path.includes("\0")) return { error: "Error: library.path names the module's file, relative to the workspace folder." };
    if (typeof l.module !== "string" || !PLAIN.test(l.module)) return { error: "Error: library.module is the import name: one identifier, no dots, not starting with _." };
    if (l.names !== undefined && (!Array.isArray(l.names) || !l.names.length || l.names.length > 200 || !l.names.every((n) => typeof n === "string" && PLAIN.test(n))))
        return { error: "Error: library.names lists the module's functions and constants a cell may use, each one identifier not starting with _." };
    return { path: l.path, module: l.module, ...(l.names ? { names: [...new Set(l.names as string[])] } : {}) };
}

/** What the sandbox's shape rule said of the source: why it is refused ("" when admitted), and what it binds. */
export interface LibraryShape {
    why: string;
    defs?: { name: string; signature: string }[];
    constants?: string[];
}

/**
 * The names the entry admits: the ones asked for, each bound by the module, with its signature; every def and
 * constant when none were asked for. The error when one asked for is not bound.
 * @param d the draft
 * @param shape the shape rule's verdict, admitted
 */
export function libraryNames(d: LibraryDraft, shape: LibraryShape): LibraryName[] | { error: string } {
    const bound = new Map<string, LibraryName>([
        ...(shape.defs ?? []).map((f): [string, LibraryName] => [f.name, { name: f.name, kind: "def", signature: f.signature }]),
        ...(shape.constants ?? []).map((name): [string, LibraryName] => [name, { name, kind: "constant", signature: "" }]),
    ]);
    const asked = d.names ?? [...bound.keys()].filter((n) => PLAIN.test(n));
    const missing = asked.filter((n) => !bound.has(n));
    if (missing.length) return { error: `Error: ${d.module} defines no ${missing.map((n) => `'${n}'`).join(", ")} at its top level.` };
    if (!asked.length) return { error: `Error: ${d.module} defines no function or constant a cell could use.` };
    return asked.map((n) => ({ ...bound.get(n)! }));
}

/**
 * The card's note: what was read, what a cell may use, and what approving does. DERIVED: nothing of the library ran.
 * @param r the entry it would store
 */
export function libraryNote(r: LibraryRequest): string {
    const bytes = new TextEncoder().encode(r.source).length;
    const names = r.names.map((n) => n.kind === "def" ? `${n.name}(${n.signature})` : n.name).join(", ");
    return `A pure-Python library for the read-only Python dialect: \`import ${r.module}\` in a cell inside the dialect, reading ${names}. ` +
        `Read from ${r.path} (${bytes} bytes, at most ${LIBRARY_MAX_BYTES}; sha256 ${r.sha256}) by a recorded ml.sh call of cat. ` +
        "Derived from the source, with nothing of it run: it is inside the dialect's whitelist, and its top level only imports the dialect's modules, defines functions whose defaults are constants, and binds constants, so it can keep no state from one run to the next. " +
        "Its body runs under the same gate as a cell's, whatever it claims. On approval it is loaded under that gate and stored, for every workspace, only if the load agrees; it is the source shown here, and a later change to the file needs a new proposal.";
}
