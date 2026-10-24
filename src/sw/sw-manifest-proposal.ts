// sw-manifest-proposal.ts — `propose_manifest` in the worker: a draft resolved through the host (nothing runs), read over
// this run's calls for the card, stored on the person's word, and its evidence run after.

// The ruling of 2026-10-23 (PROGRAM_MANIFEST.md, "The store, as built"): nothing executes before the person approves. The
// host's `spawn` only resolves (facts, then `discard`). The evidence run follows approval, on a sandboxed host only, over
// this run's calls of the program that the stored entry makes free, under the envelope derived from it (writes none,
// exec the program only), with the version probe's 2 s limit; every one must exit within its okCodes with the envelope
// applied as asked and no protected name changed. All passing marks `evidence`, and the entry then describes plain-host
// calls too; the first failure is kept on the entry and it stays sandbox-only. No call to re-run: no evidence, never a
// synthetic call.

import { hostTakesEnvelope, type HostFacts } from "../shell/host-protocol";
import { callsOfDraft, draftArgvs, draftNote, draftRequest, parseDraft, type DraftReading } from "../shell/manifest-proposal";
import { envelopeFor, envelopeMismatch, manifestsFor, planSpawn, shFacts, SHIPPED_MANIFESTS } from "../shell/sh-call";
import { manifestKey, storeRefusal, type ManifestOrigin, type ManifestRequest, type StoredManifest } from "../shell/stored-manifests";
import { addManifest, manifestsReady, markEvidence, storedManifests } from "./sw-manifests";
import { judgeCall } from "./sw-policies";
import { recordRunLog } from "./sw-run-log";
import { PROBE_TIMEOUT_MS, ranCalls, versionOf } from "./sw-shell-call";
import { withShell, type ShellHost } from "./sw-shell";

/** A draft the worker checked: the entry it would store, and why B3 forced its scope, when it did. */
export interface CheckedManifest {
    request: ManifestRequest;
    forced?: string;
}

/** The step a proposal is made from: the host records it as the owner of every resolve and re-run. */
export interface ProposalStep { runId: string; seq: number; signal: AbortSignal }

/** The facts of `argv` in `cwd`, resolved and discarded: the host starts nothing. A step's resolve names it as owner;
 *  the registration page's has none. */
async function resolveOnly(h: ShellHost, step: Pick<ProposalStep, "runId" | "seq"> | undefined, spawn: Parameters<ShellHost["client"]["spawn"]>[0]): Promise<HostFacts> {
    const facts = await h.client.spawn({ ...spawn, ...(step ? { owner: { run: step.runId, seq: step.seq } } : {}) });
    await h.client.discard(facts.id).catch(() => { /* expired: nothing to start either way */ });
    return facts;
}

/**
 * Check a draft as the store would, pinned to what the host resolves for it now: nothing runs.
 * @param step the proposing step
 * @param args the model's arguments
 * @returns the entry, or the error the model reads
 */
export function checkManifestProposal(step: Pick<ProposalStep, "runId" | "seq">, args: Record<string, unknown>): Promise<CheckedManifest | { error: string }> {
    return checkDraft(args, "proposed", step);
}

/**
 * Check a draft, the model's or the person's, as the store would, pinned to what the host resolves for it now (B4, and
 * a script's sha256 as the host read it; a pin or hash the draft carries is never used): nothing runs.
 * @param args `{ manifest, scope }`
 * @param origin whose draft it is
 * @param step the proposing step, for a model's draft
 * @param root the configured root (as given in Settings, or as the host resolved it) to resolve under first: where a
 *   workspace entry for a binary is kept. Absent: the first root.
 * @returns the entry, or the error (`Error: …`)
 */
export async function checkDraft(args: Record<string, unknown>, origin: ManifestOrigin, step?: Pick<ProposalStep, "runId" | "seq">, root?: string): Promise<CheckedManifest | { error: string }> {
    const d = parseDraft(args);
    if ("error" in d) return d;
    try {
        return await withShell(async (h) => {
            const first = root === undefined ? undefined : h.configured.roots.find((r) => r.given === root || r.path === root);
            if (root !== undefined && !first) return { error: `Error: ${root} is not a configured workspace folder.` };
            const roots = h.configured.roots.map((r) => r.path).sort((a, b) => (b === first?.path ? 1 : 0) - (a === first?.path ? 1 : 0));
            if (!roots.length) return { error: "Error: no workspace folder is configured for ml.sh." };
            let last: { error: string } = { error: `Error: ${String(d.manifest.program)} did not resolve.` };
            for (const { root, argv } of draftArgvs(d, roots)) {
                const facts = await resolveOnly(h, step, { argv, cwd: root, mode: "host", ...(argv.length > 1 ? { pathArgs: [{ arg: 1, hash: true }] } : {}) });
                const r = draftRequest(d, facts, root, roots, origin);
                if ("error" in r) { last = r; continue; }
                await manifestsReady;
                const why = storeRefusal(r.request, storedManifests(), SHIPPED_MANIFESTS);
                return why ? { error: `Error: ${why}.` } : r;
            }
            return last;
        });
    } catch (e) { return { error: `Error: ml.sh is not available: ${(e as Error)?.message || String(e)}` }; }
}

/** The entry as a call reads it before it is stored. A draft written against a version range is read with its version
 *  taken as in range: reading it would run the program, which waits for the person (the card says so). */
function asDraftEntry(r: ManifestRequest): StoredManifest {
    const m = r.manifest.version && r.manifest.version.range !== "*" ? { ...r.manifest, version: { range: "*", args: [], pattern: "" } } : r.manifest;
    return { ...r, manifest: m, id: "draft", created: 0 };
}

/**
 * The card's note for a checked draft: this run's calls of the program, resolved afresh by the host with the draft
 * (nothing runs), and the draft's reading of each. DERIVED only.
 * @param step the proposing step
 * @param c the checked draft
 */
export async function draftCardNote(step: Pick<ProposalStep, "runId" | "seq">, c: CheckedManifest): Promise<string> {
    try {
        return await withShell(async (h) => {
            const roots = h.configured.roots.map((r) => r.path);
            const entry = asDraftEntry(c.request);
            const readings: DraftReading[] = [];
            for (const call of callsOfDraft(c.request, ranCalls(step.runId), roots)) {
                if (call.env.set.length) { readings.push({ argv: call.argv, skipped: "it set environment variables, whose values are not kept" }); continue; }
                const plan = planSpawn({ argv: call.argv, cwd: call.cwd.path, env: {} }, { cwd: call.cwd.path, roots, stored: [entry] });
                const facts = await resolveOnly(h, step, plan.spawn);
                const f = shFacts(facts, null, { roots, stored: [entry] });
                readings.push({ argv: call.argv, facts: f, free: f.described && judgeCall(step.runId, "sh", f as never, f.placement).decision === "allow" });
            }
            const ranged = c.request.manifest.version && c.request.manifest.version.range !== "*";
            const note = draftNote(c.request, c.forced, readings, h.configured.sandboxed);
            return ranged ? `${note} Its version is read only once it is approved, so these readings take it as in range.` : note;
        });
    } catch (e) { return draftNote(c.request, c.forced, [], false) + ` (ml.sh is not available: ${(e as Error)?.message || String(e)})`; }
}

/** The outcome the tool reports, by run and the manifest's key: set on approval, read once by the tool's own run. */
const outcomes = new Map<string, Promise<string>>();   // state: plumbing — one approval's answer, taken by the call it approved

/**
 * Store an approved draft and run its evidence: what the gate's resolve calls on the person's yes. The tool's run reads
 * the outcome (`proposalOutcome`).
 * @param step the proposing step (its signal stops the evidence run)
 * @param c the draft the card showed
 */
export function approveManifest(step: ProposalStep, c: CheckedManifest): void {
    const k = `${step.runId}:${manifestKey(c.request.manifest)}`;
    outcomes.set(k, (async () => {
        const stored = await addManifest(c.request);
        if ("refused" in stored) return `Not stored: ${stored.refused}.`;
        recordRunLog(step.runId, { subsystem: "shell", kind: "manifest-added", reason: stored.scope, detail: { manifest: stored.id, program: stored.manifest.program } });
        const where = stored.scope === "global" ? "for every workspace" : `for the workspace ${stored.root}`;
        const head = `Stored ${where}: ${manifestKey(stored.manifest)} now describes its calls under the OS sandbox.`;
        return `${head} ${await evidenceRun(step, stored)}`;
    })().catch((e) => `Not stored: ${(e as Error)?.message || String(e)}.`));
}

/**
 * The outcome of the person's answer for this draft, once: why it was not stored, or what was stored and what its
 * evidence run measured. Undefined when the person did not approve it.
 * @param runId the run
 * @param args the model's arguments
 */
export async function proposalOutcome(runId: string, args: Record<string, unknown>): Promise<string | undefined> {
    const d = parseDraft(args);
    if ("error" in d) return undefined;
    const k = `${runId}:${manifestKey(d.manifest as never)}`;
    const o = outcomes.get(k);
    outcomes.delete(k);
    return o;
}

/**
 * The evidence run of a stored proposed entry, after approval: this run's calls of the program that it makes free,
 * re-run under the sandbox and the envelope derived from it. Records the outcome on the entry.
 * @param step the step
 * @param entry the stored entry
 * @returns what it measured, for the model
 */
export async function evidenceRun(step: ProposalStep, entry: StoredManifest): Promise<string> {
    const log = (reason: string, detail: Record<string, string | number> = {}) =>
        recordRunLog(step.runId, { ...(reason === "failed" ? { level: "warn" as const } : {}), subsystem: "shell", kind: "manifest-evidence", reason, detail: { manifest: entry.id, ...detail } });
    try {
        return await withShell(async (h) => {
            if (!h.configured.sandboxed) { log("not-sandboxed"); return "This host does not run calls under the OS sandbox, so no evidence run was made; it describes calls only under the sandbox."; }
            const roots = h.configured.roots.map((r) => r.path);
            const list = manifestsFor([entry], roots).list;
            let passed = 0;
            for (const call of callsOfDraft(entry, ranCalls(step.runId), roots)) {
                if (call.env.set.length) continue;
                if (step.signal.aborted) { log("cancelled"); return "The run was cancelled before its evidence run finished: it describes calls only under the sandbox."; }
                const plan = planSpawn({ argv: call.argv, cwd: call.cwd.path, env: {} }, { cwd: call.cwd.path, roots, stored: [entry] });
                const facts = await h.client.spawn({ ...plan.spawn, timeoutMs: PROBE_TIMEOUT_MS, owner: { run: step.runId, seq: step.seq } });
                const drop = () => h.client.discard(facts.id).catch(() => { /* gone */ });
                const f = shFacts(facts, await versionOf(step, h, facts, list), { roots, stored: [entry] });
                // Only what the entry makes free is re-run: the evidence run does nothing the approved entry would not allow.
                if (!f.described || f.placement !== "host-sandbox" || judgeCall(step.runId, "sh", f as never, f.placement).decision !== "allow") { await drop(); continue; }
                const asked = envelopeFor(f);
                const fail = async (why: string) => {
                    await markEvidence(entry.id, { failure: { argv: [...f.argv], why, at: Date.now() } });
                    log("failed", { program: f.argv[0] ?? "", why });
                    return `Its evidence run failed on ${JSON.stringify(f.argv)}: ${why}. It describes calls only under the sandbox.`;
                };
                if (!asked || asked.write !== "none" || !hostTakesEnvelope(h.hello)) { await drop(); return fail("the host cannot hold an envelope that refuses writes for it"); }
                await h.client.start(facts.id, asked);
                const done = await h.client.waitDone(facts.id);
                for (const s of [done.stdout, done.stderr]) if (!("error" in s)) await h.client.release(s.ptr).catch(() => { /* gone */ });
                const ok = plan.description?.okCodes ?? [0];
                const why = done.timedOut ? `it ran past ${PROBE_TIMEOUT_MS} ms`
                    : done.killed ? `it was killed (${done.killed})`
                    : done.error ? `${done.error.code}: ${done.error.message}`
                    : done.code === null || !ok.includes(done.code) ? `it exited ${done.code ?? done.signal}, not one of ${ok.join(", ")}`
                    : !done.envelope ? "the host did not report the envelope it applied"
                    : envelopeMismatch(done.envelope, asked) ? `the host applied write ${done.envelope.write}, exec ${done.envelope.exec}, not what was asked`
                    : done.protectedChanged === undefined ? "the host did not report the protected names"
                    : done.protectedChanged.length ? `it changed ${done.protectedChanged.map((x) => x.name).join(", ")}`
                    : undefined;
                if (why) return fail(why);
                passed++;
            }
            if (!passed) { log("none"); return "None of this run's calls of it is free to re-run, so it has no evidence and describes calls only under the sandbox."; }
            await markEvidence(entry.id, { evidence: { calls: passed, at: Date.now() } });
            log("passed", { calls: passed });
            return `Its evidence run re-ran ${passed} call${passed === 1 ? "" : "s"} under the sandbox, all as the manifest says, so it describes calls without the sandbox too.`;
        });
    } catch (e) { log("unavailable"); return `No evidence run was made (${(e as Error)?.message || String(e)}): it describes calls only under the sandbox.`; }
}
