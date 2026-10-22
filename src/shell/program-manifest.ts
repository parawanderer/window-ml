// program-manifest.ts — what a program manifest says (docs/spec/PROGRAM_MANIFEST.md), its validator, and describeCall: one argv in, the facts a policy sees out.

// A manifest DESCRIBES a program, per subcommand and flag; it never decides (docs/spec/POLICIES.md decides). Every flag
// a manifest does not list makes the call `unknown`: the flags that change what a program does are enumerated, never
// sampled. The same JSON is read by the process host (window-ml-host), which resolves the path arguments this module
// names; the fixtures under tests/fixtures/program-calls/ are the vectors both readers are held to.

import { union, fromProgramEffect, type EffectsData, type ProgramEffect, type Resource } from "../effects";

/** One flag of a command: whether it takes a value, and what it adds to the call. A flag absent from its command's
 *  table makes the call `unknown`. */
export type FlagSpec = {
    /** Takes one value: `--f=v`, `--f v`, `-fv` or `-f v`. */
    value?: boolean;
    /** Takes a value only in the attached form (`--color=always`); the bare flag is also valid. */
    optionalValue?: boolean;
    /** Effects the flag adds, in the program-manifest vocabulary. */
    effects?: readonly ProgramEffect[];
    /** The flag's value is a path the program reads or writes (`--output=f`, `--contents f`). */
    valueIsPath?: "read" | "write";
    /** The flag's value is the directory the command acts in, instead of the cwd (`git -C dir`). */
    valueIsDir?: boolean;
    /** With this flag, path operands start at this index instead of the command's own (`rg -e pat a b`: 0). */
    pathsFrom?: number;
    /** It starts another program (`find -exec`, `git -c core.pager=…`): never free on the program's word. */
    runner?: boolean;
    /** It prints the environment or its inputs back (`curl -v`). */
    echoes?: boolean;
    /** Exit codes that become answers with this flag (`git diff --exit-code`: 1). */
    okCodes?: readonly number[];
    /** With this flag the command walks its directory arguments (`ls -R`). */
    recursive?: boolean;
};

/** A `find`-style expression primary: how many arguments it consumes (or up to which terminator), and what it adds. */
export type PrimarySpec = {
    /** Arguments consumed after the primary. */
    args?: number;
    /** Consumes arguments up to and including one of these (`-exec … ;` or `+`). */
    until?: readonly string[];
    effects?: readonly ProgramEffect[];
    /** Its (first) argument is a path the program reads or writes (`-newer f`, `-fprint f`). */
    argIsPath?: "read" | "write";
    runner?: boolean;
};

/** A program or one of its subcommands. */
export type CommandSpec = {
    /** What the command does with no flags, applied to its path targets. */
    effects: readonly ProgramEffect[];
    /** Which operands are paths: none, all, all from an index on, or the repository (the cwd, or a `valueIsDir` flag's value). */
    paths: "none" | "operands" | { operandsFrom: number } | "repo";
    /** What the command touches when it is given no path operand: the cwd (`ls`, `rg`), or nothing (stdin: `cat`). */
    noPaths?: "cwd" | "nothing";
    /** The end-of-options marker the command honours, where the host puts it before a value from a variable. */
    terminator?: "--" | "--end-of-options" | null;
    /** Accepts `-<n>` as a number (`head -20`, `git log -5`). */
    numericFlag?: boolean;
    /** Short flags combine (`ls -la`). */
    clusters?: boolean;
    /** At most this many operands; more makes the call `unknown` (`git branch` lists with none, creates with one). */
    maxOperands?: number;
    flags: Readonly<Record<string, FlagSpec>>;
    /** The first operand selects one; an unlisted one makes the call `unknown`. */
    subcommands?: Readonly<Record<string, CommandSpec>>;
    /** A grammar other than options-then-operands. */
    syntax?: "find";
    /** For `syntax: "find"`: every primary and operator; an unlisted one makes the call `unknown`. */
    primaries?: Readonly<Record<string, PrimarySpec>>;
    okCodes?: readonly number[];
    echoes?: boolean;
    /** It walks its directory arguments (`rg`, `find`): the host checks what is beneath them for secrets. */
    recursive?: boolean;
    /** GNU permutes options and operands (`rm a -r` is recursive); BSD stops at the first operand (`rm a -r` removes two
     *  files). An argument starting with `-` after an operand, `--` included, makes the call `unknown`. */
    optionsFirst?: boolean;
    /** A lone `-` is a FILE NAME here (`rm -` removes the file `-`), not stdin: it stays a path operand. */
    dashIsPath?: boolean;
    /** The command may reach anything in its repository, whatever its operands say (`git rm` removes the parent
     *  directories it empties; `git mv` creates names under a directory): its effects also fall on the directory it
     *  acts in and on the repository's root (`resolve({arg: "repo"})`). */
    repoWide?: boolean;
    /** Operands are git pathspecs: one that starts with `:` (magic; `:/x` is relative to the repository root, not to
     *  the cwd), or holds `*`, `?`, `[` or `\` (a glob git expands to every match, or an escape), is not one path the
     *  host can resolve, so the call is `unknown`. */
    pathspecs?: boolean;
    /** Arguments the caller inserts right after this command's name, turning off what the repository's own config could
     *  make it run (`git` → `--no-pager`; `git diff` → `--no-ext-diff --no-textconv`). They never widen a call. */
    harden?: readonly string[];
};

/** What every program manifest says: the program, how it exits, and its command tree. */
interface ManifestBase {
    program: string;
    okCodes?: readonly number[];
    echoes?: boolean;
    /** Environment variables that change what the program does: a call setting one is not described. */
    env?: readonly string[];
    command: CommandSpec;
}

/** The version range a binary's manifest was written against (`>=2.30.0 <3`) and how the host reads the version
 *  (`args`, a regex whose group 1 is it). `"*"` with no `args` is a program that reports no version (BSD `ls`,
 *  `find`): its manifest then lists only flags whose meaning is the same in every implementation. */
export type ManifestVersion = { range: string; args: readonly string[]; pattern: string };

/** An interpreted script's pin (`node scripts/index.mjs`): `path` relative to a workspace root, `sha256` of the
 *  resolved file. */
export type ManifestEntrypoint = { path: string; sha256: string };

/**
 * A program manifest: a standalone binary pinned by a `version` range, or an interpreted script pinned by its
 * `entrypoint`'s sha256, never both (PROGRAM_MANIFEST.md, "Interpreted script tools"). A script's `program` is the
 * interpreter; the call matches only when `argv[1]` is the script with no interpreter flag before it, and its options
 * parse from `argv[2]`. The interpreter's own version is not read: the manifest describes the script.
 */
export type ProgramManifest = ManifestBase & (
    | { version: ManifestVersion; entrypoint?: undefined }
    | { entrypoint: ManifestEntrypoint; version?: undefined });

/** A path the host is asked to resolve: argv index, and the separator to split on when the path is a flag's attached
 *  value (`--output=f`). The shape of the host's `pathArgs` entries (window-ml-host docs/PROTOCOL.md). */
export type PathArg = { arg: number; split?: string; role: "read" | "write"; walk?: true };

/** What describeCall finds in one argv: the facts a policy is given, before the host resolves the paths. */
export type CallDescription = {
    /** False when anything in the call is outside the manifest; `effects` is then `"unknown"` and `why` says what. */
    described: boolean;
    why: string[];
    program: string;
    /** The subcommand path (`["diff"]`), empty for a program without subcommands. */
    subcommand: string[];
    effects: EffectsData;
    /** The arguments the host resolves (`realpath`, `inRoot`, `secret`). */
    pathArgs: PathArg[];
    /** The command acts on its directory (a repository, or `ls` with no operand): the cwd, or `dirArg`'s value. */
    actsOnDir: boolean;
    /** The argv index of a `valueIsDir` flag's value, when one was given. */
    dirArg: number | null;
    /** The call walks directories (`rg`, `find`, `ls -R`): its path operands carry `walk`, and when it acts on its
     *  directory, that directory is walked too. The host answers `containsSecret` for each. */
    recursive: boolean;
    /** Where `hardenArgv` inserts the manifest's hardening arguments: after argv index `at`. */
    harden: { at: number; args: string[] }[];
    /** Where operands start (the host puts the terminator there before a value from a variable), or null if none. */
    operandStart: number | null;
    terminator: "--" | "--end-of-options" | null;
    runner: boolean;
    echoes: boolean;
    okCodes: number[];
};

/** How describeCall turns a path into a resource: the host's resolution once it has one, otherwise the path as given
 *  with `inRoot` and `secret` unset (covered by no bound). `dir` names the directory the command acts in. */
export type DescribeOptions = {
    /** The version the host recorded for the resolved program; absent means not reported, which is `unknown`. */
    version?: string;
    /** The call's environment changes, by name. */
    envSet?: readonly string[];
    resolve?: (p: { arg: number | "cwd" | "repo"; given: string }) => Resource;
};

const unresolved = (p: { arg: number | "cwd" | "repo"; given: string }): Resource => ({ kind: "fs", path: p.given });

/** Describes one argv by its program's manifest. `argv[0]` is the program as the caller wrote it; its basename must
 *  name the manifest's program. */
export function describeCall(argv: readonly string[], m: ProgramManifest, opts: DescribeOptions = {}): CallDescription {
    const d: CallDescription = {
        described: true, why: [], program: m.program, subcommand: [], effects: [], pathArgs: [], actsOnDir: false,
        dirArg: null, recursive: false, harden: [], operandStart: null, terminator: null, runner: false, echoes: !!m.echoes, okCodes: [...(m.okCodes ?? [0])],
    };
    const unknown = (why: string) => { d.described = false; d.why.push(why); };
    const base = (argv[0] ?? "").split("/").pop();
    if (base !== m.program) unknown(`argv[0] ${JSON.stringify(argv[0])} is not ${m.program}`);
    if (m.entrypoint || m.version.range === "*") { /* pinned by its hash (shFacts), or written for every implementation */ }
    else if (opts.version === undefined) unknown("the program's version was not reported");
    else if (!inRange(opts.version, m.version.range)) unknown(`version ${opts.version} is outside ${m.version.range}`);
    for (const n of opts.envSet ?? []) if ((m.env ?? []).includes(n)) unknown(`the call sets ${n}, which changes what ${m.program} does`);
    // An interpreted script: argv[1] is the script itself. Any interpreter flag before it (`-u`, `-X dev`, `--import`,
    // even `--`) changes what runs, so the call is not this manifest's.
    const ep = m.entrypoint;
    if (ep && (argv.length < 2 || argv[1].startsWith("-"))) unknown(`${m.program} is described only as ${m.program} ${ep.path}, with no interpreter flag before it`);

    const terms: { term: ProgramEffect; targets: "command" | Resource[] }[] = [];
    let cmd = m.command;
    let i = ep ? 2 : 1;
    let operandPaths: number[] = [];
    if (cmd.harden?.length) d.harden.push({ at: i - 1, args: [...cmd.harden] });
    // Descend through subcommands: options before a subcommand belong to the level above it.
    for (;;) {
        const r = cmd.syntax === "find" ? parseFind(argv, i, cmd, d, terms, unknown) : parseOptions(argv, i, cmd, d, terms, unknown);
        if (!r.sub) { operandPaths = finishCommand(argv, cmd, r.operands, r.pathsFrom, d, terms, unknown); break; }
        const next = cmd.subcommands?.[argv[r.sub]];
        if (!next) { unknown(`${[m.program, ...d.subcommand].join(" ")} has no subcommand ${JSON.stringify(argv[r.sub])} in its manifest`); break; }
        d.subcommand.push(argv[r.sub]);
        if (next.harden?.length) d.harden.push({ at: r.sub, args: [...next.harden] });
        cmd = next;
        i = r.sub + 1;
    }
    if (cmd.recursive) d.recursive = true;
    if (d.recursive) for (const p of d.pathArgs) if (operandPaths.includes(p.arg)) p.walk = true;
    if (cmd.okCodes) d.okCodes = [...new Set([...cmd.okCodes, ...d.okCodes.filter((c) => c !== 0)])];
    if (cmd.echoes) d.echoes = true;

    if (!d.described) { d.effects = "unknown"; return d; }
    const resolve = opts.resolve ?? unresolved;
    const repoWide = cmd.repoWide === true;
    const dirRes = (): Resource => d.dirArg !== null ? resolve({ arg: d.dirArg, given: argv[d.dirArg] }) : resolve({ arg: "cwd", given: "." });
    const commandTargets: Resource[] = [
        ...operandPaths.map((i) => resolve({ arg: i, given: argv[i] })),
        ...(d.actsOnDir ? [dirRes()] : []),
        ...(repoWide ? [dirRes(), resolve({ arg: "repo", given: "." })] : []),
    ];
    const sets: EffectsData[] = [];
    for (const t of terms) {
        const targets = t.targets === "command" ? commandTargets : t.targets.map((r) => r.kind === "fs" && r.path.startsWith("\0arg:")
            ? resolveArg(r.path, argv, resolve) : r);
        sets.push(fromProgramEffect(t.term, { paths: targets }));
    }
    d.effects = union(...sets);
    return d;
}

/** A placeholder resource for argv index `i` (optionally after a separator), resolved once parsing is done. */
function argRes(i: number, split?: string): Resource {
    return { kind: "fs", path: `\0arg:${i}:${split ?? ""}` };
}

function resolveArg(ph: string, argv: readonly string[], resolve: NonNullable<DescribeOptions["resolve"]>): Resource {
    const [, n, split] = ph.split(":");
    const i = Number(n);
    const given = split ? argv[i].slice(argv[i].indexOf(split) + split.length) : argv[i];
    return resolve({ arg: i, given });
}

/** The argv with the manifest's hardening arguments inserted (`git --no-pager diff --no-ext-diff --no-textconv …`),
 *  skipping any already present. What the person approves and the host runs is this argv, and it describes exactly
 *  as the original does. */
export function hardenArgv(argv: readonly string[], d: CallDescription): string[] {
    const out = [...argv];
    for (const h of [...d.harden].sort((a, b) => b.at - a.at)) {
        const add = h.args.filter((a) => !argv.includes(a));
        out.splice(h.at + 1, 0, ...add);
    }
    return out;
}

type Terms = { term: ProgramEffect; targets: "command" | Resource[] }[];

/** Options-then-operands. Returns the operand indices, the path start a flag set, and the index of a subcommand name
 *  when the command has subcommands and one was reached before any operand. */
function parseOptions(argv: readonly string[], start: number, cmd: CommandSpec, d: CallDescription, terms: Terms,
    unknown: (w: string) => void): { operands: number[]; pathsFrom?: number; sub?: number } {
    const operands: number[] = [];
    let pathsFrom: number | undefined;
    let afterTerminator = false;
    const apply = (name: string, f: FlagSpec, valueAt: { arg: number; split?: string; attached?: boolean } | null) => {
        if (f.effects?.includes("unknown")) unknown(`${name} can make ${d.program} do what no manifest describes`);
        // A flag's read/write/write-names applies to its own path value when it has one (`--output=f`), else to the command's
        // targets (`git push -u` writes the repository's config).
        for (const t of f.effects ?? []) {
            if (f.valueIsPath && (t === "read" || t === "write" || t === "write-names")) continue;
            terms.push({ term: t, targets: "command" });
        }
        if (f.valueIsPath && valueAt) {
            if (valueAt.attached) unknown(`${name}'s path is attached to a short flag; pass it as its own argument`);
            else {
                d.pathArgs.push({ arg: valueAt.arg, ...(valueAt.split ? { split: valueAt.split } : {}), role: f.valueIsPath });
                terms.push({ term: f.valueIsPath, targets: [argRes(valueAt.arg, valueAt.split)] });
                if (f.effects?.includes("write-names")) terms.push({ term: "write-names", targets: [argRes(valueAt.arg, valueAt.split)] });
            }
        }
        if (f.valueIsDir && valueAt) {
            if (valueAt.attached || valueAt.split) unknown(`${name}'s directory must be its own argument`);
            else { d.dirArg = valueAt.arg; d.pathArgs.push({ arg: valueAt.arg, role: "read" }); }
        }
        if (f.pathsFrom !== undefined) pathsFrom = f.pathsFrom;
        if (f.runner) d.runner = true;
        if (f.echoes) d.echoes = true;
        if (f.recursive) d.recursive = true;
        if (f.okCodes) d.okCodes = [...new Set([...d.okCodes, ...f.okCodes])];
    };
    for (let i = start; i < argv.length; i++) {
        const a = argv[i];
        if (afterTerminator) {
            if (cmd.pathspecs && notLiteralPathspec(a)) unknown(`pathspec ${JSON.stringify(a)} is magic or a glob, not a path`);
            operands.push(i);
            continue;
        }
        if (cmd.optionsFirst && operands.length > 0 && a !== "-" && a.startsWith("-")) {
            unknown(`${a} follows an operand: GNU reads it as an option, BSD as a file name`);
            continue;
        }
        if (a === "--" || a === "--end-of-options") {
            if (cmd.terminator === a || (a === "--" && cmd.terminator === "--end-of-options")) { afterTerminator = true; continue; }
            unknown(`${a} is not a terminator this command honours`);
            continue;
        }
        if (a === "-" || !a.startsWith("-")) {
            if (cmd.subcommands && operands.length === 0) return { operands, pathsFrom, sub: i };
            if (cmd.pathspecs && notLiteralPathspec(a)) unknown(`pathspec ${JSON.stringify(a)} is magic or a glob, not a path`);
            operands.push(i);
            continue;
        }
        if (cmd.numericFlag && /^-\d+$/.test(a)) continue;
        if (a.startsWith("--")) {
            const eq = a.indexOf("=");
            const name = eq < 0 ? a : a.slice(0, eq);
            const f = cmd.flags[name];
            if (!f) { unknown(`flag ${name} is not in the manifest`); continue; }
            if (f.value) {
                if (eq >= 0) apply(name, f, { arg: i, split: "=" });
                else if (i + 1 < argv.length) { apply(name, f, { arg: i + 1 }); i++; }
                else unknown(`${name} needs a value`);
            } else if (eq >= 0) {
                if (f.optionalValue) apply(name, f, null);
                else unknown(`${name} takes no value`);
            } else apply(name, f, null);
            continue;
        }
        // A single-dash flag: a whole name first (`-C`, `-name`), then a cluster of one-letter flags.
        const whole = cmd.flags[a];
        if (whole) {
            if (whole.value) {
                if (i + 1 < argv.length) { apply(a, whole, { arg: i + 1 }); i++; }
                else unknown(`${a} needs a value`);
            } else apply(a, whole, null);
            continue;
        }
        const letters = a.slice(1);
        for (let j = 0; j < letters.length; j++) {
            const name = `-${letters[j]}`;
            const f = cmd.flags[name];
            if (!f) { unknown(`flag ${name}${letters.length > 1 ? ` (in ${a})` : ""} is not in the manifest`); break; }
            if (j > 0 && !cmd.clusters) { unknown(`${a}: this command's short flags do not combine`); break; }
            if (f.value) {
                if (j + 1 < letters.length) apply(name, f, { arg: i, attached: true });
                else if (i + 1 < argv.length) { apply(name, f, { arg: i + 1 }); i++; }
                else unknown(`${name} needs a value`);
                break;
            }
            apply(name, f, null);
        }
    }
    return { operands, pathsFrom };
}

/** find's grammar: options, then path operands up to the first expression token, then primaries and operators. */
function parseFind(argv: readonly string[], start: number, cmd: CommandSpec, d: CallDescription, terms: Terms,
    unknown: (w: string) => void): { operands: number[]; pathsFrom?: number; sub?: number } {
    const operands: number[] = [];
    let i = start;
    while (i < argv.length && /^-[HLPEXdsx]+$/.test(argv[i]) && cmd.flags[argv[i]]) {
        const f = cmd.flags[argv[i]];
        if (f.effects?.includes("unknown")) unknown(`${argv[i]} can make find do what no manifest describes`);
        for (const t of f.effects ?? []) terms.push({ term: t, targets: "command" });
        i++;
    }
    while (i < argv.length && !argv[i].startsWith("-") && !["(", ")", "!", ","].includes(argv[i])) operands.push(i++);
    const prims = cmd.primaries ?? {};
    for (; i < argv.length; i++) {
        const a = argv[i];
        const p = prims[a];
        if (!p) { unknown(`find expression ${JSON.stringify(a)} is not in the manifest`); break; }
        if (p.effects?.includes("unknown")) unknown(`${a} can make find do what no manifest describes`);
        for (const t of p.effects ?? []) {
            if (p.argIsPath && (t === "read" || t === "write" || t === "write-names")) continue;
            terms.push({ term: t, targets: "command" });
        }
        if (p.runner) d.runner = true;
        if (p.until) {
            let k = i + 1;
            while (k < argv.length && !p.until.includes(argv[k])) k++;
            if (k >= argv.length) { unknown(`${a} is not terminated by ${p.until.join(" or ")}`); break; }
            i = k;
            continue;
        }
        const n = p.args ?? 0;
        if (i + n >= argv.length) { unknown(`${a} needs ${n} argument${n === 1 ? "" : "s"}`); break; }
        if (p.argIsPath && n > 0) {
            d.pathArgs.push({ arg: i + 1, role: p.argIsPath });
            terms.push({ term: p.argIsPath, targets: [argRes(i + 1)] });
            if (p.effects?.includes("write-names")) terms.push({ term: "write-names", targets: [argRes(i + 1)] });
        }
        i += n;
    }
    return { operands };
}

/** After parsing a command: its path operands (returned; `-` is stdin, not a path), what it acts on without them, and its
 *  own effects over those targets. */
function finishCommand(argv: readonly string[], cmd: CommandSpec, operands: number[], pathsFrom: number | undefined, d: CallDescription,
    terms: Terms, unknown: (w: string) => void): number[] {
    if (cmd.maxOperands !== undefined && operands.length > cmd.maxOperands) unknown(`more than ${cmd.maxOperands} operand(s)`);
    d.operandStart = operands.length ? operands[0] : null;
    d.terminator = cmd.terminator ?? null;
    let paths: number[] = [];
    if (cmd.paths === "operands") paths = operands;
    else if (typeof cmd.paths === "object") paths = operands.slice(pathsFrom ?? cmd.paths.operandsFrom);
    if (!cmd.dashIsPath) paths = paths.filter((i) => argv[i] !== "-");
    for (const i of paths) d.pathArgs.push({ arg: i, role: "read" });
    d.actsOnDir = cmd.paths === "repo" || (paths.length === 0 && cmd.noPaths === "cwd" && cmd.paths !== "none");
    if (d.dirArg !== null && cmd.paths !== "repo" && !cmd.repoWide) unknown("a directory flag on a command that does not act on a repository");
    if (cmd.effects.includes("unknown")) unknown(`${[d.program, ...d.subcommand].join(" ")} is described as unknown`);
    for (const t of cmd.effects) terms.push({ term: t, targets: "command" });
    return paths;
}

// --- versions ---

/** Whether a dotted version satisfies a range of space-separated comparators (`>=2.30.0 <3`), all of which must hold. */
export function inRange(version: string, range: string): boolean {
    const v = parseVersion(version);
    if (!v) return false;
    return range.trim().split(/\s+/).every((c) => {
        const m = /^(>=|<=|>|<|=)?(\d+(?:\.\d+)*)$/.exec(c);
        if (!m) return false;
        const cmp = compareVersions(v, parseVersion(m[2])!);
        switch (m[1] ?? "=") {
            case ">=": return cmp >= 0;
            case "<=": return cmp <= 0;
            case ">": return cmp > 0;
            case "<": return cmp < 0;
            default: return cmp === 0;
        }
    });
}

function parseVersion(s: string): number[] | null {
    return /^\d+(\.\d+)*$/.test(s) ? s.split(".").map(Number) : null;
}

function compareVersions(a: number[], b: number[]): number {
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
        const d = (a[i] ?? 0) - (b[i] ?? 0);
        if (d) return Math.sign(d);
    }
    return 0;
}

// --- the validator ---

const PROGRAM_EFFECT_WORDS = new Set(["read", "write", "write-names", "runs-code", "unknown"]);
const FLAG_KEYS = new Set(["value", "optionalValue", "effects", "valueIsPath", "valueIsDir", "pathsFrom", "runner", "echoes", "okCodes", "recursive"]);
const PRIMARY_KEYS = new Set(["args", "until", "effects", "argIsPath", "runner"]);
/** Whether git may read a pathspec as something other than the one path it spells: `:` magic, or a glob or escape git expands. */
function notLiteralPathspec(a: string): boolean {
    return a.startsWith(":") || /[*?[\\]/.test(a);
}

const COMMAND_KEYS = new Set(["effects", "paths", "noPaths", "terminator", "numericFlag", "clusters", "maxOperands", "flags", "subcommands", "syntax", "primaries", "okCodes", "echoes", "recursive", "harden", "optionsFirst", "dashIsPath", "repoWide", "pathspecs"]);
const MANIFEST_KEYS = new Set(["program", "version", "okCodes", "echoes", "env", "entrypoint", "command"]);

/** Checks a parsed manifest against the format above; returns every problem, with its JSON path. Unknown keys are
 *  problems, so a misspelt `runer` cannot silently drop a runner flag. */
export function validateManifest(m: unknown): string[] {
    const errs: string[] = [];
    const isObj = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);
    const keys = (o: Record<string, unknown>, allowed: Set<string>, at: string) => {
        for (const k of Object.keys(o)) if (!allowed.has(k)) errs.push(`${at}: unknown key ${k}`);
    };
    const effects = (x: unknown, at: string) => {
        if (!Array.isArray(x)) return errs.push(`${at}: effects is an array`);
        x.forEach((t, i) => {
            if (typeof t === "string" ? PROGRAM_EFFECT_WORDS.has(t) : isObj(t) && Object.keys(t).length === 1 && isObj(t.network)
                && Object.keys(t.network).every((k) => k === "direction") && [undefined, "read", "write", "both"].includes(t.network.direction as string)) return;
            errs.push(`${at}[${i}]: not a program effect: ${JSON.stringify(t)}`);
        });
    };
    const codes = (x: unknown, at: string) => {
        if (!Array.isArray(x) || !x.every((c) => Number.isInteger(c) && c >= 0 && c < 256)) errs.push(`${at}: exit codes are integers 0-255`);
    };
    const command = (c: unknown, at: string) => {
        if (!isObj(c)) return errs.push(`${at}: a command is an object`);
        keys(c, COMMAND_KEYS, at);
        effects(c.effects, `${at}.effects`);
        const p = c.paths;
        if (!(p === "none" || p === "operands" || p === "repo" || (isObj(p) && Number.isInteger(p.operandsFrom) && Object.keys(p).length === 1))) errs.push(`${at}.paths: none, operands, repo or {operandsFrom}`);
        if (c.noPaths !== undefined && c.noPaths !== "cwd" && c.noPaths !== "nothing") errs.push(`${at}.noPaths: cwd or nothing`);
        if (![undefined, null, "--", "--end-of-options"].includes(c.terminator as string)) errs.push(`${at}.terminator`);
        if (c.harden !== undefined && !(Array.isArray(c.harden) && c.harden.every((a) => typeof a === "string" && isObj(c.flags) && a in (c.flags as object))))
            errs.push(`${at}.harden: flags this command lists, so hardening never makes a call unknown`);
        for (const b of ["numericFlag", "clusters", "echoes", "recursive", "optionsFirst", "dashIsPath", "repoWide", "pathspecs"]) if (c[b] !== undefined && typeof c[b] !== "boolean") errs.push(`${at}.${b}: boolean`);
        if (c.maxOperands !== undefined && !(Number.isInteger(c.maxOperands) && (c.maxOperands as number) >= 0)) errs.push(`${at}.maxOperands`);
        if (c.okCodes !== undefined) codes(c.okCodes, `${at}.okCodes`);
        if (!isObj(c.flags)) errs.push(`${at}.flags: an object`);
        else for (const [name, f] of Object.entries(c.flags)) {
            const fa = `${at}.flags[${name}]`;
            if (!/^-{1,2}[A-Za-z0-9][A-Za-z0-9-]*$/.test(name)) errs.push(`${fa}: a flag name starts with - or --`);
            if (!isObj(f)) { errs.push(`${fa}: an object`); continue; }
            keys(f, FLAG_KEYS, fa);
            if (f.effects !== undefined) effects(f.effects, `${fa}.effects`);
            if (f.value && f.optionalValue) errs.push(`${fa}: value and optionalValue exclude each other`);
            if ((f.valueIsPath || f.valueIsDir) && !f.value) errs.push(`${fa}: a path or directory value needs value: true`);
            if (f.valueIsPath !== undefined && f.valueIsPath !== "read" && f.valueIsPath !== "write") errs.push(`${fa}.valueIsPath: read or write`);
            if (f.okCodes !== undefined) codes(f.okCodes, `${fa}.okCodes`);
            if (f.runner && !(Array.isArray(f.effects) && f.effects.some((t) => t === "runs-code" || t === "unknown"))) errs.push(`${fa}: a runner's effects include runs-code or unknown`);
        }
        if (c.subcommands !== undefined) {
            if (!isObj(c.subcommands)) errs.push(`${at}.subcommands: an object`);
            else for (const [n, s] of Object.entries(c.subcommands)) command(s, `${at}.subcommands.${n}`);
        }
        if (c.syntax !== undefined && c.syntax !== "find") errs.push(`${at}.syntax: find`);
        if (c.syntax === "find") {
            if (!isObj(c.primaries)) errs.push(`${at}.primaries: find syntax needs its primaries`);
            else for (const [n, pr] of Object.entries(c.primaries)) {
                const pa = `${at}.primaries[${n}]`;
                if (!isObj(pr)) { errs.push(`${pa}: an object`); continue; }
                keys(pr, PRIMARY_KEYS, pa);
                if (pr.effects !== undefined) effects(pr.effects, `${pa}.effects`);
                if (pr.args !== undefined && !(Number.isInteger(pr.args) && (pr.args as number) >= 0)) errs.push(`${pa}.args`);
                if (pr.argIsPath !== undefined && !(pr.args as number > 0)) errs.push(`${pa}: argIsPath needs args >= 1`);
                if (pr.runner && !(Array.isArray(pr.effects) && pr.effects.some((t) => t === "runs-code" || t === "unknown"))) errs.push(`${pa}: a runner's effects include runs-code or unknown`);
            }
        } else if (c.primaries !== undefined) errs.push(`${at}.primaries: only with syntax find`);
    };
    if (!isObj(m)) return ["a manifest is an object"];
    keys(m, MANIFEST_KEYS, "$");
    if (typeof m.program !== "string" || !/^[A-Za-z0-9._+-]+$/.test(m.program)) errs.push("$.program: a program name");
    const v = m.version;
    if (m.entrypoint !== undefined && v === undefined) { /* pinned by its hash, checked below */ }
    else if (!isObj(v) || typeof v.range !== "string" || !Array.isArray(v.args) || typeof v.pattern !== "string") errs.push("$.version: {range, args, pattern}");
    else {
        if (v.range === "*") { if (v.args.length || v.pattern) errs.push("$.version: a \"*\" range reads no version (args [], pattern \"\")"); }
        else if (!v.range.trim().split(/\s+/).every((c) => /^(>=|<=|>|<|=)?\d+(\.\d+)*$/.test(c))) errs.push("$.version.range: comparators like >=2.30.0 <3");
        try { new RegExp(v.pattern); } catch { errs.push("$.version.pattern: a regex"); }
        if (v.range !== "*" && !(v.args.length && v.pattern)) errs.push("$.version: a range needs the args and pattern that read it");
    }
    if (m.entrypoint !== undefined) {
        const e = m.entrypoint;
        if (!isObj(e) || typeof e.path !== "string" || typeof e.sha256 !== "string" || Object.keys(e).length !== 2) errs.push("$.entrypoint: {path, sha256}");
        else {
            if (!e.path || e.path.startsWith("/") || e.path.startsWith("-") || e.path.split("/").some((c) => c === "" || c === "." || c === ".."))
                errs.push("$.entrypoint.path: a path relative to a workspace root, with no . or .. and no leading -");
            if (!/^[0-9a-f]{64}$/.test(e.sha256)) errs.push("$.entrypoint.sha256: 64 lowercase hex digits");
        }
        if (v !== undefined) errs.push("$.version: a script is pinned by its entrypoint's sha256, so it has no version");
    }
    if (m.okCodes !== undefined) codes(m.okCodes, "$.okCodes");
    if (m.echoes !== undefined && typeof m.echoes !== "boolean") errs.push("$.echoes: boolean");
    if (m.env !== undefined && !(Array.isArray(m.env) && m.env.every((e) => typeof e === "string"))) errs.push("$.env: names");
    command(m.command, "$.command");
    return errs;
}
