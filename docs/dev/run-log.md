# The execution log — what the machinery did under a run

A run's transcript says what the model asked for and what came back. It says nothing about the work
underneath it. A measured run spent **13 minutes 57 seconds** inside a single `pageInfo`, and nothing
anywhere said why: the browser had discarded the tab in the background, so the content script was
registered and simply not running. From the loop's point of view nothing had gone wrong yet.

That is the shape of everything in this log — work that happens, matters, and is invisible.

- **The store and the records**: `src/run-log.ts` (and `src/storage-ring.ts` underneath it)
- **The worker's copy and its one message**: `src/sw/sw-run-log.ts`
- **The panel**: `src/sidebar/run-log-view.tsx`, docked by `src/chat/dock.tsx`
- **The published export**: `docs/spec/run-log.schema.json`, generated from `run-log.ts`
- **A demo of the whole thing**: `node tests/e2e/run-log-demo.mjs`

## How to log to it

Two calls, and which one you reach for is about what you are holding.

```ts
// You know whose run it is (sw-runs.ts, sw-run-host.ts where the runId is in scope):
import { recordRunLog } from "./sw-run-log";
recordRunLog(runId, { subsystem: "tab", kind: "pinned", reason: "hosting", detail: { tab: tabId } });

// You only have a TAB — which is the usual case, because the machinery that reloads a discarded tab or
// attaches a debugger is addressed to a tab (sw-cdp.ts, and anything keyed the same way):
import { noteRunMechanic } from "./sw-runs";
noteRunMechanic(tabId, { subsystem: "cdp", kind: "refused", reason: "permission", detail: { tab: tabId } });
```

`noteRunMechanic` records for whichever run(s) that tab is hosting, and says nothing when there is none — correct
rather than lossy: this log is a run's, and with no run there is nobody to tell.

Both are fire-and-forget and neither can throw: a log line must never fail the run being logged. The cost of that
is the trap below — a malformed record is dropped in silence.

The fields are `HousekeepingReport`'s (`subsystem`, `kind`, `reason?`, `key?`, `bytes?`, `ms?`, `detail?`) plus
the `run`, which the call supplies. Pick `subsystem`/`kind` freely; both are open registries. Add the row to the
table below in the same change, which the tests check (see "Why a bad name is dangerous").

### Watching them while you drive

`globalThis.__mlRunLog.echo()`, evaluated in the WORKER, mirrors every record to its console as it is made;
`.all()` reads the ring without going through a message. Both are for a Playwright spec, a demo or `observe` —
whoever is driving the browser and for whom the records ARE the thing being watched. Off for everyone else, and
that default is the whole point: this log exists because a `console.log` in a service worker is one nobody will
ever see, and echoing by default would simply put the noise back.

`tests/e2e/run-log-demo.mjs` is the worked example, relaying the lines out with `ext.sw.on("console")`.

## It is not the housekeeping log, and the difference is a rule

`docs/spec/HOUSEKEEPING_LOG.md` scopes that log to **decisions the system made on its own** and puts
"anything a user or model action caused directly" explicitly out of scope. A CDP attach is caused by a
tool call. So this is a fourth row in that spec's scope table rather than a stretching of the third,
and keeping them apart is the only thing stopping either from becoming the second, noisier debug
stream that spec names as its own fear.

What it **reuses** is the record shape (`HousekeepingEvent` plus a `run`) and `sanitizeReport`, which
is what lets one renderer draw both — `housekeepingText` formats a run-log record with no changes.

## The records

`subsystem` and `kind` are **open strings**, deliberately, exactly as they are in the housekeeping log:
a new mechanism adds its own. The published schema therefore describes them as strings with the known
values as examples, and never as an enum — a consumer generated from a closed enum would break the day
any new mechanism reports.

| subsystem | kind | what it means |
| --- | --- | --- |
| `page` | `held` (`navigating`) | a delegated send waited on the nav barrier while the page committed a navigation |
| `page` | `discarded` | the tab was discarded with a call outstanding; `ms` is how long before we noticed |
| `page` | `reloaded` | reloaded in place and about to retry; a `reason` of `gone` means the reload itself failed |
| `page` | `recovered` | the retry answered, and how long it took |
| `page` | `unreachable` (`asleep`/`gone`/`silent`) | gave up, with how long it waited |
| `cdp` | `attached` (`already`) | the debugger was attached — the banner the person saw |
| `cdp` | `refused` (`permission`/`busy`) | "CDP not enabled", or DevTools already holds the tab |
| `cdp` | `detached` | paired with the attach, so the two bracket how long the run held the debugger |
| `tab` | `pinned` (`hosting`) | `autoDiscardable: false` while a run is hosted here |
| `tab` | `released` | and let go again, which is the half that is easy to forget |
| `tab` | `replaced` | `chrome.tabs.onReplaced` re-filed the run under a new tab id |

**Which tab a record is ABOUT goes in `detail.tab`**, never the event's own `tab` field: that one means
the tab that REPORTED an event, which for a worker record is nobody, and the shared renderer prints it
as part of "who said this".

**A tool name cannot be a `reason`.** Reasons are lowercase slugs (`^[a-z0-9][a-z0-9-]{0,31}$`) and a
tool is `pageInfo` or `python_exec`, so the tool travels in `detail.tool`.

### Why a bad name is dangerous, and what guards it

`sanitizeRunReport` **silently drops** a record whose subsystem or kind is not a slug. That is the right
production behaviour — a log line must never fail the run being logged — and a terrible failure to
debug, because a dropped record looks exactly like a mechanic that never happened.

So `tests/run-log.test.mjs` enumerates the names the emitters actually pass, by reading the emitter
sources, rather than sampling them. One of them is not a literal at its emit site (`reason: e.state`
on an unreachable page), so the guard reads those from where `TabState` is declared. Both directions
are checked: every name emitted must survive the sanitizer, and every name the module's own convention
table lists must be one something emits.

## Deliberately not a line per probe

The watch probes a silent tab every four seconds for up to four minutes. Sixty rows saying "still
nothing" would bury the four that matter, and the transcript already shows what a step cost. **This log
is for what the transcript CANNOT say**, which is the test to apply to anything added to it.

## Reading it

The panel follows **whichever session is open**. There is no run picker: the question it answers —
"what happened under THIS" — is always about what is being read. The count of other runs holding
records exists only so an empty panel can be told from a broken one.

It asks no capability of the runtime, unlike the resource panel. Those graphs describe a box the
*runtime* reports on; this log is read out of **this browser's own worker**, so being able to draw it
is the whole question, and `ChatExtras.runLog` returns null for a runtime that is not ours.

**The panel is the records, and nothing else.** Its filters, its three exports and its count were a toolbar and
a paragraph sitting on top of the log, in the one region whose width is the scarce thing. They are now one menu
button in the dock's own bar (`PanelHead`, which is how a docked panel puts controls in the tab bar instead of
growing a second row), and the paragraph is the TAB's tooltip under a rule (`.tt-note`). The count is in that
button's own tip: it is a status rather than a control, so it earned no row, but it is the one number someone
wants at a glance and a tooltip costs no width.

Two reading choices live in that menu, both remembered per device in `chrome.storage.local` beside the panel's
neighbours (`outMaxH` and the rest of Appearance do the same), because the view is drawn from `src/sidebar/` and
may not reach into `src/chat/`:

- **Colour by group**, OFF by default. Each line's subsystem column takes a colour from the palette the resource
  panel draws with — the one "Colour palette" names, which is why that setting is no longer called "Model
  colours". Assigned by POSITION over every group the log holds (`poolColor`, the rule pools already use), not by
  hashing the name: a log has four or five groups, and two of them colliding is likely rather than unlucky. The
  order is over every group, not the shown ones, so filtering one out does not recolour the rest. The colour is
  blended toward the ground before use (`--log-g-into`), because a palette drawn for thin chart lines is shouting
  as a word in a wall of monospace. Default off because the renderer underneath is the housekeeping log's too.
- **Text size**, a ZOOM and never an absolute size. The log is a code block, so the size it already reads at is
  the device's "Code size" (`--code-fs`); this multiplies it, so changing that one still moves a log somebody had
  zoomed instead of the two settings disagreeing. `Ctrl`/`⌘` with `+`, `−` or `0` does the same thing while the
  log has focus — the output cell is focusable already, since it owns Ctrl+F — and the key is prevented, so the
  browser does not zoom the whole page instead.

The tab id is dropped from the rendered LINES while it is the same on all of them — in a region this
narrow that width is what turns each record into two wrapped lines — and comes back the moment a run is
re-filed under a new tab, which is exactly when it is worth reading. The records always carry it.

## The two exports

- **The log itself** downloads as the structured records in a published document (`RunLogDocument`),
  not as the rendered lines. They are structured for the same reason they are stored that way.
- **"all events" reuses the EXISTING `run.json`**, which already carries `session.events` — the whole
  timeline the resource panel draws. The button belongs here because this panel is where someone stands
  when they ask "where did the time go", which is the row `run.json` already owns in AGENTS.md's
  "which artifact to reach for" table. A fifth artifact that was almost that file is how that table
  stops working.

## Still open: letting the model read its own run's log

Agreed in principle, deliberately not built yet, and the order matters: **records first, surface after**,
or the API gets shaped around a speculative reader. Two hazards, in order:

1. **Prompt injection**, which is the real one. A record's `key` can be page-derived (a URL, a title),
   and feeding that back through a channel the model asked for is an injection surface — the same
   reasoning behind `PROSE_SEGMENTS` and `suspiciousChars`. The model-facing view is enums and numbers
   only, with any free string withheld or marked untrusted. This falls out of the records being
   structured, which is an argument for it.
2. **Acting on transient infrastructure noise.** "CDP not enabled" invites a model to route around
   something only a person can fix. Keep it PULL-only (a tool it calls), never injected, behind an
   "allow the model to inspect run logs" approval, gated at the BACKGROUND — the worker filters to this
   run and applies the withholding. A page-side check is not the boundary.

`DUMP_RUN_LOG` is extension pages only until that exists: the ring holds every run's records.

## The trap this log exists for

- **The execution log is the OTHER half of that trap, and it is NOT the housekeeping log.** What the machinery did
  under a run — the discarded tab reloaded, the CDP attach refused, the tab re-filed under a new id — goes to
  `run-log.ts`, whose scope is per-RUN mechanics. **It exists because a `console.log` in a service worker is one
  nobody will ever see, so write what the worker did HERE**: `recordRunLog(runId, { subsystem, kind, reason?,
  detail? })` where the run is in scope, or `noteRunMechanic(tabId, …)` (sw-runs.ts) where only the tab is, which
  is the usual case — the machinery is addressed to tabs and the log is read per run. Both are fire-and-forget
  and neither can throw. Driving the browser yourself? `globalThis.__mlRunLog.echo()` in the WORKER mirrors every
  record to its console as it happens, and `.all()` reads the ring without a message; off for everyone else, for
  the reason above. It is NOT the housekeeping log, whose spec excludes "anything a user or model action caused
  directly" — a CDP attach is caused by a tool call — but it REUSES that log's record shape plus a `run` and its
  sanitizer, so one renderer draws both. Two things bite: `sanitizeRunReport` SILENTLY DROPS a record whose
  `subsystem`/`kind` is not a lowercase slug (right in production, invisible in development — a tool name is
  never a `reason`, it goes in `detail.tool`), and `detail.tab` is which tab a record is ABOUT, while the event's
  own `tab` means who REPORTED it. Never a line per probe: the transcript already shows what a step cost.
