// manifests-section.tsx — the Settings "Program manifests" page: every program manifest stored beside the shipped ones,
// global and per workspace, with its pin and its evidence, an add that the host pins, and a remove.

// docs/spec/PROGRAM_MANIFEST.md, "Registering a program": one page lists them, like the policy page: shipped, the
// person's, the model's, each with its source, its pin and the measured evidence. What it adds is the person's; the
// worker has the host resolve it and pins it (`MANIFESTS`, background.ts), so nothing here names a fingerprint or hash.
import { useEffect, useState } from "preact/hooks";
import type { StoredManifest } from "../../shell/stored-manifests";
import { cursorTipOn } from "../ui-kit";

/** What the worker's `MANIFESTS` answers (`manifestView`, src/sw/sw-manifests.ts), with why B3 forced an add's scope. */
export interface ManifestView { global: StoredManifest[]; workspace: { root: string; manifests: StoredManifest[] }[]; shipped: string[]; forced?: string }
/** The storage keys the store lives under, re-read on change. Defined as GLOBAL_MANIFESTS_KEY and WORKSPACE_MANIFESTS_KEY in src/sw/sw-manifests.ts (worker code, not imported into this bundle). */
const MANIFEST_STORAGE_KEYS = ["ml_manifests_global", "ml_manifests_workspace"];

/** The manifest a new entry starts from: a reader whose operands are paths, any version. */
const MANIFEST_STARTER = JSON.stringify({ program: "mytool", version: { range: "*", args: [], pattern: "" }, command: { effects: ["read"], paths: "operands", flags: {} } }, null, 2);

/**
 * Ask the worker for the stored manifests (`MANIFESTS`), applying an add or remove first when one is given.
 * @param payload `{}` to read, or `{ op, ... }` to change and read
 * @returns the view after, or `{ error }` when the worker refused, or null when it could not be asked
 */
function askManifests(payload: Record<string, unknown>): Promise<{ view?: ManifestView; error?: string } | null> {
    return new Promise((resolve) => {
        try {
            chrome.runtime.sendMessage({ type: "MANIFESTS", payload }, (res: { data?: ManifestView; error?: string } | undefined) => {
                void chrome.runtime.lastError;
                if (res?.data) resolve({ view: { global: res.data.global ?? [], workspace: res.data.workspace ?? [], shipped: res.data.shipped ?? [], forced: res.data.forced } });
                else resolve(res?.error ? { error: res.error } : null);
            });
        } catch { resolve(null); }
    });
}

/** The program a stored entry describes, as a call names it: `mytool`, or `node scripts/gen.mjs`. */
export const manifestName = (s: Pick<StoredManifest, "manifest">): string => s.manifest.entrypoint ? `${s.manifest.program} ${s.manifest.entrypoint.path}` : s.manifest.program;

/** What the entry is pinned to, in words: the binary as the host resolved it, or the script's hash. */
export function pinText(s: Pick<StoredManifest, "manifest" | "pin">): string {
    if (s.manifest.entrypoint?.sha256) return `pinned to the script's sha256 ${s.manifest.entrypoint.sha256.slice(0, 12)}`;
    if (!s.pin) return "not pinned";
    return `pinned to ${s.pin.path} (fingerprint ${s.pin.fingerprint}${s.pin.version ? `, version ${s.pin.version}` : ""})`;
}

/** What a script's entry says about where it applies: outside the sandbox nothing bounds what the script imports. */
const SCRIPT_SANDBOX_ONLY = "A script is described under the sandbox only, whoever added it: outside it nothing bounds what the script imports.";

/**
 * Where the entry describes calls, and the evidence it rests on: a label, its tone, and the line under it. A script is
 * sandbox-only whatever its origin or evidence (`entrypointMisses`, sh-call.ts); a proposed program until its evidence passes (B5).
 */
export function evidenceOf(s: Pick<StoredManifest, "manifest" | "origin" | "evidence" | "evidenceFailure">): { label: string; tone: "allow" | "ask" | "deny"; detail?: string } {
    const when = (at: number) => new Date(at).toLocaleString();
    const ev = s.origin === "person" ? undefined
        : s.evidence ? { tone: "allow" as const, line: `Evidence: ${s.evidence.calls} call${s.evidence.calls === 1 ? "" : "s"} re-run under the sandbox with writes refused, all as it says (${when(s.evidence.at)}).` }
        : s.evidenceFailure ? { tone: "deny" as const, line: `Evidence failed on ${s.evidenceFailure.argv.join(" ")}: ${s.evidenceFailure.why} (${when(s.evidenceFailure.at)}).` }
        : { tone: "ask" as const, line: "No evidence: no call of it was re-run." };
    if (s.manifest.entrypoint) return { label: "under the sandbox only", tone: ev?.tone === "deny" ? "deny" : "ask", detail: [ev?.line, SCRIPT_SANDBOX_ONLY].filter(Boolean).join(" ") };
    if (!ev || ev.tone === "allow") return { label: "with or without the sandbox", tone: "allow", ...(ev ? { detail: ev.line } : {}) };
    return { label: "under the sandbox only", tone: ev.tone, detail: ev.line };
}

/**
 * One stored program manifest: what it describes, whose it is, where it describes calls and the evidence for that, its
 * pin, the manifest itself behind a disclosure, and a remove.
 * @group settings
 * @gallery person {"entry": {"id": "man-1", "scope": "global", "manifest": {"program": "mytool", "version": {"range": "*", "args": [], "pattern": ""}, "command": {"effects": ["read"], "paths": "operands", "flags": {}}}, "origin": "person", "created": 1760000000000, "pin": {"path": "/opt/homebrew/bin/mytool", "fingerprint": "16777232:4242:183920:1760000000", "inRoot": false}}}
 * @gallery proposed with evidence {"entry": {"id": "man-2", "scope": "global", "manifest": {"program": "file", "version": {"range": "*", "args": [], "pattern": ""}, "command": {"effects": ["read"], "paths": "operands", "flags": {}}}, "origin": "proposed", "created": 1760000000000, "pin": {"path": "/usr/bin/file", "fingerprint": "16777232:99:52000:1750000000", "inRoot": false}, "evidence": {"calls": 1, "at": 1760000000000}}}
 * @gallery script added by hand {"entry": {"id": "man-4", "scope": "workspace", "root": "/Users/me/src/proj", "manifest": {"program": "node", "entrypoint": {"path": "scripts/report.mjs", "sha256": "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"}, "command": {"effects": ["read"], "paths": "operands", "flags": {}}}, "origin": "person", "created": 1760000000000}}
 * @gallery proposed failed {"entry": {"id": "man-3", "scope": "workspace", "root": "/Users/me/src/proj", "manifest": {"program": "node", "entrypoint": {"path": "scripts/gen.mjs", "sha256": "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"}, "command": {"effects": ["read"], "paths": "operands", "flags": {}}}, "origin": "proposed", "created": 1760000000000, "evidenceFailure": {"argv": ["node", "/Users/me/src/proj/scripts/gen.mjs", "out.json"], "why": "it exited 1, not one of 0", "at": 1760000000000}}}
 * @param entry the stored entry
 * @param onRemove removes it
 */
export function ManifestRow({ entry, onRemove }: { entry: StoredManifest; onRemove?: () => void }) {
    const name = manifestName(entry);
    const ev = evidenceOf(entry);
    return (
        <div class="pol-row man-row" data-manifest-id={entry.id}>
            <div class="pol-head">
                <span class={`pol-effect pol-${ev.tone}`}>{ev.label}</span>
                <span class="pol-label"><code>{name}</code></span>
                <span class="pol-tag">{entry.origin === "proposed" ? "proposed by the model" : "yours"}</span>
                <button class="perm-x" aria-label={`Remove the manifest for ${name}`} {...cursorTipOn(`Remove the manifest for ${name}`)} onClick={onRemove}>✕</button>
            </div>
            <div class="set-hint">{pinText(entry)}. A changed program file describes nothing until it is registered again.</div>
            {ev.detail ? <div class={ev.tone === "deny" ? "set-err pol-broken" : "set-hint"}>{ev.detail}</div> : null}
            <details>
                <summary class="set-hint">The manifest</summary>
                <pre class="pol-code"><code>{JSON.stringify(entry.manifest, null, 2)}</code></pre>
            </details>
        </div>
    );
}

/**
 * The page's body: the shipped programs, the global manifests with the add form, and each workspace's.
 * @gallery {"roots": ["/Users/me/src/proj"], "initial": {"global": [{"id": "man-1", "scope": "global", "manifest": {"program": "mytool", "version": {"range": "*", "args": [], "pattern": ""}, "command": {"effects": ["read"], "paths": "operands", "flags": {}}}, "origin": "person", "created": 1760000000000, "pin": {"path": "/opt/homebrew/bin/mytool", "fingerprint": "16777232:4242:183920:1760000000", "inRoot": false}}], "workspace": [], "shipped": ["cat", "git", "grep", "ls", "rm"]}}
 * @group settings
 * @param roots the configured workspace folders, as given in Settings
 * @param initial the view to draw without asking the worker (the gallery's); absent asks it
 */
export function ManifestsSectionBody({ roots, initial }: { roots: readonly string[]; initial?: ManifestView }) {
    const [view, setView] = useState<ManifestView | null>(initial ?? null);
    const [err, setErr] = useState("");
    const [note, setNote] = useState("");
    const [scope, setScope] = useState("global");
    const [text, setText] = useState(MANIFEST_STARTER);
    useEffect(() => {
        if (initial) return;
        const read = (): void => { void askManifests({}).then((r) => { if (r?.view) setView(r.view); }); };
        read();
        const onChange = (changes: Record<string, unknown>) => { if (MANIFEST_STORAGE_KEYS.some((k) => k in changes)) read(); };
        try { chrome.storage.onChanged.addListener(onChange); } catch { /* not an extension page */ }
        return () => { try { chrome.storage.onChanged.removeListener(onChange); } catch { /* ignore */ } };
    }, []);
    if (!view) return <div class="set-hint">Reading…</div>;
    const send = (payload: Record<string, unknown>): Promise<boolean> => askManifests(payload).then((r) => {
        if (r?.view) { setView(r.view); setErr(""); setNote(r.view.forced ? `Stored for its workspace: ${r.view.forced}.` : ""); return true; }
        setErr(r?.error ?? "The extension could not be reached.");
        return false;
    });
    const add = (): void => {
        let manifest: unknown;
        try { manifest = JSON.parse(text); } catch (e) { setErr(`Not JSON: ${(e as Error).message}`); return; }
        const payload = scope === "global" ? { op: "add", scope, manifest } : { op: "add", scope: "workspace", root: scope, manifest };
        void send(payload).then((ok) => { if (ok) setText(MANIFEST_STARTER); });
    };
    const rows = (list: StoredManifest[]) => list.map((s) => <ManifestRow key={s.id} entry={s} onRemove={() => { void send({ op: "remove", id: s.id }); }} />);
    return (
        <>
            <div class="set-note">A program manifest says what a program's calls do (which arguments are paths, what it reads or writes), so a call it describes can go without asking you when a policy allows it. Without one, every call asks. Each is <b>pinned</b> to the program file the process host found when it was added: a different file at that path, or a changed script, describes nothing. One the model proposed describes calls only under the OS sandbox, where its claims are enforced, until its evidence run passes.</div>
            {err ? <div class="set-err man-err">{err}</div> : null}
            {note ? <div class="set-hint man-note">{note}</div> : null}
            <div class="set-hint">Shipped with the extension, not replaceable here: {view.shipped.join(", ")}.</div>
            <div class="set-hint">Global: for every workspace.</div>
            {view.global.length ? <div class="pol-rows">{rows(view.global)}</div> : <div class="set-hint">No global manifest.</div>}
            {view.workspace.map((w) => (
                <div class="pol-run" key={w.root} data-root={w.root}>
                    <div class="set-hint">Workspace <span class="perm-host">{w.root}</span>: only while it is a workspace folder above.</div>
                    <div class="pol-rows">{rows(w.manifests)}</div>
                </div>
            ))}
            <div class="pol-add man-add">
                <div class="set-hint">Add one. The process host resolves the program now (nothing runs) and pins it; a program inside a workspace folder, and any script, is kept for that workspace.</div>
                <select aria-label="Where the new manifest applies" value={scope} onChange={(e: any) => setScope(e.target.value)}>
                    <option value="global">every workspace</option>
                    {roots.map((r) => <option key={r} value={r}>{r}</option>)}
                </select>
                <textarea class="pol-source-input man-source" aria-label="New manifest (JSON)" rows={8} spellcheck={false} value={text} onInput={(e: any) => setText(e.target.value)} />
                <button class="test-btn" onClick={add}>Add</button>
            </div>
        </>
    );
}
