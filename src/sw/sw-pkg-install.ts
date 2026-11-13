// sw-pkg-install.ts — `python_install` in the worker: the verdict against the core's own lock and PyPI's index before any file is downloaded, the card it freezes, and the person's answer judged against that card.

// docs/plan/repl/PACKAGES_INSTALL.md, slices 2 to 4. The verdict reads PyPI's index on the precheck, before approval
// (ruled 2026-11-12: one card; the name canonicalized before any request, the requests capped per call and per run, each
// one in the run log), against the core's own tags and environment (`core-env.gen.ts`). The check is frozen at card time
// (sw-run-host.ts holds it in the gate's closure); an answer is approved only when the rows it carries are that check's
// rows, field by field (`judgeAnswer`), so a verdict that changed cannot be approved unseen. Approving downloads the
// card's PyPI files into the mirror, each checked against its sha256 (`sw-pkg-mirror.ts`), then installs them
// (`installApproved`, slice 4): each wheel's archive is checked (`pkg-archive.ts`), the import is tested in a candidate
// worker (offscreen.ts `installTest`), and only when it passes are the wheels added to the run's record
// (`sw-pkg-installs.ts`), which the run's next cell carries to its own worker. A failure changes nothing of the run.

import { canonicalName } from "../python/pkg-pep508";
import { cardFromVerdict, lockEntries, preloadedClosure, rowsFromAnswer, sameRows } from "../python/pkg-card";
import { type PkgCard } from "../contract/contract-render";
import { type CoreFacts } from "../python/pkg-verdict";
import { PY_PACKAGE_LOADS } from "../python/python-env";
import { fileKey, lookupName, resolveVerdict } from "../python/pkg-index";
import { CORE_ENV } from "../python/core-env.gen";
import { ensureWheel, indexGetFor, mirroredDigests } from "./sw-pkg-mirror";
import { mirroredWheel } from "../python/pkg-mirror-db";
import { checkWheel } from "../python/pkg-archive";
import { recordInstalls, runInstalls, type InstalledWheel } from "./sw-pkg-installs";
import { recordRunLog } from "./sw-run-log";
import { ensureOffscreen } from "./sw-offscreen";
import whitelist from "../../notebooks/python-dialect/data/whitelist.json";

/** One python_install call as checked when its card is raised: what was asked, and the card shown. */
export interface PkgCheck {
    request: { name: string; version?: string };
    card: PkgCard;
    /** Each PyPI file's download URL as the index gave it, by `fileKey`: kept with the check, never shown or answered. */
    urls: ReadonlyMap<string, string>;
}

let corePromise: Promise<CoreFacts & { imports: Set<string> }> | null = null;   // state: cache — the core's lock as this worker read it, re-read after an eviction

/** The core's facts: the lock the extension ships (`dist/pyodide/pyodide-lock.json`), and the tags and marker
 *  environment the pinned core reports (`CORE_ENV`). */
function core(): Promise<CoreFacts & { imports: Set<string> }> {
    corePromise ??= (async () => {
        const res = await fetch(chrome.runtime.getURL("pyodide/pyodide-lock.json"));
        const json: unknown = await res.json();
        const lock = lockEntries(json, canonicalName);
        const info = (json as { info?: { python?: unknown } })?.info;
        // Every import name a lock package provides, shipped or not: no installed wheel may take one (pkg-archive.ts).
        const pkgs = Object.values(((json as { packages?: unknown })?.packages ?? {}) as Record<string, { imports?: unknown }>);
        const imports = new Set(pkgs.flatMap((p) => (Array.isArray(p?.imports) ? p.imports : []).filter((n): n is string => typeof n === "string")));
        return { tags: CORE_ENV.tags, markerEnv: CORE_ENV.markerEnv, python: typeof info?.python === "string" ? info.python : CORE_ENV.python, lock, preloaded: preloadedClosure(PY_PACKAGE_LOADS, lock, canonicalName), imports };
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
 * @returns how many were downloaded and held, or the sentence for the one that failed
 */
async function downloadApproved(check: PkgCheck): Promise<{ downloaded: number; held: number } | { failed: string }> {
    if (!check.card.ok) return { failed: "Not installed: the card was a refusal." };
    let downloaded = 0, held = 0;
    for (const row of check.card.files) {
        if (row.source === "lock") continue;
        const url = check.urls.get(fileKey(row.sha256, row.filename));
        if (!url || row.size === null) return { failed: `Not installed: ${row.filename} has no download the card can stand behind.` };
        try {
            if (await ensureWheel({ name: row.name, version: row.version, filename: row.filename, size: row.size, sha256: row.sha256, url }) === "held") held++;
            else downloaded++;
        } catch (e) {
            return { failed: `Not installed: ${row.filename} could not be downloaded as approved (${e instanceof Error ? e.message : String(e)}). Nothing of it was kept.` };
        }
    }
    return { downloaded, held };
}

/**
 * Download an approved card's files and say so, installing nothing: what an approval did before slice 4.
 * @param check the approved check
 * @returns what the tool reports: how many files were downloaded, or which one failed and why
 */
export async function fetchApproved(check: PkgCheck): Promise<string> {
    const r = await downloadApproved(check);
    if ("failed" in r) return r.failed;
    const what = [r.downloaded ? `downloaded and checked ${r.downloaded} ${r.downloaded === 1 ? "file" : "files"}` : "", r.held ? `${r.held} already held` : ""].filter(Boolean).join("; ");
    return `Approved: ${what || "nothing to download"}. This build does not install packages yet, so nothing was installed.`;
}

/** What an install's candidate answered (offscreen.ts `installTest`). */
export type InstallTestResult = { ok: true } | { ok: false; error: string; module?: string; missing?: string; died?: boolean; collision?: boolean };

/** Ask the offscreen document to test an install in a candidate worker; `stop` aborts it. */
export type InstallTester = (run: string, wheels: { filename: string; sha256: string }[], modules: string[], stop: AbortSignal | undefined) => Promise<InstallTestResult>;

/** The tester the extension uses: the offscreen document's candidate, stopped by the run's Stop. */
const offscreenTester: InstallTester = async (run, wheels, modules, stop) => {
    await ensureOffscreen();
    const onStop = () => { chrome.runtime.sendMessage({ type: "PY_INSTALL_STOP", run }).catch(() => { /* nothing running */ }); };
    stop?.addEventListener("abort", onStop, { once: true });
    try { return await chrome.runtime.sendMessage({ type: "PY_INSTALL_TEST", run, wheels, modules }) as InstallTestResult; }
    finally { stop?.removeEventListener("abort", onStop); }
};

/** The closing sentence of every failed install: what was kept and what was not. */
const NOTHING_INSTALLED = "Nothing was installed; the downloaded files stay in the mirror.";

/**
 * Install an approved card into the run (slice 4): download what is missing, check each new wheel's archive, test the
 * import in a candidate worker, and only when it passes add the wheels to the run's record. A failure at any step
 * changes nothing of the run (PACKAGES_INSTALL.md, item 4).
 * @param check the approved check
 * @param runId the run
 * @param stop the run's Stop
 * @param test the candidate (the offscreen document's; a test passes its own)
 * @returns what the tool reports
 */
export async function installApproved(check: PkgCheck, runId: string, stop?: AbortSignal, test: InstallTester = offscreenTester): Promise<string> {
    const t0 = Date.now();
    const log = (reason: string, detail: Record<string, unknown> = {}) => recordRunLog(runId, { subsystem: "python", kind: "pkg-install", reason, ...(reason === "ok" ? {} : { level: "warn" as const }), detail: { name: check.request.name, ms: Date.now() - t0, ...detail } });
    const got = await downloadApproved(check);
    if ("failed" in got) { log("download"); return got.failed; }
    if (!check.card.ok) return "Not installed: the card was a refusal.";
    const earlier = await runInstalls(runId);
    const have = new Set(earlier.map((w) => w.sha256));
    const fresh = check.card.files.filter((r) => r.source !== "lock" && !have.has(r.sha256));
    if (!fresh.length) { log("ok", { files: 0 }); return `Installed: ${check.request.name} is already importable in this run's python_exec cells; nothing new was put in place.`; }
    const facts = await core();
    const taken = new Set<string>([...facts.imports, ...(whitelist as { modules: string[] }).modules, ...earlier.flatMap((w) => w.topLevel)]);
    const budget = { used: 0 };
    const rows: InstalledWheel[] = [];
    const modules: string[] = [];
    for (const r of fresh) {
        const blob = await mirroredWheel(r.sha256).catch(() => undefined);
        if (!blob) { log("mirror", { filename: r.filename }); return `Not installed: ${r.filename} is not in the package mirror as it was approved. ${NOTHING_INSTALLED}`; }
        const c = await checkWheel(new Uint8Array(await blob.arrayBuffer()), r.filename, taken, budget);
        if (!c.ok) { log(c.reason, { filename: r.filename }); return `Not installed: ${r.filename} ${c.why}. ${NOTHING_INSTALLED}`; }
        for (const n of c.topLevel) taken.add(n);
        modules.push(...c.modules);
        rows.push({ name: r.name, version: r.version, source: r.source, filename: r.filename, sha256: r.sha256, topLevel: c.topLevel });
    }
    const refs = [...earlier, ...rows].map(({ filename, sha256 }) => ({ filename, sha256 }));
    const res = await test(runId, refs, modules, stop).catch((e): InstallTestResult => ({ ok: false, error: String(e), died: true }));
    if (!res.ok) {
        log(res.collision ? "name-collision" : res.missing ? "missing" : res.died ? "died" : "import", { module: res.module, missing: res.missing });
        if (stop?.aborted) return `Not installed: the run was stopped while the import was tested. ${NOTHING_INSTALLED}`;
        if (res.missing && res.module && !modules.includes(res.missing.split(".")[0])) return `Not installed: importing ${res.module} needs ${res.missing}, which none of the approved files provide. Ask python_install for the package that provides it; the files approved here stay in the mirror and show as mirror on the next card.`;
        if (res.died) return `Not installed: the Python interpreter did not survive the test${res.module ? ` of importing ${res.module}` : ""} (${res.error}). ${NOTHING_INSTALLED}`;
        return `Not installed: importing ${res.module ?? check.request.name} failed: ${res.error}. ${NOTHING_INSTALLED}`;
    }
    await recordInstalls(runId, rows);
    log("ok", { files: rows.length, modules });
    const names = rows.map((w) => `${w.name} ${w.version}`).join(", ");
    return `Installed ${names} into this run. ${modules.map((m) => `import ${m}`).join(", ")} works in this run's python_exec cells.`;
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
