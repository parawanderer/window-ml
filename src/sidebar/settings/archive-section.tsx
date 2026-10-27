// archive-section.tsx — the Settings "Archive folder" section: picking the folder the session archive copies itself
// into, and everything its permission can do afterwards. The body (`ArchiveFolderBody`) is pure, taking the folder's
// report and the actions as props, so a client drawing a REMOTE runtime can render it from the contract; this
// browser's own wiring is `LocalArchiveFolder` below.
//
// The permission has four states and each one says what to do next, because the one that surprises people is the
// third: a folder picked with "Allow this time" is not writable after a restart. Nothing is lost while it is not
// (months wait, marked pending), and one click with "Allow on every visit" chosen makes it stay connected.
import { useEffect, useState } from "preact/hooks";
import type { FolderReport } from "../../archive/archive-worker";
import { canPickFolder, pickFolder, regrantCount, regrantFolder, saveFolder } from "../../archive/archive-folder";
import type { BackupForm } from "../../backup/backup-file";
import { idbKeyringStore, type KeyringStore } from "../../backup/backup-keyring";
import { KeyringSetup } from "./backup-section";

/** The browser-specific way to turn folder access on, when there is one. */
export const BRAVE_FLAG = "brave://flags/#file-system-access-api";

const ago = (t: number | null): string => {
    if (!t) return "not yet";
    const s = Math.round((Date.now() - t) / 1000);
    return s < 90 ? "just now" : s < 5400 ? `${Math.round(s / 60)} minutes ago` : new Date(t).toLocaleString();
};

// --- the folder's form ---

let formGroups = 0;   // state: plumbing — numbers the radio groups so two on a page keep separate choices

/** What each form is called on the choice, in the order it is offered. */
const FORM_LABELS: [BackupForm, string][] = [
    ["encrypted", "Encrypted (.wmlbak), recommended"],
    ["gzip", "Compressed (.sqlite.gz)"],
    ["plain", "Plain SQLite (.sqlite)"],
];
/** A form in a sentence: "Switch to compressed", "Now written as plain SQLite". */
const formName = (f: BackupForm): string => ({ encrypted: "encrypted", gzip: "compressed", plain: "plain SQLite" })[f];

/**
 * The form the archive folder's month files are written in: a choice of three, one warning line for the two that leave
 * transcripts readable to the folder's sync service, and, before a switch is sent, what the switch does. Choosing
 * Encrypted on an install with no backup key runs the recovery-key set-up first and sends the form only after it
 * completes; cancelling leaves the form as it was. `first` is a folder picked for the first time: Encrypted is
 * preselected and nothing is switched away from, so there is no switch notice, only Continue.
 * @group settings
 * @gallery encrypted {"current": "encrypted", "keyringSet": true, "busy": false}
 * @gallery plain, with the warning {"current": "plain", "keyringSet": true, "busy": false}
 * @gallery compressed, with the warning {"current": "gzip", "keyringSet": false, "busy": false}
 * @gallery a new folder, encrypted preselected {"current": "plain", "keyringSet": false, "busy": false, "first": true}
 */
export function ArchiveFormChoice(p: {
    current: BackupForm;
    /** whether this install has a backup keyring (null while unknown); Encrypted without one starts the set-up */
    keyringSet: boolean | null;
    busy: boolean;
    /** a folder just picked for the first time: Encrypted is preselected and Continue sends the choice */
    first?: boolean;
    /** the keyring set-up writes here; this browser's IndexedDB by default */
    keyringStore?: KeyringStore;
    onApply(form: BackupForm): void;
}) {
    const [pick, setPick] = useState<BackupForm | null>(null);
    const [setting, setSetting] = useState(false);
    const [group] = useState(() => `arch-form-${++formGroups}`);
    const sel = pick ?? (p.first ? "encrypted" : p.current);
    const switching = !p.first && sel !== p.current;
    if (setting) return (
        <KeyringSetup keyring={p.keyringStore ?? idbKeyringStore()}
            onCancel={() => { setSetting(false); setPick(null); }}
            onDone={() => { setSetting(false); setPick(null); p.onApply("encrypted"); }} />
    );
    const go = () => {
        if (sel === "encrypted" && p.keyringSet === false) { setSetting(true); return; }
        setPick(null);
        p.onApply(sel);
    };
    return (
        <div class="arch-form">
            <div class="bk-title">Month files are written as</div>
            <div class="bk-choices" role="radiogroup" aria-label="Archive folder form">
                {FORM_LABELS.map(([f, label]) => (
                    <label class="set-check" key={f}><input type="radio" name={group} checked={sel === f} disabled={p.busy} onChange={() => setPick(f)} /><span>{label}</span></label>
                ))}
            </div>
            {sel !== "encrypted" ? <div class="set-warn">These files hold whole transcripts, and a synced folder's service can read them.</div> : null}
            {sel === "encrypted" && p.keyringSet === false ? <div class="set-hint">Encrypting asks you to choose a passphrase first, and shows a recovery key.</div> : null}
            {switching ? <div class="set-hint">The next sync rewrites every month in the new form and removes the old files. A sync service may keep earlier versions of them in its own history.</div> : null}
            {switching || p.first ? (
                <div class="arch-actions">
                    <button class="test-btn arch-primary" disabled={p.busy} onClick={go}>{p.busy ? "Working…" : p.first ? "Continue" : `Switch to ${formName(sel)}`}</button>
                    {switching ? <button class="test-btn" disabled={p.busy} onClick={() => setPick(null)}>Cancel</button> : null}
                </div>
            ) : null}
        </div>
    );
}

const monthsOf = (n: number): string => `${n} month${n === 1 ? "" : "s"}`;

/**
 * The month files the last sync or import could not take in, by reason: encrypted ones this install has no key for or
 * has the wrong key for are told apart from damaged ones, which keep their month and the error.
 * @group settings
 * @gallery needs a key {"skipped": [{"month": "2026-08", "reason": "needs-key", "error": "x"}, {"month": "2026-09", "reason": "needs-key", "error": "x"}]}
 * @gallery another install's key {"skipped": [{"month": "2026-09", "reason": "other-key", "error": "x"}]}
 * @gallery damaged {"skipped": [{"month": "2026-07", "reason": "unreadable", "error": "not an archive"}]}
 */
export function SkippedMonths(p: { skipped: NonNullable<FolderReport["skipped"]> }) {
    const by = (reason: string) => p.skipped.filter((s) => s.reason === reason);
    const need = by("needs-key"), other = by("other-key"), bad = p.skipped.filter((s) => s.reason !== "needs-key" && s.reason !== "other-key");
    if (!p.skipped.length) return null;
    return (
        <div class="arch-skips">
            {need.length ? <div class="set-warn">{monthsOf(need.length)} {need.length === 1 ? "is" : "are"} encrypted, and this install has no backup key: set one up under Backup and restore. {need.length === 1 ? "It is" : "They are"} left as {need.length === 1 ? "it was" : "they were"}.</div> : null}
            {other.length ? <div class="set-warn">{monthsOf(other.length)} {other.length === 1 ? "is" : "are"} encrypted with another install's key. {other.length === 1 ? "It is" : "They are"} left as {other.length === 1 ? "it was" : "they were"}.</div> : null}
            {bad.length ? <div class="set-warn">{bad.length === 1 ? "A file" : `${bad.length} files`} could not be read and {bad.length === 1 ? "was" : "were"} left as {bad.length === 1 ? "it was" : "they were"}: {bad.map((b) => `${b.month} (${b.error})`).join("; ")}</div> : null}
        </div>
    );
}

/**
 * The section's body. `busy` names the action in flight, so its button says so and none is pressed twice.
 * @group settings
 * @gallery {"report": {"state": "connected", "name": "window.ml archive", "pending": 0, "lastSync": null, "form": "encrypted", "keyring": {"set": true, "keyId": "k1"}}, "archiveOn": true, "isBrave": false, "canAskHere": true, "busy": null, "message": "", "found": {"name": "window.ml archive", "files": 14, "first": "2025-09", "last": "2026-10"}}
 * @gallery plain, with the warning {"report": {"state": "connected", "name": "window.ml archive", "pending": 0, "lastSync": 1790000000000, "form": "plain", "keyring": {"set": false}}, "archiveOn": true, "isBrave": false, "canAskHere": true, "busy": null, "message": ""}
 * @gallery encrypted {"report": {"state": "connected", "name": "window.ml archive", "pending": 0, "lastSync": 1790000000000, "form": "encrypted", "keyring": {"set": true, "keyId": "k1"}}, "archiveOn": true, "isBrave": false, "canAskHere": true, "busy": null, "message": ""}
 * @gallery months that need a key {"report": {"state": "connected", "name": "window.ml archive", "pending": 2, "lastSync": 1790000000000, "form": "encrypted", "keyring": {"set": false}, "skipped": [{"month": "2026-08", "reason": "needs-key", "error": "x"}, {"month": "2026-09", "reason": "needs-key", "error": "x"}]}, "archiveOn": true, "isBrave": false, "canAskHere": true, "busy": null, "message": ""}
 * @gallery a month under another install's key {"report": {"state": "connected", "name": "window.ml archive", "pending": 1, "lastSync": 1790000000000, "form": "encrypted", "keyring": {"set": true, "keyId": "k1"}, "skipped": [{"month": "2026-09", "reason": "other-key", "error": "x"}, {"month": "2026-07", "reason": "unreadable", "error": "not an archive"}]}, "archiveOn": true, "isBrave": false, "canAskHere": true, "busy": null, "message": ""}
 * @gallery a new folder, encrypted preselected {"report": {"state": "connected", "name": "window.ml archive", "pending": 0, "lastSync": null, "form": null, "keyring": {"set": false}}, "archiveOn": true, "isBrave": false, "canAskHere": true, "busy": null, "message": ""}
 */
export function ArchiveFolderBody(p: {
    report: FolderReport | null;
    archiveOn: boolean;
    isBrave: boolean;
    /** false inside a frame of another site (the in-page overlay), where the browser refuses the picker and the prompt */
    canAskHere: boolean;
    busy: string | null;
    message: string;
    /** a folder just picked that already holds month files: asked about before anything is written to it */
    found?: { name: string; files: number; first?: string; last?: string } | null;
    onPick(): void; onRegrant(): void; onSync(): void; onImport(): void; onForget(): void;
    /** what to do with the files a just-picked folder holds: take them in (the default), or move them aside */
    onAdopt?(): void; onFresh?(): void;
    /** send the chosen form (the worker sets it and the next sync rewrites the folder) */
    onForm?(form: BackupForm): void;
    /** where the recovery-key set-up writes the keyring; this browser's by default (tests pass a memory store) */
    keyringStore?: KeyringStore;
}) {
    const r = p.report;
    if (!r) return <div class="set-hint">{p.message || "Reading…"}</div>;
    if (p.found) return (
        <div class="arch">
            <div class="set-warn"><b>{p.found.name}</b> already holds {p.found.files} month file{p.found.files === 1 ? "" : "s"}
                {p.found.first ? <> ({p.found.first === p.found.last ? p.found.first : `${p.found.first} to ${p.found.last}`})</> : null}, probably from an earlier archive.</div>
            <div class="arch-actions">
                <button class="test-btn arch-primary" disabled={!!p.busy} onClick={p.onAdopt}>{p.busy === "adopt" ? "Importing…" : "Import them and use this folder"}</button>
                <button class="test-btn" disabled={!!p.busy} onClick={p.onFresh}>{p.busy === "fresh" ? "Moving…" : "Start fresh"}</button>
            </div>
            <div class="set-hint">Importing adds their sessions to this browser's archive and keeps everything the folder holds, so both machines' history ends up in the same files. Starting fresh moves the old files into a subfolder named <code>earlier-</code> and the date; nothing is deleted.</div>
            {p.message ? <div class="set-hint arch-msg">{p.message}</div> : null}
        </div>
    );
    // A connected folder whose form was never chosen: nothing is written to it until it is, whether it was just picked,
    // the page was reloaded, or the pick was made from elsewhere.
    if (r.state === "connected" && r.form === null) return (
        <div class="arch">
            <div class="set-hint">Using <b>{r.name}</b>. Nothing is written to it until you choose how the archive writes its month files there.</div>
            <ArchiveFormChoice first current="plain" keyringSet={r.keyring ? r.keyring.set : null} busy={!!p.busy} keyringStore={p.keyringStore} onApply={(f) => p.onForm?.(f)} />
            {p.message ? <div class="set-hint arch-msg">{p.message}</div> : null}
        </div>
    );
    const pending = r.pending ? <div class="set-hint">{r.pending} month file{r.pending === 1 ? "" : "s"} wait to be written. Nothing is lost meanwhile.</div> : null;
    const note = p.message ? <div class="set-hint arch-msg">{p.message}</div> : null;
    const off = !p.archiveOn ? <div class="set-warn">Sessions reach the folder only while "Archive sessions instead of deleting them" is on.</div> : null;
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
            <div class="set-hint">Pick a folder and the archive copies itself there as one SQLite file per month (<code>2026-09.sqlite</code>). Any SQLite tool opens them, they survive a wiped browser, and a sync tool (Syncthing, a NAS, git) is safe on them: a file is replaced only once it is completely written. The picker opens in Documents; a new folder there, say <i>window.ml archive</i>, is a good home.</div>
            {asks("Pick a folder…", "Picking…", "pick", p.onPick, true)}
            {off}{note}
        </div>
    );

    // HOW MANY TIMES THIS HAS BEEN DONE ALREADY decides what there is to say. None: the prompt may offer a lasting
    // choice, so name it. Once: it was allowed for this session only, so say what to look for and why it may be
    // missing. Twice or more: the advice has been followed and the grant lapsed anyway, and claiming a third time
    // that the right option exists is the thing that makes this read as a loop with no exit.
    const tried = regrantCount();
    if (r.state === "needs-grant") return (
        <div class="arch">
            <div class="set-warn">The archive folder{r.name ? <> <b>{r.name}</b></> : null} {tried ? "lapsed again" : "needs permission again"}.</div>
            <div class="set-hint">{tried >= 2
                ? <>This browser has asked again after every restart, whichever option was chosen, so there may be no lasting choice to make here. Nothing is lost while it is disconnected: the archive is in the browser and still searchable. Reconnect when you want the copy on disk brought up to date.</>
                : tried === 1
                    ? <>It was allowed only until the browser restarted. Reconnect, and look in the prompt for a lasting choice (<b>Always allow</b>, or <b>Allow on every visit</b> in Chrome). Not every browser offers one.</>
                    : <>The browser asks again after a restart unless it was allowed for good. Reconnect, and if the prompt offers <b>Always allow</b> (<b>Allow on every visit</b> in Chrome), choose it.</>}</div>
            {asks("Reconnect", "Asking…", "regrant", p.onRegrant, true)}
            {/* Said only once the lasting choice has demonstrably not been taken. Chrome STOPS offering "Allow on
                every visit" for an origin after the prompt is dismissed or denied a few times, and reverts to the
                one-time question with no sign that it has done so — which reads as the lasting option never having
                existed. Nothing here can re-enable it; resetting the site's permissions can. */}
            {tried ? (
                <div class="set-hint">Only offered <b>Allow this time</b>? A browser stops offering the lasting choice
                    for a site once the prompt has been dismissed a few times. Reset this page's permissions in the
                    address bar (the icon left of the address → Site settings → Reset permissions), then reconnect.
                    Some builds, Brave among them, do not offer it at all.</div>
            ) : null}
            {pending}{off}{note}
        </div>
    );

    return (
        <div class="arch">
            <div class="set-field"><span>Folder</span><div><b>{r.name}</b>, written {ago(r.lastSync)}</div></div>
            {/* The browser never says whether the grant lasts, and a first pick is only ever granted until a restart:
                the lasting choice is offered on the NEXT ask. Said once, here, so that ask is not a surprise. */}
            {tried ? null : <div class="set-hint">After a browser restart it may ask for this folder again. Choose <b>Always allow</b> then, if it is offered, and it stays connected.</div>}
            {pending}
            <ArchiveFormChoice current={r.form ?? "plain"} keyringSet={r.keyring ? r.keyring.set : null} busy={!!p.busy} keyringStore={p.keyringStore} onApply={(f) => p.onForm?.(f)} />
            {r.skipped?.length ? <SkippedMonths skipped={r.skipped} /> : null}
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
function folderMessage(action: "state" | "picked" | "fresh" | "survey" | "sync" | "import" | "form", form?: BackupForm): Promise<FolderReport> {
    return new Promise((resolve, reject) => chrome.runtime.sendMessage({ type: "ARCHIVE_FOLDER", payload: { action, ...(form ? { form } : {}) } }, (r?: { data?: FolderReport; error?: string }) => {
        if (r?.data) resolve(r.data);
        else reject(new Error(r?.error || "the archive did not answer"));
    }));
}

/** How many month files a sync wrote, in words. */
const written = (r: FolderReport): string =>
    r.form === null ? "Nothing is written until you choose a form." : r.written?.length ? `Wrote ${r.written.length} month file${r.written.length === 1 ? "" : "s"}.` : "Nothing archived yet to write.";

/** What taking a folder into use did: the sessions it brought in, what it wrote, and any file it could not read. */
function adopted(name: string, r: FolderReport): string {
    const got = r.imported?.sessions ? ` Imported ${r.imported.sessions} session${r.imported.sessions === 1 ? "" : "s"} it held.` : "";
    // Encrypted months this install has no key for are told apart, by reason, under the folder; only damaged ones here.
    const dead = r.skipped?.filter((x) => x.reason === "unreadable") ?? [];
    const bad = dead.length ? ` Left ${dead.length} file${dead.length === 1 ? "" : "s"} it could not read as they were (${dead.map((x) => x.month).join(", ")}).` : "";
    return `Using ${name}.${got} ${written(r)}${bad}`;
}

/**
 * This browser's archive folder: the body, wired to the picker (here, in the page, inside the click) and the worker.
 * @gallery none it asks the service worker for the folder's state; `ArchiveFolderBody` is the same view with props
 */
export function LocalArchiveFolder({ archiveOn }: { archiveOn: boolean }) {
    const [report, setReport] = useState<FolderReport | null>(null);
    const [busy, setBusy] = useState<string | null>(null);
    const [message, setMessage] = useState("");
    const [isBrave, setIsBrave] = useState(false);
    const [found, setFound] = useState<{ name: string; files: number; first?: string; last?: string } | null>(null);
    // The months the last sync or import skipped: a plain state read does not carry them, so they are kept here.
    const [skipped, setSkipped] = useState<NonNullable<FolderReport["skipped"]>>([]);
    const call = async (action: Parameters<typeof folderMessage>[0], form?: BackupForm) => {
        const r = await folderMessage(action, form);
        if (r.written || r.imported || r.skipped) setSkipped(r.skipped ?? []);
        return r;
    };
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
    const shown = report && skipped.length ? { ...report, skipped } : report;
    return (
        <ArchiveFolderBody report={shown} archiveOn={archiveOn} isBrave={isBrave} busy={busy} message={message}
            canAskHere={isTopLevel()}
            found={found}
            onForm={(form) => void act("form", async () => {
                const r = await call("form", form);
                return `Now written as ${formName(r.form!)}. Wrote ${r.written?.length ?? 0}, removed ${r.removed?.length ?? 0}.`;
            })()}
            onPick={act("pick", async () => {
                const name = await pickFolder();
                if (!name) return;
                // Asked before anything is written: a folder with an earlier archive's files is a choice to make.
                const survey = await folderMessage("survey");
                if (survey.found?.files) { setFound({ name, ...survey.found }); return; }
                // A new folder (form unchosen) is not synced until chosen: `picked` imports and writes nothing, and the
                // section then asks for the form.
                return adopted(name, await call("picked"));
            })}
            onAdopt={act("adopt", async () => {
                const name = found?.name ?? "the folder";
                const r = await call("picked");
                setFound(null);
                return adopted(name, r);
            })}
            onFresh={act("fresh", async () => {
                const name = found?.name ?? "the folder";
                const r = await call("fresh");
                setFound(null);
                const moved = r.movedAside ? ` Moved ${r.movedAside.files} earlier file${r.movedAside.files === 1 ? "" : "s"} into ${r.movedAside.folder}.` : "";
                return `Using ${name}.${moved} ${written(r)}`;
            })}
            onRegrant={act("regrant", async () => {
                if (!(await regrantFolder())) return "Not allowed, so the folder stays paused.";
                const r = await call("sync");
                return `Connected. ${r.written?.length ? `Wrote ${r.written.length} waiting month file${r.written.length === 1 ? "" : "s"}.` : ""}`;
            })}
            onSync={act("sync", async () => {
                const r = await call("sync");
                return r.written?.length || r.removed?.length ? `Wrote ${r.written?.length ?? 0}, removed ${r.removed?.length ?? 0}.` : "Already up to date.";
            })}
            onImport={act("import", async () => {
                const r = await call("import");
                return r.imported ? `Imported ${r.imported.sessions} session${r.imported.sessions === 1 ? "" : "s"} from ${r.imported.files} file${r.imported.files === 1 ? "" : "s"}.` : "The folder is not connected.";
            })}
            onForget={act("forget", async () => { await saveFolder(null); return "Stopped. The folder's files are still there."; })} />
    );
}
