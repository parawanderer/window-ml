# Moving a live run to another tab

**Status: design note, nothing built.** Written 2026-11-12 by the async lane, assigned by the coordinator as the lane
closest to it. The owner of the build is OPEN. The decisions below (a move, not a fork; the same runtime only; started
only by the person, from the Commander HUD or the chat page's "move to tab…") are as RELAYED from Shane through the
async lane, pending his confirmation in the coordinator's session, which records them the same way. Nothing here is
built until he confirms there.

## Why

Two cases, both Shane's:

1. **From the HUD or the sidebar.** A person is talking to a run about one page, opens another tab themselves and finds
   a document, a paper or a page they want the model to see.
2. **From the chat page.** The model is on some page; the person opens a new page in another tab and wants the run to
   be on that one instead.

Today the only way is to tell the model "go to this page yourself". That is a round trip the person did not need, the
model has to be given the URL, and a page the person reached by scrolling, searching or filling a form is not the page
that URL opens. The person has already done the navigating: the run should follow them there.

## The decisions

- **A move, not a fork.** The use case is the same as asking the model to open the site, minus the round trip; the run
  keeps its id, its transcript and its worker state, and leaves the old tab. A fork onto the new page (the original
  staying where it was) was considered and rejected for this: it answers a different question.
- **The same runtime only, at first.** A move re-homes a run between tabs of the browser that hosts it. Moving a run to
  a tab of another runtime (another browser, through the hub) is out of scope until this one exists.
- **Started only by the person**, from one of two surfaces they own:
  - **The Commander HUD on the destination page**: "bring a session here", listing this browser's live and resumable
    sessions.
  - **The chat page**: a session's "move to tab…", picking from the runtime's open tabs (`tab-tree.ts`).

  Never by the model (no tool moves a run), and never by a page.

## What moves and what does not

A run the person starts is assembled in the WORKER (`sw-run-start.ts`, docs/dev/agent-tools.md), so almost all of it
already lives off the page:

| Moves with the run | Stays behind, or is lost |
| --- | --- |
| the transcript and the run's messages | whatever the model made in the old page's world: `exec` variables, DOM edits, form input it filled |
| the `@tool:` pointers and their values (`tokensByRun`, worker memory) | a CDP attach to the old tab (detached, logged `cdp`/`detached`) |
| a worker-hosted run's Python namespace | anything bound to the old DOCUMENT: a located element, a screenshot point or box, minted against its `documentId`; each must FAIL as stale on the new page, never resolve against it |
| the task table and its runtime-bound tasks (ASYNC_CALLS.md, rule 4a) | the old page's page-bound tasks, cancelled by rule 4a |
| `ml.current` | a page-built run's custom function tools: as on a cross-page navigation, only the BUILTIN toolset is rebuilt (`_rebuildToolset`) |

## How it would work

A move is close to what already happens when a background-hosted run navigates to another site in its own tab (the
navigation barrier, re-adoption, the hand-over to the worker: docs/dev/agent-tools.md, "Cross-page persistence"), plus
RE-KEYING the run from one tab id to another. The template for the re-keying exists: `chrome.tabs.onReplaced`
(`background.ts`) already moves a run and every tab-keyed map (`retabRuns`, `moveTabKey`, `movePageBuiltTab`) to a new
tab id. A move does the same on the person's word, with these additions:

1. **At a turn boundary.** A move asked for while a page tool is outstanding either waits for the turn boundary or
   cancels the outstanding call with honest text (the cancel-per-executor rule, ASYNC_CALLS.md rule 3); which of the
   two is a decision for the build. It is never applied under a running page call.
2. **The run's inbox is re-keyed** (`runInboxes` carries a `tabId`), so a task's result is delivered to the new tab.
3. **The model is told**, as an inbox item at the next turn boundary: `[the person moved this run to tab "<title>"
   (<url>); the previous page's state is not carried]`. Without it the model acts on a page it thinks it is still on.
4. **The destination need not be approved for `window.ml`.** A run the person starts works on any page; the worker-hosted
   path the hand-over already uses (`nav-handover.ts`) covers a site that may not use it, with the isolated-world
   routing `exec` already has (`exec-routing.ts`).
   The person choosing the tab IS the consent the cross-domain gate asks for (docs/dev/agent-tools.md, "Variant B"):
   the destination's origin joins the run's `consentedOrigins`, and a run that did not opt in with `crossOrigin` is
   moved anyway, because the gate exists to stop a PAGE sending the run elsewhere, not the person.
5. **The old tab is released**: unpinned (`autoDiscardable` back on, logged `tab`/`released`) and left as it is. Its
   page is not reloaded or closed.
6. **The run log records the move** (a `tab` record naming both tab ids), so the person sees where the run went and
   when.

A move off a tab that crashed or stopped answering is the same operation, and the page-health work (the async lane,
2026-11-12) may offer it as the recovery for a dead tab.

## Security

- **A page can never start a move.** Not a page that wants a run's context pulled onto itself, and not one that wants a
  run pushed off it. The move is a message only the person's own surfaces (the Commander, the chat page) send, decided
  in the worker from the sender, never from anything a page says. The red-team row is e3's, written after the feature
  PR merges: a page's message that names a run and a tab moves nothing and is answered with nothing.
- **Moving a run to a page discloses the run to nothing.** The destination page learns no more than it does when a run
  the person started there runs on it: the presence rules (`docs/dev/site-access.md`, "Presence") hold unchanged.
- **The model's text never names the old tab's URL to the new page.** The inbox item is model-facing only.

## Open

- Wait for the turn boundary, or cancel the outstanding call (step 1).
- Whether "bring a session here" lists only this tab's site's sessions or all of them.
- A move between runtimes (another browser through the hub), after this exists.
