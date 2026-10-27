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
| 3c. Two machines on one encrypted folder: adopting the folder's key | designed |

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

**Not built.** Adopting another install's data key on restore; rotating the recovery key; the archive folder's
encryption switch (part 3).

## The archive folder's form (part 3)

Designed 2026-10-27. 3a is built, worker and screen (`folderForm` op, `folder-sync.ts`, the archive section); so is 3b; 3c
is not. Three PRs, in this order, because each needs the one before.

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
  the error. Using another install's key is part 3c.
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
- **A plain `sync` merges only the dirty months.** A delete made on A reaches B when B's month is dirty, on B's resync
  (`adoptFolder`) or on an Import; nothing makes B look at a month it has not touched.

### 3c. Two machines on one encrypted folder

- **Each install makes its own data key at set-up**, so machine B cannot open machine A's months, and skips them
  (`other-key`) rather than overwriting them: safe, but neither sees the other's sessions.
- **"Use this folder's key"**: Settings asks for A's passphrase or recovery key, unwraps the data key from a month
  file's header (`unlock`), and makes it this install's keyring, with A's wraps. B's own earlier backups still open with
  B's old passphrase or recovery key, typed; Settings says so before it replaces anything.
- **This is the same step as "adopting another install's data key on restore"**, so a restore offers it too.

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
- **A month file's `removed` entries are part of the month.** A month with entries and no sessions still has a file;
  code that treats "no sessions" as "no file" deletes a delete before the other machine has read it.
- **A restore does not use `mergeFrom`.** It takes sessions only, under the hard `removed` rule; routing it through the
  merge would let a backup's entries delete sessions.
- **`writeMonthFile` replaces;** never call it for a month whose file was not merged in this sync.
- **An encrypted file's name is a hint.** Read the first bytes; a renamed `.sqlite` may be gzip or encrypted.
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
