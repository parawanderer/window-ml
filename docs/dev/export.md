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

**Three surfaces, one exporter (2026-09-24).** The chat page and the phone app export the same sessions with the
same code, so what used to be `chrome.*` inline in `export.ts` now goes through the services seam
(`sidebar/services.ts`): `saveFile` (a download in a browser, the share sheet on a phone), `printDoc`, `appVersion`
and `assetUrl`. Three things to know before touching it.

`printDoc` is NULLABLE and that is the interface, not a convenience. A PDF is really "print this document and choose
Save as PDF", which needs a print dialog: the extension's frames route the doc to a tab (above), a plain page prints
it in its own offscreen iframe (`sidebar/print-frame.ts`, extracted for exactly this), and a phone app's WebView has
neither. `canPrintSession()` is what the pickers ask, and the phone's picker offers Markdown and JSON only.

`assetUrl` exists because of KaTeX. The print doc loads from a blob URL, whose relative paths resolve against the
ORIGIN ROOT rather than wherever the page is served from, so `url(fonts/KaTeX_*.woff2)` silently 404s on any page
not served at `/`. Each host resolves it: `chrome.runtime.getURL` in the extension, `new URL(path, location.href)`
on a page.

And the diff moved OUT of `BUILD_INFO`. `build-info.gen.ts` carries the commit and the dirty FILE LIST; the
uncommitted diff is `build-diff.gen.ts`, imported only by `tools.ts`, which serves it on `agent_api_docs({ diff:
true })`. Nothing tree-shakes a property off an object literal, so the day the chat page began importing
`BUILD_INFO` for an export's provenance it also began carrying a whole `git diff` into a bundle that never reads
one — and the web build's `chrome.*` guard started failing whenever the working tree happened to contain that
string. A harness artifact that DOES want the diff folds it back in itself (`tests/e2e/run-once.mjs`).

**The picker (chat page, `src/chat/export-dialog.tsx`).** The panel's export is a menu of formats; the chat page's
is a dialog, because the three formats are a choice nobody arrives with an opinion about and a menu makes you pick
before reading what they are for. Each row says who the file is for, not its extension. It also says when the
session is only PARTLY loaded: a long transcript is paged (`transcript-window.tsx`), and a file holding just the end
of a conversation would be read as the whole of it.


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

**A resume is in every surface, and it is not a step.** A session picked up again on a different page
(`session.resume`) shows as a divider in the log, a `---` + `**→ resumed on …**` in `run.md`, and
`session.resumes[]` in `run.json`. It is a fact about the SESSION rather than something in a turn, so it is
none of a step, a message or an answer, and it is positioned by the newest step that had already happened when
it did — `+0.6` in the panel, so it lands past that turn's answer at `+0.5` rather than between a turn and its
own reply. The Markdown export computes the same position through the same `inter` list the answers and says
use, because two orderings of one seam is how the log and the export come to disagree.

The list of what did NOT survive is in the panel's cursor tooltip and written out in full in `run.md`: a static
export cannot hover, and "earlier references no longer hold" is the whole reason the seam is drawn. A differ
should read `resumes` before concluding two runs diverged — everything before one describes a page that was no
longer there, and the model was told so in its own transcript.

**Three durations, three diagnoses (`TokenUsage`).** Ollama-native reports `load_duration`, `prompt_eval_duration`
and `eval_duration`; we also stamp our own `genMs` wall clock on every route. `prompt_eval_duration` (→
`promptEvalMs`) was being dropped, which made `genMs - evalMs` — rendered as "+Nms network" — charge the BOX
for reading the prompt, which is the model's own work and scales with a system prompt re-sent every turn. The
tooltip now subtracts it and shows both. The OpenAI route reports none of the three, so `genBasis` says the
rate includes the network; that whole matrix (openai/ollama x streamed/not) is pinned in
`tests/e2e/gen-phases.spec.mjs`, and the fake backend serves BOTH wire shapes — it grew an
`/ollama/api/chat` NDJSON route because only the OpenAI one had ever been exercised end to end.

## What the model saw, and which artifact to reach for

**RULE — the log/export ALWAYS carries what the MODEL actually saw.** The exports (Markdown +
PDF) and the DevTools/debug log exist for DEBUGGABILITY: there must ALWAYS be a view of the raw
model-facing INPUT *and* OUTPUT of every step — the exact args the model sent and the exact tool
result it received — even if collapsed behind a `<details>`. The default human-facing view may be
pretty and omit spam (a rendered table instead of raw HTML; a clean result instead of the
plumbing/token lines the model was fed), but the raw view must NEVER be *unavailable*. The
precedent is the tool call's raw-JSON-args disclosure that sits beside its rendered In (a static
export shows both since it can't toggle). **So whenever a rendered/pretty view DIFFERS from what
the model actually saw, add the raw view too** — in the sidebar (a rendered⇄raw toggle or a
disclosure) AND both exports. E.g. when a tool result carries an appended `@tool:<id>` token line,
that model-facing result — token line included — must be recoverable in the log, not silently
dropped for the clean render.

**A person's message follows the same rule.** A right-click "ask about this" folds the element's content into the
text the model gets (`framePrompt`, `src/agent/prompts.ts`). That text stays in `task` / `says[].text` /
`ExportMessage.text`, as it always was; beside it, `taskDisplay` / `display` (`PromptDisplay`,
`src/contract/contract-run.ts`) keep what was typed and the element, present only when the two differ. The
transcript and the HUD draw the typed words with the element as a chip, behind a rendered⇄raw switch; `run.json`
carries both; `run.md` shows the typed words, an `Element` line, and the model's text in a `raw (as the model got
it)` disclosure. A session recorded before the field existed has only the framed text, and is drawn as it always
was. Every surface that frames goes through `framePrompt`, so the three places a message is framed (the worker's run
recipe, its follow-up, and a page-built handle's follow-up in `injected.ts`) cannot drift apart. A run a PAGE built
cannot attach a display to its task: the worker drops it from `START_RUN` unless it built the run. Plain chat
sessions are not covered: an element sent into one is still drawn as the framed text.

**WHICH ARTIFACT TO REACH FOR.** A run can be got out four ways and they are not interchangeable. Picking
the wrong one costs a whole read-through, so:

| You want to | Reach for | Because |
| --- | --- | --- |
| READ a run — what the model did, in order, with the images | **`run.md`** (+ `images/`) | It is the canonical human narrative. Screenshots are real PNG sidecars, so a coding assistant can open them; base64 in a text file is unreadable to everyone. |
| Read it in a browser, folded | **`run.md.html`** | The same markdown rendered, every `h2` collapsible, and a failed run's status links AT the step that broke. Relative asset paths, so it works off the disk and under a server. |
| DIFF two runs | **`run.json`** | A markdown diff is mostly layout. Strip `VOLATILE_FIELDS` and run `canonicalizeText()` first, or every pointer id and timestamp shows as a change. |
| Parse a run from Python/Go, or build a tool on it | **`run.json`** + `docs/spec/export.schema.json` | The schema is normative and checked in; generate models from it. Fields tagged `@unstable` will grow. |
| Hand a run to a person who is not you | **the PDF** | Self-contained, light-themed, images inlined, prints with sane page breaks. Nothing to unzip and no sidecars to lose. |
| Collect data for tuning the server's VRAM predictor | **`ml.__loads()`** | One record per load: the prediction, the load's own figures and the measured trace (peak, settled, every sample). Collected only with the panel's "load predictions" toggle on. |
| Debug the resource panel / the event lane | **`ml.__events()`** | Not an export at all: the raw INPUTS the timeline is derived from (the debug stream, the server's frames, ps/info). Use it when the drawn events look wrong, because the drawing is what is in question. |

The one that surprises people: **`run.json` carries `session.events`**, the whole timeline the resource panel
draws — spans, phases, model loads, sub-call lineage. That is the "event spam", and it is the point: it is
derived by the same `eventsFrom` the panel uses, so a consumer never redoes arithmetic that is wrong in the
same three places every time (spans run BACKWARDS from a finish stamp; a tool step is ONE event with
`phases`, not three; a model load is its own event). If you are asking "where did the time go", that is the
file. If you are asking "what did it say", it is `run.md`.
