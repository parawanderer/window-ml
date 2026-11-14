// pkg-card.ts — the python_install card's model: a verdict as the rows a person approves, index text made safe to show, and the rows an answer carries rebuilt and compared with the rows shown.

// docs/plan/repl/PACKAGES_INSTALL.md, slice 2. Pure: no fetch, no storage, no DOM. What the card shows and what the
// worker approves are the same rows: the worker freezes `cardFromVerdict`'s rows when it raises the card, and approves
// only an answer whose rows `rowsFromAnswer` rebuilds and `sameRows` finds equal to them, field by field. A verdict
// that changed between the card and the answer therefore cannot be approved unseen.

import { INVISIBLE } from "../agent/security";
import { VERDICT_BOUNDS, type LockEntry, type Verdict } from "./pkg-verdict";
import { PkgCard, PkgRow } from "../contract/contract-render";
import { SHIPPED_LOCK_FILES } from "./pkg-shipped.gen";

/** Where a package comes from, as the card says it. `pypi` only in slice 2's types: no slice-2 card has such a row. */
export type PkgEcosystem = "pypi";

const SHA256_RE = /^[0-9a-f]{64}$/;
/** The longest version string a row may carry; PEP 440 versions in the pinned snapshot are far shorter. */
const VERSION_MAX = 128;
const ROW_KEYS = ["name", "version", "filename", "source", "size", "sha256"] as const;

/**
 * The card for a verdict. A file without a 64-hex digest, or a PyPI file without a size, refuses the whole card as
 * `malformed` at that package: a row the person cannot check in full is never shown as approvable. A PyPI file whose
 * digest is in `mirrored` is shown as `mirror` and left out of the download total: its bytes are already held. A lock
 * file the extension does not ship refuses the card as `not-shipped` at that package.
 * @param v the verdict, from `verdict()`
 * @param mirrored the digests the mirror holds
 * @param shipped the lock files the extension ships (`pkg-shipped.gen.ts`)
 * @returns the card's rows and total, or the refusal
 */
export function cardFromVerdict(v: Verdict, mirrored: ReadonlySet<string> = new Set(), shipped: ReadonlySet<string> = new Set(SHIPPED_LOCK_FILES)): PkgCard {
    if (!v.ok) return { ok: false, reason: v.reason, at: v.at };
    const files: PkgRow[] = [];
    let totalBytes = 0;
    for (const f of v.files) {
        if (typeof f.sha256 !== "string" || !SHA256_RE.test(f.sha256)) return { ok: false, reason: "malformed", at: f.name };
        // A lock file is in the core only when the extension ships it; the lock names far more than that (ruled 2026-11-13).
        if (f.source === "lock" && !shipped.has(f.filename)) return { ok: false, reason: "not-shipped", at: f.name };
        let size: number | null = null;
        if (f.source === "pypi") {
            if (typeof f.size !== "number" || !Number.isSafeInteger(f.size) || f.size < 0) return { ok: false, reason: "malformed", at: f.name };
            size = f.size;
            if (mirrored.has(f.sha256)) {
                files.push({ name: f.name, version: f.version, filename: f.filename, source: "mirror", size, sha256: f.sha256 });
                continue;
            }
            totalBytes += f.size;
        }
        files.push({ name: f.name, version: f.version, filename: f.filename, source: f.source, size, sha256: f.sha256 });
    }
    return { ok: true, files, loaded: [...v.loaded], totalBytes };
}

/** Control characters (C0, DEL, C1) and every character that draws nothing or reorders the text around it. */
const HIDDEN = new RegExp(`[\\u0000-\\u001f\\u007f-\\u009f]|${INVISIBLE.source}`, "gu");

/**
 * Index text as the card may show it: each control, bidi or invisible character replaced by U+FFFD in the text, and
 * listed as `\u{XXXX}` beside it, so a name cannot pose as another or reorder the row.
 * @param s a string from the index or the lock
 * @returns the text to draw and the characters it hid, in order
 */
export function shownText(s: string): { text: string; hidden: string[] } {
    const hidden: string[] = [];
    const text = s.replace(HIDDEN, (c) => {
        hidden.push(`\\u{${(c.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, "0")}}`);
        return "�";
    });
    return { text, hidden };
}

/** A string field of an answer's row, or `undefined` when it is not a string of at most `max` characters. */
function str(v: unknown, max: number): string | undefined {
    return typeof v === "string" && v.length <= max ? v : undefined;
}

/**
 * The rows an answer carries, rebuilt field by field: an array of at most `VERDICT_BOUNDS.packages` plain objects, each
 * with exactly the six fields of `PkgRow` and each field of its type. `undefined` for anything else, which the
 * worker resolves as denied.
 * @param x the answer's `files`, as it arrived
 * @returns fresh rows, or `undefined`
 */
export function rowsFromAnswer(x: unknown): PkgRow[] | undefined {
    if (!Array.isArray(x) || x.length > VERDICT_BOUNDS.packages) return undefined;
    const out: PkgRow[] = [];
    for (let i = 0; i < x.length; i++) {
        if (!Object.hasOwn(x, i)) return undefined;
        const r: unknown = x[i];
        if (typeof r !== "object" || r === null || Array.isArray(r) || Object.getPrototypeOf(r) !== Object.prototype) return undefined;
        const keys = Object.keys(r);
        if (keys.length !== ROW_KEYS.length || !ROW_KEYS.every((k) => Object.hasOwn(r, k))) return undefined;
        const o = r as Record<string, unknown>;
        const name = str(o.name, VERDICT_BOUNDS.name), version = str(o.version, VERSION_MAX), filename = str(o.filename, VERDICT_BOUNDS.filename);
        const sha256 = str(o.sha256, 64), source = o.source, size = o.size;
        if (name === undefined || version === undefined || filename === undefined || sha256 === undefined || !SHA256_RE.test(sha256)) return undefined;
        if (source !== "lock" && source !== "pypi" && source !== "mirror") return undefined;
        if (size !== null && (typeof size !== "number" || !Number.isSafeInteger(size) || size < 0)) return undefined;
        out.push({ name, version, filename, source, size, sha256 });
    }
    return out;
}

/**
 * Whether two row lists are the same rows in the same order, compared field by field.
 * @param a the rows the worker froze at card time
 * @param b the rows the answer carries, from `rowsFromAnswer`
 * @returns true only when every field of every row is equal
 */
export function sameRows(a: readonly PkgRow[], b: readonly PkgRow[]): boolean {
    return a.length === b.length && a.every((r, i) => ROW_KEYS.every((k) => r[k] === b[i][k]));
}

/**
 * The core's lock as the verdict reads it, from pyodide-lock.json's `packages`: each entry's version, file,
 * dependencies and sha256, by canonical name. An entry missing a field is left out (the verdict then judges that name
 * as not in the lock, which in slice 2 refuses it as not on the index).
 * @param lock the parsed pyodide-lock.json
 * @param canonical the canonical-name function (`canonicalName` from pkg-pep508)
 * @returns the lock by canonical name
 */
export function lockEntries(lock: unknown, canonical: (n: string) => string): Map<string, LockEntry> {
    const out = new Map<string, LockEntry>();
    const pkgs = typeof lock === "object" && lock !== null ? (lock as { packages?: unknown }).packages : undefined;
    if (typeof pkgs !== "object" || pkgs === null) return out;
    for (const [key, e] of Object.entries(pkgs as Record<string, unknown>)) {
        if (typeof e !== "object" || e === null) continue;
        const { version, file_name, depends, sha256 } = e as Record<string, unknown>;
        if (typeof version !== "string" || typeof file_name !== "string" || !Array.isArray(depends) || !depends.every((d) => typeof d === "string")) continue;
        out.set(canonical(key), { version, file: file_name, depends: depends as string[], ...(typeof sha256 === "string" && SHA256_RE.test(sha256) ? { sha256 } : {}) });
    }
    return out;
}

/**
 * The canonical names a fresh sandbox has loaded: each start-up package and its lock dependencies, transitively.
 * @param loads the start-up packages (`PY_PACKAGE_LOADS`)
 * @param lock the lock by canonical name
 * @param canonical the canonical-name function
 * @returns the loaded set, which an install never replaces
 */
export function preloadedClosure(loads: readonly string[], lock: ReadonlyMap<string, LockEntry>, canonical: (n: string) => string): Set<string> {
    const seen = new Set<string>();
    const stack = loads.map(canonical);
    while (stack.length) {
        const n = stack.pop()!;
        if (seen.has(n)) continue;
        seen.add(n);
        for (const d of lock.get(n)?.depends ?? []) stack.push(canonical(d));
    }
    return seen;
}
