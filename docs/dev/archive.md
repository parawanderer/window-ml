# The session archive

Long-term storage for saved sessions, in SQLite. The live session store (`session-store.ts`, IndexedDB) keeps what is
recent; when retention or the storage budget would delete a session and `sessionArchive` is on, the session MOVES
here instead. Decided with Shane on 2026-09-19; the design and the probe behind it are in
`tmp/chat-page-archive-probe-result.md` and `tmp/chat-page-archive-review-answers.md`.

## The pieces

| File | Holds |
| --- | --- |
| `archive-db.ts` | The schema and every query: `migrate`, `prepareSession` + `writeSession`, `listArchived` (paged by `last_ts`, FTS5 search), `readArchived`, `removeArchived`, `archiveStats`. Pure over a sqlite-wasm `Database`, tested in Node against `:memory:` (`tests/archive-db.test.mjs`). |
| `archive-worker.ts` | A dedicated worker the offscreen document starts. Opens the one connection (`opfs-sahpool` VFS, `/archive.sqlite`), answers `{ id, op, args }` in order. |
| `offscreen.ts` | Relays `ARCHIVE_OP` messages to that worker, strips the id. |
| `sw-offscreen.ts` | The ONE offscreen document, shared with the Python sandbox; nothing closes it. |
| `sw-archive.ts` | `archiveCall(op, args)`: the worker side's messenger, with one retry when the document was torn down. |
| `session-store.ts` | The `archive` option on eviction: move, and only then forget. |
| `folder-sync.ts` | What a sync does over any folder of month files (`MonthFolder`): `syncMonths` merges every file of each dirty month (any form) in before writing it in the archive's `folder_form` and removing the other forms' files, `importMonths`, `adoptFolder` (a pick), `surveyFolder`, `setFolderForm`. chrome-free, tested in Node against a Map (`tests/folder-sync.test.mjs`). |
| `archive-folder.ts` | The picked folder: its handle in IndexedDB (`ml-archive-folder`), its `FolderState`, picking and re-granting (a page, in a click), and reading and writing month files (`YYYY-MM.wmlbak`, `.sqlite.gz`, `.sqlite`). chrome-free: the page and the worker both use it. |
| `sidebar/archive-section.tsx` | The archive folder, in Settings → Storage under "Archive sessions instead of deleting them" (shown only while that is on). `ArchiveFolderBody` is pure (report + actions as props) so a remote runtime's view can render it; `LocalArchiveFolder` wires it to this browser. |

## Why it is built this way

- **SQLite, and in OPFS.** Queryable history (paging, FTS5), images stored once, a file any tool opens. Its fast file
  handles (`createSyncAccessHandle`) exist only on OPFS and only in a dedicated worker, so the live database cannot be
  in a folder a person picked (the probe: `hasSyncAccessHandle: false` there). `opfs-sahpool`, unlike `opfs`, needs no
  cross-origin isolation, which an extension page does not have.
- **A classic bundle finding its wasm.** Every bundle here is `iife`, with no `import.meta.url`; the worker passes
  `locateFile` (which the package's types omit), and `build.mjs` copies `sqlite3.wasm` beside `archive-worker.js`.
- **Images once.** A `data:image/*` string anywhere in an event is stored decoded in `images`, keyed by the SHA-256 of
  the data URL, and replaced by `wml-archive-img:<sha>`; `readArchived` puts it back. `image_refs` lets a remove free
  images nothing else uses. A session compacted in the live store (chat-page.md, "Saved sessions") arrives with WebP
  images. The PNGs archived before that are re-encoded in place by a BACKFILL (`archiveImageCompactor`,
  sw-image-compact.ts; `pngBatch`/`replacePngs`, db.ts), batch by batch, each one transaction: the sha key is only an
  identity and is never re-checked, so every event pointing at an image reads the WebP; an import never overwrites an
  image the archive has, so an older month file cannot bring the PNG back; the months showing a replaced image are
  marked dirty, and a folder sync follows. A PNG the encoder keeps (not opaque, no smaller) goes in `image_kept`, which
  is created on first use and only in the archive, never in a month file. Only the events' images: the row's
  `history`, what a resume sends the model, stays as stored.
- **A failed move KEEPS the session.** Deleting what someone asked to have archived is the one outcome that cannot be
  undone. It is logged as `sessions/archive-failed` and not retried for an hour (`ARCHIVE_RETRY_MS`).
- **Nothing starts SQLite unless the archive is on.** A delete, and the Storage report, ask the archive only then.

## The folder

- **One file per month**, by the UTC month of a session's LAST activity: `YYYY-MM.wmlbak` (encrypted), `.sqlite.gz`
  (compressed) or `.sqlite` (plain), by `meta.folder_form` (absent reads as `plain`; `backup.md`, "The archive folder's
  form"). Decrypted and gunzipped, a standalone SQLite file: the same schema, only that month's sessions and the images
  they use, and that month's `removed` entries (below). A month may hold files of several forms mid-switch; a sync merges them all and leaves the chosen one.
- **Dirty months, not "the current month".** A write marks its month dirty, and the month it moved from; a remove
  marks its month. A sync rewrites exactly the dirty months, and removes the file of a month left with neither sessions
  nor `removed` entries. That is how a delete reaches a month that closed long ago.
- **A sync MERGES before it writes** (`folder-sync.ts`): every file of a month is imported first, so sessions they
  hold that the archive lacks are kept, and a picked folder is imported whole before the first write. What the archive
  removed on purpose (`removed`) is not brought back, or a delete would come back from the old copy; the file's own
  entries are applied too (`mergeFrom`), so a delete made on another machine removes the session here. A month with a file that
  is not readable (or is encrypted and this install lacks its key: skip reason `needs-key`, `other-key`, else
  `unreadable`) is never touched, none of its files; it stays pending. Why, and the rules: `backup.md`, "merge before
  write" and 3b.
- **A month file carries its month's `removed` entries** (hash, month, time; 180 days, then they expire), so a month
  whose sessions were all deleted keeps a file of entries only until they expire. `ARCHIVE_SCHEMA` is unchanged; an
  older reader ignores the table.
- **Built in memory, never as a temporary file.** `exportMonth` attaches `:memory:`, copies the month in and
  serializes it (`sqlite3_js_db_export(db, "snap")`); `importBytes` deserializes a file into an attached `:memory:` and
  copies in what is new (`INSERT OR IGNORE`, sessions by hash, images by content hash). The file header is checked
  first: SQLite accepts any bytes into `deserialize` and fails only at the first read, leaving an attachment behind.
- **`createWritable` replaces a file on `close()`**, so something syncing the folder never reads a half-written file.
- **The worker writes; a page only picks and re-grants.** Both need a click. A sync runs 30 s after an archive write,
  on the six-hourly alarm, and from Settings. While the grant is `prompt`, nothing is written and the months stay
  dirty ("pending" in Settings).
- **A picked folder that already holds month files is asked about** before anything is written: import them (the
  default), or start fresh, which moves them into `earlier-<date>/`. A pick with no one to ask (an attention card's
  fix) imports them.
- **Four states in Settings:** none (pick), connected (the form of the month files, write now, import, change,
  stop), needs re-grant (reconnect, choose "Allow on every visit", which survives a restart), unsupported (Brave: the
  flag to copy). Inside the in-page overlay (a frame in someone's site) the browser refuses the picker and the prompt,
  so the section says to open Settings in the chat page instead.

- **The state is on the contract**, as `capabilities.archive` (`ArchiveCapability`: `folder`, `pending`, `lastSync`),
  present only while `sessionArchive` is on. `sw-archive.ts` keeps the last `FolderReport` any operation returned and
  the session server re-sends the runtime's description when it changes, so a client never polls. It is read once at
  worker start, which is when a lapsed "Allow this time" grant first shows. `unsupported` is decided in the offscreen
  document: no worker can pick a folder, so the archive worker answers `none` and the document, a page, corrects it.
  A `needs-grant` is fixed only by a click in that runtime's own Settings, so a remote client can say so and no more.

## Reaching archived sessions

- **`sessions.list` / `sessions.search`** merge the live index and the archive by `lastTs`, asking each for a page
  past `before`; a session in both is shown once, as its live row. The archive's search is FTS5 over every event's
  text, quoted into a phrase; a live session is matched by title, task and page title (its events have no index).
- **Opening one un-archives it** (`session.unarchive`, and `session.resume` does it first on its own): the session
  goes back into the live store WHOLE (`restoreSession`: row, events, history) and only then leaves the archive, so
  a failure between the two leaves it in both, never in neither. The store measures it from the moment it came back,
  or the next sweep would archive it again. The index restores its row, which every client hears as an `upsert`.
  There is deliberately no read-only path over the archive: one place a session lives means every command works on
  it unchanged.

## Testing

`tests/archive-db.test.mjs` for the SQL (Node, in-memory). `tests/session-store.test.mjs` for the move-or-keep rule.
`tests/e2e/archive.spec.mjs` for the real chain: offscreen relay, worker, wasm, OPFS, and the folder (an OPFS
directory stands in for a picked one, since a native picker cannot be clicked from a test: a sync writes the month, a
delete removes it, an import restores it). `tests/archive-section.test.mjs` for each state's wording and actions.
