// sh-call.ts — one `ml.sh.run` call: what a script passed, checked; what the host is asked; the facts a policy and the
// card are given; and what the script gets back.

// docs/spec/SHELL.md, "One call" and "Policies: what a shell call gives one". Pure: no `chrome`, no host. The worker
// (sw-shell.ts) carries these shapes to the process host and back. Everything a decision rests on comes from the
// host's resolution (`HostFacts`) and the program's manifest, never from what the script says about its call: the
// script supplies the argv, the cwd and the environment additions, and nothing else.

import type { CallDescription, ProgramManifest } from "./program-manifest";
import { describeCall, hardenArgv } from "./program-manifest";
import type { EffectsData, Resource } from "../effects";
import type { HostDone, HostFacts, HostPathArg, HostPlacement, HostSpawn, HostStream } from "./host-protocol";
import { binaryKind } from "../sw/body-read";
import cat from "./manifests/cat.json";
import find from "./manifests/find.json";
import git from "./manifests/git.json";
import head from "./manifests/head.json";
import jq from "./manifests/jq.json";
import ls from "./manifests/ls.json";
import rg from "./manifests/rg.json";
import tail from "./manifests/tail.json";
import wc from "./manifests/wc.json";

/** The manifests shipped with the extension, by program name. A program not here is unannotated: its effects are
 *  `unknown`, the host resolves none of its arguments as paths, and every call to it asks. */
export const SHIPPED_MANIFESTS: Readonly<Record<string, ProgramManifest>> = Object.freeze(Object.fromEntries(
    ([cat, find, git, head, jq, ls, rg, tail, wc] as unknown as ProgramManifest[]).map((m) => [m.program, m]),
));

/**
 * The manifest for an argv's program, by the basename of `argv[0]`.
 * @param argv0 the program as the script wrote it
 * @returns the manifest, or undefined for an unannotated program
 */
export function manifestFor(argv0: string): ProgramManifest | undefined {
    const base = argv0.split("/").pop() ?? "";
    return Object.prototype.hasOwnProperty.call(SHIPPED_MANIFESTS, base) ? SHIPPED_MANIFESTS[base] : undefined;
}

/** Bounds on what one call may carry, set far past any real command line, so a script cannot make the worker or the
 *  host do unbounded work on its say-so. */
export const SH_LIMITS = Object.freeze({ argv: 1024, argChars: 131072, totalChars: 262144, env: 64, envChars: 32768, timeoutMs: 3_600_000 });

/** A call the worker refuses before the host sees it: `code` is the `ml` wire's. */
export class ShRefused extends Error {
    constructor(readonly code: "BadRequest" | "Refused" | "SecretHandle", message: string) { super(message); }
}

/** The options `ml.sh.run` takes. Anything else is refused by name, so `shell: true` is told it does nothing. */
const RUN_OPTIONS = ["cwd", "env", "timeoutMs"] as const;

/** One `ml.sh.run(argv, opts)` as checked: the argv, and what the call adds to the session's defaults. */
export interface ShRunRequest { argv: string[]; cwd?: string; env: Record<string, string>; timeoutMs?: number }

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
    return out;
}

/** What the worker asks the host, and what it learned from the manifest on the way. */
export interface ShPlan {
    /** `spawn`'s arguments. Its `argv` is the FINAL one: the manifest's hardening inserted, what the card shows and runs. */
    spawn: HostSpawn;
    /** The manifest's description of the final argv, or null for an unannotated program. */
    description: CallDescription | null;
}

/**
 * Turn a checked request into the host's `spawn`, with the manifest's hardening and the arguments it marks as paths.
 * @param req the request
 * @param session the session's working directory (an absolute path inside a root); a relative `cwd` is taken from it
 * @returns the plan
 */
export function planSpawn(req: ShRunRequest, session: { cwd: string }): ShPlan {
    const cwd = req.cwd === undefined ? session.cwd : req.cwd.startsWith("/") ? req.cwd : `${session.cwd.replace(/\/+$/, "")}/${req.cwd}`;
    const m = manifestFor(req.argv[0]);
    const spawn: HostSpawn = { argv: req.argv, cwd, ...(Object.keys(req.env).length ? { env: { ...req.env } } : {}), mode: "host", ...(req.timeoutMs ? { timeoutMs: req.timeoutMs } : {}) };
    if (!m) return { spawn, description: null };
    const first = describeCall(req.argv, m, { envSet: Object.keys(req.env) });
    // Hardening is a belt, not a judgement: it applies whether or not the call is described (git is undescribed until
    // the host reports its version, and still gets `--no-pager`). Its points come only from levels the parse
    // understood. The hardened argv describes as the original does, so its own description carries the indices the
    // host resolves.
    const argv = first.harden.length ? hardenArgv(req.argv, first) : req.argv;
    const d = argv === req.argv ? first : describeCall(argv, m, { envSet: Object.keys(req.env) });
    spawn.argv = argv;
    const pathArgs: HostPathArg[] = d.pathArgs.map((p) => ({ arg: p.arg, ...(p.split ? { split: p.split } : {}), ...(p.walk ? { walk: true } : {}) }));
    if (pathArgs.length) spawn.pathArgs = pathArgs;
    if (d.recursive && d.actsOnDir && d.dirArg === null) spawn.walkCwd = true;
    if (m.program === "git" && d.dirArg !== null) spawn.repoArg = d.dirArg;
    return { spawn, description: d };
}

/** One path argument as a policy reads it. `containsSecret` only for a walked directory: null when the walk could not
 *  tell. */
export interface ShPathFact { arg: number; given: string; path: string; inRoot: boolean; secret: boolean; exists: boolean; containsSecret?: boolean | null }

/**
 * One call as a policy's `c` and the card see it: everything resolved by the host or read from the manifest, nothing
 * the script asserted (docs/spec/SHELL.md, "What it is given"). Plain data: it is copied into the approval's
 * descriptor, the run log and both exports as is.
 */
export interface ShFacts {
    argv: string[];
    program: { path: string; inRoot: boolean };
    cwd: { path: string; inRoot: boolean; containsSecret?: boolean | null };
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
}

/** A walked directory whose walk found a secret, or could not tell, counts as one. */
const secretBeneath = (containsSecret: boolean | null | undefined): boolean => containsSecret !== undefined && containsSecret !== false;

/**
 * The facts of one call, from the host's resolution, described again by the manifest over the resolved paths.
 * @param facts what `spawn` answered
 * @returns the policy's `c`
 */
export function shFacts(facts: HostFacts): ShFacts {
    const m = manifestFor(facts.argv[0]);
    const why: string[] = [];
    let effects: EffectsData = "unknown";
    let described = false;
    let runner = false;
    if (!m) why.push(`${facts.argv[0]} has no program manifest`);
    else {
        const byArg = new Map(facts.paths.map((p) => [p.arg, p]));
        const resolve = (p: { arg: number | "cwd"; given: string }): Resource => {
            if (p.arg === "cwd") return { kind: "fs", path: facts.cwd.path, inRoot: facts.cwd.inRoot, secret: secretBeneath(facts.cwd.containsSecret) };
            const f = byArg.get(p.arg);
            // An argument the host was not asked to resolve has no root or secret answer, which no bound covers.
            return f ? { kind: "fs", path: f.path, inRoot: f.inRoot, secret: f.secret || secretBeneath(f.containsSecret) } : { kind: "fs", path: p.given };
        };
        const d = describeCall(facts.argv, m, { envSet: facts.env.set, resolve });
        effects = d.effects;
        described = d.described;
        runner = d.runner;
        why.push(...d.why);
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
        program: { path: facts.program.path, inRoot: facts.program.inRoot },
        cwd: { path: facts.cwd.path, inRoot: facts.cwd.inRoot, ...(facts.cwd.containsSecret !== undefined ? { containsSecret: facts.cwd.containsSecret } : {}) },
        env: { set: [...facts.env.set], free: facts.env.free },
        secrets: [...facts.env.secrets],
        paths: facts.paths.map((p) => ({ arg: p.arg, given: p.given, path: p.path, inRoot: p.inRoot, secret: p.secret, exists: p.exists, ...(p.containsSecret !== undefined ? { containsSecret: p.containsSecret } : {}) })),
        repo: facts.repo ? { root: facts.repo.root, reasons: [...facts.repo.reasons] } : null,
        repoConfigRunsCode: facts.repoConfigRunsCode,
        effects, described, why, runner,
        mode: facts.mode, sandboxed: facts.sandboxed, placement: facts.placement,
    };
}

/** One line of the approval card: a label, its value, and whether it is something to look at twice. */
export interface ShCardLine { label: string; value: string; warn?: boolean }

/**
 * The approval card's lines for one call: what will run, where, with what, as the host resolved it. Never the script
 * that computed the call (SHELL.md, "Approval": what was approved is exactly what runs). Human-facing text.
 * @param f the call's facts
 * @returns the lines, in reading order
 */
export function shCardLines(f: ShFacts): ShCardLine[] {
    const lines: ShCardLine[] = [
        { label: "Runs", value: f.argv.map(quoteArg).join(" ") },
        { label: "Program", value: f.program.path },
        { label: "In", value: f.cwd.path + (f.cwd.inRoot ? "" : " (outside the workspace roots)"), ...(f.cwd.inRoot ? {} : { warn: true }) },
        f.sandboxed
            ? { label: "Sandbox", value: "on: writes only inside the workspace roots, no network" }
            : { label: "Sandbox", value: "off: runs as you, with your files and network", warn: true },
    ];
    if (f.env.set.length) lines.push({ label: "Sets", value: f.env.set.join(", "), ...(f.env.free ? {} : { warn: true }) });
    for (const p of f.paths) {
        const notes = [!p.inRoot && "outside the roots", p.secret && "looks like a secret", p.containsSecret === true && "has secret-looking files beneath it",
            p.containsSecret === null && "too large to check for secrets", !p.exists && "does not exist yet"].filter(Boolean);
        lines.push({ label: `Path ${p.arg}`, value: p.path + (notes.length ? ` (${notes.join(", ")})` : ""), ...(notes.some((n) => n !== "does not exist yet") ? { warn: true } : {}) });
    }
    if (secretBeneath(f.cwd.containsSecret)) lines.push({ label: "Reads", value: f.cwd.containsSecret ? "the whole directory, which has secret-looking files in it" : "the whole directory, too large to check for secrets", warn: true });
    if (f.repoConfigRunsCode) lines.push({ label: "Repository", value: `its own config makes git run a program: ${f.repo?.reasons.join(", ") || "see .git/config"}`, warn: true });
    if (f.runner) lines.push({ label: "Starts", value: "another program, which this card does not show", warn: true });
    lines.push({ label: "Does", value: effectsText(f.effects), ...(f.effects === "unknown" ? { warn: true } : {}) });
    if (!f.described && f.why.length) lines.push({ label: "Why unknown", value: f.why.join("; ") });
    return lines;
}

/** An argument as the card prints it: bare when it is plain, else JSON-quoted, so a space or a quote cannot hide where
 *  one argument ends. */
function quoteArg(a: string): string {
    return /^[A-Za-z0-9_@%+=:,./-]+$/.test(a) ? a : JSON.stringify(a);
}

/** A call's effects in words, for the card. */
function effectsText(e: EffectsData): string {
    if (e === "unknown") return "unknown: no manifest describes this call";
    if (!e.length) return "nothing beyond running";
    return e.map((x) => `${x.op} ${x.res.kind === "fs" ? x.res.path + (x.res.inRoot === false ? " (outside the roots)" : "") : x.res.kind === "net" ? `network ${x.res.host}` : x.res.kind === "secret" ? `secret ${x.res.name}` : x.res.kind}`).join("; ");
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
 */
export function shResult(done: HostDone, facts: Pick<ShFacts, "placement">, description: CallDescription | null, out: { stdout: ShOut; stderr: ShOut }): ShResult {
    const okCodes = description?.okCodes ?? [0];
    const ok = !done.error && !done.timedOut && !done.cancelled && done.code !== null && okCodes.includes(done.code);
    return {
        code: done.code, signal: done.signal, ok, timedOut: done.timedOut, cancelled: done.cancelled, durationMs: done.durationMs,
        ran: facts.placement, stdout: out.stdout, stderr: out.stderr,
        ...(done.error ? { error: `${done.error.code}: ${done.error.message}` } : {}),
    };
}

/** The `ml` wire's code for a host error: what the host refuses as enforcement is `Refused`, a malformed call is the
 *  caller's, and the rest failed. */
export function wireCodeOf(hostCode: string): "Refused" | "BadRequest" | "TooLarge" | "SecretHandle" | "Failed" {
    switch (hostCode) {
        case "CwdOutsideRoots": case "EnvRefused": case "ProgramNotFound": case "Unsupported": case "NotConfigured": case "BadRoot": return "Refused";
        case "SecretUnavailable": return "SecretHandle";
        case "BadRequest": return "BadRequest";
        case "TooLarge": return "TooLarge";
        default: return "Failed";
    }
}
