// sh-call.ts — one `ml.sh.run` call: what a script passed, checked; what the host is asked; the facts a policy and the
// card are given; and what the script gets back.

// docs/spec/SHELL.md, "One call" and "Policies: what a shell call gives one". Pure: no `chrome`, no host. The worker
// (sw-shell.ts) carries these shapes to the process host and back. Everything a decision rests on comes from the
// host's resolution (`HostFacts`) and the program's manifest, never from what the script says about its call: the
// script supplies the argv, the cwd and the environment additions, and nothing else.

import type { CallDescription, ProgramManifest } from "./program-manifest";
import { CREDENTIAL_PROVIDERS, describeCall, hardenArgv } from "./program-manifest";
import { claimsTopLevelName, type EffectsData, type Resource } from "../effects";
import type { HostDone, HostDoneEnvelope, HostEnvelope, HostFacts, HostPathArg, HostPlacement, HostProtectedChange, HostSpawn, HostStream, HostTilde, HostFilesMapped } from "./host-protocol";
import { binaryKind } from "../sw/body-read";
import { BOX_PREFIX, FILE_PREFIX, POINT_PREFIX, TOOL_TOKEN_PREFIX } from "../pointers/token-prefixes";
import { applicable, storedMisses, type StoredManifest } from "./stored-manifests";
import cat from "./manifests/cat.json";
import cp from "./manifests/cp.json";
import find from "./manifests/find.json";
import gh from "./manifests/gh.json";
import git from "./manifests/git.json";
import head from "./manifests/head.json";
import jq from "./manifests/jq.json";
import ls from "./manifests/ls.json";
import mv from "./manifests/mv.json";
import rg from "./manifests/rg.json";
import rm from "./manifests/rm.json";
import rmdir from "./manifests/rmdir.json";
import tail from "./manifests/tail.json";
import unlink from "./manifests/unlink.json";
import wc from "./manifests/wc.json";
import type { ShCallSpan, ShUnasked, StepAsk } from "../contract";

/** The manifests shipped with the extension, by program name. A program not here is unannotated: its effects are
 *  `unknown`, the host resolves none of its arguments as paths, and every call to it asks. */
export const SHIPPED_MANIFESTS: Readonly<Record<string, ProgramManifest>> = Object.freeze(Object.fromEntries(
    ([cat, cp, find, gh, git, head, jq, ls, mv, rg, rm, rmdir, tail, unlink, wc] as unknown as ProgramManifest[]).map((m) => [m.program, m]),
));

/** The manifests a call is described by: the shipped ones, unless the caller names its own. */
const SHIPPED_LIST: readonly ProgramManifest[] = Object.freeze(Object.values(SHIPPED_MANIFESTS));

/** Where a call is made, for matching an interpreted script's manifest: its cwd and the workspace roots, both as the
 *  host resolved them. `rootOf` names the one root a manifest is registered for (a workspace's stored manifest); a
 *  manifest it says nothing of matches under any root. */
export interface ManifestPlace { cwd: string; roots: readonly string[]; rootOf?: (m: ProgramManifest) => string | undefined }

/** The manifests a call made under `roots` is described by: the stored entries that apply there (the workspace's own,
 *  then the global ones), then the shipped manifests; and which root each workspace entry is registered for. A stored
 *  entry never shares a key with a shipped manifest (the store refuses one), so the order only settles workspace over
 *  global. */
export function manifestsFor(stored: readonly StoredManifest[] | undefined, roots: readonly string[]): { list: readonly ProgramManifest[]; rootOf: (m: ProgramManifest) => string | undefined; entryOf: (m: ProgramManifest) => StoredManifest | undefined } {
    // B2 at call time too: the store and its load refuse an entry for a shipped program, and this keeps one from shadowing it if any arrives another way.
    const here = applicable(stored ?? [], roots).filter((s) => !SHIPPED_MANIFESTS[s.manifest.program]);
    const byManifest = new Map(here.map((s) => [s.manifest, s]));
    return {
        list: here.length ? [...here.map((s) => s.manifest), ...SHIPPED_LIST] : SHIPPED_LIST,
        rootOf: (m) => byManifest.get(m)?.root,
        entryOf: (m) => byManifest.get(m),
    };
}

/** `a/./b/../c` → `a/c`, for an absolute path; textual only (symlinks are the host's to resolve). */
const normalPath = (p: string): string => {
    const out: string[] = [];
    for (const c of p.split("/")) {
        if (c === "" || c === ".") continue;
        if (c === "..") out.pop(); else out.push(c);
    }
    return "/" + out.join("/");
};

/**
 * The manifest for an argv's program. An interpreted script's manifest (`entrypoint`) is chosen when `argv[1]`, taken
 * from the cwd, names its script under one of the roots, with no interpreter flag before it; otherwise the program's
 * own manifest, by the basename of `argv[0]`.
 * @param argv the call as the script wrote it
 * @param place the call's cwd and the roots; without them no script manifest is chosen
 * @param manifests the manifests to choose from (default: the shipped ones)
 * @returns the manifest, or undefined for an unannotated program
 */
export function manifestFor(argv: readonly string[], place?: ManifestPlace, manifests: readonly ProgramManifest[] = SHIPPED_LIST): ProgramManifest | undefined {
    const base = (argv[0] ?? "").split("/").pop() ?? "";
    const script = argv[1];
    if (place && script && !script.startsWith("-")) {
        const target = normalPath(script.startsWith("/") ? script : `${place.cwd}/${script}`);
        const m = manifests.find((m) => m.program === base && m.entrypoint
            && rootsOf(m, place).some((r) => normalPath(`${r}/${m.entrypoint!.path}`) === target));
        if (m) return m;
    }
    return manifests.find((m) => m.program === base && !m.entrypoint);
}

/** The roots a manifest's entrypoint may sit under: its own root when it is registered for one, else every root. */
const rootsOf = (m: ProgramManifest, place: Pick<ManifestPlace, "roots" | "rootOf">): readonly string[] => {
    const own = place.rootOf?.(m);
    return own === undefined ? place.roots : place.roots.filter((r) => normalPath(r) === normalPath(own));
};

/**
 * Whether the host's facts bear out an interpreted script's manifest: `argv[1]` resolved to the script under a root,
 * its hash is the pin, and the call runs under the OS sandbox (on the plain host the script's imports are not bounded,
 * PROGRAM_MANIFEST.md "Interpreted script tools"). Each failure is a line of `why`.
 * @param facts what `spawn` answered
 * @param m the chosen manifest
 * @param roots the workspace roots as the host resolved them
 * @returns why the manifest does not apply; empty when it does
 */
function entrypointMisses(facts: HostFacts, m: ProgramManifest, roots: readonly string[]): string[] {
    const ep = m.entrypoint;
    if (!ep) return [];
    const why: string[] = [];
    const f = facts.paths.find((p) => p.arg === 1);
    if (!f || !roots.some((r) => normalPath(`${r}/${ep.path}`) === f.path)) why.push(`${f?.given ?? "argv[1]"} resolves to ${f?.path ?? "nothing"}, not ${ep.path} in a workspace root`);
    else if (f.sha256 !== ep.sha256) why.push(`${ep.path} is not the file its manifest was pinned to (sha256 ${f.sha256 ?? "unreadable"})`);
    if (!facts.sandboxed) why.push(`${ep.path} is described only under the OS sandbox: on the plain host, what it imports is not bounded`);
    return why;
}

/** Bounds on what one call may carry, set far past any real command line, so a script cannot make the worker or the
 *  host do unbounded work on its say-so. */
export const SH_LIMITS = Object.freeze({ argv: 1024, argChars: 131072, totalChars: 262144, env: 64, envChars: 32768, timeoutMs: 3_600_000 });

/** A call the worker refuses before the host sees it: `code` is the `ml` wire's. */
export class ShRefused extends Error {
    constructor(readonly code: "BadRequest" | "Refused" | "SecretHandle", message: string) { super(message); }
}

/** The options `ml.sh.run` takes. Anything else is refused by name, so `shell: true` is told it does nothing. */
const RUN_OPTIONS = ["cwd", "env", "timeoutMs", "expectMs"] as const;

/** The lease a bench cell builds in (build.mjs `--define __SH_LEASE_MS__=…`); undefined when nothing defined it. */
declare const __SH_LEASE_MS__: number | undefined;

/** How long a call runs before it DETACHES into a task when the script gives no `expectMs` (docs/spec/ASYNC_CALLS.md,
 *  mode 1). A PLACEHOLDER: the default is a bench question (rule 1), seconds and not minutes until one answers it. The
 *  bench varies it per cell through `__SH_LEASE_MS__`; what ships is 15 s. */
export const SH_LEASE_MS = typeof __SH_LEASE_MS__ === "number" ? __SH_LEASE_MS__ : 15_000;   // state: fixed

/** The host's own time limit for a call that names no `timeoutMs` (window-ml-host `DEFAULT_TIMEOUT_MS`): what a detached
 *  call is told it still runs under. */
export const SH_HOST_TIMEOUT_MS = 120_000;   // state: fixed

/** The prefixes of a pointer token: a value window.ml holds, never a name on the host's disk. */
const POINTER_PREFIXES = [TOOL_TOKEN_PREFIX, FILE_PREFIX, POINT_PREFIX, BOX_PREFIX] as const;

/**
 * Why one argv item that is a pointer token is refused (SHELL.md, RULED 2026-10-28: one rule for every prefix, so a
 * manifest never repeats it). The program would be handed the token's characters as a path and open nothing, or a
 * file that happens to carry that name. An item that merely CONTAINS a token (`--in=@file:x`) is the program's text.
 * @param a the argument
 * @param i its index
 * @returns the sentence, or null when the item is not a pointer token
 */
export function heldValueRefusal(a: string, i: number): string | null {
    const prefix = POINTER_PREFIXES.find((p) => a.startsWith(p));
    if (!prefix) return null;
    const how = prefix === FILE_PREFIX ? `an attachment is not on the host's disk, so no program can open it by that name; write it there first with ml.sh.put(${JSON.stringify(a.slice(0, 80))}, "<folder>/<name>") into a folder that exists, and pass that path`
        : prefix === TOOL_TOKEN_PREFIX ? "read it with ml.dereference, or reduce it with ml.pipe, and pass the text"
        : "it names a place on the page, which no program on the host can see";
    return `argv[${i}] is ${JSON.stringify(a.slice(0, 80))}, a held value, not a path: ${how}. A file that really has this name is ./${a.slice(0, 80)}`;
}

/** One `ml.sh.run(argv, opts)` as checked: the argv, and what the call adds to the session's defaults. `expectMs` is
 *  the script's own estimate of how long the call takes: its lease, past which it detaches. */
export interface ShRunRequest { argv: string[]; cwd?: string; env: Record<string, string>; timeoutMs?: number; expectMs?: number }

/**
 * Check one `ml.sh.run` call's arguments, as the script passed them (already a plain copy).
 * @param args `[argv, opts?]`
 * @returns the request
 * @throws ShRefused naming what is wrong and the form that is right
 */
export function parseShRun(args: readonly unknown[]): ShRunRequest {
    const [argv, opts] = args;
    if (typeof argv === "string")
        throw new ShRefused("BadRequest", `ml.sh.run takes an argv array, not a command string: ml.sh.run(["git", "status"]). No shell parses anything, so quoting, pipes and globs are never interpreted.`);
    if (!Array.isArray(argv) || argv.length === 0) throw new ShRefused("BadRequest", `ml.sh.run's first argument is an argv array with the program first: ml.sh.run(["git", "status"])`);
    if (argv.length > SH_LIMITS.argv) throw new ShRefused("BadRequest", `an argv of ${argv.length} items is longer than ml.sh.run takes (${SH_LIMITS.argv})`);
    let total = 0;
    for (const [i, a] of argv.entries()) {
        if (typeof a !== "string") throw new ShRefused("BadRequest", `argv[${i}] is a ${a === null ? "null" : typeof a}; every argument is a string (write String(x) for a number)`);
        if (a.includes("\0")) throw new ShRefused("BadRequest", `argv[${i}] contains a NUL character, which no program can receive`);
        if (a.length > SH_LIMITS.argChars) throw new ShRefused("BadRequest", `argv[${i}] is longer than one argument may be (${SH_LIMITS.argChars} characters)`);
        const held = heldValueRefusal(a, i);
        if (held) throw new ShRefused("BadRequest", held);
        total += a.length;
    }
    if (total > SH_LIMITS.totalChars) throw new ShRefused("BadRequest", `the argv is longer than one call may carry (${SH_LIMITS.totalChars} characters)`);
    if (argv[0] === "") throw new ShRefused("BadRequest", "argv[0] is the program, and it is empty");
    const out: ShRunRequest = { argv: [...argv as string[]], env: {} };
    if (opts === undefined || opts === null) return out;
    if (typeof opts !== "object" || Array.isArray(opts)) throw new ShRefused("BadRequest", `ml.sh.run's second argument is an options object: { ${RUN_OPTIONS.join(", ")} }`);
    const o = opts as Record<string, unknown>;
    for (const k of Object.keys(o)) {
        if (!(RUN_OPTIONS as readonly string[]).includes(k))
            throw new ShRefused("BadRequest", `ml.sh.run has no option ${JSON.stringify(k)}; its options are ${RUN_OPTIONS.join(", ")}${k === "shell" ? ". There is no shell: pass the argv" : ""}`);
    }
    if (o.cwd !== undefined && o.cwd !== null) {
        if (typeof o.cwd !== "string" || !o.cwd || o.cwd.includes("\0")) throw new ShRefused("BadRequest", "cwd is a directory path, as a string");
        out.cwd = o.cwd;
    }
    if (o.env !== undefined && o.env !== null) {
        if (typeof o.env !== "object" || Array.isArray(o.env)) throw new ShRefused("BadRequest", "env is an object of variable names to string values; it ADDS to the session's environment");
        const names = Object.keys(o.env);
        if (names.length > SH_LIMITS.env) throw new ShRefused("BadRequest", `env sets ${names.length} variables, more than one call may (${SH_LIMITS.env})`);
        let chars = 0;
        for (const n of names) {
            const v = (o.env as Record<string, unknown>)[n];
            if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(n)) throw new ShRefused("BadRequest", `env name ${JSON.stringify(n)} is not a variable name`);
            if (v && typeof v === "object" && Object.prototype.hasOwnProperty.call(v, "$secret"))
                throw new ShRefused("SecretHandle", `env.${n} is a secret handle, and ml.sh cannot inject secrets yet`);
            if (typeof v !== "string") throw new ShRefused("BadRequest", `env.${n} is a ${v === null ? "null" : typeof v}; a value is a string`);
            if (v.includes("\0")) throw new ShRefused("BadRequest", `env.${n} contains a NUL character`);
            chars += n.length + v.length;
            out.env[n] = v;
        }
        if (chars > SH_LIMITS.envChars) throw new ShRefused("BadRequest", `env is longer than one call may carry (${SH_LIMITS.envChars} characters)`);
    }
    if (o.timeoutMs !== undefined && o.timeoutMs !== null) {
        if (typeof o.timeoutMs !== "number" || !Number.isFinite(o.timeoutMs) || o.timeoutMs <= 0) throw new ShRefused("BadRequest", "timeoutMs is a positive number of milliseconds");
        out.timeoutMs = Math.min(Math.floor(o.timeoutMs), SH_LIMITS.timeoutMs);
    }
    if (o.expectMs !== undefined && o.expectMs !== null) {
        if (typeof o.expectMs !== "number" || !Number.isFinite(o.expectMs) || o.expectMs <= 0) throw new ShRefused("BadRequest", "expectMs is a positive number of milliseconds: how long you expect the call to take");
        out.expectMs = Math.min(Math.floor(o.expectMs), SH_LIMITS.timeoutMs);
    }
    return out;
}

/** What the worker asks the host, and what it learned from the manifest on the way. */
export interface ShPlan {
    /** `spawn`'s arguments. Its `argv` is the FINAL one: the manifest's hardening inserted, what the card shows and runs. */
    spawn: HostSpawn;
    /** The manifest's description of the final argv, or null for an unannotated program. */
    description: CallDescription | null;
    /** The credential the manifest names, and the manifest itself, whose bytes' hash the host checks: what
     *  `credentialFor` turns into `spawn.credential` once it knows the host holds the provider. */
    credential?: { provider: string; manifest: ProgramManifest };
    /** Why the call is refused before it reaches the host: a `/files` argument the manifest does not place, while `/files`
     *  is a folder on the host's disk (FILE_ATTACHMENTS.md H9). The model's text, naming the real path to retry with. */
    filesRefusal?: string;
}

/**
 * The sha256 of a shipped manifest's file, as the host pins it: every shipped file is `JSON.stringify(m, null, 2)`
 * plus a newline (tests/program-manifest.test.mjs holds them to it), so the bundled object hashes to its file.
 * @param m a shipped manifest
 * @returns lowercase hex
 */
export async function manifestSha256(m: ProgramManifest): Promise<string> {
    const bytes = new TextEncoder().encode(`${JSON.stringify(m, null, 2)}\n`);
    return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * `spawn.credential` for a plan whose manifest names one, or undefined when the host would not hold it: only to a
 * sandboxed session whose host lists the provider in `hello.credentials` (an older host has no list and would ignore
 * the field, running the call under the ordinary profile as if it had been honoured).
 * @param plan the plan
 * @param host what `hello` and `configure` answered
 */
export async function credentialFor(plan: ShPlan, host: { hello: { credentials?: readonly string[] }; configured: { sandboxed: boolean } }): Promise<HostSpawn["credential"]> {
    const c = plan.credential;
    if (!c || !host.configured.sandboxed || !(host.hello.credentials ?? []).includes(c.provider)) return undefined;
    return { provider: c.provider, manifest: await manifestSha256(c.manifest) };
}

/**
 * Turn a checked request into the host's `spawn`, with the manifest's hardening and the arguments it marks as paths.
 * @param req the request
 * @param session the session's working directory (an absolute path inside a root); a relative `cwd` is taken from it.
 *   `tilde`: the host expands a leading `~` (`hello.tilde`), so a `cwd` of `~` or `~/…` goes to it as written.
 *   `files`: `/files` is the uploads folder of this mount on the host's disk (`hello.filesArgv`); `shown` is that
 *   folder as the model's text writes it (`~/git/proj/window-ml-files`)
 * @returns the plan
 */
export function planSpawn(req: ShRunRequest, session: { cwd: string; roots?: readonly string[]; manifests?: readonly ProgramManifest[]; stored?: readonly StoredManifest[]; tilde?: boolean; files?: { mount: string; session: string; shown: string } }): ShPlan {
    const cwd = req.cwd === undefined ? session.cwd : req.cwd.startsWith("/") || (session.tilde && isTildeArg(req.cwd)) ? req.cwd : `${session.cwd.replace(/\/+$/, "")}/${req.cwd}`;
    const st = session.stored ? manifestsFor(session.stored, session.roots ?? []) : undefined;
    const m = manifestFor(req.argv, session.roots ? { cwd, roots: session.roots, ...(st ? { rootOf: st.rootOf } : {}) } : undefined, st?.list ?? session.manifests);
    const spawn: HostSpawn = { argv: req.argv, cwd, ...(Object.keys(req.env).length ? { env: { ...req.env } } : {}), mode: "host", ...(req.timeoutMs ? { timeoutMs: req.timeoutMs } : {}) };
    const files = session.files;
    if (files) spawn.files = { mount: files.mount, session: files.session };
    if (!m) return { spawn, description: null, ...filesPlaced(req.argv, null, files) };
    const first = describeCall(req.argv, m, { envSet: Object.keys(req.env) });
    // Hardening is a belt, not a judgement: it applies whether or not the call is described (git is undescribed until
    // the host reports its version, and still gets `--no-pager`). Its points come only from levels the parse
    // understood. The hardened argv describes as the original does, so its own description carries the indices the
    // host resolves.
    const argv = first.harden.length ? hardenArgv(req.argv, first) : req.argv;
    const d = argv === req.argv ? first : describeCall(argv, m, { envSet: Object.keys(req.env) });
    spawn.argv = argv;
    const pathArgs: HostPathArg[] = d.pathArgs.map((p) => ({ arg: p.arg, ...(p.split ? { split: p.split } : {}), ...(p.walk ? { walk: true } : {}), ...(p.role === "write" ? { role: "write" as const } : {}) }));
    // The script itself, resolved and hashed, so its facts say which file runs and whether it is the pinned one.
    if (m.entrypoint) pathArgs.unshift({ arg: 1, hash: true });
    if (pathArgs.length) spawn.pathArgs = pathArgs;
    if (d.recursive && d.actsOnDir && d.dirArg === null) spawn.walkCwd = true;
    if (m.program === "git" && d.dirArg !== null) spawn.repoArg = d.dirArg;
    // Only the shipped manifest's own object: the host pins the shipped bytes alone, and a stored entry kept from before
    // `shippedOnlyRefusal` existed would only end in CredentialRefused after the ask.
    const shipped = m.credential && SHIPPED_MANIFESTS[m.program] === m;
    return { spawn, description: d, ...(shipped ? { credential: { provider: m.credential!.provider, manifest: m } } : {}), ...filesPlaced(argv, m, files) };
}

/** Whether an argument names `/files` itself or a path under it. */
const isFilesPath = (a: string): boolean => a === "/files" || a.startsWith("/files/");

/**
 * The refusal of a `/files` argument the host cannot place (FILE_ATTACHMENTS.md H9): while `/files` is on the host's
 * disk, the host maps only what the manifest marks as a path, so a call with no manifest, or one its manifest does not
 * describe, naming `/files` at an argument's start or after its FIRST `=` is refused with the real path to retry with.
 * A described call places every argument, and one it does not mark as a path (a pattern, a message) is left alone.
 * Placing is the parse alone: the program's version and the call's environment are not known yet here and change no
 * argument's position, so they do not count (a call they leave undescribed still asks once the host reports them).
 * Named cost: a `/files` path after a second `=` (`--set=a=/files/x`) is not seen.
 * @param argv the call's argv
 * @param m its manifest, or null with none
 * @param files the mount `/files` names, if any
 */
function filesPlaced(argv: readonly string[], m: ProgramManifest | null, files: { shown: string } | undefined): { filesRefusal?: string } {
    if (!files) return {};
    // A script's manifest is pinned by its hash and has no version to check.
    const unversioned = (p: ProgramManifest): ProgramManifest => p.entrypoint ? p : { ...p, version: { range: "*", args: [], pattern: "" } };
    if (m && describeCall(argv, unversioned(m)).described) return {};
    for (const a of argv.slice(1)) {
        const eq = a.indexOf("=");
        const at = isFilesPath(a) ? a : eq >= 0 && isFilesPath(a.slice(eq + 1)) ? a.slice(eq + 1) : null;
        if (at !== null) return { filesRefusal: `/files is on disk while the host is connected: ${files.shown.replace(/\/+$/, "")}${at.slice("/files".length)}` };
    }
    return {};
}

/** One path argument as a policy reads it. `containsSecret` only for a walked directory: null when the walk could not
 *  tell. */
export interface ShPathFact { arg: number; given: string; path: string; inRoot: boolean; secret: boolean; exists: boolean; topLevel?: boolean; isRoot?: boolean; containsSecret?: boolean | null; sha256?: string | null; link?: string }

/** Where a resolved path sits among the roots: a root itself, or a top-level entry of one (its parent is a root).
 *  Both are textual over the host's realpaths, which the roots are too. Unset when the roots are not known. */
function placeAmongRoots(path: string, roots: readonly string[] | undefined): { topLevel?: boolean; isRoot?: boolean } {
    if (!roots) return {};
    const p = normalPath(path), rs = roots.map(normalPath);
    const parent = p === "/" ? null : normalPath(p.slice(0, p.lastIndexOf("/")) || "/");
    return { topLevel: parent !== null && rs.includes(parent), isRoot: rs.includes(p) };
}

/** {@link placeAmongRoots} of a path fact, of its symlink when the host names one, and of the argument as spelled
 *  against the cwd: `rm top` removes the link `top` while its target may be nested, so the place is the widest of them
 *  (review of #990, 2026-10-22). The spelling covers a host that omits `link` (an older one), since an absent field must
 *  not shrink the claim; ORing only widens, so a nested link to a nested target stays free. */
function placeBoth(f: { given: string; path: string; link?: string }, roots: readonly string[] | undefined, cwd: string): { topLevel?: boolean; isRoot?: boolean } {
    const a = placeAmongRoots(f.path, roots);
    if (a.topLevel === undefined) return a;
    const spelled = f.given.startsWith("/") ? f.given : cwd + "/" + f.given;
    const others = [spelled, ...(f.link !== undefined ? [f.link] : [])].map((x) => placeAmongRoots(x, roots));
    return { topLevel: a.topLevel || others.some((b) => b.topLevel === true), isRoot: a.isRoot === true || others.some((b) => b.isRoot === true) };
}

/** Whether the argument's last name changed under resolution while the host sent no `link`: the final component was
 *  then a symlink the host did not name (an older host), which folded only the target into `inRoot` and `secret`, so
 *  the name a delete or rename acts on is unchecked and `inRoot` is taken as false (red-team recheck of #990,
 *  2026-10-22). An unchanged last name (only a directory on the way moved it, `/tmp` → `/private/tmp`) is not. */
function unnamedLink(f: { given: string; path: string; link?: string }, cwd: string): boolean {
    if (f.link !== undefined) return false;
    const last = (p: string) => p.slice(p.lastIndexOf("/") + 1);
    return last(normalPath(f.given.startsWith("/") ? f.given : cwd + "/" + f.given)) !== last(normalPath(f.path));
}

/**
 * One call as a policy's `c` and the card see it: everything resolved by the host or read from the manifest, nothing
 * the script asserted (docs/spec/SHELL.md, "What it is given"). Plain data: it is copied into the approval's
 * descriptor, the run log and both exports as is.
 */
export interface ShFacts {
    argv: string[];
    /** `version`: what the program reported (the worker's version probe), null when it was not read. */
    program: { path: string; inRoot: boolean; version: string | null };
    /** `topLevel`/`isRoot` as on a path, present only when the roots were given. */
    cwd: { path: string; inRoot: boolean; topLevel?: boolean; isRoot?: boolean; containsSecret?: boolean | null };
    env: { set: string[]; free: boolean };
    secrets: string[];
    paths: ShPathFact[];
    repo: { root: string; reasons: string[] } | null;
    repoConfigRunsCode: boolean | null;
    effects: EffectsData;
    /** Whether the manifest describes this call; `why` says what it could not describe (or that there is no manifest). */
    described: boolean;
    why: string[];
    /** The call starts another program (`find -exec`, `xargs`, a git alias): its own word is not the whole story. */
    runner: boolean;
    mode: "host" | "container";
    sandboxed: boolean;
    placement: HostPlacement;
    /** The credential the call's manifest names: what the card says it sends, and `held` when the host's facts say it
     *  will inject it (the call then always asks, `judgeCall`); null when the manifest names none. `hosts` is null when
     *  a host holds it without naming hosts (a build from before the proxy), whose profile reaches any host on `ports`. */
    credential: { provider: string; sends: string; held: boolean; ports: readonly number[]; hosts: readonly string[] | null } | null;
    /** The arguments whose leading `~` the host expanded (`argv` and the paths already carry the expansion); `[]` from a
     *  host that expands nothing. */
    tilde: HostTilde[];
    /** The `/files` arguments the host mapped to the uploads folder (FILE_ATTACHMENTS.md H9; `argv` and the paths carry
     *  the real path); `[]` when nothing was mapped. */
    files: HostFilesMapped[];
}

/** Whether the host expands this argument's `~` (window-ml-host PROTOCOL.md, `spawn`): exactly `~`, or a `~/` prefix. */
export const isTildeArg = (a: string): boolean => a === "~" || a.startsWith("~/");

/**
 * The card's lines for the `/files` arguments the host mapped: both forms, what the call wrote and what the process got.
 * Human-facing text.
 * @param files the facts' entries
 */
export function filesLines(files: readonly HostFilesMapped[]): ShCardLine[] {
    return files.map((m) => ({ label: "/files", value: `${m.from} is ${m.to}` }));
}

/**
 * The card's lines for the arguments whose `~` the host expanded, or left literal for want of a usable `HOME`.
 * Human-facing text.
 * @param tilde the facts' entries
 */
export function tildeLines(tilde: readonly HostTilde[]): ShCardLine[] {
    return tilde.map((t) => ({ label: "~", value: t.to ? `${t.from} is ${t.to}` : `${t.from} stays literal (${t.reason ?? "no home"})`, ...(t.to ? {} : { warn: true }) }));
}

/** A walked directory whose walk found a secret, or could not tell, counts as one. */
const secretBeneath = (containsSecret: boolean | null | undefined): boolean => containsSecret !== undefined && containsSecret !== false;

/**
 * The facts of one call, from the host's resolution, described again by the manifest over the resolved paths.
 * @param facts what `spawn` answered
 * @param version the version the program reported, or null when it was not read (a manifest with a range then
 *   describes nothing: its effects are `unknown`)
 * @returns the policy's `c`
 */
export function shFacts(facts: HostFacts, version: string | null = null, place?: { roots: readonly string[]; manifests?: readonly ProgramManifest[]; stored?: readonly StoredManifest[] }): ShFacts {
    const st = place?.stored ? manifestsFor(place.stored, place.roots) : undefined;
    const m = manifestFor(facts.argv, place ? { cwd: facts.cwd.path, roots: place.roots, ...(st ? { rootOf: st.rootOf } : {}) } : undefined, st?.list ?? place?.manifests);
    const entry = m ? st?.entryOf(m) : undefined;
    const why: string[] = [];
    let effects: EffectsData = "unknown";
    let described = false;
    let runner = false;
    if (!m) why.push(`${facts.argv[0]} has no program manifest`);
    else if (facts.program.inRoot && !m.entrypoint && entry?.scope !== "workspace") {
        // Keyed on the host's resolved file, never on the argv spelling: a program a workspace file named `cat` is not cat
        // (PROGRAM_MANIFEST.md, ruled 2026-10-22). A manifest the workspace registered for its own entrypoint is not shipped.
        why.push(`${facts.program.path} is inside a workspace root, so no shipped manifest describes it`);
    } else {
        const byArg = new Map(facts.paths.map((p) => [p.arg, p]));
        const resolve = (p: { arg: number | "cwd" | "repo"; given: string }): Resource => {
            // The repository's root, when the host found one; else the cwd (a call outside a repository fails in git).
            if (p.arg === "repo") {
                if (!facts.repo) return { kind: "fs", path: facts.cwd.path, inRoot: facts.cwd.inRoot, secret: secretBeneath(facts.cwd.containsSecret), exists: true, ...placeAmongRoots(facts.cwd.path, place?.roots) };
                const r = normalPath(facts.repo.root);
                return { kind: "fs", path: r, inRoot: (place?.roots ?? []).some((x) => r === normalPath(x) || r.startsWith(normalPath(x) + "/")), secret: false, exists: true, ...placeAmongRoots(r, place?.roots) };
            }
            if (p.arg === "cwd") return { kind: "fs", path: facts.cwd.path, inRoot: facts.cwd.inRoot, secret: secretBeneath(facts.cwd.containsSecret), exists: true, ...placeAmongRoots(facts.cwd.path, place?.roots) };
            const f = byArg.get(p.arg);
            // An argument the host was not asked to resolve has no root or secret answer, which no bound covers.
            return f ? { kind: "fs", path: f.path, inRoot: f.inRoot && !unnamedLink(f, facts.cwd.path), secret: f.secret || secretBeneath(f.containsSecret), exists: f.exists, ...placeBoth(f, place?.roots, facts.cwd.path) } : { kind: "fs", path: p.given };
        };
        const d = describeCall(facts.argv, m, { envSet: facts.env.set, resolve, ...(version !== null ? { version } : {}) });
        effects = d.effects;
        described = d.described;
        runner = d.runner;
        why.push(...d.why);
        const misses = [...entrypointMisses(facts, m, place ? rootsOf(m, { roots: place.roots, ...(st ? { rootOf: st.rootOf } : {}) }) : []),
            ...(entry ? storedMisses(facts, entry, version) : [])];
        if (misses.length) { why.push(...misses); effects = "unknown"; described = false; }
    }
    // A variable off the free list changes what a program does in ways no manifest lists (SHELL.md, "The environment is
    // scrubbed"): the call is not described, whatever its argv says.
    if (!facts.env.free) {
        why.push(`the call sets ${facts.env.set.join(", ")}, which is not on the free list (LANG, LC_*, TZ, NO_COLOR, COLUMNS, TERM=dumb)`);
        effects = "unknown";
        described = false;
    }
    return {
        argv: [...facts.argv],
        program: { path: facts.program.path, inRoot: facts.program.inRoot, version },
        cwd: { path: facts.cwd.path, inRoot: facts.cwd.inRoot, ...placeAmongRoots(facts.cwd.path, place?.roots), ...(facts.cwd.containsSecret !== undefined ? { containsSecret: facts.cwd.containsSecret } : {}) },
        env: { set: [...facts.env.set], free: facts.env.free },
        secrets: [...facts.env.secrets],
        paths: facts.paths.map((p) => ({ arg: p.arg, given: p.given, path: p.path, inRoot: p.inRoot && !unnamedLink(p, facts.cwd.path), secret: p.secret, exists: p.exists, ...placeBoth(p, place?.roots, facts.cwd.path), ...(p.link !== undefined ? { link: p.link } : {}), ...(p.containsSecret !== undefined ? { containsSecret: p.containsSecret } : {}), ...(p.sha256 !== undefined ? { sha256: p.sha256 } : {}) })),
        repo: facts.repo ? { root: facts.repo.root, reasons: [...facts.repo.reasons] } : null,
        repoConfigRunsCode: facts.repoConfigRunsCode,
        effects, described, why, runner,
        mode: facts.mode, sandboxed: facts.sandboxed, placement: facts.placement,
        credential: credentialOf(facts, m),
        tilde: (facts.tilde ?? []).map((t) => ({ ...t })),
        files: (facts.files ?? []).map((m) => ({ ...m })),
    };
}

/** The call's credential: the host's word when it will inject one, else the manifest's, not held. */
function credentialOf(facts: HostFacts, m: ProgramManifest | undefined): ShFacts["credential"] {
    const provider = facts.credential?.provider ?? m?.credential?.provider;
    if (provider === undefined) return null;
    const sends = Object.hasOwn(CREDENTIAL_PROVIDERS, provider) ? CREDENTIAL_PROVIDERS[provider]!.sends : `the ${provider} credential`;
    // The host's grant when it holds one, else what the manifest asks for, else the provider's own.
    const own = Object.hasOwn(CREDENTIAL_PROVIDERS, provider) ? CREDENTIAL_PROVIDERS[provider] : undefined;
    const ports = facts.credential?.ports ?? m?.network?.ports ?? own?.ports ?? [];
    // A host that holds it says which names its proxy admits; one that names none bounds by port alone.
    const hosts = facts.credential ? facts.credential.hosts ?? null : m?.network?.hosts ?? own?.hosts ?? [];
    return { provider, sends, held: !!facts.credential, ports, hosts };
}

/**
 * The narrowest sandbox envelope the approved claims permit, or absent when they permit none (today's floor).
 * Pure over the facts the person or a policy approved: the script's word is never an input (SHELL.md, "The narrow
 * write envelope"). A claim that needs a right the envelope would withhold sends no envelope, rather than running
 * under one that would fail the call as `ok: false`. A call whose claims carry `exec(process)` (or that is a runner,
 * which starts programs no manifest describes) gets none at all: `find -exec rm` claims no write of its own, and an
 * envelope over only the described writes would fail rm as `ok: false`. Every envelope this returns is therefore
 * `exec: "program-only"`; `"any"` is unreachable, because the floor is no envelope at all.
 * @param f the call's facts
 * @returns the envelope to send on `start`, or undefined for today's floor
 */
export function envelopeFor(f: ShFacts): HostEnvelope | undefined {
    if (f.effects === "unknown" || f.runner) return undefined;
    if (f.effects.some((e) => e.op === "exec" && e.res.kind === "process")) return undefined;
    // The write set is every write or alloc effect (alloc on fs counts: a package install writes where it allocates).
    // A net or heap write is in it too and has no path to vouch for, so it withholds the envelope.
    const writes = f.effects.filter((e) => e.op === "write" || e.op === "alloc");
    let write: "roots" | "none";
    if (writes.length === 0) write = "none";
    else {
        const ok = writes.every((e) => e.res.kind === "fs" && e.res.inRoot === true && e.res.secret !== true
            && e.res.isRoot !== true && !claimsTopLevelName(e));
        if (!ok) return undefined;
        write = "roots";
    }
    return { write, exec: "program-only" };
}

/** One line of the approval card: a label, its value, and whether it is something to look at twice. */
export interface ShCardLine {
    label: string; value: string; warn?: boolean;
    /** What the label means, and for a value that is not what it seems, why: drawn as a hover on the line. */
    tip?: string;
    /** The line is the COMMAND: drawn as code, not as a fact. `script` is the body of a `<shell> -c <script>` call, with its newlines. */
    command?: true; script?: string;
}

const SHELLS = new Set(["bash", "sh", "zsh", "dash", "ksh"]);

/**
 * The script of a `<shell> -c <script>` argv, or null for any other call. A short-option cluster ending in `c`
 * (`-lc`, `-euc`) is the same flag; the script is the argument after it.
 * @param argv the program and its arguments
 */
export function scriptOf(argv: readonly string[]): string | null {
    const prog = (argv[0] ?? "").split("/").pop() ?? "";
    if (!SHELLS.has(prog)) return null;
    const flag = argv[1];
    if (typeof flag !== "string" || !/^-[A-Za-z]*c$/.test(flag)) return null;
    return typeof argv[2] === "string" ? argv[2] : null;
}

/** The floor's report name: what an absent envelope on `start` means, and what `done` calls it. */
const FLOOR: HostDoneEnvelope = { write: "today", exec: "any" };

/**
 * The "Sandbox applied" line: what the host reported, never what the worker asked for. An older host reports
 * nothing (`null`), which is unknown, never narrow; a report that is not what was asked for says so.
 * @param applied what `done.envelope` carried, or null when it carried nothing
 * @param asked what was sent on `start`, or undefined when nothing was (today's floor)
 */
function sandboxAppliedLine(applied: HostDoneEnvelope | null, asked: HostEnvelope | undefined): ShCardLine {
    if (applied === null) return { label: "Sandbox applied", value: "unknown (the host did not report it)" };
    const value = envelopeText(applied);
    return envelopeMismatch(applied, asked)
        ? { label: "Sandbox applied", value: `${value} (not the ${envelopeText(asked ?? FLOOR)} that was asked for)`, warn: true }
        : { label: "Sandbox applied", value };
}

/** An envelope in words, as the card and the run log print it. */
export const envelopeText = (e: HostDoneEnvelope): string => `write ${e.write}, exec ${e.exec}${e.profile ? `, profile ${e.profile}` : ""}${e.hosts ? `, hosts ${e.hosts.join(", ")}` : ""}`;

/**
 * Whether the host applied something other than what was asked for, an absent ask being the floor. An unreported
 * envelope (`null`) is not a mismatch: it is unknown, and says so in its own words.
 * @param applied what `done.envelope` carried, or null
 * @param asked what was sent on `start`, or undefined for the floor
 */
export function envelopeMismatch(applied: HostDoneEnvelope | null, asked: HostEnvelope | undefined): boolean {
    if (applied === null) return false;
    const want = asked ?? FLOOR;
    // A credentialed profile runs program-only whatever was asked: that narrowing is the host's rule, not a mismatch.
    return applied.write !== want.write || applied.exec !== (applied.profile ? "program-only" : want.exec);
}

/**
 * The protected names that changed during a call, in words: each `name change`, with the root once when they share
 * one and on each when they do not. During, never "by": two calls in one root both see either's change (SHELL.md).
 * Past `maxLen` it names as many as fit and says how many it left out, so a cut text never reads as the whole list.
 * @param changes the host's list, non-empty
 * @param more whether more changed than the list names (the host cut it)
 * @param maxLen the most characters the text may take (the run log's detail cap); unbounded by default. At least 60, or
 *   even the count alone is cut
 */
export function protectedChangesText(changes: readonly HostProtectedChange[], more: boolean, maxLen = Infinity): string {
    const one = new Set(changes.map((c) => c.root)).size === 1;
    const head = `changed during this call${one ? ` in ${changes[0]!.root}` : ""}: `;
    const items = changes.map((c) => `${one ? c.name : `${c.root}/${c.name}`} ${c.change}`);
    const whole = head + items.join(", ") + (more ? ", and more (the list was cut)" : "");
    if (whole.length <= maxLen) return whole;
    // The longest prefix of the items that fits with its own count of the rest after it.
    for (let k = items.length - 1; k >= 1; k--) {
        const cut = `${head}${items.slice(0, k).join(", ")}, and ${items.length - k}${more ? "+" : ""} more (the list was cut)`;
        if (cut.length <= maxLen) return cut;
    }
    // Not even one fits (a root path can be 4096 bytes): the count alone, which never reads as a list.
    return `changed during this call: ${items.length}${more ? "+" : ""} protected names, unlisted`.slice(0, maxLen);
}

/** How many protected changes a step's ask keeps for its card. The script's result carries the host's whole list. */
export const SH_CHANGES_SHOWN = 16;

/** What a finished call reports beside its exit, kept on the person's ask so the card can say it once the call ran.
 *  `protectedChanged` is cut at {@link SH_CHANGES_SHOWN}, with `protectedChangedTruncated` set when it was. */
export type ShOutcome = Pick<ShResult, "ran" | "envelope" | "asked" | "protectedChanged" | "protectedChangedTruncated">;

/**
 * A result's outcome, small enough to ride the step's event.
 * @param r the call's result
 */
export function shOutcome(r: ShResult): ShOutcome {
    const list = r.protectedChanged;
    const cut = list !== null && list.length > SH_CHANGES_SHOWN;
    return {
        ran: r.ran, envelope: r.envelope, ...(r.asked !== undefined ? { asked: r.asked } : {}),
        protectedChanged: cut ? list.slice(0, SH_CHANGES_SHOWN) : list,
        ...(cut || r.protectedChangedTruncated ? { protectedChangedTruncated: true as const } : {}),
    };
}

/**
 * The card's lines for a call that has run: the sandbox the host applied (a sandboxed call only: an unsandboxed one's
 * card already says it ran as the person), and what changed among the protected names during it. Human-facing text.
 * @param o the call's outcome
 * @returns the lines, in reading order
 */
export function shOutcomeLines(o: ShOutcome): ShCardLine[] {
    const lines: ShCardLine[] = o.ran === "host-sandbox" ? [sandboxAppliedLine(o.envelope, o.asked)] : [];
    const ch = o.protectedChanged;
    lines.push(ch === null ? { label: "Protected names", value: "unknown (the host did not report them)" }
        : !ch.length ? { label: "Protected names", value: "none changed during this call" }
        : { label: "Protected names", value: protectedChangesText(ch, !!o.protectedChangedTruncated), warn: true });
    return lines;
}

/** `port 443`, `ports 80 and 443`: the ports a credentialed profile reaches, for the card. */
function portsText(ports: readonly number[]): string {
    return ports.length === 1 ? `port ${ports[0]}` : `ports ${ports.slice(0, -1).join(", ")} and ${ports[ports.length - 1]}`;
}

/**
 * The approval card's lines for one call: what will run, where, with what, as the host resolved it. Never the script
 * that computed the call (SHELL.md, "Approval": what was approved is exactly what runs). Human-facing text.
 * @param f the call's facts
 * @param applied what the host reported it applied, or null when an older host reported nothing; omit on the approval
 *   card, which is shown before anything has been applied
 * @param asked what was sent on `start`, or undefined when nothing was (today's floor)
 * @returns the lines, in reading order
 */
export function shCardLines(f: ShFacts, applied?: HostDoneEnvelope | null, asked?: HostEnvelope): ShCardLine[] {
    const lines: ShCardLine[] = [
        { label: "Runs", value: f.argv.map(quoteArg).join(" "), command: true, ...(scriptOf(f.argv) !== null ? { script: scriptOf(f.argv)! } : {}) },
        { label: "Program", value: f.program.path + (f.program.version ? ` (version ${f.program.version})` : "") },
        { label: "In", value: f.cwd.path + (f.cwd.inRoot ? "" : " (outside the workspace roots)"), ...(f.cwd.inRoot ? {} : { warn: true }) },
        ...tildeLines(f.tilde ?? []),
        ...filesLines(f.files ?? []),
        f.sandboxed
            ? { label: "Sandbox", value: f.credential?.held ? `on: writes only inside the workspace roots, network to ${f.credential.hosts ? f.credential.hosts.join(", ") : "any host"} on ${portsText(f.credential.ports)} only` : "on: writes only inside the workspace roots, no network" }
            : { label: "Sandbox", value: "off: runs as you, with your files and network", warn: true },
    ];
    if (f.credential?.held) lines.push({ label: "Sends", value: f.credential.sends, warn: true });
    // Named by the manifest, not injected: unsandboxed the program uses its own login; sandboxed it has none.
    else if (f.credential) lines.push({ label: "Sends", value: f.sandboxed ? `nothing: this host cannot send ${f.credential.sends} under its sandbox, where the program cannot read its own login either` : `${f.credential.sends}, read by the program itself`, warn: true });
    if (applied !== undefined) lines.push(sandboxAppliedLine(applied, asked));
    if (f.env.set.length) lines.push({ label: "Sets", value: f.env.set.join(", "), ...(f.env.free ? {} : { warn: true }) });
    for (const p of f.paths) {
        const notes = [!p.inRoot && (unnamedLink(p, f.cwd.path) ? "a symlink the host did not name, so where the name is was not checked" : "outside the roots"), p.secret && "looks like a secret", p.containsSecret === true && "has secret-looking files beneath it",
            p.containsSecret === null && "too large to check for secrets", !p.exists && "does not exist yet"].filter(Boolean);
        // A hashed argument is the script that runs: where it was named, the file it resolved to, and its hash, which
        // stands where a binary's version does.
        const label = p.sha256 !== undefined ? "Script" : `Path ${p.arg}`;
        const where = p.sha256 !== undefined && p.given !== p.path ? `${p.given} → ${p.path}` : p.path;
        const hash = p.sha256 !== undefined ? ` (sha256 ${p.sha256 ? p.sha256.slice(0, 12) : "unreadable"})` : "";
        lines.push({ label, value: where + hash + (notes.length ? ` (${notes.join(", ")})` : ""), ...(notes.some((n) => n !== "does not exist yet") ? { warn: true } : {}) });
    }
    if (secretBeneath(f.cwd.containsSecret)) lines.push({ label: "Reads", value: f.cwd.containsSecret ? "the whole directory, which has secret-looking files in it" : "the whole directory, too large to check for secrets", warn: true });
    if (f.repoConfigRunsCode) lines.push({ label: "Repository", value: `its own config makes git run a program: ${f.repo?.reasons.join(", ") || "see .git/config"}`, warn: true });
    if (f.runner) lines.push({ label: "Starts", value: "another program, which this card does not show", warn: true });
    lines.push({ label: "Does", value: effectsText(f.effects), tip: doesTip(f), ...(f.effects === "unknown" || f.effects.some(claimsTopLevelName) ? { warn: true } : {}) });
    if (!f.described && f.why.length) lines.push({ label: "Why unknown", value: f.why.join("; ") });
    return lines;
}

/**
 * The hover on a card's "Does" line: what the line is, and when the effects are unknown, what that means for this call
 * (a shell runs whatever script it is handed, so its effects are the script's, which nothing here judges).
 * @param f the call's facts
 */
function doesTip(f: ShFacts): string {
    const what = "What this call would do to your files, the network and the machine, read from the program's manifest.";
    if (f.effects !== "unknown") return what;
    const shell = scriptOf(f.argv) !== null || SHELLS.has((f.argv[0] ?? "").split("/").pop() ?? "");
    return `${what} Here it is unknown: ${f.why.length ? `${f.why.join("; ")}. ` : ""}${shell ? "A shell does whatever the script it is given says, so read the command above before approving. " : ""}Approving it is approving whatever it does, inside the sandbox.`;
}

/** An argument as the card prints it: bare when it is plain, else JSON-quoted, so a space or a quote cannot hide where
 *  one argument ends. */
export function quoteArg(a: string): string {
    return /^[A-Za-z0-9_@%+=:,./-]+$/.test(a) ? a : JSON.stringify(a);
}

/** A call's effects in words, for the card. */
export function effectsText(e: EffectsData): string {
    if (e === "unknown") return "unknown";   // why is the card's own line: no manifest, an unknown flag, no version
    if (!e.length) return "nothing beyond running";
    return e.map((x) => `${x.res.kind === "fs" && x.res.names ? "create, remove or rename" : x.op} ${x.res.kind === "fs" ? x.res.path + (x.res.inRoot === false ? " (outside the roots)" : claimsTopLevelName(x) ? " (a name at the top of a workspace root)" : "") : x.res.kind === "net" ? `network ${x.res.host}` : x.res.kind === "secret" ? `secret ${x.res.name}` : x.res.kind}`).join("; ");
}

/** How much of each stream the script is handed with the result; the rest is read by range. 64 KiB. */
export const SH_HEAD_BYTES = 65536;

/** One stream of a finished call, as the script gets it: a pointer to the whole (held by the host, read by range), and
 *  its head as text. `complete`: the head is all of it. */
export interface ShOut { token: string | null; size: number; truncated: boolean; sha256: string; text: string; complete: boolean; error?: string }

/** What `ml.sh.run` returns. `ok` holds when the program exited with a code its manifest calls an answer (grep's 1)
 *  and was not killed; a non-zero exit is a value, never a throw. */
export interface ShResult {
    code: number | null;
    signal: string | null;
    ok: boolean;
    timedOut: boolean;
    cancelled: boolean;
    durationMs: number;
    ran: HostPlacement;
    stdout: ShOut;
    stderr: ShOut;
    error?: string;
    /** Who let it run: a policy (its label), the built-in default (`builtin`), or the person (`person`). */
    approvedBy?: string;
    /** How long the call waited for the person, when it did: a reading taken after the wait is not simultaneous with
     *  one taken before. */
    waitedMs?: number;
    /** `"oom"`: the call passed its memory bound (`memoryBound`, bytes) and the host killed it. */
    killed?: "oom";
    /** The highest physical footprint the host measured, in bytes (absent from a host older than 0.3.0). */
    peakFootprint?: number;
    memoryBound?: number;
    /** The CPU time the host measured, in milliseconds (host 0.7.0); absent from an older host. */
    cpuMs?: number;
    /** What was asked of the host on `start`, after the host-version gate; absent = nothing was sent (today's floor). */
    asked?: HostEnvelope;
    /** What the host reported it applied. `null` = an older host reported nothing: unknown, never narrow. */
    envelope: HostDoneEnvelope | null;
    /** What changed among the roots' protected names DURING the call, `[]` when nothing. `null` = the host reported
     *  nothing (an older host, or a `done` cut to fit): unknown, never "nothing". */
    protectedChanged: HostProtectedChange[] | null;
    /** The host cut `protectedChanged` at its bound; absent = the list is complete. */
    protectedChangedTruncated?: true;
}

const CHANGE_KINDS: ReadonlySet<unknown> = new Set(["created", "modified", "removed"]);

/**
 * `done.protectedChanged` as the result carries it. A list with any entry of another shape is unknown (`null`),
 * never a shorter list that would read as complete.
 * @param v what `done` carried
 */
function protectedChangedOf(v: unknown): HostProtectedChange[] | null {
    if (!Array.isArray(v)) return null;
    const ok = (c: unknown): c is HostProtectedChange => typeof c === "object" && c !== null
        && typeof (c as HostProtectedChange).root === "string" && typeof (c as HostProtectedChange).name === "string" && CHANGE_KINDS.has((c as HostProtectedChange).change);
    return v.every(ok) ? v.map((c) => ({ root: c.root, name: c.name, change: c.change })) : null;
}

/**
 * A stream's head as text: UTF-8 when it is text, a one-line note when it is binary (the bytes are never decoded as
 * text for the model).
 * @param bytes the first bytes the host held
 * @param size the stream's whole size
 * @returns the text, and whether it is all of the stream
 */
export function headText(bytes: Uint8Array, size: number): { text: string; complete: boolean } {
    const kind = binaryKind(bytes);
    if (kind) return { text: `[binary output: ${kind}, ${size} bytes]`, complete: false };
    // A cut can land inside a multi-byte character: the decoder's replacement there is the cut, not the program's.
    const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
    const complete = bytes.length >= size;
    return { text: complete ? text : `${text}… [first ${bytes.length} of ${size} bytes]`, complete };
}

/**
 * One stream as the script gets it.
 * @param s the host's stream
 * @param token the run's pointer for it, or null when none was made
 * @param head the head's bytes, read from the host
 */
export function shOut(s: HostStream, token: string | null, head: Uint8Array): ShOut {
    if ("error" in s) return { token: null, size: 0, truncated: false, sha256: "", text: "", complete: false, error: s.error };
    const t = headText(head, s.size);
    return { token, size: s.size, truncated: s.truncated, sha256: s.sha256, text: t.text, complete: t.complete && !s.truncated };
}

/**
 * The result of a finished call. `ok` is recomputed from the manifest's answer codes; the host's own `ok` knows only 0.
 * @param done the host's `done` event
 * @param facts the call's facts (its placement)
 * @param description the manifest's description, or null
 * @param out the two streams, already shaped
 * @param asked the envelope sent on `start`, or undefined when none was (today's floor)
 */
export function shResult(done: HostDone, facts: Pick<ShFacts, "placement">, description: CallDescription | null, out: { stdout: ShOut; stderr: ShOut }, asked?: HostEnvelope): ShResult {
    const okCodes = description?.okCodes ?? [0];
    const ok = !done.error && !done.killed && !done.timedOut && !done.cancelled && done.code !== null && okCodes.includes(done.code);
    const changed = protectedChangedOf(done.protectedChanged);
    return {
        code: done.code, signal: done.signal, ok, timedOut: done.timedOut, cancelled: done.cancelled, durationMs: done.durationMs,
        ran: facts.placement, stdout: out.stdout, stderr: out.stderr,
        envelope: done.envelope ?? null,
        ...(asked !== undefined ? { asked } : {}),
        protectedChanged: changed, ...(changed !== null && done.protectedChangedTruncated === true ? { protectedChangedTruncated: true as const } : {}),
        ...(done.error ? { error: `${done.error.code}: ${done.error.message}` } : {}),
        ...(done.killed === "oom" ? { killed: "oom" as const, error: `killed: past its memory bound of ${done.memoryBound ?? "?"} bytes` } : {}),
        ...(typeof done.peakFootprint === "number" ? { peakFootprint: done.peakFootprint } : {}),
        ...(typeof done.memoryBound === "number" ? { memoryBound: done.memoryBound } : {}),
        ...(typeof done.cpuMs === "number" ? { cpuMs: done.cpuMs } : {}),
    };
}

/** The `ml` wire's code for a host error: what the host refuses as enforcement is `Refused`, a malformed call is the
 *  caller's, and the rest failed. */
export function wireCodeOf(hostCode: string): "Refused" | "BadRequest" | "TooLarge" | "SecretHandle" | "Failed" {
    switch (hostCode) {
        case "CwdOutsideRoots": case "EnvRefused": case "ProgramNotFound": case "Unsupported": case "NotConfigured": case "BadRoot": case "CredentialRefused": return "Refused";
        case "SecretUnavailable": return "SecretHandle";
        case "BadRequest": return "BadRequest";
        case "TooLarge": return "TooLarge";
        default: return "Failed";
    }
}

/**
 * The lines for what an allowed ask's call reported once it ran (a shell call's sandbox and protected names), or none
 * when it has not reported, or reported in a shape this build does not draw.
 * @param a the ask
 * @returns the lines
 */
export function askOutcomeLines(a: StepAsk): ShCardLine[] {
    if (a.kind === "put" && a.state === "allowed") { const w = putWrote(a.outcome); return w ? [w] : []; }
    if (a.kind !== "sh" || a.state !== "allowed" || !a.outcome) return [];
    try { return shOutcomeLines(a.outcome as unknown as ShOutcome); } catch { return []; }
}

/** The line for what an `ml.sh.put` wrote (its outcome's `put`), or undefined for an outcome of another call. */
function putWrote(o: unknown): ShCardLine | undefined {
    const p = (o as { put?: { path?: unknown; size?: unknown } } | undefined)?.put;
    return p && typeof p.path === "string" ? { label: "Wrote", value: `${p.path} (${Number(p.size) || 0} bytes)` } : undefined;
}

/**
 * The lines under a step for an `ml.sh` call that ran without asking: what allowed it, then what it reported, in the
 * ask card's own words (`shOutcomeLines`), so the two paths never describe one call differently. Human-facing text.
 * @param u what the span carried
 * @returns the lines, in reading order
 */
export function unaskedLines(u: ShUnasked): ShCardLine[] {
    const lines: ShCardLine[] = [{ label: "Allowed by", value: u.by !== "policy" ? "the built-in default" : u.policy ? `the policy "${u.policy}"` : "a policy (no label recorded)" }];
    if (Array.isArray(u.tilde)) lines.push(...tildeLines(u.tilde));
    if (Array.isArray(u.files)) lines.push(...filesLines(u.files));
    const put = putWrote(u.outcome);
    if (put) return [...lines, put];
    try { lines.push(...shOutcomeLines(u.outcome as unknown as ShOutcome)); } catch { /* an outcome of another shape: the line says who allowed it */ }
    return lines;
}

/** The `ml.sh` calls of a step that ran without asking, in the order they finished. */
export const unaskedCalls = (shCalls: readonly ShCallSpan[] | undefined): ShUnasked[] =>
    (shCalls ?? []).flatMap((c) => (c.unasked && Array.isArray(c.unasked.argv) ? [c.unasked] : []));
