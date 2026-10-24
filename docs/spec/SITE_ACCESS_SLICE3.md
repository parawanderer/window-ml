# Site access slice 3: implementation reference (decided 2026-10-13)

Written 2026-10-13 against origin/main `163f78c5`, with #626 open; the owner's decisions of the same day are folded in.
This is the reference the slice-3 PRs are built from. Nothing here is built yet. It covers the slice-3 items in
[SITE_ACCESS.md](SITE_ACCESS.md): `requestAccess`, the toolbar badge, the popup, moving the self-approval whitelist
(`pageApprovalDomains`) to origins, and the "may start agents" level with its start-approval card. When a PR lands, its
deviations from this file go into "Where the build differs from this spec" in SITE_ACCESS.md.

What to read first:

- **Section 1**: every string the slice ships. The start card's wording (1.1) was approved as written, with the
  budget lines adjusted for the Q2 decision.
- **Section 2**: the decisions, each with its status. "decided" means the owner agreed with the recommendation;
  "(owner, 2026-10-13)" means the owner decided differently from it.

Sections 3 to 5 are the threat analysis, the PR split and the places where the spec and the build disagreed.

## The decisions, in one list

Each one is argued in section 2.

| # | Question | Decision |
| --- | --- | --- |
| Q1 | Does the agent level also cover `ml.agent` loops the page hosts itself (no START_RUN)? | Page-hosted loops stay level 1 but get no backend permissions. `ml.agent({ host: "page" })` is the local loop; without it the run is a worker run and needs the agent level (owner, 2026-10-13) |
| Q2 | Is the step budget per turn or for the whole session? | Per turn. A turn the person drives uses the normal budget. Turns the page drives draw from a separate page turn budget approved on the card (owner, 2026-10-13) |
| Q2a | How does a page-sent turn reach the model? | Marked as the page's, never as the person's; the card shows it with the site's name (owner, 2026-10-13) |
| Q2b | May the page ask for the person? | Yes: the page ends its turn as "waiting for the person", and what the person types is their turn (owner, 2026-10-13) |
| Q3 | Does a later turn that adds tools, changes the model or changes the system prompt ask again? | Yes (decided) |
| Q4 | May the first START_RUN of a run carry `resumeMessages` (a history the page wrote)? | No. Refuse it (decided). If it is added later it must be shown on the card like the system prompt |
| Q5 | How long does an unanswered start card wait? | 3 minutes. An eviction denies it sooner (decided) |
| Q6 | Does self-approval imply "may start agents, always"? | Yes (decided). The use case is personal and local pages scripting the person's own agents |
| Q7 | Where does the start card show? | The tab's HUD card, the overlay sidebar and the DevTools panel. Not the chat page or the phone yet (decided) |
| Q8 | Does a site that keeps getting denied stop asking? | Yes. After 3 denials in a browser session, its starts are refused without a card (decided) |
| Q9 | What happens when the agent level is revoked while a site's agent runs? | The run is cancelled at its next step (decided) |
| Q10 | How is the registrable domain (eTLD+1) found? | Add `tldts`, bundled in the worker only (decided) |
| Q11 | Does a click on the extension's own UI count as the page's user gesture? | No (decided) |
| Q12 | When a site asks for agents too, is "Let it start agents too" ticked by default? | No (decided) |
| Q13 | Does the stub (`window.ml` with only `requestAccess`) land in slice 3 or slice 4? | Slice 4, as the e2e suite already assumes (decided) |
| Q14 | Which storage area holds the self-approval list, and what happens to the popup's editor? | `chrome.storage.local`, keyed by origin. Remove the editor from the popup; DevTools Settings keeps it (decided) |
| Q15 | Do the existing tool gates of page-started runs keep taking focus and approving on Enter? | No. Fix it in the same PR (decided) |
| Q16 | Is "Allow once" the button's label? | Use "Allow this agent" instead (decided) |
| Q17 | What may a page reached by a running agent's navigation do? | Never start an agent and never disturb the driver model. Its request is recorded and shown quietly (owner, 2026-10-13) |
| Q18 | How are the extension's own tools told apart from a site's? | A `defineTool` registry with a ratchet; undeclared means the site's own. Its own PR, before the start card (owner, 2026-10-13) |
| Q19 | How do the lists match origins (#628)? | No loopback special case. A bare entry is `https://host` on the default port; anything else is its exact origin (owner, 2026-10-13) |

## 1. The user-facing text

Notes on the text below:

- **Voice.** It follows the current UI: plain sentences, the origin in `code`, the extension called "window.ml", and
  places named as they appear on screen ("DevTools Settings → Permissions", "the toolbar button").
- **No em-dashes.** New strings use none, following the rule for public-facing text, even though older strings in the
  same views do.
- **Tooltips.** In the panel, card and Settings, tooltips are `cursorTipOn`. An icon-only control also gets an
  `aria-label`. The popup has no panel tooltip, so it uses `title`, as its existing buttons do.
- **Placeholders.** `{origin}` is the origin exactly as the browser reports it (`https://evil.example`). It is never a
  title or favicon that the page supplied. `{host}` is the same origin with the scheme dropped, used only in headings.
  `{reason}` and `{task}` are the site's own text, always shown as plain text.

### 1.1 The start-approval card

**Where it appears:**

- The tab's HUD corner card (`hud-card.tsx`, a new `card-start.tsx`).
- The same body in the overlay sidebar and the DevTools panel transcript (`agent-detail.tsx`), drawn by one component.

**How it behaves:**

- The card never takes focus and has no keyboard shortcut for allowing (see 3.3).
- Its buttons are disabled for 1 second after it appears or its content changes.

| Slot | Text |
| --- | --- |
| Heading (`.action-goal`) | **{host}** wants to start an agent |
| Line under it, dim | Started by this page, not by you. |
| Label above the quote | The task, in the site's own words |
| Quote | `{task}` verbatim, as plain text in a bordered block. Whitespace is kept and nothing is rendered as Markdown or HTML. Bidi control characters are shown as visible `⟨U+202E⟩` marks. After 12 lines the rest folds |
| Fold control | Show all ({n} characters) |
| Only when the site sent `system` or `systemAppend` | The site also wrote instructions the model reads before the task. **Show** |
| Their disclosure | The same quote style, labelled "Instructions, in the site's own words" |
| Label above the tool list | It can: |
| Tool lines | One fixed sentence for each builtin the run has (below). A site's own tools' descriptions are shown as the site's instructions (S2, owner, 2026-10-14) |
| Model line | Model: `{model}` (the model the worker resolved, after the filter) |
| Budget line | Up to {n} steps a turn (Q2) |
| Page turn line | The site may send up to {m} more messages to this agent before it asks again (Q2) |
| Session line, dim | Allowing covers this conversation: the site's follow-up messages to this agent do not ask again until it has sent {m} of them. |
| Gate line, dim | Actions that need your approval still ask you, one at a time. |
| Review | The card lets the person review every parameter the site set, the system prompt included (Q4). Page-side content in the system prompt is kept small |
| Info control (`aria-label`) | What these choices do |
| Buttons, left to right | **Deny** · **Allow this agent** (Q16; the spec's "Allow once") · **Always allow agents from {host}** |

**S2 (owner, 2026-10-14):** a site-defined tool's description and parameters are instructions the model reads, so they
count as the site's instructions: quoted in the instructions disclosure, labelled as the site's own words, and a changed
one asks again (Q3, with the SHA-256 binding). A tool named like a builtin always reads to the model as the extension's
own: its description and parameter descriptions are the extension's, never the page's.

The tool lines, keyed by builtin name. A name the worker does not recognise as a builtin counts as one of the site's own
tools.

| Tool | Line |
| --- | --- |
| `exec` | Run code on this page |
| `click`, `type` (one line) | Click and type on this page |
| `navigate` | Open other pages in this tab, on any site (`crossOrigin` on), or Open other pages of this site in this tab |
| `fetch_url` | Read other websites (it asks you before each new one) |
| `python_exec` | Run Python |
| `look`, `locate`, `verify` (one line) | Take screenshots of this page and show them to the model |
| read-only DOM tools (`find`, `describeElement`, …) (one line) | Read this page |
| `scroll` | Scroll this page |
| `answer`, `dereference`, `agent_api_docs`, `chat_metadata` | none |
| server tools | Use server tools: {name}, {name}. Their arguments leave this machine |
| the site's own tools | Use {n} tools the site defined. They run as the site's own code |

`scroll` has its own line because a scroll acts on the page: it can mark a chat's messages read or load more of a
feed. The tools with no line reach nothing outside the run, the extension and the person; `answer` hands the person
elements of the page. The lines live in the tool registry (`cardLine`, `src/tools/tool-registry.ts`).

The info dialog (`startMechanics()`, built like `approvalMechanics()`):

> **What these choices do**
> - Allow this agent starts this one. The site's later messages to it do not ask again until it has sent {m} of them.
>   Another agent from this site asks again.
> - Always allow agents lets {host} start agents without asking. Turn it off from the toolbar button or in DevTools
>   Settings → Permissions.
> - Deny refuses this start. Nothing runs, and the site is told it was refused.
> - Nobody answering for 3 minutes counts as Deny.

The button tooltips:

- **Deny:** Refuse this start. Nothing runs.
- **Allow this agent:** Start this agent. The site's later messages to it do not ask again until it has sent {m} of them.
- **Always allow agents from {host}:** Let {host} start agents without asking. You can turn this off from the toolbar
  button.

While the buttons are disabled for their first second, they have no tooltip and show no text. This is deliberate: a
countdown would draw the eye to the button.

The card's other states:

- **Expired:** *This request expired, and nothing ran. The site can ask again.* This shows when it timed out, when the
  worker restarted, or when the decision was for a request the worker no longer holds.
- **Asking past the page turn budget** (a message, resume or steer the page sends after it has used the page turns
  approved):
  - Heading: **{host}** wants this agent to keep going
  - Line: It has sent {used} of the {m} messages you allowed and asks to send {k} more.
  - The quote shows the new turn's text, and the buttons are the same.
  - A turn the person drives (a reply, Continue) never shows this card (Q2).
- **Asking for more** (a later turn adding tools, changing the model or changing the instructions; Q3):
  - Heading: **{host}** wants to change what this agent can do
  - The changed lines get a "new" chip; the chip's tooltip says: Not part of what you allowed before.
- **Collapsed HUD pill** (the orb), when the card is minimised: {host} wants to start an agent
- **Queued behind a pending tool approval** on the same card: the start ask waits its turn and shows in the pill as
  "1 more waiting".
- **A page-sent turn in the transcript** (Q2a): the step list and the agent-say bubble carry the site's name, and the
  model reads the turn as "Message from the page ({origin}): {text}".
- **The page waits for the person** (Q2b): the run stops and the card's reply box opens with the page's prompt,
  labelled "The site asks: ({origin})". What the person types is their own turn, on the normal per-turn budget.
- **A page opened by a running agent asks** (Q17): nothing is raised. The run's step list shows one quiet line, and
  the badge counts it: not started: this page was opened by a running agent.

### 1.2 The toolbar badge

**Where it is set:** `chrome.action`, from a new `sw-badge.ts`.

**What it counts:** the pending access requests (from any site) plus the start asks waiting on that tab. It is set per
tab, so a start ask shows only on its own tab.

| State | Badge text | Colour | Toolbar tooltip (`setTitle`) |
| --- | --- | --- | --- |
| Nothing waiting | (none) | | window.ml |
| One access request | 1 | amber | window.ml: {host} is asking for access |
| Several requests | {n} (9+ past nine) | amber | window.ml: {n} sites are asking for access |
| One start ask on this tab | 1 | amber | window.ml: an agent start is waiting for you on this tab |
| A mix | {n} | amber | window.ml: {n} things are waiting for you |

### 1.3 The popup

**Where:** `popup.html` / `popup.ts`.

#### "Waiting for you" block

This block goes at the top of the popup and shows only when something is waiting.

**An access request:**

| Element | Text |
| --- | --- |
| Line | `{origin}` asks to use window.ml. |
| Line, when it also asked for agents | `{origin}` asks to use window.ml and to start agents. |
| Reason line, when there is one | The site says: “{reason}” (escaped, cut at 200 characters, shown in the quote style) |
| Checkbox, when agents were asked (Q12, unticked) | Let it start agents too. Each start asks you. |
| Buttons | Allow this session · Always allow · Deny |
| Tooltip on Allow this session | Allowed until the browser restarts |
| Tooltip on Deny | Refuse it, and stop it asking. Undo in DevTools Settings → Permissions. |
| Age, dim | Asked {relative time} · expires in {days} days |

**A self-approval request:**

| Element | Text |
| --- | --- |
| Line | `{origin}` asks to approve its own actions. |
| Button | Review… |

Review… opens the confirmation in 1.6. Self-approval is never granted with one click.

**A start ask on this tab:**

| Element | Text |
| --- | --- |
| Line | An agent start from `{origin}` is waiting on this tab. |
| Button | Show |
| Tooltip on Show | Open the card on the page |

#### "This site" block

The existing block (`#siteAccess`) gets a second line for agents. The existing strings stay as they are:

- is allowed to use window.ml.
- is allowed to use window.ml until the browser restarts.
- is denied: its calls are refused.
- is not allowed to use window.ml. Its calls are refused.

| Agent level | Line | Buttons |
| --- | --- | --- |
| off | Agents: it may not start agents. | Let it start agents |
| ask | Agents: it may start agents, and each start asks you. | Always allow agents · No agents |
| always | Agents: it starts agents without asking. | Ask each time · No agents |
| denied | Agents: denied. It cannot ask again. | Stop denying |
| self-approve | Agents: it approves its own actions (DevTools Settings → Permissions). | (none) |

The agents line is hidden while the site itself is not allowed.

Changes elsewhere in the popup:

- The "Trusted domains (self-approval)" editor (`#permDomain`, `#permList`) is removed (Q14).
- The whitelist state line becomes: is allowed, and approves its own actions (DevTools Settings → Permissions).

### 1.4 DevTools Settings → Permissions

**Where:** `settings.tsx`. DevTools Settings is the superset of the popup.

#### "Sites that may use window.ml"

This section changes from chips to rows, one row per allowed origin:

`{origin}` · `[Always | This session]` · `Agents: [Off | Ask each time | Always | Denied]` · ✕

| Element | Text |
| --- | --- |
| Note, appended to the existing note | Starting an agent is a separate permission. A site can use window.ml without it. With "Ask each time", every agent the site starts shows a card with its task, tools, model and budget before anything runs. |
| Agents select tooltip | Whether this site's own `ml.agent` calls may start the extension's agent. Agents you start yourself are not affected. |
| ✕ (`aria-label` and tooltip) | Revoke {origin} |

#### New row: "Let sites ask for access"

| Element | Text |
| --- | --- |
| Checkbox | Let sites ask for access |
| Hint | A site you have not allowed can call `ml.requestAccess()` after you click on it, and the request waits in the toolbar button. Off: sites cannot ask, and you allow them only from here or the toolbar button. Either way a site cannot tell whether you have the extension unless you allow it, except by asking. |

The hint's last sentence is true only after slice 4. Until then it reads: Off: sites cannot ask, and you allow them only
from here or the toolbar button.

#### New section: "Waiting for an answer"

This section appears only when something is waiting. It holds the same entries as the popup, for every site, with the
same buttons.

#### "Self-approval whitelist" becomes "Sites that approve their own actions"

| Element | Text |
| --- | --- |
| Note | A site here may answer its own approval prompts: its page's `approve()` stands in for the extension's card. It can run code, click and type for you, run Python with network access, and fetch pages with your logins, without asking you each time. Only add a site you control or fully trust. Each scheme and port is its own site. A bare host means `https://` on the default port, including `localhost` and other loopback hosts; type the full origin for `http://` or another port (Q19). Being here also allows the site to use window.ml and to start agents. |
| Input placeholder | https://example.com |
| Error | Enter a site, e.g. `https://docs.google.com`. |
| Empty | No site approves its own actions. Every site's privileged agent calls go through the extension's approval card. |
| Upgrade notice (once, dismissable) | Sites on this list now match one origin each. Each host you had became its `https://` origin. Add an `http://` origin or another port yourself if you need one. #628 already lists the origins a bare entry no longer covers, each with an Add. |

### 1.5 The `requestAccess` prompt

There is no window and no popup that opens by itself. The prompt is the entry in 1.3, the badge in 1.2 and the
Settings section in 1.4. That is all of it, as rule 5 of the spec requires.

### 1.6 The self-approval confirmation

**Where:** a dialog in the popup, opened from Review….

This is the spec's draft, unchanged except that it names the origin and states what the site gets in full.

> **{origin} wants to approve its own actions.**
> If you allow this, the site can run code, click and type on your behalf, run Python with network access, and fetch
> pages using your logins, without asking you each time. Only allow this for a site you control or fully trust.
> The site says: “{reason}”
> **[Deny]** **[Allow]**

The Allow button is disabled for 1 second after the dialog opens.

### 1.7 Refusals a page sees (and the model, when its `exec` calls `ml.agent`)

Each one is the `{ error }` of the request, passed through `forPage` (and `forModel`, where an exec reads it).

| When | Text |
| --- | --- |
| `ml.agent` without `host: "page"` from a site without the agent level (Q1) | Refused: {origin} may use window.ml but not start agents. Pass `host: "page"` to run the loop in the page, or ask with `ml.requestAccess({ agents: true })`. |
| START_RUN, RESUME_RUN or INJECT_MESSAGE from a site without the agent level | Refused: {origin} may use window.ml but not start agents. Ask with `ml.requestAccess({ agents: true })`, or allow it from the extension's toolbar button. |
| The same, with agents denied | Refused: {origin} is not allowed to start agents. |
| The card was denied | Refused: the person declined to start this agent. Nothing ran. |
| The card timed out, or the worker restarted while it waited | Refused: nobody answered the request to start this agent. Nothing ran. |
| A second start while one is waiting on this tab | Refused: this site already has an agent start waiting for an answer on this tab. |
| Quieted after 3 denials (Q8) | Refused: this site's agent starts were declined. It may ask again after the browser restarts. |
| Past the page turn budget, declined | Refused: the person declined to let this site send more than {m} messages to this agent. |
| A page opened by a running agent tries to start one (Q17) | Refused: this page was opened by a running agent, which cannot be started from here. |
| A run id another site started | Refused: run "{id}" was started by another site. |
| `resumeMessages` on a run's first turn (Q4) | Refused: an agent's first turn cannot carry an earlier conversation. |
| The agent level revoked mid-run (Q9) | The run ends cancelled. Its result's summary reads: Cancelled: this site may no longer start agents. |

Until `ml.requestAccess` takes `{ agents: true }` (PR 4) and the toolbar button can set the agent level (PR 3), the
first two rows ship without the hint that names them: "Pass `host: "page"` to run the loop in the page." and "The person
can allow it in DevTools Settings → Permissions." A hint names only a call or a control that can grant the level.

Existing refusals that change because the whitelist becomes origins. They are rewritten to say "the list of sites that
approve their own actions":

- `background.ts:628`
- `background.ts:668`
- `sw-python.ts:124`

`requestAccess` answers. Each is the resolved value, never a throw:

| When | Value |
| --- | --- |
| No gesture, on an origin with no decision yet | `{ state: "refused", reason: "needs a user gesture" }` |
| A sub-frame, an opaque origin, or not http(s) | `{ state: "refused", reason: "only a page's top frame on http or https can ask" }` |
| Too many sites waiting | `{ state: "refused", reason: "too many requests are waiting; try again later" }` |
| Asking is turned off | `{ state: "refused", reason: "this browser does not take requests from sites" }` |
| Self-approval asked by an origin that is not allowed | `{ state: "refused", reason: "ask for access first" }` |
| Waiting | `{ state: "pending" }` |
| Decided | `{ state: "granted", agents: "granted" \| "pending" \| "denied" \| "off" }` or `{ state: "denied" }` |

### 1.8 docs/API.md

This goes in a new section, "Which sites may use `window.ml`". It replaces the second and third paragraphs of "Security
& trust model", which still say any page can call `window.ml`.

> A page can use `window.ml` only once you allow its site, from the toolbar button or in DevTools Settings →
> Permissions. Everything else is refused, whatever the browser's own site-access setting. A site is one origin:
> `http://` and `https://`, and every port, are separate decisions. Runs you start yourself (from the HUD, the chat page
> or the sidebar) work on any page, because the extension builds them, not the page.
>
> A site that is not allowed can ask, after you click on it:
>
> ```js
> const r = await ml.requestAccess({ reason: "Summarise threads on this forum", agents: true });
> // r.state: "granted" | "pending" | "denied" | "refused"
> ```
>
> The request waits in the toolbar button. It never opens a window. Each site asks once: later calls answer with the
> current state, and a denial is final until you lift it in Settings.
>
> Starting an agent is a second permission, off unless you turn it on. With it, every `ml.agent` or `ml.createAgent`
> run the site starts first shows a card with the site's task in its own words, the tools, the model and the step
> budget, and nothing runs until you allow it. Allowing covers that conversation's later messages from the site up to
> the page turn budget on the card; turns you drive yourself are yours. "Always allow agents" skips the card for that
> site. A site may always cancel its own run. `ml.agent({ host: "page" })` runs the loop in the page instead: it is
> plain `window.ml` use and gets no server tools.

## 2. The decisions, with their reasons

Each entry says what the decision is and why. Where the owner decided differently from the original recommendation, the
entry says "(owner, 2026-10-13)" and keeps the reasoning that applies. Entries the owner agreed with say "decided".

**Q1. Does the agent level cover page-hosted loops? (owner, 2026-10-13)**

- **What happens today.** A page's `ml.agent` runs its loop in the page, never sending START_RUN, when two things are
  true: no debug surface is on, and either the run has no gated tool or the origin self-approves
  (`ml-agent-run.ts:177`). In that case its model calls are `FETCH_LLM`.
- **What the page could do anyway.** An approved page can write the same loop itself on top of `ml.chat`.
- **What the agent level actually protects.** Three things a page cannot build itself:
  - the extension's agent, with its privileged tools (`fetch_url` as you, `python_exec`, CDP clicks, navigation across
    sites);
  - approval cards in the extension's own UI, for a task the page wrote;
  - a run the worker hosts across navigations.
- **Decided.** A page-hosted loop stays a level-1 affordance, so a page need not write a loop itself, but it gets no
  backend permissions: calling OpenWebUI server tools from a page-hosted loop needs the agent level.
- **Hosting is explicit in the API.** `ml.agent({ host: "page" })` is the local loop. Without it the run is a worker
  run (START_RUN), refused unless the site may start agents. The refusal names `host: "page"` (1.7). This replaces the
  earlier choice of letting the same `ml.agent("summarise")` call show a card or not depending on whether a debug
  surface is on.
- **Self-approving sites** imply the agent level (Q6), so they keep working unchanged.

**Q2. Is the budget per turn or cumulative? (owner, 2026-10-13)**

- **The spec says** "a resume past the approved budget asks again", but a `createAgent` handle can send unlimited
  turns of up to N steps each. A per-turn budget alone bounds nothing over a session.
- **Decided: per turn, with a separate page turn budget.** The step budget (`maxSteps`, not the read-only exec budget)
  is per turn.
  - A turn the person drives (a reply, Continue) is the person's go-ahead on the normal per-turn budget and supersedes
    the page's.
  - Turns the PAGE drives (`say()`, INJECT_MESSAGE, RESUME_RUN sent by the page) draw from a separate PAGE TURN BUDGET
    approved on the start card. Past it, a page-sent turn asks again ("keep going", 1.1).
  - The bound over a session is therefore the page turn budget times the per-turn budget, and the person sees both on
    the card.
- **Q2a, attribution.** A page-sent turn reaches the model marked as the page's ("Message from the page ({origin}):
  ..."), never as the person's, and the card shows it with the site's name. Today a page `say()` becomes a plain
  `role: "user"` message and an unlabelled agent-say bubble. That is fixed in slice 3 (PR 2).
- **Q2b, the page wants the person.** A page may end its turn as "waiting for the person". The run stops, the card's
  reply box opens with the page's prompt (labelled as the page's), and what the person types is their turn.

**Q3. Does a widening on a later turn ask again? (decided: yes)**

- **The spec** binds the approval to the session only.
- **The gap.** A handle's second START_RUN can carry a different toolset, model, `system` or `systemAppend`. Approving
  a read-only agent would then admit an `exec`/`python_exec` one.
- **Decided.** Bind the approval to the set of gated builtins, server tools, model and the hash of the
  instructions. A turn that adds to the first three, or changes the instructions, asks again (the 1.1 variant). A
  smaller toolset or the same model rides.

**Q4. May a first turn carry `resumeMessages`? (decided: no)**

- **The gap.** A handle sends its own history on every START_RUN (`ml-agent-run.ts:299`). On a first turn that history
  is whatever the page wrote. It could include fabricated assistant turns and tool results, which the card would never
  show.
- **Decided.** Refuse it when no approval exists for the run id. If page-written history is ever allowed, it must be
  shown on the card like the system prompt. The card lets the person review ALL parameters, the system prompt
  included, so page-side content in the system prompt is kept limited.
- **Later turns.** A later turn's history must also not be the page's. Take the worker's stored `messages` (as
  RESUME_RUN does) and ignore the page's copy. That changes "the page stays authoritative across turns"
  (`sw-run-host.ts` `hostRun` comment) for page-started runs.

**Q5. Timeout. (decided)**

- **Decided: 3 minutes.**
- **Eviction.** An MV3 worker can be evicted while it waits. The waiting promise dies with it, the page's channel
  closes, and the start counts as refused. That fails closed.
- **Persisting the wait is not worth it.** It would only let a start succeed after a restart, which is the page racing
  the worker.

**Q6. Does self-approval imply the agent level? (decided: yes)**

- **Decided: yes, as "always".** The use case is personal and local pages scripting the person's own agents. A self-approving site already answers its own tool gates and runs its loop in the
  page. A start card there would be the only prompt such a site ever shows.
- **Upgrade.** This keeps today's behaviour for the hosts now on the list.

**Q7. Which surfaces show the start card? (decided)**

- **Decided for slice 3:** the tab's HUD card, the overlay sidebar and the DevTools panel. Those are the surfaces
  that show a page-built run's gates today.
- **Not yet:** the chat page and the phone (over the hub). They would need the start ask in the session index and the
  hub's gate protocol.
- **Why the chat page waits.** Chat mode is talking to the model, while in-page agents help with the site the person
  is looking at, so the chat page has no natural place for a site's start ask. The docs say the chat page cannot show
  the card yet, and why.
- **Never:** the external `__mlApprovals` channel. A page's `approvalRouting` must never route the start ask there.

**Q8. Does a site that keeps being denied stop asking? (decided)**

- **The problem.** Without a limit, a page can raise a card after every denial.
- **Decided.** After 3 denials (or timeouts) from one origin in a browser session, its starts are refused without
  a card until the browser restarts or you change its level. The count lives in `chrome.storage.session`.

**Q9. The agent level is revoked while a site's agent runs. (decided)**

- **The precedent.** #621 hands a page-built run to the worker when its SITE is revoked, so the run continues as yours.
- **Why that does not fit here.** For the agent level it would keep running an agent you just said this site may not
  start.
- **Decided.** Cancel the site's page-started runs at their next step, with the cancel reason in 1.7. A revoke of
  the whole site keeps #621's hand-over.
- **If you prefer one rule for both,** hand over here too.

**Q10. The registrable domain (eTLD+1). (decided)**

- **The constraint.** Rule 6 needs it, and there is no Public Suffix List in the repo.
- **Why a naive "last two labels" fails.** It is wrong both ways:
  - every `*.github.io` user would share one bucket, so one hostile page blocks all of them;
  - `*.co.uk` sites would collapse together.
- **Decided.** `tldts` (MIT, about 100 KB), bundled only into `background.js`.

**Q11. Is a gesture on our own UI a gesture? (decided: no)**

- **The problem.** User activation spreads to ancestor frames. A click on the HUD card's iframe (Approve on a tool
  gate, the composer) gives the PAGE transient activation for about 5 seconds. A page can wait for that and call
  `requestAccess` without the person ever touching its content.
- **Decided.** The content script counts a gesture only if two things hold:
  - `navigator.userActivation.isActive`;
  - a trusted `pointerdown`/`keydown` on the page's own document, outside our shadow hosts, within the last 5 seconds.
    It records this with a capture listener registered at `document_start`, before any page script can register one.

**Q12. The "agents too" checkbox default. (decided: unticked)**

- **Decided: unticked.** It is the most powerful permission a site can ask for. The level is "off unless the person
  turns it on", and the site's request says what it wants. Each start would still show a card.

**Q13. The stub. (decided)**

- **The disagreement.** The spec's slice list puts "the stub and `requestAccess`" in slice 3. The e2e suite gates the
  stub test on `holeOpen("slice4", …)` (`site-access.spec.mjs:117`), and the stub needs `injected.js` withheld, which
  is slice 4.
- **Decided.** Slice 3 adds `ml.requestAccess` to the full API. The stub and feature detection come in slice 4.
  The spec's slice list gets corrected.

**Q14. Self-approval storage, and the popup editor. (decided)**

- **Decided storage.** A new local key `ml_site_selfapprove` (origins). The old `pageApprovalDomains` in `sync`
  is read once and left in place, so another machine on an older build keeps working. A site decision has no business
  in `sync` (spec, "The approved list").
- **Decided for the popup.** Remove its whitelist editor. It is the strongest grant the extension has, and the
  popup is the one-click surface. Settings keeps it.

**Q15. Today's tool gates of a page-started run. (decided)**

- **The problem.** The card asks the shell to focus it when a gate appears (`__mlSidebarCardFocus`,
  `hud-card.tsx:397`), and Enter approves. A page-built run decides when its gates appear, so a page can raise one as
  the person presses Enter in the page's own form.
- **Decided.** In PR 2, for runs the page built:
  - drop the focus steal;
  - require a click (or Enter with focus already inside the card).

  Runs the person started keep the shortcut.

**Q16. Button label. (decided)**

- **The problem.** "Allow once" reads as "one turn", while what it grants is the conversation, with the site's later messages drawn from the page turn budget.
- **Decided.** "Allow this agent".

**Q17. A page reached by a running agent's navigation. (owner, 2026-10-13)**

- **The problem.** A running agent navigates to pages the person never chose. If such a page is a site that may start
  agents, or can raise a request, it reaches the person through a run they did not start about it, and it can disturb
  the driver model.
- **Decided.** A page reached by a running agent's navigation never starts an agent and never disturbs the driver
  model. Its request (a start, or an access request) is recorded and shown quietly: in the run's step list, and on the
  badge. It reads "not started: this page was opened by a running agent". No card appears and no model call is made.
- **Where it lands.** The refusal is `agentRefusal`'s, in PR 2. The recording for `requestAccess` is in PR 4, which
  owns the request store; the badge count follows from the stores (PR 3).

**Q18. How the extension's own tools are told apart from a site's. (owner, 2026-10-13)**

- **The problem.** `GATED_TOOL_NAMES`, `CITABLE_TOOLS` and the card's "is this ours" each keep a list of names. A
  start card that decides "builtin or the site's own" from a separate list can disagree with the gate.
- **Decided.** Declare every internal tool with `defineTool({ name, gated, citable, realm, cardLine })`, in a registry
  with a ratchet. `GATED_TOOL_NAMES`, `CITABLE_TOOLS` and the card's tool lines read from it. A name that is not
  declared is the site's own tool.
- **Where it lands.** Its own PR (1b), before the start card PR.

**Q19. How the lists match origins (#628). (owner, 2026-10-13)**

- **The problem.** The self-approval whitelist was matched by host over any scheme and port, so `http://host` and
  other ports of a whitelisted host were treated as self-approving. #628 reads it by origin, with the rule the site
  gate uses, before the slice 3 storage migration.
- **Decided.** No loopback special case. A bare entry, loopback hosts included, trusts only `https://host` on the
  default port. Anything else (`http://`, another port) is stored as its exact origin. Nothing is migrated silently:
  inferring http origins from the gate's approvals would trust http without the person choosing it. A site the person
  had allowed over http is listed in Settings with an Add that stores that exact origin.
- **Effect on slice 3.** The migration in PR 1 keeps this rule and builds on `selfApproves` and `selfApprovalOrigin`
  from #628.

**Smaller defaults.** The owner did not change these:

- 1-second button arming;
- 12-line fold;
- at most 3 start asks waiting across the browser;
- the 7-day request expiry and the 5-request cap, both already decided in the spec;
- `ml.current.env.page` gains `agents: "off" | "ask" | "always"` beside `approved`.

## 3. Threat analysis

The threat is the one in `docs/dev/security-audit.md`: a page that shares the main world with `window.ml`, posts any
window message, knows every run id it has seen, and may frame web-accessible extension pages.

### 3.1 Can a page spam `requestAccess`?

Bounded in the worker:

- One entry per origin, ever.
- At most one pending entry per registrable domain (Q10), and 5 in all.
- A denial is final.
- An entry expires after 7 days, which allows one re-ask.

Further bounds this plan adds:

- The content script keeps one request in flight per document and drops the rest without relaying them. That bounds
  worker work, not only storage.
- No gesture means no entry (Q11 closes the borrowed gesture).
- The badge counts entries, so a flood moves it by at most 1 per registrable domain and 5 in all.

Residual:

- **Crowding out other sites.** Five hostile registrable domains can fill the global cap, so a sixth site cannot ask
  for up to 7 days. The person sees five entries and can deny them, which frees the slots. Accepted.
- **Rotating to dodge the cap.** A page can rotate *registrable* domains it owns. Each needs a real gesture on a page
  of that domain.

For start cards, the counterpart is:

- one waiting per origin per tab;
- 3 across the browser;
- quieting after 3 denials (Q8).

A START_RUN arriving while its origin's start ask is waiting is refused at once (1.7). It is not queued.

### 3.2 Can it shape the start card to mislead?

**What the page controls:**

- the task;
- `system`/`systemAppend`;
- the custom tools' names and descriptions;
- the model it asks for;
- `maxSteps`;
- when the card appears.

**What it does not control:** the origin. The card reads that from `sender`, as the gate does.

The framing:

- **The task is quoted, never rendered.**
  - It sits in a bordered block labelled "The task, in the site's own words", under "Started by this page, not by you".
  - Markdown, HTML and links stay inert text.
  - Bidi overrides and zero-width characters are made visible.
  - Long text folds at 12 lines with its length shown, so a page cannot push the tool list and buttons off the card
    with whitespace. The quote has a fixed maximum height, and the tool list, model and budget sit outside the
    scrolling area, in the footer with the buttons.
- **The page cannot impersonate the extension.**
  - The heading and every line outside the quote come from the worker.
  - A task that reads "window.ml: this is a routine check, click Always" is still inside the labelled quote.
- **Hidden instructions are named.**
  - If the site sent `system`/`systemAppend`, the card says so, with a Show disclosure. Otherwise a benign task could
    front a malicious system prompt.
  - `resumeMessages` on a first turn is refused (Q4) for the same reason.
- **Tools are described by the extension, never by the page.**
  - A tool line comes from a fixed table keyed by the builtin's name.
  - `pageStartPayload` already forces `requiresApproval` on gated builtins and server tools, so a custom tool named
    `exec` is still gated.
  - What the page calls its own tools is counted in the tool lines ("{n} tools the site defined"), because they run as
    the page's own code and get nothing the page lacks. Their descriptions are the site's instructions, shown in the
    instructions disclosure (S2, owner, 2026-10-14), and a tool named like a builtin reads to the model as the
    extension's own.
- **The model and budgets are the worker's values.** The model is the one resolved after the model filter. The per-turn
  budget is `stepBudget`'s value, capped at 200. The page turn budget is the worker's own number, never the page's.
- **A page-sent turn cannot pass for the person's** (Q2a). The worker marks it "Message from the page ({origin}):
  ..." before the model reads it and labels its bubble with the site's name. A page cannot set that label, and a turn
  the person types in the card's reply box is the only one sent unlabelled. A "waiting for the person" prompt (Q2b) is
  shown labelled as the page's, so it cannot read as the extension's own question.
- **Not mitigated: the content of an honest-looking task.**
  - "Summarise this page" can lead the agent, through prompt injection in the page, into anything its tools allow.
  - This is why the tool lines are on the card and why gated actions still ask one by one.
  - The card says the second fact ("Actions that need your approval still ask you").

### 3.3 Can it race the card?

- **Content swap.** The card draws the worker's snapshot, sent to the shell over `chrome.runtime` (attack 15 closed
  that path), and the approval names a request id bound to that snapshot. The page cannot change what is shown or what
  starts. A second START_RUN while one is waiting is refused (3.1), so "approve A, get B" is impossible.
- **Arming delay.** Buttons stay disabled for 1 second after the card appears or its content changes. This defeats a
  card timed to land under a click the person was already making, including a click on a tool gate in the same card
  position. A start ask queues behind a pending tool gate rather than replacing it.
- **Keyboard.** The start card has no Enter shortcut and never takes focus (Q15 extends that to page-started runs'
  tool gates). A page cannot time it to a keystroke in its own form.
- **Synthetic clicks.** The roots are closed (#610) and the buttons live in the extension's iframe. The page's
  `click()` and synthetic events do not reach them. The decision travels as a new `SET_START_APPROVAL`, which is
  accepted only from the shell's private port or an extension page, like `SET_APPROVAL`, and is in neither `HANDLE_MAP`
  nor `PAGE_RELAYED_EXTRA`.
- **Overlay clickjacking.** This is the known-open item in security-audit.md: a page element in the top layer from the
  page's own closed shadow root, with `pointer-events: none`. The start card inherits it. Two options:
  - ship the proposed occlusion check (IntersectionObserver v2 `trackVisibility` on the Allow buttons, refusing a click
    while they are covered) with PR 2;
  - accept it as known-open for both kinds of card.

  The plan includes the check in PR 2, behind its own test.
- **A fake card in the page.** A page can draw a look-alike. Clicking it does nothing (it cannot approve). Accepted.

### 3.4 Can it reuse a session approval across tabs, or after a revoke?

The approval is stored as `{ runId, tabId, origin, scope, budget, pageTurns: { allowed, used }, bound: { gated tools,
server tools, model, instructions hash } }`. Every START_RUN, RESUME_RUN and INJECT_MESSAGE re-checks it against:

| Attempt | Outcome |
| --- | --- |
| Another tab, same run id | Already refused: the run's owner tab (`startBackgroundRun`). The approval also names the tab |
| Another tab, new run id | A new card. "Always" is per origin by design |
| Same tab, another origin (navigation to a second approved site that knows the id) | Refused: the approval names its origin (1.7, "started by another site") |
| After a revoke of the site or the agent level | The level is read live on every check, so the next message fails even if the cleanup below has not run. Approvals for an origin that lost either level are dropped at the `chrome.storage.onChanged` event `nav-handover.ts` already listens to, and again at worker start. Re-approving the site does not bring them back |
| After "Always" is turned back to "Ask" | Session approvals made by "Allow this agent" stay. Approvals that rode on "Always" are not recorded, so the next start asks |
| A page re-sending an old approved START_RUN | Rides only within the approval's binding and page turn budget. That is the same page, conversation and spend it was allowed |

### 3.5 What "session" means across a worker eviction

Definition: **one run id, on one tab, for one origin, until the run is deleted, the tab closes, the agent level or the
site is revoked, or the browser restarts.**

- **Approvals are stored before the run starts**, in `chrome.storage.session` (`ml_start_approved`). An eviction
  between two turns does not lose them, matching the run itself (its snapshot survives eviction and a handle's next
  turn continues it).
- **Restore order.** `startBackgroundRun` already waits for `hydrationDone`. It also waits for the approvals' read, so
  a message that wakes the worker is judged against restored approvals, never against an empty map. On the bounded
  wait's expiry it refuses (`RESTORE_PENDING`), as today.
- **A start waiting at eviction** is lost, and counts as refused (Q5). The card's later click finds no entry and shows
  "expired".
- **Lost at browser restart:** session storage goes, and so do page-built runs.
- **Extension update:** `chrome.storage.session` is also cleared, so there is nothing to migrate.
- **`pageTurns.used`** (the page-sent turns spent against the page turn budget) is written when a page-sent turn is
  accepted, before the turn runs, with the run's snapshot. An eviction cannot undercount it. The per-turn step budget
  restarts each turn, so it needs no stored count across turns.

### 3.6 Other surfaces found while planning

- **The whitelist trusts plain http.**
  - `senderTrust` and `publicConfig` match `pageApprovalDomains` by HOST, any scheme (`sw-consent.ts:196`,
    `contract-config.ts:356`).
  - So `http://host` is "whitelisted" for `CDP_CLICK` and page-loop self-gating, while the site gate refuses it.
  - PR 1 closes this with a failing-first test.
- **`REQUEST_ACCESS` must sit outside the origin gate.** Otherwise an unapproved page could never ask. It goes on the
  UNGATED list, bound to the sender (top frame, http(s), the content script's gesture fact), with the ratchet in
  `tests/redteam.test.js` updated.
- **The model can call `ml.requestAccess` from an approved exec** on an approved page. That asks only for the agent
  level or self-approval, which the person decides in the popup. An isolated exec's `ml` has no `requestAccess`.

## 4. The PR split

Run the red-team pass as its own agent on PR 2 and PR 4: they add page-started message types and an `ml.*` member.
Every security test below fails first against the base. Labels on each PR are `@security` plus those listed.

### PR 0: this file and the stale docs (docs only)

**Scope.** This reference, and the stale statements that later PRs would otherwise inherit. Section 5 lists each.

- `docs/spec/SITE_ACCESS_SLICE3.md` (this file), linked from SITE_ACCESS.md and `docs/dev/site-access.md`.
- `docs/dev/security-audit.md`: remove the "Known open" items that are done (#579, #621), and any other that the Done
  list already covers.
- `docs/dev/state.md`: the stale grants row (#611).
- `docs/API.md`: the security section describes site access.
- `SITE_ACCESS.md`:
  - "Upgrading an existing install";
  - the slice list (the stub moves to slice 4);
  - the agent level names its three types instead of `RUN_CONTROL_TYPES`.

**Tests.** `check-doc-links`, and the doc tests in `npm test`.

**Labels.** `@docs`, `@security`.

### PR 1: levels in storage, the whitelist as origins, and the upgrade

**Files:**

- `src/site-access.ts` (pure). The origin rule is #628's (Q19): no loopback special case, a bare entry is
  `https://host` on the default port, anything else is its exact origin. Build on its `selfApproves` and
  `selfApprovalOrigin`:
  - `SiteLists` gains `agents` (origin → `"ask" | "always" | "denied"`) and `selfApprove` (origins).
  - `decide` becomes `levelsFor(lists, origin) → { use, agents, selfApprove }`; self-approval implies `use: always`
    and `agents: always` (Q6).
  - `applyEdit` gains `agents` and `selfApprove` ops; revoke drops the origin's agents entry.
  - `migrateSiteLists(v1, syncHosts)`.
- `src/sw/sw-site-access.ts`: new keys; `migrateSiteAccess()` at worker start under a `ml_site_schema: 2` marker.
- `src/sw/sw-consent.ts` (`senderTrust` by origin).
- `src/contract/contract-config.ts`:
  - `publicConfig` takes the self-approval decision as an argument;
  - `pageApprovalDomains` stays in the type, read only by the migration.
- `src/background.ts`: `GET_CONFIG`, and `SITE_ACCESS` returning levels.
- `src/sw/nav-handover.ts`: `changesSiteAccess` watches the new local keys, not `sync`.
- `src/sw/worker-ml.ts`.
- `src/popup.html` / `src/popup.ts`: remove the whitelist editor; agents line in "This site".
- `src/sidebar/settings/settings.tsx`: rows with the agents select; the whitelist section by origin; the upgrade
  notice.
- The three refusal strings in 1.7.

**State:**

| `defineState` id | Store | scope | realm | audience | lostOn | `read` |
| --- | --- | --- | --- | --- | --- | --- |
| `site.levels` | `ml_site_always`, `ml_site_denied`, `ml_site_agents`, `ml_site_selfapprove` (local); `ml_site_session` and the session half of `ml_site_agents` (session) | browser | worker | human | `browser-restart` for the session half only | `({ tabId }) → { origin, use, agents, selfApprove }` for the tab's current top-frame origin |

`ml_site_schema` is marked `// state: fixed`.

This also declares the existing lists, which predate the ratchet.

**Tests:**

- `tests/site-access.test.mjs`:
  - `levelsFor` and `applyEdit` over every `(use × agents × selfApprove)` combination;
  - the migration enumerated:
    - a host;
    - a host with a port typed in;
    - an IP;
    - `localhost`;
    - an empty list;
    - a non-string entry;
    - running it twice.
- **Upgrade fixture**, `site-access-upgrade.test.mjs`, against the bundle. Storage as the old code wrote it:
  - local `ml_site_always: ["https://a.test", "http://b.test"]`, `ml_site_denied: ["https://c.test"]`;
  - sync `pageApprovalDomains: ["x.test"]`.

  Assert what a person sees after the upgrade:
  - a and b allowed, with agents "ask";
  - c denied;
  - `https://x.test` allowed, self-approving, agents always;
  - `http://x.test` refused, and "untrusted" for `CDP_CLICK`;
  - a site allowed after the migration gets agents "off";
  - the Settings rows render those states (jsdom, `sidebar-settings.test.js`).
- **Red-team**, `tests/redteam.test.js` (f), failing first (the first two are #628's; keep them as regression tests
  if it has merged):
  - `http://host` with the host on the old whitelist is not "whitelisted" for `CDP_CLICK`;
  - `GET_CONFIG` answers `pageApprovalAllowed: false` there;
  - a page cannot write `ml_site_agents` or `ml_site_selfapprove` through any page-started type (`SITE_ACCESS` stays
    extension-only).
- **e2e:** none. Nothing here needs a real browser.

**Docs:**

- `docs/dev/site-access.md` ("The lists");
- `docs/dev/state.md` (grants table);
- `SITE_ACCESS.md` (a deviation entry if Q14 is taken);
- `docs/API.md` (the whitelist paragraph).

**Labels.** `@ui`, `@api`.

### PR 1b: the `defineTool` registry (Q18)

**Why first.** The start card's tool lines and its "is this ours" test must read the same source as the gate. Declaring
the tools once removes the second list before the card is built on it.

**Files:**

- a `defineTool({ name, gated, citable, realm, cardLine })` registry, beside the tool definitions in `src/tools/`
  (`tool-params.ts` and `tool-exec.ts` hold the lists today). Search first with `node scripts/index.mjs 'tool'`;
- `GATED_TOOL_NAMES`, `CITABLE_TOOLS` (today in `src/tools/`, `src/agent/` and `src/sw/sw-run-host.ts`) become reads of
  the registry;
- the card's builtin table (1.1) is the registry's `cardLine`; a name that is not declared is the site's own tool;
- a ratchet (`scripts/check-*.mjs`, run by the pre-commit hook and CI) that fails on a tool the loop can run that is
  not declared.

**State.** The registry is fixed at load: `// state: fixed`.

**Tests:**

- every declared tool: `gated`, `citable` and `realm` equal what the old lists said (enumerated, from a snapshot of the
  old lists taken before the change);
- a site tool named like a builtin (`exec`) is gated and gets the builtin's line;
- an undeclared name is the site's own;
- the ratchet fails on an undeclared tool.

**Docs.** `docs/dev/agent-tools.md`, one paragraph.

**Labels.** `@agent`.

### PR 2: the agent level and the start card

**Files:**

- `src/page-relay.ts`: `AGENT_LEVEL_TYPES = START_RUN, RESUME_RUN, INJECT_MESSAGE`. `RUN_CONTROL_TYPES` keeps
  `PAGE_CANCEL_RUN` for its existing use.
- `src/ml/ml-agent-run.ts` and the contract: `ml.agent({ host: "page" })` (Q1). Without it the run is a worker run;
  with it the loop stays local and gets no server tools.
- Page-turn attribution and the page turn budget (Q2, Q2a, Q2b):
  - a page-sent turn reaches the model as "Message from the page ({origin}): ..." and its bubble carries the site's
    name, instead of the plain `role: "user"` message and unlabelled agent-say bubble used today;
  - the approval's `pageTurns` count, checked on every page-sent turn; a turn the person drives bypasses it and uses
    the normal per-turn budget;
  - "waiting for the person": the page ends its turn that way, the run stops, and the card's reply box opens with the
    page's prompt, labelled.
- The navigation rule (Q17): `agentRefusal` refuses a start from a page a running agent's navigation reached, records
  it, and draws one quiet line in the run's step list. PR 4 adds the same record for `requestAccess`; PR 3's badge
  counts both.
- `src/sw/sw-site-access.ts`: `agentRefusal(type, sender)`.
- New `sw-start-approval.ts`:
  - `pendingStarts`;
  - the approval store;
  - `askToStart` (snapshot, binding, timeout, quieting, caps);
  - `resolveStart`;
  - revoke cleanup;
  - the Q9 cancel.
- `src/background.ts`:
  - the router applies `agentRefusal` after `pageRefusal`;
  - `SET_START_APPROVAL`, extension sender or the shell's port only.
- `src/sw/sw-run-host.ts`:
  - `startBackgroundRun` awaits the ask before `hostRun`;
  - the binding and page turn budget check on RESUME_RUN, a handle's START_RUN and INJECT_MESSAGE;
  - `resumeMessages` handling (Q4).
- `src/contract/contract-messages.ts` and `contract-agent.ts`: the `StartAsk` descriptor and the event kind.
- `card-start.tsx` (new), `hud-card.tsx`, `src/sidebar/transcript/agent-detail.tsx`.
- `src/sidebar/shell.ts`: forward the decision; no focus for page-built runs (Q15).
- `panel.ts` (the DevTools forward).
- The occlusion check on the Allow buttons (3.3).

**State:**

| `defineState` id | Store | scope | realm | audience | lostOn | `read` |
| --- | --- | --- | --- | --- | --- | --- |
| `run.startAsk` | `pendingStarts` (Map) | run | worker | human | `worker-eviction` (deliberately: it denies) | `({ runId }) → { origin, since, budget, pageTurns }` |
| `run.startApproval` | `ml_start_approved` (session storage) | session | worker | human | `browser-restart` | `({ runId }) → { origin, scope, budget, pageTurns, bound }` |
| `site.startDenials` | `ml_start_denials` (session storage) | browser | worker | human | `browser-restart` | |

**Tests**, new `redteam-agent-level.test.mjs`, each failing first, with `fake.calls()` as the oracle (no model
request before an allow):

- **Without the level** (a site allowed to use window.ml but not agents):
  - START_RUN, RESUME_RUN and INJECT_MESSAGE are refused;
  - PAGE_CANCEL_RUN is allowed;
  - enumerate `AGENT_LEVEL_TYPES` from the module.
- **"ask":**
  - nothing runs before the decision;
  - deny, timeout and eviction (`helpers.js` eviction seam) each leave zero model calls;
  - allow runs exactly the snapshot.
- **A `createAgent` handle:**
  - turn 2 asks nothing;
  - the page turns past the page turn budget ask; a turn the person drives does not;
  - a page-sent turn reaches the model labelled with the origin and is never a plain user message;
  - "waiting for the person" stops the run and opens the reply box, and the person's text is their own turn;
  - a turn adding `exec` asks;
  - a turn changing `system` asks;
  - the same with a smaller toolset rides.
- **Binding:**
  - same run id from another tab: refused;
  - from another origin on the same tab: refused;
  - after a revoke of the level: refused, and the approval is gone;
  - after re-approval: asks again.
- **Eviction:**
  - an approval written, then the worker evicted, and the next turn rides;
  - a start waiting at eviction is refused and runs nothing.
- **First turn:** `resumeMessages` refused, with nothing run.
- **Page-hosted loops (Q1):** `ml.agent` without `host: "page"` from a site without the level is refused, naming
  `host: "page"`; with it the loop runs and its server-tool calls are refused; a self-approving site runs either.
- **Navigation (Q17):** a start from a page a running agent navigated to is refused with no card and no model call, the
  driver model's context is unchanged, and the step list shows the record.
- **Floods:**
  - a second START_RUN while waiting is refused;
  - 3 denials quiet the origin;
  - 3 asks across the browser is the cap.
- **Routing:** `approvalRouting: "external"` never puts the start ask on `__mlApprovals`.
- **The decision message:**
  - `SET_START_APPROVAL` from a page (window message, the relay, a forged `__mlSidebarApp` post) resolves nothing;
  - add it to the UNGATED/extension-only enumeration.
- **The card's text** (jsdom render of `card-start.tsx`):
  - a task holding `<img onerror>`, a Markdown link, `‮`, 10,000 newlines, and a fake "window.ml:" heading stays
    inside the labelled quote as text;
  - the tool lines come from the table whatever the page named its tools;
  - the arming delay.
- **Upgrade** (with PR 1's fixture): a pre-upgrade origin's first START_RUN shows the card instead of running or
  being refused.
- **Q9:** revoking the level mid-run cancels at the next step.

**e2e**, `tests/e2e/site-access.spec.mjs`, a new "attack 19: the start card". These need what jsdom lacks: real focus,
the closed root, the iframe and the top layer.

- The page starts an agent; the HUD card shows the origin and the quote.
- The page's synthetic clicks and `postMessage`s cannot allow it.
- An Enter pressed in a page `<input>` as the card appears allows nothing, and the card did not take focus.
- A real click inside the first second does nothing; after it, it runs.
- A page top-layer overlay with `pointer-events: none` over Allow makes the click refuse (if the occlusion check
  lands).
- The same in the DevTools panel (`watchRunEvents`).
- Tag none `@real-ok`.

**Docs:**

- `docs/dev/site-access.md`: new "Starting agents" section.
- `docs/dev/sidebar.md`: the card.
- `docs/dev/agent-tools.md`: one line on page-started runs.
- `SITE_ACCESS.md`: deviations for Q1 to Q4, Q9 and Q17.
- `docs/API.md` 1.8: the agents paragraph.
- `security-audit.md`: tick.

**Labels.** `@agent`, `@ui`, `@api`.

### PR 3: the badge and the popup

**Files:**

- new `sw-badge.ts`, which recomputes on every change to `pendingStarts` and the request store, and on
  `tabs.onRemoved`;
- `src/popup.html` / `popup.ts`: "Waiting for you" (start asks on this tab, with Show); the agents buttons;
- `src/sidebar/shell.ts`: Show opens the card.

**State.** None new. The badge is derived from the stores above; marked `// state: ui`.

**Tests:**

- `badge.test.mjs` (vm, `chrome.action` mocked):
  - the counts;
  - per tab;
  - "9+";
  - cleared by a decision, a timeout, an eviction (recomputed at start), and a closed tab;
  - the `setTitle` strings.
- The popup in jsdom: the agents line and buttons for each level, and hidden while the site is not allowed.
- **e2e:** open `chrome-extension://<id>/popup.html` in a tab beside a page with a waiting start. "Show" opens the
  card; the badge text is read through the extension's `chrome.action.getBadgeText`.

**Docs.** `docs/dev/site-access.md`.

**Labels.** `@ui`.

**As built.**

- The badge counts start asks only. A refused start from a page a running agent reached (`site.notStarted`) is not
  counted yet: it joins the count with PR 4's request store, where it has an answer the person can give.
- Several start asks on one tab use the "n things are waiting for you" title, the one written for a mix.
- Show unfolds the card without focusing it, so the start card's rule that it never takes focus holds for it too.
- The second row of 1.7 now names the toolbar button: "The person can allow it from the extension's toolbar button or
  in DevTools Settings → Permissions."

It could fold into PR 2 or PR 4. It is kept apart because it is the one place both feed.

### PR 4: `requestAccess`

**Files:**

- new `ml-access.ts`, exposed on `window.ml` (`injected.ts`);
- `src/contract.ts` (`MlApi.requestAccess` JSDoc, terse: the model reads it through `agent_api_docs`, so prompt
  review applies);
- `src/page-relay.ts` (`REQUEST_ACCESS` on an ungated list beside `PAGE_STARTED_TYPES`);
- `src/content.ts` (the gesture fact, Q11; one in flight per document);
- new pure `site-requests.ts` (the state machine; a request from a page a running agent opened is recorded as "not
  started" and never shown as a prompt, Q17);
- new `sw-access-requests.ts` (storage, expiry, the "let sites ask" setting);
- `src/popup.*` (request entries, the agents checkbox, the self-approval dialog);
- `settings.tsx`:
  - the "Let sites ask for access" row;
  - "Waiting for an answer";
  - the setting in `DEFAULT_CONFIG` (`contract-config.ts`) as `siteRequests: true`.
- `package.json` (`tldts`, Q10).

**State:**

| `defineState` id | Store | scope | realm | audience | lostOn | `read` |
| --- | --- | --- | --- | --- | --- | --- |
| `site.requests` | `ml_site_requests` (local) | browser | worker | human | none | `({ tabId }) → the tab's origin's request` |
| (none) | The content script's last-input time | | | | | `// state: plumbing` |

The `siteRequests` config key is covered by the config's own registration.

**Tests:**

- `site-requests.test.mjs` (pure, enumerated over every `(state × event)`):
  - one entry per origin;
  - denial final;
  - per-registrable-domain cap with `github.io` and `co.uk` cases;
  - global cap 5;
  - 7-day expiry and the single re-ask;
  - revoke without reload;
  - agents asked on an origin whose agents are denied resolves `denied` with no entry;
  - self-approval from an unallowed origin is refused.
- **Red-team** (`tests/redteam.test.js`, new section):
  - `REQUEST_ACCESS` from a sub-frame, an opaque origin, `data:` and `file:` creates nothing;
  - without the gesture fact it creates nothing;
  - with an activation that came only from our card's iframe it creates nothing (Q11);
  - the page cannot set the gesture fact (it is added by the content script; a page-posted field is ignored);
  - 1,000 requests leave one entry;
  - `REQUEST_ACCESS` is on the UNGATED ratchet, and a page cannot reach any other type through it.
- **Upgrade:** a stored config without `siteRequests` means on; a request store written by this PR and read after a
  schema bump (fixture).
- **e2e:** flip spec attacks 3 to 7 (1,000 calls → badge 1; no gesture; 50 subdomains; iframe/sandbox/`about:blank`;
  denied then reload/new tab/new window):
  - a gesture from a click on the HUD card does not count;
  - a granted request makes the page's next `ml.chat` work with no reload.

**Docs:**

- `docs/API.md` 1.8 (the `requestAccess` part);
- `docs/dev/site-access.md`;
- `SITE_ACCESS.md` (status, and the Q11 deviation);
- regenerate the API docs;
- a `Prompt-Review` note if the JSDoc grew.

**Labels.** `@api`, `@ui`.

**Order.** PR 1 and PR 1b come before PR 2, because the level's storage and the upgrade must exist before anything reads them, and the card reads the tool registry.
PR 2 comes before PR 4, because `requestAccess({ agents })` needs the level. PR 3 can land with either.

**Coordination.** #626 touches `sw-run-host.ts` and `security-audit.md`. Branch PR 2 after it merges.

## 5. Where the current spec and build disagree

1. **The spec's "Upgrading an existing install"** says upgrades are out of scope and only the seeding is kept (fixed in
   PR 0). Since then:
   - the AGENTS.md rule to test the upgrade has applied;
   - #578 decided an upgrade (existing origins keep agents, with start approval);
   - #611 and #625 shipped upgrade tests.

   The section is stale.
2. **The stub** is in slice 3 in the spec's slice list. The e2e suite gates it as slice 4 (Q13). Fixed in PR 0.
3. **"What the agent level gates: … (`RUN_CONTROL_TYPES`)".** That set also holds `PAGE_CANCEL_RUN`, which the spec
   then says stays allowed. The level needs its own set of three (the spec names them in PR 0).
4. **"A `createAgent` handle sends every turn as a new START_RUN".** That is true only when the run is hosted in the
   background. A handle on a page with no debug surface and no gated tool, or on a self-approving origin, loops in the
   page and sends no START_RUN at all. Q1 makes the choice explicit with `host: "page"`.
5. **`resumeMessages`.** The spec does not mention it. A handle's START_RUN carries the history the page holds, which
   makes "one approval per session" approve whatever history the page writes (Q4).
6. **The whitelist.**
   - Host-keyed matching was still live in `senderTrust` and `publicConfig`, over http too. Only `decide` was narrowed
     to https in slice 1. #628 closes it (Q19); it was open when this was written.
   - It is stored in `sync`, which the spec rules out for site decisions.
7. **The tool gates of page-started runs** take focus and approve on Enter (Q15). The spec's threat list does not cover
   timing.
8. **`docs/dev/security-audit.md` "Known open"** listed two items that are done (removed in PR 0):
   - "START_RUN `maxSteps` is not clamped … `origin`" was fixed by #579 (`pageStartPayload` uses `stepBudget` and drops
     `origin`);
   - "A page-built run whose approved site is revoked … is not handed to the worker" was done by #621, and is also
     ticked under Done.
9. **`docs/dev/state.md` grants table** still had (removed in PR 0) "Implicit: a tab hosting a run may send non-control page messages
   regardless of the site lists". `RUN_TAB_TYPES` went in #611.
10. **`docs/API.md` "Security & trust model"** predates site access. It says any page the extension is active on can
    call `window.ml`. PR 0 adds a brief description of site access and links this reference; PR 2 and PR 4 fill in
    the agent level and `requestAccess` (1.8).
11. **AGENTS.md "Config"** says `DEFAULT_CONFIG` is duplicated in `background.js` and `popup.js`. The popup now imports
    it from `contract-config.ts`. This is not slice 3's business, but PR 4 adds a config key and will meet it.
12. **The hand-overs and the agent level** (Q9): #621 hands a page-built run to the worker on a site revoke. Applying
    the same rule to an agent-level revoke would keep alive a run the person just said this site may not start.
13. **Spec rule 3 (gesture)** assumes `navigator.userActivation` proves the person interacted with the page. Activation
    from our own card's iframe propagates to the page (Q11).
