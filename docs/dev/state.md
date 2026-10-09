# Where state lives

Everything in the extension that outlives a single call: what it holds, how long it lives, where it is kept, and
whether the state inspector shows it ([`../spec/STATE_INSPECTOR.md`](../spec/STATE_INSPECTOR.md)). Read it before adding a
new store, so it lands in a scope that already exists and does not become a fourth copy of something.

Built from a survey of the code on 2026-10-08 (raw reports in `tmp/state-survey/`, not committed). Line numbers drift,
so names are the reference. UI state (what is open, hovered, scrolled: about 150 signals) and device preferences
(about 55) are counted, not listed: they are not a run's state.

**Adding state?** Declare it where it lives with `defineState` (`src/state-registry.ts`): its scope, realm, audience,
what loses it, and a `read` that returns plain data for one run. The inspector lists what is declared. State that is not
a run's (a cache, UI, in-flight plumbing, a lookup table) gets a `// state: cache|ui|plumbing|fixed|test` marker instead.
`node scripts/check-state.mjs` asks about every store a change adds (`working-in-the-repo.md`). A store with no
declaration yet still gets a row here.

## Where a value can live, and what kills it

| Place | Survives | Lost on |
| --- | --- | --- |
| service-worker memory (`src/sw/`, `src/agent/` run closures) | nothing | an MV3 worker eviction (idle ~30 s), an extension reload |
| page memory (`injected.ts`, `src/ml/`, `src/tools/`) | nothing | navigation, reload, tab close |
| offscreen memory (Pyodide, the archive worker) | nothing | the offscreen document closing, a watchdog kill |
| `chrome.storage.session` | worker eviction | browser restart |
| `chrome.storage.local` | restarts | uninstall, explicit removal |
| `chrome.storage.sync` | restarts; syncs across the person's browsers | uninstall |
| IndexedDB (extension origin): `ml-values`, `ml-saved-sessions`, `ml-hub-keyring`, `ml-archive-folder` | restarts | budget and retention eviction, uninstall |
| OPFS: the session archive (`archive.sqlite`) | restarts | uninstall |
| `localStorage` (extension pages, chat page) | restarts | clearing site data |

## Run state

What one run carries. "Host" is where the agent loop runs: the worker for a background-hosted run, the page for a
page-hosted one. Several stores exist once per host.

| State | Where | Persisted | Inspector member |
| --- | --- | --- | --- |
| Start payload: task, system prompt, tools, model, max steps, auto-approve flags | `bgRuns[runId].p` (`sw-runs.ts`); page: `toolCtx`, `AgentControl` | `ml_bgrun_<runId>` while live (deleted when the run settles); session store `history` if saved | `init`, `input` |
| The live context (`messages`) and per-message `meta` | the loop's closure (`agent-loop.ts`) | per-step checkpoint into `bgRuns` / `ml_bgrun_*`, without meta | `messages` / `meta`. **The background host does not pass `contextSink`, so a background run's context cannot be snapshotted yet** |
| `@tool:` values | `tokensByRun` TokenStore (`sw-runs.ts`, memory, 200 per session); page-hosted: `control.tokens` | no | `pointers` |
| Large stored values (fetched tables) | `ml-values` IndexedDB (`ValueStore`), claimed per session | yes | `pointers` (the join reads both stores) |
| `@pt` / `@box` tokens | `pointRegistry`, `boxRegistry` (`util.ts`, page) | no; die on navigation, unannounced | `page.points`, `page.boxes` (page realm) |
| The answer set (what the run hands the person) | `answerSets` (`tool-exec.ts`, page), reset each turn | no | `run.answer` (page realm, while a turn runs) |
| Queued steering messages (the mailbox) | background: `runInboxes` (live turn only); page: `AgentControl.inbox` | no | `mailbox` |
| Open approval gates | `pendingApprovals` (`sw-consent.ts`); client mirrors `AgentStep.awaitingApproval`, `SessionSummary.pendingApprovals` | no | `approvals` (new) |
| Model switched mid-run | `runModels` | `ml_run_models` (LRU 200) | `run.model` |
| The run's current tab and URL | `activeRuns`, `tabPageUrl` | `ml_pinned_tabs` (pinned tabs only) | `run` |
| Interrupted / auto-resumed | `hydratedRuns`, `resurrectedRuns` | derived from `ml_bgrun_*` | `run` |
| Delegated sub-call spend | `subTally` / `bgRuns.sub`; page: `subUsage` (`bus.ts`); a worker-built run's worker tools: `runs[runId].spent` (`worker-tools.ts`), reported per call as the envelope's `subUsage` | in `history.sub` if saved | `run` (the model sees it via `chat_metadata`) |
| What a worker-built run's `fetch_url` read (the read-only survey's free re-reads) | `runs[runId].cache` (`worker-tools.ts`, worker memory, frozen copies); page-hosted and approved exec: `mlFetchCache` (`injected.ts`, page) | no; the worker's goes with an eviction (a re-read then asks again) | maybe |
| Execution log | `runLog` (`sw-run-log.ts`) | `ml_run_log` (session storage) | `run.log`, read by the model as `ml.current.log` (no `key`/`tab`/`origin`) |
| Environment: debugger attached, tab pinned, navigation barrier, hub devices granted this session | `attachedDebuggees`, `ml_pinned_tabs`, `navBarrier`, `SessionPublisher.granted` | partly | `run` (new) |
| Docs already shown to the model | `docsMemories` (`tool-exec.ts`, page; a worker-built run's: worker) | no | maybe |
| An isolated exec's `state` | `globalThis.__mlState` in the run's user-script world `wml-<runId>` (`sw-isolated-exec.ts`); a CDP world's dies with the call | no | no |
| Crops already seen (vision) | `VisionMemory`, made FRESH on every re-adopt | no | maybe |
| Process-wide run flags: closed-shadow piercing, CDP clicks | `window.__mlPierceClosed`, `cdpEnabled` (page; the last run to start wins) | no | `init` can disagree with what is in effect |

## Grants: what may happen without asking

| Grant | Where | Lifetime |
| --- | --- | --- |
| Cross-origin navigations approved, which also make fetches to those origins free | `consentedOrigins` (`sw-run-host.ts` closure) | ONE TURN; reset on resume |
| Sheets approved for `python_exec` | `approvedSheets` (`sw-run-host.ts` closure); page: `approvedSheets` (`ml-agent-run.ts`, page-wide) | one turn; page-hosted: the page |
| Sub-operations of an approved call: sheets, Python code, server-tool calls, fetches inside an approved `exec` | `pendingGrants` (`sw-consent.ts`) | ONE DELEGATED CALL. Deleted per TAB in `delegateTool`'s `finally`, so two runs on one tab clobber each other |
| Repeat `ml.fetch` of an approved URL | `fetchConsent` | the tab, until it closes (memory) |
| One credentialed fetch | `credFetchGrants` | one use |
| Remembered `confirm()` decisions | `approveOnce.remembered` (`ml-agent-handle.ts`, page) | the gate |
| `window.ml` on an origin | `ml_site_always` / `ml_site_denied` (local), `ml_site_session` (session storage) | persistent / browser session |
| Implicit: `pageApprovalDomains` (config) | `site-access.ts`, `senderTrust` | persistent |
| Implicit: a tab hosting a run may send non-control page messages regardless of the site lists | `sw-site-access.ts` | while the run is hosted |
| Auto-approve settings | `MlConfig` (sync) | persistent |

## Session state

| State | Where | Persisted |
| --- | --- | --- |
| The session index: summary (title, pinned, status, start model, start page, lineage), event ring, gates, owner tab | `SessionIndex` (`session-index.ts`), `SessionSummary` (`session-host.ts`) | summaries and events of SAVED sessions in `ml-saved-sessions` |
| A finished run's history (messages, payload, sub spend) | session store `history` | `ml-saved-sessions` if saved; otherwise only `bgRuns` (memory) |
| Chats: `createChat` histories | page `sessionRegistry`; worker-hosted `chats` (`sw-chat.ts`, cap 32) | `ml_session_<hash>` and store `history` when `save: true` |
| Page registries of runs and handles | `agentRegistry`, `handleRegistry` (`bus.ts`) | no; they never shrink, so finished runs stay resumable for the page's life |
| Reader-triggered model calls (titles, summaries, annotations) | `asides` (`store.ts`), client-side | no |
| The title | owned by the worker (`titleSession`, `sw-sessions.ts`): kept in the session index, asked of the utility model once; every surface asks it (`SESSION_TITLE`, or `side.call` with purpose `title`) | in `ml-saved-sessions` if saved. A rename on the chat page does not yet reach a sidebar that already shows the old one |

## Page state (one document, every run in the tab)

| State | Where | Note |
| --- | --- | --- |
| `ml.state` | `agentState` (`util.ts`) | shared by EVERY run in the tab; exec's description promises it persists, and a cross-page run silently gets `{}` |
| The `ml.fetch` cache and its `evicted` set | `mlFetchCache` (~64 MB LRU) | lost on navigation; afterwards `python_exec` tables by URL fail with "hasn't been fetched in this run", which is untrue for a run that fetched on the previous page |
| The debug ring | `debugRing` (`bus.ts`, 200) | replayed to a late sidebar |

## Python (offscreen)

One interpreter for every run, serial (`runChain`). `python_exec` runs in the main namespace: the script is the body of
`_user()`, so its names are locals, and `RESET` wipes non-underscore globals before and after each call. The bench
keeps one namespace per mode (`benchNs`), promoting the script's names to globals (`symtable`); its id changes when the
namespace is recreated, which is how a loss is noticed (`benchLost`).

- **Leaks between calls today:** `_`-prefixed globals (a model's own `global _x`) and module state.
- **The tool description contradicts itself:** "ONE cell of a live Jupyter notebook" and "Each call is STATELESS"
  (`python-tool.ts`).
- **Loss:** a watchdog kill (15 s script, 120 s start), a worker crash, the offscreen document closing, an extension
  reload. The housekeeping log records pyodide kills and cold starts with a time and a reason.

The questions for persisting per run are in the spec's "Python state persists per run".

## Copies that can disagree

- **Run history, three:** `bgRuns`, `ml_bgrun_<id>`, the session store's `history`. The step and seq bases reach all
  three only at turn end.
- **Run model, four:** `runModels`, `bgRuns.p.model`, the snapshot's `p.model`, `SessionSummary.model` (keeps the start
  model).
- **The event stream, five:** `runReplayBuffer`, the DevTools `debugBuffer`, the session index ring, the session store,
  the hub publication. Each has its own cap and clearing rule.
- **Approvals:** the real gates (`pendingApprovals`) against the derived `Indexed.gates` and
  `SessionSummary.pendingApprovals`, which diverge after a worker eviction.
- **Page:** `tabPageUrl` against `p.pageUrl` against `SessionSummary.page`.
- **Value claims:** a `ml-values` row's `sessions` (persistent) against `tokensByRun` (memory): after an eviction a row
  stays claimed by a session whose pointers are gone, until release or the idle sweep.
- **The title**: one owner now, but the sidebar keeps the copy it was handed and hears of no rename.

## Lost on a worker eviction

Open approval gates (the loop awaiting them is orphaned); every grant held in memory (`consentedOrigins`,
`approvedSheets`, `pendingGrants`, `fetchConsent`, `credFetchGrants`); `tokensByRun`, so pointers in a resumed context
DANGLE; queued steering (`runInboxes`); completed runs' `bgRuns` entries (a follow-up fails unless the session was
saved); `tabPageUrl`; unsaved sessions' index rows; ephemeral worker chats; the unflushed tail of the logs.

## Never shown

`apiKey`, `chatUrl` (it can carry a token), `modelFilter`, `pageApprovalDomains` (show `publicConfig()` only); the hub
keyring (`ml-hub-keyring`: private keys, the channel key, the account root) beyond what `membershipOf` returns; a
pairing offer's code; the archive folder handle (its name and state only); values in Python's `full` namespace (it can
hold live network handles: neither shown nor evaluated).

## The registry

Each realm's bundle has its own registry (`src/state-registry.ts`); a snapshot asks the realm that holds the run.
Declared so far, in the worker: `run.init`, `run.sub`, `run.model`, `run.interrupted`, `run.mailbox`, `run.pointers`,
`run.page`, `run.messages`, `run.input`, `grants.turn` (`sw-runs.ts`), `run.values` (`sw-values.ts`), `run.approvals`, `grants.call`, `grants.fetch`, `grants.credentialedFetch` (`sw-consent.ts`),
`run.log` (`sw-run-log.ts`), `session.title` (`sw-sessions.ts`), `run.meta` and `run.current` (`sw-runs.ts`). In the page: `run.answer` (`run-delegation.ts`),
`page.points`, `page.boxes` (`util.ts`), and for a page-hosted run `run.messages`, `run.pointers`, `run.mailbox`
(`page-run-state.ts`), asked of the run's tab with `RUN_STATE_IN_PAGE` (`sw-run-state.ts`). An id is unique per realm,
not overall: both hosts declare the same member of a run. Each realm
answers only for the declarations whose `realm` is its own, since a module both bundles load declares in each. A page's
answer is the page's word: the worker sanitizes it (`pageStateFrom`), forces its realm, and takes it for a member id
the worker declares only for a run the session index says the page hosts, where the worker holds nothing
(`withPageState`). `node scripts/check-state.mjs` with no arguments lists the stores that predate the ratchet
and are neither declared nor marked (134 when it was written). This file shrinks to the scopes, the places and the
hazards as the declarations take over its rows.
