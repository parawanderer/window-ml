# Backup, restore and the archive folder

How this browser's sessions and settings get OUT of the browser profile and back IN: the archive folder (a live
mirror) and the backup file (a one-off snapshot). One file format serves both. Agreed with Shane on 2026-10-23; built
in four PRs, and each section below says which parts exist yet.

| Part | Status |
| --- | --- |
| A. The folder merges before it writes; a picked folder with old files is asked about | built |
| 1. The file format: compression, encryption, keys; `docs/spec/BACKUP_FORMAT.md`; a standalone decryptor | built |
| 2a. Backup and restore without screens: the key inventory, collect and preview and apply of settings, the file writer, the keyring at rest, the worker ops | built |
| 2b. The screens: Settings (DevTools panel and chat page Extension tab), the popup button, the recovery screen | built |
| 3a. The archive folder's form: encrypted, compressed or plain month files, and the switch from plain | built (worker and screen) |
| 3b. Deletes that travel: the `removed` entries written into the month files | built |
| 3c. Two machines on one encrypted folder: adopting the folder's key, keeping one's own as a retired key | built |
| 3d. Forgetting a retired key, by hand, in Settings | built |
| 3e. Telling a planted key from the real one: verified counts, key ids to match, the folder's pinned key | designed |

The archive itself (SQLite over OPFS, the worker, un-archiving) is `archive.md`; read it first.

## Two ways out, one format

| | Archive folder | Backup file |
| --- | --- | --- |
| Holds | sessions moved into the archive | settings, policies, site lists, UI preferences, and every session, live and archived |
| Written | 30 s after an archive write, every 6 hours, from Settings | once, on a click |
| Shape | one month file per `YYYY-MM` of last activity | one file |
| For | a copy that survives a wiped profile | moving to a new machine; a snapshot |

Both are the archive's SQLite schema (`migrate`, db.ts). A backup is the same database holding every session, plus a
`backup_settings` table (part 2). So a decrypted backup opens in any SQLite tool like a month file does, and restoring
its sessions is the archive's own import (`importFrom`: new sessions only, so a second restore adds nothing).

Restored sessions land in the ARCHIVE, not the live store: opening one un-archives it (`archive.md`, "Reaching archived
sessions"), so there is still exactly one place each session lives.

## The three forms of a file (part 1)

| Form | Name | Opens with |
| --- | --- | --- |
| plain | `2026-10.sqlite` | any SQLite tool |
| compressed | `2026-10.sqlite.gz` | `gunzip`, then any SQLite tool |
| encrypted, the default | `2026-10.wmlbak` | the passphrase or the recovery key, in Settings or with the decryptor |

- **Encrypted by default** because the obvious place for a folder or a backup is one a cloud service syncs, and these
  files hold whole transcripts: page text, screenshots, whatever a tool fetched. Plain is a setting, with a warning.
- **Compression comes before encryption**, because ciphertext does not compress; an encrypted file is always gzip
  inside. `CompressionStream` is built into the browser, so it costs no dependency. Event JSON shrinks several times;
  images are already WebP and do not.
- **Every reader takes all three forms**, told apart by their first bytes, never by the name.

The byte layout, precise enough to write a decryptor from, is `docs/spec/BACKUP_FORMAT.md`; the code is `src/backup/backup-format.ts` and the standalone reader `tools/wmlbak-decrypt.mjs`. In outline:

- One random 256-bit DATA KEY per install encrypts everything. Each file derives its own key from it (HKDF over a
  per-file salt), so nonces restart at zero in every file and never repeat under one key.
- The body is AES-256-GCM in chunks, each with a counter nonce and a last-chunk flag, the header as associated data: a
  truncated file, reordered chunks or an edited header fail to decrypt rather than restoring part of a history.
- Every header carries the data key WRAPPED twice: under a key from the passphrase (Argon2id, `hash-wasm`; memory-hard,
  which is what makes guessing a passphrase on a GPU expensive) and under the RECOVERY KEY (128 random bits, so a fast
  HKDF is enough). Either opens any file, on any machine, with nothing else from this one.
- The browser keeps the data key only as a non-extractable `CryptoKey` plus the two wrapped copies, which it pastes
  into each header. Nothing in the profile can read the key back out; changing the passphrase needs the old one (or the
  recovery key) to unwrap it, and only new files carry the new wrap.

## The passphrase and the recovery key (part 2)

Set once per install, the first time something is encrypted. Afterwards the folder writes without asking.

- **The recovery screen**, as a password manager does it: the key shown once in groups (`K7QF-2MXR-…`), with copy,
  download as text, and print; then one group, picked at random, typed back. It says plainly that with both the
  passphrase and the key lost, nobody can open these files.
- **Settings and the export dialog say, beside the encryption switch,** why it is on by default and how to get a plain
  SQLite file out: "Decrypt a file…" in Settings, or the decryptor script, documented in the spec.
- **The API key** goes into a backup by default only when it is encrypted; a plain backup leaves it out unless ticked.

## Backup and restore (part 2)

- **Where:** Settings → Extension on the chat page, and the DevTools Settings panel (the rule: that panel has every
  setting). The popup's button opens the chat page at `#/settings/extension/backup`: a popup closes the moment a file
  chooser takes focus, and an export of a large archive outlives a popup's attention anyway.
- **What a settings backup holds is an inventory, not a guess.** Every storage key in `src/` is classified as backed
  up or not, and a test fails on a key nobody classified, so a new preference forces the decision instead of silently
  missing from every backup. Backed up: `chrome.storage.sync` (the config, filtered to `DEFAULT_CONFIG`'s keys),
  policies, the site-access lists, UI preferences. Never: the hub keyring (pairing is redone on a new machine), run
  state, logs, caches, grants that last one session.
- **Restore shows what it would change before it changes anything**, sites it would approve listed first: approving a
  site lets its pages call `window.ml`. Unknown keys are dropped; a backup from an older version is read through the
  same upgrade a stored value would get, tested against a fixture.
- **Resuming a restored chat (the open question).** A chat's `ml_session_<hash>` record, what `ml.resumeChat` reads, is
  not a column of the archive, but its content is: `saveChatSession` writes the same `StoredSession` into the session's
  `history` as `{ kind: "chat", session }` (sw-sessions.ts), and `history` is archived and backed up whole. Archiving
  never removes the `ml_session_` record (only a delete does, `forgetStored`), so in the same profile an archived chat
  still resumes. A RESTORED chat does not: nothing writes `ml_session_<hash>` back. Un-archiving (`unarchiveSession`)
  restores the row, events and history into the session store and stops there, while `ml.resumeChat` (`GET_SESSION`,
  background.ts) and a worker-hosted chat after an eviction (`rehydrate`, sw-chat.ts, through `load`) read only the
  storage key. So a restored chat is readable, but resuming it from a page fails until the key exists.
  `unarchiveSession` now writes the record back from the history when it is a chat and no record exists
  (`restoreChatRecord`, session/chat-record.ts), never over a live one. Not touched, noted: a session evicted with
  outcome `deleted` leaves its `ml_session_` record behind, since only `forgetStored` removes it.

### What part 2a built

| File | Holds |
| --- | --- |
| `src/backup/backup-inventory.ts` | `INVENTORY` and `classify(area, key)`: every storage key, backed up or never, one reason each |
| `src/backup/backup-settings.ts` | `collectSettings`, `parseSettings`, `upgradeSettings`, `previewRestore`, `applyRestore` (pure) |
| `src/backup/backup-file.ts` | `beginBackup`, `addSession`, `finishBackup`, `sealBackup`, `openBackupBytes`, `inspectBackup`, `inspectRestore`, `restoreNewSessions` |
| `src/backup/backup-keyring.ts` | the data key at rest (IndexedDB `ml-backup-keyring`), `setupKeyring`, `changePassphrase` |
| `src/backup/backup-opfs.ts` | the two origin-private files that carry a backup between a page and the archive worker |
| `src/sw/sw-backup.ts` | the `BACKUP` message: the real `BackupDeps`, validation, the restore plan checked again |
| `src/backup/backup-run.ts` | `createBackup`, `offerRestore`, `restoreBackup`: the sequence, every outside thing injected |
| `src/archive/archive-worker.ts` | the ops `backupBegin`, `backupPut`, `backupFinish`, `backupAbort`, `restoreInspect`, `restoreSessions`, `backupFileRemove` |
| `src/sw/policy-valid.ts` | the policy validator and the source and label bounds the worker and a restore share (moved out of `sw-policies.ts`) |

**The inventory.** 129 classified entries: 92 backed up (the 55 config keys other than the API key, the global
policies, 5 site keys, 31 UI preferences), 1 backed up only when encrypted (`apiKey`), 36 never. The config is
classified from `DEFAULT_CONFIG`, so a new setting is in every backup from the commit that adds it; any other key needs
an entry in `INVENTORY`, and `tests/backup-inventory.test.mjs` fails on a key nobody classified and on an entry no
source names. The scan reads every `ml_` string in `src/` (a whole literal is a key, one ending in `_` or `:` and the
text before a template's first `${` are prefixes) and the keys at every `chrome.storage.*.get|set|remove` call. It
cannot see a key assembled at run time from non-literal parts, or a key that does not start with `ml_` and is reached
only through a constant. Stores that are not `chrome.storage` (IndexedDB) are listed in `OTHER_STORES`, with what a
backup does with each, so the hub pairing is visibly never backed up.

**Collect.** `collectSettings` reads `sync` and `local` (never `session`) and keeps the keys the inventory marks `yes`.
The API key is kept only for an encrypted file or when the person ticked the box for a plain one, and the result says
when it was left out (`apiKeyOmitted`) so the screen can tell the person. A whole-list key nobody ever wrote (the
policies, the site lists) is collected as empty, so that a backup saying "none" differs from a backup from a version
that did not have the key.

**Restore, three steps, none of which writes.**

1. `parseSettings` bounds the payload (8 MiB, 256 KiB a value) and refuses one from a newer layout. The worker holds
   the 8 MiB bound too, where it reads the row (`inspectBackup`): an oversize payload is never returned, only
   `settingsError`, so a hostile file cannot make the worker hand a gigabyte of text to the page.
2. `upgradeSettings` reads an old payload through the upgrades a stored value gets: the site lists through
   `migrateSiteLists` (a pre-slice-3 backup has no agent levels and keeps its self-approval whitelist in the sync
   config), `protoStream` through `protoMode`, the policies through the validator the worker uses. It drops, and lists,
   a key this version does not keep, a key the inventory says is never restored, a config value of the wrong type, an
   origin that is not an origin, a malformed or repeated policy, and a policy whose source or label is past
   `POLICY_SOURCE_MAX`/`POLICY_LABEL_MAX` (the policy page refuses those too; counted in the same note).
   `tests/fixtures/backup/settings-pre-slice3.json` is the fixture of an old payload and `tests/backup-settings.test.mjs`
   reads it.
3. `previewRestore` lists the changes against what is stored now. Sites whose standing changes come first, those that
   would become able to call `window.ml` before the rest (a site on the self-approval list counts: that implies use).
   Then policies (those that allow first), then the settings that send traffic or widen what runs without asking
   (`RISKY_CONFIG`: `chatUrl`, which would receive the saved API key; `apiKey` itself, which replaces this browser's;
   `modelFilter`, whose clearing removes the model whitelist; `agentStartPage`; `pageApprovalDomains`, which migrates
   into the self-approval list; the shell, auto-approve and CDP flags), then everything else. A credential is shown as
   `(set)`, never its value, and a plain file can carry `apiKey` too, so a restore that changes it is risky whatever the
   file's form. A restore that changes `chatUrl` while the backup carries no API key would send THIS browser's saved
   key to the backup's address, and the risky group says exactly that.
   What a screen renders: `PolicyChange.source` is the predicate, so a hostile rule cannot hide behind its label.
   `Change.shown` is display text cut at 160 characters; when it is cut, `shown.truncated` is `true` and
   `shown.length` holds the full lengths, and the change's own `before`/`after` hold the whole value.

`applyRestore` writes exactly `plan.changes`, one `set` per storage area, so the site lists and their layout marker land
together; a key the backup does not carry is left alone. A list the backup holds empty and that is not empty here is a
removal. Run it in the service worker after `siteSchemaReady()`, or a later migration can undo it. The site lists a
backup carries are the `local` ones (the session half of the agent levels, and the sites allowed for one browser
session, are never backed up); a restore replaces the local lists and keeps the session ones.

**The file.** `beginBackup` opens an empty in-memory archive and imports the archive's own export into it; `addSession`
writes each live session with the archive's own `writeSession` (the live copy wins where a session is in both);
`finishBackup` adds the `backup_settings` table (`key`/`value` rows: `payload`, `created`, `layout`) and serializes it.
`sealBackup` writes the chosen form. The memory cost is the archive twice over plus the file. A restore opens the file
(`openBackupBytes`: this install's key when it sealed the file, else the passphrase or recovery key it is given),
`inspectRestore` counts what is new without changing the archive, and `restoreNewSessions` is the archive's import (new
sessions only, and never a session the person removed on purpose). The worker then marks every month dirty, because an
import from a folder matches the folder and an import from a backup does not.

**The restore is pinned to what was inspected.** `restoreInspect` answers the SHA-256 of the file in the `in` slot
(`digest`), the hash of every session it would add (`hashes`, uncapped) and the first 500 of them by title, start time
and bytes (`adding`, with `more` counting the rest). `restoreSessions` takes the digest and hashes back, refuses with
`reason: "changed"` when the slot's file digests differently, and imports only those hashes (`importFrom`'s `only`).
`restoreBackup` takes the whole `RestoreOffer` for that reason: pass it what `offerRestore` returned, never a re-read.
The same applies to the settings half, which `applyRestore` pins to `plan.changes`.

**An import copies only the images its new sessions reference** (`importFrom`). It once copied every `images` row of the
file, so an orphan blob in a backup or a month file landed in the archive whether or not any session was new.

**Moving the bytes.** Extension messages are JSON and a backup can be hundreds of megabytes, so the worker writes the
finished file to an origin-private file (`out`) and reads the file to restore from another (`in`); the page, which
shares the origin, streams `out` to the place the person chose and copies a picked file into `in`. The ops return sizes
and counts only. A `BackupError`'s `reason` travels with the error (`archiveCall` keeps it), so the screen can tell
"this needs the passphrase" from "that passphrase is wrong".

**The keyring.** `setupKeyring(store, passphrase)` makes the data key, stores it as a non-extractable `CryptoKey` with
its two wrapped copies in IndexedDB `ml-backup-keyring` (created with `add`, so two contexts racing a set-up cannot both
win), and returns the recovery key once as 7 groups of 4 for the recovery screen. `loadKeyring` needs no secret: the
data key is usable but not readable. `changePassphrase` unwraps with the old passphrase or the recovery key and
replaces only the passphrase wrap; files already written keep their old wraps, so they open with the old passphrase and
with the recovery key.

**The service-worker binding (2b).** One message, `BACKUP`, from extension pages only (a page-relayed one is refused
before anything runs, and it is not in `HANDLE_MAP`): `{action:"create", form, includeApiKey?}`, `{action:"offer",
secret?}` and `{action:"restore", plan, sessions, settings, secret?}`, handled by `backupAction` in `sw-backup.ts`
over the real `BackupDeps` (`archiveCall`, the worker's `sessionStore`, the three storage areas, `chromeStorageWriter`).
A failure answers `{ error, reason }`, so the page can tell `needs-key` from `wrong-secret`. A restore does not trust
the page: the worker reads the file and the storage again, makes its own offer (its own digest, its own session hashes,
its own plan) and restores THAT. From the page it takes only the area and key of each settings change the person left
ticked (a key the file lacks, or a forged value, is never written) and, optionally, the digest the person previewed: a
different one is refused with `reason: "changed"`. It waits for `siteSchemaReady()` before writing settings and calls
`scheduleFolderSync()` only when sessions were added. Setting up and changing the passphrase are not messages: the page reaches the keyring in
IndexedDB directly.

### What part 2b built (the screens)

`src/sidebar/settings/backup-section.tsx`, a "Backup and restore" sub-section under Storage in Settings, beside the
archive folder one (`settings.tsx`). The chat page's Settings → Extension renders the same `Settings` component, so
one section serves the DevTools panel and the chat page. Each screen is a pure body taking state and callbacks
(`RecoveryKeyBody`, `BackupBody`, `RestoreBody`, `DecryptBody`, `ChangePassphraseBody`, each with `@gallery`
examples); `LocalBackup` wires them to the `BACKUP` message, the keyring in IndexedDB and the `in`/`out` slots.

- **Set-up and the recovery screen.** The first encrypted backup on an install with no keyring starts it: a passphrase
  typed twice (at least 12 characters, with the reason), then the key once in its groups (copy, download as .txt, print
  through a print stylesheet that shows only the key and one line), then one group picked at random to type back. The
  keyring is made in a MEMORY store and written to IndexedDB only once the group matched, so leaving half way never
  leaves a passphrase whose recovery key was not seen. The key lives in component state and nowhere else
  (`tests/backup-section.test.mjs` spies every storage write).
- **Backup.** Encrypted (default), compressed or plain, the "why encrypted" text, the decryptor's path, and an "Include
  the API key" box for the two unencrypted forms. `BACKUP create`, then the `out` slot is streamed to a save dialog
  (`showSaveFilePicker`) or an `<a download>`, named from `BACKUP_EXTENSION` and the date; the slot is removed after.
  The download is of an in-memory copy whose URL lives a minute: a download reads its blob after the click returns,
  and a blob of the slot's `File`, removed by then, made Chromium cancel it.
  The result line says size, sessions, "the API key was left out", and lists `unclassified` keys as a developer warning.
- **Restore.** "Restore from a file…" streams the picked file into `in` (`copyIntoBackupSlot`), then `BACKUP offer`.
  `needs-key` asks for a passphrase or recovery key in one field (`secretFromText` tells them apart by shape);
  `wrong-secret` keeps the field and says so; unlocking shows an indeterminate bar. The preview follows the plan's
  order: sites that gain use first, policies with their predicate, the risky settings with their `why` (chatUrl's
  API-key warning is the plan's own text), the rest collapsed. A cut value says "First 160 of N characters" and opens
  whole. The new sessions are listed from `contents.adding` with "and N more". The restore sends the plan's changes,
  the digest the person previewed and the secret; the worker recomputes its own offer and refuses `changed` when the
  digest differs, which the screen words as "the file changed" with a button to read it again (after a `changed` from
  the sessions step the slot is already emptied, so the re-read then asks for the file again).
- **Decrypt a file…** reads the file into memory whole (`openBackupBytes`, in the page) and saves the plain
  `.sqlite`; this install's keyring opens its own files, anything else asks for a secret. It inherits the format's
  output budget (`LIMITS.outputBytes`) and the page's memory; larger files go through `tools/wmlbak-decrypt.mjs`.
- **Change passphrase.** `changePassphrase` with the old passphrase or the recovery key; the screen says files already
  written still open with the old passphrase and the recovery key.
- **The popup's button** "Backup and restore…" opens `chat.html#/settings/extension/backup` (focusing an open chat tab
  and moving its hash): the `backup` anchor opens the Storage section and scrolls to the block (`route.ts`).

**In a real browser** (`tests/e2e/backup.spec.mjs`): set-up with a wrong group refused and the right one accepted, the
key in no storage area, two encrypted backups, then a fresh profile restoring with only the recovery key (a wrong
secret refused, sites first in the preview), a file swapped under the preview refused as `changed` with nothing
written, the re-read restoring both sessions and the settings; and the download path with no save dialog.

**Not built.** Rotating the recovery key. (Adopting another install's data key, on restore and from the archive folder,
and the folder's encryption switch are parts 3c and 3a, below.)

## The archive folder's form (part 3)

Designed 2026-10-27. 3a is built, worker and screen (`folderForm` op, `folder-sync.ts`, the archive section); so are 3b
and 3c. Three PRs, in this order, because each needs the one before.

### 3a. Encrypted, compressed or plain month files

- **The form is the archive's own setting**, `meta.folder_form` (`encrypted`, `gzip`, `plain`: a `BackupForm`;
  "compressed" below is `gzip`), because the worker that writes the
  files is chrome-free and owns that database. Settings sets it with a worker op.
- **The upgrade.** An archive from before part 3 has no `folder_form` and reads as `plain`, which is what it was
  writing: nothing changes on someone's machine until they choose. Settings then says the folder is not encrypted and
  offers to switch, which runs the recovery-key set-up (part 2b's screen) when the install has no keyring.
- **A new folder is encrypted by default, and writes nothing until its form is chosen.** The form is unchosen (null)
  while the archive has neither `folder_form` nor `last_sync`; Settings preselects Encrypted, which with no keyring asks
  for set-up first, and plain is an explicit choice.
- **The name follows the form** (`YYYY-MM.sqlite`, `.sqlite.gz`, `.wmlbak`, `BACKUP_EXTENSION`), and a reader sniffs
  the bytes (`readAnyForm`), never the name. A month may have files of several forms in the folder: mid-switch, or two
  machines writing different forms.
- **A sync merges every file of the month**, whatever its form, then writes the chosen form, then removes the month's
  files in the other forms. A removal happens only after the new file is completely written and only for a file
  that was merged in this sync; if any of the month's files cannot be read, nothing of that month is written or
  removed and it stays pending (part A's rule, per file).
- **Two machines on different forms settle.** A month is rewritten only when it is dirty (a change, a merge that
  changed the archive, a form switch), never because a file is in another form. A rewrite still removes the other
  forms' files, so while new sessions arrive the month's file changes form with whichever machine wrote last; once a
  merge adds nothing, neither writes (tested: A plain and B encrypted on one key).
- **Switching forms marks every month dirty**, so the next sync rewrites the folder in the new form and the plaintext
  copies go. A synced folder's service may still keep old versions; Settings says so once, at the switch.
- **An encrypted month this install cannot open** (no keyring, or another install's key: `keyId` differs) is skipped
  with a reason the section can act on (`needs-key`, `other-key`), never as a bare error string.
- **Memory.** A month is decrypted and gunzipped whole, as `exportMonth` builds it whole; `LIMITS.outputBytes` (1 GiB)
  is far above any month the archive holds, so the bound is the worker's memory, not the format.

### What part 3a built (the screen)

`ArchiveFormChoice` and `SkippedMonths` in `archive-section.tsx`, under the connected folder; both pure, with
`@gallery` examples. `folderAction` takes `{ action: "form", form }`, refuses anything but the three `BackupForm`
values, calls the worker's `folderForm` op and then starts a `sync` (`ARCHIVE_FOLDER` stays extension pages only).

- **The choice.** Encrypted (recommended), compressed, plain SQLite, showing `report.form`. Plain and compressed carry
  one warning line (whole transcripts, readable by a synced folder's service). Picking a form other than the current
  one says, before anything is sent, that the next sync rewrites every month and removes the old files and that a
  sync service may keep earlier versions; Cancel leaves the form as it was.
- **Encrypted with no keyring** runs `KeyringSetup` first, the part 2b flow (`RecoveryKeyBody`, keyring written only
  after the group is typed back; the backup screen uses the same component) and sends the form only once it is done.
- **An unchosen form.** `folderFormOf` is null (`FolderReport.form` null) while `meta.folder_form` and `meta.last_sync`
  are both absent: an archive that never synced never had a folder, and every pre-part-3 archive that had one synced
  at its pick, so those read as `plain` and the upgrade rule holds. While it is unchosen `sync`, `resync` and `fresh`
  write nothing (months stay pending, `last_sync` is not set; a pick still imports what the folder holds) and the job
  is `blocked` on a choice in Settings. `setFolderForm` ends it. The section shows the choice, Encrypted preselected
  with an explicit Continue and no switch notice, whenever a folder is connected and the form is null: right after the
  pick, after a reload, or after a pick made from elsewhere. There is no page-side inference.
- **Skipped months by reason**, from the last sync or import report (kept in the page; a plain state read does not
  carry them): `needs-key` and `other-key` each say how many months and what to do, `unreadable` keeps the month and
  the error. Using another install's key is part 3c, below.
- **The job status.** `archive.folder-sync` reports `blocked` while the last sync or import skipped months for
  `needs-key` or `other-key` (one line, shown in the housekeeping log's jobs). It does not reach the attention
  codes (`sw-attention.ts` has no `blocked`, and a new code is a contract change); a state read does not clear it.

### 3b. Deletes that travel

- **A month file carries its month's `removed` entries** (a `removed` table in the file; `migrate` creates it for a
  month file too). An older reader ignores the table: `importFrom` names the tables it copies.
- **A merge takes the file's entries in**: each is added to `removed`, or replaces an entry with an older `ts`; a
  session the archive holds whose `archived_ts` is older than the entry's `ts` is removed (`removeArchived`, which
  marks its month). One whose `archived_ts` is newer was archived again after the delete, and the entry is dropped.
- **An un-archive is a removal too**, so a session moved back to the live store on machine A leaves B's archive at
  the next merge; it returns when A archives it again. That is one archive shared by two machines, which is the point.
- **The clocks are the two machines'.** A skew only matters for a session deleted on one and re-archived on the other
  within the skew; the later write wins by its own clock.
- **Entries expire** after 180 days (`REMOVED_TTL_MS`), or a month file would carry every delete forever.

### What part 3b built

`migrate` creates `removed` in a month file's schema too, and `copyMonth`/`exportMonth` copy the entries whose `month` is
that month and whose `ts` is under 180 days old. `ARCHIVE_SCHEMA` is NOT bumped: an older reader names the tables it
copies and ignores `removed`, so it still imports such a file; an older install that REWRITES the month writes it
without the entries, and the delete stops travelling from that month until the entry is made again.

- **`mergeFrom` (db.ts) is the merge**, one transaction with the import, entries first. An entry is added to
  `main.removed`, or replaces an older one, and keeps the FILE's `ts`. A held session with `archived_ts` below the
  entry's `ts` is removed (events, text, image references, orphan images; its month is marked dirty). One at or above
  it was archived again after the delete: it stays and the entry is not added. Then the sessions the archive lacks:
  one with a local entry whose `ts` is at least its `archived_ts` stays deleted; a newer one is imported and the local
  entry dropped (archived again on the other machine after this one deleted it). A file with no `removed` table (from
  before 3b) merges as it always did. An entry whose hash, month or time is malformed is not read.
- **A restore keeps the hard rule.** `importFrom` (the restore and `beginBackup`) is unchanged: any local entry blocks
  the hash, whatever the backup copy's `archived_ts`, and the backup's own entries are not read. The preview
  (`inspectBackup`) counts by the same rule. A live session a backup holds has `archived_ts` "now", newer than the entry
  of the un-archive that put it live, so the time rule would restore it as a duplicate of the live one; and a backup is
  a snapshot of sessions, not a record of deletes. A restore therefore imports exactly what it previewed.
- **`SyncOutcome.deleted`**, and `importMonths`' and `adoptFolder`'s `imported.deleted`, count sessions a merge removed;
  `merged` still means sessions added.
- **A month with entries and no sessions keeps a file holding only the entries**, in the chosen form. Its file is
  removed once it has neither (`SyncOutcome.removed`). `allMonths` (hence `markAllDirty`, a pick and a change of form)
  includes the months that have only entries, so a change of form rewrites those files too.
- **Expiry.** `syncMonths` calls `expireRemoved(db, now)` before it lists the dirty months and again after each month's
  merge: entries older than 180 days leave `main.removed` and their months become dirty, so a file that carried one is
  rewritten without it. `FolderOptions.now` is the injectable clock. 180 days is far over any gap between two
  machines' syncs; a machine offline longer, still holding the session, brings it back.
- **A sync merges a month file another machine changed.** The archive remembers, per month and form, the `size` and
  `lastModified` of each file it last wrote or merged (`folder_files`, main only, written by `folderFilesSet`);
  `MonthFolder.stat` reads them without the bytes. Before the dirty list is read, `mergeChanged` merges every month whose
  files differ from that record (a new file, a changed one, a removed one) with `mergeFrom`. It marks the month dirty
  only when the merge changed the archive (sessions added or removed, an entry added or dropped) or the folder lost the
  file while the archive still holds something for the month; otherwise it only records the stats. A merge that changed nothing never causes a rewrite, so two machines syncing
  back and forth settle and stop writing (`tests/folder-sync.test.mjs`). A write records the written file's stats, an
  Import records what it merged, and a month left with no file forgets its record. A month the merge could not read
  (`needs-key`, `other-key`, `unreadable`) is skipped as a dirty one is and its stats are not recorded, so it is tried
  again. An archive from before 3b has no record, which counts as changed: its first sync after the upgrade merges every
  file once. This is what makes a new session or a delete written on A reach B with nothing dirty on B.

### 3c. Two machines on one encrypted folder

- **Each install makes its own data key at set-up**, so machine B cannot open machine A's months, and skips them
  (`other-key`) rather than overwriting them: safe, but neither sees the other's sessions.
- **"Use this folder's key"**: Settings asks for A's passphrase or recovery key, unwraps the data key from a month
  file's header (`unlock`), and makes it this install's current key, with A's wraps. B's own earlier key is KEPT as a
  retired key, so B's own earlier backups and months still open on B without a typed secret (on another install they
  need B's old passphrase or recovery key, as the header carries B's old wraps). Settings says so before it acts.
- **This is the same step as "adopting another install's data key on restore"**, so a restore offers it too.

### What part 3c built

- **`Keyring.retired?`** (`backup-format.ts`): a list of `{ key, keyId }`, non-extractable like the current key, in the
  same IndexedDB record. A record stored before 3c has none and loads, seals and opens unchanged. Sealing always uses
  the current key. Opening picks by the header's `keyId` among the current and the retired keys: `keyFor(ring, keyId)`,
  the one place that decides, used by `decryptFile`, `unlockChoice` (so a backup under a retired key opens with no
  secret) and `openFile` in `folder-sync.ts` (so a month under a retired key is merged, not skipped). A key neither
  current nor retired is still `other-key` there and `needs-key` on restore.
- **`adoptKeyring(store, file, secret)`** (`backup-keyring.ts`): `readHeader(file)`, `unlock(header.wraps, secret)`,
  `opensFirstChunk(file, key)` (the key must be the one the header names and open the first chunk, whose associated
  data is the header, so a header spliced over another file's chunks is refused as `corrupt`; red-team review
  2026-10-27), then store `{ key, keyId, wraps: the header's wraps, retired: [previous current, ...previous retired] }` (each keyId
  once, never the new current) with `replace`, or with `create` on an install with no keyring. A wrong secret throws
  `wrong-secret` before anything is read from the store for writing, so the record is untouched; the key the install
  already has is a no-op. `changePassphrase` keeps `retired` (it spreads the record).
- **`other-key` and `needs-key` skips carry the header's `keyId`** (`SyncOutcome.skipped`, `FolderReport.skipped`). The
  section adopts from the key most skipped months share (`keyToAdopt`), opened from the first of those months.
- **The page reads the header itself.** The section already holds the folder handle (`writableFolder`, the one
  `pickFolder` saved), so `readMonthHead` reads the header and first chunk of that month's encrypted file through it
  (`readHeadAndFirstChunk`, also used by the restore offer) and `adoptKeyring` runs in the page, as the key set-up
  does. No new worker op reads a file and no privilege is added.
- **`ARCHIVE_FOLDER { action: "rekey" }`** (extension pages only, refused from a page sender like the other actions):
  the worker op `rekey` marks every month dirty (`markAllDirty`) and a sync follows, so every month is rewritten under
  the new key and the months the install could not open are merged. It answers a `FolderReport`, so it is in
  `FOLDER_OPS`. When the folder's form is still unchosen (a new machine joining) nothing may be written, so the section
  sends `import` instead, which reads the months with the new key, and the form choice follows.
- **The archive section** (`SkippedMonths`, `AdoptFolderKey`): under an `other-key` line, "Use this folder's key": the
  restore screen's field (`SecretField`, one component for restore, decrypt and this) and `secretFromText`, with the
  cost said first (`adoptNotice`). A wrong secret says so and keeps the typed text. Under a `needs-key` line on an
  install with no keyring (a new machine) the same block is the FIRST choice, outlined, with "Set up a new key instead"
  (`KeyringSetup`) below it; where the form choice is on screen (the form is unchosen) that choice is the set-up.
- **Restore** (`AdoptBackupKey`, `offersBackupKey`): after a restore that needed a typed secret for a key this install
  neither holds nor retired (or that has no keyring), the screen offers once "Use this backup's key on this install".
  The page keeps the file's header bytes and the typed secret past the restore (the worker removes the slot) and drops
  both when the offer is used, declined, or another file is picked. It calls `adoptKeyring` and does not rekey the
  folder. The folder's months are still rewritten under the new key as they change, so a second machine sharing an
  encrypted folder under the OLD key starts skipping them (`other-key`) until it adopts the new key too; the offer does
  not say so yet.
- **Two machines that adopt each other's keys at the same moment swap keys.** Each keeps its old key as retired, so each
  still reads the months the other wrote, and the folder settles after the rewrites (`tests/folder-sync.test.mjs`).
  Nothing is built to prevent it.
- **A passphrase change on the other machine is not followed.** This install keeps the wraps it adopted, so the files it
  writes open with the passphrase as it was at adoption, and with the recovery key. Adopting again does not help: the
  same key is a no-op (`adoptKeyring`), so picking up the new wrap is not built.
- **Adoption trusts the secret, not the file's author** (what can be checked out of band: 3e). The chunk check binds the key to the file it came from, but
  whoever knows the secret the person types (a folder writer who shares the passphrase, a compromised second device)
  can seal a whole file under a key of their own wrapped under it, and that file is adopted; the folder's other months
  then start skipping as `other-key` on the honest machine, which is the visible sign. The recovery key is the stronger
  secret to adopt with: it is shown once and not shared.
- **A retired key is dropped only by hand.** A key adopted by mistake and later replaced stays in `retired` and keeps
  opening files it sealed until the person forgets it in Settings (part 3d, below).

### 3d. Forgetting a retired key

Designed 2026-10-27, after the red-team review of 3c.

**Why it matters.** A retired key leaks nothing new: nothing is sealed under it again. What it keeps open is the way IN.
The sync opens and merges any month file under a retired key (`keyFor`), then rewrites it under the current key. If the
retired key was adopted by mistake (or from someone who knew the secret, see "Adoption trusts the secret" above), its
maker can keep planting month files that this install merges into the archive as the person's own sessions; a resumed
one hands a planted transcript to the model. Replacing the key does not close that. Forgetting it does.

**Why forgetting is cheap.** Every encrypted file carries its own wraps in its header, so a file under a forgotten key
still opens with that key's passphrase or recovery key, typed (`unlockChoice` then asks, as for any foreign file). A
retired key saves typing; nothing depends on it to be recoverable. The cost Settings states is exactly that.

**Why not automatically.** Two machines that adopted each other's keys at once (the swap above) read each other's
months ONLY through their retired keys; an automatic drop breaks that. And a person may no longer know their old
passphrase, so a silent drop turns "saves typing" into "type a secret you lost". Forgetting is always a click.

**What to build:**

- **`retired` entries gain `since` (ms)**, set by `adoptKeyring` when it retires a key. A record from before 3d has
  entries with no `since`: they load and are listed as "retired earlier" (THE UPGRADE test).
- **`forgetRetiredKey(store, keyId)`** (`backup-keyring.ts`): removes that entry with `replace`; the current key and
  wraps are untouched; an unknown keyId, or the CURRENT keyId, is refused (the current key is never forgotten this
  way). Drops the `retired` field when the list empties.
- **The archive section lists the retired keys** under the key line: key id (short), when retired, and how many of the
  folder's month files are still under it (the page counts headers through the folder handle it holds, as
  `readMonthHead` does; no worker op). Each has "Forget", which says once before it acts: files under this key will ask
  for its passphrase or recovery key on this install; N months in the folder are still under it and will be skipped
  (`other-key`) until another install rewrites them. A month count of zero is the safe case and reads so.
- **No change to sync, rekey or sealing.** After a forget, a month under that key is simply `other-key`, which 3a and
  3c already handle (skipped, never overwritten, offered for adoption).
- **Tests:** forgetting removes only that entry, byte for byte otherwise; the current key and an unknown id are refused;
  after a forget a backup under that key throws `needs-key` from `unlockChoice` and opens with its typed passphrase and
  recovery key; a folder month under it is skipped as `other-key` and not rewritten; the upgrade record with no `since`
  lists and forgets; the swap case still settles if neither forgets; pure-component tests for the list, the notice and
  the zero-months wording; `@gallery` examples for the list.

**What part 3d built.**

- `Keyring.retired` entries carry `since?` (epoch ms). `adoptKeyring` stamps `Date.now()` on the key it retires and
  keeps the stamp of entries already retired; a 3c record has none and is listed as "retired earlier".
- `forgetRetiredKey(store, keyId)` (`backup-keyring.ts`) removes one entry with `replace`, drops the field when the
  list empties, and throws a plain `Error` for the current keyId, an unknown keyId, or no keyring (this module throws
  plain `Error`s for refused requests, as `create` does; `BackupError` is for file and secret failures).
- `keyringState` gained `retired?: { keyId, since? }[]` (absent when empty), so the list reaches the page, and the
  worker's `FolderReport.keyring`, without a `CryptoKey` leaving the module.
- The counts come from the PAGE: `LocalArchiveFolder.refresh` calls `monthKeyCounts(dir)` (`archive-folder.ts`) on the
  folder handle it already holds (`writableFolder`), which reads each encrypted month's header and first chunk
  (`readMonthHead`) and tallies `readHeader(...).keyId`. Only when a retired key is listed; unreadable files count for
  no key; a folder not connected here gives `null` and the list shows no counts. No worker op, no new privilege.
- `RetiredKeys` (`archive-section.tsx`) sits under the form choice: short id, date, months under it, "Forget", which
  opens `forgetNotice(n)` once (n = 0 reads as safe) and acts on "Forget this key". With the folder unreadable the
  notice says the months were not counted. The Settings page has no separate "key line" today, so the list goes
  under the form choice, which is where the key is chosen.
- Sync, rekey and sealing are unchanged: a month under a forgotten key is `other-key` (`tests/folder-sync.test.mjs`).

### 3e. Telling a planted key from the real one

Designed 2026-10-27, from the red-team review of 3c and its probe of 3d (`tmp/probe-3d-forgetkey-redteam.test.mjs` in
the red-team clone).

**The limit, stated once.** Whoever knows the secret the person types can seal a file under a key of their own, and
adoption takes it: the secret IS the authentication, and nothing in a file tells the other machine apart from a writer
who shares that secret. An `other-key` skip is DETECTION after the fact, not prevention. What 3e adds is out-of-band
evidence the person can check, and keeping the evidence Settings already shows honest.

**The count lies (red-team finding on 3d).** `monthKeyCounts` tallies the `keyId` in each header without opening the
file, and the count is what the Forget notice rests on. A folder writer needs no secret to steer it: headers that name
a key over payloads nothing opens inflate N (a key the person means to forget looks in use); relabelling real months
deflates it (the person forgets, the writer restores the headers, and those months open under no key here).

**What to build:**

- **Count by opening.** `monthKeyCounts(dir, ring)` counts a month under K only when `keyFor(ring, header.keyId)` is K
  and `opensFirstChunk(head, K)` holds, on the head and first chunk `readMonthHead` already returns (one AES-GCM per
  month). It returns `{ byKey, unopened }`: `unopened` counts encrypted month files that open under no key this install
  holds, whatever their header says. The header is the chunks' associated data, so a relabelled header opens under no
  key, and a deflated count shows up as `unopened` instead of vanishing. The Forget notice says, when `unopened > 0`:
  "N more files in the folder open under no key on this install; some may have been under this one." The page loads
  the keyring itself (`loadKeyring(idbKeyringStore())`), inside `archive-folder.ts`'s caller, so no `CryptoKey` reaches
  a component. Files under a key this install never had count as `unopened`, which is true and is what the `other-key`
  line already says.
- **Key ids a person can match.** One format for a key id on screen: the full 16 hex in groups of four
  (`9f3a 1c7e 2b40 d815`), from one helper beside `RetiredKeys`. Settings shows "This install's key" with it on the
  form choice whenever a keyring is set, and the retired list uses the same format. The adopt block names the key it
  is about to adopt, the `keyId` of the skipped months (`keyToAdopt`): "Key in these files: 9f3a 1c7e 2b40 d815. Check
  it matches the key shown in Settings on the other machine before you enter its secret."
- **The folder's pinned key.** The page keeps, beside the folder handle (`ml-archive-folder`, key `pin`), the `keyId`
  this install expects the folder's months under. It is set by a page action only: adopting from the folder (the
  adopted id), switching the form to encrypted (the current id), the rekey after a restore adopted a key (the new
  current id), and, once, on a refresh of a connected encrypted folder that has synced (`lastSync`) with NO skipped
  months (the current id: every month opened here, so the folder is under keys this install holds). Picking another
  folder (`saveFolder`) drops it. The worker never reads or writes it.
- **"This folder's key changed."** When a pin is set and the `other-key` skips name a key id that is not the pin, the
  skipped-months block leads with that, names both ids, and says: "If you did not change the key on your other machine,
  do not enter a secret here: someone who can write to this folder may have added these files." Adoption stays
  possible (a real change on the other machine looks the same), and updates the pin. No pin (a new machine joining,
  or an install from before 3e that has not yet had a clean sync) gives today's neutral offer, with the key id to
  match.
- **No change to sync, sealing, `adoptKeyring` or the worker ops.**
- **Tests:** the red-team probe committed (planted headers do not count; the control counts the real months); a
  relabelled real month counts as `unopened` and under no key; a month under a key the install never held counts as
  `unopened`; the Forget notice with and without `unopened`; the key id format; the adopt block shows the id; the pin
  is set by each of its four actions and dropped by `saveFolder`; the clean-sync pin is NOT set when any month is
  skipped; the changed-key wording appears only with a pin and a different id; THE UPGRADE: an install with no pin
  shows the neutral offer; `@gallery` examples for the changed-key block and the notice with `unopened`.

## The folder: merge before write (part A)

**The bug this fixes.** Picking a folder marked every month the archive held as dirty and wrote it, and writing a
month replaces the file of that name (`writeMonthFile`). A new install pointed at an old machine's folder therefore
overwrote every month the two had in common with the new machine's sessions alone, on the first sync after anything
was archived into that month, unless Import had been clicked first. Two machines sharing one synced folder did the
same to each other.

**The rule now:**

- **A sync merges a month file into the archive before rewriting it**: sessions the file has and the archive does not
  are imported first (`importFrom`), so a sync never drops what the folder held (`syncMonths`, folder-sync.ts). Where
  both have a session, the archive's copy wins.
- **A file that cannot be read as an archive is never overwritten**: its month is reported as skipped and stays
  pending. Part 3 relies on this: a machine without the key must not replace another's encrypted month.
- **The archive remembers what it removed on purpose** (`removed`: hash, month, when; main database only, created by
  `migrate`, so an archive from before it gains the table on open). A delete
  and an un-archive both write one; a merge and an Import skip those hashes, or every delete would come back from the
  folder's previous copy at the next sync. Archiving the session again clears its entry.
- **Picking a folder that already holds month files asks first**: import them (the default), or start fresh, which
  moves them into a subfolder (`earlier-<date>/`) rather than deleting anything.
- **Across machines a delete sticks (part 3b)**: the month file carries the `removed` entries of its month, and a merge
  applies them (see "What part 3b built"). Before 3b, machine B's file still had what A deleted and A's merge took it
  back unless A deleted it itself.

## Traps

- **A merge without the `removed` list undoes deletes.** Anything that imports from the folder skips those hashes.
- **Record stats only after a merge or a write that succeeded.** A recorded stat says "this file is merged"; one
  recorded on a skip hides the file for ever.
- **A month file's `removed` entries are part of the month.** A month with entries and no sessions still has a file;
  code that treats "no sessions" as "no file" deletes a delete before the other machine has read it.
- **A restore does not use `mergeFrom`.** It takes sessions only, under the hard `removed` rule; routing it through the
  merge would let a backup's entries delete sessions.
- **`writeMonthFile` replaces;** never call it for a month whose file was not merged in this sync.
- **An encrypted file's name is a hint.** Read the first bytes; a renamed `.sqlite` may be gzip or encrypted.
- **Open by `keyFor`, never by comparing `keyId` with the current key alone.** After an adoption the install's own
  months and backups are under a retired key; a comparison with `keyring.keyId` calls them `other-key` and, since the
  month is then skipped and never rewritten, leaves them unreadable to the install that wrote them.
- **The data key is never extractable after setup;** code that needs its raw bytes is code that should be unwrapping
  with the passphrase or the recovery key.
- **A restore imports the sessions it listed, from the file it digested.** Do not give `restoreSessions` back a re-read
  of the slot, and do not make `BackupContents.adding` the pin: it is capped for display, `hashes` is not.
- **A restore writes the preview and nothing else.** `applyRestore` reads `plan.changes` only; a new kind of restored
  key is a new `Change`, never a side write.
- **A new storage key is a decision.** The inventory test fails until it is classified; `never` is a fine answer, with
  the reason in one line.
- **Every reader goes through the budget.** `gunzip`, `readAnyForm` and `decryptFile` cap the output (`LIMITS`); a new
  reader that decompresses without `maxOutput`, or reads a header without `parseHeader`, is a gzip bomb or an Argon2 bomb.
