# Spec: sites get `window.ml` only when someone said yes

**Status: building.** Hostile-site suite first (#373, every attack shown working against the old build); slice 0
(#374) and slice 1 (origin gate, lists, settings) built; slices 2 to 4 not started. Written 2026-10-06. Supersedes the idea recorded on 2026-07-29 (a consent prompt only
when the extension holds "on all sites"): this gates every site, whatever the browser's site-access setting is.

## The problem

`content.js` injects `injected.js` into every page the extension can reach, so every page gets a working
`window.ml`. The background already refuses the dangerous gains (the API key, the user's cookies, the debugger, a
self-approved tool: [`CHOKEPOINT_CONSENT_SPEC.md`](CHOKEPOINT_CONSENT_SPEC.md), `tests/redteam.test.js`). What any
page can still do, silently:

- **Spend the user's models.** `ml.chat` and `ml.agent` reach the configured backend: local GPU time, and real money
  where OpenWebUI routes a model to a paid API.
- **Read what the backend has.** The model list, the public config subset, VRAM state.
- **Tell that the extension is installed**, by checking for `window.ml`.

None of that needs a capability the page lacks. It needs the user's backend, and the page should not have it unless
the user said so.

## The rule

Every message a PAGE starts is refused by the background unless the page's origin is approved. The check uses
`sender.origin`, which the browser sets and a page cannot forge, at the one place every page message passes through
(the router in `background.ts`), before any handler runs. Nothing page-side is trusted to enforce it: `injected.js`
runs in the page's own world, so the page controls anything written there.

Three kinds of caller, the same tiers `senderTrust` already has, with a new meaning for the middle one:

| Caller | How it is recognised | What it may do |
| --- | --- | --- |
| Extension surface (sidebar, popup, chat page, DevTools) | `sender.tab == null`, extension origin | Everything, as today |
| Approved origin | `sender.origin` is on the approved list | Everything a page may do today. The existing per-call grants still apply on top |
| Any other page | Everything else | Nothing it starts. It may answer a tool call the background sent it, once ([runs](#runs-on-pages-that-are-not-approved)), and ask for access ([requesting access](#requesting-access)) |

`pageApprovalDomains` (sites trusted to supply their own approval gate) stays a separate, narrower list. Being on
it implies approval; approval does not imply it.

**Never grantable:** an opaque origin (`null`: sandboxed iframes, `data:`, `about:blank` documents), any non-http(s)
scheme, and any frame that is not the top frame. A cross-origin iframe never inherits its parent's approval.

### The approved list

- Keyed by ORIGIN (scheme, host, port), not by host: `http://example.com` and `https://example.com` are different
  decisions, as they are for the camera.
- Two scopes, like the browser's own permission prompts: **this session** (`chrome.storage.session`, gone on browser
  restart) and **always** (`chrome.storage.local`). Not `sync`: whether `sync` reaches other machines depends on
  the browser's own account sync, which differs between Chrome and its forks, and a decision about this browser's
  backend has no business following anyone to a machine with a different one.
- A DENIED list beside it, same keying, always persistent. [Requesting access](#requesting-access) reads it.
- Edited in two places, per the repo's settings rule: **DevTools Settings** (the full list, with revoke and
  un-deny) and the **toolbar popup** (the current tab's origin only: allow for session, allow always, deny,
  revoke).
- A revoke takes effect on the next message, with no reload: the check reads the list on every call. Calls already
  in flight finish.

## Runs the user starts are built in the worker (slice 0)

Added while building, after the rest of this spec was written. It is a precondition for everything below.

### The gap

Every run the USER starts on a page, rather than a page starting for itself, was ASSEMBLED in that page's own world:
the HUD Commander, the chat page's `agent.start`, Continue (+N), a follow-up turn, adopting a stored session onto a
tab. The shell posts `__mlStartAgent` (or `__mlSessionSend`, `__mlContinueRun`, `__mlAdoptSession`) into the page,
and the page's `ml.agent` builds the toolset, the system prompt and the task, then sends `START_RUN`. Two
consequences:

- **The page decides what the user's run is.** It sees the start message first (its own scripts register listeners
  before `injected.js` does) and can change the task, the tools or the system prompt. Attack 12 does exactly that
  against the old build. Approving or not approving the page changes nothing here.
- **The origin gate would break the Commander everywhere.** A plain gate refuses `START_RUN` from an unapproved
  page, so the user's own run could not start on any site they had not approved, and the run's pre-start probes
  (`GET_CONFIG`, `MODEL_CAPS`) would fail too.

Four ways out were weighed: a one-time ticket that let the page start one run after a user action (keeps the hijack),
approving a site when the user runs the agent on it (lends the page the API, which this spec rejects), refusing the
Commander on unapproved sites (the literal reading, and a large regression), and building the run in the worker.
The owner chose the last, on 2026-10-06.

### The design

**What the page supplies, and what it never does.** The page runs the tools and answers one question at start: its
own page context (URL, title, language, time, locale), the text `pageContext()` already produces. It never supplies
the task, the model, the system prompt, the toolset, or anything that decides approval. Its page context is page
data, exactly as a tool result is: a hostile page can lie in it, which is the prompt-injection problem approvals
exist for.

**One assembly, two hosts.** The code that turns options into a run (which tools, which vision reader, the grounding
model, the server-tool bundles, the unattended and tool-token shaping, the system prompt) moves out of
`ml-agent-run.ts` into a module both hosts call with an `ml` of their own. The page passes its `window.ml`; the
worker passes an adapter whose `config`/`capabilities`/`models`/`serverTools`/`chat` call the worker's functions
directly and whose tool factories are the SAME factories the page uses. The factories need no DOM to build a tool
(checked: they run in plain Node), so the descriptors the worker sends the model, approval flags included, come from
the code the page runs, and there is no second copy to drift. A builtin tool's `run` is never called in the worker;
a remote tool's is (below).

**Starting.** The worker mints the run id, assembles the run, then pushes the run's `RebuildConfig` into the tab:
the same adopt a navigation already uses (`_adoptRun`), sent instead of asked for. The page registers the builtin
toolset under the run id and answers with its page context; the worker folds it into the system prompt and starts
the loop it already hosts. The URL and title in the run's provenance are read from `chrome.tabs`, which the browser
sets, not from the page.

**Remote (server) tools run in the worker.** A run's server-tool bundles are executed by the worker
(`sw-tools.ts`), not delegated to the page: the page would otherwise have to fetch the tool list itself, which is a
backend read, and a remote call's arguments leave the machine, which is not a page's business.

**Entry points.** The HUD composer, Continue, a follow-up turn and steering go from the extension's own frame (the
card or overlay app, an extension origin) straight to the worker. The chat page's `agent.start` and adopting a
stored session call the worker's start directly instead of relaying through the page. A console `ml.agent()` on an
approved page keeps its page path: the page asked for that run, and its options (custom tools, a custom system
prompt, `approve`, `onStep`) only exist there.

**What does not change.** The loop, the approval gate, delegation and its navigation barrier, the run's events and
how every surface renders them.

## Runs on pages that are not approved

A run started from an approved page or from an extension surface can navigate to any page, and its tools have to
work there. The obvious fix, approving the tab for the run's duration, would hand the page the whole API while the
run is on it, since the page shares the world `window.ml` lives in. So a run grants nothing to the page. What it
grants is to the BACKGROUND: permission to send this run's tool calls into that tab.

- **Calls flow one way.** The background sends a tool call into the tab (`RUN_TOOL_IN_PAGE`, through
  `delegateSend`), carrying a one-time token. The page's only accepted message is ONE answer to that token. A second
  answer, an answer to a token never issued, and an answer after the run ended are all dropped.
- **Nothing privileged ever sits in the page.** A page that hooks `postMessage`, patches prototypes and records every
  token it sees still has no message the background will honour, except a single answer to a question the background
  asked. A forged answer can only misreport the page's own content, which the page can already do by changing its
  DOM. That is the prompt-injection problem, which approvals exist for, not a new capability.
- **The vision tools' model calls move to the background.** `look`, `locate` and `verify` currently call `ml.chat`
  from inside the page ([builtin-tools.ts](../../src/tools/builtin-tools.ts)). On an unapproved origin those calls are page
  messages and would be refused, and an exception carved out for them is one the page could ride along on. The
  background already takes the screenshots, so the split is: the page does DOM work and returns data, and the
  background makes every model call. This refactor is most of the work in this spec.
- **What the page still sees, by construction:** whatever the run sends into it. Code `exec` runs there, text
  `type` enters there, and any argument carrying data from an earlier page. The README says so.

## Requesting access

A page that is not approved gets a stub in place of the API: `window.ml` with a single method,
`ml.requestAccess()`, and nothing else. Every other member is absent, not throwing, so feature detection works:
`typeof ml.chat === "function"` is the test for "I may use it".

```ts
const r = await ml.requestAccess({ reason?: string });   // reason: shown to the user, plain text, max 200 chars
// r: { state: "granted" | "denied" | "pending" | "refused", reason?: string }
```

The rules, all enforced in the background (the stub only posts the request):

1. **One prompt per origin, ever.** The first request from an origin creates one pending entry. Every later
   request from that origin, from any tab, before or after a reload, resolves with the current state and shows
   nothing new.
2. **A denial is final.** Denied origins resolve `{ state: "denied" }` at once, forever, with no UI. Only the user
   can lift it, from DevTools Settings. A page cannot tell "denied by the user" from "denied by default".
3. **It needs a real user gesture.** The content script, in its isolated world where the page cannot tamper with
   it, checks `navigator.userActivation.isActive` before relaying. No gesture: `{ state: "refused", reason:
   "needs a user gesture" }`, and no entry is created. That stops a page asking on load.
4. **Top frame, http(s), non-opaque origin only.** Anything else is `refused` and creates nothing.
5. **It never takes focus.** No window, no popup opening by itself. A pending request shows as a count on the
   toolbar icon's badge and as an entry in the popup, where the user allows or denies it.
6. **It cannot flood the list.** Requests are throttled by registrable domain (eTLD+1), not origin, so rotating
   subdomains of one site counts as one requester: at most one pending entry per registrable domain, at most 5
   pending entries in all. Past either cap, the request is `refused` and nothing is created. A pending entry
   nobody answers expires after 7 days (decided), and the origin may then ask once more. That is the only way to ask twice.
7. **What the user sees is the origin, verbatim, and the reason as plain text.** Never a title or favicon the page
   supplied. The reason is escaped, truncated, and labelled as the site's own words.

`granted` takes effect without a reload: the content script swaps the stub for the full API on the state change.

The stub means an unapproved page can still tell the extension is installed. That is the cost of letting pages
ask, and it is a setting: **"Let sites ask for access"** (default on, decided). Off, unapproved pages get nothing at all,
and approval happens from the popup only.

### The self-approval whitelist (slice 3; DRAFT, wording for the owner to approve)

Agreed with the owner on 2026-10-06, after slice 1: the whitelist (`pageApprovalDomains`, "sites trusted to supply their
own approval gate") gets the same treatment as the approved list, and an approved site may ask for it.

**What it grants, which is why it is separate.** Plain approval lets a page spend the person's models. Self-approval lets
the page's own `approve()` stand in for the extension's approval card: it can approve its own `exec`, clicks and typing,
`python_exec` in full mode, and fetches made with the person's cookies. Those are the gains `tests/redteam.test.js`
lists. It is a decision to let a site act as the person with nothing in between.

**Keyed by ORIGIN.** Today it is keyed by host, so a host on it is trusted over plain `http://` too, where anyone who can
tamper with the connection can be that host. It moves to origins. Upgrade: each existing host becomes its `https://`
origin only, and `http://` has to be added explicitly. A fixture test reads a stored host list written by the old code
and asserts what a person sees after the upgrade.

**Asking for it.** `ml.requestAccess({ level: "self-approve", reason? })`, with every rule of plain requesting above, and:

- Only from an origin that is ALREADY approved. An unapproved site asks for plain access first, so a site can never jump
  straight to the stronger grant.
- Always (no "this session"): it is a standing trust decision, and a session-scoped version would mostly teach people to
  click through it.
- Never one click from the badge: the popup entry opens a confirmation that names the grant in words. Draft:

  > **evil.example wants to approve its own actions.**
  > If you allow this, the site can run code, click and type on your behalf, and fetch pages using your logins, without
  > asking you each time. Only allow this for a site you control or fully trust.
  > The site says: "reason, as plain text"
  > [Deny] [Allow]

- A denial is final, as for plain access.

### Detection, honestly

Removing `window.ml` is not invisibility. Two other signals exist today, and this spec does not remove them:

- `injected.js` and the sidebar files are web-accessible to `<all_urls>`, so a page can probe for them by URL. Set
  `use_dynamic_url: true` on those entries, which makes the URL change per session.
- `shadow-patch.js` runs in the page's own world on every page at `document_start`, because it has to patch
  `attachShadow` before the page's code runs, so the agent can see closed shadow roots. A page can detect the patch.
  Limiting it to approved origins would break the agent on unapproved pages a run visits. Open question below.

The goal of this spec is that an unapproved page gains no capability. Not being detectable is a separate goal, and
only partly met.

## Upgrading an existing install

Out of scope for now: the only install is the author's. The one step kept is seeding the approved list from
`pageApprovalDomains` on first start, because it is three lines and those sites are already trusted for more than
this. If the extension ever has other users, the upgrade (what breaks for an existing userscript, and the notice
that explains it) needs its own design and a fixture test, per the repo's rule on testing upgrades.

## Tests

The tests are part of the design. Every claim above has a test that tries to break it.

### Unit and red-team (node:vm, `tests/redteam.test.js` and a new `tests/site-access.test.mjs`)

- **Enumerate, do not sample.** For every key of `HANDLE_MAP` (read from the module, so a message type added
  tomorrow is covered without editing the test), plus the streaming port and `ABORT_REQUEST`: refused from an
  unapproved origin with no run, and refused from an unapproved origin while a run is driving that very tab.
- Every non-grantable sender is refused even when its host is on the approved list: an opaque origin, a sub-frame,
  a non-http(s) scheme.
- Delegation tokens: a forged token, a reused token, an answer after the run ended, after a cancel, and after
  `chrome.tabs.onReplaced` moved the run to a new tab id. All are dropped, and none produces a model call.
- The request state machine, as a pure module: one entry per origin, denial is final, the registrable-domain and
  global caps, expiry and the single re-ask, revoke without reload.

### The hostile site (new e2e suite, `tests/e2e/site-access.spec.mjs`, genre `security`)

A mock website whose only job is attacking this surface, served by the e2e harness under several hostnames that
Chromium resolves to the local server (`--host-resolver-rules`): `evil.test`, many `sNN.evil.test` subdomains,
`approved.test`, and `frame.test` for cross-origin iframes. It runs against the fake LLM, and the main oracle is
**`fake.calls()`: no model request reaches the backend that a run did not make itself.** An attack counts as failed
only when the page saw a refusal AND the fake backend saw nothing.

The attacks, each its own test:

1. Call every `window.ml` method from an unapproved origin, including the ones the stub does not define, through a
   copy of the full `injected.js` the page loads itself.
2. Skip `window.ml` and post every raw request type to the content script.
3. Call `requestAccess` 1,000 times: one pending entry, badge count 1.
4. Call `requestAccess` on load with no gesture: refused, nothing created.
5. Rotate 50 subdomains, each asking once after a gesture: one entry for `evil.test`, the rest refused.
6. Ask from a cross-origin iframe, a sandboxed iframe and an `about:blank` popup: all refused, nothing created.
7. Get denied, then retry after a reload, in a new tab and in a new window: `denied` at once, and no UI.
8. Get approved, get revoked, keep calling without a reload: refused from the revoke on.
9. **Catch a run in progress.** An approved page starts a run that navigates to `evil.test`, which hooks
   `postMessage`, `EventTarget.prototype.addEventListener` and every `window.ml` member before the tools arrive,
   records every message and token, and replays them all. During the run, and again after it ends: the fake backend
   sees exactly the run's scripted calls, and the run's own tool results are unaffected except where the page
   forged an answer to its own token.
10. The same, with `look` on the hostile page: the vision call happens, from the background, and the page's
    attempt to send its own vision call is refused.
11. Mid-run navigation from `evil.test` to `evil2.test`: no grant follows to either page.
12. **Rewrite a run the user started.** The user starts a run on `evil.test` from the HUD or the chat page; the page
    intercepts the extension's start message and changes the task. Added after the spec was written: a user-started
    run was assembled in the page's own world, so the page could rewrite its task, toolset and system prompt.
13. **Cancel a run the page is on**, using the run id that the run's own debug events carry into the page.
14. **Read a run's pointers.** `DEREF_TOKEN` answered anyone who named a run id, and the run id reaches the page in the
    run's own debug events, so a page a run visited could read every value the run captured, including other
    origins' content and credentialed fetches. Found while building slice 0.

The suite was written before any slice landed, against a build that every attack beats. While a slice is open its
tests assert that the attack SUCCEEDS; the slice that closes it flips that, and the same tests then assert the secure
outcome. A security test that has never been seen to fail may be testing nothing.

Nothing here needs a real model or network. A test that passes because the browser was slow is a failure: every
wait is on a run finishing or a state change, never a timer.

## Slices

0. Runs the user starts are built in the worker ([above](#runs-the-user-starts-are-built-in-the-worker-slice-0)).
   Attack 12.
1. The background check and the approved/denied lists, with the settings UI. Unapproved pages still get the full
   `injected.js` but every call is refused. Red-team enumeration tests.
2. Delegation tokens, and the vision tools' model calls moved to the background. Tests 9 to 11.
3. The stub and `requestAccess`, with the badge and popup entry. Tests 3 to 7. The self-approval whitelist moves to
   origins, and an approved site may ask for it ([above](#the-self-approval-whitelist-slice-3-draft-wording-for-the-owner-to-approve)).
4. Not injecting the full API on unapproved pages, and `use_dynamic_url`.

The README's security paragraph changes after slice 2, not before: until then a run on a page still lends it the
API.

## Where the build differs from this spec

Recorded as each slice lands, with the reason.

- **Slice 0 exists.** It was not in the original spec; see [above](#runs-the-user-starts-are-built-in-the-worker-slice-0).
- **A page may not start a turn in, resume or steer a run the worker built** (`isWorkerRun`, refused at the router),
  even knowing its id. Found while building slice 0: the id reaches the page in the run's own debug events, so without
  this the page could put a turn of its choosing into the person's run, with that run's tools, after slice 0 had
  stopped it rewriting the first one.
- **Slice 0: a durable resume is driven by the worker, and the run becomes the worker's.** It used to be the fresh
  page re-driving the run through its resume handle, which is a page driving a run, and which a worker-built run (no
  page-side handle) could not use at all. Found in review.
- **Removed, not gated: `ML_KEEP_SESSION` and the page's `__mlSessionKeep`.** They existed so the page could report
  which session a UI-started run became; the worker now mints that id itself. Any page could post the old message.
- **A step budget a person picks is capped at `MAX_CONTINUE_STEPS` (200) for a start too**, through one validator
  (`stepBudget`); before, only a Continue was capped.
- **Slice 1: a tab hosting a run may send its tools' traffic, whatever its origin.** The spec's slice 1 says every call
  from an unapproved page is refused; built literally, a run on an unapproved page breaks the moment a delegated tool
  makes its own request (a vision tool's model call, a screenshot, `fetch_url`, `python_exec`). Until slice 2's tokens,
  a tab in `activeRuns` may send every page-started type except RUN CONTROL (start, resume, steer, cancel). The red-team
  test asserts both halves. Attack 9 stays open until then. It also keeps a run working on a local `file:` page,
  which is never grantable.
- **Slice 1: `pageApprovalDomains` IMPLIES approval, live, and over https only.** The spec said "seed the approved list
  from it on first start". Reading it at decision time is the same for the one install and stays true when a domain is
  added later. It implies approval for the host's `https://` origin only: the whitelist is keyed by HOST, and implying
  `http://` too would extend a trust that lets a site approve its own tool calls to whoever can tamper with a plain-http
  connection to that host. That http hole exists in the whitelist itself today; slice 3 moves the whitelist to origins
  (below, "The self-approval whitelist").
- **Slice 1: a page's cancel has its own message type (`PAGE_CANCEL_RUN`).** The shell's Stop and the page's cancel
  both arrived as `CANCEL_RUN` from the same content-script world, so the gate could not refuse one without the other.
  This closes attack 13 in slice 1, not slice 2.
- **Slice 1: `DEREF_TOKEN` now answers only the run's own tab.** That narrows attack 14 to the page a run is on; slice 2
  removes the page-initiated read altogether (the values an approved script names are sent with the call).
- **Slice 1: the page's forwarded debug and session events are gated too** (`ML_DEBUG_EVENT`, `ML_SESSION_EVENT`).
  They are page-started, and an unapproved page could otherwise write sessions into the index the chat page reads.
- **Slice 1, found in review: a run a page built is handed to the worker once its tab is on a site that may not drive
  it.** The page that built it is gone, and its follow-up and Continue would otherwise be refused (they are run
  control). The Commander's Pyodide prewarm moved to its own message type for the same reason: the shell shares the
  page's sender.
- **Not fixed, noticed:** `GET_CONFIG` never sent `labelMatch`, so a page-built run always used the default metric.
  `publicConfig` keeps that behaviour; the worker path inherits it.

## Open questions

- **`shadow-patch.js`.** Keep it on every page (detectable, and the agent sees closed shadow roots anywhere a run
  goes), or only on approved origins plus a best-effort inject on run navigation (less detectable, and closed roots
  on a run-visited page are sometimes missed)? Leaning towards keeping it: capability matters more than detection.
- **The page context sits in the system prompt.** A run's "Current page context" is the page's own answer (URL, title,
  language, time), appended to the SYSTEM prompt under its heading, as it always was. A hostile page can put any text
  there, in a position models weigh more than a tool result. Moving it into the first user turn would label it as data
  more plainly, at the cost of changing every run's prompt. Not changed in slice 0.
- **Page-hosted runs.** A run on a `pageApprovalDomains` site runs its loop in the page today, which makes its model
  calls page messages. That is fine under this spec, since the site is approved, but it means that path never gets
  the delegation protection. It stays as is.
