// pkg-scan-note.ts — what python_install's platform scan answers, read back keeping only names, and the note the model reads from it.

// The scan itself is pkg-scan.ts, which runs in the candidate; this half is what the service worker needs of it, so the
// scan's Python and the core tables stay out of its bundle. docs/plan/repl/PACKAGES_INSTALL.md, slice 4, item 7.

import { shownText } from "./pkg-card";

/** What the scan found: a call that fails in the core, a stdlib module the core lacks, or a raise on the core's branch. */
export interface ScanFinding {
    kind: "call" | "missing" | "raise";
    /** The failing call or the missing module, from the scan's own tables; empty for a raise. */
    what: string;
    /** The module (or `module.function()`) whose import-time code reaches it. */
    in: string;
    /** The import chain from the top-level module tested, which is `chain[0]`. */
    chain: string[];
}

/** A candidate's scan, as the cell answers it. */
export interface ScanResult {
    findings: ScanFinding[];
    /** How many modules it read. */
    reached: number;
    /** It stopped at a bound (modules, a file's size, the total read) before the closure was done. */
    truncated?: boolean;
}

/** Bounds on what one scan reads: it runs inside the candidate's 60 s, on sources the package wrote. */
export const SCAN_BOUNDS = { modules: 2000, fileBytes: 2 * 1024 * 1024, totalBytes: 48 * 1024 * 1024, findings: 20 } as const;

/** A dotted name the scan built from the package's paths and identifiers; anything else is not shown. */
const NAME = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*(\(\))?$/;

/**
 * Read a scan cell's answer, keeping only findings whose every field is a name: anything else in it is dropped.
 * @param raw the cell's JSON value
 * @returns the scan, or null when it did not answer one
 */
export function readScan(raw: unknown): ScanResult | null {
    let v: unknown = raw;
    try { while (typeof v === "string") v = JSON.parse(v); } catch { return null; }
    if (!v || typeof v !== "object" || !Array.isArray((v as ScanResult).findings)) return null;
    const r = v as ScanResult;
    const findings = r.findings.filter((f): f is ScanFinding => !!f && ["call", "missing", "raise"].includes(f.kind)
        && typeof f.in === "string" && NAME.test(f.in) && typeof f.what === "string" && (f.kind === "raise" ? f.what === "" : NAME.test(f.what) || (f.kind === "call" && /^dlopen-(system|unknown)$/.test(f.what)))
        && Array.isArray(f.chain) && f.chain.length > 0 && f.chain.every((c) => typeof c === "string" && NAME.test(c)))
        .slice(0, SCAN_BOUNDS.findings).map(({ kind, what, in: where, chain }) => ({ kind, what, in: where, chain: [...chain] }));
    return { findings, reached: Number.isFinite(r.reached) ? Number(r.reached) : 0, ...(r.truncated === true ? { truncated: true } : {}) };
}

/** One finding as a clause the model reads. */
function clause(f: ScanFinding): string {
    const where = shownText(f.in).text;
    if (f.kind === "missing") return `${where} imports ${shownText(f.what).text}, which this sandbox's Python does not have`;
    if (f.kind === "raise") return `${where} raises at import time on this platform`;
    if (f.what.startsWith("dlopen-")) return `${where} loads a shared library at import time, which this sandbox has none of`;
    return `${where} calls ${shownText(f.what).text} at import time, which fails in this sandbox`;
}

/** How many findings a note spells out; the rest are counted. */
const NOTE_SHOWN = 3;

/**
 * The platform scan's note: what it found, for the result the model reads; empty when it found nothing.
 * @param scan the scan, or null when it did not run
 * @param module only the findings reached from this top-level module (a failed import's), or every finding
 */
export function scanNote(scan: ScanResult | null, module?: string): string {
    const fs = (scan?.findings ?? []).filter((f) => module === undefined || f.chain[0] === module);
    if (!fs.length) return "";
    const more = fs.length - NOTE_SHOWN;
    return `The platform scan found: ${fs.slice(0, NOTE_SHOWN).map(clause).join("; ")}${more > 0 ? `; and ${more} more` : ""}.`;
}
