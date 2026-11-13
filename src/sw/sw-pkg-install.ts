// sw-pkg-install.ts — `python_install` in the worker: the verdict against the core's own lock and PyPI's index before any file is downloaded, the card it freezes, and the person's answer judged against that card.

// docs/plan/repl/PACKAGES_INSTALL.md, slices 2 and 3. The verdict reads PyPI's index on the precheck, before approval
// (ruled 2026-11-12: one card; the name canonicalized before any request, the requests capped per call and per run, each
// one in the run log), against the core's own tags and environment (`core-env.gen.ts`). The check is frozen at card time
// (sw-run-host.ts holds it in the gate's closure); an answer is approved only when the rows it carries are that check's
// rows, field by field (`judgeAnswer`), so a verdict that changed cannot be approved unseen. Approving downloads the
// card's PyPI files into the mirror, each checked against its sha256 (`sw-pkg-mirror.ts`), and installs nothing yet
// (slice 4).

import { canonicalName } from "../python/pkg-pep508";
import { cardFromVerdict, lockEntries, preloadedClosure, rowsFromAnswer, sameRows } from "../python/pkg-card";
import { type PkgCard } from "../contract/contract-render";
import { type CoreFacts } from "../python/pkg-verdict";
import { PY_PACKAGE_LOADS } from "../python/python-env";
import { fileKey, lookupName, resolveVerdict } from "../python/pkg-index";
import { CORE_ENV } from "../python/core-env.gen";
import { ensureWheel, indexGetFor, mirroredDigests } from "./sw-pkg-mirror";

/** One python_install call as checked when its card is raised: what was asked, and the card shown. */
export interface PkgCheck {
    request: { name: string; version?: string };
    card: PkgCard;
    /** Each PyPI file's download URL as the index gave it, by `fileKey`: kept with the check, never shown or answered. */
    urls: ReadonlyMap<string, string>;
}

let corePromise: Promise<CoreFacts> | null = null;   // state: cache — the core's lock as this worker read it, re-read after an eviction

/** The core's facts: the lock the extension ships (`dist/pyodide/pyodide-lock.json`), and the tags and marker
 *  environment the pinned core reports (`CORE_ENV`). */
function core(): Promise<CoreFacts> {
    corePromise ??= (async () => {
        const res = await fetch(chrome.runtime.getURL("pyodide/pyodide-lock.json"));
        const json: unknown = await res.json();
        const lock = lockEntries(json, canonicalName);
        const info = (json as { info?: { python?: unknown } })?.info;
        return { tags: CORE_ENV.tags, markerEnv: CORE_ENV.markerEnv, python: typeof info?.python === "string" ? info.python : CORE_ENV.python, lock, preloaded: preloadedClosure(PY_PACKAGE_LOADS, lock, canonicalName) };
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
    if (lookupName(name) === null) return `Error: invalid arguments for "python_install": "name" must be a project name as PyPI writes one (letters, digits, ".", "_" and "-"), so nothing was looked up.`;
    if (version !== undefined && typeof version !== "string") return `Error: invalid arguments for "python_install": "version" must be a string.`;
    return version !== undefined ? { name, version } : { name };
}

/**
 * Check one call for its card: the verdict with the index read from PyPI, as the rows the person will approve. A file
 * the mirror already holds is shown as `mirror`.
 * @param request the request, from `installRequest`
 * @param runId the run, whose index requests are capped together
 * @param log told each index URL before it is requested (the run log)
 * @returns the frozen check
 */
export async function checkInstall(request: { name: string; version?: string }, runId: string, log: (url: string) => void): Promise<PkgCheck> {
    const facts = await core();
    const r = await resolveVerdict(request, facts, indexGetFor(runId, log));
    const mirrored = r.verdict.ok ? await mirroredDigests().catch(() => new Set<string>()) : new Set<string>();
    return { request, card: cardFromVerdict(r.verdict, mirrored), urls: r.urls };
}

/**
 * Download an approved card's PyPI files into the mirror, each checked against the sha256 the card showed. Files the
 * mirror holds and lock files are not fetched.
 * @param check the approved check
 * @returns what the tool reports: how many files were downloaded, or which one failed and why
 */
export async function fetchApproved(check: PkgCheck): Promise<string> {
    if (!check.card.ok) return "Not installed: the card was a refusal.";
    let downloaded = 0, held = 0;
    for (const row of check.card.files) {
        if (row.source === "lock") continue;
        const url = check.urls.get(fileKey(row.sha256, row.filename));
        if (!url || row.size === null) return `Not installed: ${row.filename} has no download the card can stand behind.`;
        try {
            if (await ensureWheel({ name: row.name, version: row.version, filename: row.filename, size: row.size, sha256: row.sha256, url }) === "held") held++;
            else downloaded++;
        } catch (e) {
            return `Not installed: ${row.filename} could not be downloaded as approved (${e instanceof Error ? e.message : String(e)}). Nothing of it was kept.`;
        }
    }
    const what = [downloaded ? `downloaded and checked ${downloaded} ${downloaded === 1 ? "file" : "files"}` : "", held ? `${held} already held` : ""].filter(Boolean).join("; ");
    return `Approved: ${what || "nothing to download"}. This build does not install packages yet, so nothing was installed.`;
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

const outcomes = new Map<string, string | Promise<string>>();   // state: plumbing — one approval's answer, taken by the call it approved

/** The key an outcome is kept under: the run and the call's request. */
const outcomeKey = (runId: string, args: Record<string, unknown>): string => `${runId}\u0000${JSON.stringify([args.name, args.version])}`;

/**
 * Record what became of an approved call, for the tool's own run to report once.
 * @param runId the run
 * @param args the call's arguments
 * @param text what the tool reports, or the download that will say it
 */
export function noteInstallOutcome(runId: string, args: Record<string, unknown>, text: string | Promise<string>): void {
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
