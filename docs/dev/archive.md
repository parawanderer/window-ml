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
| `archive-folder.ts` | The picked folder: its handle in IndexedDB (`ml-archive-folder`), its `FolderState`, picking and re-granting (a page, in a click), and reading and writing `YYYY-MM.sqlite`. chrome-free: the page and the worker both use it. |
| `sidebar/archive-section.tsx` | Settings → Archive folder. `ArchiveFolderBody` is pure (report + actions as props) so a remote runtime's view can render it; `LocalArchiveFolder` wires it to this browser. |

## Why it is built this way

- **SQLite, and in OPFS.** Queryable history (paging, FTS5), images stored once, a file any tool opens. Its fast file
  handles (`createSyncAccessHandle`) exist only on OPFS and only in a dedicated worker, so the live database cannot be
  in a folder a person picked (the probe: `hasSyncAccessHandle: false` there). `opfs-sahpool`, unlike `opfs`, needs no
  cross-origin isolation, which an extension page does not have.
- **A classic bundle finding its wasm.** Every bundle here is `iife`, with no `import.meta.url`; the worker passes
  `locateFile` (which the package's types omit), and `build.mjs` copies `sqlite3.wasm` beside `archive-worker.js`.
- **Images once.** A `data:image/*` string anywhere in an event is stored decoded in `images`, keyed by the SHA-256 of
  the data URL, and replaced by `wml-archive-img:<sha>`; `readArchived` puts it back. `image_refs` lets a remove free
  images nothing else uses.
- **A failed move KEEPS the session.** Deleting what someone asked to have archived is the one outcome that cannot be
  undone. It is logged as `sessions/archive-failed` and not retried for an hour (`ARCHIVE_RETRY_MS`).
- **Nothing starts SQLite unless the archive is on.** A delete, and the Storage report, ask the archive only then.

## The folder

- **One file per month, `YYYY-MM.sqlite`**, by the UTC month of a session's LAST activity. A standalone SQLite file:
  the same schema, only that month's sessions and the images they use.
- **Dirty months, not "the current month".** A write marks its month dirty, and the month it moved from; a remove
  marks its month. A sync rewrites exactly the dirty months, and removes the file of a month left empty. That is
  how a delete reaches a month that closed long ago.
- **Built in memory, never as a temporary file.** `exportMonth` attaches `:memory:`, copies the month in and
  serializes it (`sqlite3_js_db_export(db, "snap")`); `importBytes` deserializes a file into an attached `:memory:` and
  copies in what is new (`INSERT OR IGNORE`, sessions by hash, images by content hash). The file header is checked
  first: SQLite accepts any bytes into `deserialize` and fails only at the first read, leaving an attachment behind.
- **`createWritable` replaces a file on `close()`**, so something syncing the folder never reads a half-written file.
- **The worker writes; a page only picks and re-grants.** Both need a click. A sync runs 30 s after an archive write,
  on the six-hourly alarm, and from Settings. While the grant is `prompt`, nothing is written and the months stay
  dirty ("pending" in Settings).
- **Four states in Settings:** none (pick), connected (write now, import, change, stop), needs re-grant (reconnect,
  choose "Allow on every visit", which survives a restart), unsupported (Brave: the flag to copy). Inside the in-page
  overlay (a frame in someone's site) the browser refuses the picker and the prompt, so the section says to open
  Settings in the chat page instead.

## Coming next

`session.resume` of an archived session (the `history` column keeps what it needs; it moves back to the live store
first), and paged `sessions.list` / `sessions.search` with an `archived` marker on the row.

## Testing

`tests/archive-db.test.mjs` for the SQL (Node, in-memory). `tests/session-store.test.mjs` for the move-or-keep rule.
`tests/e2e/archive.spec.mjs` for the real chain: offscreen relay, worker, wasm, OPFS, and the folder (an OPFS
directory stands in for a picked one, since a native picker cannot be clicked from a test: a sync writes the month, a
delete removes it, an import restores it). `tests/archive-section.test.mjs` for each state's wording and actions.
