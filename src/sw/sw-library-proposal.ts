// sw-library-proposal.ts — `propose_manifest` with `library` in the worker: the source read by a recorded ml.sh call, the card's verdict derived with nothing run, the load and the store on the person's word.

// READONLY_LIBRARY_MANIFEST.md, "The runtime import loop", ruled 2026-10-24 (A to D). Before the card: the file is
// resolved through the host (nothing runs) and refused outside every root, on a secret path, or past the size cap;
// then read by an `ml.sh` call of `cat` on that one file, recorded like any other and judged under cat's own manifest;
// its bytes must hash to what the host resolved. The shape rule (`libraryShape`, in a sandbox of its own) judges the
// source with nothing of it run. After the yes: the load under the gate, whose check is the enforce layer; only a
// load that agrees is stored, and a disagreement is logged at warn, since the card promised what the load refused.

import { isLibraryDraft, libraryNames, libraryNote, parseLibraryDraft, type LibraryDraft } from "../shell/library-proposal";
import { LIBRARY_MAX_BYTES, type LibraryRequest } from "../shell/stored-libraries";
import { addLibrary, storedLibraries } from "./sw-libraries";
import { pythonLibrary } from "./sw-python";
import { recordRunLog } from "./sw-run-log";
import { shRun, type ShCallContext } from "./sw-shell-call";
import { withShell } from "./sw-shell";
import type { ShResult } from "../shell/sh-call";

export { isLibraryDraft };

/** A library draft the worker checked: the entry it would store, and the card's note. */
export interface CheckedLibrary {
    request: LibraryRequest;
    note: string;
}

/** The file a draft names, as the host resolved it with nothing run: its realpath, root and sha256. */
interface ResolvedFile { path: string; root: string; sha256: string }

const hex = (b: ArrayBuffer): string => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");

/**
 * The file `d` names, resolved by the host and discarded (nothing runs), or why it cannot be proposed. Also the
 * precheck: what fails here is told to the model and never becomes a card.
 * @param step the proposing step, as the host's owner
 * @param d the draft
 */
async function resolveFile(step: { runId: string; seq: number }, d: LibraryDraft): Promise<ResolvedFile | { error: string }> {
    try {
        return await withShell(async (h) => {
            const roots = h.configured.roots.map((r) => r.path);
            if (!roots.length) return { error: "Error: no workspace folder is configured for ml.sh." };
            const facts = await h.client.spawn({ argv: ["cat", d.path], cwd: roots[0], mode: "host", pathArgs: [{ arg: 1, hash: true }], owner: { run: step.runId, seq: step.seq } });
            await h.client.discard(facts.id).catch(() => { /* expired: nothing to start either way */ });
            const p = facts.paths.find((x) => x.arg === 1);
            if (!p || !p.exists) return { error: `Error: ${d.path} does not exist.` };
            if (!p.inRoot) return { error: `Error: ${d.path} is outside every configured workspace folder.` };
            if (p.secret || p.containsSecret) return { error: `Error: ${d.path} is a secret path, which is never read for a library.` };
            if (typeof p.sha256 !== "string") return { error: `Error: ${d.path} is not a regular file the host can hash.` };
            const root = roots.filter((r) => p.path === r || p.path.startsWith(r.endsWith("/") ? r : r + "/")).sort((a, b) => b.length - a.length)[0];
            if (!root) return { error: `Error: ${d.path} is outside every configured workspace folder.` };
            return { path: p.path, root, sha256: p.sha256 };
        });
    } catch (e) { return { error: `Error: ml.sh is not available: ${(e as Error)?.message || String(e)}` }; }
}

/**
 * The precheck of a library draft: its arguments, its name against what is stored, and its file as the host resolves
 * it. Nothing runs and nothing is read.
 * @param step the proposing step
 * @param args the model's arguments
 * @returns the error the model reads, or null
 */
export async function precheckLibrary(step: { runId: string; seq: number }, args: Record<string, unknown>): Promise<string | null> {
    const d = parseLibraryDraft(args);
    if ("error" in d) return d.error;
    if (storedLibraries().some((s) => s.module === d.module)) return `Error: a library named ${d.module} is already stored.`;
    const f = await resolveFile(step, d);
    return "error" in f ? f.error : null;
}

/**
 * Check a library draft for the card: the file resolved, read by a recorded `ml.sh` call of `cat`, its bytes held to
 * the host's hash, and the source judged by the shape rule with nothing of it run.
 * @param ctx the step, as an `ml.sh` call's context: the read is this step's own call
 * @param args the model's arguments
 * @returns the entry and the card's note, or the error the card shows
 */
export async function checkLibraryProposal(ctx: ShCallContext, args: Record<string, unknown>): Promise<CheckedLibrary | { error: string }> {
    const d = parseLibraryDraft(args);
    if ("error" in d) return d;
    if (storedLibraries().some((s) => s.module === d.module)) return { error: `Error: a library named ${d.module} is already stored.` };
    const f = await resolveFile(ctx, d);
    if ("error" in f) return f;
    const r = await shRun(ctx, [["cat", f.path]]);
    if ("error" in r) return { error: `Error: reading ${d.path} with cat was refused: ${r.error}` };
    const out = (r.ok as ShResult).stdout;
    if (!(r.ok as ShResult).ok || out.error) return { error: `Error: cat could not read ${d.path}${out.error ? `: ${out.error}` : ""}.` };
    if (out.size > LIBRARY_MAX_BYTES || !out.complete) return { error: `Error: ${d.path} is ${out.size} bytes; a library is at most ${LIBRARY_MAX_BYTES}.` };
    const bytes = new TextEncoder().encode(out.text);
    const sha = hex(await crypto.subtle.digest("SHA-256", bytes));
    if (out.sha256 !== f.sha256 || sha !== f.sha256)
        return { error: `Error: ${d.path} changed while it was read, or is not UTF-8 text (sha256 ${f.sha256} resolved, ${out.sha256} read).` };
    const shape = await pythonLibrary("shape", { name: d.module, source: out.text, sha256: sha, names: [] });
    if (shape.why) return { error: `Error: ${d.module} is not a library the dialect can admit: ${shape.why}.` };
    const names = libraryNames(d, shape);
    if ("error" in names) return names;
    const request: LibraryRequest = { module: d.module, path: f.path, root: f.root, sha256: sha, source: out.text, names, origin: "proposed" };
    return { request, note: libraryNote(request) };
}

/** The outcome the tool reports, by run and module: set on approval, read once by the tool's own run. */
const outcomes = new Map<string, Promise<string>>();   // state: plumbing — one approval's answer, taken by the call it approved

/**
 * Load an approved library under the gate and store it only if the load agrees: what the gate's resolve calls on the
 * person's yes. The tool's run reads the outcome (`libraryOutcome`).
 * @param runId the run
 * @param c the draft the card showed
 */
export function approveLibrary(runId: string, c: CheckedLibrary): void {
    const r = c.request;
    outcomes.set(`${runId}:${r.module}`, (async () => {
        const loaded = await pythonLibrary("load", { name: r.module, source: r.source, sha256: r.sha256, names: r.names.map((n) => n.name) });
        if (loaded.why) {
            // The card said the shape rule admits it; the load, which is the enforce layer, did not.
            recordRunLog(runId, { level: "warn", subsystem: "python", kind: "library-disagreed", reason: "load-refused", detail: { module: r.module, sha256: r.sha256, why: loaded.why } });
            return `Not stored: loading ${r.module} under the dialect's gate refused it (${loaded.why}), though its shape was admitted.`;
        }
        const stored = await addLibrary(r);
        if ("refused" in stored) return `Not stored: ${stored.refused}.`;
        recordRunLog(runId, { subsystem: "python", kind: "library-added", reason: "proposed", detail: { library: stored.id, module: stored.module, sha256: stored.sha256 } });
        return `Stored for every workspace: a cell inside the read-only Python dialect may now \`import ${stored.module}\` and use ${stored.names.map((n) => n.name).join(", ")}. It is the source as read now; a change to ${stored.path} needs a new proposal.`;
    })().catch((e) => `Not stored: ${(e as Error)?.message || String(e)}.`));
}

/**
 * The outcome of the person's answer for this library, once. Undefined when the person did not approve it.
 * @param runId the run
 * @param args the model's arguments
 */
export async function libraryOutcome(runId: string, args: Record<string, unknown>): Promise<string | undefined> {
    const draft = parseLibraryDraft(args);
    if ("error" in draft) return undefined;
    const k = `${runId}:${draft.module}`;
    const o = outcomes.get(k);
    outcomes.delete(k);
    return o;
}
