// sw-pkg-install.ts — `python_install` in the worker: the verdict against the core's own lock before anything is fetched, the card it freezes, and the person's answer judged against that card.

// docs/plan/repl/PACKAGES_INSTALL.md, slice 2. No network: the index view is the lock alone, so a package the core does
// not ship is refused as not on the index (PyPI is slice 3), and approving installs nothing yet (slice 4). The check is
// frozen at card time (sw-run-host.ts holds it in the gate's closure); an answer is approved only when the rows it
// carries are that check's rows, field by field (`judgeAnswer`), so a verdict that changed cannot be approved unseen.

import { canonicalName } from "../python/pkg-pep508";
import { cardFromVerdict, lockEntries, preloadedClosure, rowsFromAnswer, sameRows } from "../python/pkg-card";
import { type PkgCard } from "../contract/contract-render";
import { verdict, type CoreFacts } from "../python/pkg-verdict";
import { PY_PACKAGE_LOADS } from "../python/python-env";

/** One python_install call as checked when its card is raised: what was asked, and the card shown. */
export interface PkgCheck {
    request: { name: string; version?: string };
    card: PkgCard;
}

let corePromise: Promise<CoreFacts> | null = null;   // state: cache — the core's lock as this worker read it, re-read after an eviction

/** The core's facts, from the lock the extension ships (`dist/pyodide/pyodide-lock.json`). Tags and the marker
 *  environment are for PyPI files, which slice 2 never judges, so they are empty here. */
function core(): Promise<CoreFacts> {
    corePromise ??= (async () => {
        const res = await fetch(chrome.runtime.getURL("pyodide/pyodide-lock.json"));
        const json: unknown = await res.json();
        const lock = lockEntries(json, canonicalName);
        const info = (json as { info?: { python?: unknown } })?.info;
        return { tags: [], markerEnv: {}, python: typeof info?.python === "string" ? info.python : "", lock, preloaded: preloadedClosure(PY_PACKAGE_LOADS, lock, canonicalName) };
    })().catch((e) => { corePromise = null; throw e; });
    return corePromise;
}

/**
 * The arguments' request, or the error the model is told (no card is shown for it).
 * @param args the call's arguments
 * @returns the request, or an error string
 */
export function installRequest(args: Record<string, unknown>): { name: string; version?: string } | string {
    const { name, version } = args;
    if (typeof name !== "string" || !name) return `Error: invalid arguments for "python_install": "name" must be a non-empty string.`;
    if (version !== undefined && typeof version !== "string") return `Error: invalid arguments for "python_install": "version" must be a string.`;
    return version !== undefined ? { name, version } : { name };
}

/**
 * Check one call for its card: the verdict against the lock alone, as the rows the person will approve.
 * @param request the request, from `installRequest`
 * @returns the frozen check
 */
export async function checkInstall(request: { name: string; version?: string }): Promise<PkgCheck> {
    const facts = await core();
    return { request, card: cardFromVerdict(verdict(request, facts, () => undefined)) };
}

/**
 * Whether an approval of `check`'s card stands: only when the card was installable and the answer carries exactly its
 * rows. Every other answer is a denial: `reason` is the run log's slug (it keeps only slugs), `why` its sentence.
 * @param check the check frozen when the card was raised
 * @param files the answer's rows, as SET_APPROVAL carried them (absent from the chat page, the phone and the hub)
 * @returns approved, or why it is not
 */
export function judgeAnswer(check: PkgCheck, files: unknown): { ok: true } | { ok: false; reason: "refusal" | "files-absent" | "files-malformed" | "files-differ"; why: string } {
    if (!check.card.ok) return { ok: false, reason: "refusal", why: `the card was a refusal (${check.card.reason})` };
    if (files === undefined) return { ok: false, reason: "files-absent", why: "the answer carried no rows (a surface that cannot show a package card denies it)" };
    const rows = rowsFromAnswer(files);
    if (!rows) return { ok: false, reason: "files-malformed", why: "the answer's rows do not check out" };
    if (!sameRows(check.card.files, rows)) return { ok: false, reason: "files-differ", why: "the answer's rows are not the rows the card showed" };
    return { ok: true };
}

const outcomes = new Map<string, string>();   // state: plumbing — one approval's answer, taken by the call it approved

/** The key an outcome is kept under: the run and the call's request. */
const outcomeKey = (runId: string, args: Record<string, unknown>): string => `${runId}\u0000${JSON.stringify([args.name, args.version])}`;

/**
 * Record what became of an approved call, for the tool's own run to report once.
 * @param runId the run
 * @param args the call's arguments
 * @param text what the tool reports
 */
export function noteInstallOutcome(runId: string, args: Record<string, unknown>, text: string): void {
    outcomes.set(outcomeKey(runId, args), text);
}

/**
 * The outcome of the person's answer for this call, once; undefined when they did not approve it.
 * @param runId the run
 * @param args the call's arguments
 * @returns the text the tool reports
 */
export async function installOutcome(runId: string, args: Record<string, unknown>): Promise<string | undefined> {
    const k = outcomeKey(runId, args);
    const o = outcomes.get(k);
    outcomes.delete(k);
    return o;
}
