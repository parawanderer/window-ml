// effects.ts — the effect algebra: what a call can affect, as a set of (operation, resource) pairs every vocabulary projects onto.
//
// docs/spec/EFFECTS.md. A library manifest, a program manifest, `ml.fetch` and a package install each describe a call in
// their own terms; the projections here turn each into one set, and `free` is the built-in default policy of every
// consumer: the effects are inside what the enforcer at the call's placement bounds, plus reads of non-secret paths
// inside the roots. Pure functions only, no browser API, so every row of the spec's tables is a test.

/** What a call does to a resource: observes it, changes it, starts code there, exercises it unseen, or takes from it. */
export type Op = "read" | "write" | "exec" | "use" | "alloc";

/** Whose heap value a call touches. `{ arg: i }` is a manifest's word; the interpreter resolves it to owned or unowned at
 *  the call (`resolveHeap`), and an unresolved one is inside no bound. */
export type HeapOwner = "owned" | "unowned" | { arg: number };

/** What a call affects. An `fs` path's `inRoot` and `secret` are the host's to resolve: unset means "not vouched for",
 *  which no bound covers. A `net` host of `"*"` is any host. A `secret` is only ever `use`d. `unknown` is the top
 *  element's resource, shown where a list of resources is asked of a set nobody described. */
export type Resource =
    | { kind: "heap"; of: HeapOwner }
    | { kind: "fs"; path: string; inRoot?: boolean; secret?: boolean }
    | { kind: "net"; host: string }
    | { kind: "process" }
    | { kind: "entropy" }
    | { kind: "secret"; name: string }
    | { kind: "unknown" };

/** One (operation, resource) pair. */
export type Effect = { op: Op; res: Resource };

/** A call's effects as stored and sent: the pairs, or `"unknown"` when nobody described the call. */
export type EffectsData = readonly Effect[] | "unknown";

/** What `ANY_HOST` names: a network destination nobody could narrow. */
export const ANY_HOST = "*";

/** The read-only view of a call's effects a policy reads (`c.effects`): set predicates, never a string compare. On the
 *  top element every question answers in the direction that asks: `has` and `uses` are true, and `reads`/`writes`/
 *  `resources` hold the `unknown` resource, so `.every((r) => r.inRoot)` is false. */
export type EffectSet = {
    readonly unknown: boolean;
    readonly pairs: readonly Effect[];
    /** Whether any pair has this operation, and this resource kind when one is named. */
    has(op: Op, kind?: Resource["kind"]): boolean;
    /** Whether the call carries the named secret. */
    uses(name: string): boolean;
    readonly reads: readonly Resource[];
    readonly writes: readonly Resource[];
};

const UNKNOWN_RES: Resource = Object.freeze({ kind: "unknown" });

/** Build the policy-facing view of a call's effects; duplicates are dropped and everything is frozen. */
export function effectSet(data: EffectsData): EffectSet {
    if (data === "unknown") {
        const top = Object.freeze([UNKNOWN_RES]);
        return Object.freeze({ unknown: true, pairs: Object.freeze([]), has: () => true, uses: () => true, reads: top, writes: top });
    }
    const pairs = Object.freeze(dedupe(data).map(freezeEffect));
    const of = (op: Op) => Object.freeze(pairs.filter((e) => e.op === op).map((e) => e.res));
    return Object.freeze({
        unknown: false,
        pairs,
        has: (op: Op, kind?: Resource["kind"]) => pairs.some((e) => e.op === op && (kind === undefined || e.res.kind === kind)),
        uses: (name: string) => pairs.some((e) => e.op === "use" && e.res.kind === "secret" && e.res.name === name),
        reads: of("read"),
        writes: of("write"),
    });
}

/** The union of several calls' effects (a pipe's stages, a fetch plus its secret); any `unknown` makes it `unknown`. */
export function union(...sets: EffectsData[]): EffectsData {
    if (sets.some((s) => s === "unknown")) return "unknown";
    return dedupe((sets as (readonly Effect[])[]).flat());
}

/** A stable key for one pair, for de-duplication and comparison. */
export function effectKey(e: Effect): string {
    const r = e.res;
    switch (r.kind) {
        case "heap": return `${e.op}:heap:${typeof r.of === "string" ? r.of : `arg${r.of.arg}`}`;
        case "fs": return `${e.op}:fs:${r.path}:${r.inRoot ?? "?"}:${r.secret ?? "?"}`;
        case "net": return `${e.op}:net:${r.host.toLowerCase()}`;
        case "secret": return `${e.op}:secret:${r.name}`;
        default: return `${e.op}:${r.kind}`;
    }
}

function dedupe(effects: readonly Effect[]): Effect[] {
    const seen = new Map<string, Effect>();
    for (const e of effects) if (!seen.has(effectKey(e))) seen.set(effectKey(e), e);
    return [...seen.values()];
}

function freezeEffect(e: Effect): Effect {
    const res = typeof (e.res as { of?: unknown }).of === "object"
        ? Object.freeze({ ...e.res, of: Object.freeze({ ...(e.res as { of: { arg: number } }).of }) })
        : Object.freeze({ ...e.res });
    return Object.freeze({ op: e.op, res: res as Resource });
}

/** Turn each `heap(arg i)` into owned or unowned, as the interpreter knows at the call; the rest is unchanged. */
export function resolveHeap(data: EffectsData, ownerOf: (i: number) => "owned" | "unowned"): EffectsData {
    if (data === "unknown") return data;
    return data.map((e) => e.res.kind === "heap" && typeof e.res.of === "object"
        ? { op: e.op, res: { kind: "heap", of: ownerOf(e.res.of.arg) } } : e);
}

// --- projections: each vocabulary's terms onto the algebra (EFFECTS.md, "Each vocabulary is a projection") ---

/** A library manifest's effect term (READONLY_LIBRARY_MANIFEST.md): `pure`, `{ mutates: [i…] }`, `cache`,
 *  `reads-external`, `external` (optionally naming what it reaches), or `callback-outside` for a callback called
 *  outside the interpreter. */
export type LibraryEffect =
    | "pure" | "cache" | "reads-external" | "external" | "callback-outside"
    | { mutates: readonly number[] }
    | { external: readonly Effect[] };

/** Project a library manifest's term for a call with `arity` arguments. `pure` reads each argument; `mutates(i)` writes
 *  argument i; `cache` is nothing observable; `reads-external` reads entropy; `external` is `unknown` unless it names
 *  its effects; a callback called outside the interpreter is `exec(heap(unowned))`, which no bound covers. */
export function fromLibraryEffect(term: LibraryEffect, arity: number): EffectsData {
    const readArgs = (): Effect[] => Array.from({ length: arity }, (_, i) => ({ op: "read", res: { kind: "heap", of: { arg: i } } }));
    if (term === "pure") return readArgs();
    if (term === "cache") return [];
    if (term === "reads-external") return [{ op: "read", res: { kind: "entropy" } }];
    if (term === "external") return "unknown";
    if (term === "callback-outside") return [{ op: "exec", res: { kind: "heap", of: "unowned" } }];
    if ("mutates" in term) return term.mutates.map((i) => ({ op: "write", res: { kind: "heap", of: { arg: i } } }));
    if ("external" in term) return term.external.length ? dedupe(term.external) : "unknown";
    return "unknown";
}

/** A program manifest's effect term (PROGRAM_MANIFEST.md) for one subcommand or flag. `network` names its direction;
 *  absent, it is both, since any outbound request can carry data out. */
export type ProgramEffect =
    | "read" | "write" | "runs-code" | "unknown"
    | { network: { direction?: "read" | "write" | "both" } };

/** What the call resolved for a program term: the concrete path arguments (inRoot/secret from the host, or unset), and
 *  the network destination when the manifest says where it comes from. */
export type ProgramCallFacts = { paths?: readonly Resource[]; host?: string };

/** Project a program manifest's term over one call's facts. `read`/`write` touch each path argument and nothing else;
 *  `runs-code` is `exec(process)`; `network` reads and/or writes the named host, or any host when none is named. */
export function fromProgramEffect(term: ProgramEffect, facts: ProgramCallFacts = {}): EffectsData {
    if (term === "unknown") return "unknown";
    if (term === "runs-code") return [{ op: "exec", res: { kind: "process" } }];
    if (term === "read" || term === "write") {
        const paths = (facts.paths ?? []).filter((p) => p.kind === "fs");
        return paths.map((p) => ({ op: term, res: p }));
    }
    const res: Resource = { kind: "net", host: facts.host || ANY_HOST };
    const dir = term.network.direction ?? "both";
    const ops: Op[] = dir === "both" ? ["read", "write"] : [dir];
    return ops.map((op) => ({ op, res }));
}

/** What an `ml.fetch` call resolved: whether a cached copy answers it, the URL, the method, and a secret handle. */
export type FetchFacts = { url: string; cached?: boolean; method?: string; secret?: string };

/** Project an `ml.fetch` call. A cached read is nothing; a live GET/HEAD reads the URL's host; any other method also
 *  writes it; a secret handle adds `use(secret(name))`. A URL with no host is `unknown`. */
export function fromFetch(f: FetchFacts): EffectsData {
    const effects: Effect[] = [];
    if (!f.cached) {
        let host: string;
        try { host = new URL(f.url).hostname.toLowerCase(); } catch { return "unknown"; }
        if (!host) return "unknown";
        const method = (f.method ?? "GET").toUpperCase();
        effects.push({ op: "read", res: { kind: "net", host } });
        if (method !== "GET" && method !== "HEAD") effects.push({ op: "write", res: { kind: "net", host } });
    }
    if (f.secret) effects.push({ op: "use", res: { kind: "secret", name: f.secret } });
    return effects;
}

/** What a package install resolved: the index it downloads from, and where it installs (the host resolves the path). */
export type InstallFacts = { indexHost: string; sitePackages: Resource & { kind: "fs" } };

/** Project a package install: it reads the index, and writes into and takes storage from site-packages. */
export function fromInstall(f: InstallFacts): EffectsData {
    return [
        { op: "read", res: { kind: "net", host: f.indexHost.toLowerCase() } },
        { op: "write", res: f.sitePackages },
        { op: "alloc", res: f.sitePackages },
    ];
}

// --- bounds and the free tier (EFFECTS.md, "What an enforcer bounds") ---

/** A resource class an enforcer bounds: owned heap, any path inside the roots (or a container's mounts, which the host
 *  resolves as `inRoot`), a network host or `"*"`, processes, entropy. */
export type BoundResource =
    | { kind: "heap"; of: "owned" }
    | { kind: "fs"; within: "roots" }
    | { kind: "net"; host: string }
    | { kind: "process" }
    | { kind: "entropy" };

/** One (operation, resource class) pair an enforcer makes harmless or impossible. */
export type BoundPair = { op: Op; res: BoundResource };

/** Where a call runs, which decides the enforcer and so the bound. */
export type Placement = "main-world" | "worker-survey" | "python-dialect" | "container" | "host-sandbox" | "host-plain";

/** What the bound of a placement depends on: whether the dialect allows `read(entropy)`, and the network allowlist of a
 *  container or the OS sandbox. */
export type BoundOptions = { entropy?: boolean; netAllowlist?: readonly string[] };

/** The set `B` the enforcer at a placement publishes. Nothing in the page's main world, a worker survey or on the plain
 *  host; the Python dialect's runtime gates bound owned heap (and entropy when allowed); a container and the OS sandbox
 *  bound reads and writes inside their roots, starting processes inside, and the allowlisted hosts. */
export function boundFor(placement: Placement, opts: BoundOptions = {}): readonly BoundPair[] {
    switch (placement) {
        case "main-world": case "worker-survey": case "host-plain": return [];
        case "python-dialect": {
            const heap: BoundPair[] = (["read", "write", "alloc"] as const).map((op) => ({ op, res: { kind: "heap", of: "owned" } }));
            return opts.entropy ? [...heap, { op: "read", res: { kind: "entropy" } }] : heap;
        }
        case "container": case "host-sandbox": {
            const net: BoundPair[] = (opts.netAllowlist ?? []).flatMap((host) =>
                (["read", "write"] as const).map((op) => ({ op, res: { kind: "net", host: host.toLowerCase() } })));
            return [
                { op: "read", res: { kind: "fs", within: "roots" } },
                { op: "write", res: { kind: "fs", within: "roots" } },
                { op: "exec", res: { kind: "process" } },
                ...net,
            ];
        }
    }
}

/** Whether one bound pair covers one effect. A path the host has not resolved, an unresolved `heap(arg i)` and a
 *  secret-flagged path are covered by nothing; `net` matches the host exactly, or any host under a `"*"` bound. A
 *  secret path is outside every bound, the sandbox and a container included: the harm of reading it is disclosure to
 *  the model, the run log and the export, which no enforcer bounds. */
export function covers(b: BoundPair, e: Effect): boolean {
    if (b.op !== e.op || b.res.kind !== e.res.kind) return false;
    const r = e.res, br = b.res;
    switch (r.kind) {
        case "heap": return r.of === "owned" && br.kind === "heap";
        case "fs": return r.inRoot === true && r.secret !== true && br.kind === "fs";
        case "net":
            if (br.kind !== "net") return false;
            return br.host === ANY_HOST || (r.host !== ANY_HOST && br.host === r.host.toLowerCase());
        case "process": case "entropy": return true;
        default: return false;
    }
}

/** Whether an effect is a read of a path the host resolved inside the roots and did not flag secret (`ReadsInRoots`). */
export function isReadInRoots(e: Effect): boolean {
    return e.op === "read" && e.res.kind === "fs" && e.res.inRoot === true && e.res.secret !== true;
}

/** The built-in default policy of every consumer: `effects ⊆ bound ∪ ReadsInRoots`. `unknown` is inside no bound,
 *  the empty one included; the empty set is inside every bound. */
export function free(effects: EffectsData, bound: readonly BoundPair[]): boolean {
    if (effects === "unknown") return false;
    return effects.every((e) => isReadInRoots(e) || bound.some((b) => covers(b, e)));
}
