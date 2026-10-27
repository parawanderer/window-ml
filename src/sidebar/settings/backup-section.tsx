// backup-section.tsx — the Settings "Backup and restore" section: making a backup (encrypted by default), the recovery key shown once, restoring one with a preview of what it would change, opening a backup as plain SQLite, and changing the passphrase. Each screen's body is pure, taking its state and callbacks as props; `LocalBackup` wires them to the service worker (the `BACKUP` message), the keyring in IndexedDB and the origin-private file slots.
//
// What the screens must never do: write the recovery key anywhere. It exists in a component's state from the moment it
// is made until the person has typed one group of it back, and the keyring itself is only stored AFTER that, so leaving
// the screen half way leaves no passphrase that nobody holds a recovery key for.
import { useEffect, useState } from "preact/hooks";
import type { RestoreOffer, BackupResult } from "../../backup/backup-run";
import { BACKUP_EXTENSION, openBackupBytes, type BackupForm } from "../../backup/backup-file";
import { BackupError, keyFor, readHeadAndFirstChunk, readHeader, sniff, type Keyring, type Secret } from "../../backup/backup-format";
import { adoptKeyring, changePassphrase, idbKeyringStore, keyringState, loadKeyring, setupKeyring, type KeyringStore } from "../../backup/backup-keyring";
import { backupSlotFile, copyIntoBackupSlot, removeBackupSlot } from "../../backup/backup-opfs";
import type { Change, PolicyChange, SiteChange } from "../../backup/backup-settings";
import { formatBytes } from "../../resource/resource-model";
import { downloadBlob } from "../export/download";
import { useCopy } from "../copy-hash";

// --- pure helpers ---

/** The fewest characters a backup passphrase may have: it is the only thing between a stolen file and every transcript in it. */
export const MIN_PASSPHRASE = 12;

/** Where the decryptor script and the format spec live, for the text that says how to get plain SQLite out without this extension. */
export const DECRYPTOR_PATH = "tools/wmlbak-decrypt.mjs";
/** The spec of the backup file's byte layout, named in the text that says how to read a backup without this extension. */
export const FORMAT_SPEC_PATH = "docs/spec/BACKUP_FORMAT.md";

/** What is wrong with a chosen passphrase and its repeat, or null when it is fine. */
export function passphraseProblem(first: string, again: string): string | null {
    if (first.length < MIN_PASSPHRASE) return `Use at least ${MIN_PASSPHRASE} characters (${first.length} so far).`;
    if (first !== again) return "The two passphrases differ.";
    return null;
}

/** Which group of the recovery key to ask for: a random one, `rand` injectable for tests. */
export const pickGroupIndex = (count: number, rand: () => number = Math.random): number => Math.min(count - 1, Math.floor(rand() * count));

/** Whether what was typed is the recovery key's group `index`; case, spaces and the look-alikes I/L/O the key never uses are forgiven, as when the whole key is typed. */
export function groupMatches(groups: readonly string[], index: number, typed: string): boolean {
    const norm = (s: string) => s.toUpperCase().replace(/[\s-]/g, "").replace(/[IL]/g, "1").replace(/O/g, "0");
    return groups[index] !== undefined && norm(typed) === norm(groups[index]);
}

/** One field takes a passphrase or a recovery key: a key is seven dash- or space-separated groups of four, nothing else looks like that. */
export function secretFromText(text: string): Secret {
    const t = text.trim();
    return /^[A-Za-z0-9]{4}([\s-][A-Za-z0-9]{4}){6}$/.test(t) ? { recoveryKey: t } : { passphrase: text };
}

/**
 * What a person is told ONCE before this install takes another install's data key (from a folder's month files or from a
 * restored backup). With a key of its own the cost is the second sentence; with none there is nothing to lose.
 * @param source what the key comes from: `folder` or `backup`
 * @param hasOwnKey whether this install already has a backup key
 */
export function adoptNotice(source: "folder" | "backup", hasOwnKey: boolean): string {
    const first = `This install will encrypt with ${source === "folder" ? "the folder's" : "this backup's"} key from now on.`;
    return hasOwnKey ? `${first} Its own earlier backups and archive months still open here, but on another install they need this install's old passphrase or recovery key.` : first;
}

/**
 * Whether a restore that has just finished should offer "Use this backup's key on this install": it needed a typed secret
 * (`secret`) and the file's key is neither this install's current key nor a retired one. A plain file, a file this
 * install sealed, and a restore that asked for no secret never offer it.
 * @param head the first bytes of the restored file (at least its header)
 * @param secret what was typed to open it, or null
 * @param ring this install's keyring, or null before set-up
 */
export function offersBackupKey(head: Uint8Array, secret: Secret | null, ring: Keyring | null): boolean {
    if (!secret || sniff(head) !== "wmlbak") return false;
    try { return !ring || !keyFor(ring, readHeader(head).keyId); } catch { return false; }
}

/** The name a backup is saved under: `window-ml-backup-2026-10-23.wmlbak`. */
export const backupFileName = (form: BackupForm, now: Date = new Date()): string => `window-ml-backup-${now.toISOString().slice(0, 10)}.${BACKUP_EXTENSION[form]}`;

/** The recovery key as a text file: the key and what it is for, nothing else. */
export const recoveryKeyText = (key: string): string =>
    `window.ml backup recovery key\n\n${key}\n\nThis key opens every window.ml backup made on this install, if the passphrase is lost. Keep it somewhere safe and apart from the backups.\n`;

// --- the field that takes a secret ---

/**
 * The one field that takes a passphrase OR a recovery key (`secretFromText` tells which by shape): the restore screen's,
 * the decrypt screen's, and the archive folder's "Use this folder's key".
 * @group settings
 * @gallery {"value": "", "disabled": false}
 * @gallery wrong, kept for another try {"value": "not it", "disabled": false, "wrong": true}
 */
export function SecretField(p: { value: string; disabled: boolean; wrong?: boolean; label?: string; onInput(v: string): void; onEnter?(): void }) {
    return (
        <label class="set-field"><span>{p.label ?? "Passphrase or recovery key"}</span>
            <input type="password" autocomplete="off" value={p.value} disabled={p.disabled} class={p.wrong ? "err" : ""}
                onInput={(e: any) => p.onInput(e.target.value)} onKeyDown={(e: any) => { if (e.key === "Enter" && p.value && !p.disabled) p.onEnter?.(); }} /></label>
    );
}

// --- the recovery screen ---

/** The three steps of encryption set-up: choose a passphrase, see the recovery key once, type one group back. */
export type RecoveryStage = "choose" | "show" | "verify";

/**
 * Encryption set-up: choose a passphrase, see the recovery key once (copy, download, print), type one group of it back.
 * `stage` is the caller's; the typed text is this component's. Only a matching group calls `onVerified`.
 * @group settings
 * @gallery choose a passphrase {"stage": "choose", "groups": [], "askIndex": 0, "busy": false, "message": ""}
 * @gallery the key once {"stage": "show", "groups": ["K7QF", "2MXR", "9TWD", "H4BN", "6CJV", "PZ3E", "8GYA"], "askIndex": 3, "busy": false, "message": ""}
 * @gallery type one group back {"stage": "verify", "groups": ["K7QF", "2MXR", "9TWD", "H4BN", "6CJV", "PZ3E", "8GYA"], "askIndex": 3, "busy": false, "message": ""}
 */
export function RecoveryKeyBody(p: {
    stage: RecoveryStage;
    /** the recovery key's groups, as `setupKeyring` returned them (empty until it has run) */
    groups: string[];
    /** which group (0-based) the verify step asks for */
    askIndex: number;
    busy: boolean;
    message: string;
    onChoose(passphrase: string): void;
    onSaved(): void;
    onBack(): void;
    onVerified(): void;
    onCancel(): void;
}) {
    const [first, setFirst] = useState("");
    const [again, setAgain] = useState("");
    const [typed, setTyped] = useState("");
    const [wrong, setWrong] = useState(false);
    const { copied, copy } = useCopy();
    const key = p.groups.join("-");

    if (p.stage === "choose") {
        const problem = first || again ? passphraseProblem(first, again) : null;
        return (
            <div class="bk">
                <div class="bk-title">Set up backup encryption</div>
                <div class="set-hint">Choose a passphrase. It protects every encrypted backup and archive file: anyone who gets a file can read every transcript in it unless they also know the passphrase, and guessing a short one is cheap. Use a sentence you will remember, at least {MIN_PASSPHRASE} characters. It is turned into a key with a deliberately slow function (Argon2id), so setting up and unlocking take about a second.</div>
                <label class="set-field"><span>Passphrase</span><input type="password" autocomplete="new-password" value={first} disabled={p.busy} onInput={(e: any) => setFirst(e.target.value)} /></label>
                <label class="set-field"><span>Again</span><input type="password" autocomplete="new-password" value={again} disabled={p.busy} class={problem && again ? "err" : ""} onInput={(e: any) => setAgain(e.target.value)} /></label>
                {problem ? <div class="set-err">{problem}</div> : null}
                {p.message ? <div class="set-err">{p.message}</div> : null}
                {p.busy ? <div class="bk-progress" role="status"><div class="pbar"><span /></div><span>Setting up…</span></div> : null}
                <div class="bk-actions">
                    <button class="test-btn arch-primary" disabled={p.busy || !first || !!passphraseProblem(first, again)} onClick={() => p.onChoose(first)}>Continue</button>
                    <button class="test-btn" disabled={p.busy} onClick={p.onCancel}>Cancel</button>
                </div>
            </div>
        );
    }

    if (p.stage === "show") return (
        <div class="bk">
            <div class="bk-title">Your recovery key</div>
            <div class="set-warn">This is the only time it is shown. If you lose both the passphrase and this key, nobody can open these files.</div>
            {/* The print stylesheet shows this block and nothing else of the page: the key and one line saying what it is. */}
            <div class="bk-print">
                <div class="bk-print-line">window.ml backup recovery key. Keep it apart from the backups.</div>
                <div class="bk-groups" aria-label="Recovery key">{p.groups.map((g, i) => <span class="bk-group" key={i}>{g}</span>)}</div>
            </div>
            <div class="bk-actions">
                <button class="test-btn" onClick={() => copy(key)}>{copied ? "Copied" : "Copy"}</button>
                <button class="test-btn" onClick={() => downloadBlob("window-ml-recovery-key.txt", new Blob([recoveryKeyText(key)], { type: "text/plain" }))}>Download as .txt</button>
                <button class="test-btn" onClick={() => window.print()}>Print</button>
            </div>
            <div class="set-hint">Store it in a password manager or print it and keep the paper somewhere safe. Nothing here saves it for you, and this install does not keep it.</div>
            <div class="bk-actions">
                <button class="test-btn arch-primary" onClick={p.onSaved}>I have saved it</button>
                <button class="test-btn" onClick={p.onCancel}>Cancel</button>
            </div>
        </div>
    );

    const ok = groupMatches(p.groups, p.askIndex, typed);
    return (
        <div class="bk">
            <div class="bk-title">Check that you saved it</div>
            <div class="set-hint">Type group {p.askIndex + 1} of the recovery key (the {p.askIndex + 1}{["st", "nd", "rd"][p.askIndex] ?? "th"} block of four characters, counting from the left).</div>
            <label class="set-field"><span>Group {p.askIndex + 1}</span>
                <input type="text" class={`bk-mono${wrong ? " err" : ""}`} autocomplete="off" spellcheck={false} maxLength={8} value={typed} disabled={p.busy}
                    onInput={(e: any) => { setTyped(e.target.value); setWrong(false); }} /></label>
            {wrong ? <div class="set-err">That is not group {p.askIndex + 1}. Look at the key you saved and try again, or go back to see it once more.</div> : null}
            {p.message ? <div class="set-err">{p.message}</div> : null}
            <div class="bk-actions">
                <button class="test-btn arch-primary" disabled={p.busy || !typed} onClick={() => { if (ok) p.onVerified(); else setWrong(true); }}>{p.busy ? "Saving…" : "Finish set-up"}</button>
                <button class="test-btn" disabled={p.busy} onClick={p.onBack}>Show the key again</button>
                <button class="test-btn" disabled={p.busy} onClick={p.onCancel}>Cancel</button>
            </div>
        </div>
    );
}

// --- making a backup ---

let radioGroups = 0;   // state: plumbing — numbers the radio groups so two forms on a page keep separate choices

/** What a finished backup shows: the result of `BACKUP create` and the name the file was saved under. */
export type BackupDone = BackupResult & { savedAs: string };

/**
 * The backup form: encrypted (default), compressed or plain SQLite, why encrypted, and what the last backup was.
 * @group settings
 * @gallery encrypted {"keyringSet": true, "busy": false, "message": "", "result": null}
 * @gallery plain with the API key box {"initialForm": "plain", "keyringSet": true, "busy": false, "message": "", "result": null}
 * @gallery done {"initialForm": "plain", "keyringSet": true, "busy": false, "message": "", "result": {"size": 18874368, "sessions": 214, "form": "plain", "apiKeyOmitted": true, "unclassified": [{"area": "local", "key": "ml_new_pref"}], "savedAs": "window-ml-backup-2026-10-23.sqlite"}}
 */
export function BackupBody(p: {
    initialForm?: BackupForm;
    /** whether this install has a backup passphrase (null while unknown); an encrypted backup without one starts the set-up first */
    keyringSet: boolean | null;
    busy: boolean;
    message: string;
    result: BackupDone | null;
    onMake(form: BackupForm, includeApiKey: boolean): void;
}) {
    const [form, setForm] = useState<BackupForm>(p.initialForm ?? "encrypted");
    const [group] = useState(() => `bk-form-${++radioGroups}`);   // one radio group per instance: two on a page must not share a choice
    const [withKey, setWithKey] = useState(false);
    const choice = (f: BackupForm, label: string) => (
        <label class="set-check"><input type="radio" name={group} checked={form === f} disabled={p.busy} onChange={() => setForm(f)} /><span>{label}</span></label>
    );
    const r = p.result;
    return (
        <div class="bk">
            <div class="bk-title">Backup</div>
            <div class="bk-choices" role="radiogroup" aria-label="Backup form">
                {choice("encrypted", "Encrypted (.wmlbak), recommended")}
                {choice("gzip", "Compressed SQLite (.sqlite.gz)")}
                {choice("plain", "Plain SQLite (.sqlite)")}
            </div>
            {form !== "encrypted" ? (
                <label class="set-check"><input type="checkbox" checked={withKey} disabled={p.busy} onChange={(e: any) => setWithKey(e.target.checked)} /><span>Include the API key</span></label>
            ) : null}
            <div class="set-hint">
                Why encrypted: a backup holds every session, with the page text, screenshots and tool results in it, and the file lands wherever you save it, often a folder a cloud service syncs. Encrypted, it also carries the API key. Compressed and plain files leave the key out unless you tick the box.
                {" "}To get plain SQLite out of an encrypted backup, choose Plain here, use "Decrypt a file…" below, or run the standalone decryptor <code>{DECRYPTOR_PATH}</code> (format: <code>{FORMAT_SPEC_PATH}</code>).
            </div>
            {form === "encrypted" && p.keyringSet === false ? <div class="set-hint">The first encrypted backup asks you to choose a passphrase and shows a recovery key.</div> : null}
            {p.busy ? <div class="bk-progress" role="status"><div class="pbar"><span /></div><span>Making the backup…</span></div> : null}
            <div class="bk-actions">
                <button class="test-btn arch-primary" disabled={p.busy} onClick={() => p.onMake(form, form !== "encrypted" && withKey)}>{p.busy ? "Working…" : form === "encrypted" && p.keyringSet === false ? "Set up encryption and back up…" : "Make a backup"}</button>
            </div>
            {p.message ? <div class="set-hint arch-msg">{p.message}</div> : null}
            {r ? (
                <div class="bk-result">
                    <div>Saved <code>{r.savedAs}</code>: {formatBytes(r.size)}, {r.sessions} session{r.sessions === 1 ? "" : "s"}.</div>
                    {r.apiKeyOmitted ? <div class="set-hint">The API key was left out.</div> : null}
                    {r.unclassified.length ? (
                        <div class="set-warn">Developer warning: {r.unclassified.length} storage key{r.unclassified.length === 1 ? " has" : "s have"} no backup classification and {r.unclassified.length === 1 ? "was" : "were"} left out: {r.unclassified.map((u) => `${u.area}.${u.key}`).join(", ")}. Add {r.unclassified.length === 1 ? "it" : "them"} to INVENTORY (backup-inventory.ts).</div>
                    ) : null}
                </div>
            ) : null}
        </div>
    );
}

// --- restoring ---

/** Where a restore stands. `needs-key` keeps the secret field; `wrong` says the last try did not open the file. */
export type RestoreState =
    | { kind: "idle" }
    | { kind: "needs-key"; wrong?: boolean }
    | { kind: "reading" }
    | { kind: "unlocking" }
    | { kind: "preview"; offer: RestoreOffer }
    | { kind: "restoring"; offer: RestoreOffer }
    | { kind: "done"; sessionsAdded: number; written: { sync: string[]; local: string[] } }
    | { kind: "changed" };

const fmtDate = (t: number): string => (Number.isFinite(t) ? new Date(t).toLocaleDateString() : "");
const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/** One site the restore changes: its origin, and what changes about it. */
function SiteRow({ s }: { s: SiteChange }) {
    const bits: string[] = [];
    if (s.use[0] !== s.use[1]) bits.push(`use: ${s.use[0]} to ${s.use[1]}`);
    if (s.agents[0] !== s.agents[1]) bits.push(`agents: ${s.agents[0]} to ${s.agents[1]}`);
    if (s.selfApprove[0] !== s.selfApprove[1]) bits.push(s.selfApprove[1] ? "may answer its own approval prompts" : "no longer answers its own approval prompts");
    return <li><code>{s.origin}</code> <span class="bk-dim">{bits.join("; ")}</span></li>;
}

/** One policy the restore adds, changes or removes, with its predicate: a label can misdescribe a rule, the predicate cannot. */
function PolicyRow({ p }: { p: PolicyChange }) {
    return (
        <li>
            <div><b>{p.label}</b> <span class="bk-dim">{p.kind}, {p.effect}, for {p.consumer}</span></div>
            <pre class="bk-src" tabIndex={0}>{p.source}</pre>
        </li>
    );
}

/** One setting the restore writes, before and after; a cut value says so and can be opened whole. */
function ChangeRow({ c }: { c: Change }) {
    const [whole, setWhole] = useState(false);
    const cut = c.shown.truncated && c.key !== "apiKey";
    return (
        <li>
            <div><code>{c.key}</code> <span class="bk-dim">{c.kind}</span></div>
            {c.why ? <div class="set-warn">{c.why}</div> : null}
            <div class="bk-diff">
                {c.shown.before !== undefined ? <><span class="bk-dim">now</span> <code>{c.shown.before}</code> </> : null}
                <span class="bk-dim">after</span> <code>{c.shown.after}</code>
            </div>
            {cut ? (
                <div class="set-hint">
                    First 160 of {c.shown.length?.after ?? "?"} characters.{" "}
                    <button class="bk-link" onClick={() => setWhole(!whole)}>{whole ? "Hide the whole value" : "Show the whole value"}</button>
                    {whole ? <pre class="bk-src" tabIndex={0}>{typeof c.after === "string" ? c.after : JSON.stringify(c.after, null, 2)}</pre> : null}
                </div>
            ) : null}
        </li>
    );
}

/** The settings half of a preview, in the plan's order: sites, policies, the risky settings, the rest collapsed. */
function SettingsPreview({ offer }: { offer: RestoreOffer }) {
    const plan = offer.plan;
    if (!plan) return <div class="set-hint">{offer.settingsError ? `The settings in this file could not be read: ${offer.settingsError}` : "This file carries no settings."}</div>;
    const gaining = plan.sites.filter((s) => s.becomesApproved);
    const other = plan.sites.filter((s) => !s.becomesApproved);
    const risky = plan.changes.filter((c) => c.group === "risky");
    const rest = plan.changes.filter((c) => c.group === "settings");
    if (!plan.changes.length && !plan.sites.length && !plan.policies.length) return <div class="set-hint">The settings in this file are the ones already here.</div>;
    return (
        <div class="bk-preview">
            {gaining.length ? <div class="bk-group-block"><div class="bk-h">These sites will be able to use window.ml</div><ul>{gaining.map((s) => <SiteRow key={s.origin} s={s} />)}</ul></div> : null}
            {other.length ? <div class="bk-group-block"><div class="bk-h">Other site changes</div><ul>{other.map((s) => <SiteRow key={s.origin} s={s} />)}</ul></div> : null}
            {plan.policies.length ? <div class="bk-group-block"><div class="bk-h">Policies</div><ul>{plan.policies.map((x) => <PolicyRow key={x.id} p={x} />)}</ul></div> : null}
            {risky.length ? <div class="bk-group-block"><div class="bk-h">Settings that send traffic or widen what runs</div><ul>{risky.map((c) => <ChangeRow key={`${c.area}.${c.key}`} c={c} />)}</ul></div> : null}
            {rest.length ? (
                <details class="bk-group-block"><summary class="bk-h">{plural(rest.length, "other setting")}</summary><ul>{rest.map((c) => <ChangeRow key={`${c.area}.${c.key}`} c={c} />)}</ul></details>
            ) : null}
            {plan.unchanged ? <div class="set-hint">{plural(plan.unchanged, "setting")} in the file already match this browser.</div> : null}
            {plan.dropped.length ? <div class="set-hint">{plural(plan.dropped.length, "entry", "entries")} in the file {plan.dropped.length === 1 ? "is" : "are"} not restored (unknown to this version or not valid).</div> : null}
        </div>
    );
}

/** The preview of an opened file, and the two choices. */
function RestorePreview(p: { offer: RestoreOffer; busy: boolean; onRestore(o: { sessions: boolean; settings: boolean }): void; onCancel(): void }) {
    const c = p.offer.contents;
    const [sessions, setSessions] = useState(c.newSessions > 0);
    const [settings, setSettings] = useState(!!p.offer.plan);
    return (
        <div class="bk-preview-root">
            <SettingsPreview offer={p.offer} />
            <div class="bk-group-block">
                <div class="bk-h">Sessions</div>
                {c.newSessions ? (
                    <>
                        <div class="set-hint">{plural(c.newSessions, "new session")} of {c.sessions} in the file. They are added to the archive; the ones you already have are left alone.</div>
                        <ul class="bk-sessions">
                            {c.adding.map((s) => <li key={s.hash}><span class="bk-title-cell">{s.title || "(untitled)"}</span> <span class="bk-dim">{fmtDate(s.createdTs)}, {formatBytes(s.bytes)}</span></li>)}
                        </ul>
                        {c.more ? <div class="set-hint">and {c.more} more</div> : null}
                    </>
                ) : <div class="set-hint">The file holds {plural(c.sessions, "session")}, and this browser has all of them.</div>}
            </div>
            <label class="set-check"><input type="checkbox" checked={sessions} disabled={p.busy || !c.newSessions} onChange={(e: any) => setSessions(e.target.checked)} /><span>Restore sessions ({c.newSessions} new)</span></label>
            <label class="set-check"><input type="checkbox" checked={settings} disabled={p.busy || !p.offer.plan} onChange={(e: any) => setSettings(e.target.checked)} /><span>Restore settings</span></label>
            <div class="bk-actions">
                <button class="test-btn arch-primary" disabled={p.busy || (!sessions && !settings)} onClick={() => p.onRestore({ sessions, settings })}>{p.busy ? "Restoring…" : "Restore"}</button>
                <button class="test-btn" disabled={p.busy} onClick={p.onCancel}>Cancel</button>
            </div>
        </div>
    );
}

/**
 * Restore: pick a file, unlock it when it needs a passphrase or a recovery key, read the preview, choose, restore.
 * @group settings
 * @gallery start {"state": {"kind": "idle"}, "message": ""}
 * @gallery needs a passphrase {"state": {"kind": "needs-key"}, "message": ""}
 * @gallery wrong passphrase {"state": {"kind": "needs-key", "wrong": true}, "message": ""}
 * @gallery reading {"state": {"kind": "reading"}, "message": ""}
 * @gallery unlocking {"state": {"kind": "unlocking"}, "message": ""}
 * @gallery changed since the preview {"state": {"kind": "changed"}, "message": ""}
 * @gallery done {"state": {"kind": "done", "sessionsAdded": 12, "written": {"sync": ["model", "chatUrl"], "local": ["ml_site_always"]}}, "message": ""}
 * @gallery done, offering the backup's key {"state": {"kind": "done", "sessionsAdded": 12, "written": {"sync": ["model"], "local": []}}, "message": "", "adopt": {"hasOwnKey": true, "busy": false, "error": ""}}
 * @gallery preview {"state": {"kind": "preview", "offer": {
 *   "contents": {"sessions": 214, "newSessions": 3, "digest": "ab12", "hashes": ["a", "b", "c"], "settings": null, "created": "2026-10-23T09:00:00Z", "more": 1,
 *     "adding": [{"hash": "a", "title": "Fix the checkout form", "createdTs": 1792000000000, "bytes": 482113}, {"hash": "b", "title": "Compare two price tables", "createdTs": 1791900000000, "bytes": 90211}]},
 *   "plan": {"unchanged": 41, "dropped": [], "notes": [], "apiKeyIncluded": false,
 *     "sites": [{"origin": "https://shop.example", "use": ["unset", "always"], "agents": ["unset", "unset"], "selfApprove": [false, false], "becomesApproved": true, "gainsSelfApprove": false}],
 *     "policies": [{"id": "p1", "label": "Allow reading the docs", "effect": "allow", "consumer": "exec", "kind": "added", "source": "fetch.url.startsWith('https://docs.example/') && method === 'GET'"}],
 *     "changes": [
 *       {"area": "sync", "key": "chatUrl", "kind": "changed", "group": "risky", "before": "http://localhost:3000/api", "after": "http://other.example/api", "shown": {"before": "\"http://localhost:3000/api\"", "after": "\"http://other.example/api\""}, "why": "this backup carries no API key, so THIS browser's saved API key would be sent to this address"},
 *       {"area": "sync", "key": "modelFilter", "kind": "changed", "group": "risky", "before": "", "after": "qwen.*|llama.*|mistral.*|gemma.*|phi.*|deepseek.*|command.*|granite.*|yi.*|olmo.*|smol.*|starcoder.*|codestral.*|nemotron.*|hermes.*", "shown": {"before": "\"\"", "after": "\"qwen.*|llama.*|mistral.*|gemma.*|phi.*|deepseek.*|command.*|granite.*|yi.*|olmo.*|smol.*|starcoder.*|codestral.*|nemotron.*|hermes.*|ol...", "truncated": true, "length": {"before": 2, "after": 190}}, "why": "the whitelist of models a page or run may use; clearing it allows every model the server offers"},
 *       {"area": "sync", "key": "theme", "kind": "changed", "group": "settings", "before": "light", "after": "dark", "shown": {"before": "\"light\"", "after": "\"dark\""}}]}}}, "message": ""}
 */
export function RestoreBody(p: {
    state: RestoreState;
    message: string;
    onPick(): void;
    /** the text of the passphrase / recovery key field */
    onUnlock(text: string): void;
    onRestore(o: { sessions: boolean; settings: boolean }): void;
    /** read the file in the slot again, after it changed */
    onReread(): void;
    /** remove the file from the slot and start over */
    onCancel(): void;
    /** after a restore that needed a typed secret for a key this install does not have: offer to use that key from now on */
    adopt?: { hasOwnKey: boolean; busy: boolean; error: string; onAdopt(): void; onDecline(): void };
}) {
    const [text, setText] = useState("");
    const s = p.state;
    const busy = s.kind === "unlocking" || s.kind === "restoring";
    return (
        <div class="bk">
            <div class="bk-title">Restore</div>
            {s.kind === "idle" || s.kind === "done" ? (
                <>
                    <div class="set-hint">Pick a backup file (.wmlbak, .sqlite or .sqlite.gz). Nothing changes until you have seen what it would change and pressed Restore.</div>
                    <div class="bk-actions"><button class="test-btn arch-primary" onClick={p.onPick}>Restore from a file…</button></div>
                </>
            ) : null}
            {s.kind === "reading" ? <div class="bk-progress" role="status"><div class="pbar"><span /></div><span>Reading the file…</span></div> : null}
            {s.kind === "needs-key" || s.kind === "unlocking" ? (
                <>
                    <div class="set-hint">{s.kind === "needs-key" && s.wrong ? "" : "This backup was made by another install, or its passphrase is not set up here. "}Enter the passphrase it was made with, or its recovery key.</div>
                    {s.kind === "needs-key" && s.wrong ? <div class="set-err">That passphrase or recovery key does not open this file. Check it and try again.</div> : null}
                    <SecretField value={text} disabled={busy} wrong={s.kind === "needs-key" && s.wrong} onInput={setText} onEnter={() => p.onUnlock(text)} />
                    {s.kind === "unlocking" ? <div class="bk-progress" role="status"><div class="pbar"><span /></div><span>Unlocking…</span></div> : null}
                    <div class="bk-actions">
                        <button class="test-btn arch-primary" disabled={busy || !text} onClick={() => p.onUnlock(text)}>{s.kind === "unlocking" ? "Unlocking…" : "Unlock"}</button>
                        <button class="test-btn" disabled={busy} onClick={p.onCancel}>Cancel</button>
                    </div>
                </>
            ) : null}
            {s.kind === "preview" || s.kind === "restoring" ? (
                <RestorePreview offer={s.offer} busy={s.kind === "restoring"} onRestore={p.onRestore} onCancel={p.onCancel} />
            ) : null}
            {s.kind === "changed" ? (
                <>
                    <div class="set-warn">The file changed after it was previewed, so nothing was restored. What you saw may not be what it holds now.</div>
                    <div class="bk-actions">
                        <button class="test-btn arch-primary" onClick={p.onReread}>Read it again</button>
                        <button class="test-btn" onClick={p.onCancel}>Cancel</button>
                    </div>
                </>
            ) : null}
            {s.kind === "done" ? (
                <div class="bk-result">Restored {plural(s.sessionsAdded, "session")}; wrote {plural(s.written.sync.length + s.written.local.length, "setting")}.</div>
            ) : null}
            {s.kind === "done" && p.adopt ? <AdoptBackupKey {...p.adopt} /> : null}
            {p.message ? <div class="set-hint arch-msg">{p.message}</div> : null}
        </div>
    );
}

/**
 * After a restore that was opened with a typed passphrase or recovery key for a key this install does not have: the offer
 * to use that key from now on, with what it costs said before it is taken. Asked once; the secret is dropped either way.
 * @group settings
 * @gallery {"hasOwnKey": true, "busy": false, "error": ""}
 * @gallery no key of its own yet {"hasOwnKey": false, "busy": false, "error": ""}
 */
export function AdoptBackupKey(p: { hasOwnKey: boolean; busy: boolean; error: string; onAdopt?(): void; onDecline?(): void }) {
    return (
        <div class="bk-adopt">
            <div class="bk-h">Use this backup's key on this install?</div>
            <div class="set-hint">{adoptNotice("backup", p.hasOwnKey)}</div>
            {p.error ? <div class="set-err">{p.error}</div> : null}
            <div class="bk-actions">
                <button class="test-btn arch-primary" disabled={p.busy} onClick={p.onAdopt}>{p.busy ? "Switching…" : "Use this backup's key on this install"}</button>
                <button class="test-btn" disabled={p.busy} onClick={p.onDecline}>No, keep this install's key</button>
            </div>
        </div>
    );
}

// --- opening a backup as plain SQLite ---

/**
 * "Decrypt a file…": a backup in, plain SQLite out. The whole file is held in memory while it is opened.
 * @group settings
 * @gallery start {"fileName": "", "needsKey": null, "busy": false, "message": ""}
 * @gallery needs a secret {"fileName": "laptop.wmlbak", "needsKey": "needed", "busy": false, "message": ""}
 * @gallery working {"fileName": "laptop.wmlbak", "needsKey": "needed", "busy": true, "message": ""}
 */
export function DecryptBody(p: {
    fileName: string;
    needsKey: null | "needed" | "wrong";
    busy: boolean;
    message: string;
    onPick(): void;
    onSecret(text: string): void;
    onCancel(): void;
}) {
    const [text, setText] = useState("");
    return (
        <div class="bk">
            <div class="bk-title">Decrypt a file</div>
            <div class="set-hint">Opens a backup and saves it as a plain SQLite file any SQLite tool reads. A file made on this install opens without a passphrase; another install's asks for its passphrase or recovery key. The file is read into memory whole, so a very large one may fail: the decryptor script (<code>{DECRYPTOR_PATH}</code>) handles those.</div>
            {!p.needsKey ? <div class="bk-actions"><button class="test-btn" disabled={p.busy} onClick={p.onPick}>{p.busy ? "Opening…" : "Decrypt a file…"}</button></div> : (
                <>
                    <div class="set-hint">{p.fileName ? <><code>{p.fileName}</code> needs</> : "This file needs"} a passphrase or a recovery key.</div>
                    {p.needsKey === "wrong" ? <div class="set-err">That does not open this file.</div> : null}
                    <SecretField value={text} disabled={p.busy} wrong={p.needsKey === "wrong"} onInput={setText} />
                    {p.busy ? <div class="bk-progress" role="status"><div class="pbar"><span /></div><span>Unlocking…</span></div> : null}
                    <div class="bk-actions">
                        <button class="test-btn arch-primary" disabled={p.busy || !text} onClick={() => p.onSecret(text)}>{p.busy ? "Unlocking…" : "Unlock and save"}</button>
                        <button class="test-btn" disabled={p.busy} onClick={p.onCancel}>Cancel</button>
                    </div>
                </>
            )}
            {p.message ? <div class="set-hint arch-msg">{p.message}</div> : null}
        </div>
    );
}

// --- changing the passphrase ---

/**
 * Change the passphrase: the old passphrase or the recovery key, then the new one twice.
 * @group settings
 * @gallery {"busy": false, "message": ""}
 */
export function ChangePassphraseBody(p: { busy: boolean; message: string; onChange(oldText: string, next: string): void }) {
    const [old, setOld] = useState("");
    const [first, setFirst] = useState("");
    const [again, setAgain] = useState("");
    const problem = first || again ? passphraseProblem(first, again) : null;
    return (
        <div class="bk">
            <div class="bk-title">Change passphrase</div>
            <label class="set-field"><span>Current passphrase or recovery key</span><input type="password" autocomplete="off" value={old} disabled={p.busy} onInput={(e: any) => setOld(e.target.value)} /></label>
            <label class="set-field"><span>New passphrase</span><input type="password" autocomplete="new-password" value={first} disabled={p.busy} onInput={(e: any) => setFirst(e.target.value)} /></label>
            <label class="set-field"><span>Again</span><input type="password" autocomplete="new-password" value={again} disabled={p.busy} class={problem && again ? "err" : ""} onInput={(e: any) => setAgain(e.target.value)} /></label>
            {problem ? <div class="set-err">{problem}</div> : null}
            <div class="set-hint">Files already written still open with the old passphrase and with the recovery key; new files use the new passphrase.</div>
            <div class="bk-actions"><button class="test-btn" disabled={p.busy || !old || !!passphraseProblem(first, again)} onClick={() => p.onChange(old, first)}>{p.busy ? "Changing…" : "Change passphrase"}</button></div>
            {p.message ? <div class="set-hint arch-msg">{p.message}</div> : null}
        </div>
    );
}

// --- this browser's wiring ---

/** A `BACKUP` message to the worker; a failure keeps the BackupError's `reason`. */
function backupMessage<T>(payload: Record<string, unknown>): Promise<T> {
    return new Promise((resolve, reject) => chrome.runtime.sendMessage({ type: "BACKUP", payload }, (r?: { data?: T; error?: string; reason?: string }) => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else if (r?.error !== undefined) reject(Object.assign(new Error(r.error), r.reason ? { reason: r.reason } : {}));
        else resolve(r?.data as T);
    }));
}

const reasonOf = (e: unknown): string | undefined => (e as { reason?: string } | null)?.reason;
const messageOf = (e: unknown): string => String((e as Error)?.message || e);

/** Ask for a file with the browser's own chooser; null when the person cancels. Must be called inside a click. */
function pickFile(accept: string): Promise<File | null> {
    return new Promise((resolve) => {
        const input = document.createElement("input");
        input.type = "file"; input.accept = accept;
        input.onchange = () => resolve(input.files?.[0] ?? null);
        input.oncancel = () => resolve(null);
        input.click();
    });
}

/** Stream the `out` slot to the place the person picks: the save dialog where the browser has one, a download otherwise. */
async function saveOutSlot(name: string): Promise<boolean> {
    const file = await backupSlotFile("out");
    if (!file) throw new Error("the backup file is gone from the browser's private storage");
    const picker = (window as unknown as { showSaveFilePicker?: (o: { suggestedName: string }) => Promise<{ createWritable(): Promise<WritableStream> }> }).showSaveFilePicker;
    if (picker) {
        let handle;
        try { handle = await picker({ suggestedName: name }); }
        catch (e) { if ((e as DOMException)?.name === "AbortError") return false; throw e; }
        await file.stream().pipeTo(await handle.createWritable());
        return true;
    }
    // A download reads its blob after this returns, and the caller removes the slot then: a blob of the slot's File
    // would be gone (Chromium cancels the download), so it is copied into memory first, and its URL outlives the read.
    const copy = new Blob([await file.arrayBuffer()], { type: "application/octet-stream" });
    const url = URL.createObjectURL(copy);
    const a = document.createElement("a");
    a.href = url; a.download = name;
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
    return true;
}

/** A keyring held in memory, for set-up: the real one is written only once the recovery key has been typed back. */
function memoryKeyringStore(): KeyringStore & { ring(): Keyring | null } {
    let ring: Keyring | null = null;
    return { ring: () => ring, read: async () => ring, create: async (r) => { ring = r; }, replace: async (r) => { ring = r; } };
}

/**
 * The recovery-key set-up as a whole, wired: passphrase, the key shown once, one group typed back, and only then the
 * keyring written to `keyring`. Shared by the backup screen and the archive folder's form choice, so there is one
 * set-up. `onDone` runs after the keyring is stored; `onCancel` leaves nothing behind.
 * @gallery none it runs Argon2 and writes the keyring; `RecoveryKeyBody` is the same view with props
 */
export function KeyringSetup(p: { keyring: KeyringStore; onDone(): void; onCancel(): void }) {
    const [mem] = useState(memoryKeyringStore);
    const [st, setSt] = useState<{ groups: string[]; askIndex: number; stage: RecoveryStage }>({ groups: [], askIndex: 0, stage: "choose" });
    const [busy, setBusy] = useState(false);
    const [message, setMessage] = useState("");
    return (
        <RecoveryKeyBody stage={st.stage} groups={st.groups} askIndex={st.askIndex} busy={busy} message={message}
            onChoose={async (pass) => {
                setBusy(true); setMessage("");
                try {
                    const r = await setupKeyring(mem, pass);
                    setSt({ groups: r.groups, askIndex: pickGroupIndex(r.groups.length), stage: "show" });
                } catch (e) { setMessage(messageOf(e)); }
                finally { setBusy(false); }
            }}
            onSaved={() => setSt({ ...st, stage: "verify" })}
            onBack={() => setSt({ ...st, stage: "show" })}
            onVerified={async () => {
                setBusy(true); setMessage("");
                try {
                    await p.keyring.create(mem.ring()!);   // only now does anything about this install's key reach storage
                    setBusy(false);
                    p.onDone();
                } catch (e) { setMessage(messageOf(e)); setBusy(false); }
            }}
            onCancel={() => { setMessage(""); p.onCancel(); }} />
    );
}

/**
 * This browser's backup and restore: the bodies, wired to the worker, the keyring and the origin-private file slots.
 * @gallery none it talks to the service worker and the browser's file system; the bodies it composes are the same views with props
 */
export function LocalBackup() {
    const keyring = idbKeyringStore();
    const [keySet, setKeySet] = useState<boolean | null>(null);
    const [setup, setSetup] = useState<{ form: BackupForm; includeApiKey: boolean } | null>(null);
    const [busy, setBusy] = useState<string | null>(null);
    const [msg, setMsg] = useState<Record<string, string>>({});
    const say = (k: string, m: string) => setMsg((o) => ({ ...o, [k]: m }));
    const [made, setMade] = useState<BackupDone | null>(null);
    const [restore, setRestore] = useState<RestoreState>({ kind: "idle" });
    const [secret, setSecret] = useState<Secret | null>(null);
    // The restored file's header and the secret typed for it, kept past the restore only to offer its key (dropped once used or declined).
    const [adopt, setAdopt] = useState<{ head: Uint8Array; secret: Secret; hasOwnKey: boolean; busy: boolean; error: string } | null>(null);
    const [dec, setDec] = useState<{ file: File | null; needs: null | "needed" | "wrong" }>({ file: null, needs: null });
    useEffect(() => { void keyringState(keyring).then((s) => setKeySet(s.set), () => setKeySet(false)); }, []);

    // --- backup ---
    const make = async (form: BackupForm, includeApiKey: boolean) => {
        setBusy("make"); say("make", ""); setMade(null);
        try {
            const r = await backupMessage<BackupResult>({ action: "create", form, includeApiKey });
            const name = backupFileName(form);
            const saved = await saveOutSlot(name);
            say("make", saved ? "" : "Not saved: the save dialog was closed.");
            if (saved) setMade({ ...r, savedAs: name });
        } catch (e) { say("make", `That did not work: ${messageOf(e)}`); }
        finally { await removeBackupSlot("out").catch(() => {}); setBusy(null); }
    };
    const onMake = async (form: BackupForm, includeApiKey: boolean) => {
        if (form === "encrypted" && !keySet) { setSetup({ form, includeApiKey }); return; }
        await make(form, includeApiKey);
    };

    // --- set-up ---
    if (setup) return (
        <KeyringSetup keyring={keyring} onCancel={() => setSetup(null)}
            onDone={() => { setKeySet(true); const then = setup; setSetup(null); void make(then.form, then.includeApiKey); }} />
    );

    // --- restore ---
    const rememberAdoptable = async (s: Secret) => {
        try {
            const file = await backupSlotFile("in");
            if (!file) return;
            const head = await readHeadAndFirstChunk(file);
            const ring = await loadKeyring(keyring);
            if (offersBackupKey(head, s, ring)) setAdopt({ head, secret: s, hasOwnKey: !!ring, busy: false, error: "" });
        } catch { /* no offer: the restore itself is unaffected */ }
    };
    const offer = async (s?: Secret) => {
        setRestore({ kind: s ? "unlocking" : "reading" }); say("restore", "");
        try {
            const o = await backupMessage<RestoreOffer>({ action: "offer", ...(s ? { secret: s } : {}) });
            setRestore({ kind: "preview", offer: o });
            if (s) void rememberAdoptable(s);
        } catch (e) {
            const reason = reasonOf(e);
            if (reason === "needs-key") setRestore({ kind: "needs-key" });
            else if (reason === "wrong-secret" || reason === "bad-recovery-key") setRestore({ kind: "needs-key", wrong: true });
            else { setRestore({ kind: "idle" }); say("restore", `That did not work: ${messageOf(e)}`); }
        }
    };
    const pickRestore = async () => {
        const file = await pickFile(".wmlbak,.sqlite,.gz,application/gzip,application/vnd.sqlite3");
        if (!file) return;
        setSecret(null); setAdopt(null); say("restore", "");
        try { await copyIntoBackupSlot("in", file); } catch (e) { say("restore", `That did not work: ${messageOf(e)}`); return; }
        await offer();
    };
    const cancelRestore = async () => { await removeBackupSlot("in").catch(() => {}); setSecret(null); setAdopt(null); setRestore({ kind: "idle" }); say("restore", ""); };

    // --- decrypt ---
    const decrypt = async (file: File, s?: Secret) => {
        setBusy("decrypt"); say("decrypt", "");
        try {
            const plain = await openBackupBytes(new Uint8Array(await file.arrayBuffer()), await loadKeyring(keyring), s);
            const out = file.name.replace(/\.(wmlbak|gz)$/i, "").replace(/\.sqlite$/i, "") + ".sqlite";
            downloadBlob(out, new Blob([plain as BlobPart], { type: "application/vnd.sqlite3" }));
            setDec({ file: null, needs: null }); say("decrypt", `Saved ${out} (${formatBytes(plain.length)}).`);
        } catch (e) {
            const reason = e instanceof BackupError ? e.reason : reasonOf(e);
            if (reason === "needs-key") setDec({ file, needs: "needed" });
            else if (reason === "wrong-secret" || reason === "bad-recovery-key") setDec({ file, needs: "wrong" });
            else { setDec({ file: null, needs: null }); say("decrypt", `That did not work: ${messageOf(e)}`); }
        } finally { setBusy(null); }
    };

    return (
        <div class="bk-root">
            <BackupBody keyringSet={keySet} busy={busy === "make"} message={msg.make ?? ""} result={made} onMake={onMake} />
            <RestoreBody state={restore} message={msg.restore ?? ""}
                onPick={pickRestore}
                onUnlock={(text) => { const s = secretFromText(text); setSecret(s); void offer(s); }}
                onRestore={async (o) => {
                    if (restore.kind !== "preview") return;
                    const current = restore.offer;
                    setRestore({ kind: "restoring", offer: current }); say("restore", "");
                    try {
                        const r = await backupMessage<{ sessionsAdded: number; written: { sync: string[]; local: string[] } }>({
                            action: "restore", plan: o.settings ? current.plan : null, digest: current.contents.digest, sessions: o.sessions, settings: o.settings, ...(secret ? { secret } : {}),
                        });
                        setSecret(null); setRestore({ kind: "done", ...r });
                    } catch (e) {
                        if (reasonOf(e) === "changed") setRestore({ kind: "changed" });
                        else { setRestore({ kind: "preview", offer: current }); say("restore", `That did not work: ${messageOf(e)}`); }
                    }
                }}
                onReread={() => void offer(secret ?? undefined)}
                onCancel={cancelRestore}
                adopt={adopt ? {
                    hasOwnKey: adopt.hasOwnKey, busy: adopt.busy, error: adopt.error,
                    onDecline: () => setAdopt(null),
                    onAdopt: async () => {
                        setAdopt({ ...adopt, busy: true, error: "" });
                        try {
                            await adoptKeyring(keyring, adopt.head, adopt.secret);
                            setKeySet(true); setAdopt(null); say("restore", "This install now encrypts with that backup's key.");
                        } catch (e) { setAdopt({ ...adopt, busy: false, error: `That did not work: ${messageOf(e)}` }); }
                    },
                } : undefined} />
            <DecryptBody fileName={dec.file?.name ?? ""} needsKey={dec.needs} busy={busy === "decrypt"} message={msg.decrypt ?? ""}
                onPick={async () => { const f = await pickFile(".wmlbak,.sqlite,.gz"); if (f) await decrypt(f); }}
                onSecret={(text) => { if (dec.file) void decrypt(dec.file, secretFromText(text)); }}
                onCancel={() => { setDec({ file: null, needs: null }); say("decrypt", ""); }} />
            {keySet ? (
                <ChangePassphraseBody busy={busy === "pass"} message={msg.pass ?? ""}
                    onChange={async (oldText, next) => {
                        setBusy("pass"); say("pass", "");
                        try { await changePassphrase(keyring, secretFromText(oldText), next); say("pass", "Passphrase changed."); }
                        catch (e) { say("pass", reasonOf(e) === "wrong-secret" || reasonOf(e) === "bad-recovery-key" ? "The current passphrase or recovery key is not right." : `That did not work: ${messageOf(e)}`); }
                        finally { setBusy(null); }
                    }} />
            ) : null}
        </div>
    );
}
