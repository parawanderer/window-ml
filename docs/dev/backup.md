# Backup, restore and the archive folder

How this browser's sessions and settings get OUT of the browser profile and back IN: the archive folder (a live
mirror) and the backup file (a one-off snapshot). One file format serves both. Agreed with Shane on 2026-10-23; built
in four PRs, and each section below says which parts exist yet.

| Part | Status |
| --- | --- |
| A. The folder merges before it writes; a picked folder with old files is asked about | built |
| 1. The file format: compression, encryption, keys; `docs/spec/BACKUP_FORMAT.md`; a standalone decryptor | built |
| 2a. Backup and restore without screens: the key inventory, collect and preview and apply of settings, the file writer, the keyring at rest, the worker ops | built |
| 2b. The screens: Settings → Extension, the DevTools panel, the popup button, the recovery screen | planned |
| 3. The encrypted archive folder, its upgrade from plaintext month files, tombstones across machines | planned |

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
  setting). The popup's button opens the chat page at `#/settings/extension`: a popup closes the moment a file chooser
  takes focus, and an export of a large archive outlives a popup's attention anyway.
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

**Not built in 2a.** The screens (including the recovery screen and its type-back check, the encryption switch, the
export dialog, "Decrypt a file"); the service-worker binding that hands `createBackup` the real session store and
storage and the message handlers behind the screens; adopting another install's data key on restore; rotating the
recovery key; a browser (e2e) run of the new worker ops and of the origin-private file transfer, which only a real
Chromium can exercise (Node tests drive the same functions through a fake worker).

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
- **Across machines a delete does not stick yet**: machine B's file still has what A deleted, and A's merge takes it
  back unless A deleted it itself. Writing the `removed` entries INTO the month files, so they travel, is part 3,
  which changes the folder's format anyway.

## Traps

- **A merge without the `removed` list undoes deletes.** Anything that imports from the folder skips those hashes.
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
