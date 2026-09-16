# The housekeeping log: what the system decided on its own

**Status: agreed, not started.** Written 2026-09-16. Build it before the value store
(`docs/spec/POINTER_VALUES.md`), with the Pyodide pre-warm as its first emitter.

## Why

The hardest bugs of the session that produced this spec were all TRANSITIONS NOTHING RECORDED: a service
worker evicted mid-session, orphaning state that only a clean shutdown would have released; a fetch-cache
eviction that turned into a misleading "never fetched" message; a chart whose window moved on its own and made
a test flaky. Each was diagnosed by reading code and reasoning backwards, because none of them left a trace.

More of these mechanisms are coming — a value store with layered eviction, a Pyodide pre-warm, idle sweeps on
alarms — and each is, by design, something that happens with nobody watching. Without a record they are the
least observable code in the extension, and untestable beyond "the value is gone".

## What goes in — the scope rule

**Only decisions the system made on its own.** The existing surfaces already cover the rest:

| Surface | Answers |
| --- | --- |
| the run log / `run.md` | what the MODEL did |
| the event lane / `ml.__events()` | what RUNS and MODELS did over time |
| **the housekeeping log** | what the SYSTEM decided without being asked |

In: evictions and sweeps and what they freed; a service-worker start, and an inferred prior eviction; the
offscreen document created or closed; a Pyodide cold start, a pre-warm, a worker killed on its timeout; a grant
expiring; storage quota estimates. Out: fetches, polls, tool calls, model calls — anything a user or model
action caused directly. The rule is what keeps this from becoming a second, noisier debug stream.

## The event

Structured, never free text:

```ts
interface HousekeepingEvent {
    t: number;                       // epoch ms
    subsystem: "sw" | "offscreen" | "pyodide" | "fetch-cache" | "value-store" | "grants" | "quota";
    kind: string;                    // "evict" | "sweep" | "start" | "evicted-inferred" | "prewarm" | "cold-start" | "kill" | "expire" | "estimate" | …
    reason?: string;                 // "budget" | "idle" | "session-end" | "timeout" | "browser" | …
    key?: string;                    // what it acted on: a URL, a pointer id, a session hash
    bytes?: number;                  // what it freed or cost
    ms?: number;                     // how long it took (a cold start, a sweep)
    origin: "worker" | "offscreen" | "page";   // WHO REPORTED IT — see Trust
    detail?: Record<string, string | number | boolean>;   // anything else, small and JSON-safe
}
```

Structured for two reasons, and the second is the stronger. It filters and exports cleanly. And it is a **test
seam**: background mechanisms have no observable output, so today an eviction test can assert only that a value
disappeared. With the log it asserts the decision — `{ subsystem: "value-store", kind: "evict", reason:
"budget", bytes: 41_000_000 }` — which is the difference between testing an outcome and testing a policy.

`subsystem` and `kind` are an open union by intent: a new mechanism adds its own. `reason` is what makes an
eviction legible — "budget" and "idle" are different findings.

## Where it lives — the event that cannot log itself

The most important event is an MV3 service worker being evicted, and a worker that is evicted writes nothing on
the way out. So:

- **The log is a ring buffer in `chrome.storage.session`.** It survives service-worker restarts (unlike worker
  memory, which is where `ml.__events()`'s debug ring lives and dies), clears on browser restart (right for a
  housekeeping log, and nothing sensitive persists to disk), and has a 10 MB quota, far above a few hundred small
  events. Cap it at about 1,000 events, oldest dropped. Nothing in the codebase uses `storage.session` yet.
- **Eviction is INFERRED on the next start.** The worker writes a last-seen heartbeat into `storage.session` at
  natural activity points (not on a timer — a timer is what keeps a worker alive and changes what is being
  measured). On start, a heartbeat older than the idle-eviction window, with no clean-stop marker, is logged as
  `{ subsystem: "sw", kind: "evicted-inferred", detail: { lastSeenAgoMs } }`. It is an inference and says so.
- **Writes are batched.** Events buffer in memory and flush on a short debounce and at natural boundaries (a run
  ending, the worker about to go idle), so logging never becomes a reason for a `storage.session` write per
  event. The cost of losing an unflushed batch to an eviction is exactly one inference, which the next start
  records anyway.

## Trust

Some mechanisms run in the PAGE's main world — the fetch cache does — and their events reach the worker through
the content-script relay, which a hostile page can call directly. So every event carries `origin`, set by the
WORKER from the message's sender, never by the reporter. Page-reported events are shown, tagged as such, and
never used to decide anything: nothing reads this log to make a security or eviction decision. It is a record,
not an input.

## The two ways in

- **A DevTools panel toggle**, beside the resource panel and the Python bench: a newest-first list with filter
  chips per subsystem, each row showing kind, reason, key and freed bytes, with page-reported rows visibly
  marked. Built from existing components — run `node scripts/components.mjs` for chips, disclosures and
  tables before adding anything. A cleared log and an empty one read differently ("nothing recorded since …").
- **`ml.__housekeeping()`**, beside `ml.__events()`: the raw events as JSON, with the same `{ download: true }`
  option. Underscored because it is a debugging aid, not API. This is what probes, `observe` runs and e2e tests
  read.

It stays out of `run.json`: it is not about a run, and an export of one run must not carry what other tabs'
housekeeping did.

## First emitters, in order

1. **The Pyodide pre-warm** (agreed separately: triggered when a run starts or the Commander opens — never on a
   mere `ml.*` read, since booting Pyodide with its packages costs real memory). Emits `prewarm` (started,
   `ms`), and the first `python_exec` after it emits whether it found the runtime warm — the log is how anyone
   finds out whether pre-warming pays for itself.
2. **Cold starts and worker kills** already measured in `python-worker.ts` (`bootMs`, `killWorker`).
3. **The fetch-cache eviction** shipped in PR #80 (`fetch-cache.ts`): page-reported `evict` with `bytes`.
4. **Service-worker start and inferred eviction.**
5. **The value store**, when it is built: every layer of its eviction (budget on write, session release, idle
   sweep, browser eviction detected as a missing database) reports here, and its tests assert on these events.

## Open questions

- **Retention across a browser restart.** `storage.session` clears; a restart is itself a housekeeping boundary
  worth seeing, but persisting the log to IndexedDB would make it disk state with its own eviction problem. Start
  without it.
- **Surfacing, not just logging.** A value-store budget eviction the user would care about (a table they are
  working with) might deserve a toast rather than a log row. Decide once there is real traffic to look at.
- **A timeline view.** These events have times, and the event lane already draws instants; a housekeeping row on
  the lane is plausible later. A list first.
