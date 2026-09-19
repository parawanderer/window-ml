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

## Coming next

The picked folder with monthly snapshot files (only the current month rewritten; `createWritable` replaces a file on
`close()`), its four permission states in Settings (none / connected / needs re-grant / unsupported, with the Brave
flag hint), import from a folder into a fresh profile, a delete rewriting that month's snapshot, `session.resume` of
an archived session (the `history` column keeps what it needs), and paged `sessions.list` / `sessions.search` with an
`archived` marker on the row.

## Testing

`tests/archive-db.test.mjs` for the SQL (Node, in-memory). `tests/session-store.test.mjs` for the move-or-keep rule.
`tests/e2e/archive.spec.mjs` for the real chain: offscreen relay, worker, wasm, OPFS.
