// pkg-verdict.ts — whether python_exec's core can install a PyPI project, decided before anything is downloaded: the file each package of its closure would be, or the first package that stops it and why.

// docs/plan/repl/PACKAGES_INSTALL.md, slice 1. A port of the static verdict in notebooks/python-packages/pypi.py
// (`wheel_verdict`, `classify`'s `closure` and `replaceable`), which section 2 of that notebook measured against real
// installs: the latest release's wheels judged by the core's tags, its dependencies under the core's markers, depth
// first in name order, a lock package winning over PyPI, and a lock package too old for a range blocking only when no
// release inside the range can replace it. Like the notebook it ignores the version ranges between two packages that
// are not in the lock (micropip may pick an older release; the probe counts how often that fails).
//
// Pure: no fetch, no storage, no clock, no Pyodide. The index and its strings are NOT trusted (the plan's "Trust"):
// every field is checked before it is used, a file that does not check out is not a candidate, and every walk is
// bounded (`VERDICT_BOUNDS`), so a hostile index can make the verdict wrong but cannot make it run code, name a path,
// shadow a lock package or run without end. The verdict approves nothing: it is what the card shows.

import { canonicalName, evaluateMarker, parseRequirement } from "./pkg-pep508";
import { cmpVersion, parseSpecifierSet, parseVersion, sameVersion, specifierSetContains, type Pep440SpecifierSet } from "./pkg-pep440";

/** The bounds of one verdict. The real closures, from the pinned top-2,000 index snapshot and the 10,000-project
 *  probe: at most 116 packages and 127 MB of wheels (teradatasql), 1,320 requirements in one release, 224 files in one
 *  release, requirement strings to 569 characters. Each bound leaves about twice that. */
export const VERDICT_BOUNDS = {
    /** Packages in one closure, the requested one included. */
    packages: 256,
    /** How deep the dependency walk goes. */
    depth: 64,
    /** Bytes of PyPI wheels one install would download. */
    bytes: 256 * 1024 * 1024,
    /** Requirements in one release's `requires_dist`. */
    requiresDist: 4096,
    /** Files in one release. */
    files: 1024,
    /** Releases of one project looked through for a replacement. */
    releases: 4096,
    /** Characters of requirement strings read by one verdict. */
    metadataChars: 4 * 1024 * 1024,
    /** Characters of a wheel's filename: a file system's longest name. */
    filename: 255,
    /** Characters of a project name, short enough that its wheel's filename fits `filename`. */
    name: 200,
} as const;

/** One package of the core's lock (pyodide-lock.json): the version it pins, its file, its dependencies. */
export interface LockEntry {
    version: string;
    file: string;
    depends: readonly string[];
}

/** What the core is, from the core itself (trusted): its tags, marker environment, Python, lock, and what is loaded. */
export interface CoreFacts {
    /** The wheel tags the core accepts (`cp314-cp314-pyodide_2026_0_wasm32`, …, `py3-none-any`). */
    tags: readonly string[];
    /** The PEP 508 marker environment (`python_version`, `sys_platform`, …). */
    markerEnv: Readonly<Record<string, string>>;
    /** `python_full_version`, what `requires_python` is checked against. */
    python: string;
    /** The lock, by canonical name. */
    lock: ReadonlyMap<string, LockEntry>;
    /** Canonical names already loaded, which an install can never replace (micropip, packaging, the start-up set). */
    preloaded: ReadonlySet<string>;
}

/** One file of a release, as PyPI's JSON API lists it. Untrusted. */
export interface IndexFile {
    filename: string;
    sha256: string;
    size: number;
    yanked: boolean;
    /** The file's own `requires_python`, when the index gives one. */
    requires_python?: string | null;
}

/** One release. `requires_dist` absent means the index did not say (PyPI's project JSON gives it for the latest
 *  release only); `null` means the release declares none. Untrusted. */
export interface IndexRelease {
    files: readonly IndexFile[];
    requires_python?: string | null;
    requires_dist?: readonly string[] | null;
}

/** One project: its latest release, and its releases by version string. Untrusted. */
export interface IndexProject {
    latest: string;
    releases: Readonly<Record<string, IndexRelease>>;
}

/** A synchronous lookup by canonical name; `undefined` when the index has no such project. */
export type IndexView = (canonical: string) => IndexProject | undefined;

/** Why a package cannot be installed. `at` names the package. */
export type VerdictReason =
    /** No file the core accepts: native wheels for other platforms, an sdist, or nothing. */
    | "no-build"
    /** The release's `requires_python` excludes the core's Python. */
    | "python-version"
    /** A lock package outside a range asked of it, which no release inside the range can replace (or is loaded). */
    | "lock-too-old"
    /** The index has no such project, or no such release. */
    | "not-on-index"
    /** A bound of `VERDICT_BOUNDS` was passed. */
    | "too-large"
    /** A name, version, specifier, requirement or marker that does not parse or cannot be evaluated. */
    | "malformed"
    /** The release's requirements are not known (an older release, whose metadata the index did not give). */
    | "no-metadata";

/** One file an install would fetch: from the core's lock, or from PyPI (with the digest the index gave). */
export interface VerdictFile {
    name: string;
    version: string;
    filename: string;
    source: "lock" | "pypi";
    sha256?: string;
    size?: number;
}

/** The verdict: every file of the closure in walk order (and the packages already loaded), or why not. */
export type Verdict =
    | { ok: true; files: VerdictFile[]; loaded: string[] }
    | { ok: false; reason: VerdictReason; at: string };

/** Thrown inside one verdict and caught at its edge. */
class Stop {
    constructor(readonly reason: VerdictReason, readonly at: string) {}
}

/** A PyPI file chosen for a package. */
interface Chosen { filename: string; sha256: string; size: number; pure: boolean }

type Node =
    | { kind: "lock"; name: string; entry: LockEntry }
    | { kind: "pypi"; name: string; version: string; file: Chosen; deps: string[]; specs: Map<string, Pep440SpecifierSet[]> };

/** An own property of a plain object, or `undefined`: an index key is never looked up on a prototype. */
function own(obj: unknown, key: string): unknown {
    return typeof obj === "object" && obj !== null && !Array.isArray(obj) && Object.hasOwn(obj, key)
        ? (obj as Record<string, unknown>)[key] : undefined;
}

const NAME_RE = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const TAG_PART_RE = /^[A-Za-z0-9_]+$/;

/** A wheel filename's project, version and tag sets, by the wheel grammar as `packaging` 26.3 reads it; `null` for
 *  anything else, including any name that could be a path (a separator, `..`, NUL, non-ASCII). */
export function parseWheelFilename(filename: unknown): { name: string; version: string; tags: [Set<string>, Set<string>, Set<string>] } | null {
    if (typeof filename !== "string" || filename.length > VERDICT_BOUNDS.filename || !filename.endsWith(".whl")) return null;
    if (!/^[\x21-\x7e]+$/.test(filename) || /[/\\]/.test(filename) || filename.includes("..")) return null;
    const parts = filename.slice(0, -4).split("-");
    if (parts.length !== 5 && parts.length !== 6) return null;
    const [namePart, version] = parts;
    if (!namePart || namePart.includes("__") || !/^[A-Za-z0-9._]+$/.test(namePart) || !parseVersion(version)) return null;
    if (parts.length === 6 && !/^[0-9]/.test(parts[2])) return null;
    const sets = parts.slice(-3).map((c) => c.split("."));
    if (sets.some((s) => s.some((x) => !TAG_PART_RE.test(x))) || !sets[0].every((x) => IDENT_RE.test(x))) return null;
    const [i, a, p] = sets.map((s) => new Set(s.map((x) => x.toLowerCase())));
    return { name: canonicalName(namePart), version, tags: [i, a, p] };
}

/** The core's tags a wheel's tag sets accept, without expanding a compressed set. */
function matchedTags(core: CoreFacts, tags: [Set<string>, Set<string>, Set<string>]): string[] {
    return core.tags.filter((t) => {
        const [i, a, p] = t.split("-");
        return tags[0].has(i) && tags[1].has(a) && tags[2].has(p);
    });
}

/** Whether a `requires_python` value admits the core's Python: `true`, `false`, or `null` when it does not parse. */
function pythonOk(rp: unknown, core: CoreFacts): boolean | null {
    if (rp === undefined || rp === null || rp === "") return true;
    const set = parseSpecifierSet(rp);
    return set ? specifierSetContains(set, core.python) : null;
}

/** A release's file if it is a wheel this core accepts for `project` at `version`; `null` otherwise. */
function candidate(core: CoreFacts, f: unknown, project: string, version: string, releaseRp: unknown): Chosen | null {
    const filename = own(f, "filename"), sha256 = own(f, "sha256"), size = own(f, "size"), yanked = own(f, "yanked");
    if (yanked !== false || typeof sha256 !== "string" || !SHA256_RE.test(sha256)) return null;
    if (typeof size !== "number" || !Number.isSafeInteger(size) || size < 0) return null;
    const w = parseWheelFilename(filename);
    if (!w || w.name !== project || !sameVersion(w.version, version)) return null;
    const fileRp = own(f, "requires_python");
    if (pythonOk(fileRp ?? releaseRp, core) !== true) return null;
    const matched = matchedTags(core, w.tags);
    if (!matched.length) return null;
    return { filename: filename as string, sha256, size, pure: matched.every((t) => t.endsWith("-none-any")) };
}

/** The file `wheel_verdict` picks from a release: the first the core accepts, a compiled one before a pure one. */
function pick(core: CoreFacts, files: readonly unknown[], project: string, version: string, releaseRp: unknown): Chosen | null {
    let match: Chosen | null = null;
    for (const f of files) {
        const c = candidate(core, f, project, version, releaseRp);
        if (c && (!match || (!c.pure && match.pure))) match = c;
    }
    return match;
}

/** A release's file list, bounded. */
function filesOf(release: unknown, at: string): readonly unknown[] {
    const files = own(release, "files");
    if (!Array.isArray(files)) throw new Stop("malformed", at);
    if (files.length > VERDICT_BOUNDS.files) throw new Stop("too-large", at);
    return files;
}

/** A project's releases object, bounded. */
function releasesOf(project: unknown, at: string): Record<string, unknown> {
    const releases = own(project, "releases");
    if (typeof releases !== "object" || releases === null || Array.isArray(releases)) throw new Stop("malformed", at);
    if (Object.keys(releases).length > VERDICT_BOUNDS.releases) throw new Stop("too-large", at);
    return releases as Record<string, unknown>;
}

/** What a release's `requires_dist` asks for on the core, as `dep_specs` in pypi.py reads it: each requirement whose
 *  marker holds (with no extra asked), by canonical name in name order, with the non-empty ranges asked of it.
 *  `null` when one does not parse, names a URL, or has a marker that cannot be evaluated. The caller bounds the input. */
export function dependencies(requiresDist: readonly string[], env: Readonly<Record<string, string>>): { deps: string[]; specs: Map<string, Pep440SpecifierSet[]> } | null {
    const specs = new Map<string, Pep440SpecifierSet[]>();
    const deps = new Set<string>();
    for (const s of requiresDist) {
        const r = parseRequirement(s);
        if (!r || r.url !== null) return null;
        if (r.marker) {
            const holds = evaluateMarker(r.marker, env);
            if (holds === undefined) return null;
            if (!holds) continue;
        }
        deps.add(r.name);
        if (r.specifier.length) specs.set(r.name, [...(specs.get(r.name) ?? []), r.specifier]);
    }
    return { deps: [...deps].sort(), specs };
}

/** Decide whether `request` installs on `core` from `index`. */
export function verdict(request: { name: string; version?: string }, core: CoreFacts, index: IndexView): Verdict {
    try {
        return decide(request, core, index);
    } catch (e) {
        if (e instanceof Stop) return { ok: false, reason: e.reason, at: e.at };
        throw e;
    }
}

function decide(request: { name: string; version?: string }, core: CoreFacts, index: IndexView): Verdict {
    const rawName = request?.name, rawVersion = request?.version;
    if (typeof rawName !== "string" || rawName.length > VERDICT_BOUNDS.name || !NAME_RE.test(rawName)) throw new Stop("malformed", String(rawName).slice(0, 80));
    const root = canonicalName(rawName);
    if (rawVersion !== undefined && !parseVersion(rawVersion)) throw new Stop("malformed", root);
    let metaChars = 0;
    const lookup = (name: string): unknown => {
        const p = index(name);
        return p === undefined || p === null ? undefined : p;
    };

    /** The version string the index files a release under, matching `version` as a PEP 440 version. */
    const releaseKey = (releases: Record<string, unknown>, version: string): string | undefined =>
        Object.hasOwn(releases, version) ? version : Object.keys(releases).find((k) => sameVersion(k, version));

    /** A PyPI package at `version` (its latest when absent): the file it would be and what it depends on. */
    const pypiNode = (name: string, version: string | undefined): Node => {
        const project = lookup(name);
        if (project === undefined) throw new Stop("not-on-index", name);
        const releases = releasesOf(project, name);
        const want = version ?? own(project, "latest");
        if (typeof want !== "string" || !parseVersion(want)) throw new Stop("malformed", name);
        const key = releaseKey(releases, want);
        if (key === undefined) throw new Stop("not-on-index", name);
        const release = releases[key];
        const rp = own(release, "requires_python");
        const py = pythonOk(rp, core);
        if (py === null) throw new Stop("malformed", name);
        if (!py) throw new Stop("python-version", name);
        const file = pick(core, filesOf(release, name), name, key, undefined);
        if (!file) throw new Stop("no-build", name);
        const rd = own(release, "requires_dist");
        if (rd === undefined) throw new Stop("no-metadata", name);
        const reqs: unknown[] = rd === null ? [] : Array.isArray(rd) ? rd : (() => { throw new Stop("malformed", name); })();
        if (reqs.length > VERDICT_BOUNDS.requiresDist) throw new Stop("too-large", name);
        for (const s of reqs) {
            if (typeof s !== "string") throw new Stop("malformed", name);
            metaChars += s.length;
        }
        if (metaChars > VERDICT_BOUNDS.metadataChars) throw new Stop("too-large", name);
        const read = dependencies(reqs as string[], core.markerEnv);
        if (!read) throw new Stop("malformed", name);
        const { deps, specs } = read;
        return { kind: "pypi", name, version: key, file, deps, specs };
    };

    /** A package by name: the lock's entry when it has one, else PyPI's latest release. */
    const resolve = (name: string): Node => {
        const entry = core.lock.get(name);
        return entry ? { kind: "lock", name, entry } : pypiNode(name, undefined);
    };

    const replaceableMemo = new Map<string, boolean>();
    /** The newest release of lock package `name` inside every range of `ranges` with a file the core accepts. */
    const replacement = (name: string, ranges: Pep440SpecifierSet[]): { version: string; file: Chosen } | null => {
        if (core.preloaded.has(name)) return null;
        const project = lookup(name);
        if (project === undefined) return null;
        const releases = releasesOf(project, name);
        let best: { version: string; file: Chosen } | null = null;
        for (const v of Object.keys(releases)) {
            const pv = parseVersion(v);
            if (!pv || !ranges.every((r) => specifierSetContains(r, v))) continue;
            if (best && cmpVersion(pv, parseVersion(best.version)!) <= 0) continue;
            const release = releases[v];
            const file = pick(core, filesOf(release, name), name, v, own(release, "requires_python"));
            if (file) best = { version: v, file };
        }
        return best;
    };
    /** `replaceable` in pypi.py: one edge's ranges alone. */
    const replaceable = (name: string, ranges: Pep440SpecifierSet[]): boolean => {
        const key = name + "\u0000" + JSON.stringify(ranges);
        if (!replaceableMemo.has(key)) replaceableMemo.set(key, replacement(name, ranges) !== null);
        return replaceableMemo.get(key)!;
    };

    // Every range asked of each lock package on the walk, the request's own `==version` included.
    const asked = new Map<string, Pep440SpecifierSet[]>();
    const ask = (name: string, ranges: Pep440SpecifierSet[]): void => {
        const entry = core.lock.get(name)!;
        asked.set(name, [...(asked.get(name) ?? []), ...ranges]);
        if (!ranges.every((r) => specifierSetContains(r, entry.version)) && !replaceable(name, ranges)) throw new Stop("lock-too-old", name);
    };

    let first: Node;
    if (core.lock.has(root)) {
        first = resolve(root);
        if (rawVersion !== undefined) ask(root, [[{ op: "==", version: parseVersion(rawVersion)!, prefix: false }]]);
    } else {
        first = pypiNode(root, rawVersion);
    }
    const order: Node[] = [first];
    const seen = new Set([root]);
    // `closure` in pypi.py: depth first, the dependency edge to a lock package checked even when it was seen.
    const walk = (node: Node, depth: number): void => {
        if (depth > VERDICT_BOUNDS.depth) throw new Stop("too-large", node.name);
        const deps = node.kind === "lock" ? node.entry.depends.map(canonicalName) : node.deps;
        for (const d of deps) {
            const ranges = node.kind === "pypi" ? node.specs.get(d) : undefined;
            if (ranges && core.lock.has(d)) ask(d, ranges);
            if (seen.has(d)) continue;
            seen.add(d);
            if (seen.size > VERDICT_BOUNDS.packages) throw new Stop("too-large", d);
            const child = resolve(d);
            order.push(child);
            walk(child, depth + 1);
        }
    };
    walk(first, 1);

    const files: VerdictFile[] = [], loaded: string[] = [];
    let bytes = 0;
    for (const node of order) {
        if (node.kind === "pypi") {
            files.push({ name: node.name, version: node.version, filename: node.file.filename, source: "pypi", sha256: node.file.sha256, size: node.file.size });
            bytes += node.file.size;
        } else if (core.preloaded.has(node.name)) {
            loaded.push(node.name);
        } else {
            const ranges = asked.get(node.name) ?? [];
            if (ranges.every((r) => specifierSetContains(r, node.entry.version))) {
                files.push({ name: node.name, version: node.entry.version, filename: node.entry.file, source: "lock" });
                continue;
            }
            // Each range alone had a replacement; the one installed must sit inside all of them.
            const r = replacement(node.name, ranges);
            if (!r) throw new Stop("lock-too-old", node.name);
            files.push({ name: node.name, version: r.version, filename: r.file.filename, source: "pypi", sha256: r.file.sha256, size: r.file.size });
            bytes += r.file.size;
        }
        if (bytes > VERDICT_BOUNDS.bytes) throw new Stop("too-large", node.name);
    }
    return { ok: true, files, loaded };
}
