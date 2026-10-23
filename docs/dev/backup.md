# Backup, restore and the archive folder

How this browser's sessions and settings get OUT of the browser profile and back IN: the archive folder (a live
mirror) and the backup file (a one-off snapshot). One file format serves both. Agreed with Shane on 2026-10-23; built
in four PRs, and each section below says which parts exist yet.

| Part | Status |
| --- | --- |
| A. The folder merges before it writes; a picked folder with old files is asked about | in progress |
| 1. The file format: compression, encryption, keys; `docs/spec/BACKUP_FORMAT.md`; a standalone decryptor | built |
| 2. Backup and restore of settings and sessions, in Settings and from the popup | planned |
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
- **Open question for part 2:** a chat's `ml_session_<hash>` record (what `ml.resumeChat` reads) is not in the archive
  schema today; check whether an un-archived chat stays resumable before calling chats restored.

## The folder: merge before write (part A)

**The bug this fixes.** Picking a folder marked every month the archive held as dirty and wrote it, and writing a
month replaces the file of that name (`writeMonthFile`). A new install pointed at an old machine's folder therefore
overwrote every month the two had in common with the new machine's sessions alone, on the first sync after anything
was archived into that month, unless Import had been clicked first. Two machines sharing one synced folder did the
same to each other.

**The rule now:**

- **A sync merges a month file into the archive before rewriting it**: sessions the file has and the archive does not
  are imported first (`importFrom`), so a sync never drops what the folder held.
- **The archive remembers what it removed on purpose** (`removed`: hash, month, when; main database only). A delete
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
