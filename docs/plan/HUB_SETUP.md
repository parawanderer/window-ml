# Brief: setting up a hub from the extension

Asked by Shane, 2026-10-23. PARKED under the 2026-10-23 freeze ([`repl/README.md`](repl/README.md), Status); assigned
when the usage week resets. Coordinator: `repl-specs`. Reviewer: the janitor (`window-ml-flaky-ci`); a red-team pass
only if a page-started message type is added, which this brief expects not to happen.

## The ask

A person who has a hub (or wants one) should be able to connect this browser to it without reading `src/`, from the
extension itself: a doc in the repo to get started, then a "hold my hand" flow in the extension that walks them through
it. Once set up, the hub is one more entry in the DevTools Settings list, which the chat UI's settings page also shows
(Shane, same day). The DevTools panel alone is the wrong place for the setup: a person setting up a hub has no run
open and may never open DevTools.

## What exists (verified 2026-10-23)

| Piece | State |
| --- | --- |
| This browser as a runtime on a hub (`src/hub/runtime/`: login, publish sessions, answer sealed commands, allowlist) | BUILT; lane 4's hub transport |
| The pairing calls (`src/hub/pair-flow.ts`: `beginOffer`, the code and the fingerprint) | BUILT |
| The client-side pairing screens and device list (`src/pairing/`: `pairing-ui.tsx`, `devices-ui.tsx`, `qr-scan.tsx`; #212, #227) | BUILT for the chat page and the phone |
| The extension's own pairing surface | a DEVELOPMENT page only, `dev-hub-pair.html`, "until the pairing screens land in Settings" (its header) |
| The root device | `scripts/hub-root.mjs`, a command-line test tool; the design's root is a phone (`docs/dev/hub-client.md`) |
| Settings | no hub section in `src/sidebar/settings/`; nothing in the popup |
| The doc | `docs/FULL-SETUP.md` §7 is "a status report rather than a step" and says the extension's connector does not exist, which is stale since lane 4 |

So the protocol, the keys and the screens' logic are done; what is missing is the extension's front door and a
current doc.

## What to build

1. **The doc first** (`docs/FULL-SETUP.md` §7 rewritten as steps, or a new `docs/<HUB>.md` linked from it): what a hub is for
   in one paragraph, self-host or use one someone runs, create the invite, pair the root device (the phone, or the CLI
   tool while the phone app is not in hand), then "open the extension's hub page". Written for a person who has run
   `docker compose` before and nothing else. Every command copied from a run that worked, with the output it printed.
2. **A setup page in the extension**, its own extension page (the way `dev-hub-pair.html` is, and the gallery), not a
   section buried in DevTools: reached from the popup ("Connect to a hub") and from the Settings list. It walks the
   steps in order and never shows a step whose precondition is unmet: hub URL → offer this browser → show the code and
   the fingerprint, with the words to say to the root device → wait for the confirmation → "Paired", with what is now
   true (this browser is a runtime named X on account Y; which devices may view). The dev page's `beginOffer` driving
   and its `HUB_RUNTIME paired` message are the implementation; the dev page is then removed in the same PR, with
   the `hub-pairing` skill rewritten to the new page.
3. **The Settings entry, after setup**: a "Hub" section in DevTools Settings (`src/sidebar/settings/`, a sibling of
   `shell-section.tsx`), which the chat UI's settings page shows too: connection state, the account and device name,
   the device list with revoke (`devices-ui.tsx` already renders it), "leave this hub", and a link back to the setup
   page. Per AGENTS.md the DevTools Settings panel is the superset; the popup gets the one "Connect"/"Connected" line.
4. **A first-run nudge, measured not guessed**: whether and where the extension mentions a hub to someone who has
   none is a UI question for the builder to put to the gallery and a panel, not to decide alone.

## Properties that do not move

- The hub is trusted with nothing (`docs/dev/hub-client.md`): the setup page shows the fingerprint and the person
  confirms it on the ROOT device, never on the page that is being paired. No step may skip the confirmation.
- `HUB_RUNTIME` stays an extension-pages-only message; the setup page is an extension page. No page-started type is
  added, so the site-access gate is untouched (`tests/redteam.test.js` still enumerates every page-started type).
- The private key stays a non-extractable `CryptoKey`; nothing on the setup page exports or displays it.
- A hub is not an execution environment (`docs/spec/SHELL.md`): the setup page pairs a RUNTIME; it says nothing about
  shells or the process host.
- State the setup keeps (the keyring, the hub URL) is already registered; a new key goes through `defineState`.

## Acceptance

- A person following the doc and the page, with a hub on mlbox over the tailnet, pairs this browser in one sitting
  with no `src/` reading; the builder does it once for real and writes what took longest.
- The `hub-pairing` skill works against the new page; `dev-hub-pair.html` is gone from `build.mjs`.
- Each step's precondition has a test (no URL: no offer; offered, unconfirmed: no "Paired"); the fingerprint shown
  equals the keyring's; gallery entries for the page's states.
- `docs/FULL-SETUP.md` §7 no longer says the connector does not exist.

Labels `@hub,@ui,@docs`. Size: M. Questions to `repl-specs` by session-mail; state the assumption in the PR rather
than block.
