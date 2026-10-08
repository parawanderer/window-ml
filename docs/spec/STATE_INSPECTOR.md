# Spec: the state inspector (the run's "kernel variables")

**Status: agreed direction, unbuilt** (Shane, 2026-10-08). It extends two proposals that were written before it:
[`CHAT_PAGE.md`](CHAT_PAGE.md) §The state inspector (the pane, the `session.context` call, the pointer join) and
[`CURRENT_CONTEXT.md`](CURRENT_CONTEXT.md) (`ml.current`, the model's own read of its context). Where this document and
those disagree, this one is newer. Each says so and points here.

## What it is

A pane on the chat page, docked like the execution log and the Python bench (`dock.tsx`), that shows what a run IS
CARRYING right now, the way an IDE's variables pane shows a program's state:

- **Session**: state shared by every language: the context, the pointers, what the run was started with, what is
  waiting to reach it. The same for JS and Python. Mostly read-only.
- **Runtime**: one group per language that keeps state: JS's `ml.state` and, once Python state persists per run
  (below), Python's variables.
- **Watches**: expressions you add, each a read-only transform of anything above.

Everything else on the page replays a LOG (`MlDebugEvent`s). This is the one view of a MUTABLE object, which is why it
has its own call and says when its snapshot was taken (`CHAT_PAGE.md`, "Four things it has to get right").

## One snapshot, three readers

**The inspector draws `ml.current`, plus a human-only part. It does not get a second state API.** `CURRENT_CONTEXT.md`
already says the inspector "is a VIEW of this shape, not a second description of it". This document holds it to that.

- **The model** reads the snapshot from a read-only `exec`, as `ml.current`.
- **The pane** draws it, through `session.context` (`CHAT_PAGE.md`).
- **Python** reads it through an `ml` bridge into Pyodide, once one exists (unspecified; it has to survive the readonly hardening, so it is a mediated callback, never `js`). The shape is plain data for
  that reason (`CURRENT_CONTEXT.md`, "Python parity constrains the shape").

One shape means the model's view and yours cannot drift apart, and that is the reason to have the pane at all. After
compaction or an edit by pointer, the transcript no longer shows what the model carries. The pane is the audit, and an
audit drawn from a different source than the thing it audits is not one.

Each member is resolved only when it is asked for, as `ml.current`'s already are (`CURRENT_CONTEXT.md`, "It is all
RESOLVED UP FRONT"). An unread member costs nothing.

### Every member has an AUDIENCE

`ml.current`'s invariant is that **nothing in it may return anything the running model was not already given**. The
inspector shows you more than that, so every member is one of two kinds:

- **`model`**: in `ml.current` and in the pane. The model was given it, or made it.
- **`human`**: in the pane only. The model was not given it, so showing it to the model would be new information,
  and the invariant forbids that.

The audience is part of the contract, written next to each member below. A member moves from `human` to `model` only
by a decision recorded here.

## The Session group

Each member's status: **exists** (the data is there and needs reading out), **new** (a small derivation of data that
exists), or **slot** (the feature behind it is not built; the group shows a labelled empty row so the shape does not
change when it lands).

| Member | What it holds | Audience | Status |
| --- | --- | --- | --- |
| `run` | id, model, step, max steps, started; the session's TITLE | model | exists (`ml.current.run`); the title is new |
| `init` | the options the run was started with (`AgentOptions` / the `agent.start` payload) | model | new. Never config the page cannot read: `MlPublicConfig`'s omissions stay a security boundary, and no key, no URL |
| `input` | the system prompt as sent, and the tool list as sent (names, descriptions, schemas) | model | new. The run has both; nothing exposes them |
| `messages` + `meta` | the context, verbatim, and what is known about each message | model | exists (#380) |
| `pointers` | every `@tool:` value the run holds: key, size, format, source, age, and whether the current context still REFERENCES it | model | the heap exists (`ValueStore.rows()`); the `linked` join is new |
| `log` | the run's execution log | model | exists (`ml.current.log`) |
| `mailbox` | messages queued for the run and not yet attached to its context (today: your queued follow-ups) | **human** | new. Not `model`: by definition it has not been given to the model |
| `subagents` | runs this run started (`ml.agent()` from `exec`; see [`HEADLESS_AGENTS.md`](HEADLESS_AGENTS.md)): id, task, status, and WHERE it runs | model | slot. A child run does not record its parent today; `{ parent, where }` is the missing piece. `where` is this browser or a runtime on the hub, so a remote subagent needs no new shape |
| `tasks` | tools that detached and will report back (unspecified: a tool that outlives its step and announces itself later) | model | slot |
| `crossPage` | state the run explicitly carried across pages, if it was kept | model | slot, until cross-page persistence says what survives |
| `policies` | access policies the person approved: the run drafts a policy, the person approves it once, and it decides what the run may do on a page (unspecified) | model | slot |
| `hooks` | reusable functions and page hooks the run defined, behind approval (unspecified). These will also get a human-facing UI of their own; this row is the variable view of them | model | slot |
| `grants` | every remembered approval that applies to this run, with its scope (below) | **human** | exists in the worker (`sw-consent.ts`, `site-access.ts`); nothing reads it out |
| `debug.userWatches` | the watches you chose to SHARE (below) | model, by your choice | new |

### `grants`: what the run may do without asking

(Shane, 2026-10-08.) Every approval that is remembered is state: it decides what the next identical call does without
a prompt. They live in the worker (`src/sw/sw-consent.ts`, `src/site-access.ts`), and nothing shows them today.

| Grant | What it allows | Scope and lifetime |
| --- | --- | --- |
| fetch URLs (`fetchConsent`) | `ml.fetch` of these exact URLs again (approve and remember) | the TAB, until it closes |
| Sheets (`pendingGrants.sheets`) | reading these Google Sheets | the tab |
| Python code (`pendingGrants.pyCode`) | running this exact code again | the tab |
| server tools (`pendingGrants.serverTools`) | this server tool with these exact arguments | the tab |
| fetches during an approved `exec` (`fetchOpen`) | the `ml.fetch` calls inside code the person approved | that one `exec` |
| credentialed fetches (`credFetchGrants`) | one fetch as the person, cookies included | ONE use, consumed by the fetch |
| site access (approved and denied origins) | a page on that origin using `window.ml` at all | the BROWSER, persistent |
| auto-approve settings in effect | read-only `exec`, read-only Python, reading the extension's own source | the browser |

**Grants belong to TABS and to the browser, not to runs.** A run that moves between tabs has a different set on each,
and two runs on one tab share one. So the member shows what applies to THIS run right now: the grants of every tab it
acts on, plus the browser-wide ones, each row labelled with its scope (tab, browser, or one use). A grant from another
run on the same tab is shown as that, not as this run's.

**Audience: `human`.** The model asked for the grants it obtained and saw their results, but a grant another run left
on the tab, or an origin approved last week, is information it was not given. Which grants could move to `model` (so
a model stops asking for what it already has) is a later decision, and this is where it is recorded.

**Read-only first, like the rest; revoking is the obvious first write.** Taking back a remembered approval is the one
action every grant row invites. It belongs where the grant is decided (the worker, through the same choke point that
grants it), never in the pane alone.

**The context buffer.** When the message history splits from what is sent (compaction, `AGENT_COMPACTION.md`), the
part that is sent becomes its own member in the same shape as `messages`, and the history keeps the rest. Both stay.

**Finding an old message by pointer.** Every message keeps its stable id (`meta[i].id`) after it leaves the context,
and the id stays a key you can look it up by. A message compaction removed draws as a GHOST row carrying its id, never
as a gap (`CHAT_PAGE.md` already asks for the ghost row). Ids are already "not additive" in `CURRENT_CONTEXT.md`'s
sense: they are right now or never.

**The pointer join** is the row to get right first. "Alive and referenced" versus "alive and no longer mentioned"
says what compaction or a sweep would free, and neither the heap nor the context can say it alone. The join is a scan
of `messages` for `@tool:` references against `ValueStore.rows()`. The token forms are the ones `PIPE_CMDS` and
`TOOL_TOKENS.md` define, told apart by shape.

## The Runtime group

- **JS: `ml.state`**, the run's persistent scratchpad (`MlApi.state`, `contract.ts`). Today it lives in the PAGE and is page-lifetime,
  so the pane reads it from the run's current page: the same page-realm read site-access gates. If cross-page state
  keeps it, it moves to Session's `crossPage`.
- **Python: the run's variables.** Decided: **Python state persists per run** (below). Until it does, this group shows
  the bench's namespace, labelled as the BENCH's, never as the run's.

Values draw with the renderers that exist: the JSON tree, the table view (`TableLike`), and the print boundary's
abridging for anything large. A value is fetched when its row is opened, never with the list.

## Python state persists per run (decided; how is open)

Shane, 2026-10-08: `python_exec` keeps its variables between calls within a run, as models already assume, since they
treat it as a Jupyter notebook. Today every call wipes the namespace (`docs/dev/python-sandbox.md`, "stateless"), and
only the bench keeps one (`benchNs`, one per mode).

**This needs an investigation before a design**, because how data reaches Python and is named there is spread over
several mechanisms that grew one at a time:

- the prelude injecting `img`, `df`, `tables` and resetting them on every call;
- tables passed by pointer (`_loadTable`, `_resolveTable`), and the proposed `vars` argument (passing a JSON value in by name);
- `wrapUserCode`'s return capture and the RESET that wipes non-underscore globals;
- the readonly hardening (purged `js`, nulled network globals);
- the bench's own `persist` path, one namespace per mode.

Questions the investigation must answer before anything is built:

1. **One namespace per run AND per mode?** A `full` call can leave a live handle to the browser's network functions in
   a variable. A later `readonly` call that inherits it is no longer read-only. The bench already keeps one namespace
   per mode for this reason. The run probably must as well.
2. **What the injected names mean on the second call.** `df` and `tables` are reset per call today. Persisting them
   silently would hand a call the previous call's table. Kept, renamed, or scoped to the call is a decision, not a
   default.
3. **Lifetime and loss.** The namespace lives in the offscreen document's Pyodide, which can be restarted or evicted.
   A run that loses its state must be TOLD, not handed a namespace that is silently empty. The pane shows "lost at
   <time>" for the same reason.
4. **Memory.** A persistent namespace holds memory for the run's whole life. Who frees it, and when: run end, session
   close, an eviction rule?
5. **Approval.** Does a readonly call's auto-approval still hold when its inputs include state an earlier, approved
   `full` call wrote?

The Python group of this pane is drawn from whatever that design produces: names, types and shapes listed, and values
fetched when a row is opened.

## Watches

A watch is an expression you add, shown with its current value: VS Code's watch pane.

- **It is a read-only transform.** It is a JSONPath (`ml.jsonPath`, RFC 9535) or a read-only-dialect expression, over
  the snapshot. Both evaluate in the WORKER realm, which has the step budget and no `eval`, and is covered by the
  dialect's halting tests. A watch cannot hang the pane, mutate anything, or reach a page. A watch that falls out of
  the dialect shows its refusal as its value.
- **Saved on this device** by default.
- **Shared with the model**, per watch, by a toggle: an eye icon whose tooltip says "share with the model". A shared
  watch appears in `ml.current.debug.userWatches` as `{ expression, value, at }`. That is a channel from you to the
  model ("look at this"), and it is opt-in for that reason.
- **A shared watch may read only `model` members.** Its value is computed by the same evaluator over the `model` part
  of the snapshot. A watch over the mailbox can be saved, but its share toggle is off and says why, or sharing it would
  leak exactly what the audience rule withholds.

## Where it is offered: the runtime's own machine only

Shane, 2026-10-08: **only on the machine where the run is running.** A phone or another desktop reaching the runtime
over the hub does not get it, for now.

This keeps `CHAT_PAGE.md`'s rule that nothing branches on "is this the local browser". The RUNTIME decides what it
offers. It reports the inspector as a capability to its own extension pages, and `remoteDescription` (`src/hub/runtime/hub-runtime.ts`)
strips it from what crosses the hub. That is the place it already strips other fields, so a remote client never sees
a capability it could ask for. Opening it up later is a decision made there, plus the snapshot's size crossing a seal
(`CURRENT_CONTEXT.md`, Open), and nothing on the client changes.

## A console beside it

You will want to evaluate things against these variables, not only read them. In order of risk:

1. **A read-only console in the worker realm**: the watch evaluator with a prompt. No approval (nothing it can do has
   an effect), no page. It covers most of "let me poke at this".
2. **A console on the run's current page**, for `ml.state` and the DOM. It runs page code, so it goes through site
   access. A person typing is not a model, so it needs no model approval, but the site still has to be granted. It
   follows the run as the run moves between pages.

The Python bench is the Python half of this already. The two are the same kind of tool for two languages.

## Order

1. **Session group from what exists**: `run` (with the title), `init`, `input`, `messages`/`meta`, `log`, `grants`,
   and `pointers` with the `linked` join, in a right-dock pane beside the execution log (the splits from #391 give that
   layout directly), drawn from `session.context`.
2. **Watches**, device-local, then the share toggle and `debug.userWatches`.
3. **The read-only console.**
4. **Python per-run state**: the investigation above, then the design, then the Python group.
5. **The slots** fill in as the features behind them land: `mailbox` (once its audience is settled for subagent
   and cross-agent mail), `subagents` (with `parent`/`where` on a child run), `tasks`, `crossPage`, `policies`, `hooks`.

## Open

- **`mailbox` for agents.** Today it holds only your queued follow-ups, and it is `human`. When it carries subagent
  and cross-agent messages ([`AGENT_MAIL.md`](AGENT_MAIL.md)), whether the run may see what is queued for it before it is attached
  is a decision for that design. The audience column is where it gets recorded.
- **A finished session** has no live run. The pane shows the last snapshot the session kept, labelled with the step
  it is from. What is kept, and for how long, is `session.context`'s question (`CHAT_PAGE.md`).
- **Custom visualisations.** The pane is the debug view; nothing stops a member having a human-facing view elsewhere
  (`hooks` will). Members should stay plain data so those views can be built on the same snapshot.
