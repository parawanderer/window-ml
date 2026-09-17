# The chat page: implementation notes

The spec is [`docs/spec/CHAT_PAGE.md`](../spec/CHAT_PAGE.md) and the contract it reads is
[`docs/spec/SESSION_CONTRACT.md`](../spec/SESSION_CONTRACT.md) (`src/session-host.ts`). This file is how the code under
`src/chat/` is put together, and why.

## The pieces

| File | What it is |
| --- | --- |
| `session-feed.ts` | One session subscription's stream rules, as a pure state machine: what to do with each message `SessionHost.events()` delivers. |
| `chat-store.ts` | The client store over ONE host: runtimes, status, the session index, and the open session's events fed into the shared reducer. |
| `grants.ts` | What this client may offer on a runtime (`holds`, `mayCommand`), and whether it can render the runtime at all (`speaksOurContract`). |
| `host-services.ts` | The services seam (`src/sidebar/services.ts`) over a store: every call the shared views make becomes a contract `Command`. |
| `platform.ts` | `ClientPlatform`, what belongs to the device rather than the runtime, and its web adapter. |
| `composite-host.ts` | Several hosts as one, routed by runtime; the first host given wins a runtime two of them report. |
| `fake-host.ts` | A scripted host with real epochs and cursors, for tests, the web build and demos. |
| `demo-world.ts` | The fake host's runtimes and sessions: one of each state the page has to draw. |
| `chat-app.tsx`, `chat.css` | The page: list and session, two panes or one. |
| `web.tsx`, `chat.html` | The web entry, built to `dist-web/` by `scripts/build-web.mjs`. |

## One reducer, one transcript

The store does not render sessions itself. It applies each event with `onDebug(event, runtime)`, the reducer every
panel surface uses, into the same `sessionMap`, and the page renders `DetailView` and `Composer` from
`src/sidebar/`. So a run reads the same on a phone as in the DevTools panel, and a renderer fixed in one place is
fixed in both. The price is that those views are held to the services seam: they may not reach `chrome` or a parent
frame (`tests/portable-session-views.test.mjs`), and they ask the seam (`sideCalls`, `bench`) rather than reading the
extension's config.

Sessions are keyed `runtime:hash` in `sessionMap`, so the same hash on two runtimes is two sessions. The page's
selection is the store's `view` signal (`{ name: "detail", hash: key }`), because shared views read it too (the
Python renderer names the driving model from it, and `highlight` targets the session being read).

## The stream rules

`SessionFeed` keeps an epoch and the SET of cursors applied in it, and drops, in this order: a message about another
session; an event from an unknown major version; an event whose payload names another hash than its envelope (a
runtime must not write into a record by mislabelling); an event from another epoch; an event already applied. A set
rather than a high-water mark, because the contract allows reordering around a reconnect: a lower cursor after a
higher one is new, not a repeat.

- `reset` adopts the new epoch and the store drops the reduced session: the backfill that follows rebuilds it. Merely
  appending would double every turn the client already had.
- `backfilled` with `truncated` under a NEW epoch and no `reset` (a runtime that lost the session's history) keeps
  what is shown and adopts the epoch. Keeping the old epoch was the first version, and it dropped every live event
  after the restart as stale.
- `gone` removes the session from the index and the reduced state, and returns the view to the list.

A feed outlives its subscription: reopening a session resumes from `position`, so the host sends only what is new.
The test for that counts what the host re-sent, because the reducer absorbs a repeated step by `seq` and the
transcript alone cannot tell a resume from a full replay.

Timestamps are moved onto this client's clock (`ts - clockOffsetMs`) on the way in, for `ts` only.

## Commands and failures

`ChatStore.send` never throws (the host never rejects) and turns a failure into a notice unless the caller passes
`quiet`. Side calls and highlights are quiet: a gloss that could not be fetched shows its own retry state, and a
highlight fires on every pointer move. The client never updates a transcript optimistically: approving sends
`approval.answer` and the gate closes when the runtime's resolved step arrives.

## Rendering by capability and grant

The page never branches on "is it local". A runtime without a `session.send` grant gets no composer and a sentence
saying so; an offline one says when it was last seen; one speaking another contract major is listed with a note and
its sessions are not shown. Grants are presentation only: the runtime checks every command itself, so a wrong answer
here costs a missing button or a `forbidden` notice, never access.

## The web build

`scripts/build-web.mjs` bundles `src/chat/web.tsx` into `dist-web/` (`chat.js`, `index.html`, `sidebar.css`,
`chat.css`, the KaTeX fonts). `npm run build` runs it after the extension, except for a variant built with `--outdir`.
It FAILS on any `chrome.*` reference in the bundle, and `tests/chat-web-bundle.test.mjs` runs the same check in memory
so `npm test` says so too. The web entry opens on `demoHost()` until `HubHost` exists (slice 6), and exposes it as
`window.__chatFake`.

The phone layout is the same component below `NARROW_PX` (760): one pane, the open session in the URL (`#s=<key>`) so
a reload stays put and a back gesture returns to the list, touch-sized controls, and `100dvh` so the composer is not
under a phone's toolbars. The step pill floats there instead of overlapping a turn's first line, which a panel's wide
first line leaves room for and a phone's does not.

## Not yet

- The extension entry (`chat.html` over `LocalHost`) is slice 3, and its `ClientPlatform` adapter comes with it.
- `CompositeHost.events` attaches to the host that owns a runtime when it subscribes, and does not move if a
  higher-priority host reports that runtime later.
- The panel's tooltips (`cursorTipOn`) are pointer-only, so on a touch screen their prose is unreachable.
