// pkg-index.ts — PyPI's JSON API read into the verdict's index view: what one answer may carry, where its files may be downloaded from, and the rounds that fetch a closure's projects before the verdict is final. No `chrome`, no network.

// docs/plan/repl/PACKAGES_INSTALL.md, slice 3. Every answer is UNTRUSTED (whatever answers at pypi.org). A file is kept
// only when it is a wheel with a sha256, a positive integer size and a download URL on files.pythonhosted.org ending in
// its own filename, so a file the card shows is a file slice 3 can fetch and check. The verdict reads a synchronous
// view (`IndexView`); `resolveVerdict` runs it over what has been fetched, fetches the projects it missed, and runs it
// again, until nothing is missing or a bound is reached.

import { canonicalName } from "./pkg-pep508";
import { verdict, VERDICT_BOUNDS, type CoreFacts, type IndexFile, type IndexProject, type IndexRelease, type Verdict } from "./pkg-verdict";

/** The one host the index is read from. */
export const INDEX_HOST = "pypi.org";
/** The one host a wheel is downloaded from. */
export const FILES_HOST = "files.pythonhosted.org";

/** Bounds on reading the index, beside the verdict's own (`VERDICT_BOUNDS`). */
export const INDEX_BOUNDS = {
    /** Bytes of one JSON answer. The largest project answers in the top 2,000 run to a few MB (every release's files). */
    body: 32 * 1024 * 1024,
    /** Requests in one check: every project of the largest closure, its pinned release, and headroom. */
    requests: 2 * VERDICT_BOUNDS.packages,
    /** Requests in one run, across its calls: names leave the machine before any approval, so a loop of calls cannot
     *  send an unbounded number of them (ruled 2026-11-12, the coordinator). */
    perRun: 4 * VERDICT_BOUNDS.packages,
} as const;

const SHA256_RE = /^[0-9a-f]{64}$/;

/** A project name as PEP 508 writes one; anything else is refused before any request is made. */
const NAME_RE = /^[A-Za-z0-9]([A-Za-z0-9._-]*[A-Za-z0-9])?$/;

/**
 * The canonical name a request may be looked up under, or null when the name is not a project name or is longer than
 * the bounds allow: such a name is refused with no request made, so a name cannot carry arbitrary text to the network.
 * @param name the name as asked
 */
export function lookupName(name: string): string | null {
    if (name.length > VERDICT_BOUNDS.name || !NAME_RE.test(name)) return null;
    return canonicalName(name);
}

/**
 * The URL of a project's JSON answer, or of one release's.
 * @param canonical the project's canonical name
 * @param version a release, when its own requirements are wanted (the project answer gives the latest release's only)
 * @returns the URL, or null when the name or version cannot be put in a path
 */
export function indexUrl(canonical: string, version?: string): string | null {
    if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(canonical) || canonical.length > VERDICT_BOUNDS.name) return null;
    if (version !== undefined && !/^[A-Za-z0-9.+!_-]{1,64}$/.test(version)) return null;
    return `https://${INDEX_HOST}/pypi/${canonical}${version !== undefined ? `/${encodeURIComponent(version)}` : ""}/json`;
}

/**
 * Whether `url` is where a wheel named `filename` may be downloaded from: https on files.pythonhosted.org, the default
 * port, no credentials, query or fragment, and a path whose last segment is the filename.
 * @param url the URL the index gave
 * @param filename the file's name, already a valid wheel filename
 */
export function wheelUrlOk(url: unknown, filename: string): url is string {
    if (typeof url !== "string" || url.length > 2048) return false;
    let u: URL;
    try { u = new URL(url); } catch { return false; }
    return u.protocol === "https:" && u.hostname === FILES_HOST && u.port === "" && !u.username && !u.password && !u.search && !u.hash
        && u.pathname.startsWith("/packages/") && u.pathname.endsWith(`/${filename}`) && !u.pathname.slice(0, -filename.length).includes("..");
}

/** Read an own property, never an inherited one. */
const own = (o: unknown, k: string): unknown => (o !== null && typeof o === "object" && Object.prototype.hasOwnProperty.call(o, k) ? (o as Record<string, unknown>)[k] : undefined);

/** One file of an answer as the verdict reads it, with its URL; null for anything that is not a downloadable wheel. */
function fileOf(f: unknown): { file: IndexFile; url: string } | null {
    const filename = own(f, "filename"), size = own(f, "size"), yanked = own(f, "yanked"), url = own(f, "url"), sha256 = own(own(f, "digests"), "sha256");
    if (typeof filename !== "string" || !filename.endsWith(".whl") || filename.length > VERDICT_BOUNDS.filename) return null;
    if (typeof sha256 !== "string" || !SHA256_RE.test(sha256)) return null;
    if (typeof size !== "number" || !Number.isSafeInteger(size) || size <= 0) return null;
    if (!wheelUrlOk(url, filename)) return null;
    const rp = own(f, "requires_python");
    return { file: { filename, sha256, size, yanked: yanked === true, ...(typeof rp === "string" ? { requires_python: rp } : {}) }, url };
}

/** A release's files from an answer's list, bounded, with their URLs added to `urls`. */
function filesOf(list: unknown, urls: Map<string, string>): IndexFile[] {
    if (!Array.isArray(list)) return [];
    const out: IndexFile[] = [];
    for (const f of list.slice(0, VERDICT_BOUNDS.files)) {
        const r = fileOf(f);
        if (!r) continue;
        out.push(r.file);
        urls.set(fileKey(r.file.sha256, r.file.filename), r.url);
    }
    return out;
}

/** The key a file's URL is kept under: its digest and its name. */
export const fileKey = (sha256: string, filename: string): string => `${sha256}\u0000${filename}`;

/** `requires_dist` as the answer gives it: a list of strings, null (declares none), or absent (did not say). */
function requiresDistOf(info: unknown): readonly string[] | null | undefined {
    const rd = own(info, "requires_dist");
    if (rd === null) return null;
    if (!Array.isArray(rd)) return undefined;
    return rd.slice(0, VERDICT_BOUNDS.requiresDist + 1).filter((s): s is string => typeof s === "string");
}

/**
 * A project's JSON answer (`/pypi/<name>/json`) as the verdict's index entry: the latest release with its
 * requirements, every other release with its files only. Total: anything malformed is dropped, never thrown.
 * @param json the parsed answer
 * @param canonical the canonical name asked for; an answer naming another project is refused
 * @param urls where each kept file's URL is recorded
 * @returns the project, or null when the answer is not one
 */
export function projectFromJson(json: unknown, canonical: string, urls: Map<string, string>): IndexProject | null {
    const info = own(json, "info"), name = own(info, "name"), latest = own(info, "version");
    if (typeof name !== "string" || canonicalName(name) !== canonical || typeof latest !== "string" || !latest) return null;
    const releases: Record<string, IndexRelease> = Object.create(null);
    const all = own(json, "releases");
    if (all !== null && typeof all === "object") {
        for (const v of Object.keys(all).slice(0, VERDICT_BOUNDS.releases)) {
            if (v === latest) continue;
            const files = filesOf(own(all, v), urls);
            if (files.length) releases[v] = { files };
        }
    }
    const rp = own(info, "requires_python"), rd = requiresDistOf(info);
    releases[latest] = { files: filesOf(own(json, "urls"), urls), requires_python: typeof rp === "string" ? rp : null, ...(rd !== undefined ? { requires_dist: rd } : {}) };
    return { latest, releases };
}

/**
 * One release's JSON answer (`/pypi/<name>/<version>/json`) merged into its project: that release's files and its
 * requirements, which the project answer gives for the latest release only.
 * @param project the project as read so far
 * @param json the parsed answer
 * @param canonical the project's canonical name
 * @param version the release asked for
 * @param urls where each kept file's URL is recorded
 * @returns the project with the release filled in; unchanged when the answer is not that release's
 */
export function withRelease(project: IndexProject, json: unknown, canonical: string, version: string, urls: Map<string, string>): IndexProject {
    const info = own(json, "info"), name = own(info, "name");
    if (typeof name !== "string" || canonicalName(name) !== canonical || own(info, "version") !== version) return project;
    const rp = own(info, "requires_python"), rd = requiresDistOf(info);
    const release: IndexRelease = { files: filesOf(own(json, "urls"), urls), requires_python: typeof rp === "string" ? rp : null, ...(rd !== undefined ? { requires_dist: rd } : {}) };
    return { latest: project.latest, releases: { ...project.releases, [version]: release } };
}

/** What `get` answers for one URL: the parsed JSON, `null` for a 404 (no such project), or a thrown error (`IndexRunCap`
 *  when the run has made all the index requests it may). */
export type IndexGet = (url: string) => Promise<unknown>;

/** A verdict and what reading the index for it gave: each PyPI file's URL by `fileKey`, and how many requests. */
export interface ResolvedVerdict {
    verdict: Verdict;
    urls: Map<string, string>;
    requests: number;
}

/**
 * The verdict for a request with the index read from PyPI: run it over the projects fetched so far, fetch the ones it
 * asked for and did not have, and run it again until it asks for nothing new. Each project is fetched once; a
 * requested version's own answer is fetched too, for its requirements. A failed request, or more than
 * `INDEX_BOUNDS.requests`, gives a refusal naming the package (`index-error`, `too-large`).
 * @param request what was asked
 * @param core the core's facts
 * @param get reads one URL
 * @returns the verdict, the files' URLs and the request count
 */
export async function resolveVerdict(request: { name: string; version?: string }, core: CoreFacts, get: IndexGet): Promise<ResolvedVerdict> {
    const urls = new Map<string, string>();
    const projects = new Map<string, IndexProject | null>();
    let requests = 0;
    const fetchJson = async (url: string): Promise<unknown> => {
        if (++requests > INDEX_BOUNDS.requests) throw new IndexBound();
        return get(url);
    };
    const asked = canonicalName(request.name);
    try {
        for (;;) {
            const missing = new Set<string>();
            const view = (c: string): IndexProject | undefined => {
                if (!projects.has(c)) { if (!core.lock.has(c)) missing.add(c); return undefined; }
                return projects.get(c) ?? undefined;
            };
            const v = verdict(request, core, view);
            // A lock package resolves to the lock with no request, and is looked up only when the verdict has to replace it.
            if (v.ok || !missing.size) {
                if (!v.ok && v.reason === "lock-too-old" && !projects.has(canonicalName(v.at))) missing.add(canonicalName(v.at));
                else return { verdict: v, urls, requests };
            }
            await Promise.all([...missing].map(async (c) => {
                const url = indexUrl(c);
                let p: IndexProject | null = null;
                if (url) {
                    const json = await fetchJson(url);
                    p = json === null ? null : projectFromJson(json, c, urls);
                    if (p && c === asked && request.version !== undefined && request.version !== p.latest) {
                        const rurl = indexUrl(c, request.version);
                        const rjson = rurl ? await fetchJson(rurl) : null;
                        if (rjson !== null) p = withRelease(p, rjson, c, request.version, urls);
                    }
                }
                projects.set(c, p);
            }));
        }
    } catch (e) {
        const at = request.name;
        return { verdict: { ok: false, reason: e instanceof IndexRunCap ? "lookup-cap" : e instanceof IndexBound ? "too-large" : "index-error", at }, urls, requests };
    }
}

/** Thrown when a check would make more requests than `INDEX_BOUNDS.requests`. */
class IndexBound extends Error {}

/** Thrown by an `IndexGet` when the run has made all the index requests it may (`INDEX_BOUNDS.perRun`). */
export class IndexRunCap extends Error {}
