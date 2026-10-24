// stored-manifests.ts — the program manifests a person registered or approved, beside the shipped ones: what a stored entry
// is, what the store refuses, and what a call's facts must bear out before one describes it. No `chrome`.

// PROGRAM_MANIFEST.md, "Registering a program", ruled 2026-10-23 (B1 to B5): a stored manifest DESCRIBES a program, it is
// never permission for one. A shipped manifest's key is never stored over (shipped wins); a program resolving inside a
// workspace root is described only by that workspace's own entry; a binary is pinned by the host's fingerprint (and the
// version it reported, when it reports one); a manifest the model proposed describes a call only under the OS sandbox
// until its evidence run marks it. The storage itself is `src/sw/sw-manifests.ts`.

import type { HostFacts } from "./host-protocol";
import { validateManifest, type ProgramManifest } from "./program-manifest";

/** Whose word a stored manifest is: the person's (written or installed in DevTools Settings), or the model's draft the
 *  person approved on a card (`propose_manifest`). */
export type ManifestOrigin = "person" | "proposed";

/** What a stored binary manifest is pinned to: the resolved program as the host reported it when it was registered. Any
 *  change (an upgrade, a rebuild, a different file at the path) drops the program back to undescribed. */
export interface ManifestPin {
    /** The resolved program, absolute. */
    path: string;
    /** The host's `program.fingerprint` (device, inode, size, mtime). */
    fingerprint: string;
    /** Whether the program resolved inside a workspace root (the host's `program.inRoot`). */
    inRoot: boolean;
    /** The version it reported then, when it reports one: it must report the same. */
    version?: string;
}

/** What a proposed manifest's evidence run measured once it passed: every one of this run's free calls of the program,
 *  re-run under the sandbox and the draft's envelope, exited within its `okCodes` with nothing changed. */
export interface ManifestEvidence {
    /** How many calls it re-ran, all passing. */
    calls: number;
    at: number;
}

/** The first call an evidence run saw fail, kept for the registration page: the entry stays sandbox-only. */
export interface ManifestEvidenceFailure {
    argv: string[];
    why: string;
    at: number;
}

/** One stored program manifest. `global` holds for every workspace; `workspace` only while `root` (a realpath) is a
 *  configured root. An interpreted script's manifest is pinned by its own `entrypoint.sha256`; a binary's by `pin`. */
export interface StoredManifest {
    id: string;
    scope: "global" | "workspace";
    root?: string;
    manifest: ProgramManifest;
    origin: ManifestOrigin;
    created: number;
    pin?: ManifestPin;
    /** A proposed entry's passed evidence run: with it the entry describes plain-host calls too (B5). */
    evidence?: ManifestEvidence;
    /** A proposed entry's failed evidence run. */
    evidenceFailure?: ManifestEvidenceFailure;
}

/** What a caller asks the store to keep: everything but the id and the time, which the store assigns, and the evidence,
 *  which only an evidence run records. */
export type ManifestRequest = Omit<StoredManifest, "id" | "created" | "evidence" | "evidenceFailure">;

/** The key two manifests compete for: the program, or the program and its script. */
export function manifestKey(m: Pick<ProgramManifest, "program" | "entrypoint">): string {
    return m.entrypoint ? `${m.program} ${m.entrypoint.path}` : m.program;
}

const isAbsolute = (p: unknown): p is string => typeof p === "string" && p.startsWith("/") && !p.includes("\0");

/** `a/./b/` → `/a/b`, textual: roots compare as the host resolved them. */
const normalRoot = (p: string): string => "/" + p.split("/").filter((c) => c && c !== ".").join("/");

/**
 * Why the store refuses to keep `r`, or undefined when it may. Checked against what is already stored and the shipped
 * manifests, at store time, so a call never meets a manifest that should not be there.
 * @param r the entry asked for
 * @param stored what the store holds now
 * @param shipped the shipped manifests, by program
 * @returns the reason, for the person
 */
export function storeRefusal(r: ManifestRequest, stored: readonly StoredManifest[], shipped: Readonly<Record<string, ProgramManifest>>): string | undefined {
    const problems = validateManifest(r.manifest);
    if (problems.length) return `not a valid program manifest: ${problems.slice(0, 3).join("; ")}`;
    if (r.origin !== "person" && r.origin !== "proposed") return "origin is person or proposed";
    if (r.scope === "workspace" ? !isAbsolute(r.root) : r.scope !== "global" || r.root !== undefined)
        return "a workspace manifest names its root (an absolute path); a global one names none";
    const m = r.manifest;
    // B2 for both kinds: an entrypoint manifest naming a shipped program would be read before the shipped one too.
    if (shipped[m.program]) return `${m.program} is described by the shipped manifest src/shell/manifests/${m.program}.json, which a stored one does not replace`;
    if (m.entrypoint) {
        if (r.pin !== undefined) return "a script's manifest is pinned by its entrypoint's sha256, not by a program pin";
        if (r.scope !== "workspace") return `${m.entrypoint.path} arrived with a repository, so its manifest belongs to that workspace, not global`;
    } else {
        const p = r.pin;
        if (!p || !isAbsolute(p.path) || typeof p.fingerprint !== "string" || !p.fingerprint || typeof p.inRoot !== "boolean"
            || (p.version !== undefined && (typeof p.version !== "string" || !p.version)))
            return "a program's manifest is pinned to the program the host resolved: its path, fingerprint and whether it is inside a root";
        // A version is read only for a manifest that says how (`versionOf`): pinned to one it never reads, every call misses.
        if (p.version !== undefined && (m.version.range === "*" || !m.version.args.length))
            return `${m.program}'s manifest reads no version, so its pin cannot name one`;
        if (p.inRoot && r.scope !== "workspace") return `${p.path} is inside a workspace root, so only that workspace may describe it`;
        if (p.inRoot && !(p.path === normalRoot(r.root!) || p.path.startsWith(normalRoot(r.root!) + "/")))
            return `${p.path} is not inside the workspace ${r.root} it is registered for`;
    }
    const key = manifestKey(m);
    const same = stored.find((s) => s.scope === r.scope && s.root === r.root && manifestKey(s.manifest) === key);
    if (same) return `${key} is already registered here (${same.id}); remove it first`;
    return undefined;
}

/**
 * Whether storage held a well-formed entry of `scope` that the store would take now; anything else is dropped on read,
 * never repaired. A stored entry for a shipped program (B2) is dropped too: the call path takes the first match, stored first.
 */
export function validStored(v: unknown, scope: StoredManifest["scope"], shipped: Readonly<Record<string, ProgramManifest>>): v is StoredManifest {
    const s = v as StoredManifest | null;
    if (!s || typeof s !== "object" || typeof s.id !== "string" || typeof s.created !== "number" || s.scope !== scope) return false;
    const e = s.evidence, f = s.evidenceFailure;
    if (e !== undefined && (s.origin !== "proposed" || !e || typeof e.calls !== "number" || !(e.calls > 0) || typeof e.at !== "number")) return false;
    if (f !== undefined && (!f || !Array.isArray(f.argv) || !f.argv.every((a) => typeof a === "string") || typeof f.why !== "string" || typeof f.at !== "number")) return false;
    return storeRefusal({ scope: s.scope, root: s.root, manifest: s.manifest, origin: s.origin, pin: s.pin }, [], shipped) === undefined;
}

/**
 * The stored entries that may describe a call made with these roots, the workspace's own first, then the global ones;
 * the shipped manifests come after them all (`withStored`).
 * @param stored every stored entry
 * @param roots the configured roots, as the host resolved them
 */
export function applicable(stored: readonly StoredManifest[], roots: readonly string[]): StoredManifest[] {
    const here = new Set(roots.map(normalRoot));
    return [...stored.filter((s) => s.scope === "workspace" && here.has(normalRoot(s.root!))), ...stored.filter((s) => s.scope === "global")];
}

/**
 * Why a stored entry does not describe this call, each a line of `why`; empty when it does. The host's facts must bear
 * out its pin, and a proposed one needs the sandbox until its evidence run passed.
 * @param facts what `spawn` answered
 * @param s the stored entry chosen
 * @param version the version the program reported this call, or null when it was not read
 */
export function storedMisses(facts: HostFacts, s: StoredManifest, version: string | null): string[] {
    const why: string[] = [];
    if (s.origin === "proposed" && !facts.sandboxed && !s.evidence)
        why.push(`the manifest for ${manifestKey(s.manifest)} was proposed by the model, so it describes a call only under the OS sandbox until an evidence run passes`);
    if (facts.program.inRoot && s.scope !== "workspace")
        why.push(`${facts.program.path} is inside a workspace root, so only that workspace's manifest describes it`);
    const p = s.pin;
    if (p) {
        if (facts.program.path !== p.path || facts.program.fingerprint !== p.fingerprint)
            why.push(`${facts.program.path} is not the program its manifest was registered for (${p.path}, ${p.fingerprint})`);
        else if (p.version !== undefined && version !== p.version)
            why.push(`${p.path} reported ${version === null ? "no version" : version}, not ${p.version}, which its manifest was registered for`);
    }
    return why;
}
