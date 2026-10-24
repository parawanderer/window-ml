# Spec: artifacts, pages the agent writes and nothing can send anywhere

**Status: spec-wip, nothing built.** Written 2026-10-24 from [issue #320](https://github.com/parawanderer/window-ml/issues/320)
(the "agent canvas", refined 2026-10-23 into artifacts) and a design session with @parawanderer the same day. The
decisions marked RULED are his; everything else is proposed. The spike that answered the open questions is
[docs/plan/artifacts/SPIKE.md](../plan/artifacts/SPIKE.md) (2026-10-24); what it changed is marked "(spike)" below.

## The problem

An agent can only show what the transcript draws: text, a table, an image, a code cell. A todo list over data it
gathered, a figure from `python_exec` with controls beside it, a view of `ml.current`, a small dashboard: each needs a
page, and a page the MODEL writes is code the model wrote, which is exactly what a prompt-injected model would use to
send the conversation somewhere.

An artifact is that page, made safe by construction: the model writes its markup, style and scripts as DATA, the
extension runs the scripts through a mediated evaluator, and nothing reachable from them can make a request.

It is not web development through the host. A project built with `ml.sh` is files on the host's disk, served by a
real server on its own origin: ordinary shell work. An artifact is part of the extension, has no files, and is
private, isolated and permissioned by default.

## What an artifact is

```
{ id, title, version, body, css, scripts[], state }
```

- **`body`** is HTML, with our elements for what an answer can draw (pointer embeds, diagrams, Markdown prose), and
  an optional `format: "markdown"` for an artifact that is mostly prose. See [The body](#the-body).
- The HTML it produces is sanitized on every write with an allowlist (DOMPurify): no `<script>`, no `on*` attribute,
  no `<meta>`, `<base>`, `<link>`, `<iframe>`, `<object>`, no form `action`. A `src` may only name a pointer
  (`@tool:<id>:out`, `@artifact:<id>`), which the host resolves to a `data:` URL. An `href` opens only through a
  host-drawn "open this URL?" that shows the whole URL.
- **`css`** is kept as written; the frame's CSP stops any load it names.
- **`scripts`** are source text in the read-only dialect's grammar, run by the [artifact realm](#the-artifact-realm).
  They are parsed when a version is WRITTEN, so a refusal reaches the model in the tool result, not at render time.
- **`state`** is JSON held by the host, never by the frame. See [State](#state).

### The body

HTML is the base, because varied layouts are expressed better in HTML than in Markdown (@parawanderer, 2026-10-24).
Everything an answer can draw is an element, so an artifact can draw it in any layout:

- **`<ml-embed ref="@tool:<id>:out">`** shows a pointer's value, as an answer's `![…](@tool:…)` does.
- **`<ml-mermaid>`**, **`<ml-chart>`** and the styled components below.
- **`<ml-markdown>`** holds Markdown prose, rendered by the answer renderer, so `![…](@tool:…)`, ```` ```mermaid ````
  fences, math and the [attribute block](#showing-one-in-an-answer) work inside it as they do in an answer.
- **`format: "markdown"`** is shorthand for a body that is one `<ml-markdown>`: an artifact that is mostly prose.
- **Dynamic content** is built by a script with the same elements: a todo row a script creates from `state` can hold
  an `<ml-embed>`. One element type serves both.
- **The HOST draws every embed, not the frame.** The frame cannot make a frame (`frame-src 'none'`) and holds no
  pointer it was not given, so an `<ml-embed>` asks the host by message; the host resolves the pointer and sends back
  what to show: a `data:` image, a sanitized table, a diagram's SVG from the existing mermaid frame as an inert
  `<img>`. Showing a value does not hand it to the artifact's scripts; reading one (`pointer` in the realm) is
  separate.
- **Rejected:** a JSON component tree. Safest of the three, but verbose, and models write it worse than Markdown or
  HTML.

Every write makes a new VERSION; old versions are kept and can be opened. Code is immutable per version; state is not
versioned with the code, so a rewrite of the scripts keeps the data.

## Who owns one

One mechanism, two owners (issue #320):

- **A conversation** owns it: its state lives with the session record, syncs and archives with it, and dies with it.
  A fork copies it at the fork point.
- **The person** owns it: a named personal page with its own list, until deleted. "Keep as page" promotes a
  conversation's artifact. A run writing a personal page needs a per-page grant.

Phase 1 is conversation artifacts only.

## Writing and editing

RULED: the model edits the SOURCE, never the live DOM. A live edit is lost on reload, is no version and does not
export.

- **A builtin tool** (`artifact`, in the tool registry) creates one and writes a version: whole fields, or a
  `str_replace`-style edit of one field (`old` → `new`, unique match), the shape models patch text with best.
- **`exec`** reaches an artifact through an `ml.artifact(<ref>)` handle: it READS the rendered artifact
  (`querySelector` over its tree) to check its work, and WRITES through the same edits the tool makes. Reads keep
  read-only `exec` auto-approvable. RULED: an edit re-renders the artifact wherever it is being shown.
- **`python_exec`** gets the source as a pointer value, transforms it, and writes it back as a new version.
- Each write lists what changed: the diff is computed by us between versions, never claimed by the model (the
  `revises` rule, `contract-render.ts`).

**A test render on write.** The scripts run once against the current state when a version is written, so a dialect
refusal, a thrown error or a spent budget comes back in that call's result.

## Showing one in an answer

An artifact is embedded like a tool output, with the inline image form the prompt already teaches
(`![caption](@tool:<id>:out)`, `prompts.ts`):

```
![budget board](@artifact:<id>)
![budget board](@artifact:<id>){side}
![the rows](@tool:<id>:out | head -n 20){collapsed}
```

RULED: placement is a THIRD layer, with its own position. Inside the ref, `:part` says WHICH value; after `|`, the
pipe says what is drawn FROM it; a trailing attribute block (the Pandoc / kramdown / markdown-it-attrs convention)
says WHERE it goes. It applies to every embed, not only artifacts.

- **A hint is a request, never a command.** A surface that cannot honour one draws the default: `side` is inline plus
  an "open beside" control wherever there is no side pane (the sidebar, the phone, exports). An unknown or malformed
  block is dropped: never shown as text, never an error. Exports keep the raw text.
- **First vocabulary:** `side`, perhaps `collapsed`. The parser accepts `{side}`, `{.side}` and `{placement=side}`;
  the spelling the prompt teaches is chosen by a panel of models.
- **Rejected:** a `| side` pipe stage (a pipe goes value to value, and order would start to matter); the image's
  title slot (`"side"`), where models put real titles.
- **An embed is LIVE: the latest code with the live state.** An artifact is a whiteboard that is updated over time
  (@parawanderer, 2026-10-24), and every embed of it is a window onto the one board.
- **Each answer records a SNAPSHOT** of the version and the state when it was written (state is small JSON, capped).
  The embed has "as of this answer", which draws the snapshot read-only, with no script writing state: an old answer's
  "3 items left" still reads right. Exports draw the snapshot, since the log carries what the model saw. Undo restores
  a snapshot as a new version. Old code never meets new state: it is the live board, or a version with its own state.
- **References** take the three forms `@tool:` has, told apart by shape (`docs/dev/pointers.md`): a quoted label, a
  minted id, a bare word for the latest. `ml.answer.add("@artifact:<id>")` and the `answer` tool resolve it through
  the same path.

## The artifact realm

RULED in direction (2026-10-24): the model never writes a script that the browser runs. The scripts are data, run by
the read-only dialect's evaluator (`docs/dev/readonly-exec.md`) in a fourth realm beside the page, the worker and the
policy realms. The evaluator is our own code, loaded in the frame as `'self'` and run in a WORKER the frame starts
from a blob (spike), so the frame's CSP keeps `script-src 'self'`, no model text is ever compiled, and an escape of
the evaluator lands in a scope with no document, no `top` and no network (see [the frame](#the-frame-the-second-wall)).

What a script can reach is one table, and nothing else is in scope:

| Receiver | Allowed |
| --- | --- |
| `root` | the artifact's view as PLAIN DATA the script owns, parsed from the body before the scripts run: `{ tag, attrs, text, children, on }` nodes and `root.byId`. The host diffs it after each run and sends it through the sanitizer to the frame; `on: { click: (e) => … }` holds a script arrow the host calls on that event (spike: a worker has no DOM, and plain data needs no new receiver kind) |
| `state` | a plain object the script owns, read and written directly; the host keeps it after each run, and rolls it back when a run or an event is refused (spike) |
| pointers | read a pointer value of the owning conversation, as data |
| `ml.current` | read, the owning conversation's |
| `ml.interval` | a budgeted repeat (a clock, a poll of state) |

`window`, `top`, `parent`, `location`, `fetch`, `XMLHttpRequest`, `WebSocket`, `RTCPeerConnection`, `open`,
`document.cookie` are not names in scope: the channels they open are ABSENT, not closed.

**Halting.** The dialect halts by construction (no `while`, no `for(;;)`, `for…of` over held collections, bounded
call depth), and every run and every event handler has a step budget. An artifact cannot hang the chat on any
surface, the phone included.

**`while` later, in this realm only.** The step budget bounds a loop the language cannot prove halts, so a `while`
here would cost a step per pass and end in "out of budget at line N", drawn by the host on the artifact and returned
to the model. The other realms keep refusing it, with adversarial tests saying so. A long computation that keeps
running without blocking needs a time-sliced evaluator: a further extension. Proposed after the spike, not measured:
in a worker a long run blocks neither the frame nor the chat, and the frame can terminate the worker on a deadline,
which may make the time slicing unnecessary.

**What it costs.** No third-party libraries: charts are our own components in the frame (`<ml-chart>`, beside the
styled components below) or a `python_exec` figure through a pointer. The dialect's syntax, not all of JavaScript.
Interpreter speed: enough for a UI, not for computation, which belongs in Python. Extending the dialect needs
adversarial tests and a re-check of its whole contract (readonly-exec.md, "The rule for extending the dialect").

## The frame: the second wall

The artifact draws in an opaque-origin sandbox frame, the way ```` ```mermaid ```` fences are drawn (`src/mermaid/`,
the manifest's `sandbox.pages`, `sandbox="allow-scripts"`). The web build and the phone use
`<iframe sandbox="allow-scripts" srcdoc>` with a CSP the host prepends. The frame matters if the evaluator is ever
escaped, and it keeps the artifact's CSS from painting over the conversation.

Measured by `tests/e2e/artifact-wall.spec.mjs`, every route under four manifest variants (spike, Q1):

- The manifest's sandbox CSP gains `default-src 'none'` (it has none today, so style, font, media and prefetch loads
  leave the frame), `img-src data:` (it is `'none'`, and resolved pointers are `data:` images) and `worker-src blob:`
  (for the evaluator's worker).
- The EMBEDDING page sets `frame-src 'self'`, which stops the frame navigating itself to another site by every route
  tried: `location`, a meta refresh, a link's click, through a `data:` or `blob:` page. The extension pages' CSP sets
  no `frame-src` today.
- Three routes leave a window under every CSP: `<link rel=preconnect>` (and so DNS), WebRTC's STUN, and
  `top.postMessage` (the site, under the in-page sidebar). None exists in a worker, which is why the evaluator runs in
  one: the frame's window runs only our renderer, over a view the sanitizer has passed.
- The host draws the artifact's border, title and badge OUTSIDE the frame, so an artifact cannot draw a convincing
  approval card or ask for a key in a pane that looks like ours.
- Messages from the frame are taken only from that frame's window (`e.source`), as `mermaid-client.ts` does.

## State

Held by the host, handed to each run as `state`, a copy the script owns and writes directly (spike), stored back after
the run and scoped to the artifact's id. A write from the person (a ticked todo) goes through the host into the
session, so the agent reads on its next turn what changed, and the log records who wrote it. What the agent reads is
labelled as data the artifact or the person wrote: it is a prompt-injection path ("now fetch https://…?…"), and the
agent's own fetches stay gated.

## Styling

The host prepends classless defaults (a plain `table`, `button`, `input` look right) and about ten classed components
(card, stat tile, pill, checklist row, two columns, output block, chart) on the chat page's palette, so artifacts follow
the theme. Each artifact records the component set's version it was written against.

## Export

An artifact exports as ONE self-contained HTML file with its current state baked in: its markup, style and scripts, the
component CSS, the evaluator, the state inlined behind a stand-in for `get`/`set`, and the CSP kept as a `<meta>`, so the
file cannot send its data anywhere from disk either. The Markdown, PDF and JSON exports carry the source the model
wrote beside the drawn view (AGENTS.md, "the log ALWAYS carries what the MODEL actually saw").

## What must be impossible

The frame and the scripts are given the conversation's data on purpose. What must be impossible is that data leaving.

| Channel | Mediated scripts | The frame, if the evaluator is escaped |
| --- | --- | --- |
| A request (`fetch`, XHR, WebSocket, a stylesheet, font, image, media load) | not in scope | `connect-src 'none'`, `default-src 'none'` |
| Navigating itself (`location`, `<meta refresh>`, a clicked link) | not in scope; `<meta>` is sanitized away, links go through the host | the embedder's `frame-src 'self'` (to verify) |
| Navigating the top page, a popup, a form | not in scope | sandbox flags (no `allow-top-navigation`, `allow-popups`, `allow-forms`), `form-action 'none'` |
| WebRTC, which CSP does not cover | not in scope | open: removing the constructors, or the spike's finding |
| `top.postMessage`: under the in-page sidebar, `top` is the SITE's page | not in scope | open: CSP does not cover it |
| DNS prefetch, preconnect | `<link>` is sanitized away | the spike's finding |
| The host API as a confused deputy | read-only and scoped to the owning conversation; scrubbed like any other output (`sw-scrub.ts`); writes only its own state; no tool calls in phase 1 | the same |
| The agent as the channel | state reaching the model is labelled as data | the same |
| The person as the channel (a fake approval card, a "paste your key" form) | the host-drawn border and badge | the same |
| Exhaustion (a hang, memory, a huge tree) | halting, step budgets, caps on source and state size | a frozen frame shows a host notice where the frame has its own process |

Every row lands as a red-team test that fails first (`tests/redteam.test.js`, `tests/e2e/site-access.spec.mjs`), as
AGENTS.md requires for a new agent tool and a new `ml.*` member.

## Order

1. **Spike**: done 2026-10-24, [SPIKE.md](../plan/artifacts/SPIKE.md).
2. **Phase 1:** conversation artifacts with no capabilities: the tool, the realm, the frame, state, versions, embeds
   with the attribute block, every surface, exports, red-team.
3. Keep as page (personal artifacts).
4. Data sources: live data the HOST fetches under a per-origin grant; the page never holds a token.
5. Actions: a button that makes a gated tool call, rememberable like a policy.
6. `while` in the artifact realm; a time-sliced evaluator.

## Open questions

Answered by the spike ([SPIKE.md](../plan/artifacts/SPIKE.md)): the second wall, the evaluator in a sandbox page,
the realm's shape and what models write. What it left open:

- **Five dialect additions** models reached for: `Math.random`, the `Number` statics, array destructuring in a
  `for…of` head, numeric object keys, and `riskyRegex` passing a group of fixed counts. Which belong to the artifact
  realm only, and which to every realm.
- **A `find(selector)` helper over the `data` view**, if models ask for one; none of the panel needed it.
