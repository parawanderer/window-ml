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

## What reports today

| Event | From | Notes |
| --- | --- | --- |
| `sw/start`, `sw/evicted-inferred` | the worker (`HousekeepingLog.start`) | See "Inferred eviction" below. |
| `pyodide/prewarm` (`reason: run-start / commander`) | the worker (`PYTHON_PREWARM`) | Only when it actually started the runtime; an already-running one logs nothing. |
| `pyodide/cold-start` (`ms`, `reason: prewarm / run`) | `offscreen.ts`, from the worker's `booted` message | The start itself, whatever caused it. A warm run reports nothing. |
| `pyodide/prewarm-used` (`ms`, `detail.warm`) | `offscreen.ts` | The first run after a pre-warm: warm, or still starting and how long it waited. |
| `pyodide/kill` (`reason: timeout / start-timeout / crashed`) | `offscreen.ts` `killWorker` | `detail.queuedRuns` is how many runs behind it failed with it; a crash keeps the worker's message in `detail.message`. |
| `fetch-cache/evict` (`reason: budget`, `key`, `bytes`) | the page (`injected.ts`, `FetchCache`'s `onEvict`) | Page-origin, so only the tab that fetched the URL reads the key back. |

`tests/e2e/housekeeping.spec.mjs` covers what only a real browser can: the log surviving a stopped worker (CDP
`ServiceWorker.stopAllWorkers`), the next worker's inference, the offscreen origin coming from the sender, and a
pre-warmed run's first `python_exec` finding the runtime warm. The Commander trigger has no test: the shell's
`openComposer` is not loaded by any unit harness.

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
