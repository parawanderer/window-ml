// manifest-proposal.ts — a program manifest the MODEL drafts (`propose_manifest`): its arguments checked, pinned to what
// the host resolved, and the card's DERIVED block. No `chrome`, no host: the worker resolves, stores and runs the
// evidence (sw-manifest-proposal.ts).

// PROGRAM_MANIFEST.md, "Registering a program", the store's ruling of 2026-10-23, the propose_manifest ruling of 2026-10-23: nothing executes before the
// person's word. The card's block is derived (the host's resolve-and-discard facts, and this run's calls that ran with
// the draft's reading of each) and says so; nothing measured is mixed into it. On approval the entry is stored
// `origin: "proposed"`, so it describes sandboxed calls only (B5) until its evidence run passes.

import type { HostFacts, HostPathArg, HostPathFact } from "./host-protocol";
import { validateManifest, type ProgramManifest } from "./program-manifest";
import { effectsText, manifestFor, quoteArg, type ShFacts } from "./sh-call";
import { manifestKey, type ManifestOrigin, type ManifestRequest } from "./stored-manifests";

/** The longest draft the tool takes, as JSON. */
export const DRAFT_MAX_CHARS = 16384;
/** At most this many of this run's calls are read on the card and re-run by the evidence run, the latest first. */
export const PROPOSAL_CALLS_MAX = 8;

/** What a call that ran did to one of its operands, read from the host's path facts just before its start and just
 *  after its done. */
export interface OperandChange { path: string; change: "created" | "modified" | "removed" }

/** A call that ran, as `ranCalls` keeps it: the host's facts, and what it did to its operands when they were read
 *  around it (`[]`: nothing; absent: not read, so it is no evidence). */
export type RanCall = HostFacts & { operandsChanged?: OperandChange[] };

/**
 * Every argument of an undescribed call that could name a file, as the host's path arguments, hashed: the whole
 * argument, or the part after `=` of a `--flag=value`. A bare flag is not one. Which are really paths only the program
 * knows, so all are read; one that is not a file reads as absent before and after, which is no change.
 * @param argv the call's argv
 */
export function operandArgs(argv: readonly string[]): HostPathArg[] {
    const out: HostPathArg[] = [];
    argv.forEach((a, i) => {
        if (!i || !a) return;
        if (a.startsWith("-")) { if (a.startsWith("--") && a.indexOf("=") > 2 && a.indexOf("=") < a.length - 1) out.push({ arg: i, split: "=", hash: true }); return; }
        out.push({ arg: i, hash: true });
    });
    return out;
}

/**
 * What changed among the operands between two reads of them. A secret path is compared by existence only (its hash is
 * never kept). A directory has no hash, so a write inside one is not seen: the evidence's own residual.
 * @param before the path facts before the start
 * @param after the path facts after the done
 */
export function operandChanges(before: readonly HostPathFact[], after: readonly HostPathFact[]): OperandChange[] {
    const was = new Map(before.map((p) => [p.path, p]));
    const out: OperandChange[] = [];
    for (const p of after) {
        const b = was.get(p.path);
        if (!b || out.some((o) => o.path === p.path)) continue;
        const change = !b.exists && p.exists ? "created" : b.exists && !p.exists ? "removed"
            : b.exists && !b.secret && !p.secret && b.sha256 !== p.sha256 ? "modified" : undefined;
        if (change) out.push({ path: p.path, change });
    }
    return out;
}

/** A draft as the tool accepted it: the manifest as the model wrote it (a script's `sha256` is the host's to fill), and
 *  the scope it asked for. */
export interface ManifestDraft {
    manifest: Record<string, unknown>;
    scope: "global" | "workspace";
}

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);

/** `a/./b/../c` → `/a/c`, textual: the host resolves symlinks. */
const normal = (p: string): string => {
    const out: string[] = [];
    for (const c of p.split("/")) { if (!c || c === ".") continue; if (c === "..") out.pop(); else out.push(c); }
    return "/" + out.join("/");
};

/**
 * The tool's arguments as a draft, or the error the model reads. Checks the shape only: whether the manifest is valid
 * is decided once the host's pin is in it (`draftRequest`).
 * @param args the model's arguments
 */
export function parseDraft(args: Record<string, unknown>): ManifestDraft | { error: string } {
    const m = args.manifest;
    if (!isObj(m)) return { error: "Error: manifest is a program manifest object (program, version or entrypoint, command)." };
    let size = 0;
    try { size = JSON.stringify(m).length; } catch { return { error: "Error: manifest is not plain JSON." }; }
    if (size > DRAFT_MAX_CHARS) return { error: `Error: the manifest is over ${DRAFT_MAX_CHARS} characters.` };
    if (typeof m.program !== "string" || !m.program || m.program.includes("/"))
        return { error: "Error: program is the program's name as a call names it (\"mytool\", \"node\"), never a path." };
    if (m.entrypoint !== undefined) {
        const e = m.entrypoint;
        if (!isObj(e) || typeof e.path !== "string" || !e.path || e.path.startsWith("/") || e.path.split("/").includes(".."))
            return { error: "Error: entrypoint.path is the script's path relative to a workspace root, e.g. \"scripts/gen.mjs\"." };
    }
    if (args.scope !== "global" && args.scope !== "workspace") return { error: "Error: scope is \"global\" (a tool on your PATH) or \"workspace\" (a tool of this repository)." };
    return { manifest: structuredClone(m), scope: args.scope };
}

/**
 * The argv the host resolves for a draft under each root: the program alone, or the interpreter and the script under
 * that root. A script is tried under every root; the worker keeps the one where it exists.
 * @param d the draft
 * @param roots the configured roots, as the host resolved them
 */
export function draftArgvs(d: ManifestDraft, roots: readonly string[]): { root: string; argv: string[] }[] {
    const program = d.manifest.program as string;
    const e = d.manifest.entrypoint as { path: string } | undefined;
    if (!e) return roots.length ? [{ root: roots[0], argv: [program] }] : [];
    return roots.map((root) => ({ root, argv: [program, `${root.replace(/\/+$/, "")}/${e.path}`] }));
}

/**
 * The entry the store would keep for a draft, pinned to what the host resolved: a binary by its path and fingerprint
 * (B4), a script by the sha256 the host read (the model's own is never used). B3 forces workspace scope on a program
 * inside a root and on a script, and `forced` says so for the card.
 * @param d the draft
 * @param facts the host's facts for `draftArgvs`' argv under `root` (resolved, then discarded: nothing ran)
 * @param root the root that argv was built for
 * @param roots the configured roots
 * @param origin whose draft it is: the model's (`propose_manifest`) or the person's (the registration page)
 * @returns the request and why its scope was forced, or the error the model reads
 */
export function draftRequest(d: ManifestDraft, facts: HostFacts, root: string, roots: readonly string[], origin: ManifestOrigin = "proposed"): { request: ManifestRequest; forced?: string } | { error: string } {
    const manifest = structuredClone(d.manifest) as Record<string, unknown>;
    let scope = d.scope, forced: string | undefined, pin: ManifestRequest["pin"], where = root;
    const e = manifest.entrypoint as { path: string; sha256?: string } | undefined;
    if (e) {
        const p = facts.paths.find((x) => x.arg === 1);
        if (!p?.exists) return { error: `Error: ${e.path} is not a file under ${roots.join(" or ")}.` };
        if (normal(p.path) !== normal(`${root}/${e.path}`)) return { error: `Error: ${e.path} resolves to ${p.path}, outside ${root} (a symlink is not pinned).` };
        if (!p.sha256) return { error: `Error: the host could not read ${p.path} to hash it.` };
        manifest.entrypoint = { path: e.path, sha256: p.sha256 };
        if (scope !== "workspace") forced = `${e.path} arrived with the repository, so its manifest belongs to that workspace`;
        scope = "workspace";
    } else {
        if (!facts.program.fingerprint) return { error: `Error: the host reported no fingerprint for ${facts.program.path}, so there is nothing to pin the manifest to.` };
        pin = { path: facts.program.path, fingerprint: facts.program.fingerprint, inRoot: facts.program.inRoot };
        if (facts.program.inRoot) {
            where = roots.find((r) => facts.program.path.startsWith(normal(r) + "/")) ?? root;
            if (scope !== "workspace") forced = `${facts.program.path} is inside the workspace ${where}, so only that workspace may describe it`;
            scope = "workspace";
        }
    }
    const problems = validateManifest(manifest);
    if (problems.length) return { error: `Error: not a valid program manifest: ${problems.slice(0, 5).join("; ")}` };
    const request: ManifestRequest = { scope, ...(scope === "workspace" ? { root: where } : {}), manifest: manifest as unknown as ProgramManifest, origin, ...(pin ? { pin } : {}) };
    return { request, ...(forced ? { forced } : {}) };
}

/**
 * This run's calls the draft would describe, the latest first, at most {@link PROPOSAL_CALLS_MAX}: the same program
 * file (a binary), or the interpreter running the same script under the same root.
 * @param r the entry
 * @param calls the run's calls that ran, oldest first
 * @param roots the configured roots
 */
export function callsOfDraft<C extends HostFacts>(r: ManifestRequest, calls: readonly C[], roots: readonly string[]): C[] {
    const own = r.root !== undefined ? roots.filter((x) => normal(x) === normal(r.root!)) : roots;
    const hit = (c: C) => r.manifest.entrypoint
        ? manifestFor(c.argv, { cwd: c.cwd.path, roots: own }, [r.manifest]) === r.manifest
        : c.program.path === r.pin?.path;
    return [...calls].reverse().filter(hit).slice(0, PROPOSAL_CALLS_MAX);
}

/** One of this run's calls as the draft reads it: resolved afresh by the host for the draft (nothing ran), and whether
 *  it would then go without a card. `skipped` says why it was not resolved. */
export type DraftReading = { argv: string[]; facts: ShFacts; free: boolean } | { argv: string[]; skipped: string };

/**
 * The card's note: what the person is asked to store, and the DERIVED block, said to be derived. Human-facing.
 * @param r the entry
 * @param forced why B3 made it a workspace entry, when it did
 * @param readings this run's calls of the program as the draft reads them
 * @param sandboxed whether this host runs calls under the OS sandbox
 */
export function draftNote(r: ManifestRequest, forced: string | undefined, readings: readonly DraftReading[], sandboxed: boolean): string {
    const key = manifestKey(r.manifest);
    const where = r.scope === "global" ? "for every workspace" : `for the workspace ${r.root}`;
    const pinned = r.manifest.entrypoint ? `the script's sha256 ${r.manifest.entrypoint.sha256.slice(0, 12)}` : `${r.pin!.path} as it is now (fingerprint ${r.pin!.fingerprint})`;
    const head = `Proposed by the model: a manifest for ${key}, stored ${where}${forced ? ` (${forced})` : ""}, pinned to ${pinned}; a change to it makes its calls ask again.`;
    const free = readings.filter((x): x is Extract<DraftReading, { facts: ShFacts }> => "facts" in x && x.free);
    const lines = readings.slice(0, 5).map((x) => `${x.argv.map(quoteArg).join(" ")}: ${"skipped" in x ? `not read (${x.skipped})` : `${effectsText(x.facts.effects)}, ${x.free ? "free" : "asks"}`}`);
    const derived = !readings.length
        ? "DERIVED, nothing run: this run has made no call of it that ran, so there is nothing to re-run as evidence."
        : `DERIVED, nothing run: the host resolved this run's ${readings.length} call${readings.length === 1 ? "" : "s"} of it again and the draft reads ${readings.length === 1 ? "it" : "them"} as: ${lines.join("; ")}${readings.length > 5 ? `; and ${readings.length - 5} more` : ""}.`;
    const after = !sandboxed
        ? "This host runs calls without the OS sandbox, so a model's manifest describes none of them, and no evidence run can be made here."
        : !free.length
            ? "Approved, it describes calls under the OS sandbox only, where its claims are enforced; with no free call to re-run, it stays that way."
            : `Approved, it describes calls under the OS sandbox only, where its claims are enforced. Then the ${free.length} free call${free.length === 1 ? " is" : "s are"} re-run under the sandbox with writes refused; if every one exits as the manifest says with nothing changed, and its recorded run created, modified or removed no file one of its arguments names, it describes calls without the sandbox too. A write inside a folder it names, or to a file no argument names, is not seen.`;
    return `${head} ${derived} ${after}`;
}
