// archive-section.tsx — the Settings "Archive folder" section: picking the folder the session archive copies itself
// into, and everything its permission can do afterwards. The body (`ArchiveFolderBody`) is pure, taking the folder's
// report and the actions as props, so a client drawing a REMOTE runtime can render it from the contract; this
// browser's own wiring is `LocalArchiveFolder` below.
//
// The permission has four states and each one says what to do next, because the one that surprises people is the
// third: a folder picked with "Allow this time" is not writable after a restart. Nothing is lost while it is not
// (months wait, marked pending), and one click with "Allow on every visit" chosen makes it stay connected.
import { useEffect, useState } from "preact/hooks";
import type { FolderReport } from "../archive-worker";
import { canPickFolder, pickFolder, regrantFolder, saveFolder } from "../archive-folder";

/** The browser-specific way to turn folder access on, when there is one. */
export const BRAVE_FLAG = "brave://flags/#file-system-access-api";

const ago = (t: number | null): string => {
    if (!t) return "not yet";
    const s = Math.round((Date.now() - t) / 1000);
    return s < 90 ? "just now" : s < 5400 ? `${Math.round(s / 60)} minutes ago` : new Date(t).toLocaleString();
};

/** The section's body. `busy` names the action in flight, so its button says so and none is pressed twice. */
export function ArchiveFolderBody(p: {
    report: FolderReport | null;
    archiveOn: boolean;
    isBrave: boolean;
    /** false inside a frame of another site (the in-page overlay), where the browser refuses the picker and the prompt */
    canAskHere: boolean;
    busy: string | null;
    message: string;
    onPick(): void; onRegrant(): void; onSync(): void; onImport(): void; onForget(): void;
}) {
    const r = p.report;
    if (!r) return <div class="set-hint">{p.message || "Reading…"}</div>;
    const pending = r.pending ? <div class="set-hint">{r.pending} month file{r.pending === 1 ? "" : "s"} wait to be written. Nothing is lost meanwhile.</div> : null;
    const note = p.message ? <div class="set-hint arch-msg">{p.message}</div> : null;
    const off = !p.archiveOn ? <div class="set-warn">Sessions reach the folder only with "Archive sessions instead of deleting them" on (above).</div> : null;
    const btn = (label: string, busyLabel: string, key: string, on: () => void, primary = false) => (
        <button class={`test-btn${primary ? " arch-primary" : ""}`} disabled={!!p.busy} onClick={on}>{p.busy === key ? busyLabel : label}</button>
    );
    // A click that needs the browser's own prompt, from where the browser will not show one.
    const asks = (label: string, busyLabel: string, key: string, on: () => void, primary = false) => p.canAskHere
        ? btn(label, busyLabel, key, on, primary)
        : <div class="set-hint">To {label.replace(/…$/, "").toLowerCase()}, open Settings in the chat page (a tab of its own): inside a web page, the browser does not allow picking a folder or asking for permission.</div>;

    if (r.state === "unsupported") return (
        <div class="arch">
            {p.isBrave ? <>
                <div class="set-warn">Brave turns folder access off by default.</div>
                <div class="set-hint">Open <code>{BRAVE_FLAG}</code>, set it to <b>Enabled</b>, and relaunch Brave. The archive keeps working in the browser's own storage meanwhile.</div>
                <button class="test-btn" onClick={() => navigator.clipboard?.writeText(BRAVE_FLAG)}>Copy that address</button>
            </> : <div class="set-hint">This browser does not let an extension use a folder on your disk. The archive keeps working in the browser's own storage.</div>}
        </div>
    );

    if (r.state === "none") return (
        <div class="arch">
            <div class="set-hint">Pick a folder and the archive copies itself there as one SQLite file per month (<code>2026-09.sqlite</code>). Any SQLite tool opens them, they survive a wiped browser, and a sync tool (Syncthing, a NAS, git) is safe on them: a file is replaced only once it is completely written.</div>
            {asks("Pick a folder…", "Picking…", "pick", p.onPick, true)}
            {off}{note}
        </div>
    );

    if (r.state === "needs-grant") return (
        <div class="arch">
            <div class="set-warn">The archive folder{r.name ? <> <b>{r.name}</b></> : null} needs permission again.</div>
            <div class="set-hint">The browser asks again after a restart unless it was allowed for good. Reconnect, and in the prompt choose <b>Allow on every visit</b> so it stays connected.</div>
            {asks("Reconnect", "Asking…", "regrant", p.onRegrant, true)}
            {pending}{off}{note}
        </div>
    );

    return (
        <div class="arch">
            <div class="set-field"><span>Folder</span><div><b>{r.name}</b>, written {ago(r.lastSync)}</div></div>
            {pending}
            <div class="arch-actions">
                {btn("Write now", "Writing…", "sync", p.onSync)}
                {btn("Import from this folder", "Importing…", "import", p.onImport)}
                {p.canAskHere ? btn("Change folder…", "Picking…", "pick", p.onPick) : null}
                {btn("Stop using this folder", "…", "forget", p.onForget)}
            </div>
            <div class="set-hint">Import copies sessions from the folder's files into this browser's archive, skipping any it already has: how a new browser profile gets its history back. Stopping leaves the folder's files where they are.</div>
            {off}{note}
        </div>
    );
}

/** A top-level page (the chat page, the DevTools panel's own page) rather than a frame inside someone's site. */
function isTopLevel(): boolean {
    try { return window.self === window.top || new URL(document.referrer || location.href).protocol === "chrome-extension:"; } catch { return false; }
}

/** Ask the worker about the folder, or tell it what a click just did. */
function folderMessage(action: "state" | "picked" | "sync" | "import"): Promise<FolderReport> {
    return new Promise((resolve, reject) => chrome.runtime.sendMessage({ type: "ARCHIVE_FOLDER", payload: { action } }, (r?: { data?: FolderReport; error?: string }) => {
        if (r?.data) resolve(r.data);
        else reject(new Error(r?.error || "the archive did not answer"));
    }));
}

/** This browser's archive folder: the body, wired to the picker (here, in the page, inside the click) and the worker. */
export function LocalArchiveFolder({ archiveOn }: { archiveOn: boolean }) {
    const [report, setReport] = useState<FolderReport | null>(null);
    const [busy, setBusy] = useState<string | null>(null);
    const [message, setMessage] = useState("");
    const [isBrave, setIsBrave] = useState(false);
    const refresh = () => folderMessage("state").then((r) => {
        // Only a page can tell that picking is impossible here; the worker reports "none" for a folder never picked.
        setReport(r.state === "none" && !canPickFolder() ? { ...r, state: "unsupported" } : r);
    }, (e) => setMessage(String(e?.message || e)));
    useEffect(() => {
        void refresh();
        void (navigator as { brave?: { isBrave(): Promise<boolean> } }).brave?.isBrave().then(setIsBrave).catch(() => {});
    }, []);
    const act = (key: string, run: () => Promise<string | void>) => async () => {
        setBusy(key); setMessage("");
        try { const said = await run(); if (said) setMessage(said); }
        catch (e) { setMessage(`That did not work: ${(e as Error)?.message || e}`); }
        finally { setBusy(null); void refresh(); }
    };
    return (
        <ArchiveFolderBody report={report} archiveOn={archiveOn} isBrave={isBrave} busy={busy} message={message}
            canAskHere={isTopLevel()}
            onPick={act("pick", async () => {
                const name = await pickFolder();
                if (!name) return;
                const r = await folderMessage("picked");
                return `Using ${name}. ${r.written?.length ? `Wrote ${r.written.length} month file${r.written.length === 1 ? "" : "s"}.` : "Nothing archived yet to write."}`;
            })}
            onRegrant={act("regrant", async () => {
                if (!(await regrantFolder())) return "Not allowed, so the folder stays paused.";
                const r = await folderMessage("sync");
                return `Connected. ${r.written?.length ? `Wrote ${r.written.length} waiting month file${r.written.length === 1 ? "" : "s"}.` : ""}`;
            })}
            onSync={act("sync", async () => {
                const r = await folderMessage("sync");
                return r.written?.length || r.removed?.length ? `Wrote ${r.written?.length ?? 0}, removed ${r.removed?.length ?? 0}.` : "Already up to date.";
            })}
            onImport={act("import", async () => {
                const r = await folderMessage("import");
                return r.imported ? `Imported ${r.imported.sessions} session${r.imported.sessions === 1 ? "" : "s"} from ${r.imported.files} file${r.imported.files === 1 ? "" : "s"}.` : "The folder is not connected.";
            })}
            onForget={act("forget", async () => { await saveFolder(null); return "Stopped. The folder's files are still there."; })} />
    );
}
