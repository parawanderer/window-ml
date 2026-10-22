# CLAUDE.md — window.ml

Chrome extension (Manifest V3) that exposes a scripting API, `window.ml`, on
web pages and bridges it to local LLMs via OpenWebUI / Ollama. It's a
**console-first primitive**, not a chat app: the deliverable is a `window.ml`
object you call from any page's devtools console or from userscripts.

See `docs/API.md` for the user-facing API and `docs/` for setup, cloud models,
and OCR. This file is the map for *extending* the code: the working rules and the traps, each pointing at the doc that
explains it.

## Layout

The extension's own sources live in **`src/`**; everything else stays at the root (`tests/`, `scripts/`, `tools/`,
`docs/`, `manifest.json`, `build.mjs`). Inside `src/`, a file sits in the folder of what it is FOR and keeps its
prefixed name, so this file names files by their bare name (`sw-llm.ts`); `node scripts/index.mjs '<name>' --kind
file` finds the path:

| Folder | Holds |
| --- | --- |
| `src/` top | build entries (`background`, `content`, `injected`, `popup`, `offscreen`, `chat-ext`, …), the `contract.ts` barrel, shared plumbing (`util`, `bridge`, `bus`, `ids`, `protostream`), pure rules (`site-access`, `page-relay`, `json-path`), generated `*.gen.ts` |
| `sw/` | everything only the service worker runs: every `sw-*`, plus its tab and nav helpers |
| `contract/` | the themed `contract-*` modules behind the barrel |
| `agent/`, `tools/` | the run loop and its gate; the agent's tools |
| `ml/` | the `window.ml` surface (`ml-*`) |
| `readonly-exec/`, `pointers/`, `table/`, `dom/` | the dialect's parts; `@tool:` pointers and values; the one table type; reading the DOM |
| `python/`, `resource/`, `session/`, `log/` | the Pyodide sandbox; the box's memory and events; the session store; run and housekeeping logs |
| `hub/` (+ `hub/runtime/`), `pairing/`, `archive/`, `chat/`, `native/`, `proto/` | as named; `hub/runtime/` is this browser AS a runtime |
| `sidebar/` (+ `resource/`, `transcript/`, `card/`, `code/`, `export/`, `settings/`) | the panel, by view |
| `gallery/` | the component gallery's page (`gallery.mjs`, the `gallery` skill) |
| `shell/` | what describes a call to `ml.sh`: program manifests (`manifests/<program>.json`) and `describeCall`; the process host itself is [window-ml-host](https://github.com/parawanderer/window-ml-host) |
| `lab/<topic>/` | LAB code: research that lives here but is not for window.ml (`lab/gradient/`). Each topic imports nothing outside its folder (`tests/lab.test.mjs`), has a `docs/spec/` file, and its PRs carry `@lab` |

A new file goes in the folder of what it is for. Move files with `node scripts/move-files.mjs`, never `git mv`.

## Architecture

Requests flow **page → content script → service worker → OpenWebUI/Ollama** and back, to get around CORS: only the
worker has host permissions. `injected.ts` defines `window.ml` in the page's MAIN world (a registered content script,
so page scripts and userscripts reach it, only on origins that may use it); `content.ts` is a dumb relay (`HANDLE_MAP`); `background.ts` is the message ROUTER
and the print/nav spine, owning config and every privileged fetch, with each cohesive leaf layer its own `sw-*.ts`;
`popup.ts` is the settings popup. Both module tables, with what each owns: `docs/dev/architecture.md`.

- **The CONTRACT is one contract in eleven files: keep importing from `./contract`** (the barrel over `contract-*`);
  about a hundred inline `import("./contract").X` queries and the doc/schema generators depend on the path.
- **A privileged handler CONSULTS `sw-consent.ts` and MUTATES `sw-runs.ts`**, which is why neither is in the router.
- **Give a new module a blank line after its header comment**, or it is read as the first declaration's
  documentation (`tests/api-docs.test.mjs` fails on it).

## The message contract (how to add a primitive)

A `window.ml` method that needs the server or privileges touches three files:

1. **injected.ts**: `makeBackgroundTaskPromise(REQUEST_TYPE, RESPONSE_TYPE, payload)`.
2. **page-relay.ts**: a `HANDLE_MAP` entry `REQUEST_TYPE` → `{ type: BACKGROUND_MSG, responseType: RESPONSE_TYPE }`.
   The background's ORIGIN GATE applies to every type listed there, so a new primitive is refused from an unapproved
   site with no extra work, and `tests/redteam.test.js` enumerates it without being edited.
3. **background.ts**: an `if (message.type === BACKGROUND_MSG)` branch in `route()` that answers
   `sendResponse({ data })` or `sendResponse({ error })` and returns `true`.

`GET_CONFIG` returns the NON-SECRET subset only; `MODEL_CAPS` returns `null` when it cannot tell ("unknown", never
"no"). The existing types, resume, streaming (the one path on a Port), tools/`toolIds` and cancellation:
`docs/dev/architecture.md`. The agent loop lives CLIENT-SIDE (`ml.step`), so `window.ml` stays a primitive.

## Config and API formats

`chrome.storage.sync`, schema `DEFAULT_CONFIG` (`contract-config.ts`, the one copy the worker and the popup import);
**`popup.ts` `FIELDS` must list every key the popup edits.** `API_FORMATS` (`sw-llm.ts`) converts the neutral message shape
to each backend's wire form (`openai`, `ollama`): `docs/dev/architecture.md`.

**RULE — a new settings flag goes in the DevTools Settings panel, ALWAYS.** That panel is the SUPERSET; the popup is
a curated subset. Adding a flag to the popup is optional, and never without DevTools Settings too.

## The read-only `exec` dialect

`autoApproveReadonly` (on by default) runs a read-only DOM survey with no prompt, through a mediated interpreter
(`readonly-exec.ts`) that is itself the whitelist and never compiles a string. Gaps degrade to "asks the human",
never to "runs unsafely". `docs/dev/readonly-exec.md` (keep it current).

**RULE — extending the dialect requires adversarial tests, without being asked.** Tests that try to abuse the new
construct and assert `NotInDialect`/`Denied` or the inert `METHOD_REF`, plus a re-check of the WHOLE contract
(halting, failure, the doc). The checklist and the `for…of` that broke: readonly-exec.md, "The rule for extending the
dialect".

**RULE — a new agent tool, `ml.*` member or page-started message type gets a RED-TEAM PASS, without being asked.** A
separate agent writes what a hostile page must NOT get from it as tests that fail first (`tests/redteam.test.js`,
`tests/e2e/site-access.spec.mjs`); the change lands with them passing. Every shape it probes, escape or one that
held, ends as a committed test or a one-line reason, never only in an untracked scratch driver. `docs/dev/site-access.md`, "Adding a tool, a
member or a message"; the `redteam` skill.

## Where the implementation notes live — read the one you are about to change

How each subsystem works, and why, lives in `docs/dev/`. Read the matching file BEFORE changing that code: most of
it was learned by shipping the wrong version first.

| Changing… | Read first |
| --- | --- |
| the contract/`sw-*` modules, resume, streaming, tools/`toolIds`, cancellation, rate-limit backoff, `modelFilter` | `docs/dev/architecture.md` |
| anything about HOW to work here: the self-tools, test layout and genres, clones, builds, CI | `docs/dev/working-in-the-repo.md` |
| agent tools, locate/vision, `verify`, cross-page runs, approvals over IPC, how a run renders in the sidebar | `docs/dev/agent-tools.md` (+ `docs/LOCATE-VISION.md` for locate) |
| the read-only `exec` dialect: the pointer macro, the parser, the mediated evaluator, halting | `docs/dev/readonly-exec.md` |
| policies: the policy store, what a remembered URL does, judging a call | `docs/dev/policies.md` (+ `docs/spec/POLICIES.md`, `docs/spec/EFFECTS.md`) |
| `python_exec`, the sandbox modes, the Python bench and its editor | `docs/dev/python-sandbox.md` |
| the Pyodide core built from the restricted-mode fork: the pin, the recipe, `fetch-pyodide`, the release | `docs/dev/pyodide-build.md` (+ the `pyodide-build` skill) |
| `ml.sh` from the extension's side: the native port to the process host, its Settings, the shell capabilities | `docs/dev/shell.md` (+ `docs/spec/SHELL.md`) |
| streamed tool output, the output cell, line maps, tracebacks, code-block buttons, retry diffs | `docs/dev/output-and-code.md` |
| `@tool:` pointers, `dereference`, the pipe dialect, the pointer macro | `docs/dev/pointers.md` (+ `docs/POINTER-IDENTIFIERS.md`) |
| the Markdown/PDF export, the JSON export and its schema, which run artifact to reach for | `docs/dev/export.md` |
| `ml.fetch` Markdown negotiation, protobuf streaming, tables, the live token count, sources/reasoning plumbing | `docs/dev/wire-and-fetch.md` |
| the housekeeping log (`ml.__housekeeping()`), or anything that evicts, sweeps or restarts on its own | `docs/dev/housekeeping.md` (+ `docs/spec/HOUSEKEEPING_LOG.md`) |
| the execution log: what the machinery did UNDER a run (a discarded tab, a refused CDP attach), and its panel | `docs/dev/run-log.md` (+ `docs/spec/run-log.schema.json`) |
| anything that keeps STATE across calls (a module-level Map/Set/signal, a storage key, an IndexedDB store, a grant): where it belongs, what loses it, which copies disagree | `docs/dev/state.md` (+ `docs/spec/STATE_INSPECTOR.md`) |
| the resource panel (VRAM/RAM) and the event lane | `docs/dev/resource-panel.md` (+ `docs/spec/RESOURCE_PANEL.md`) |
| the overlay vs DevTools surfaces, `debugMode`, shared UI components, tooltips, the transcript window | `docs/dev/sidebar.md` |
| the chat page (`src/chat/`): the client store, hosts, stream rules, the web build | `docs/dev/chat-page.md` (+ `docs/spec/CHAT_PAGE.md`, `docs/spec/SESSION_CONTRACT.md`) |
| the session archive (SQLite over OPFS, the offscreen worker, move-instead-of-delete) | `docs/dev/archive.md` |
| the hub client (`src/hub/`): HPKE over WebCrypto, certificates, sealed commands, encrypted streams | `docs/dev/hub-client.md` |
| which sites may use `window.ml`: the origin gate, the approved/denied lists, their settings | `docs/dev/site-access.md` (+ `docs/spec/SITE_ACCESS.md`) |
| what a page can observe of window.ml acting in it (globals, stacks, event trust, CDP traces, request headers) | `docs/dev/detection-surface.md` |
| notifications: what reaches someone with the app closed, on which surface, and what a real push would still add | `docs/spec/NOTIFICATIONS.md` |
| the patched Ollama/OpenWebUI features and how the client reads them | `docs/FORKED-BACKENDS.md` |
| the e2e harness, observe, the bench, live probes, demos | `docs/dev/e2e-harness.md` (+ each tool's skill in `.claude/skills/`) |
| the system prompt, a tool's description, anything else the model reads | `docs/dev/prompt-review.md` (+ `docs/spec/PROMPT_BUDGET.md`) |
| an analysis worth keeping across several files (bench sweeps, model comparisons): a notebook | `docs/dev/notebooks.md` |

**The traps, one line each.** Every known trap, with its full text and reason, by doc: `grep -n -A3 '^## Traps'
docs/dev/*.md`.

- **Resource panel.** Memory is raw BYTES (`formatBytes`, once); absent is not zero and not idle; `/api/ps` names are
  short (`normModel`); screen↔time only via `axisFrac`/`axisTime`; frames come from the pinned `events.proto`. → resource-panel.md
- **Event lane.** Spans run BACKWARDS from a finish stamp; a tool step is ONE event with phases. → resource-panel.md
- **Pointers.** `PIPE_CMDS` is the single source for the dialect; the three reference forms are told apart by SHAPE. → pointers.md
- **Python.** A worker-hosted run keeps one namespace across its cells; every other call is stateless. `full` mode always asks; missing wheels (`pyodide-wheels/`) fail only at run time. → python-sandbox.md
- **Tables.** One `TableLike`, one set of parsers (`table-data.ts`); the delimiter is DISCOVERED; pass `rowCount` when you cap. → wire-and-fetch.md
- **Wire formats.** Protobuf is chosen from the RESPONSE's content type; no `TextDecoder` near binary (`binaryKind`). → wire-and-fetch.md
- **One design language.** A palette or icon change to the chat page's CALM view is a change to `mobile/` too. → chat-page.md
- **Notifications.** Only a certificate's DURABLE fields reach a reminder; nothing about a session on a lock screen. → chat-page.md
- **Sidebar.** A new app→parent message is also handled in `panel.ts`; session views call `services()`, never
  `chrome.*`; split a `runtime:hash` key on the LAST `:`; our shadow roots are CLOSED (tests use `inShell`). → sidebar.md
- **A run's events never reach the page's window**: e2e uses `watchRunEvents` and opens the sidebar by clicking its tab. → sidebar.md
- **Transcript.** A long session is WINDOWED: jump via `reveal`; the window is a Map bumped through `rev`, never a signal. → sidebar.md
- **A delegated tool has a THIRD outcome** (a sleeping tab neither answers nor rejects): send via `delegateSend`. → agent-tools.md
- **The execution log** (`recordRunLog`/`noteRunMechanic`) drops a record SILENTLY unless `subsystem`/`kind` are lowercase slugs. → run-log.md
- **State in worker memory dies with the worker** (MV3 eviction, ~30 s idle), `@tool:` values (`tokensByRun`) included. → state.md
- **Hub client.** A hub is trusted with nothing: act on the signature inside the seal, never `Envelope.sender`. → hub-client.md
- **WHO THE ROOT IS:** a phone in a pocket, never a runtime; `scripts/hub-root.mjs` is a test tool, NOT the design. → hub-client.md
- **Chat page.** `src/chat/` never reaches `chrome`; events reach `sessionMap` only through `SessionFeed`; no optimistic updates. → chat-page.md
- **A run never starts on a page WE own** (`AGENT_START_PAGE`); a new tab is the runtime's `capabilities.blankStart`. → agent-tools.md
- **Backend quirks:** OpenWebUI has no root `/v1/chat/completions` and drops a top-level `think` (`applyThink`). → architecture.md
- **Exports.** Diff two runs with `run.json` after stripping `VOLATILE_FIELDS` and running `canonicalizeText()`. → export.md

## Showing a run

**RULE — the log/export ALWAYS carries what the MODEL actually saw.** Wherever a pretty view differs from the exact
args or result (a `@tool:<id>` token line included), add the raw view too, in the sidebar AND both exports.
`docs/dev/export.md`.

**RULE — use the PANEL'S tooltip, not the browser's `title`.** `cursorTipOn(text)` (ui-kit.tsx); an icon-only
control's accessible name is `aria-label` (+ the tip). `docs/dev/sidebar.md`.

## Conventions

Each rule's reasoning, measurement and incident: `docs/dev/working-in-the-repo.md`.

**RULE — when you change a rule, test the UPGRADE, not just the new behaviour.** Old state meets the new code on
someone's machine: a FIXTURE of what the old code wrote, read by the new code, asserting what a person sees.

**RULE — when one rule VALIDATES another's output, enumerate the inputs; do not sample them.** Branch on the
quantity the decision is about, never a proxy, and give the DEFAULT its own assertion; box-shape routing runs
against every shape in `tests/fixtures/boxes.mjs`.

**RULE — before you build ANYTHING reusable, search for it by concept: `node scripts/index.mjs '<regex>'`.** An
undocumented thing is INVISIBLE to it: a new export or CSS family needs a first sentence saying what it is FOR, and a
new file opens with `// <name>.ts — <what it is for>.`. The `code-index` skill.

**What a component LOOKS like: `node scripts/gallery.mjs shot <id>`.** One that renders blank or broken gets a
committed `@gallery {json}` example and `@group`; one that draws nothing until triggered gets `@gallery-flow` or
`@gallery none <reason>`. The `gallery` skill.

**RULE — state goes through the STATE REGISTRY, from the first commit of the component that adds it.** State a RUN
depends on is declared beside its store with `defineState` (`src/state-registry.ts`); other state is marked
`// state: cache|ui|plumbing|fixed|test`; `scripts/check-state.mjs` ratchets it. Check `docs/dev/state.md` first so
it is not a fourth copy. This rule stays in AGENTS.md: it is for everyone adding code, not only someone reading the
state docs.

**RULE — a builtin agent tool is declared in the TOOL REGISTRY** (`defineBuiltinTool`, `src/tools/tool-registry.ts`);
an undeclared name is the SITE's own tool. `node scripts/check-tools.mjs`; the `tool-registry` skill.

**RULE — a test goes under a SECTION (`// --- what this group is about ---`), and `node scripts/test-index.mjs
'<regex>'` is how you find one.** Before choosing WHICH suite to run: `node scripts/test-cover.mjs <file>`.

**RULE — a doc points only at files that exist** (`node scripts/check-doc-links.mjs`, every commit and CI). An
EXAMPLE path uses a `<placeholder>`; move files with `move-files`, which rewrites both.

**RULE — JSDoc that CONTRADICTS the code is a defect; JSDoc that is INCOMPLETE is not.** The contract's JSDoc is
what the MODEL reads. `node scripts/check-jsdoc.mjs`; a stranded block is folded back, not deleted.

**Size.** A file past ~800 lines gets a REMINDER (`check-file-size.mjs`, `--cost` to decide where to refactor); a huge
TEST file gets split. AGENTS.md is held under 35k characters (`node scripts/check-agents-size.mjs`).

**Refactoring tools:** `imports.mjs`, `extract-function.mjs`, `move-files.mjs`. **RULE — move code between files with
`node scripts/move-symbols.mjs`, never by copy and paste** (`--dry-run --diff` first). Each has a skill.

**Vitals** (`node scripts/vitals.mjs`) about once a month, committed; keep `feat:`/`fix:` subject prefixes. **Ecosystem
totals** (`node scripts/ecosystem.mjs`) for any claim about how much is agent-written.

**RULE — AGENTS.md holds working rules and traps; implementation notes go to `docs/dev/`.** Before adding a
paragraph here, ask whether someone NOT touching that code needs it. A trap is ONE line plus a pointer; a new
subsystem gets a doc and a row in the table above.

**RULE — self-tools get a skill + an AGENTS.md mention, and you keep both current, WITHOUT asking.** A reusable
harness or script gets `.claude/skills/<name>/SKILL.md`, its detail in e2e-harness.md or working-in-the-repo.md.

**RULE — review the prompt now and then, without being asked:** after a stretch of agent-loop or tool work, and at
least monthly (`docs/dev/prompt-review.md`). Last review: **2026-10-21** (`propose_policy`'s details, measured on the
policy-fetch interview). A review commit carries `Prompt-Review: <date>`; update the date here with it.

**RULE — a complex analysis worth keeping goes in a notebook, not in a reply:** `notebooks/<topic>/`, run with
`node scripts/nb.mjs`. `docs/dev/notebooks.md`; the `notebooks` skill.

**RULE — never pad model-facing text for alignment.** A model pays for every space; assert no run of two spaces
(`tests/token-pipe.test.mjs`). Human-facing surfaces align freely.

- **Plain JS in docs/examples** (`document.querySelector`, never `$`/`$$`); **JSDoc** (`/** … */`) on functions.
- **A FAILED build leaves `dist/` alone** (it builds into `dist.stage/`): never discard its stderr. A STALE bundle is
  CHECKED (`scripts/check-dist-fresh.mjs`); `npm run build:all` builds every bundle.
- **Iterating? Run a GENRE: `npm run test:core`** (the `test-genres` skill); run the full `npm test` before you commit.
- **Tests: `npm test`** (`node:test`, real files in `node:vm` with mocked `chrome`). A new primitive gets a test in
  `tests/background.test.js` and `tests/relay.test.js`.
- **Several sessions at once? Each gets its own CLONE** as a sibling directory (`.env` and `pyodide-wheels`
  symlinked, `git config core.hooksPath .githooks`, `npm ci`). Never `git add -A` in a shared tree.
- **RULE — a clone or worktree you CREATED for a topic, you REMOVE once its PR has merged**, after checking it holds
  nothing unpushed. One you did not create is never removed without asking; `~/git/window-ml` and
  `~/git/window-ml-hub` never.
- **Four absences are silent:** `node_modules`, `pyodide-wheels/`, `.env`, and the `wmlhub` binary (`npm run fetch-hub`).
- **Coverage: `npm run coverage`** (the `coverage` skill). **End-to-end** only for what jsdom/`node:vm` cannot
  represent; factor pure logic out into a fast `*.test.mjs` instead.

## End-to-end & real-model testing

`npm run test:e2e` loads the BUILT extension in a real Chromium against `fake-llm.mjs`, a scriptable OpenAI-shaped
server (the CI gate); a real backend via `E2E_BACKEND`/`E2E_MODEL`/`E2E_KEY` or `USE_ENV=1`. The harness, the
self-tools and every demo: `docs/dev/e2e-harness.md`.

- **RULE — a wait loop breaks on something visible while a step is COLLAPSED**, or it runs to its cap and passes
  anyway: wait for the RUN to finish (`fake.calls()` reached the script's length, no `.astep.tool.pending`).
- **A spec sharing state across its tests** pins `test.describe.configure({ mode: "default" })`.
- **`@real-ok`** marks the only tests the nightly real-model job runs; only one that guards its fake usage.
- **RULE — a demo says what it is doing, on screen: `narrate(page, "…")`**, at every beat, and `narrateDone(page)` before holding.
- **RULE — a demo about what happens INSIDE a run calls `openRunInSidebar(page)`.**

## Branches, PRs and CI

Work goes on a **branch and through a PR**, not straight onto main: the PR is what runs CI (e2e, the unit suite, real
CPython), which a green local `npm test` is not. Why each of these: `docs/dev/working-in-the-repo.md`.

- **RULE — label every PR by TOPIC when you open it** (`gh pr create --label @exec,@api`), every one that applies:
  `@core` `@api` `@agent` `@exec` `@python` `@ui` `@chat-page` `@mobile` `@hub` `@hub-compat` `@model-backend-compat`
  `@resource-panel` `@security` `@docs` `@agent-skills` `@ci` `@lab`. What each means is its description (`gh label
  list`). A reviewer must not miss the two `-compat` ones: the change needs a matching one in window-ml-hub, or in
  the forked Ollama/OpenWebUI. A missing topic gets a new `@` label with a description, not a stretched old one.
- **A PR that changes what the phone app does gets `run:android-flows`** (a trigger, not a topic). The `phone` skill.
- **A PR that conflicts with its base has NO checks at all**; **a CANCELLED check prints as `fail`**.
- **RULE — every GitHub post an agent makes says WHICH SESSION made it** (comment, review, inline remark, PR body):
  end with `> *Drafted by <harness> · work: <slug> · session <id8> · <model>*` and `<!-- agent-post: harness=… work=…
  session=<full id> model=… -->`; the work slug is session-mail's name for your work. Not in commits.
- **Merge your own PR with `node scripts/merge-when-green.mjs <pr> --wait --merge --session <id>`** (the skill).
- **The `ci` skill is the playbook**; **the `background-work` skill** runs anything slow without blocking on it.

## Forked backends (patched servers)

Several capabilities need `parawanderer/ollama` (branch `slop`) or `parawanderer/open-webui` (branch
`ml/tool-execute-api`); each is optional and absent means "not reported". **Read `docs/FORKED-BACKENDS.md` before
assuming a resource-panel field is broken.** Hints go through `wireHint`; **an absent `use` means unknown, never guess.**

## Security invariants (don't regress these)

- **A page uses `window.ml` only once its ORIGIN is approved**: the router refuses every page-started type from an
  unapproved origin, reading `sender`, never anything the page says; a run the USER starts works on any page. → site-access.md
- **A page whose origin may not use `window.ml` gets NOTHING of ours** until the person starts a run there: no page
  script, no window message, no answer to what it posts; the content script speaks only on the worker's word
  (`page-gate.ts`), never on anything the page can post. → site-access.md, "Presence"
- **An error's text never carries the server URL, the API key or the model filter to a page or the model**: it goes
  through `sw-scrub.ts`; only extension pages and the run log's `key` keep the raw text. → site-access.md
- **An approved exec of a run the worker built runs in an isolated world** when it names a pointer or `ml.current`,
  or the page is not approved (`exec-routing.ts`). With no isolated world, `ml.current`, `ml.sh` and an unapproved
  page are REFUSED; a pointer script on an approved page falls back to the main world with a note. → site-access.md
- **Config overrides (URL/key) are accepted only from the popup**: page-relayed messages have `sender.tab` set and
  the background strips overrides then, so a hostile page can't repoint the saved API key at another host.
- **Pages can change only the model**, and `setModel` validates it against the server list.
- **`modelFilter`** (regex whitelist) is enforced on the RESOLVED model, filters `LIST_MODELS`, is NOT in the public
  config, and an invalid regex fails OPEN; `modelFilterAllows` is the single source. → architecture.md
- **The background's cross-origin fetches rely on `<all_urls>`**, which "On click" site access withholds for
  third-party hosts: a known limitation, not a bug.
- **The page you are ON is free in every fetch mode; a local file is never read** (`isCurrentPage`); the background
  refuses every non-http(s) URL. → wire-and-fetch.md
- **A privileged/credentialed background fetch MUST validate its target host; the client-side approval gate does NOT
  protect it.** `FETCH_SHEET` is hard-locked to the `docs.google.com/.../export?` shape (`SHEET_URL_OK`);
  `FETCH_IMAGE_B64` sends `credentials:"omit"` and reads only a public host's raster image. → site-access.md
