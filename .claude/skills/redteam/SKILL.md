---
name: redteam
description: The red-team pass for a new agent tool, `ml.*` member or page-started message type - what a hostile page must NOT get from it, each property written as a test that fails first while it does not hold. Use for the red-team pass AGENTS.md requires before such a change lands, and whenever a session's job is to find gaps in the site-access defences. Not for reviewing code - the output is tests that run.
---

# Red-team pass for window.ml

**The threat model** is a web page, or any script on one (an ad, an analytics tag). It shares the main world with
`window.ml` and with any tool code the extension runs in the page, so it can patch prototypes, read and post every
window message, reach the extension's shadow roots (they are OPEN), see every iframe the extension adds, and learn
every run id that reaches the page. It cannot read the extension's isolated world, its frames' state, or the
worker's memory. The person approves origins; an unapproved one must get nothing it can use, and a run the person
starts may visit any page and must lend it nothing.

**What to check** for a given change is the checklist in `docs/dev/site-access.md`, "Adding a tool, a member or a
message". Start where a defence ASSUMES something (each entry in the spec's "Where the build differs" says what it
rests on), the moments a run id or a value crosses into the page, and anything that fails OPEN when a field is absent
(no `documentId`, no `frameId`, an empty list read as "allow").

**Work property first.** For each place, write down the property the boundary must keep ("the page cannot read the
sheet approved for the run", "a grant minted for the run is spent only by the run") before working out whether it
holds. The property is the test's title; how it currently fails to hold goes in its `todo`.

## A test that fails first

A security test never seen to fail may test nothing (a fixture that never loaded, a host that never resolved). So:

1. Write the test asserting the DEFENDED outcome, with a POSITIVE CONTROL in the same test (the honest path works:
   the run's own tab streams, the real destination's page info arrives). Without it, a broken setup passes.
2. Run it against main and watch it FAIL for the reason you claim. Quote the failing assertion in your report.
3. Land it as `{ todo: "<what is open>" }` (vm) or under `holeOpen(slice, …)` (e2e) if the fix is not yours, so the
   suite stays green and the test reports its failure. The fixer removes the `todo` / flips `OPEN`.
4. The fixer mutation-checks: revert each part of the fix alone and confirm the test fails again. A layer no test
   notices is not a layer.

**The oracle**: a refusal the page can see AND nothing reached the backend, a tab or the screen that the run did not
make itself. Count requests, tab messages and captures before and after, as `attempt()` in `tests/redteam.test.js`
does. Enumerate inputs instead of sampling them: loop over `PAGE_STARTED_TYPES`, `RUN_TAB_TYPES`, every contract
event kind, every sender shape.

## The two harnesses

**vm, fast, first choice** (`tests/redteam.test.js`, `tests/site-access.test.mjs`, `tests/run-start.test.mjs`): the
built `dist/background.js` in `node:vm` with mocked `chrome` (`loadBackground` in `tests/helpers.js`). Rebuild first
(`npm run build:all`), or you are testing the old bundle.

- `loadBackground({ siteGate: true })` applies the real origin gate; without it a test sender is pre-approved.
- A sender is the browser's facts: `hostilePage(tabId, url)` gives `{ tab: { id, url }, url }`; add `frameId`,
  `origin`, `documentId` to forge what a real one would carry. A real content-script sender always has
  `documentId`; a test that omits it exercises the "unknown document" branch.
- `bg.send(msg, sender)` delivers a runtime message; a type nothing answers never settles, so race it against a short
  timer. `bg.tabMessages`, `bg.calls`, `bg.captures` are what reached a tab, the backend, the screen.
- `bg.commit(tabId, { documentId, url })` fires `webNavigation.onCommitted` (navigation races).
- `bg.context.__mlStartUserRunForTest(tabId, { task, surface })` starts a run the WORKER builds; the page is played by
  `onTabMessage(tabId, msg)`, which answers `ADOPT_RUN_NOW` and `RUN_TOOL_IN_PAGE` and can send its own messages
  mid-call.
- `bg.connect("ml-devtools")` is a DevTools panel: what it is sent is what the person would see.
- Values out of the vm are another realm: `JSON.parse(JSON.stringify(x))` before `deepStrictEqual`.
- Page-side code (`run-delegation.ts`, the dialect) imports directly; a bound resolver read through
  `currentDeref()` is what a page script sharing the realm would reach.

**e2e, real browser** (`tests/e2e/site-access.spec.mjs`, genre `security`): the built extension in Chromium against a
hostile site (`tests/e2e/fixtures/hostile/{server.mjs,evil.js}`) answering for several hostnames, which
`--host-resolver-rules` maps to it, so each is a distinct origin. `evil.js` is the hostile page's toolbox (it records
what it heard, `__heard`, and posts into the extension's iframe). Watch a background run with `watchRunEvents`; open
the sidebar by clicking its tab, never by posting into its iframe. Use it for what the vm cannot represent: worlds,
frames, real navigation, the shadow DOM.

## When a classifier blocks you

If a safety classifier refuses a test or its analysis, STOP on that case: do not reword it and retry. Name the case
to the owner; their other model writes the test, and the site-access work writes the defence.

## Report

By session mail (`~/git/session-mail/window-ml/`, its README is the protocol) to whoever owns the fix: each property
that does not hold, the file and line the gap goes through, the failing test (branch and commit), and which parts are
checked versus inferred. A failing test is the report; prose is the cover note.
