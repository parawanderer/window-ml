# CLAUDE.md — window.ml

Chrome extension (Manifest V3) that exposes a scripting API, `window.ml`, on
web pages and bridges it to local LLMs via OpenWebUI / Ollama. It's a
**console-first primitive**, not a chat app: the deliverable is a `window.ml`
object you call from any page's devtools console or from userscripts.

See `docs/API.md` for the user-facing API and `docs/` for setup, cloud models,
and OCR. This file is the map for *extending* the code.

## Layout

The extension's own sources live in **`src/`**; everything else stays at the root (`tests/`, `scripts/`, `tools/`,
`docs/`, `manifest.json`, `build.mjs`). Inside `src/`, a file sits in the folder of what it is FOR and keeps its
prefixed name, so this file names files by their bare name (`sw-llm.ts`) and `node scripts/index.mjs '<name>' --kind
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

A new file goes in the folder of what it is for. Move files with `node scripts/move-files.mjs`, never `git mv`.

## Architecture (4 files + popup)

Requests flow: **page → content script → background worker → OpenWebUI**, and
back. This exists to bypass CORS — the background worker has host permissions
the page doesn't.

| File | World | Role |
| --- | --- | --- |
| `injected.js` | page main world | Defines `window.ml`. Serializes `<img>`/blob/http images to data URLs. Fires `ml:ready` + sets `window.ml.ready`. |
| `content.js` | isolated content-script world | Dumb relay: `window.postMessage` ⇄ `chrome.runtime.sendMessage`, via `HANDLE_MAP`. |
| `background.js` | service worker | Owns config, builds per-format request bodies, extracts replies, talks to the server. All privileged fetches happen here. |
| `popup.html` / `popup.js` | extension popup | Settings UI (`chrome.storage.sync`), model picker, Save & Test, VRAM readout, Free VRAM. |

`content.js` injects `injected.js` as a real `<script>` tag so `window.ml`
lives in the page's **main world** (reachable by page scripts/userscripts), not
the isolated content-script world.


**The CONTRACT is one contract in eleven files.** `contract.ts` holds `MlApi`, `JsonSchema`, and a BARREL
(`export * from "./contract-<theme>"`). Keep importing from `./contract`: about a hundred references are the inline
type query `import("./contract").X`, which `move-symbols` rebases only inside the code it moves, and the doc/schema
generators start from it by path. List the modules live with `node scripts/index.mjs '^contract-' --kind file --word`.

**`background.ts` is the message ROUTER + the print/nav spine.** Every cohesive leaf layer is its own `sw-*.ts`
module, bundled back into `dist/background.js`. List them live with `node scripts/index.mjs '^sw-' --kind file
--word`. A privileged handler CONSULTS `sw-consent.ts` and MUTATES `sw-runs.ts`, which is why neither belongs in the
router. Both module tables, with what each owns: `docs/dev/architecture.md`.

**Give a new module a blank line after its header comment**, or anything that reads comments by adjacency takes it
for the first declaration's documentation (`tests/api-docs.test.mjs` fails on it).

## The message contract (how to add a primitive)

Every `window.ml` method that needs the server/privileges follows one pattern.
To add a new one, touch three files:

1. **injected.js** — call `makeBackgroundTaskPromise(REQUEST_TYPE, RESPONSE_TYPE, payload)`.
   It posts to the content script and resolves with the matching response.
2. **page-relay.ts** — add a `HANDLE_MAP` entry mapping `REQUEST_TYPE` →
   `{ type: BACKGROUND_MSG, responseType: RESPONSE_TYPE }`. The content script relays what is listed there, and the
   background's ORIGIN GATE applies to every type listed there: a new primitive is refused from an unapproved site
   with no extra work, and `tests/redteam.test.js` enumerates it without being edited.
3. **background.js** — add an `if (message.type === BACKGROUND_MSG)` branch in
   `route()`; do the work; `sendResponse({ data })` or `sendResponse({ error })`; `return true` to keep the channel
   open.

Existing message types: `FETCH_LLM`, `LIST_MODELS`, `GET_MODEL`, `GET_CONFIG`,
`SET_MODEL`, `MODEL_CAPS`, `LIST_SERVER_TOOLS`, `OLLAMA_PS`, `OLLAMA_UNLOAD`, `FETCH_IMAGE_B64`,
`CAPTURE_TAB`, `SAVE_SESSION`, `GET_SESSION`, `PYTHON_EXEC`, `FETCH_SHEET`. Plus `ABORT_TASK` and the streaming
`LLM_STREAM_*` port, both outside HANDLE_MAP. `GET_CONFIG` returns the NON-SECRET subset only: the URL and API key
never reach the page. `MODEL_CAPS` returns `null` when it cannot tell: "unknown", never "no".

How resume, `ml.config()`, the `vision` option, capabilities, streaming (`onToken`, the one path that rides a Port),
tools/`toolIds` and the `SERVER_TOOL_MODES` probe, and cancellation (`ABORT_REQUEST` → `ABORT_TASK`) work:
`docs/dev/architecture.md`. The agent loop lives CLIENT-SIDE (`ml.step`); the extension ships no
loop/whitelist/overseer, so `window.ml` stays a primitive.

## Config

`chrome.storage.sync`, schema in `DEFAULT_CONFIG`:
`chatUrl`, `apiKey`, `model`, `apiFormat` (`"openai"` | `"ollama"`), `ocrModel`.

**`DEFAULT_CONFIG` is duplicated in `background.js` and `popup.js` and must stay
in sync** (popup.js has a comment saying so). `popup.js` `FIELDS` must list
every editable key.

**RULE — a new settings flag goes in the DevTools Settings panel, ALWAYS.** That panel is the SUPERSET; the popup is
a curated subset. Adding a flag to the popup is optional, and never without DevTools Settings too.

## API formats

`API_FORMATS` in `background.js` maps each backend to `{ buildMessage,
extractContent, extractToolCalls, expectedShape, applyFormat, streamChunk }`. `openai` uses
`choices[0].message.*` + `response_format`; `ollama` uses `message.*` +
`format`. Messages travel in a neutral `{ role, content, images?, tool_calls?,
tool_call_id? }` shape; each format converts to its wire form.

## The read-only `exec` dialect

`autoApproveReadonly` (on by default) runs a read-only DOM survey with no prompt, through a mediated
mini-interpreter (`readonly-exec.ts`) that is itself the whitelist and never compiles a string. Gaps degrade to
"asks the human", never to "runs unsafely". `docs/dev/readonly-exec.md` (keep it current).

**RULE — extending the dialect requires adversarial tests, without being asked.** A new construct, method or facade
member gets tests that try to abuse it (reach an effectful method, `window`/`constructor`/a realm, mutate, spend
tokens, loop unbounded) and assert `NotInDialect`/`Denied` or the inert `METHOD_REF`. And re-check the WHOLE
contract, not just the new surface: HALTING tests (in a worker with a timeout), FAILURE tests (falling out of
dialect leaves nothing behind), and an update to the doc. Why, with the `for…of` that broke: the doc's last section.

**RULE — a new agent tool, `ml.*` member or page-started message type gets a RED-TEAM PASS, without being asked.**
Before the PR, run a separate agent whose only job is to attack it from a hostile page (shares the main world, posts
any window message, knows every run id), writing tests that fail first in `tests/redteam.test.js` or
`tests/e2e/site-access.spec.mjs`; the change lands with them passing. What to attack: `docs/dev/site-access.md`,
"Adding a tool, a member or a message"; how: the `redteam` skill.

## Where the implementation notes live — read the one you are about to change

This file holds the rules for working in the repo and the traps. How each subsystem works, and why it is built
that way, lives in `docs/dev/`. Read the matching file BEFORE changing that code: most of what is in them was
learned by shipping the wrong version first.

| Changing… | Read first |
| --- | --- |
| the contract/`sw-*` modules, resume, streaming, tools/`toolIds`, cancellation, rate-limit backoff, `modelFilter` | `docs/dev/architecture.md` |
| anything about HOW to work here: the self-tools, test layout and genres, clones, builds, CI | `docs/dev/working-in-the-repo.md` |
| agent tools, locate/vision, `verify`, cross-page runs, approvals over IPC, how a run renders in the sidebar | `docs/dev/agent-tools.md` (+ `docs/LOCATE-VISION.md` for locate) |
| the read-only `exec` dialect: the pointer macro, the parser, the mediated evaluator, halting | `docs/dev/readonly-exec.md` |
| `python_exec`, the sandbox modes, the Python bench and its editor | `docs/dev/python-sandbox.md` |
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
| notifications: what reaches someone with the app closed, on which surface, and what a real push would still add | `docs/spec/NOTIFICATIONS.md` |
| the patched Ollama/OpenWebUI features and how the client reads them | `docs/FORKED-BACKENDS.md` |
| the e2e harness, observe, the bench, live probes, demos | `docs/dev/e2e-harness.md` (+ each tool's skill in `.claude/skills/`) |

**The traps, one line each.** Each doc's `Traps` section has the full text and the reason.

- **Resource panel.** Memory is raw binary BYTES (convert once, `formatBytes`); absent is not zero and not idle;
  event-stream names are fully qualified and `/api/ps` short (`normModel`); screen↔time only through
  `axisFrac`/`axisTime`. Frames are typed from the pinned `events.proto`: never hand-add a field. → resource-panel.md
- **Event lane.** Spans run BACKWARDS from a finish stamp; a tool step is ONE event with phases; a load is its own
  event. → resource-panel.md
- **Pointers.** `PIPE_CMDS` is the single source for every description of the dialect. The three reference
  forms (`@tool:"label"`, 7-hex id, bare tool name) are told apart by SHAPE, never tried in order.
- **Python.** Each call is stateless; `readonly` mode hardens the sandbox and may auto-approve, `full` always asks.
  The wheels (`pyodide-wheels/`) are gitignored and a missing set fails only at run time.
- **Tables.** One representation (`TableLike`) and one set of parsers (`table-data.ts`); the delimiter is
  DISCOVERED, never assumed a comma; `shape` is the SOURCE's row count, so pass `rowCount` when you cap; the `Table`
  facade is read-only. → wire-and-fetch.md
- **Wire formats.** Protobuf is chosen from the RESPONSE's content type, never sniffed; no `TextDecoder` near
  binary (`binaryKind` first); a strict backend refusing an optional key is retried once without it. → wire-and-fetch.md
- **One design language.** The phone app and the chat page's CALM view are one product: a palette or icon change to
  the page is a change to `mobile/` in the same breath (`mobile/AGENTS.md`). → chat-page.md
- **Notifications.** Only a certificate's DURABLE fields may reach a scheduled reminder, nothing about a session
  goes on a lock screen, and `expo-notifications` stays out of `app.json`'s plugins. → chat-page.md
- **Sidebar.** One app, two surfaces: a new app→parent message is also handled in `panel.ts`; shared session views
  call `services()`, never `chrome.*`; a session key is `runtime:hash`, split on the LAST `:`. → sidebar.md
- **A run's events never reach the page's window**, and the sidebar app talks to its host only through
  `parent-channel.ts`: an e2e watches a background run with `watchRunEvents` and opens the sidebar by clicking its
  tab, never by posting into its iframe. → sidebar.md
- **Transcript.** A long session is WINDOWED; a jump to a step goes through `reveal`; the window is a plain Map
  bumped through `rev`, NEVER a signal read during render. → sidebar.md
- **A delegated tool has a THIRD outcome:** a send to a sleeping tab neither answers nor rejects. Every send goes
  through `delegateSend` (sw-run-host.ts); a tab can come back under a new id (`chrome.tabs.onReplaced`). → agent-tools.md
- **The execution log** (`run-log.ts`) is where the worker writes what it did under a run, since a service-worker
  `console.log` is never seen: `recordRunLog`/`noteRunMechanic`. `subsystem`/`kind` must be lowercase slugs or the
  record is SILENTLY dropped. It is not the housekeeping log. → run-log.md
- **State in worker memory dies with the worker** (an MV3 eviction, ~30 s idle): open gates, in-memory grants and every
  `@tool:` value (`tokensByRun`) go silently. Declaring it is the RULE under Conventions. → state.md
- **Hub client.** A hub is trusted with nothing: act on the signature inside the seal, never `Envelope.sender`.
  `seal.ts` checks in a deliberate order, nonce last. → hub-client.md
- **WHO THE ROOT IS:** a phone in a pocket, never a runtime (`extension-pairing.ts` refuses `createAccount`).
  `scripts/hub-root.mjs` is a test tool, NOT the design. → hub-client.md
- **Chat page.** `src/chat/` never reaches `chrome`; events reach `sessionMap` only through `SessionFeed`/`onDebug`;
  no optimistic updates; the session index is fed where the DevTools panel is fed, never at a second point. → chat-page.md
- **A run never starts on a page WE own** (`AGENT_START_PAGE`): the extension's own page is privileged and puts
  the API key within `exec`'s reach. Whether a new tab can be opened is the RUNTIME's answer
  (`capabilities.blankStart`), and absent is not blocked. → agent-tools.md
- **Exports.** Diff two runs with `run.json` after stripping `VOLATILE_FIELDS` and running `canonicalizeText()`.

## Showing a run

**RULE — the log/export ALWAYS carries what the MODEL actually saw.** Wherever a pretty view differs from the exact
args the model sent or the exact result it received (a `@tool:<id>` token line included), add the raw view too, in
the sidebar AND both exports. Which artifact to reach for (`run.md`, `run.md.html`, `run.json`, the PDF,
`ml.__loads()`, `ml.__events()`): `docs/dev/export.md`.

**RULE — use the PANEL'S tooltip, not the browser's `title`.** `cursorTipOn(text)` (ui-kit.tsx) for anything
explanatory: a STRING is rendered as escaped inline markdown, a node as authored JSX. The exception is an accessible
NAME on an icon-only control: `aria-label` (+ the tip). Reasons and the touch behaviour: `docs/dev/sidebar.md`.

## Conventions

Each rule below has its reasoning, its measurement and the incident behind it in
`docs/dev/working-in-the-repo.md`.

**RULE — when you change a rule, test the UPGRADE, not just the new behaviour.** Old state (accounts, certificates,
saved sessions, stored config) meets the new code on someone's machine. The cheap form is a FIXTURE of what the old
code wrote, read by the new code, asserting what a person sees.

**RULE — when one rule VALIDATES another's output, enumerate the inputs; do not sample them.** Branch on the
quantity the decision is about, never a proxy for it, and give the DEFAULT its own assertion. Anything that routes on
box shape runs against every shape in `tests/fixtures/boxes.mjs`.

**RULE — before you build ANYTHING reusable, search for it by concept: `node scripts/index.mjs '<regex>'`.** It
indexes every module, module-scope declaration and documented CSS class by its docstring's first sentence, so an
undocumented thing is INVISIBLE and gets rebuilt. A new export or CSS family needs a first sentence saying what it
is FOR (`--new` ratchet), a new file opens with `// <name>.ts — <what it is for>.` (`--headerless` gate).
`.claude/skills/code-index/SKILL.md`.

**RULE — state goes through the STATE REGISTRY, from the first commit of the component that adds it.** Anything kept
across calls (a module-level Map/Set/signal/`let`, a storage key, an IndexedDB store, a grant) that a RUN depends on is
declared beside the store with `defineState` (`src/state-registry.ts`): scope, realm (`worker`/`page`/`offscreen`),
audience (`model`, `human`, or `never` for a secret) and what loses it, with a `read` returning plain data for one run.
State that is not a run's is marked `// state: cache|ui|plumbing|fixed|test`. The Run state panel and `ml.current` read
the registry, so an undeclared store is invisible to both; `scripts/check-state.mjs` ratchets it (pre-commit, CI). Check
`docs/dev/state.md` first so it is not a fourth copy of something. This rule stays in AGENTS.md: it is for everyone
adding code, not only someone reading the state docs.

**RULE — a test goes under a SECTION (`// --- what this group is about ---`), and `node scripts/test-index.mjs
'<regex>'` is how you find one.** Ratcheted on new tests; a new test file opens with a header comment.
`.claude/skills/test-index/SKILL.md`.

**Before choosing WHICH suite to run: `node scripts/test-cover.mjs <file>` (or `--changed`).** It names the tests
that can notice the change and prints the command. `.claude/skills/test-cover/SKILL.md`.

**RULE — a doc points only at files that exist.** `node scripts/check-doc-links.mjs` (pre-commit, every commit, and
CI) fails on any broken Markdown link, and on a backticked path (`` `src/<name>.ts` ``) a change ADDS that names nothing;
old dead paths are listed, not failed. An EXAMPLE path uses a `<placeholder>`, which is never checked. Move files with `move-files`, which rewrites both.

**RULE — JSDoc that CONTRADICTS the code is a defect; JSDoc that is INCOMPLETE is not.** The contract's JSDoc is
what the MODEL reads. `node scripts/check-jsdoc.mjs`, ratcheted. A stranded block is folded back, not deleted.

**Size.** A file past ~800 lines gets a REMINDER (`node scripts/check-file-size.mjs`, never fails). To decide WHERE
to refactor use `--cost` (lines x decayed commits), not `--all`. AGENTS.md itself is held under 35k characters
(`node scripts/check-agents-size.mjs`, same reminder). A huge TEST file costs more than its tests: split one into
files. `.claude/skills/file-size/SKILL.md`.

**Refactoring tools.** `node scripts/imports.mjs` (edges, which names cross, `--cycles`) before planning a split;
`node scripts/extract-function.mjs` to cut up a body; `node scripts/move-files.mjs --to <dir> <files>` to
relocate whole files with every path to them rewritten; **RULE — move code between files with `node
scripts/move-symbols.mjs`, never by copy and paste** (`--dry-run --diff` first). Each has a skill.

**Vitals.** `node scripts/vitals.mjs` about once a month, commit the result; keep `feat:`/`fix:` subject prefixes,
which it classifies. `.claude/skills/vitals/SKILL.md`.

**RULE — AGENTS.md holds working rules and traps; implementation notes go to `docs/dev/`.** Before adding a
paragraph here, ask whether someone NOT touching that code needs it. A trap is ONE line plus a pointer; a new
subsystem gets a doc and a row in the table above.

**RULE — self-tools get a skill + an AGENTS.md mention, and you keep both current, WITHOUT asking.** A harness,
driver or script you will reuse gets `.claude/skills/<name>/SKILL.md` and a one-line mention here (detail in
`docs/dev/e2e-harness.md` or `docs/dev/working-in-the-repo.md`).

**RULE — never pad model-facing text for alignment.** A model pays for every space. Single space or a delimiter;
assert no run of two spaces (`tests/token-pipe.test.mjs`). Human-facing surfaces align freely.

- **Plain JS in docs/examples** — `document.querySelector`, never jQuery-style `$`/`$$`.
- **Document functions with JSDoc** (`/** … */`), not a plain `//` block; inline `//` is for logic inside a body.
- **A FAILED build leaves `dist/` alone** (it builds into `dist.stage/`), so a silenced failed build looks like
  a working one: never discard its stderr.
- **A STALE bundle is CHECKED** (`scripts/check-dist-fresh.mjs`, the Playwright `globalSetup`); `npm run build:all`
  builds every bundle. `E2E_DIST=<dir>` skips it, `E2E_STALE_OK=1` overrides it.
- **Iterating? Run a GENRE: `npm run test:core`** (`node scripts/test.mjs core|panel|ext|chat|python|live`,
  `--list`, `--timings`, `--files a b`). Four files on one prefix in `core` fail `--check-genres`. Run the full
  `npm test` before you commit. `.claude/skills/test-genres/SKILL.md`.
- **Tests: `npm test`** (Node ≥ 20, `node:test`) loads the real files into `node:vm` with mocked `chrome`; DOM tools
  use `loadDomWorld(html)`. A new primitive gets a test in `tests/background.test.js` and `tests/relay.test.js`.
  Real-CPython tests self-skip without `dist/pyodide/` (`npm run fetch-pyodide`).
- **Several sessions at once? Each gets its own CLONE** as a sibling directory, with `.env` and `pyodide-wheels`
  symlinked, `git config core.hooksPath .githooks` (it does not clone, and its absence is silent), and `npm ci`.
  Never `git add -A` in a shared tree. The commands: `docs/dev/working-in-the-repo.md`.
- **Four absences are silent:** `node_modules`, `pyodide-wheels/` (fails at run time as `No module named
  'numpy'`), `.env` (`USE_ENV=1` dies on ENOENT), and the `wmlhub` binary (thirty hub tests SKIP; `npm run
  fetch-hub`).
- **Coverage: `npm run coverage`**, and `node scripts/coverage-lines.mjs <file>` for NEVER RUN vs BRANCH NOT TAKEN.
  `.claude/skills/coverage/SKILL.md`.
- **End-to-end: `npm run test:e2e`** (Playwright, built extension in real Chromium) only for what jsdom/`node:vm`
  cannot represent; factor pure logic out into a fast `*.test.mjs` instead.

## End-to-end & real-model testing

`tests/e2e/` loads the BUILT extension in a real Chromium, headless by default (`E2E_HEADFUL=1` to watch). The
backend is `fake-llm.mjs`, a scriptable OpenAI-shaped server, so the real pipeline runs deterministically; that is
the CI gate. A real backend: `E2E_BACKEND`/`E2E_MODEL`/`E2E_KEY`, or `USE_ENV=1`. The harness, the self-tools and
every demo: `docs/dev/e2e-harness.md`.

- **RULE — a wait loop breaks on something visible while a step is COLLAPSED**, or it runs to its cap and passes
  anyway. Wait for the RUN to finish (`fake.calls()` reached the script's length, no `.astep.tool.pending`).
- **A spec sharing state across its tests** pins itself with `test.describe.configure({ mode: "default" })`; the
  suite is `fullyParallel`.
- **`@real-ok`** marks the only tests the nightly real-model job runs; tag one only if it guards its fake usage.
- **RULE — a demo says what it is doing, on screen: `narrate(page, "…")`**, at every beat, and `narrateDone(page)`
  immediately before holding the browser open.
- **RULE — a demo about what happens INSIDE a run calls `openRunInSidebar(page)`**: the panel opens on the
  sessions list, not the run.
- **The self-tools**, each with a skill in `.claude/skills/`: `observe.mjs` (one agent run → `run.md`/`run.json`),
  `converse.mjs` (a run you talk to turn by turn through files: answer, steer, rule on gates),
  `run-once.mjs`, `bench/`, the live probes (`server-tool-live`, `md-ladder-live`, `proto-stream-live`,
  `capture-frames`), `chat-shots.mjs` + `window.__chatFake` (chat-web), `scripts/probe.mjs` (one look at a page),
  `scripts/android.mjs`/`scripts/ios.mjs` (phone), `scripts/hub-root.mjs` + `dev-hub-pair.html` (hub-pairing),
  `scripts/check-disk.mjs` (disk-space), and the narrated `*-demo.mjs` files.

## Branches, PRs and CI

Work goes on a **branch and through a PR**, not straight onto main: several sessions work this repo at once, and the
PR is what runs CI (e2e, three Node versions, real CPython), which a green local `npm test` is not.

- **RULE — label every PR by TOPIC when you open it** (`gh pr create --label @exec,@api`), every one that applies.
  Topic labels start with `@`, which keeps them apart from GitHub's defaults: `@core` `@api` `@agent` `@exec`
  `@python` `@ui` `@chat-page` `@mobile` `@hub` `@hub-compat` `@model-backend-compat` `@resource-panel` `@security`
  `@docs` `@agent-skills` `@ci`. What each means is its description (`gh label list`). A reviewer must not miss the
  two `-compat` ones: the change needs a matching one in window-ml-hub, or in the forked Ollama/OpenWebUI. A missing
  topic gets a new `@` label with a description, not a stretched old one.
- **A PR that conflicts with its base has NO checks at all.** If `gh run list` shows nothing for a pushed commit,
  suspect this first.
- **A CANCELLED check prints as `fail`.** Resolve the JOB conclusions before blaming a change; poll a run by ID.
- **The `ci` skill is the playbook** (open, watch in the background, read only failing logs, the known-bad list);
  **the `background-work` skill** is how to run anything slow without blocking on it.

Why each of these, and the concurrency-group trap on main: `docs/dev/working-in-the-repo.md`.

## Forked backends (patched servers)

Most of this runs against stock Ollama + stock OpenWebUI; several capabilities need `parawanderer/ollama` (branch
`slop`) or `parawanderer/open-webui` (branch `ml/tool-execute-api`). Every one is optional: absent means "not
reported". **Read `docs/FORKED-BACKENDS.md` before assuming a resource-panel field is broken.** Request hints
(`hint`) go through `wireHint` (contract-run.ts); **an absent `use` means unknown, never guess one.**

## Security invariants (don't regress these)

- **A page uses `window.ml` only once its ORIGIN is approved**: the router refuses every page-started type
  (`page-relay.ts`) from an unapproved origin, reading `sender`, never anything the page says; a run the USER starts is
  built by the worker and works on any page. → site-access.md

- **Config overrides (URL/key) are accepted only from the popup.** Page-relayed
  messages have `sender.tab` set; `background.js` strips overrides when it's set,
  so a hostile page can't repoint the saved API key at another host.
- Pages can change only the **model**, and `setModel` validates it against the
  server list.
- **`modelFilter`** (regex whitelist) is enforced on the RESOLVED model in `prepareRequest` and `setModel`, filters
  `LIST_MODELS`, is NOT in the public config, and an invalid regex fails OPEN. `modelFilterAllows` is the single
  source. → architecture.md
- The background's cross-origin fetches rely on `<all_urls>`, which "On click" site access withholds for
  third-party hosts: a known limitation, not a bug.
- **The page you are ON is free in every fetch mode; a local file is never read** (`isCurrentPage`, dom.ts).
  `ml.fetch` holds the rule; the background refuses every non-http(s) URL. → wire-and-fetch.md
- **A privileged/credentialed background fetch MUST validate its target host —
  the client-side approval gate does NOT protect it.** The agent approval lives
  in `injected.ts`, but raw messages (`FETCH_SHEET`, …) are reachable by any page
  through the content-script relay, so a hostile page can call the handler
  directly. `FETCH_SHEET` fetches `credentials:"include"` (the user's cookies),
  so it's hard-locked to the `docs.google.com/.../export?` shape (`SHEET_URL_OK`)
  — without it, it's a cookie-authenticated "read any URL" exfil primitive.
  (`FETCH_IMAGE_B64` is *uncredentialed* — default `same-origin` — so it can read
  cross-origin public bytes but not the user's authenticated data.)

## Gotchas (hard-won)

- OpenWebUI has **no root `/v1/chat/completions`** (tested 0.9.5, 0.10.2) —
  external clients use `/api/chat/completions`. Unknown routes return the SPA
  HTML, so a non-JSON body means "wrong route."
- OpenWebUI **0.9.5** 400s external chat calls (`NoneType ... startswith`,
  issue #24550); fixed in 0.10.x. Workaround was the `/ollama/api/chat` passthrough.
- `think` is Ollama's param; sent only when a boolean. Cloud (non-Ollama) models
  may reject it — pass `{ think: null }` to omit.
- Vision fail-fast reads Ollama `/api/show`; for non-Ollama models it returns
  "unknown" and the request is sent anyway (degrades gracefully).
- Cross-origin `<img>` without CORS **taints the canvas**, so pixel readback
  fails even for already-rendered images — hence image fetching goes through the
  background worker, not a canvas.
- `think` placement: Like `num_ctx`, OpenWebUI's OpenAI route reads `think` from the request-body **`params`**
  object, not top-level — a top-level `think:false` is silently dropped (reasoning keeps coming). `applyThink`
  places it per format: `params.think` (openai) vs a top-level `think` (ollama native).
