# Moving a run to another tab

**Status: design note, nothing built.** Written 2026-11-12 by the async lane, assigned by the coordinator as the lane
closest to it. Shane confirmed the decisions below in the coordinator's session on 2026-11-12 (a move, not a fork; the
same runtime only; started only by the person). The build is the `[window-ml move-run]` lane's, started after this note
and the page-health change land; the chat page's "move to tab…" entry is the Chat Page lane's afterwards. Revised the
same day on the move-run lane's findings against main b7153df8 (the two shapes of a move, per-run re-keying, the grants
that stay behind, a page-built run, the point tokens, the origin consent), and again on its second read (the arrival
watcher, the start-origin rule, what `settle` already released, the sender check).

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
  keeps its id and its transcript, and leaves the old tab. A fork onto the new page (the original staying where it
  was) was considered and rejected for this: it answers a different question.
- **The same runtime only, at first.** A move re-homes a run between tabs of the browser that hosts it. Moving a run to
  a tab of another runtime (another browser, through the hub) is out of scope until this one exists.
- **Started only by the person**, from one of two surfaces they own:
  - **The HUD on the destination page** (the off-mode card and its composer, `hud-card.tsx`): "bring a session here",
    listing this browser's paused and finished sessions (shape (a) below).
  - **The chat page**: a session's "move to tab…", picking from the runtime's open tabs (`tab-tree.ts`).

  Never by the model (no tool moves a run), and never by a page.

## Two shapes of a move, and which ships first

`hostRun` (`sw-run-host.ts`) binds the run's `tabId` ONCE PER TURN: every page send (`toPage`, `delegateSend`), the
run's inbox (`runInboxes.set`), and the turn's `settle` (`untrackRun`, `releaseDebugger`, `watchBetweenTurns`) close
over it, about a hundred uses. Re-keying a map does not redirect a turn that is running. And `settle`, at the end of
EVERY turn, deletes the run's inbox, ends its tasks (`endTasks`) and its Python namespace (`deletePythonRun`). So:

- **(a) A move BETWEEN TURNS. Ships first.** The run is paused or finished; its stored snapshot's tab is re-homed, and
  its next turn is hosted on the new tab from the start. It is cheap, and it covers both headline cases and the crash
  case: a dead tab's turn ends (the page-health work), and the person brings the session to a live tab.
- **(b) A move BETWEEN STEPS of a running turn.** Needs `hostRun`'s tab to become a mutable cell that every send reads
  at the moment it sends, and the inbox re-keyed. An open item, not built in the first PR.

## What a move carries

For shape (a), the turn has already settled, so most of what a turn holds is gone before any move, and the move takes
nothing away from it:

| Carried to the new tab | Already ended by the turn's `settle`, move or not | Stays behind with the old tab |
| --- | --- | --- |
| the transcript and the run's messages (its snapshot) | the run's inbox (`runInboxes`) | whatever the model made in the old page's world: `exec` variables, DOM edits, form input it filled |
| the `@tool:` pointers and values of a worker-held run (`tokensByRun`, memory, as a follow-up keeps them) | its detached tasks (`endTasks`; `ASYNC_CALLS.md`, rule 4) | the per-TAB grants: `fetchConsent` and `credFetchGrants` are consent for the old tab's page and do NOT follow the run (`@security`) |
| `ml.current` | its Python namespace (`deletePythonRun`) | a CDP attach (already released at `settle`, `releaseDebugger`) |
| | its tracking entry and the tab's pin (`untrackRun`; the tab is unpinned and `tab`/`released` logged when it was the tab's last run) | |
| | | point and box tokens: see below |

For shape (b) the middle column is live, so a move between steps would carry the inbox and the runtime-bound tasks,
and cancel the page-bound ones (`ASYNC_CALLS.md`, rule 4a).

**Point and box tokens.** A page-world `@pt`/`@box` token lives in that page's `pointRegistry` (`util.ts`); on another
tab it does not exist and fails as "Unknown point token … may be stale" (`builtin-tools.ts`). A worker-held shot is
stamped with its `documentId` (`worker-tools.ts`, `imageDocument`; `python-tool.ts`'s `mintVia` pins it). Either way a
token from the old page fails on the new one and never resolves against it.

**A page-built run.** Its `@tool:` values sit under `pageValueSession(tabId)` (`"page:<tabId>"`, `sw-runs.ts`), keyed by
the tab. A move first hands such a run to the worker (`makeWorkerRun`, as `nav-handover.ts` does at a navigation onto a
site that may not use window.ml), then moves it as a worker-held run. Its custom function tools do not survive, as on a
cross-page navigation: only the BUILTIN toolset is rebuilt (`_rebuildToolset`).

## How it would work (shape (a))

The re-keying is PER RUN, between two LIVE tabs. `chrome.tabs.onReplaced` is not a template for it: it is per TAB
(`retabRuns` in `sw-runs.ts` moves every run under the tab, with the replay ring, `readoptPageInfo` and `tabPageUrl`;
`background.ts` moves `fetchConsent`, `credFetchGrants` and `debugBuffer`; `moveTabKey` in `tab-replaced.ts` OVERWRITES
the destination's entry), and it also calls `sessionServer.pageGone` and `navBarrier.forget`, which are wrong for an old
tab that stays open. A move needs its own per-run function:

1. **Re-home one run.** Between turns a move changes exactly these, and nothing else filed under the old tab moves or
   is overwritten under the new one:
   - the stored snapshot's `tabId`;
   - the run's replay ring (`runReplayBuffer`), which is kept between turns only while the tab still holds a
     background run (`tabHasBgRun`);
   - the between-turn ARRIVAL WATCHER: `settle` arms `watchBetweenTurns(tabId, runId)` (`nav-arrival.ts`) on the old
     tab, whose commits would otherwise go on holding or clearing the run, and the next turn's start judges
     `holdStands(tabId, runId)` against that tab's URL. The move re-arms the watcher on the new tab and DROPS any hold
     the old tab's page set;
   - a page-built run's `@tool:` values, through `makeWorkerRun` (above).

   There is no tracking entry to move: `untrackRun` removed the run at `settle`. The per-tab grants stay where they are.
2. **The model is told** in the next turn's messages, since a settled run has no inbox: `[the person moved this run to
   tab "<title>" (<url>); the previous page's state is not carried]`. Without it the model acts on a page it thinks it
   is still on.
3. **The destination need not be approved for `window.ml`.** A run the person starts works on any page; the
   worker-hosted path the hand-over already uses (`nav-handover.ts`) covers a site that may not use it, with the
   isolated-world routing `exec` already has (`exec-routing.ts`).
4. **The person choosing the tab is the consent the cross-domain gate asks for** (docs/dev/agent-tools.md, "Variant B").
   `consentedOrigins` is turn-local, seeded from `runOrigins(runId)` and the run's stored `pageOrigin`; the move
   calls `grantRunOrigin(runId, <destination origin>)` (`worker-tools.ts`), which outlives the turn, and REWRITES the
   stored `pageOrigin`, with the stored `pageUrl` and `pageTitle` (`run-assembly.ts`), to the destination. That also
   moves the START-ORIGIN read rule (`startLeftWhy`/`startOriginRead`, `sw-run-host.ts`): after the move the
   destination is the origin whose uncredentialed reads ask once the tab leaves it, and the old origin stops counting
   as the start. An origin the run was granted by an earlier consent stays granted, as it does today. A run that did not opt in with `crossOrigin` is
   moved anyway: the gate exists to stop a PAGE sending the run elsewhere, not the person. (`@security`)
5. **The old tab is left as it is.** Its page is not reloaded or closed. The move does not re-pin it and sends no
   `pageGone` for it; its pin was already released at `settle` if this was its last run. The next turn's `trackRun`
   pins the new tab.
6. **The run log records the move** (a `tab` record naming both tab ids and the run), so the person sees where the run
   went and when.

## Known gap, not caused by a move: `onReplaced` during a live turn

Same cause as shape (b): a `chrome.tabs.onReplaced` while a turn runs leaves the turn sending to the removed tab id,
since `hostRun` closed over it, and `retabRuns` never touches `runInboxes[run].tabId`, so a person's steering message
from the restored tab is dropped by the inbox's tab check (`background.ts`). Untested today. The move-run lane writes
the failing-first row in its own PR.

## Security

- **A page can never start a move.** Not a page that wants a run's context pulled onto itself, and not one that wants a
  run pushed off it. The move is a message only the person's own surfaces (the HUD, the chat page) send, decided in the
  worker from the sender, never from anything a page says. The HUD runs `sidebar-app` in an EXTENSION iframe
  (`services-ext.ts`), so the worker proves the sender by an extension-origin `sender.url`, as `SET_APPROVAL` does;
  and the move's message type is never listed in `HANDLE_MAP` (`page-relay.ts`), so no page's message is relayed to it.
  Those two are what make this hold. The red-team row is e3's, written after the feature PR
  merges: a page's message that names a run and a tab moves nothing and is answered with nothing.
- **The per-tab grants stay behind** (step 1), and the old origin is not carried as the run's start (step 4).
- **Moving a run to a page discloses the run to nothing.** The destination page learns no more than it does when a run
  the person started there runs on it: the presence rules (`docs/dev/site-access.md`, "Presence") hold unchanged.
- **The model's text never names the old tab's URL to the new page.** The note to the model is model-facing only.

## Open

- Shape (b), a move between steps of a running turn: `hostRun`'s tab as a mutable cell, the inbox re-keyed, and rule
  4a's cancels.
- Whether "bring a session here" lists only this tab's site's sessions or all of them.
- A move between runtimes (another browser through the hub), after this exists.
