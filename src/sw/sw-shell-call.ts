// sw-shell-call.ts — one `ml.sh` call made from inside a running step: the host's facts, a policy's or the person's
// answer, the start, and each output kept as a pointer the script reads by range.

// docs/spec/SHELL.md, "One call". The script names an argv; the HOST resolves what it means (program, cwd, paths, repo,
// sandbox) and starts nothing until this worker says so (`spawn` then `start`). What decides is never the script's word:
// a policy judges the host's facts (sw-policies.ts `judgeCall`), and a call no policy answers is a nested ask on the
// running step (sw-asks.ts), whose card shows those facts and never the script. A store not yet loaded answers "ask",
// and the call is judged again just before it starts, so a `deny` saved while the card waited still holds.
//
// Called only by the worker for a run it hosts, with the run and the step's seq it already knows (an isolated exec's
// channel, iso-channel.ts): no page-started message reaches here (tests/redteam.test.js).

import type { EffectsData } from "../effects";
import type { TokenStore } from "../pointers/token-pipe";
import { bytesOf, HostError, READ_CHUNK, type HostClient, type HostFacts, type HostStream } from "../shell/host-protocol";
import { manifestFor, parseShRun, planSpawn, shFacts, shOut, shResult, wireCodeOf, ShRefused, SH_HEAD_BYTES, type ShFacts, type ShOut, type ShResult } from "../shell/sh-call";
import { toolToken } from "../util";
import { defineState } from "../state-registry";
import { binaryKind } from "./body-read";
import { judgeCall } from "./sw-policies";
import { raiseAsk } from "./sw-asks";
import { recordRunLog } from "./sw-run-log";
import { holdOutput, shellHost, ShellUnavailable, withShell, type ShellHost } from "./sw-shell";

/** The step a call is made from, as the worker knows it: never anything the script said. */
export interface ShCallContext {
    runId: string;
    /** The OFFSET seq of the running step (what every surface and the ask key use). */
    seq: number;
    /** The loop's own step and seq of that step, as it notes its own pointers (TokenStore). */
    local: { step: number; seq: number };
    /** Aborted when the run is cancelled: a call waiting is denied, a running one is cancelled. */
    signal: AbortSignal;
    /** The run's pointers, where each output's pointer is noted. */
    tokens: TokenStore;
}

/** What a call answers the script: its value, or the error it throws, with the `ml` wire's code. */
export type ShAnswer = { ok: unknown } | { error: string; code: "Refused" | "Denied" | "BadRequest" | "TooLarge" | "SecretHandle" | "Failed" };

/** How many outputs the host keeps for one run before the oldest is released (its pointer then holds its head only). */
export const SH_HELD_PER_RUN = 32;

/** The version probe's limits (the coordinator's ruling): two seconds, and the first 4 KiB of what it prints. */
export const PROBE_TIMEOUT_MS = 2000, PROBE_BYTES = 4096;

/** One output the host holds for a run, by its pointer id. */
interface HeldOut { runId: string; ptr: string; size: number; client: HostClient }

const held = new Map<string, HeldOut>();   // state: declared below as "shell.outputs"
const versions = new Map<string, string | null>();   // state: declared below as "shell.versions"
const watched = new WeakSet<HostClient>();   // state: plumbing — the clients whose closing already forgets what they held

defineState({
    id: "shell.outputs", scope: "run", realm: "worker", audience: "model", lostOn: ["worker-eviction", "browser-restart"],
    describe: "The ml.sh outputs the process host still holds for this run, by pointer: the script reads past each one's head with ml.sh.read. An eviction closes the host's port and the host deletes them; the pointers then hold the head only.",
    read: ({ runId }) => {
        const mine = [...held].filter(([, h]) => h.runId === runId).map(([id, h]) => ({ token: `@tool:${id}`, size: h.size }));
        return mine.length ? mine : undefined;
    },
});
defineState({
    id: "shell.versions", scope: "browser", realm: "worker", audience: "human", lostOn: ["worker-eviction", "browser-restart"],
    describe: "The version each program reported to the version probe, by the program file's fingerprint (device, inode, size, modification time): a program that changes on disk is probed again.",
    read: () => (versions.size ? Object.fromEntries(versions) : undefined),
});

/** An error answer. */
const refuse = (code: Exclude<ShAnswer, { ok: unknown }>["code"], error: string): ShAnswer => ({ error, code });

/** The answer for a throw from the host or the session. */
function failure(e: unknown): ShAnswer {
    if (e instanceof ShRefused) return refuse(e.code === "BadRequest" ? "BadRequest" : "Refused", e.message);
    if (e instanceof ShellUnavailable) return refuse("Refused", e.message);
    if (e instanceof HostError) return refuse(wireCodeOf(e.code), `${e.code}: ${e.message}`);
    return refuse("Failed", (e as Error)?.message || String(e));
}

/**
 * `ml.sh.run(argv, opts)`: resolve, decide, start, wait, and answer the result with each output's head and pointer.
 * @param ctx the step the call is made from
 * @param args the script's arguments, as they crossed
 * @returns the result, or why not
 */
export async function shRun(ctx: ShCallContext, args: readonly unknown[]): Promise<ShAnswer> {
    let req;
    try { req = parseShRun(args); } catch (e) { return failure(e); }
    try {
        return await withShell(async (h) => {
            const cwd = h.configured.roots[0]?.path;
            if (!cwd) return refuse("Refused", "No workspace folder is configured for ml.sh.");
            const plan = planSpawn(req, { cwd });
            const facts = await h.client.spawn(plan.spawn);
            const discard = () => h.client.discard(facts.id).catch(() => { /* expired or gone: nothing to start either way */ });
            let f: ShFacts;
            try { f = shFacts(facts, await versionOf(ctx, h, facts)); }
            catch (e) { await discard(); throw e; }
            const verdict = await decide(ctx, f);
            if ("refused" in verdict) { await discard(); return refuse("Denied", verdict.refused); }
            // Judged again where the process starts: a policy saved while the card waited still holds.
            const again = judgeCall(ctx.runId, "sh", asPolicyFacts(f), f.placement);
            if (again.decision === "deny") { await discard(); return refuse("Denied", `ml.sh: ${denyText(again.by)}`); }
            if (ctx.signal.aborted) { await discard(); return refuse("Denied", "ml.sh: the run was cancelled"); }
            await h.client.start(facts.id);
            const onAbort = () => { void h.client.cancel(facts.id).catch(() => { /* already done */ }); };
            ctx.signal.addEventListener("abort", onAbort);
            let done;
            try { done = await h.client.waitDone(facts.id); } finally { ctx.signal.removeEventListener("abort", onAbort); }
            const stdout = await keep(ctx, h, done.stdout, f);
            const stderr = await keep(ctx, h, done.stderr, f);
            const result: ShResult = { ...shResult(done, f, plan.description, { stdout, stderr }), approvedBy: verdict.by, ...(verdict.waitedMs !== undefined ? { waitedMs: verdict.waitedMs } : {}) };
            recordRunLog(ctx.runId, { ...(result.ok ? {} : { level: "warn" as const }), subsystem: "shell", kind: "run", reason: verdict.by === "person" ? "person" : verdict.by === "builtin" ? "builtin" : "policy",
                ms: done.durationMs, detail: { seq: ctx.seq, program: f.argv[0] ?? "", code: done.code ?? -1, placement: f.placement } });
            return { ok: result };
        });
    } catch (e) { return failure(e); }
}

/** The facts as a policy's `c`: ShFacts is plain data with `effects`. */
const asPolicyFacts = (f: ShFacts): Record<string, unknown> & { effects: EffectsData } => f as unknown as Record<string, unknown> & { effects: EffectsData };

/** A policy's refusal in words. */
const denyText = (by: unknown): string => `the policy "${(by as { label?: string } | undefined)?.label ?? "?"}" refuses it`;

/**
 * Whether the call may start: a policy's answer, the built-in default's (effects inside the placement's bound), or the
 * person's on a nested ask.
 * @param ctx the step
 * @param f the call's facts
 */
async function decide(ctx: ShCallContext, f: ShFacts): Promise<{ by: string; waitedMs?: number } | { refused: string }> {
    const j = judgeCall(ctx.runId, "sh", asPolicyFacts(f), f.placement);
    if (j.decision === "deny") return { refused: `ml.sh: ${denyText(j.by)}` };
    if (j.decision === "allow") return { by: j.by === "builtin" ? "builtin" : `policy "${(j.by as { label?: string } | undefined)?.label ?? "?"}"` };
    // No policy answers (or the store is not loaded yet): the person does, on a card inside the running step.
    const o = await raiseAsk(ctx.runId, ctx.seq, { kind: "sh", consumer: "sh", facts: asPolicyFacts(f), placement: f.placement });
    if (!o.allowed) return { refused: `ml.sh: ${o.state === "denied" ? "the person declined" : o.note || o.state}${o.state === "denied" && o.note ? ` (${o.note})` : ""}` };
    return { by: "person", waitedMs: o.waitedMs };
}

/**
 * The version the program reports, for a manifest written against a version range (the coordinator's ruling): an
 * ordinary call of the manifest's own version args, effects empty, judged like any other; free only under the OS
 * sandbox, so on the plain host it is never raised (and the version stays unread). Refused outright for a program
 * inside the workspace roots, which the script could have written. Cached by the program file's fingerprint.
 * @param ctx the step
 * @param h the host
 * @param facts the call's facts
 * @returns the version, null when it was not read, or null too for a manifest that reads none
 */
async function versionOf(ctx: ShCallContext, h: ShellHost, facts: HostFacts): Promise<string | null> {
    const m = manifestFor(facts.argv[0]);
    if (!m || m.version.range === "*" || !m.version.args.length) return null;
    const fp = facts.program.fingerprint;
    const log = (reason: string, version?: string | null) => recordRunLog(ctx.runId, { subsystem: "shell", kind: "version-probe", reason, detail: { program: facts.program.path, ...(version !== undefined ? { version: version ?? "unread" } : {}) } });
    if (fp && versions.has(fp)) return versions.get(fp) ?? null;
    if (facts.program.inRoot) { log("program-in-root"); return null; }
    if (facts.placement !== "host-sandbox") { log("not-sandboxed"); return null; }
    if (!fp) { log("no-fingerprint"); return null; }
    const probe = await h.client.spawn({ argv: [facts.program.path, ...m.version.args], cwd: facts.cwd.path, mode: "host", timeoutMs: PROBE_TIMEOUT_MS });
    const drop = () => h.client.discard(probe.id).catch(() => { /* gone */ });
    // The same file the call resolved, under the same enforcer: otherwise its answer is not this program's.
    if (probe.program.fingerprint !== fp || probe.placement !== "host-sandbox") { await drop(); log("changed"); return null; }
    const j = judgeCall(ctx.runId, "sh", { ...asPolicyFacts(shFacts(probe)), effects: [] }, "host-sandbox");
    // Only an allow starts it: a store not loaded yet ("ask") or no answer would need a card, which a probe never raises.
    if (j.decision !== "allow") { await drop(); log(j.decision === "deny" ? "denied" : "would-ask"); return null; }
    let version: string | null = null;
    try {
        await h.client.start(probe.id);
        const done = await h.client.waitDone(probe.id);
        for (const s of [done.stdout, done.stderr]) {
            if ("error" in s) continue;
            if (s === done.stdout && done.code === 0 && s.size) {
                const r = await h.client.read(s.ptr, 0, PROBE_BYTES);
                const bytes = bytesOf(r.data);
                if (!binaryKind(bytes)) version = new RegExp(m.version.pattern, "m").exec(new TextDecoder().decode(bytes))?.[1] ?? null;
            }
            await h.client.release(s.ptr).catch(() => { /* gone with the session */ });
        }
    } catch { version = null; }
    versions.set(fp, version);
    log("ran", version);
    return version;
}

/**
 * One stream as the script gets it: its head read now, and a pointer noted in the run's store. A stream longer than its
 * head stays held by the host for `ml.sh.read`; a short one is released at once.
 * @param ctx the step
 * @param h the host
 * @param s the stream
 * @param f the call's facts, for the pointer's `in`
 */
async function keep(ctx: ShCallContext, h: ShellHost, s: HostStream, f: ShFacts): Promise<ShOut> {
    if ("error" in s) return shOut(s, null, new Uint8Array());
    const head = s.size ? bytesOf((await h.client.read(s.ptr, 0, Math.min(SH_HEAD_BYTES, READ_CHUNK))).data) : new Uint8Array();
    // Its own seed, so it never collides with the loop's per-step ids.
    const id = toolToken(`${ctx.runId}:sh:${crypto.randomUUID()}`, ctx.seq);
    const out = shOut(s, `@tool:${id}`, head);
    ctx.tokens.note({ id, tool: "ml.sh", kind: "text", out: out.text, in: JSON.stringify(f.argv), t: Date.now(), step: ctx.local.step, seq: ctx.local.seq });
    if (head.length >= s.size) { await h.client.release(s.ptr).catch(() => { /* gone */ }); return out; }
    held.set(id, { runId: ctx.runId, ptr: s.ptr, size: s.size, client: h.client });
    holdOutput(1);
    if (!watched.has(h.client)) { watched.add(h.client); h.client.onClosed(() => forgetClient(h.client)); }
    const mine = [...held].filter(([, x]) => x.runId === ctx.runId);
    for (const [old] of mine.slice(0, Math.max(0, mine.length - SH_HELD_PER_RUN))) releaseOne(old);
    return out;
}

/** Release one held output (the host deletes it). */
function releaseOne(id: string): void {
    const x = held.get(id);
    if (!x) return;
    held.delete(id);
    holdOutput(-1);
    if (!x.client.isClosed) void x.client.release(x.ptr).catch(() => { /* gone */ });
}

/** The host went: everything it held is gone with it. */
function forgetClient(c: HostClient): void {
    for (const [id, x] of [...held]) if (x.client === c) { held.delete(id); holdOutput(-1); }
}

/**
 * Release what the host holds for a run: its session is gone (sw-runs.ts `releaseSessionTokens`).
 * @param runId the run
 */
export function releaseShOutputs(runId: string): void {
    for (const [id, x] of [...held]) if (x.runId === runId) releaseOne(id);
}

/** The most one `ml.sh.read` returns: the host's read chunk. */
export const SH_READ_MAX = READ_CHUNK;

/**
 * `ml.sh.read(pointer, { offset, length })`: a range of an output the host holds for THIS run. Text comes back as text;
 * binary as `{ $bytes }`, never decoded for the model.
 * @param ctx the step
 * @param args the pointer (`@tool:<id>` or the id) and the range
 */
export async function shRead(ctx: ShCallContext, args: readonly unknown[]): Promise<ShAnswer> {
    const [ref, range] = args;
    if (typeof ref !== "string") return refuse("BadRequest", "ml.sh.read takes an output's pointer (@tool:<id>) and { offset, length }");
    const id = ref.replace(/^@tool:/, "");
    const o = range && typeof range === "object" ? range as { offset?: unknown; length?: unknown } : {};
    const offset = o.offset === undefined ? 0 : o.offset, length = o.length === undefined ? SH_HEAD_BYTES : o.length;
    if (typeof offset !== "number" || !Number.isSafeInteger(offset) || offset < 0 || typeof length !== "number" || !Number.isSafeInteger(length) || length < 0)
        return refuse("BadRequest", "ml.sh.read's offset and length are whole numbers of bytes, 0 or more");
    const x = held.get(id);
    // Another run's output reads as one that does not exist: a script learns nothing about what other runs hold.
    if (!x || x.runId !== ctx.runId) return refuse("Refused", `${ref} is not an ml.sh output the process host still holds for this run (a short output is all in its head; a released or evicted one is gone): read its head with ml.dereference`);
    try {
        const h = await shellHost();
        if (h.client !== x.client) { forgetClient(x.client); return refuse("Refused", `${ref}: the process host restarted, and the output went with it`); }
        const r = await h.client.read(x.ptr, offset, Math.min(length, SH_READ_MAX));
        const bytes = bytesOf(r.data);
        const base = { offset: r.offset, length: bytes.length, size: r.size, eof: r.eof };
        return { ok: binaryKind(bytes) ? { ...base, bytes: r.data } : { ...base, text: new TextDecoder("utf-8", { fatal: false }).decode(bytes) } };
    } catch (e) { return failure(e); }
}
