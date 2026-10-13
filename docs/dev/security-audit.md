# Security audit: the page-facing toolkit

What has been checked about what a hostile web page can get from window.ml, what has not, and the plan to close the
difference. It is a working checklist, not a design doc: the design is [site-access.md](site-access.md) and
[../spec/SITE_ACCESS.md](../spec/SITE_ACCESS.md). Tick an item only when its tests are merged, and name the PR.

The question it answers: once every box is ticked, can we say the page-facing surface has been investigated
thoroughly, short of a human review? Until then the answer is no, and this file says why.

## Threat model in one paragraph

A hostile page shares the main world with `window.ml`, can post any window message, can reach our shadow hosts but
not inside their closed roots (#610; the hosts sit in the top layer, #599), knows every run id it has seen, and may frame any web-accessible extension page. It must not get
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
- [x] Part 5, first PR: a page-built run that navigates onto an unapproved site is handed to the worker at the browser's
      commit (`nav-handover.ts`), and the ratchet e2e covers it; a run handed over mid-turn runs the rest of the turn as
      a worker run (`answer`, python with an image, `fetch_url`, exec routing, grants, lifecycle): #606.
- [x] Part 5, second PR: `RUN_TAB_TYPES` dropped, a tab hosting a run is judged by its own origin; a worker-driven
      run's python_exec over a page table, `fetch_url` session render with an `ask`, and sealed describeElement run in
      the worker (`pageRead`, `worker-page-read.ts`); red-team tests for every former run-tab type, the hand-over that
      cannot be stopped, and the upgrade; attack 9 closed: #611.
- [x] A tool call that throws anywhere in its dispatch (delegateTool's setup on an odd argument, a page's malformed
      envelope, an isolated world's odd return, auto-approve, the precheck, the gate and its bookkeeping) is an error
      result the model reads, or a gate for a step that only decides, and a `tool`/`threw` record in the execution log;
      it no longer ends the run. A throw while the run is cancelled still ends it (redteam-tool-throw.test.mjs,
      agent-loop.test.mjs "a dispatch that THROWS"): #618.
- [x] Attack 18: the shell resolves a highlight's selector in its isolated world and takes `ML_HL_AT` only for a
      current `@pt`/`@box` token request, so the page neither hears the selector being approved nor moves the approve
      highlight or the card's note; positive control in the light DOM and the page's open and closed shadow roots
      (site-access.spec.mjs, attack 18): #617.
- [x] A page's START_RUN `maxSteps` is clamped (`pageStartPayload` takes `stepBudget`) and its `origin` is dropped, so a
      page cannot stamp its prompt as an extension surface: #579.
- [x] A page-built run whose site is revoked while it runs, with no navigation, is handed to the worker (owner's
      decision 2026-10-12): every path that changes the approved set (popup, DevTools Settings, a denial, another
      surface or a sync, the whitelist) decides at the storage event; every send decides again, and a call built for the
      page is built again if the hand-over lands first; the decision is stored at once and survives an eviction;
      `VALUE_COLUMNS` is refused to an unapproved page; red-team: a revoked page flooding sends cannot stop or delay
      it: #621.
- [x] An error's text no longer carries the server URL, the API key or the model filter to a page (every page-started
      answer and the stream port, `forPage`) or to a worker-hosted run's model (every tool result, `forModel`); the
      person's extension pages and the execution log's `key` keep it; `SET_MODEL` no longer lists the models the filter
      hides. Every page-started type is walked under three backend failures (`tests/error-scrub.test.mjs`): #620.
- [x] A run the worker holds at the end of its turn, built by it or handed it (a navigation, a revoke), sends its page a
      finish with the run id alone: the run's summary used to ride it into the page's world; the page answers nothing
      the worker reads. A page's START_RUN or RESUME_RUN waits for the run restore before it is judged, so a message
      that wakes the worker cannot start a turn in a worker run. `ml_handed_to_worker` never drops an entry for a run
      the worker still holds (the cap used to drop the oldest, live ones included). The eviction test seam forgets the
      in-memory hand-overs, as an eviction does: #625.

- [x] What a page can do with the render descriptors it answers a worker-built or page-built run's call with
      (`renderOut`/`renderIn`, `answerMedia`, `image`/`images`, table columns), once the loop makes them a pointer
      (redteam-render-values.test.mjs): a `value` key naming another run's stored table, or (for a worker-built run) one
      disclosed to the page, is no longer claimed by the run (`runMayClaim`); a page's `PYTHON_EXEC` no longer reads a
      worker-built run's value by naming its key; a picture in a page's render no longer becomes an image pointer that
      `look` shows a reader as an earlier capture (`withoutPageVision`). Held already, now tested: a page cannot
      overwrite, re-point or relabel an existing pointer, its `:in` slot is the model's call, answer media and inline
      images do not reach a worker-built run, odd tables leave the worker's prototypes alone, and the sidebar draws every
      descriptor field as text: #626.
- [x] The self-approval whitelist (`pageApprovalDomains`) is read by origin at every reader: `senderTrust` (`CDP_CLICK`,
      `SERVER_TOOL_EXEC`, `FETCH_SHEET`, full-mode `PYTHON_EXEC`, `FETCH_URL`, a worker run's fetch, sheets and Python),
      `pageApprovalAllowed` (`GET_CONFIG`, the worker's config) and the gate's implied approval go through one rule
      (`selfApproves`), so plain http, another port, a subdomain or a sub-frame of a whitelisted host no longer gets the
      https site's self-approval, and the gate no longer implies approval for another port. Tested as a table over sender
      shapes x readers, with the upgrade from a stored list of hosts (self-approval-origin.test.js): #628.

## In progress

(none)

## Known open

- [ ] Stylesheet timing: a page can move our host or `<html>` through a CSSOM edit made after one frame read and undone
      before the next. Closed for the HOSTS by their inline `all: initial !important` (`HOST_STYLE`, shell-shot.ts),
      which beats every page stylesheet `!important` rule, layered or not, and animations: no page rule moves, zooms,
      filters, reflects, clips, blends or hides a host, timed or not (review-look.spec.mjs, "our hosts pinned"): #581.
      - [x] Top layer: the hosts are `popover="manual"` and shown, so no page z-index covers them; a page modal,
            fullscreen element or popover opened after ours is answered by raising ours again, and the page's
            `hidePopover()`, attribute removal or change, or a cancelled show by restoring ours, all within one budget;
            a host kept out of the top layer refuses the shot as tampered (review-look.spec.mjs, "the top layer";
            shell-top-layer.test.mjs): #599.
      - [x] Closed shadow roots (owner decision 2026-10-10): all three roots are `mode: "closed"`, so the page cannot
            put a `:host{…!important}` rule inside one (a stylesheet, an adopted sheet or a CSSOM edit of ours), nor
            reach our nodes or the card's iframe. The page holds no handle on a root by any path (host, global,
            expando, event path, mutation record, focus, selection, hit test, the test hook); the card app's theme post
            to `window.parent` and the page-started `CDP_SHADOW_RESOLVE` descending into our hosts, both of which
            bypassed it, are shut, and so are the resolver keyed on a host id the page can rename (17c) and a drag out of
            the lightbox (17d) (site-access.spec.mjs, attack 17; review-look.spec.mjs, "does not get in";
            background.test.js, "never descends into the shell's own host"): #610.
      - [ ] `<html>` (the page's own element) stays open: a timed edit to it is seen only by a frame read.
      - [x] Review of #599: a host removed and put back is restored at once (child-list watch); the page re-showing
            one of our hosts is restacked; the keeper's listeners outlive an unmount, so a page listener added between
            two mounts runs after ours; a host out of the top layer only for each frame's paint refuses the shot
            (`strays`). review-look.spec.mjs, "What the first version missed".
      - [ ] A page element put in the top layer from a CLOSED shadow root of the page's, or whose `toggle` event a
            page listener added before the content script loaded stops, is not noticed until something else asks for a
            raise. It paints over our UI with
            `pointer-events: none` and the clicks reach ours (clickjacking the card). Proposed: an occlusion check on
            the approval controls (IntersectionObserver v2 `trackVisibility`), refusing a click while they are covered.
- [ ] A page's `renderOut`/`renderIn` still render in a worker run's sidebar step (human-facing only, drawn as text;
      pictures are dropped since #626).
- [ ] A page's answer to a delegated call is kept whole: its render in the step's pointer (a 300,000-row table, a 20 MB
      capture) and its text result, which also reaches the model unclipped. Bounded only by Chrome's 64 MiB message cap
      and the pointer store's 200 entries. Owner decision on the bound (redteam-render-values.test.mjs, the `todo`).
- [ ] An off-viewport locate scope reports "the vision call errored" instead of saying the scope is off screen.
- [ ] Error text that reaches the page outside `forPage`: `VALUE_COLUMNS` errors and the `PYTHON_STREAM` and
      `SERVER_TOOL_STREAM` frames (content.ts). None is built from the config today.
- [ ] Site access slice 3 (`requestAccess`, the agent level and its start card, the self-approval list by origin;
      decided 2026-10-13, built in the PRs of [../spec/SITE_ACCESS_SLICE3.md](../spec/SITE_ACCESS_SLICE3.md)), slice 4.

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
