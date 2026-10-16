# The housekeeping log

What the system decided on its own: evictions, sweeps, service-worker restarts, Python cold starts. The design and
its scope rule are in `docs/spec/HOUSEKEEPING_LOG.md`; this file is how the code does it and what to keep true when
you add an emitter.

## The pieces

| File | Holds |
| --- | --- |
| `housekeeping.ts` | `HousekeepingLog` (buffer, batched flush, start/inference), `sanitizeReport`, `trimRing`, `eventsForReader`. Pure apart from the storage area it is handed, so all of it is unit-tested in `tests/housekeeping.test.mjs`. |
| `sw-housekeeping.ts` | The worker's one log over `chrome.storage.session`, `senderOrigin`, and the two message handlers. |
| `background.ts` | Routes `HOUSEKEEPING_REPORT` / `DUMP_HOUSEKEEPING`, calls `start()` at load and `beat()` on every message. |
| `injected.ts` | `ml.__housekeeping({ download })`. |
| `sidebar/housekeeping-log.tsx` | The panel view (header ⋮ → Housekeeping log), in both the overlay and DevTools. |

## What reports today

| Event | From | Notes |
| --- | --- | --- |
| `sw/start`, `sw/evicted-inferred` | the worker (`HousekeepingLog.start`) | See "Inferred eviction" below. |
| `pyodide/prewarm` (`reason: run-start / commander`) | the worker (`PYTHON_PREWARM`) | Only when it actually started the runtime; an already-running one logs nothing. |
| `pyodide/cold-start` (`ms`, `reason: prewarm / run`, `key` = principal) | `offscreen.ts`, from the worker's `booted` message | The start itself, whatever caused it. A warm run reports nothing. |
| `pyodide/prewarm-used` (`ms`, `detail.warm`) | `offscreen.ts` | The first run after a pre-warm: warm, or still starting and how long it waited. |
| `pyodide/kill` (`reason: timeout / start-timeout / crashed`) | `offscreen.ts` `killWorker` | `detail.queuedRuns` is how many runs behind it failed with it; a crash keeps the worker's message in `detail.message`. |
| `pyodide/respawn` (`key` = principal, `detail.mode`) | `offscreen.ts` `ensureWorker` | A principal's worker was killed and is starting fresh: its kept bench namespace died with the old worker. |
| `fetch-cache/evict` (`reason: budget`, `key`, `bytes`) | the page (`injected.ts`, `FetchCache`'s `onEvict`) | Page-origin, so only the tab that fetched the URL reads the key back. |
| `sessions/evict` (`reason: retention / budget`, `key` = session hash, `bytes`, `detail.outcome`, `detail.idleDays`) | the worker (`SessionStore`'s `onEvicted`, `sw-sessions.ts`) | A saved session the store dropped on its own: past `sessionRetentionDays`, or to fit its size and count caps. Pinned sessions never appear. `outcome` is `deleted` today and will be `archived` once an archive folder exists. A `session.delete` is asked for, so it is not logged. |

`tests/e2e/housekeeping.spec.mjs` covers what only a real browser can: the log surviving a stopped worker (CDP
`ServiceWorker.stopAllWorkers`), the next worker's inference, the offscreen origin coming from the sender, and a
pre-warmed run's first `python_exec` finding the runtime warm. The Commander trigger has no test: the shell's
`openComposer` is not loaded by any unit harness.

## The panel view

The first entry in the header's ⋮ "More panels" menu (`MoreMenu`, app.tsx) — the home for panels opened too rarely
to earn a header icon of their own, which is why the row gained one menu button rather than one per panel. It
REPLACES the view like Settings, and `‹` returns to the session or list you were reading (`viewReturn`). It rides
the full bench's non-scrolling column (`view-bench`) with a `fill` output cell, so the log takes the panel's height.
Nothing is read until it opens. Opening it asks the worker once (`DUMP_HOUSEKEEPING`, which flushes the buffer); after that
`storage.onChanged` for `ml_hk_log` pushes the ring in, so the open log updates live without polling.

The events render as TEXT inside the shared `OutputCell` + `TimedOutput`, one line per event, oldest first. That
reuse is the design: a log is output, and the cell already has the timestamp gutter (one mark per line, at the
event's `t`), Ctrl+F, the resize grip and tail-follow, which keeps the newest event in view. Subsystem filter chips
sit in the view's toolbar, the event lane's `rc-lane-chip`s. Anything the worker did not record itself ends
in `[offscreen]` or `[page tab N]`. A cleared log shows its `log clear` line; an empty one says nothing has been
recorded since the browser started. `housekeepingText` is pure and tested in `tests/housekeeping-log.test.mjs`; the
section itself in `tests/sidebar-settings.test.js`.

## Background jobs: what is happening NOW

The log says what happened. It cannot say whether a pass is running, how much waits for one, or whether the last one
finished or was cut off when the worker stopped. A job that acts on saved data on its own is DECLARED beside its code
with `defineJob` (`src/job-registry.ts`), the way a store is declared with `defineState`: an id, a title, when it runs
(a sentence), which log records are its own (`subsystem`, `start?`, `done`, `failed?`, `also?`), and an optional
`live()` returning plain data (`running`, `pending` with its unit, `nextDue`).

The status is the live answer plus the log, and the whole rule is the pure `jobStatus`: running wins; else a `start`
record with no `done`/`failed` after it is **interrupted** (the worker was stopped in the pass, and nothing had to
survive it for that to be seen); else a last run that failed is `failed` until a later one succeeds; else pending work
is `waiting`; else `idle`. Kinds are listed rather than matched by subsystem, because `sessions` holds two jobs. The log
lives in `storage.session`, so a browser restart clears the history: a pass cut off by closing the browser shows as
`waiting` (its sessions are still uncompacted), never as a wrong `interrupted`.

Declared today:

| Job | Where | Pass records | Live |
| --- | --- | --- | --- |
| Screenshot compaction | `sw-image-compact.ts` `compactionJob` | `sessions/compact-pass` → `compact-pass-done` / `compact-images-failed` | running, sessions waiting, the quiet timer's due time |
| Saved-session cleanup | `sw-sessions.ts` | none: each `sessions/evict` is a run, `archive-failed` a failure | none |
| Stored-value sweep | `sw-values.ts` | none: each `value-store/evict` | its alarm's next time |
| Archive folder sync | `sw-archive.ts` `syncFolder` | `archive/folder-sync` → `folder-sync-done` / `folder-sync-failed`, only while a folder is connected | running, month files waiting, the debounce's due time, `blocked` when the grant lapsed |
| Price snapshot refresh | `sw-prices.ts` `startRefresh` | `prices/refresh` → `refresh-done` / `refresh-failed` | running |
| Archive screenshot compaction | `sw-image-compact.ts` `archiveImageCompactor` | `archive/image-compact` → `image-compact-done` / `image-compact-failed` | running, archived PNGs waiting (known once a pass has asked), the quiet timer's due time |
| Python pre-warm | `sw-python.ts` | none: each `pyodide/prewarm` | none |

`blocked` is a live field for work that waits on a person (a folder whose permission lapsed); the row says what to do
in place of a countdown. A `reason` must be a lowercase slug or the log DROPS it (`sanitizeReport`), so prose and error
messages go in `detail` (`why`, `error`): the price refresh's error was lost that way until 2026-10-12. `DUMP_JOBS` reads them all against
one copy of the log, for extension pages only (`handleJobsDump`). The **Background work** section (`BackgroundWork`,
`housekeeping-log.tsx`) sits at the top of the housekeeping view, so the chat page's Settings, Housekeeping shows it
too: one fold per job with its state on the header line, opening onto the job's own records. It re-reads when the log
changes and every 5 s while shown. Tests: `tests/job-registry.test.mjs` (registry, states, the upgrade from a log with
no job records, the message, the section) and the compaction section of `tests/image-compaction.test.mjs`.

To add a job: declare it at module load beside the job, log a start/done pair if a pass can be cut off, and give it
a `live()` if it knows what waits.

## Adding an emitter

- **In the worker:** `recordHousekeeping({ subsystem, kind, reason?, key?, bytes?, ms?, detail? })` from
  `sw-housekeeping.ts`.
- **Anywhere else** (the offscreen document, the page): send `HOUSEKEEPING_REPORT` with the same object. From the
  page that is `HOUSEKEEPING_REPORT_REQUEST` through the content-script relay.
- Names (`subsystem`, `kind`, `reason`) are lowercase slugs, at most 32 characters, or the event is dropped.
  `detail` is flat: strings, finite numbers, booleans, at most 16 entries.
- Log only what nobody asked for. A fetch, a tool call or a model call is not housekeeping; the eviction that a
  fetch later caused is.
- Tests assert on the event (`{ subsystem, kind, reason, bytes }`), not only on the value having gone.

## How it works

**Storage.** A ring in `storage.session` under `ml_hk_log`: 1,000 events, of which at most 200 may be page-reported.
The page cap is dropped from first, so a page flooding reports cannot push the worker's own events out.
`storage.session` survives the worker being evicted and is cleared when the extension reloads or updates and when
the browser restarts.

**Batching.** Events buffer in memory and flush one second after the first, in one read-append-write. Flushes are
chained on one promise, so two never read the same ring and overwrite each other's batch. A failed write loses that
batch and nothing after it.

**Inferred eviction.** Every flush also writes a heartbeat (`ml_hk_seen`), and every incoming message calls
`beat()`, throttled to one heartbeat per 5 s. There is no timer: a timer keeps a worker alive and changes what is
measured. Because `storage.session` clears on reload, a heartbeat present when the worker STARTS means this
extension session already had a worker that stopped without saying so. `start()` logs `sw/evicted-inferred` with the
gap (`reason: "idle"` past Chrome's 30 s idle window, `"unknown"` below it) and then `sw/start`. The gap can be up to
one heartbeat interval too long. A heartbeat write is itself an extension API call and so resets Chrome's idle
timer, but it only follows a message within a second, so it extends a worker's life by at most that second.

**The start race.** The message that wakes a worker is often the dump itself. `all()` and `clear()` wait for
`start()` to finish writing, or the first dump after a restart would miss the inference it exists to show.

## Trust

- **`origin` is the worker's to set**, from `sender`, which the browser stamps: an extension URL is `offscreen`
  (`offscreen.html`) or `extension` (popup, DevTools panel, the overlay's iframe even though it sits in a tab);
  anything else from a tab is `page`, with its tab id. Whatever the payload claims is discarded.
- **A page reads `key` and string `detail` values only on events its own tab reported.** A key can be another tab's
  fetched URL or a session hash, and a saved session is resumable by anyone holding its hash; a string detail can
  carry the same. The decision itself (subsystem, kind, reason, bytes, ms, numeric and boolean details) stays
  visible. Extension surfaces see everything.
- **A page cannot clear the log.** `clear` from our own surfaces leaves a single `log/clear` event, so a cleared log
  reads differently from an empty one.
- **Nothing reads the log to decide anything.** Keep it that way: it is a record that a page can partly write.
