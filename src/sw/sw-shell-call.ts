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
import type { ShCallSpan, ShUnasked } from "../contract";
import type { TokenStore } from "../pointers/token-pipe";
import { bytesOf, HostError, hostTakesEnvelope, READ_CHUNK, type HostClient, type HostEnvelope, type HostFacts, type HostStream } from "../shell/host-protocol";
import { envelopeFor, envelopeMismatch, envelopeText, manifestFor, manifestsFor, parseShRun, planSpawn, protectedChangesText, shFacts, shOut, shOutcome, shResult, wireCodeOf, ShRefused, SH_HEAD_BYTES, type ShFacts, type ShOut, type ShResult } from "../shell/sh-call";
import { toolToken } from "../util";
import { defineState } from "../state-registry";
import { binaryKind } from "./body-read";
import { judgeCall, askWhyOf, askedByPolicy } from "./sw-policies";
import { noteAskOutcome, raiseAsk } from "./sw-asks";
import { recordRunLog } from "./sw-run-log";
import { MAX_DETAIL_STRING } from "../log/housekeeping";
import { holdOutput, shellHost, ShellUnavailable, withShell, type ShellHost } from "./sw-shell";
import { manifestsReady, storedManifests } from "./sw-manifests";
import type { ProgramManifest } from "../shell/program-manifest";
import { operandArgs, operandChanges, type RanCall } from "../shell/manifest-proposal";

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

/** The calls a step has made and its tool result has not yet carried to the timeline, by run and the step's OFFSET seq. */
const spansByStep = new Map<string, ShCallSpan[]>();   // state: plumbing — filled by shRun, drained when the step's tool returns
/** At most this many steps' spans wait to be drained; past it the oldest go (a call whose step is never drained). */
const SPAN_STEPS_MAX = 256;

/**
 * The span the event lane draws for one finished call: the program's basename, its duration and what the host measured.
 * A field the host did not send is left out, so an older host draws nothing extra.
 * @param program `argv[0]` as the script wrote it
 * @param r the call's result
 * @param unasked what let it run without asking, for a call no one was asked about
 * @returns the span
 */
export function shSpanOf(program: string, r: Pick<ShResult, "durationMs" | "peakFootprint" | "memoryBound" | "killed" | "cpuMs">, unasked?: ShUnasked): ShCallSpan {
    return { program: program.split("/").pop() || program, durationMs: r.durationMs,
        ...(r.peakFootprint !== undefined ? { peakFootprint: r.peakFootprint } : {}),
        ...(r.memoryBound !== undefined ? { memoryBound: r.memoryBound } : {}),
        ...(r.cpuMs !== undefined ? { cpuMs: r.cpuMs } : {}),
        ...(r.killed ? { killed: r.killed } : {}),
        ...(unasked ? { unasked } : {}) };
}

/**
 * Take the spans of the calls a step made, forgetting them.
 * @param runId the run
 * @param seq the step's offset seq
 * @returns the spans in the order the calls finished, or undefined when it made none
 */
export function takeShSpans(runId: string, seq: number): ShCallSpan[] | undefined {
    const k = `${runId}:${seq}`;
    const s = spansByStep.get(k);
    spansByStep.delete(k);
    return s?.length ? s : undefined;
}

/** One output the host holds for a run, by its pointer id. */
interface HeldOut { runId: string; ptr: string; size: number; client: HostClient }

const held = new Map<string, HeldOut>();   // state: declared below as "shell.outputs"
/** The calls each run made that RAN (a policy, the built-in default or the person let them start), as the host resolved
 *  them: what `propose_manifest`'s card reads a draft over and its evidence run re-runs. A refused call is never here. */
const ranByRun = new Map<string, RanCall[]>();   // state: declared below as "shell.ran"
/** At most this many calls a run, the latest kept, and this many runs, the oldest dropped. */
export const RAN_PER_RUN = 64, RAN_RUNS_MAX = 32;
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
    id: "shell.ran", scope: "run", realm: "worker", audience: "human", lostOn: ["worker-eviction", "browser-restart"],
    describe: "The ml.sh calls this run made that ran, as the host resolved them (argv, cwd, program and its fingerprint), and what an undescribed one created, modified or removed among its arguments: what a propose_manifest card reads a draft over, and what its evidence run re-runs under the sandbox and checks.",
    read: ({ runId }) => {
        const mine = runId ? ranByRun.get(runId) : undefined;
        return mine?.length ? mine.map((f) => ({ argv: [...f.argv], cwd: f.cwd.path, program: f.program.path, placement: f.placement })) : undefined;
    },
});

/**
 * The calls a run made that ran, oldest first, as copies.
 * @param runId the run
 * @returns the host's facts of each
 */
export function ranCalls(runId: string): RanCall[] {
    return (ranByRun.get(runId) ?? []).map((f) => structuredClone(f));
}

/**
 * An undescribed call's operands as the host reads them now (`operandArgs`), resolved and discarded: nothing starts.
 * Undefined when the host would not resolve them, so the call is no evidence.
 * @param h the host
 * @param facts the call's facts
 */
async function readOperands(h: ShellHost, facts: HostFacts): Promise<HostFacts["paths"] | undefined> {
    const pathArgs = operandArgs(facts.argv);
    if (!pathArgs.length) return [];
    try {
        const r = await h.client.spawn({ argv: facts.argv, cwd: facts.cwd.path, env: {}, mode: "host", pathArgs });
        void h.client.discard(r.id).catch(() => { /* expired or gone */ });
        return r.paths;
    } catch { return undefined; }
}

/** Note what a call that ran did to its operands, on its entry in {@link ranByRun}. */
function noteOperands(runId: string, id: string, before: HostFacts["paths"], after: HostFacts["paths"] | undefined): void {
    const e = ranByRun.get(runId)?.find((c) => c.id === id);
    if (e && after) e.operandsChanged = operandChanges(before, after);
}

/** Note a call that ran, keeping the latest {@link RAN_PER_RUN} of the run and the latest {@link RAN_RUNS_MAX} runs. */
function noteRan(runId: string, facts: HostFacts): void {
    const list = ranByRun.get(runId) ?? [];
    ranByRun.delete(runId);
    ranByRun.set(runId, [...list, structuredClone(facts)].slice(-RAN_PER_RUN));
    while (ranByRun.size > RAN_RUNS_MAX) ranByRun.delete(ranByRun.keys().next().value!);
}

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
            // The roots as the host resolved them (realpaths), which its path facts are compared against.
            const roots = h.configured.roots.map((r) => r.path);
            // The stored manifests, once storage has been read (a failed read leaves none, so a call one would describe asks).
            await manifestsReady;
            const stored = storedManifests();
            const plan = planSpawn(req, { cwd, roots, stored });
            const spawn = () => h.client.spawn({ ...plan.spawn, owner: ownerOf(ctx) });
            let facts = await spawn();
            let f: ShFacts;
            let verdict: { by: string; policy?: string; waitedMs?: number; askId?: string };
            let done;
            let asked: HostEnvelope | undefined;
            for (let attempt = 0; ; attempt++) {
                const id = facts.id;
                const discard = () => h.client.discard(id).catch(() => { /* expired or gone: nothing to start either way */ });
                try { f = shFacts(facts, await versionOf(ctx, h, facts, manifestsFor(stored, roots).list), { roots, stored }); }
                catch (e) { await discard(); throw e; }
                const v = await decide(ctx, f);
                if ("refused" in v) { await discard(); return refuse("Denied", v.refused); }
                verdict = v;
                // Judged again where the process starts: a policy saved while the card waited still holds.
                const again = judgeCall(ctx.runId, "sh", asPolicyFacts(f), f.placement);
                if (again.decision === "deny") { await discard(); return refuse("Denied", `ml.sh: ${denyText(again.by)}`); }
                if (ctx.signal.aborted) { await discard(); return refuse("Denied", "ml.sh: the run was cancelled"); }
                // Listening BEFORE the start: a cancel that lands while the host is starting it still reaches it (finding C).
                const onAbort = () => { void h.client.cancel(id).catch(() => { /* not started yet, or already done */ }); };
                ctx.signal.addEventListener("abort", onAbort);
                // The narrowest envelope the approved claims permit, and only to a sandboxed call on a host that both
                // understands it (K3's `hello.sandbox.landlockAbi`) and can hold it. An unsandboxed call is refused
                // an envelope outright (window-ml-host `src/session.rs`: "this call is not sandboxed, so it cannot
                // hold an envelope"), and `hostTakesEnvelope` already excludes a bwrap without Landlock. The script's
                // word is never an input: `envelopeFor` reads only the facts the person or the policy approved.
                // Absent = today's floor, never a silent widening.
                asked = f.placement === "host-sandbox" && hostTakesEnvelope(h.hello) ? envelopeFor(f) : undefined;
                // An undescribed call's operands, read around it: what a draft that later calls it a reader is checked
                // against, since its evidence run under `write: none` cannot see a write the program swallows.
                const before = f.described ? undefined : await readOperands(h, facts);
                try {
                    try { await h.client.start(id, asked); }
                    catch (e) {
                        if (!(e instanceof HostError && e.code === "PinChanged")) throw e;
                        // The script changed after its facts were read: it is another program than the one judged. Its fresh
                        // facts no longer match the pin, so the first time it is described afresh and asks. A file the PERSON
                        // approved that changed before it started is refused: what they approved is not what would run.
                        const fresh = await spawn();
                        if (attempt === 0 && verdict.by !== "person") { facts = fresh; continue; }
                        void h.client.discard(fresh.id).catch(() => { /* gone */ });
                        const hashOf = (x: HostFacts) => x.paths.find((p) => p.sha256 !== undefined);
                        const was = hashOf(facts), now = hashOf(fresh);
                        recordRunLog(ctx.runId, { level: "warn", subsystem: "shell", kind: "pin-changed", reason: verdict.by === "person" ? "person" : "policy",
                            detail: { seq: ctx.seq, path: was?.path ?? "", approved: was?.sha256 ?? "unreadable", now: now?.sha256 ?? "unreadable" } });
                        return refuse("Denied", `ml.sh: ${was?.path ?? "the script"} changed between approval and start (sha256 ${was?.sha256 ?? "unreadable"} approved, now ${now?.sha256 ?? "unreadable"}): not run`);
                    }
                    noteRan(ctx.runId, facts);
                    if (ctx.signal.aborted) onAbort();
                    done = await h.client.waitDone(id);
                    if (before) noteOperands(ctx.runId, id, before, await readOperands(h, facts));
                } finally { ctx.signal.removeEventListener("abort", onAbort); }
                break;
            }
            const stdout = await keep(ctx, h, done.stdout, f);
            const stderr = await keep(ctx, h, done.stderr, f);
            const result: ShResult = { ...shResult(done, f, plan.description, { stdout, stderr }, asked), approvedBy: verdict.by, ...(verdict.waitedMs !== undefined ? { waitedMs: verdict.waitedMs } : {}) };
            recordRunLog(ctx.runId, { ...(result.ok ? {} : { level: "warn" as const }), subsystem: "shell", kind: "run", reason: verdict.by === "person" ? "person" : verdict.by === "builtin" ? "builtin" : "policy",
                ms: done.durationMs, detail: { seq: ctx.seq, program: f.argv[0] ?? "", code: done.code ?? -1, placement: f.placement,
                    ...(result.killed ? { killed: result.killed } : {}), ...(result.peakFootprint !== undefined ? { peakFootprint: result.peakFootprint } : {}),
                    ...(result.memoryBound !== undefined ? { memoryBound: result.memoryBound } : {}),
                    ...(result.cpuMs !== undefined ? { cpuMs: result.cpuMs } : {}), ...envelopeDetail(result) } });
            if (result.protectedChanged?.length) {
                // Its own record, at warn: what someone reading the log after a surprise looks for.
                recordRunLog(ctx.runId, { level: "warn", subsystem: "shell", kind: "protected-changed", reason: f.placement,
                    detail: { seq: ctx.seq, program: f.argv[0] ?? "", count: result.protectedChanged.length, changes: protectedChangesText(result.protectedChanged, !!result.protectedChangedTruncated, MAX_DETAIL_STRING),
                        ...(result.protectedChangedTruncated ? { truncated: true } : {}) } });
            }
            if (verdict.askId) noteAskOutcome(ctx.runId, ctx.seq, verdict.askId, shOutcome(result));
            const k = `${ctx.runId}:${ctx.seq}`;
            // A call no one was asked about is drawn under its step from this, in the card's words: what ran without
            // asking is never only in the run log.
            const unasked: ShUnasked | undefined = verdict.by === "person" ? undefined
                : { by: verdict.policy !== undefined ? "policy" : "default", ...(verdict.policy !== undefined ? { policy: verdict.policy } : {}),
                    argv: [...f.argv], outcome: shOutcome(result) as unknown as Record<string, unknown> };
            spansByStep.set(k, [...(spansByStep.get(k) ?? []), shSpanOf(f.argv[0] ?? "", result, unasked)]);
            if (spansByStep.size > SPAN_STEPS_MAX) spansByStep.delete(spansByStep.keys().next().value!);
            return { ok: result };
        });
    } catch (e) { return failure(e); }
}

/** The owner the host records for a call (its `status`, its orphan list): the run and the step's seq, never the script's word. */
const ownerOf = (ctx: Pick<ShCallContext, "runId" | "seq">): { run: string; seq: number } => ({ run: ctx.runId, seq: ctx.seq });

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
async function decide(ctx: ShCallContext, f: ShFacts): Promise<{ by: string; policy?: string; waitedMs?: number; askId?: string } | { refused: string }> {
    const j = judgeCall(ctx.runId, "sh", asPolicyFacts(f), f.placement);
    if (j.decision === "deny") return { refused: `ml.sh: ${denyText(j.by)}` };
    if (j.decision === "allow") {
        if (j.by === "builtin") return { by: "builtin" };
        const policy = (j.by as { label?: string } | undefined)?.label ?? "?";
        return { by: `policy "${policy}"`, policy };
    }
    // No policy answers, an `ask` policy matched (it beats an allow and the built-in default), or the store is not loaded
    // yet: the person does, on a card inside the running step. The card offers no "remember" (an ask's card never does).
    const why = askWhyOf(j);
    if (why) recordRunLog(ctx.runId, { subsystem: "policy", kind: askedByPolicy(why) ? "ask" : "lapsed", reason: why.cause, detail: { tool: "sh", policy: why.policy ?? "" } });
    const o = await raiseAsk(ctx.runId, ctx.seq, { kind: "sh", consumer: "sh", facts: asPolicyFacts(f), placement: f.placement, ...(why ? { why } : {}) });
    if (!o.allowed) return { refused: `ml.sh: ${o.state === "denied" ? "the person declined" : o.note || o.state}${o.state === "denied" && o.note ? ` (${o.note})` : ""}${why ? `. ${why.detail}` : ""}` };
    return { by: "person", waitedMs: o.waitedMs, ...(o.askId ? { askId: o.askId } : {}) };
}

/**
 * The run record's words for the sandbox and the protected names: what was asked (`floor` when nothing was sent), what
 * the host applied (`unknown` when it reported nothing), a mismatch between the two, and how many protected names
 * changed during the call (`unknown` from a host that reported none).
 * @param r the call's result
 */
function envelopeDetail(r: ShResult): Record<string, string | number | boolean> {
    return {
        asked: r.asked ? envelopeText(r.asked) : "floor",
        applied: r.envelope ? envelopeText(r.envelope) : "unknown",
        ...(envelopeMismatch(r.envelope, r.asked) ? { envelopeMismatch: true } : {}),
        protectedChanged: r.protectedChanged ? r.protectedChanged.length : "unknown",
        ...(r.protectedChangedTruncated ? { protectedChangedTruncated: true } : {}),
    };
}

/**
 * The version the program reports, for a manifest written against a version range (the coordinator's ruling): an
 * ordinary call of the manifest's own version args, effects empty, judged like any other; free only under the OS
 * sandbox, so on the plain host it is never raised (and the version stays unread). Refused outright for a program
 * inside the workspace roots, which the script could have written. Cached by the program file's fingerprint.
 * @param ctx the step
 * @param h the host
 * @param facts the call's facts
 * @param manifests the manifests the call is described by (default: the shipped ones)
 * @returns the version, null when it was not read, or null too for a manifest that reads none
 */
export async function versionOf(ctx: Pick<ShCallContext, "runId" | "seq" | "signal">, h: ShellHost, facts: HostFacts, manifests?: readonly ProgramManifest[]): Promise<string | null> {
    const m = manifestFor(facts.argv, undefined, manifests);
    if (!m?.version || m.version.range === "*" || !m.version.args.length) return null;
    const fp = facts.program.fingerprint;
    const log = (reason: string, version?: string | null) => recordRunLog(ctx.runId, { subsystem: "shell", kind: "version-probe", reason, detail: { program: facts.program.path, ...(version !== undefined ? { version: version ?? "unread" } : {}) } });
    // Refused BEFORE the cache: a hard link inside a root to a probed program shares its fingerprint, and must not
    // borrow its version (red-team finding A).
    if (facts.program.inRoot) { log("program-in-root"); return null; }
    if (facts.placement !== "host-sandbox") { log("not-sandboxed"); return null; }
    if (!fp) { log("no-fingerprint"); return null; }
    if (versions.has(fp)) return versions.get(fp) ?? null;
    // Nothing starts after a cancel, the probe included (finding B).
    if (ctx.signal.aborted) return null;
    const probe = await h.client.spawn({ argv: [facts.program.path, ...m.version.args], cwd: facts.cwd.path, mode: "host", timeoutMs: PROBE_TIMEOUT_MS, owner: ownerOf(ctx) });
    const drop = () => h.client.discard(probe.id).catch(() => { /* gone */ });
    // The same file the call resolved, under the same enforcer: otherwise its answer is not this program's.
    if (probe.program.fingerprint !== fp || probe.placement !== "host-sandbox") { await drop(); log("changed"); return null; }
    // Judged with no effects, and that same judged object derives its envelope below (ruled 2026-10-19: the approved
    // claims are the judge's facts, so `git --version` gets write none like any other probe).
    const judged: ShFacts = { ...shFacts(probe), effects: [] };
    const j = judgeCall(ctx.runId, "sh", asPolicyFacts(judged), "host-sandbox");
    // Only an allow starts it: a store not loaded yet, an `ask` policy or no answer would need a card, which a probe never raises.
    if (j.decision !== "allow") { await drop(); log(j.decision === "deny" ? "denied" : "would-ask"); return null; }
    if (ctx.signal.aborted) { await drop(); return null; }
    let version: string | null = null;
    try {
        // The probe's envelope derives from what was judged, as every start's does: a probe never runs under the floor
        // while its claims permit narrower (K3 audit, red team #827).
        await h.client.start(probe.id, hostTakesEnvelope(h.hello) ? envelopeFor(judged) : undefined);
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
