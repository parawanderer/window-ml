# Spec: a session's history is stored whole and read by range

**Status: spec, measured; nothing below is built.** Written 2026-11-17 by the session-store lane, at the REPL
coordinator's brief. Measured against main d3394f0d. The figures marked "measured" were run in this lane against the
real `SessionStore` (scripts below); the code paths are cited by file and line. Compaction POLICY is out of scope: what
the model is sent, and when that changes, is Shane's to decide through the coordinator.

## Why

A Claude Code session's history passed 2 GB and had to be cut. Shane's ruling (2026-11-17): **a session's history is
always written to the store; only a recent window is loaded; older history is read explicitly by range, by the model
too; nothing loads a whole session into memory.** The model managing its own compaction remains the goal, and
compaction changes what the model is SENT, never what is stored.

## 1. What happens today

### The stored form

Two IndexedDB object stores in `ml-saved-sessions`, version 1 (`session-store.ts:31-33`, `:520-528`):

- `events`, keyed `[hash, seq]`. **Events are already append-only**: a flush puts only the new events
  (`session-store.ts:534-541`). A session is NOT one record rewritten whole, as far as its events go.
- `sessions`, one row per session (`StoredSessionRow`, `:51-75`). The row carries `history` (`:64`): the model's whole
  message array plus the `StartRunPayload` (system prompt, tool descriptors, rebuild config). **The row is rewritten
  on every flush** (`tx.objectStore(SESSIONS).put(row)`, `:537`), so the whole history is rewritten each time any event
  is written.

The history is rewritten more often than the events. `checkpoint` calls `saveRunHistory` after EVERY completed step
(`sw-run-host.ts:2061-2066`; `agent-host.ts:284-289`) and again at turn end (`sw-run-host.ts:2134`), each with the
loop's whole `messages` array; `putHistory` overwrites (`session-store.ts:312-318`) and asks for an immediate flush
(`:317`). The same step also writes the whole array to `chrome.storage.local` as the resume snapshot (`persistRun`,
`sw-runs.ts:250-254`, called at `sw-run-host.ts:2062`). A chat writes its whole `StoredSession` to
`ml_session_<hash>` on each save (`sw-sessions.ts:933-937`).

**Measured: the row writes are quadratic in the session's length.** A run of N steps, each adding one tool result of R
bytes, with today's per-step checkpoint (`amp.mts` below, a counting backend under the real `SessionStore`):

| N steps | R | history at the end | row bytes written | ratio |
| --- | --- | --- | --- | --- |
| 50 | 4 KiB | 0.22 MB | 6.1 MB | 28× |
| 200 | 4 KiB | 0.84 MB | 87 MB | 103× |
| 800 | 4 KiB | 3.3 MB | 1.35 GB | 403× |
| 200 | 64 KiB | 13 MB | 1.32 GB | 101× |

The ratio is about N/2. The `chrome.storage.local` snapshot doubles it. The events are written once (`eventBytes`
equals the history to within a percent).

**The budget does not count the history.** `row.bytes` adds the events' size only (`session-store.ts:416-417`), so the
256 MiB `STORE_BUDGET_BYTES` (`:20`) bounds events and leaves every history uncounted.

### What each reader loads

| Reader | What it loads | Where |
| --- | --- | --- |
| Worker start (`SessionStore.open`) | **every row of every saved session, histories included**, held for the worker's life | `session-store.ts:206-212` (`getAll`, `:530-533`); the map, `:158` |
| Resume (`session.resume`, `RESUME_RUN`) | the whole history, from that in-memory row; no events | `session-commands.ts:482` → `sw-sessions.ts:421` → `session-store.ts:351-354`; held in `bgRuns`, `sw-sessions.ts:441-446` |
| `forModelHistory` | scrubs the whole resumed array once, in place, before the first model call | `sw-scrub.ts:64-75`, called at `sw-run-host.ts:1157` |
| `ml.resumeChat` | the whole `ml_session_<hash>` record | `background.ts:1437-1442`; `sw-chat.ts:414-433` |
| Sidebar, DevTools, side panel | never the store: a per-tab ring of 500 events, sent as one replay | `sw-debug.ts:16`, `:87`; overlay `REPLAY_CAP` 400, `sw-runs.ts:427` |
| Chat page, opening a saved session | **every event** (`getAll` over the key range), posted as one message per event, `from: 0`, so nothing is left to page | `session-server.ts:150-167` → `sw-sessions.ts:615` → `session-store.ts:357-361` |
| `session.backfill` (phone, hub, a trimmed ring) | 40 events per page, but **reads the whole session from IndexedDB for every page**: a full pull is quadratic | `session-commands.ts:229`, `:342`, `:357` |
| Markdown and JSON export | the client's in-memory `Session`, after `pullAllHistory` pulled every page; one string (`join`, `JSON.stringify`) and one Blob | `export.ts:795-833`; `export-tasks.ts:109`; `pull-history.ts:44-73`; `export-json.ts:386-388` |
| PDF export | one HTML string with images inline, in one `PRINT_SESSION` runtime message, held 60 s in the worker | `export.ts:726`; `background.ts:259-264`, `:437-450` |
| Backup | per session, all events and the history in one `backupPut` message; then the whole build exported as one `Uint8Array`, gzipped whole, encrypted in 1 MiB chunks into one buffer | `backup-run.ts:50-66`; `backup-file.ts:74`; `backup-format.ts:167-169`, `:445-459` |
| Restore | the whole file, decompressed whole | `archive-worker.ts:153-162`, `:194`; `backup-format.ts:571` |
| Archive move | `read(hash)` (all events) plus the history in ONE `ARCHIVE_OP` runtime message | `session-store.ts:253`; `sw-sessions.ts:582-584`; `sw-archive.ts:12` |
| Unarchive | every event `JSON.parse`d, images back to data URLs, one message back, then one IndexedDB write | `db.ts:332-345`; `sw-sessions.ts:885-899`; `session-store.ts:340-348` |
| Image compaction | every event from `compacted` onward; each chunk's commit re-puts the row WITH its history | `session-store.ts:460`, `:490` |
| Phone sync, live | one sealed frame per event, 1 MiB cap per frame | `session-publisher.ts:88-95`; `seal.ts:17-18` |
| Phone cache | 1.5 MB, oldest events trimmed | `event-cache.ts:33` |

The in-memory index (`session-index.ts`) is already bounded: 500 events and 16 MiB per session, 64 MiB in all
(`:153-155`), and a restored saved session is seeded with no events (`:486-501`). It is not the problem.

## 2. The bounds, and what a person sees at each

| Bound | Figure | Source | What a person sees when it is crossed today |
| --- | --- | --- | --- |
| The service worker's JS heap | measured lower bounds, no limit found: the worker held 96 million small JS objects (V8 heap, near the 4.09 GiB `jsHeapSizeLimit` an extension page reports), 6 GiB of external strings and 6 GiB of ArrayBuffers, each without dying; one death in the objects case was not reproduced. The worker has no `performance.memory` | `notebooks/session-store/chrome-bounds.ipynb`, section 1 (Chromium 151) | a death takes the whole extension process, its pages included. Not the first bound a session meets: the 64 MiB message and the 512 Mi string bind long before |
| One runtime message (`sendMessage`, `Port.postMessage`) | 64 MiB, JSON-serialized; measured: a 64 MiB string passes (129 ms by `sendMessage`, 123 ms by a `Port`), 65 MiB is refused at the sender, on both | Chromium `extensions/renderer/api/messaging/messaging_util.cc`; `notebooks/session-store/chrome-bounds.ipynb`, section 4 | "Message exceeded maximum allowed size of 64MiB." An archive move of a larger session fails, the session is KEPT (`session-store.ts:255-258`), the move is retried hourly (`ARCHIVE_RETRY_MS`, `:28`), and the housekeeping log records `archive-failed` each time. A PDF export of a larger session fails the same way |
| One IndexedDB value | no cap found up to 256 MiB as one string and 512 MiB as an object of strings, each put and read back: the 128 MiB IPC limit (`kIDBMaxMessageSize`) does not bind a put, since a value above 64 KiB is wrapped as a Blob | `notebooks/session-store/chrome-bounds.ipynb`, section 3 | a 512 MiB string cannot be made at all (`RangeError: Invalid string length`), so a whole-session JSON is refused before IndexedDB sees it |
| The IndexedDB and OPFS quota | measured: 10 GiB without `unlimitedStorage`; with it, the disk's free space (672.1 GiB of 926.3 here). window.ml declares it (`manifest.json:6`), so the disk, not the browser, is the bound | `notebooks/session-store/chrome-bounds.ipynb`, section 2 | a write fails with `QuotaExceededError`, and NOTHING says so: the worker builds its store with no `onError` (`sw-sessions.ts:565`), so `flush`'s catch (`session-store.ts:374`) drops it. The run continues; that flush's events are not on disk |
| One JS string (`JSON.stringify`, `join`) | 2^29 − 24 code units, about 512 Mi | measured in Node 26 (`buffer.constants.MAX_STRING_LENGTH` = 536,870,888; one more threw `RangeError: Invalid string length`), and checked in Chromium 151, where a 512 MiB string throws the same `RangeError` (`notebooks/session-store/chrome-bounds.ipynb`, section 3) | the Markdown or JSON export of a larger session throws, and no file is saved |
| A backup's restore | 1 GiB decompressed (`LIMITS.outputBytes`, `backup-format.ts:82`) | code | **a compressed or encrypted backup bigger than 1 GiB is written without complaint and refused on restore**: the person finds out on the day they need it |
| One hub frame | 1 MiB (`seal.ts:17-18`) | code | not determined: no publish-side check of an event above it was found |
| One protected session larger than the budget | measured (`protect.mts` below) | `planEviction`, `session-store.ts:107-126` | **every unprotected, unpinned session is dropped.** One running session of 300 MB against the 256 MiB budget evicted all 40 others; only a pinned one survived. With the archive on, each is moved, or each fails and is retried hourly if it is over 64 MiB |

## 3. The stored form

**One rule: a write adds what is new; a read names a range.** The history becomes records like the events already are,
and the row becomes small.

`ml-saved-sessions` version 2:

- `sessions`: the row, WITHOUT `history`. It gains `historyCount`, `historyBytes` (counted toward the budget from now
  on), `runMeta` (a fingerprint of the payload below) and `form: 2`. A row is then a few hundred bytes, so
  `open()` loading every row costs the list, not the histories.
- `events`: unchanged, `[hash, seq]`. Reads become ranged: `getAll(IDBKeyRange.bound([hash, a], [hash, b - 1]))`, or
  a cursor that stops at a byte budget.
- `history`, NEW, `[hash, pos]` → one `NeutralMessage`. Append-only in the ordinary case. A message the loop REPLACED
  (the in-place scrub of a resumed history, `sw-scrub.ts:71`) is a put at its own position, so a write costs what
  changed and never the array.
- `runmeta`, NEW, `[hash]` → `{ payload, sub }`. Written when its fingerprint changes (a new turn's `stepBase`), not per
  step.
- `marks`, NEW, `[hash, seq]` → `{ pos, ts, turn, bytesBefore }`, one per turn start. This is the index a range is
  named against: "turn 12", "since yesterday 14:00", "the 2 MB before the end" each resolve to an `events` key range
  and a `history` position range without reading either.
- `views`, NEW, `[hash]` → **what the next request is built from**: a list of `history` position ranges, later
  interleaved with the stubs a compaction writes. With no compaction it is `[[0, historyCount)]`. This is where
  compaction meets storage: compaction writes a new view and never touches `history`.

**The writer.** `putHistory(hash, messages)` keeps, per live session, the message objects it last wrote (references
only; the loop already holds the objects). At a checkpoint it compares by identity: positions past the last write
are appended; a position whose object changed is put again; nothing else is written.

**RULE: a message object is never mutated after it enters `messages`; a change replaces it.** Identity comparison is
correct only under this rule, and the code today follows it: the resume scrub replaces (`messages[i] = { ...m, content
}`, `sw-scrub.ts:71`), and the archive and move notes are pushed as new objects (`sw-run-host.ts:1162-1165`). The
test that enforces it: in the test build, at each checkpoint, the writer also keeps a content hash of every position
it has written and recomputes it for each position whose identity is unchanged; a hash that differs under an
unchanged identity fails the test, naming the position. Image compaction (`session-store.ts:445-497`) is outside this
rule's reach: it rewrites EVENTS, never `history` (`:445-447`), and copy-on-write: `replaceImages` returns new objects
along a changed path and the originals untouched (`image-compact.ts:39-56`).

The `chrome.storage.local` resume snapshot (`persistRun`) stops carrying `messages` and names the store instead:
`{ hash, historyCount }`.

**A run that is not saved** (`ephemeral`) still gets its history written, under its run id, so an evicted worker can
still resume it. Those records:

- are deleted when the run settles, as the snapshot is today;
- are swept at worker start: a run-id history with no live run and no resumable snapshot (`bgRunResumable`) is a crash
  between write and settle, and is deleted, with one housekeeping record;
- are in no backup, archive or export, and count toward no session list and no budget row.

**A failed write is recorded and shown.** The store gets an `onError` (today the worker builds it with none,
`sw-sessions.ts:565`, §2): a failed flush is recorded in the housekeeping log (subsystem `sessions`, kind
`write-failed`, the session's hash and how many events and history positions were not written) and shown on the
session as one line saying what was not saved. The run continues. This is the same slice as the row change.

**Eviction (ruled by the coordinator, 2026-11-17).** A protected session's excess is not paid for by the others:
`planEviction` evicts down to `budget + protectedBytes`, where `protectedBytes` is what the protected sessions hold
above the budget, and records that in the housekeeping log. A running session is never evicted for its own size.

**State.** The four new stores, the migration pass's progress, the scrub cache of §4 and §6b, and §5's OPFS build
file are each declared with `defineState` beside their store from the first commit, each with its row in
`docs/dev/state.md`. The migration pass writes one housekeeping record per session moved and one per failure.

**What is loaded.** Resume reads the VIEW's ranges. With no compaction the view is the whole history, so **this does
not yet bound resume**: Shane's ruling (only a recent window is loaded) is met for every other reader, and for resume
only once a compaction policy writes a smaller view ("Open", below). Everything else (transcript, export, the model's
reads of older history) takes a range.

**Cost after the change** (measured by slice 2 with the same script, counting the history positions and `runmeta`
each write puts): the 800-step case writes 3.34 MB of history for a 3.34 MB history (1.0x, was 1.35 GB), 8 KB of
`runmeta` once, and 0.27 MB of rows; 200 steps, 0.84 MB for 0.84 MB.

**The upgrade.** Old state meets the new code on someone's machine, and that is what gets tested:

1. `onupgradeneeded` from 1 to 2 creates the four new stores and touches no existing record.
2. After open, a background pass walks `sessions` with a CURSOR, one row at a time, never `getAll`. A row with
   `history` and no `form` is split in one transaction per session: its messages to `history`, the payload to
   `runmeta`, a whole-range `views` record, `marks` rebuilt from its `agent-turn` events by a ranged cursor, then the
   row rewritten without `history`. Peak memory is one session's history, which today is held for every session at
   once.
3. Until a row is migrated, a reader that finds `history` on the row uses it. Resume, export and the model's ranged
   read all work on an unmigrated row.
4. A worker stopped mid-pass leaves whole sessions in one form or the other, never half, because each session is one
   transaction. The next start resumes the pass.
5. An older extension reading a version-2 database: IndexedDB refuses to open a lower version, so a downgrade shows
   the list as empty. This is acceptable if the release notes say so; the alternative, keeping `history` on the row
   too, keeps today's cost.
6. `ml_session_<hash>` (a page's `{ save: true }` chat, read by `ml.resumeChat`) stays as it is in this spec: the
   PAGE sends the whole chat on each save (`ml-chat.ts:157-164`), so the page already holds it, and its size is the
   page's. The saved session's own copy moves to the new form like any other.

The upgrade test is a fixture written by today's code (a version-1 database with a row carrying `history`, from
`indexedDbBackend` over `fake-indexeddb`, as `tests/background-sessions.test.js` already uses it), opened by the new code, asserting: the list is unchanged;
`session.resume` sends the model the same messages; the row in memory has no `history`; a worker stopped after the
first session's transaction resumes at the second.

## 4. The model reads its own older history

**A ranged read is a tool result like any other**: the same size cap, the same `@tool:` pointer when it is long, the
same scrub.

- **Through `dereference`.** History positions get a pointer form, `@history:<from>-<to>` for messages and
  `@history:turn/<n>` for a turn, resolved by the worker from the `history` and `marks` stores. `dereference` already
  pages, slices and pipes (`docs/dev/pointers.md`), so a long range is read the way a long tool output is. Ranges are
  over `history` positions (model messages), never event `seq`. A range of another session is refused (§6b says when
  that could change).
- **Who may read.** `@history:` resolves only inside the run that owns the session, checked on the worker's run record,
  never on anything in the pointer text. A page-started run gets no `ml.current.history`, and `@history:` is refused
  there.
- **What `ml.current` shows.** `ml.current` is resolved up front and synchronous (`docs/spec/CURRENT_CONTEXT.md`, "It
  is all RESOLVED UP FRONT"), so it cannot read storage. It gains metadata only: `ml.current.history = { count, bytes,
  sent: [[from, to], ...], turns: [{ pos, ts }, ...] }`, read from the row and `marks`, which are small. A model sees
  that positions 0 to 340 exist, that only 280 to 340 were sent, and reads 0 to 40 with `dereference`. `messages`
  stays "the wire": the sent set, as today.
- **The scrub.** `scrubSecrets` takes one whole string (`src/secret-scrub.ts:115-122`) and has no state across calls,
  so a secret split across a range boundary would pass. The rule: **scrub the unit, then slice; never scrub a slice.**
  A range is made of whole messages; each is scrubbed whole (as `forModelHistory` does) before the range is cut to its
  cap. A message is bounded by what the model saw when it was written, so scrubbing it whole is bounded too. (The
  brief cites a section "The scrub as built" in SECRET_HANDLES.md; there is none. Its scrub section is "Scrubbing is
  by VALUE, in the harness", which ends "Not built". The built scrub is `src/secret-scrub.ts` and `sw-scrub.ts`.)
- **The scrub cache.** Scrubbed chunks, where they are cached (§6b.2), are cached under a fingerprint of the secrets.
  The cache and the fingerprint follow the secret registry's rule: in no backup, export or archive file, deleted with
  the session, and the fingerprint is a KEYED value (an HMAC under a per-install key), never a bare hash of the
  registry, which would let anyone holding the cache test a guessed secret against it.
- **Images.** A range returns an image as its existing `@tool:`/image reference, never as an inline data URL, so
  reading old screenshots costs what the model asks for.

`@history:` is a new pointer form the model reads, so it gets the red-team pass AGENTS.md requires (a hostile page
must not reach a run's history through it, or another session's), the tool registry entry if it is a tool, and a
prompt review.

## 5. What streams instead of loading

Each of these keeps a bound per step: one batch of events, a few MiB at most, never the session.

- **The chat page and `session.backfill`.** Opening a saved session sends the newest window (the last turn, or 2 MiB,
  whichever is larger) with `from > 0`. The client's existing `loadEarlier` pages the rest (`chat-store.ts`, ~290-340).
  `session.backfill` reads its 40 events by key range instead of reading the whole session to slice it.
- **Export.** Read from the worker in pages, never from `sessionMap` after `pullAllHistory`. Markdown and the zip are
  written through a `WritableStream`: the File System Access save picker where the page has it, else an OPFS
  temporary file handed to `downloads`. JSON is written by a streaming writer that emits the same document,
  `export.schema.json` unchanged, event by event. PDF goes through printing, which needs one document in memory: it
  refuses above a stated size and offers Markdown.
- **Backup.** `backupPut` sends a session in batches (`begin`, `events` × k, `commit`) inside one archive-worker
  transaction. The build is written into an OPFS database file instead of an in-memory one seeded with a copy of the
  archive (`archive-worker.ts:129-133`). Gzip and encryption become a `TransformStream` over that file into the backup
  slot; `sealGzip` already chunks at 1 MiB (`backup-format.ts:445-459`). Restore runs the same stream backwards into
  an OPFS file and opens it, so the 1 GiB whole-buffer cap becomes a per-chunk check plus the total the header
  declares, and a backup that was written can always be restored.
- **Archive.** The move is the same batched `begin`/`events`/`commit`, so no message nears 64 MiB and a large session
  stops being stuck in the live store. The archive's `events` table is already keyed `(hash, pos)` (`db.ts:97-100`),
  so a ranged read of an archived session is one `SELECT … WHERE hash = ? AND pos BETWEEN ? AND ?`. Unarchiving
  to RESUME restores the row, the view's ranges and the newest window; the rest is read in place from the archive by
  range. The archive's `history` column (one TEXT, `db.ts:94`) becomes a `history` table keyed `(hash, pos)`, with
  the same cursor-and-transaction upgrade as §3.
- **Phone sync.** Live frames are already one per event. Two gaps: an event above the 1 MiB frame cap (a screenshot
  step) needs a rule, sending its image by reference and fetching it on demand, which is the hub lane's; and the
  backfill above.

## 6. Two questions from Shane

### a. The memory of `/files/` (FILE_ATTACHMENTS.md, "A session's files as a directory")

**A proposal.** It takes effect only through an amendment to FILE_ATTACHMENTS.md, a separate spec PR after this one
(accepted as a proposal by the coordinator, 2026-11-17); building it is assigned later.

**Measured in that spec, not built** (`FILE_ATTACHMENTS.md:552-555`). The ruled mount is EAGER: at interpreter start
every file's whole bytes are posted to the worker and held as ArrayBuffers, "one times the directory's size" (`:601`).
A cell then reads into the wasm heap, which grows and never shrinks; the measured worst case is three times a file's
size (a 50 MB file: 154 MB of buffers, wasm memory at 75 MB, `:637-638`). The worker dies at a 2.6 GB JS heap
(`:638`; `docs/dev/python-sandbox.md:291`). The quota is still an open question (`:1442-1444`), and it applies only to
files a run made, not to the person's attachments (`:661-663`). So today's text bounds a session's `/files/` at about
800 MB of directory before a cell that reads it all kills the worker, and nothing enforces even that.

**What a lazy, ranged mount takes.** The spec rejected one in two lines (`:603-613`): a lazy mount needs a synchronous
channel, and "`Atomics.wait` would block the interrupt buffer so Stop would fall through to the kill". The async lane's
own measurement two sections later answers that objection for host mounts (`:776-806`, Route A, 2026-11-13): a sliced
wait over a SharedArrayBuffer stops 300 times out of 300, also under `lockdownReadonly`, costs 0.26 ms per request
end to end, and reads 103 MB/s in 512 KiB chunks, with a chunked read working to 4 GiB.

**Recommendation: build `/files/` on Route A's file system type, with the offscreen document as its server, reading
the shelf by range** (`Blob.slice(a, b).arrayBuffer()` over the value store's blobs, `src/pointers/value-store.ts:236-242`,
reads a range without loading the blob). Nothing is held until a file is read, and a read holds its range. Keep the
eager MEMFS only below a small directory size, to be measured, where it is simpler and as cheap. Writes stay as ruled
(MEMFS nodes, posted on close). A `python_install` candidate worker never gets the `/files/` mount (the packages
lane's constraint): the worker that tries an install sees no session's files. This is the files-host lane's ground: the recommendation goes to it through the
coordinator, and this spec builds nothing there.

### b. Archived history through that file system?

**The coordinator's position holds as a VIEW and fails as the only path.** Yes to a read-only lazy mount over the
store, `/history/` beside `/files/`, served by the same ranged reader as §4. It breaks, or needs a rule, in six
places:

1. **Not every run has file tools.** The read-only `exec` dialect, the path that runs with no prompt, has no file API;
   files exist only in `python_exec` and `ml.sh`, and `full` Python always asks. So `/history/` cannot replace §4's
   `dereference` path; it is a second front end over one reader.
2. **Byte offsets against a whole-string scrub.** A file promises an exact `st_size` and stable offsets. The model must
   see the scrubbed text, and a scrub changes lengths, so the file's size is only known after scrubbing every
   message: a `stat` becomes a whole-session scan. The rule that works: the view is JSONL of SCRUBBED messages,
   built per chunk and cached under the secrets' fingerprint, with a chunk index of scrubbed lengths. When the
   secrets change, the cache is rebuilt by a streaming pass, and a read of a stale chunk waits for it. Scrubbing
   happens on the server side of the channel, so unscrubbed text never enters the wasm heap.
3. **The shared `full` worker.** `/files/` is one directory per session inside a worker that can host several runs
   (`FILE_ATTACHMENTS.md:621-624`). A mount of another session's history must exist only in a run-principal realm
   (`run:<id>`, `docs/dev/python-sandbox.md:190-192`), never in `full`, the bench or a page's realm, or one run reads
   what another was consented.
4. **Images.** Events carry screenshots as data URLs. In a file view they are separate files
   (`/history/<session>/images/<sha>.webp`), referenced from the JSONL, never base64 inline.
5. **The shell.** A `/history/` the host could see would need the host to serve a mount backed by the extension. That
   is the files-host lane's, and out of reach until host mounts exist. Python only, at first.
6. **Consent.** The mount and §4's pointer share one rule: the current session by default; another session's history
   only by the person's consent in the sidebar, per session; never for a page-started run (no `ml.current`, and a
   page-started turn may not carry a history, `docs/dev/site-access.md:387-389`); every read through the scrub.
   Today no tool or `ml.*` member reads another session at all (the dialect's `ml` surface, `src/readonly-exec/policy.ts:506`),
   so this is a new capability with its own red-team pass, not a widening of an old one.

No to the file system as the STORAGE: IndexedDB and the archive's SQLite stay the store, and the mount is computed
from them.

## Scripts

`amp.mts` measured the write amplification; `protect.mts` measured eviction with a protected session over budget.
Both run with `npx tsx <file>` from a clone and import `src/session/session-store.ts`.

```ts
// amp.mts — write amplification of the per-step history checkpoint. Args: N steps, R bytes per tool result.
import { SessionStore } from "./src/session/session-store.ts";
const N = Number(process.argv[2] ?? 200), R = Number(process.argv[3] ?? 4096);
let rowBytes = 0, eventBytes = 0;
const backend = {
  async rows() { return []; },
  async append(row: any, _from: number, events: any[]) { rowBytes += JSON.stringify(row).length; for (const e of events) eventBytes += JSON.stringify(e).length; },
  async events() { return []; }, async remove() {},
};
const store = new SessionStore(backend as any, { budgetBytes: Infinity, maxSessions: Infinity });
const summary: any = { id: { runtime: "r", hash: "h1" }, saved: true, status: "running", createdTs: 1, lastTs: 1 };
const messages: any[] = [{ role: "system", content: "s".repeat(8000) }, { role: "user", content: "task" }];
const payload: any = { systemPrompt: "s".repeat(8000), tools: [] };
store.put(summary, { kind: "agent", ts: 1 } as any); await store.flush();
for (let i = 0; i < N; i++) {
  const out = "x".repeat(R);
  messages.push({ role: "assistant", content: "call " + i }, { role: "tool", content: out });
  store.put(summary, { kind: "agent-step", ts: 2 + i, step: i, result: out } as any);
  store.putHistory("h1", { kind: "agent", messages: [...messages], payload });
  await store.flush();
}
console.log({ N, R, eventBytes, rowBytes, history: JSON.stringify(messages).length });
```

```ts
// protect.mts — one running session over the budget, forty small ones, one pinned.
import { planEviction } from "./src/session/session-store.ts";
const MB = 1024 * 1024;
const row = (hash: string, bytes: number, lastTs: number, pinned = false): any => ({ hash, bytes, lastTs, createdTs: lastTs, count: 1, summary: { id: { hash }, ...(pinned ? { pinned: true } : {}) } });
const rows = [row("big-running", 300 * MB, 1000), ...Array.from({ length: 40 }, (_, i) => row("s" + i, MB, i)), row("pinned", 2 * MB, 5, true)];
console.log(planEviction(rows, { protect: ["big-running"] }).length);   // 40
```

## Slices

In order. Each is one PR, with what it must not break.

1. **The two unknown figures, measured in a real Chrome, as a notebook** (`notebooks/session-store/`; DONE,
   `chrome-bounds.ipynb`, §2's rows): the service
   worker's `jsHeapSizeLimit` and where it dies, and what `unlimitedStorage` does to IndexedDB and OPFS quota
   (`navigator.storage.estimate()`). Small, no `src/` change. It decides the batch sizes in slices 4, 6 and 7.
2. **The `history` and `runmeta` stores, the writer, the upgrade, `onError`, `historyBytes` in the budget** (§3).
   Medium. Must not break: resume of a session saved by today's code (the upgrade fixture), a run resumed after
   worker eviction, `ml.resumeChat`, the Storage page's figures.
   BUILT (`session-store.ts`): version 2 creates `history`, `runmeta`, and `marks` and `views` empty (so slice 5 needs
   no version); the writer compares by identity, then by length and a 64-bit print (two independent 32-bit hashes),
   so a page's chat (new objects at every save) writes only what changed too. A collision (a changed message of the
   same length and print) is NOT written and nothing reports it: about 2^-64 per changed position, reachable only by
   a page crafting one against its own chat; a message that cannot be serialized gets no print and is always written; `checkImmutable` is the test build's check of the rule; a failed write
   rolls its row back, is recorded (`sessions/write-failed`) and said on the session as an `agent-note`; `migrate`
   moves each version-1 row in one transaction, and any other write of such a row moves it in the same transaction.
   Left for later slices: the pass walks the rows `open()` already holds, not a cursor (slice 3 stops `open()` loading
   them); `marks` and `views` are not written (slice 5; an absent view is the whole history); the resume snapshot
   still carries `messages`, and an unsaved run's history is not written under its run id.
3. **`open()` without histories; the protected-session eviction rule** (§3). Small. Must not break: the session
   list after a restart, a pinned session surviving, the housekeeping log's eviction records.
4. **Ranged `events` reads, `session.backfill` by key range, the chat page's newest window** (§5). Medium. Changes
   what a phone or hub receives: labels `@hub-compat` and `@mobile`, with the SESSION_CONTRACT.md diff saying that
   opening a session sends a window with `from > 0` and that `session.backfill` is the way to the rest. Must not
   break: an older phone app that never asks for earlier pages (it sees the newest window, which is the honest
   degradation), the chat page's export pull.
5. **`marks`, `views`, `ml.current.history`, `@history:`** (§4), with its red-team pass (a hostile page, a
   page-started run, another session's range) and a prompt review. Medium. Must not break: `ml.current.messages`
   as the wire, the existing pointer forms.
6. **The batched archive move and backup; restore by stream** (§5). Large. Changes what a phone or hub receives:
   an archived session is served by range from the archive, so `session.backfill` and opening a session answer for
   it the same way as for a live one. Labels `@hub-compat` and `@mobile`, with the SESSION_CONTRACT.md diff saying an
   archived session is paged like any other. Must not break: restoring every backup an older version wrote, the
   archive folder's month files (byte-compatible) and its sync's merge.
7. **Streaming export** (§5). Medium. Must not break: `export.schema.json` and the `run.json` diff rule
   (`docs/dev/export.md`).
8. **`/history/`** (§6b), after `/files/` exists.

## Resume before compaction (ruled 2026-11-17)

RULED 2026-11-17 (Shane, in the coordinator's session): resume stays as it is for the storage slices: it loads the
VIEW, which is the whole history until compaction exists (§3, "What is loaded"). The first compaction design item is a
recent window plus a stub that points at the older range (`@history:0-N`), read on demand (§4). The stub's wording and
the window's size are compaction policy, proposed to Shane through the coordinator with options when slice 5 is near.

## Open, for Shane through the coordinator

- **Anything about what the model is SENT** (the view's contents, when it shrinks, what a stub says): compaction
  policy, out of scope here.
