// libraries-section.tsx — the Settings "Python libraries" page: every tier 3 library a person approved for the read-only Python dialect, with what a cell may use from it, where it was read from, its source, and a remove that says it restarts the Python sandboxes.

// READONLY_LIBRARY_MANIFEST.md, "The runtime import loop", ruled 2026-10-24: an entry is a snapshot of the approved
// bytes, global only, stored only from a card the person approved (so this page has no add); removing one restarts every
// Python worker that was handed a library, since nothing unloads a module (ruling D). The worker's side is `LIBRARIES`
// (background.ts).
import { useEffect, useState } from "preact/hooks";
import type { StoredLibrary } from "../../shell/stored-libraries";
import { cursorTipOn } from "../ui-kit";

/** What the worker's `LIBRARIES` answers: the stored libraries, and after a remove how many sandboxes it restarted. */
export interface LibrariesView { libraries: StoredLibrary[]; restarted?: number }
/** The storage key the store lives under, re-read on change. Defined as LIBRARIES_KEY in src/sw/sw-libraries.ts (worker code, not imported into this bundle). */
const LIBRARIES_STORAGE_KEY = "ml_libraries_global";

/**
 * Ask the worker for the stored libraries (`LIBRARIES`), applying a remove first when one is given.
 * @param payload `{}` to read, or `{ op: "remove", id }`
 * @returns the view after, or `{ error }` when the worker refused, or null when it could not be asked
 */
function askLibraries(payload: Record<string, unknown>): Promise<{ view?: LibrariesView; error?: string } | null> {
    return new Promise((resolve) => {
        try {
            chrome.runtime.sendMessage({ type: "LIBRARIES", payload }, (res: { data?: LibrariesView; error?: string } | undefined) => {
                void chrome.runtime.lastError;
                if (res?.data) resolve({ view: { libraries: res.data.libraries ?? [], restarted: res.data.restarted } });
                else resolve(res?.error ? { error: res.error } : null);
            });
        } catch { resolve(null); }
    });
}

/** What a cell may use from a stored library, as the card showed it: `total(xs, start=0), SCALE`. */
export const libraryUses = (s: Pick<StoredLibrary, "names">): string => s.names.map((n) => n.kind === "def" ? `${n.name}(${n.signature})` : n.name).join(", ");

/**
 * One stored library: its import name, what a cell may use, where and when it was read, its pin, the source behind a
 * disclosure, and a remove.
 * @group settings
 * @gallery proposed {"entry": {"id": "lib-1", "module": "stats_lib", "path": "/Users/me/src/proj/lib/stats.py", "root": "/Users/me/src/proj", "sha256": "3f1c2a9e0b7d4c5a6e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d", "source": "\"\"\"Stats.\"\"\"\ndef total(xs, start=0):\n    return sum(xs) + start\nSCALE = 2\n", "names": [{"name": "total", "kind": "def", "signature": "xs, start=0"}, {"name": "SCALE", "kind": "constant", "signature": ""}], "origin": "proposed", "created": 1760000000000}}
 * @param entry the stored entry
 * @param onRemove removes it
 */
export function LibraryRow({ entry, onRemove }: { entry: StoredLibrary; onRemove?: () => void }) {
    const bytes = new TextEncoder().encode(entry.source).length;
    return (
        <div class="pol-row lib-row" data-library-id={entry.id}>
            <div class="pol-head">
                <span class="pol-label"><code>import {entry.module}</code></span>
                <span class="pol-tag">proposed by the model, approved by you</span>
                <button class="perm-x" aria-label={`Remove the library ${entry.module}`} {...cursorTipOn(`Remove the library ${entry.module}`)} onClick={onRemove}>✕</button>
            </div>
            <div class="set-hint">A cell inside the dialect may use {libraryUses(entry)}.</div>
            <div class="set-hint">Read from {entry.path} on {new Date(entry.created).toLocaleString()} ({bytes} bytes, sha256 {entry.sha256.slice(0, 12)}). This is the source as it was then: a change to the file needs a new proposal.</div>
            <details>
                <summary class="set-hint">The source</summary>
                <pre class="pol-code"><code>{entry.source}</code></pre>
            </details>
        </div>
    );
}

/**
 * The page's body: the stored libraries, each with a remove, and what a remove does to the Python sandboxes.
 * @gallery {"initial": {"libraries": [{"id": "lib-1", "module": "stats_lib", "path": "/Users/me/src/proj/lib/stats.py", "root": "/Users/me/src/proj", "sha256": "3f1c2a9e0b7d4c5a6e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d", "source": "def total(xs):\n    return sum(xs)\n", "names": [{"name": "total", "kind": "def", "signature": "xs"}], "origin": "proposed", "created": 1760000000000}]}}
 * @group settings
 * @param initial the view to draw without asking the worker (the gallery's); absent asks it
 */
export function LibrariesSectionBody({ initial }: { initial?: LibrariesView }) {
    const [view, setView] = useState<LibrariesView | null>(initial ?? null);
    const [err, setErr] = useState("");
    const [note, setNote] = useState("");
    useEffect(() => {
        if (initial) return;
        const read = (): void => { void askLibraries({}).then((r) => { if (r?.view) setView(r.view); }); };
        read();
        const onChange = (changes: Record<string, unknown>) => { if (LIBRARIES_STORAGE_KEY in changes) read(); };
        try { chrome.storage.onChanged.addListener(onChange); } catch { /* not an extension page */ }
        return () => { try { chrome.storage.onChanged.removeListener(onChange); } catch { /* ignore */ } };
    }, []);
    if (!view) return <div class="set-hint">Reading…</div>;
    const remove = (s: StoredLibrary): void => {
        void askLibraries({ op: "remove", id: s.id }).then((r) => {
            if (!r?.view) { setErr(r?.error ?? "The extension could not be reached."); return; }
            setView(r.view);
            setErr("");
            const n = r.view.restarted ?? 0;
            setNote(`Removed ${s.module}. ${n ? `${n} Python sandbox${n === 1 ? "" : "es"} restarted, so no cell can still import it.` : "No Python sandbox had loaded a library, so none restarted."}`);
        });
    };
    return (
        <>
            <div class="set-note">A pure-Python module the model proposed and you approved, which a cell inside the read-only Python dialect may <code>import</code>. Its code runs under the same gate as the cell's, so it adds an import, never a permission. Each is the source as you saw it on the card, for every workspace. <b>Removing one restarts the Python sandboxes that loaded a library</b>, since a loaded module stays importable until its sandbox restarts: a run's kept Python names in those sandboxes are lost, and its next cell says so.</div>
            {err ? <div class="set-err lib-err">{err}</div> : null}
            {note ? <div class="set-hint lib-note">{note}</div> : null}
            {view.libraries.length
                ? <div class="pol-rows">{view.libraries.map((s) => <LibraryRow key={s.id} entry={s} onRemove={() => remove(s)} />)}</div>
                : <div class="set-hint">No library stored. The model proposes one with <code>propose_manifest</code>; it is stored only when you approve its card.</div>}
        </>
    );
}
