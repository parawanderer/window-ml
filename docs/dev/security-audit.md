# Security audit: the page-facing toolkit

What has been checked about what a hostile web page can get from window.ml, what has not, and the plan to close the
difference. It is a working checklist, not a design doc: the design is [site-access.md](site-access.md) and
[../spec/SITE_ACCESS.md](../spec/SITE_ACCESS.md). Tick an item only when its tests are merged, and name the PR.

The question it answers: once every box is ticked, can we say the page-facing surface has been investigated
thoroughly, short of a human review? Until then the answer is no, and this file says why.

## Threat model in one paragraph

A hostile page shares the main world with `window.ml`, can post any window message, can style and reach into our
open shadow roots, knows every run id it has seen, and may frame any web-accessible extension page. It must not get
privileges the person did not grant it, must not see what a run the person started sees or says, and must not put
words into model-facing text that the extension presents as its own. Page content reaching the model as page content
(prompt injection) is inherent and out of scope: the defences limit what a steered run can DO, not what it reads.

## Done (merged, with tests)

Site access slices 0 to 2 parts 1 to 4 predate this file; see [site-access.md](site-access.md) and its Tests section.
Since then, slice 2 part 3 (the vision split: a worker-built run's capture, crops, reader calls and replies happen in
the worker, and the page answers geometry only):

- [x] Capture refuses a tab that is not showing (another site's pixels): #479, #485.
- [x] Raster and vision-host seams, worker capture with the extension's UI masked, document pinning: #481, #488, #495.
- [x] Geometry replies validated field by field (`checkGeometry`), worker-built legends: #510.
- [x] Verifies in the worker; a page envelope cannot carry an image, reply or spend into a worker run: #519.
- [x] Trusted (CDP) typing uses the model's own text, never the page's echo: #527.
- [x] A page's `hint.session` naming a worker-built run is dropped: #497, #521.
- [x] `look` in the worker, bounded full-page stitch, short captures: #533.
- [x] Screenshot mask: page CSS that the shell cannot bound refuses the shot; the UI is watched through the capture;
      a page-framed `sidebar.html` stays empty and cannot take the shell's port; second pass by another model: #559.
- [x] `locate` in the worker; a handed-over run's page-written model names and `driverSees` validated in one place
      (`runVision`): #561.
- [x] A page's START_RUN can no longer set what only the worker may: `builtBy`, `rebuild.builtBy`, `display` dropped;
      `pageOrigin`/`pageUrl` taken from the sender; the auto-approve flags and `selfIntrospection` bounded by the
      worker's config; `requiresApproval` forced on the built-in gated tools and remote tools; another tab's run id
      refused; `approvalRouting` confirmed unable to resolve a gate. Every START_RUN field is classified in the PR: #566.
- [x] Answer media and python `image` in the worker; a ratchet e2e that a worker run's page sends nothing at all,
      with an in-run positive control; the e2e watcher no longer shares the run's window (it captured the watcher): #571.

## In progress

(none)

## Known open

- [ ] Stylesheet timing: a page can move our host or `<html>` through a CSSOM edit made after one frame read and undone
      before the next. Closed for the HOSTS by their inline `all: initial !important` (`HOST_STYLE`, shell-shot.ts),
      which beats every page stylesheet `!important` rule, layered or not, and animations: no page rule moves, zooms,
      filters, reflects, clips, blends or hides a host, timed or not (review-look.spec.mjs, "our hosts pinned"). Still
      open: `<html>` (the page's own element), and a `:host` rule the page puts inside our open root, whose `!important`
      beats the host's inline one (inner context wins): edited into our own sheet through the CSSOM or set as an adopted
      sheet, neither is a DOM mutation, so the watch refuses it only when a frame read sees it. Next: hosts in the top
      layer; closed shadow roots stay a documented gap.
- [ ] A page's `renderOut`/`renderIn` still render in a worker run's sidebar step (human-facing only).
- [ ] An off-viewport locate scope reports "the vision call errored" instead of saying the scope is off screen.
- [ ] START_RUN `maxSteps` is not clamped (RESUME_RUN is), and a page can stamp its prompt's `origin` as an
      extension surface. Proposed: clamp, and drop `origin` for page runs. Owner decision pending.
- [ ] Part 5 must move or refuse page-built runs never handed to the worker: all their tools still use the page's
      vision, python and fetch types. Worker runs still send `PYTHON_EXEC`/`FETCH_SHEET` for a page table and
      `CDP_SHADOW_RESOLVE` from the page.
- [ ] A run handed to the worker mid-turn would still run `answer` and python with an image in the page (no route
      does this today).
- [ ] Site access part 4b, part 5 (drop the run-tab allowance, `RUN_TAB_TYPES`), slice 3 (`requestAccess`, wording
      needs owner approval), slice 4.

## The plan to get to "thoroughly investigated"

The reviews so far were scoped to each PR's change. `builtBy` and `pageOrigin` were found by accident, which shows
the page boundary has never been enumerated field by field. The repo's own rule is to enumerate inputs, not sample
them.

1. [ ] **Trust table.** Started: START_RUN's fields are classified in #566. One table in this file: every
       page-reachable message type (each `HANDLE_MAP` entry in `src/page-relay.ts`), every window message the content script or shell listens to, and every DOM surface a
       page can reach (shadow hosts, web-accessible pages). For each FIELD: who may set it (page, worker, extension
       page, person), what reads it, what it can change, and the test that proves a page cannot set what it must not.
2. [ ] **Fix and test** every field the table shows wrong, test first.
3. [ ] **Re-check the surfaces built before slice 2** against its rule that a worker-built run lends the page
       nothing: exec and its isolated world, `ml.current`, python, `ml.fetch` and rendered fetch, pointers and
       stored values, CDP actions, iframes, the chat page, the hub.
4. [ ] **A whole-surface pass by another model** (the owner's red-team session) over the table, not one case.
5. [ ] **What the harness cannot show**, written down with the vm test that stands in for it: bfcache restore with
       the same document id, prerender activation, a restored discarded tab (Playwright cannot stage any of them), and
       a run in Brave, the owner's browser.
6. [ ] A human review of this file and the trust table.

## Cases another model must write

Cases the safety classifier stopped a Claude session from writing are tracked outside the repo, with what each must
prove and on which branch; a case is closed only when another model has written it and it has merged. Two so far:
the approval-card redress attack (closed, #392) and the screenshot-mask second pass (written by the other model and
merged in #559; whether the Claude-written parts of that list also need the other model is an owner decision).
