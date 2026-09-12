# Exports

Implementation notes for the Markdown/PDF export log and the programmatic JSON export, moved out of AGENTS.md on 2026-09-12 so they are read when that code is being
changed rather than loaded into every session. AGENTS.md keeps the repository's working rules and the traps that
bite; this file keeps how the subsystem works and why it is built that way. Paths name files by their bare name,
as in AGENTS.md — they are all under `src/`.

**Export log.** The detail-view header has an "Export log" button opening a small
menu with two formats (chat and agent both). It serialises the in-memory session
(options, turns/steps, exec JS beautified, results, model provenance, timestamps)
— no new plumbing, it's all already in the `Session` object.

*One walk, two sinks.* `writeAgent`/`writeChat` walk the `Session` and emit through
a **`Sink`** — a deliberately small *semantic* vocabulary (`note`/`block`/`prose`/
`image`/`details`/…, never "bold this"), so each format renders those meanings its
own way. A third format = a third sink, not a third walker.

- **Markdown** (`mdSink` → `serializeSession` → `{ md, images }`). **Screenshots
  ship as real PNG sidecars**, because base64 in a text file is unreadable to a
  coding assistant but a `.png` can be opened: the sink decodes each data-URL and
  the markdown references `images/step-N.png`. A run with images downloads a
  **`.zip`** (`run.md` + `images/*.png`); a text-only run downloads a bare
  **`.md`**. The zip is written by a tiny dependency-free **store-method**
  `zipStore` (PNGs are already deflated, so no compression — local headers +
  central directory + a hand-rolled `crc32`). The iframe can't touch the
  filesystem, so it downloads via a `Blob` + `<a download>` click.
- **PDF** (`htmlSink` → `sessionToHtml` → `printSession`). A self-contained
  light-themed HTML doc (inline `PRINT_CSS` + the bundled Atom One *light* hljs
  theme, images inlined — a print doc has nowhere to put sidecars). `printSession`
  **routes the doc to the background** (`PRINT_SESSION` → `chrome.runtime.sendMessage`,
  which reaches it from BOTH surfaces), which opens a bundled **`print.html` tab**
  (`src/sidebar/print.ts`) that fetches the doc by key (`GET_PRINT_DOC`, one-shot),
  drops it into an iframe, prints THAT, and closes itself (`CLOSE_PRINT_TAB`). This
  is because `window.print()` is **SUPPRESSED for a frame inside DOCKED DevTools**
  (the panel surface) — a real top-level tab prints fine; markdown export was
  unaffected (it downloads via `<a download>`). The background stashes the doc in a
  `pendingPrints` map with a TTL timer (cleared on fetch) so a dismissed export
  never leaks. A `printInFrame` fallback (the old offscreen `.printframe` +
  `contentWindow.print()`) remains for when the runtime channel is absent. Chrome
  seeds the **filename from the printed doc's `<title>`**, so it's set to the same
  `ml-agent-<hash>` base as the `.md`. `@page` margins + `break-inside: avoid` on
  images/code/notes are the reason this isn't just the sidebar's stylesheet. The
  doc renders at the **extension's origin**, so the HTML sink pushes every dynamic
  string through `escapeHtml`/`markdown()`/`highlight()` (all three escape) — a
  hostile tool result or model reply can never inject markup. Disclosures are
  `<details open>`: a collapsed one prints as just its summary.


**Programmatic export (`export-schema.ts` + `docs/spec/export.schema.json`).** The JSON export is a
PUBLISHED contract, and `export-schema.ts` (root, beside contract.ts) is normative. Two things about it are
easy to get wrong. **Internal types are RESOLVED, and tag their own instability**: the
generator chases every referenced type out of contract.ts lazily and transitively — no hand-kept list,
because one goes stale silently and the schema would then describe less than it claims while still
looking complete — so a consumer gets real types for `renderIn`/`renderOut`/`config` instead of an opaque
object. The ones that WILL grow carry **`@unstable`** in the JSDoc above their declaration; the generator
marks those `x-unstable`, says so in the description, and gives an unstable UNION a trailing branch that
accepts anything, so adding a render-descriptor variant does not start failing an old consumer's
validator. A union inherits its members' instability, which is what makes an inline
`DebugSessionConfig | DebugAgentConfig` permissive without being tagged itself. Put `@unstable` on a type
and the schema follows: that is the whole mechanism. **And a differ needs more than the field list**: `VOLATILE_FIELDS` names the fields to strip,
but a pointer id is also surfaced *as text* (an `@tool:` citation in an answer, a `dereference` ref, the
token line on a result), so removing `steps[].token` leaves every copy behind — `VOLATILE_PATTERNS` +
`canonicalizeText()` handle those, and the session hash is deliberately NOT a pattern (eight bare hex
characters would strike colours and short commits too; its value is known from `session.hash`).
`scripts/gen-export-schema.mjs` lifts the interfaces into **JSON Schema draft 2020-12** so a Python or Go
consumer can generate models (`datamodel-code-generator` → Pydantic, `quicktype`, …). It is a line scanner
for the same reason `gen-api-docs.mjs` is (typescript@7 is the Go port, no JS compiler API) and THROWS on a
type it cannot map rather than silently emitting "anything". Unlike the other generated files the output is
**checked in** — a spec people link to cannot be a build artifact — and `tests/export-schema.test.mjs`
regenerates, diffs, and validates real agent AND chat exports against it, including a test that the
validator itself can fail. Each document opens with a **`$schema`** URL pinned to that BUILD's commit on
raw.githubusercontent (`schemaUrl()`, best-effort — omitted when there is no GitHub remote or no commit,
since a wrong URL gets validated against and quietly misleads; still emitted for a DIRTY build, with
`build.dirty` beside it as the caveat). It is the conventional key editors use to validate a file with no
setup, and it points at the commit rather than `main` because `main` drifts away from what the file is.
`generator.build` carries the COMMIT (a manifest version only moves on releases,
so it cannot answer "are these two runs comparable"); its `dirtyDiff` is opt-in via
`ExportProvenance.includeDirtyDiff` — on for a harness artifact whose job is reproducing a run, off for a
download the user shares, since it is unpublished source. `session.page` records where the run STARTED,
previously recoverable only by regexing the system prompt. **`session.events` is the resource panel's event
lane, published** — the run's TIMELINE, so it survives outside the panel that drew it. Derived by the same
`eventsFrom` the panel uses, so the two cannot disagree, and derived deliberately: the arithmetic is wrong
in the same three places every time a consumer redoes it (spans run BACKWARDS from a finish stamp; a tool
step is ONE event with `phases` splitting model/human-at-the-gate/tool, not three; a model load is its own
event because "slow" and "not there yet" are different answers). Sub-calls carry `parent`, so a reader
model's cost is attributable. `evict` is in the kind union but never exported — it is read off `/api/ps`
polls, a fact about the box rather than about a session. The kind union is **`@unstable`**: the timeline is
a general format, and other producers (a benchmark sweep) time spans a session has no concept of. Tagging a
LITERAL union needed a generator fix — `typeToSchema` recognises one as an enum and returns before the
branch that appends the permissive variant, so an `@unstable` enum stayed closed while its prose promised
otherwise. `ExportPhaseKind` is open for the same reason; the variant in sight is how a tool was DISPATCHED
(in process vs an HTTP evaluation endpoint) — a fact about OUR dispatch, never a claim about where the work
ended up, since an in-process tool can reach a VM/container over IPC unobservably. When that endpoint ships
it must report its own measured eval time, or the span is the tool plus the network as one number — the trap
`promptEvalMs` was added to close for model calls.

**Three durations, three diagnoses (`TokenUsage`).** Ollama-native reports `load_duration`, `prompt_eval_duration`
and `eval_duration`; we also stamp our own `genMs` wall clock on every route. `prompt_eval_duration` (→
`promptEvalMs`) was being dropped, which made `genMs - evalMs` — rendered as "+Nms network" — charge the BOX
for reading the prompt, which is the model's own work and scales with a system prompt re-sent every turn. The
tooltip now subtracts it and shows both. The OpenAI route reports none of the three, so `genBasis` says the
rate includes the network; that whole matrix (openai/ollama x streamed/not) is pinned in
`tests/e2e/gen-phases.spec.mjs`, and the fake backend serves BOTH wire shapes — it grew an
`/ollama/api/chat` NDJSON route because only the OpenAI one had ever been exercised end to end.
