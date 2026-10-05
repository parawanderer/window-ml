# The execution log — what the machinery did under a run

A run's transcript says what the model asked for and what came back. It says nothing about the work
underneath it. A measured run spent **13 minutes 57 seconds** inside a single `pageInfo`, and nothing
anywhere said why: the browser had discarded the tab in the background, so the content script was
registered and simply not running. From the loop's point of view nothing had gone wrong yet.

That is the shape of everything in this log — work that happens, matters, and is invisible.

- **The store and the records**: `src/run-log.ts` (and `src/storage-ring.ts` underneath it)
- **The worker's copy and its one message**: `src/sw-run-log.ts`
- **The panel**: `src/sidebar/run-log-view.tsx`, docked by `src/chat/dock.tsx`
- **The published export**: `docs/spec/run-log.schema.json`, generated from `run-log.ts`
- **A demo of the whole thing**: `node tests/e2e/run-log-demo.mjs`

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
