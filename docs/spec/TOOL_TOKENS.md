# Tool tokens — deterministic tool output woven into the final answer

**Status:** spec / not yet built. Author: design discussion, 2026-09-01.

## Problem

When an `ml.agent` run finishes, the model writes a free-text summary. If it wants to *show*
you something it did — the JS it ran, the table `python_exec` produced, the element it found —
it has to **re-type that from memory**, and a small model gets it subtly wrong: a paraphrased
query, a hallucinated number, a mangled table. The real output already exists, rendered, one
step back in the transcript — the model just can't point at it.

We already retain, per tool step, exactly what's needed to fix this: a monotonic `seq` and **two
serializable render descriptors** — `renderIn` (a view of the *call*: `exec`'s pretty JS,
`python`'s notebook cell) and `renderOut` (a view of the *result*: `locate`'s badged image,
`python`'s output table). One registry already renders them in every surface (`RenderPanel`,
reused by the sidebar, the HUD card, and the export).

**Idea:** give every tool call a stable **token**, surface it to the model, and let the final
answer reference it with a markdown link so the *actual* input/output is spliced in verbatim —
rendered by the same descriptor pipeline. The model narrates; the machine supplies the facts.

This generalizes the parked "exec/python output as the answer" idea (`idea-exec-output-as-answer`):
deterministic output instead of hallucinated re-typing.

## Token model

- Each tool step's **token id** is `hash(runHash + ":" + seq)` truncated to ~6 hex. This is the best
  of both: **deterministic** (a replay / re-render of the same run mints the same id, so a persisted
  or re-adopted transcript still resolves) yet **opaque to the model** — it looks like a random hash,
  so the model must **copy** it from a result. A *guessed* id won't match the hash (→ a visible
  "unresolved" chip) instead of silently resolving to the wrong step.
- A token addresses a step's render **slot** (colon), with an optional **format** piped after it (`|`):
  `@tool:<id>[:in|:out][ | <format>]`
  - `@tool:35bf1f` — the **output** (default, = `:out`).
  - `@tool:35bf1f:out` — `renderOut` (else the raw result text).
  - `@tool:35bf1f:in` — `renderIn` (else the raw args).
  - `@tool:35bf1f:out | latex` — pipe the value through a **format override**: interpret it as
    **LaTeX** and render as math. The `|` reads like a filter pipe (Jinja/shell), which models know;
    whitespace around it is optional (`…:out|latex` ≡ `…:out | latex`). Format is extensible (default
    = the descriptor's natural render); an unknown format falls back to the natural render. Shipped:
    - `latex` — a scalar/expression rendered as a formula (KaTeX). An `![…]` EMBED renders as a green
      tool-output BLOCK (marker + caption), like a non-latex output; a `[…]` link stays inline.
    - `img` — render the tool's OWN image bytes: a raster `data:image/(png|jpe?g|gif|webp);base64,…`
      URL or a bare base64 blob. Deliberately STRICT — no `svg`, no `data:text/html`, no `javascript:`,
      and NO external http(s) URL (that would beacon the viewer); anything else falls back to text.
    - `raw` — force the LITERAL value as a plain text/code block (skip any table/image/latex derivation).
    - AUTO: a python_exec that returns a sympy expression / a `sympy.latex(...)` string / an image already renders typeset (or as an image) with NO pipe — the descriptor carries a `latex:true` / an image, and a plain `:out` cite honors it. A pipe only OVERRIDES.
- A token resolves **only within its own run**. Unknown/foreign/garbled → an "unresolved ref" chip,
  never a crash.
- **Tool-name alias.** An id that is a **tool name** instead of a 6-hex id — `@tool:python_exec:out` —
  resolves to **that tool's LAST tokened step** in the run. Models routinely reference "the last
  python_exec output" by name (they never saw the hidden hex id — a citable builtin mints its token
  without the model opting in), so this accommodates the natural idiom. Two anchoring granularities: the
  **hex id** is a permanent anchor to **one specific call**; the **alias** is a coarser anchor to **the
  tool's most recent call** — and it lets the model cite an output *after the fact*, without having set
  `token: true` beforehand. Grammar-gated: a non-hex id is treated as a token ONLY when the surface
  confirms a step of that tool actually ran (`isAlias`), so a genuinely garbled `@tool:nothex` still
  stays prose. Resolution: `resolveToken` tries an exact minted-id match first, then the alias
  (`resolveTokenStep` / the `res.outputs` resolver both use it). Works for the 5 citable **builtins**
  always; a **custom** tool's alias resolves only if the model opted in with `token: true` (only then is
  its token minted).

## Surfacing the token to the model (flag: `toolTokens`)

The model can only reference a token it was shown. So when enabled, each tool result the model
receives gains a terse trailing line, e.g.:

```
…tool result text…

[output token: @tool:35bf1f — reference it in your final answer with a markdown link]
```

- New `AgentOptions.toolTokens?: boolean` (default **false**). A **HUD-started run turns it on
  automatically** (set in the `__mlStartAgent` handler, the same spot `HUD_HINT` is added), because
  that's where a rich answer card is shown. A headless / console `ml.agent()` gets no benefit
  (nothing renders the card), so it stays off unless the caller opts in — no wasted tokens.
- Threaded page→background on `StartRunPayload.toolTokens`; logged in the sidebar "agent options"
  block like the other options.
- Gating also controls the **prompt clause** (below) and the final-answer resolver — all three move
  together, so an off run behaves exactly as today.

## Referencing a token in the final answer (real markdown)

The model uses an ordinary markdown link whose URL is the token:

```
I ran your query in `exec`:

[the query](@tool:35bf1f:in)

and it returned:

[the result](@tool:35bf1f:out)
```

- **Real markdown link syntax** (`[label](url)`) — NOT the inverted `(label)[url]`, which fights the
  model's training.
- **Block vs inline is decided by the descriptor, not the syntax.** A link alone in a paragraph, or
  one whose descriptor is block-level (table/image/code), renders as a block; a link to a small
  scalar mid-sentence can render inline. The surrounding prose is the label; the label text is
  shown as the block's caption/alt where a surface wants one.
- Default `:out` so `[result](@tool:35bf1f)` is the common short form.

## Resolution & rendering (reuse everything)

The final answer is markdown-with-token-links. Resolution differs by consumer, but **both reuse
existing renderers** — no new descriptor rendering is written:

- **UI surfaces (HUD card, sidebar agent-result, export HTML/PDF):** split the markdown on token
  links; render prose spans as markdown, and each token as `RenderPanel` fed the referenced step's
  `renderIn`/`renderOut`. Same registry, same look as the transcript. Per the render-in-both rule,
  build it for **all three** surfaces, not HUD-only.
- **Programmatic (`ml.agent().summary`) and the `.md` export:** resolve each token link to **inline
  markdown** using the **export's existing `mdSink`** (`export.ts`) — the one place that already
  turns a descriptor into markdown (table → GFM table, code → fenced block, image → sidecar/data-URI
  or a `[image]` placeholder). So `summary` comes back as self-contained markdown a headless caller
  can print. (HUD runs are background-hosted, so their `ml.agent()` promise usually dies with the
  page anyway; this mainly matters for an opt-in headless caller.)
- **Unknown token:** render a visible `⟨unresolved @tool:xxxx⟩` chip / text, never throw. Validate
  at resolve time against the run's known step ids.

## Provenance & verifiability (hover + click-to-step)

An embedded output is only trustworthy if you can trace it back to the real run — otherwise it's
indistinguishable from prose the model made up. So **every rendered token carries its provenance**,
not as an option but as part of the render:

- **Hover** a token render → a small chip: "deterministic • step N • `<tool>`" — signalling this block
  is the *actual* captured output of a tool call, not model text.
- **Click** it → open the **"Show work" transcript at that exact step** and **green-pulse** it. The
  sidebar already addresses rows by `seq`, so this is a scroll-to-`seq` + a pulse class.
  - HUD card → opens the sidebar/DevTools transcript scrolled to the step.
  - Sidebar agent-result → scrolls within itself and pulses.
  - Export (static, no JS transcript to open) → the token render links to the step's section anchor.

This is what makes weaving outputs into the answer *safe to trust*: the reader can always jump to the
step that produced it. The wrapper element carries `data-tool-token` / the step `seq` so all three
surfaces share one hover+click affordance.

## The `answer` set — user-facing, minimal, curated

`answer` is **user-facing**: whatever is in it is what the person who started the run *sees* as the
result. So the framing (and the tool description) is explicit: **keep it minimal and make it match
what the user actually asked for** — not a dump of everything touched. Today `answer` only
*accumulates* DOM elements, so a model that calls it a few times can't walk anything back. It becomes
a small **curated, ordered set** the model manages:

- **Items** are heterogeneous: a **tool token** (`@tool:35bf1f:out` — a table, an image, a value), a
  **DOM element** ref (the existing live-node → HUD highlight), or a short **text/markdown** snippet.
- **Operations** — the model can *manage*, not just append: **add** (default), **remove/pop** by
  index or item, **clear**, and **reorder**. So it can add a candidate, then drop it if a later step
  supersedes it — the exact "pop items it doesn't like" ask.
- **Two front doors, same set:**
  1. The **`answer` tool** — `answer({ add: [...] })` / `{ remove: [...] }` / `{ clear: true }`.
  2. **`ml.answer` — a run-bound collection object** (NOT a function). Callable-namespace hybrids are a
     Python-ism with no clean JS form here, and — decisively — a function's `.length` is its *arity*,
     which would collide with the wanted `.length` = item-count. So it's a plain collection:
     ```js
     ml.answer.add("Total: 42")          // text item
     ml.answer.add("@tool:35bf1f:out")   // a tool output — the @tool: prefix ⇒ token (cf. @pt:/@box:)
     ml.answer.add(el)                   // a live element (ml.queryAll) → HUD highlight
     ml.answer.remove(0)                 // by index, or remove("@tool:35bf1f")
     ml.answer.clear();  ml.answer.length
     ml.answer                           // dumps the set for inspection
     ```
     Each item is added as a **primitive** (text / `@tool:` token string / Element); inspecting the set
     yields lightweight indexed records — `{ i, kind: "text"|"token"|"element", preview }` — so the
     model has handles to curate by without a heavy wrapper type. `@tool:`-prefixed text that's meant
     literally uses the escape `add({ text: "@tool:literal" })`.
     - **Free in read-only `exec`** — no approval. It mutates the run's own answer set, so it isn't
       "read-only" in the pure sense, but read-only exec is "safe *terminating* JS operations" (it
       already builds arrays/sets/strings), and curating your own user-facing answer is one such
       operation — it spends nothing, touches only this run's answer surface, grants no capability a
       hostile page doesn't already have. Blessed into the `readonly-exec.ts` facade
       (`ML_READONLY_METHODS`-style allowlist) — the **first *mutating* facade member**; noted as a
       deliberate exception there and in the security invariants.
     - **Run-bound; invalid outside a turn.** `ml.answer` targets the currently-executing run's set.
       Called from the console with no active run it **throws** a clear message ("ml.answer is only
       live inside an ml.agent run…"), not silent `undefined` (which would fail later as a baffling
       "cannot read properties of undefined").

The **final free-text turn** (the narrative, which may embed `@tool` tokens) and the **`answer` set**
(the crisp deliverable) coexist: the HUD card shows the curated set as the headline result, the
narrative below it. If the model curates nothing, today's behavior holds — the final text is the
answer, its embedded tokens resolved inline.

## `AgentResult` / `ml.agent()` return

Keep the return object a **good representation of the result, with no rendering plumbing in it**:

- `summary` stays a **string, and is markdown**. Token links in the final text are resolved to inline
  markdown via `mdSink` before the promise resolves, so a console caller gets a self-contained
  document (`console.log(r.summary)` shows the table as a GFM table). No token links leak out; no
  `refs`/descriptor arrays in the return.
- The curated `answer` set is exposed as **resolved content**, not references — e.g.
  `AgentResult.answer?: string` (the set rendered to markdown) and/or the existing `elements`/
  `answerMedia` for the live-node items. A caller gets the *result*, never the machinery.
- The **UIs don't read the return object** for rich rendering — they render from the debug-event
  stream (the `agent-result` event carries the raw answer template + the answer set; per-step
  descriptors are already buffered from the `agent-step` events) via `RenderPanel`. So the return
  object stays clean and the UIs stay rich, independently.

## Prompt clause

A terse clause (like `SELF_CLAUSE`), appended **only when `toolTokens` is on**, teaching: outputs are
addressable; each result prints its `@tool:id`; reference one in the final answer with a markdown
link `[label](@tool:id:out)` (`:in` for the call, `:out | latex` to render a value as math); **copy the
hex id verbatim** OR cite a **builtin's latest output by tool NAME** (`@tool:python_exec:out`) without
opting in — the hex points at a specific call, the name at the tool's most recent one; and that the
**`answer` set is what the user sees — keep it minimal and matched
to the ask** — curate it with `answer({ add/remove/clear })` or the free `ml.answer(...)`, and a tool
output can *be* the answer (a table, an image) by adding its token. Kept out of the system prompt on
every run because it's only true when the flag is set, matching the `SELF_CLAUSE`/HUD-hint pattern.

## Data flow / touch points

- **Mint + carry:** `tool-exec.ts` (or the loop's `emitStep`) mints the id (`hash(runHash:seq)`) per
  call; it rides the `agent-step` event next to `seq`/`renderIn`/`renderOut`.
- **Surface:** when `toolTokens`, append the token line to the result the model sees (in the loop,
  where the tool envelope becomes the `{ role: "tool" }` message).
- **Flag threading:** `AgentOptions.toolTokens` → `StartRunPayload.toolTokens` → agent-options log;
  `__mlStartAgent` sets it for HUD runs.
- **Prompt:** a new `*_CLAUSE` in `prompts.ts`, gated like `SELF_CLAUSE`.
- **Resolve for UI:** the HUD card + sidebar agent-result + export split the template and call
  `RenderPanel` per token, each wrapped in the hover+click provenance affordance (`data-tool-token` +
  `seq`).
- **Resolve for markdown:** `export.ts` `mdSink` gains a "descriptor by token" path so `summary` and
  the `.md` export inline the output.
- **`answer` revamp:** the `answer` tool becomes a curated set (`add`/`remove`/`clear`) over items
  (token | element | text); `AgentResult.answer?` (resolved markdown) + existing `elements`/
  `answerMedia`. Add `ml.answer(...)` to the API and **bless it into the read-only-exec facade**
  (`readonly-exec.ts` `mlFacade` / `ML_READONLY_METHODS`) so it runs free in `exec` — a documented
  exception to "facade is read-only" (mutates only the run's own answer surface, spends nothing).
- **LaTeX mode:** a `latex` `RenderDescriptor` (or a render-mode field) the surfaces map to a math
  renderer (KaTeX-class), reachable via `@tool:id:out | latex`.
- **Provenance UI:** a shared wrapper (all three surfaces) rendering the hover chip + click→scroll-to-
  `seq` + green-pulse.

## Security

Descriptors are **data**, already serialized across the window bus (functions/Nodes never cross);
referencing an earlier step's descriptor in the final answer is just re-displaying retained data —
no new capability, no code execution. Tokens are run-scoped, so one run can't pull another's output.
The export already pushes every dynamic string through `escapeHtml`/`markdown()`; the final-answer
prose goes through the same, so an embedded label can't inject markup.

## Build order

Ordered to ship the independent win first, then de-risk model *behavior* before investing in the
renderer, then the visible payoff, then parity, then the flourish:

1. **`answer` revamp (no tokens needed).** The accumulate-only tool → a curated set
   (`ml.answer.add`/`remove`/`clear`/`length`, items = element | text; token items come in step 3);
   user-facing/minimal framing in the description; `ml.answer` as a run-bound collection blessed free
   in read-only exec (throws outside a run); `AgentResult.answer?`; the HUD card shows the set.
   Self-contained, improves something already shipped, testable now.
2. **Token mint + surface + prompt clause (no renderer yet).** `hash(runHash:seq)` on the
   `agent-step` event; the `toolTokens` flag (HUD auto-on) threaded; the per-result token line; the
   clause. **Probe** (`observe.mjs`) that the model actually emits `[label](@tool:id:out)` links —
   grep the final answer; nothing rendered yet. De-risks the behavior before the renderer.
3. **Resolve + render (HUD card) + provenance + token items.** Split the final answer on token links →
   `RenderPanel` per token, each wrapped in the hover-chip + click→step green-pulse; `summary` via
   `mdSink`. Add token items to the `answer` set (the pandas-table headline). The visible payoff —
   probe end-to-end.
4. **Parity:** sidebar agent-result + export render the same template + provenance (render-in-both).
5. **LaTeX format** (and the extensible pipe mechanism): `@tool:id:out | latex` → a math render.

## Resolved decisions

- **Id source:** `hash(runHash:seq)` truncated — deterministic (survives replay/re-adopt) yet opaque
  to the model, so it must be copied, not guessed.
- **Inline scalars:** a small scalar `:out` renders **inline**; block descriptors (table/image/code)
  render as blocks. Plus a `latex` mode for math.
- **`answer` is a curated set** (add/remove/clear/reorder), user-facing + minimal, drivable by the
  tool or the free `ml.answer(...)`. Supersedes the "multiple answers" question — it's an ordered set
  by design.
- **Return object** carries resolved markdown only (no render refs/plumbing).

## Open questions

- **`ml.answer(...)` signature:** `ml.answer(item)` append + `ml.answer.remove/clear`, or a single
  `ml.answer({ add, remove, clear })`? Must read cleanly in a read-only `exec` one-liner.
- **Blessing a *mutating* method into the read-only facade:** confirm the precedent is acceptable —
  `ml.answer` would be the first facade member that changes state (everything else is pure read). It's
  safe (own-run answer surface, no spend, no privilege), but it widens "read-only exec" to "read-only
  + curate-my-answer." Worth a deliberate note in `readonly-exec.ts` and the security invariants.
- **Streaming answers:** resolve tokens only at end-of-turn (the template isn't complete mid-stream) —
  confirm the live "thinking/answer" stream shows raw links until finalized.
- **LaTeX renderer:** KaTeX is the natural pick, but the artifact/CSP + bundle-size story needs a look
  (inline the font/CSS; no external fetch). Scoped to phase 4, so it doesn't gate v1.
