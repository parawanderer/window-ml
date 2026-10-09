# The e2e harness, probes and demos

Implementation notes for the self-tools in `tests/e2e/`: observe, run-once, the bench, the live probes and the narrated demos. Each also has a skill in `.claude/skills/`, moved out of AGENTS.md on 2026-09-12 so they are read when that code is being
changed rather than loaded into every session. AGENTS.md keeps the repository's working rules and the traps that
bite; this file keeps how the subsystem works and why it is built that way. Paths name files by their bare name,
as in AGENTS.md — they are all under `src/`.

- **`converse.mjs`** (`converse` skill) — observe's run, TALKED TO: `runOnce`'s `nextTurn` hook asks for each next
  turn as the run goes, and `decide` lets the caller rule on gates. The interface is a directory (`inbox/`, `outbox/`,
  `status`, `gate.json`/`decision`), so an agent session can interview a model about a feature, answer what it asks
  and steer it, one Bash call per message. Built for the `ml.current` usability runs (2026-10-08).
- **`panel.mjs`** (`panel` skill) — one interview file (`tests/e2e/panel/*.json`) put to several real models at once,
  each in its own converse session, after a one-tool-call PROBE per model so a broken connection is named rather than
  read as a model ignoring the task. Writes `summary.md`: calls per turn, how each ended, then the answers side by
  side. For judging an API, prompt or tool change by how models in general read it; the bench measures, a panel asks.
- **`observe.mjs`** — a **debug/observation wrapper, not a test** (see the `observe` skill for the
  full playbook): `node --import tsx tests/e2e/observe.mjs` drives ONE agent run in a real Chromium
  and writes ARTIFACTS to `tests/e2e/artifacts/<RUN_LABEL|timestamp>/` (gitignored): **`run.md`** =
  the extension's OWN canonical markdown (captures the `__mlDebug` stream under `debugMode:"overlay"`,
  rebuilds a `Session`, runs `serializeSession`), **`run.json`** = the same Session through the
  machine-readable export (diff TWO runs with this — a markdown diff is mostly layout), a screenshot
  per step (`look`/`locate` sidecars included), `events.json`, `transcript.txt`. This is how a model debugs the extension itself: run →
  read `run.md` + screenshots → diff run dirs before/after a fix, and sweep rule-adherence across
  models. Knobs (env vars):
  - `TASK` — the agent task; `START` — the start route (any served example page: `/spreadsheet`,
    `/find-waldo`, `/canvas-input`, … or the cross-page chain `/`, `/step2`, `/step3` — `GET /examples`).
  - **Real model:** `USE_ENV=1` reads `OPENWEBUI_URL/KEY/MODEL` from `.env`; `E2E_MODEL=<id>` overrides
    the model (e.g. `deepseek.deepseek-v4-pro`, `gemma4:31b`); no vars → the deterministic fake-LLM.
  - `TOOLTOKENS=1` enables tool tokens · `PYTHON=1` wires `python_exec` · `TOOLS=findByText,answer`
    limits to a domTools subset (smaller prompt/schemas = far fewer tokens/turn) · `WARM=0` skips the
    VRAM warm-up (a local model wants it warmed; the fake/API don't) · `FOLLOWUP="…"` runs a SECOND turn
    in the SAME session (createAgent + two run()s, same run hash) to reproduce multi-turn behaviour a
    single `ml.agent()` can't (a "…now show the work" follow-up; the cross-turn token-id collision).
  - **`SYNTHETIC=0`** — every observe and bench run sets `ml_synthetic_traffic`, so its requests carry
    `hint.synthetic: true` and a patched Ollama keeps them out of what it learns from (the timing is the
    harness's: instant approvals, scripted follow-ups, a killed browser). `SYNTHETIC=0` is for a run a person
    actually drives (`WATCH=1 APPROVE=hold`), which is real use. `runOnce({ synthetic })` underneath.
  - **`APPROVE=<policy>`** — how the built-in approval poller resolves a gate the run halts on (via the
    SW-only `__mlApprovals` channel; the run passes `approvalRouting:"both"`): `auto` (default, approve
    all), `deny`, `readonly` (approve exec + readonly python, deny the rest), `hold` (log but DON'T
    resolve — leave it for a manual click in WATCH). Every gate + decision is logged, so a run never
    hangs silently at an approval.
  - **Sidebar focus is the DEFAULT:** every run fires non-blocking and the harness opens the overlay
    sidebar at HALF the viewport width + clicks into the live session, so a watching human never has to
    click. **`WATCH=1`** additionally HOLDS the browser open at the end (close the window / Ctrl+C to
    exit) instead of tearing down — for inspecting a finished run; without it the browser closes when the
    run completes.

- **`run-once.mjs`** — the run-driving CORE both CLIs share: `runOnce(config)` drives ONE agent run in a
  real Chromium and RETURNS `{ events, session, runMd, result, … }` instead of only writing files.
  `observe.mjs` is a thin env-var CLI over it; the bench is a matrix over it. Every piece of run state is
  a local (not a module global) so `--jobs N` can call it concurrently. It also owns **seeded histories**
  (`seed: { task, script }`): turn 1 runs against the SCRIPTED fake so an experiment decides exactly what
  the model will find in context — a corrupted pointer, a failed call, a large captured output — then the
  backend swaps to the real model and the task continues in the SAME session. Nothing is fabricated (the
  real loop produced that history), and `seedBoundarySeq` marks where the seed ends so the script's own
  behaviour is never scored as the model's.
- **`bench/`** — a **matrix over `runOnce`, not a test** (see the `bench` skill for the playbook):
  `node --import tsx tests/e2e/bench/run.mjs <spec>.bench.ts` runs every combination of the spec's
  dimensions x tasks x repeats and reports re-emission, pointer use split by fault cause, recovery, token
  cost and correctness with **spread, not a point estimate** (models are stochastic; N>=5 per cell). A
  spec is **typed TypeScript** (`spec.ts`, `defineBench`), so the dimension keys you declare are the keys
  `apply()` receives — a mistyped axis is a compile error, not a cell that silently never varies. Four
  rules keep it honest: metrics derive ONLY from the existing `__mlDebug` stream (a metric that can't be
  computed from it means the PRODUCT is missing an event — fix it there); an experimental dimension is a
  build-time `--define` (`build.mjs --outdir <dir> --define K=V`) so a hypothesis that may conclude "the
  current design was fine" adds zero product surface; cells are content-addressed by config AND build
  fingerprint, so a long sweep resumes and an edit invalidates what it invalidates instead of mixing two
  builds into one table; and the extractors are calibrated FIRST against the scripted fake-LLM. That last
  rule is not ceremony — `specs/smoke.bench.ts` scripts a run that re-emits (must read 1.00), one that
  cites instead (0.00) and one that hides a re-emission in a seeded turn (0.00), and it caught two real
  extractor bugs before any GPU time. Assertions: `tests/bench-metrics.test.mjs` (fast, synthetic
  streams) and `tests/e2e/bench-selftest.spec.mjs` (real streams — the only thing that catches an
  extractor reading a field the product never emits). One walk, N sinks: terminal + markdown today. **Two audiences, one run:** the terminal is for the agent, and
  **`--serve`** prints a banner URL for a live page a human watches — every run's state and what is
  queued, the in-flight run's step against its budget and the tool it is in, elapsed / mean-per-run /
  mean-per-step / ETA, and links to each `run.md`. Dependency-free (node:http + SSE) and a SINK, not a
  second brain: it recomputes with the same `aggregate()` the report uses, so it cannot disagree with
  `report.md`. Worked example specs live in `tests/e2e/bench/specs/` with a `README.md` for humans.
  **CI runs it as its own `bench` job**
  (`npm run bench:calibrate` → build, smoke sweep, `check-calibration.mjs`), deliberately separate from
  `test`/`e2e` so a broken INSTRUMENT names itself instead of reading as a broken extension. Artifacts land per RUN under
  `tests/e2e/artifacts/bench/<spec>/<task>/<combo>/r<N>/` (gitignored) — `run.md` to read, **`run.json` to
  DIFF** (a markdown diff is mostly layout; strip `VOLATILE_FIELDS` + `canonicalizeText` first), plus
  events/transcript/screenshots, and `run.html`+`run.pdf` behind `--pdf`. The report's **Runs** table
  indexes every individual run, since the aggregate hides the one repeat that went wrong.
  **`run.md.html`** is the markdown RENDERED (`tests/e2e/viewer.mjs`, `marked` — a devDependency, since
  the alternative is a partial renderer that silently mangles what it did not anticipate). It is written
  beside `run.md` with RELATIVE asset paths, which is what lets ONE file serve both cases: opened off the
  disk it finds its own `images/`, and served under `/artifacts/<run>/` it finds them there too — so there
  is no server-side render to drift from it. Every h2 becomes a collapsible section, and a **failed run's
  status in the index links straight AT the step that broke** (`focusStep` in metrics.mjs: a memory fault,
  else a tool that returned an error, else the last step of a run that crashed or hit its cap; a run that
  merely answered WRONG with every tool working gets no anchor, because there is no failing step and
  pointing at one would send the reader to an innocent call). Folding is the NATIVE `<details>` state,
  driven by a small inline script admitted by a **CSP hash** — raw HTML has to pass through for the sink's
  own `<details>`, so a scraped hostile page could otherwise run script when a human READS the transcript,
  and a hash admits this exact text while refusing anything injected. A first attempt did the folding in
  pure CSS to avoid script entirely, and it was wrong in a way worth remembering: hiding section bodies
  OVERRIDES the native state, so after "collapse all" a heading click did visibly nothing.
  Observe's artifacts get the same file.
- **`approval-demo.mjs`** — a **narrated demo, not a test**: `npm run build && node --import tsx
  tests/e2e/approval-demo.mjs` opens a headful browser and walks the approval-over-IPC flow (idea #2)
  three times — a manual APPROVE, a manual REJECT, and a POLICY driver that auto-approves read-only
  `exec` and rejects writes — printing the pending-gate descriptor (`__mlApprovals.list()`) and each
  decision (`resolve(key, …)`), all driven from the SW realm with the page walled off. Deterministic
  (fake-LLM, no model/key). Pace it with `PACE`/`HOLD` (ms). The automated assertions of the same flow
  are `approval.spec.mjs`.
- **`resource-demo.mjs` / `resource-panel.spec.mjs`** — the VRAM/RAM panel against a scripted fake BOX.
  `fake-llm.mjs` fakes the box as well as the model: **`setResident()`** drives `/api/ps` and
  **`setCapacity()`** drives `/api/info`, both settable mid-run, so a demo or spec can make models load, move
  card and evict on a timeline. `setCapacity(null)` reproduces a server without the patch, which answers that
  route with the SPA's HTML rather than a 404. The demo walks: idle cards → a model onto the first card → a
  second onto the next → a CPU-resident third against System RAM → an eviction → the panel CLOSED for 20s (so
  the history shows an honest GAP) → CHURN (models loading and evicting at random, including two on one card)
  → the same track drawn stacked and overlaid → a SPLIT model (uneven across every card, remainder in RAM; on
  a one-card box, a partial offload instead) → the box going SILENT on `/api/info` (the tracks stand, because
  capacity is a fact about the box) → a fresh page against a box that NEVER answered (no ceiling invented) →
  capacity restored.
  **`BOX=` picks the machine**: `cuda` (default — two ~95 GiB cards, names nvidia-smi) · `amd` (two ROCm
  cards, names rocm-smi) · `laptop` (a 12 GiB 4080 laptop and 32 GiB RAM, where a 27B has to spill into system
  memory) · `rig` (four NVLinked 3090s a 70B is split across) · `lab` (eight A100s = nine pools, past the
  curated colour palette) · `metal` (one unified pool, no vendor tool to name). Screenshots land in
  `tests/e2e/artifacts/resource-demo[-<box>]/`. The fake box PLACES models the way ollama does — a model takes
  what fits on its card and spills the rest to RAM — so a script can't produce a card at 128% of its capacity.
  The spec asserts the same behaviours, plus a **CUDA → Metal backend switch** (the panel re-shapes to one
  unified track and the old box's history is dropped, since an 18 GiB reading redrawn against an 11.84 GiB
  pool clips and looks like a measurement), the tiling at width, the drag floor, and the tooltip/hit-target
  invariants.
- **`server-tool-live.mjs`** — a **debug probe, not a test**: `npm run build && node --import tsx
  tests/e2e/server-tool-live.mjs` drives `ml.execServerTool` against the REAL OpenWebUI in `.env`, through
  the built extension. Everything in `server-tools.spec.mjs` drives frames this repo also wrote, which is a
  closed loop; this is the only thing that exercises the service-worker fetch, the `chrome-extension://`
  origin, the real auth header and frames a server we did not write produced. `TOOL`/`FN`/`ARGS` pick the
  call. Spends real GPU time (fetch_page summarises with a local model), so it runs one small page by
  default, and it is NOT in CI — the backend is live. It prints arrival time beside PRODUCED time per chunk,
  which is the number to read: equal everywhere means either the server is not stamping or something
  between buffered the whole stream and delivered it at once.
- **`md-ladder-live.mjs`** — a **debug probe, not a test**: `npm run build && node --import tsx
  tests/e2e/md-ladder-live.mjs` drives the Markdown negotiation ladder against LIVE docs sites through the
  built extension and prints each resolution tree. Every other ladder test drives a SCRIPTED fetch, so this
  is the only thing that exercises the real background worker, its host permissions and the real consent
  path. Each site is visited first and fetched from its OWN origin, so the fetch is same-origin and needs no
  approval. Not in CI — the sites are live.
- **`line-map-demo.mjs`** — a **narrated demo, not a test** of the line-mapping system: `npm run build &&
  node --import tsx tests/e2e/line-map-demo.mjs` runs four steps — a dense python one-liner reflowed (toggle
  rendered⇄raw to see the same tokens unbroken), a clean failure, one that PRINTS its way to a failure (so
  stdout and the traceback share the Out), and the JS twin beautified by js-beautify with its map derived.
  Click a traceback line number and the line it names lights up in the code — red for the failure, green for
  the call path. `HOLD=0` exits instead of holding the browser open. The assertions are
  `tests/e2e/line-map.spec.mjs`.

- **`chat-shots.mjs`** and **`chat-web.spec.mjs`**: the chat page's web build (`dist-web/`), which is not the
  extension, so neither uses `launchExtension`. Both serve the build with `static-server.mjs` and open it in a plain
  Chromium, against the fake host's demo world. `chat-shots.mjs` writes a phone and a desktop screenshot of the list and
  of every demo session (`OUT`, `THEME=light`, `SERVE=1` to serve and wait); the spec drives the page through its own UI
  and reads `window.__chatFake.commands` back, because a transcript can look right while the wrong command was sent.
  `E2E_DIST_WEB=<dir>` points both at a build made elsewhere. Scripting the fake host: the `chat-web` skill.
- **`capture-frames.mjs`** — a **capture probe, not a test**: `node --import tsx tests/e2e/capture-frames.mjs
  > tests/e2e/fixtures/events-<name>.json` connects straight to the `.env` box's `/api/events` and dumps the
  retained ring, so a stream fixture is a RECORDING rather than a guess (`SECS`, `SINCE`; it exits saying so
  if the backend does not serve the route). Reach for it whenever the event stream's shapes are in question.
  Its motivating find is the standing reason the fixtures must be recorded: **the stream names models
  fully-qualified (`registry.ollama.ai/library/gemma4:31b`) while `/api/ps`, in the very same frame, names
  them short (`gemma4:31b`)**. Every hand-written fixture agreed with itself, so the panel shipped drawing
  each streamed model TWICE — once as its real row and once as an "off-box" model that had never been
  resident. `normModel` reconciles them (the inverse of Ollama's own ShortName: the default registry, then
  the default `library` namespace, then the implicit `:latest`), applied ONCE at the `machineEventFrom`
  boundary so no later comparison can forget. The replay half is `fake-llm.mjs`'s **`setEvents(frames)`** /
  **`pushFrame(frame)`** / `streamSubscribers()`, and `tests/e2e/resource-stream.spec.mjs` is what drives
  them — the stream transport had NO e2e coverage before it, which is why every bug on this path was
  live-only. Not in CI: only a patched Ollama serves the route.
- **`cursor-demo.mjs`** — a **narrated demo, not a test** of everything the pointer does on the resource
  chart: `npm run build && node --import tsx tests/e2e/cursor-demo.mjs`. Ten beats — the free crosshair,
  turning snap on in the panel's own track editor, a mark on every line, hovering one band to narrow it to
  one, a selection that snaps, the zoom it leaves, an eviction rule making the line and marks stand down, Esc
  hiding the tip, moving bringing it back, and the product alone. Every one of those came from watching the
  chart go wrong rather than from a spec, which is why they are worth having in one place you can run.
  Deterministic (a fake box, no model and no key); `HOLD=0` exits instead of holding the browser open, `PACE`
  sets the beat. Screenshots land in `tests/e2e/artifacts/cursor-demo/`. The assertions are in
  `resource-panel.spec.mjs`. It also walks the KEYBOARD reading — ↑↓ picking a model without the pointer
  moving, → drilling into what its memory is holding, and a real 3:1 split answering on both cards at once.
- **`panel-news-demo.mjs`** — a **narrated demo, not a test** of the resource panel's 2026-09-11/12 features in one run:
  `npm run build && node --import tsx tests/e2e/panel-news-demo.mjs`. A fake box drives the panel over the EVENT
  STREAM the way a patched Ollama does (samples at the stream's cadence, edges between), so it walks: the quant in
  words, the residual named by process (a tenant, "outside ollama's view", a runner's overhead), the gear's time grid
  and load predictions, a LIVE load that overshoots and settles against its dashed prediction, `ml.__loads()`, the
  phase ribbon from engine timings, the drilled-in load curve, the shared kind toggles, and the engine's token count
  climbing through a streamed tool call. `HEADLESS=1` checks the script unseen; `PACE`/`HOLD` as elsewhere. It parks
  the pointer INSIDE the panel between beats (`park()`): a one-step jump out of the iframe never tells the chart the
  pointer left, and the last hover stays up.
- **`whole-box-demo.mjs`** — a **narrated demo, not a test** of the Whole box view across `tests/fixtures/boxes.mjs`'s
  shapes and their links: gpubox over PCIe (REAL capture), 4×3090 bridged two ways (the reorder), 8×A100 NVSwitch,
  a DGX-1 partial mesh, AMD MI210s over an Infinity Fabric Link and 8×MI300X all-to-all over xGMI (both MOCKS), and a
  Mac, where Whole box is not offered. Each beat opens a fresh tab, picks the view from the header, and hovers a card
  for the links section.
- **`stream-demo.mjs`** — a **narrated demo, not a test** of LIVE tool-output streaming: `npm run build &&
  node --import tsx tests/e2e/stream-demo.mjs` opens a headful browser, slides the overlay open on a real
  (background-hosted) run, and drives a deliberately SLOW `exec` (paced `console.log`), a read-only `exec` survey
  (no approval, paced by awaiting a slow `ml.ps()`) and `python_exec` (paced `print`) so you can watch each Out fill
  in Jupyter-style. It also captures the two adjacent
  behaviours: the "captured, but NOT sent to the model" marking, and the in-cell Ctrl+F find bar.
  Screenshots land in `tests/e2e/artifacts/stream-demo/`; `HOLD=0` exits instead of holding the browser
  open. Deterministic (fake-LLM, approvals resolved via the SW `__mlApprovals` channel). The automated
  assertions are `python-stream.spec.mjs` (the reverse channel), `readonly-stream.spec.mjs` (a read-only survey
  streams as an approved `exec` does, and a refused one is discarded) and `output-scroll.spec.mjs` (tail-follow).
- **`code-theme-demo.mjs`** — a **narrated demo, not a test** of Settings → Code blocks → Colour theme:
  `npm run build && node --import tsx tests/e2e/code-theme-demo.mjs`. An agent step's JavaScript and a bench script
  side by side, walked through the default, GitHub (a pair, in a light panel), Nord (dark-only, keeping its own
  background in a light panel), the panel switched to dark, and a VS Code theme uploaded through Settings. `THEME=`
  points it at your own theme file (the repo's fixture otherwise); `LINGER`, `HOLD=0`, `HEADLESS=1`; screenshots in
  `tests/e2e/artifacts/code-theme-demo/`. The assertions are `code-theme.spec.mjs` and `tests/code-themes.test.mjs`.
- **`bench-traceback-demo.mjs`** — a **narrated demo, not a test** of a bench traceback pointing into the
  editor: `npm run build && node --import tsx tests/e2e/bench-traceback-demo.mjs`. Real Pyodide, no model.
  It opens with the log's renderers in the bench (a sympy integral typeset, a numpy Mandelbrot returned as a PIL
  image). Then a script fails inside a function (the line is marked and the gutter comes on), the call-site frame pulses
  green and the failing frame red, two lines typed above move the mark and the jump with the line, editing the
  failing line drops the mark and the frame says it changed, a fixed re-run clears it, and Settings →
  Appearance → Show line numbers draws the gutter on its own. `PACE`, `LINGER`, `HOLD=0`, `HEADLESS=1`;
  screenshots in `tests/e2e/artifacts/bench-traceback-demo/`. The assertions are `bench-editor.spec.mjs`.
- **`bench-completion-demo.mjs`** — a **narrated demo, not a test** of what the bench's completion knows:
  `npm run build && node --import tsx tests/e2e/bench-completion-demo.mjs`. Real Pyodide and real Jedi, no
  model. It starts the sandbox through the environment panel WITHOUT running anything, shows the prelude's
  `np`/`pd`/`to_base64` completing with nothing kept, a pandas call typed from stubs, a Run that keeps `grid`,
  the live array completing beside the stubs, and a Reset that takes `grid` away and leaves the prelude. `PACE`,
  `LINGER` (how long each popup stays up), `HOLD=0`, `HEADLESS=1`; screenshots in
  `tests/e2e/artifacts/bench-completion-demo/`. Its first headless run caught the worker's per-run inputs being
  listed as kept variables, which is what a demo is for. The assertions are `tests/python.test.mjs` and
  `bench-dock.spec.mjs`.
- **`run-log-demo.mjs`** — a **narrated demo, not a test** of the EXECUTION LOG panel (`docs/dev/run-log.md`):
  `npm run build && node tests/e2e/run-log-demo.mjs` (`BEAT=`, `HOLD=0`; screenshots in
  `tests/e2e/artifacts/run-log-demo/`). It loads the extension and uses the real chat page, because the panel is
  extension-only (`ChatExtras.runLog`), and it stages the measured failure rather than drawing it: a run whose
  first step is a `wait` that sits for twelve seconds, with the tab reported discarded out from under it. It
  prints the records as the worker holds them and the panel's own text, so checking it does not mean opening
  seventeen screenshots.
  It turns the execution log's console echo on (`globalThis.__mlRunLog.echo()`, in the WORKER) and relays those
  lines out through `ext.sw.on("console")`, which is worth copying into any spec or harness that cares what the
  machinery did: the records stream as they happen instead of being read back out of `storage.session` at the
  end. It is off by default for everyone who is not driving the browser.
  **A REAL `chrome.tabs.discard` TAKES THE WHOLE BROWSER CONNECTION WITH IT.** Measured, in isolation, with no run
  in flight and two tabs open: the discard succeeds, Chrome re-files the tab under a new id — and Playwright's
  persistent context is gone (`pages()` is empty, every page `isClosed()`, the next call throws "Target page,
  context or browser has been closed"). The target is destroyed and the connection does not survive it. So a spec
  cannot stage a discard at all, and this demo patches Chrome's own `discarded` flag ONCE, on the one tab, which
  is the single boolean `tabState` reads; everything after it — the probe that notices, the reload in place, the
  re-adopt, the one retry — is real. The assertions are `tests/run-log.test.mjs`, the execution-log test in
  `chat-page.spec.mjs`, and the pin/release half of `cross-page.spec.mjs`.
  Two things this demo found that the specs did not: the log's story ended at "discarded, reloaded" with nothing
  saying whether the run went on (so a retry that works now says so), and the tab id, identical on every line,
  was spending exactly the width that wrapped each record into two.
- **`touch-tips-demo.mjs`** — a **narrated demo, not a test** of READING A TOOLTIP WITHOUT A POINTER:
  `npm run build && node tests/e2e/touch-tips-demo.mjs` (`BEAT=`, `HOLD=0`; screenshots in
  `tests/e2e/artifacts/touch-tips-demo/`). One phone context (`hasTouch`), left open at the end. Five beats: the
  tip is unreachable · a tap holds it · the tap is not stolen (the step opens too) · the next tap dismisses it ·
  a trigger that IS a control raises nothing.
  **A HEADFUL DEMO CANNOT HOLD A SYNTHETIC HOVER**, which is why there is no desktop beat and is worth knowing
  before writing one: `page.mouse.move` is a CDP event while the real cursor is wherever the hand left it, so
  Chromium corrects the pointer position back out and raises a genuine `pointerout` within a frame or two.
  Measured: headless the tip survives a second; headful it is gone inside 900ms, with three `pointerout`s, the
  last carrying a null `relatedTarget`. A spec can assert a hover (it runs headless); a watched demo cannot.
  It also prints what each beat SAW (`observe`), because checking a demo otherwise means opening six screenshots
  — and that is how it caught the tip dying to the scroll its own tap had caused, which the spec had missed by
  asserting a beat too early. The assertions are `tests/tooltip-layer.test.mjs` and the `@mobile` test in
  `chat-web.spec.mjs`.
- **`streak-demo.mjs`** — a **narrated demo, not a test** of TOOL-STREAK FOLDING in the chat page's calm view:
  `npm run build && node tests/e2e/streak-demo.mjs` (`BEAT=` paces it, `HOLD=0` exits instead of leaving the
  browser for you; screenshots in `tests/e2e/artifacts/streak-demo/`). It needs no extension — it serves
  `dist-web/` and drives the FAKE HOST (`window.__chatFake.addSession` + `emit`) rather than a scripted model,
  because every beat is about WHEN the client folds what it has, so the pacing has to be the demo's own.
  Nine beats, each one rule: different tools never fold · two is a pair · a live tail stays open · something
  following it makes it fold · a second run of the same tool is a SEPARATE streak (adjacent, not cumulative) ·
  the row carries the count, the failures and the total time · a turn that said something is never folded ·
  open is indistinguishable from never folded, plus the rail · the tail folds when the run ends.
  PART THREE is a second session for the other thing that changes under a reader: a run stopping at its step cap
  and being continued past it, where the boilerplate answer collapses into a seam naming the budget. That part
  caught a fold merging ACROSS the seam, so the divider rendered under all seven steps instead of in the middle
  of them — a plausible-looking order that nothing throws on and no finished transcript would show.
  PART TWO turns on the ⋮ menu's "Group all tool calls" and walks the three things that rule still owes you: a
  mixed run becoming one row counted in CALLS and naming every tool; a pending gate standing OUTSIDE the group and
  folding in once answered; and a citation in the answer opening the group the step it names is now inside.
  It exists because a finished transcript cannot show you any of that: every clause is about the turns AROUND a
  step, so reading the end state tells you what folded and never why. Its first run found `ApprovalBadge`
  throwing on an approval value it did not know — a crash a newer runtime could have caused on a real client.
  The assertions are `tests/step-streak.test.mjs` and the fold tests in `chat-web.spec.mjs`.
- **`table-demo.mjs`** — a **narrated demo, not a test** of fetched tables: `npm run build && node --import tsx
  tests/e2e/table-demo.mjs` (`HOLD=0` exits). Part one (beats 1–8) is built behaviour: CSV / semicolon / Parquet
  previews, `pipe`, the read-only survey, a full `exec` through a pointer, `python_exec` from the cache, and an
  answer citing its work. Part two (beats 9–12) is a TARGET written before it exists: an Arrow file, `python_exec`
  opening it by pointer, and JavaScript reading Python's table back in full. Its captions compute a verdict from
  the tool message (`✓ works` / `✗ not built yet — got: …`), so the demo never claims what did not happen.
- **ACCEPTANCE specs: `pointer-values.spec.mjs`.** Tests for `docs/spec/POINTER_VALUES.md` written before the
  slices, each marked `pending("<slice>")` — a `test.fail()`, so it RUNS and Playwright reports "expected to fail,
  but passed" the day a slice lands, which forces the marker off in that change. A marked test passes on ANY
  failure, so when writing or reviewing one run it with **`SHOW_PENDING=1`** and read why each fails: a wrong
  fixture looks exactly like missing behaviour otherwise (writing this spec, one did — `ml.fetch` on a URL
  `fetch_url` had not approved). Arrow fixtures come from the `apache-arrow` dev dependency.
- **`bench-editor-demo.mjs`** — a **narrated demo, not a test** of the Python bench's editor:
  `npm run build && node --import tsx tests/e2e/bench-editor-demo.mjs` opens a headful browser, switches
  to the bench, and types numpy into it so you can watch the plain textarea upgrade to CodeMirror, the
  highlighting land, the completion popup filter, and Cmd/Ctrl+Enter run against the real Pyodide
  sandbox. `PACE` sets the keystroke delay, `HOLD=0` exits instead of holding the window open, and
  `HEADLESS=1` captures the screenshots (`tests/e2e/artifacts/bench-editor-demo/`) without a window.
  Deterministic — nothing here calls a model. The automated assertions are `bench-editor.spec.mjs`.
  Three things about the editor (`CodeEditor`, `src/sidebar/code/code-editor.tsx`) are easy to break:
  - **The run chord is ALWAYS claimed, whoever acts on it.** CodeMirror's default keymap reads `Mod-Enter`
    as "insert a blank line", so an editor that leaves it unbound adds a line to the script AND lets it
    bubble to whatever runs it. With `onRun` the editor runs it and STOPS it; without, it swallows it and
    lets it bubble. The bench passes no `onRun` — it owns `⌘/Ctrl+↵` panel-wide (`onBenchKey`). Both
    modifiers are bound, since "Mod" is Cmd-ONLY on macOS and the textarea this replaced took either.
  - **A test must press the platform's OWN Mod** to see the blank-line bug: on a Mac only Cmd reaches
    that binding, so a Ctrl+Enter test passes there and fails on Linux CI.
  - **A stale `value` prop is an echo, not an edit.** Preact replays props several keystrokes behind, and
    pushing one back in rewrote the document under a moved cursor ("pri" landed as "rip"); echoes are
    consumed as a queue.
  - **A traceback frame jumps into the EDITOR, the log's gesture.** `jumpToLine` (render-panel.tsx) hands
    the jump to the bench with a synchronous `BENCH_JUMP_EVENT` when the frame is inside `.bench` (it cannot
    import vram.tsx), and the editor pulses the line with the log's own `.cline-pulse`/`.cline-pulse-fail`.
    The last failure's line is marked (`markLine`) with its number red, like a failing step's block. The
    traceback's numbers are about the code that RAN (`BenchRun.code`) and you keep typing after a failure, so
    both go through `mapLine` (diff.ts): a line that moved is followed, a line that was EDITED is refused, and
    the frame says "changed since this ran" rather than pulsing whatever slid into that number.
  - **Line numbers follow the log's preference** (`codeLineNumbers`, Settings → Appearance) and come on while
    the last run's failure is shown. Keyed on the FAILURE, not the mark: the mark goes when you edit the
    failing line, and the gutter going with it shifted every line sideways under the cursor.
  - **A spec clicking in the bench must wait for the panel to stop SLIDING** (`openBench` in
    bench-editor.spec.mjs). The transition is on the shadow host outside the iframe, which Playwright's
    stability check does not see, so an early click lands where the button was and the frame receives
    nothing — a run that silently never started, 3 times in 4.
  **`.bench-code` is the FRAME, not the field** — it sizes the editor in its pane. A test drives
  `.bench-code textarea` under jsdom (the bundle never loads there, so that is the fallback it gets) and
  `.bench-code .cm-content` in a real browser, where `inputValue()`/`toHaveValue()` no longer apply: read
  the document as `.cm-line`s joined by `\n`, since `toHaveText` normalises exactly the whitespace a
  reflow test is about.

## The harness, the suite and its rules

## End-to-end & real-model testing (the Playwright harness)

`tests/e2e/` loads the **built `dist/`** extension in a real Chromium so browser-only
behaviour (navigation, SW lifecycle, content-script re-injection) can be exercised. It is
**opt-in and slow** — reach for it only when jsdom/`node:vm` genuinely can't represent the
thing. The parts:

- **`harness.mjs`** — `launchExtension()` (persistent context + `--load-extension=dist`),
  `configureExtension(sw, cfg)` (writes `chrome.storage.sync` via the SW), `waitForMl(page)` (which also APPROVES the
  page's origin, since every page-started message is refused for an unapproved one, docs/dev/site-access.md;
  `{ approve: false }` leaves it unapproved), `approveOrigin(sw, origin)`. The node:vm harness does the same for a test
  sender unless `loadBackground({ siteGate: true })`.
  **HEADLESS by default**, via `channel: "chromium"`. The old note here said an MV3 service worker does
  not register under headless Chromium — true, but narrower than it read: plain `headless: true` runs the
  headless SHELL, a stripped binary with no extension support at all. `channel: "chromium"` runs the FULL
  browser in `--headless=new`, where the worker registers in ~0.5s and the whole suite passes. This
  matters beyond tidiness: a headful window grabs focus and the mouse on every launch, and the suite
  launches one per spec. Pass `headful: true` (the narrated demos do) or set `E2E_HEADFUL=1` for a look.
  **`E2E_DIST=<dir>`** runs specs against a bundle built elsewhere (`node build.mjs --outdir <dir>`) — use it
  whenever `dist/` is loaded in a window someone is using, rather than rebuilding underneath them. **A run is started exactly like a console call:** `page.evaluate(() =>
  window.ml.agent(task, opts))` — Playwright's `page.evaluate` runs in the page **main world**,
  where `injected.js` defines `window.ml`, so no test-only hooks; the same front door a human
  uses. The result structured-clones back to Node.
- **`fake-llm.mjs`** — a scriptable OpenAI-shaped backend (`startFakeLlm()` → `setScript([...])`)
  so the REAL pipeline (background loop → tool delegation → page) runs **deterministically with
  no Ollama**. A script step is `{ content }`, `{ tool, args }`, or `(reqBody) => step` (reactive
  — the final answer can echo a value a real DOM tool read off the page). This is the CI gate.
- **The suite is `fullyParallel`** (3 workers in CI, half the cores locally). Each test gets its own browser and
  its own servers on port 0, so tests share nothing. A spec that DOES share state across its tests (one browser
  from a `beforeAll`) must pin itself with `test.describe.configure({ mode: "default" })`, or its tests land on
  different workers, each running its own `beforeAll`.
- **RULE — a wait loop breaks on something that is on screen while a step is COLLAPSED.** Steps start collapsed,
  so anything inside a step body (`.r-py-in`, `.code.tb`, `.r-df-table`) is not in the DOM until the step is
  opened, and a `for (…; i < 60; …) { …; if (bodyThing) break; sleep(400) }` quietly runs to its cap and then
  passes anyway, because the test opens the step next. Eleven tests did that for 24–30 s each. Wait for the RUN
  TO FINISH instead (`fake.calls().length` has reached the script's length and no `.astep.tool.pending` is
  left) — not merely for one step to land, or the test opens a step while the next is still arriving and the
  sidebar re-renders under it, which only shows once CPU is contended. A test whose time is the same on a
  laptop and on CI is waiting on a timer.
- **`cross-page.spec.mjs`** — a `smoke` (extension loads + one-shot agent) + a `sanity` (agent
  reads a page value via a DOM tool and answers it) that run under BOTH the fake and a real
  backend, plus the skipped cross-page acceptance test (see `tmp/cross-page-agent.md`). Those two
  are tagged **`@real-ok`**, and a `beforeEach` SKIPS every other test in the file when
  `E2E_BACKEND` is set: the rest script an exact turn sequence and read `fake.calls()` back, so
  they cannot mean anything against a real model — and without the skip they dereferenced a null
  `fake` and failed, which reads as a product bug in the nightly real-model job. Tag a new test
  `@real-ok` only if it guards its fake usage (`if (fake) …`) and asserts on the run's own result.
- **The self-tools** (details and gotchas: `docs/dev/e2e-harness.md`; each has a skill in `.claude/skills/`):
  `observe.mjs` drives ONE agent run and writes `run.md`/`run.json`/screenshots — how a model debugs the
  extension. `run-once.mjs` is the core observe and the bench share (seeded histories included). `bench/` is a
  typed matrix over `runOnce` with spread, not point estimates, and its own CI job. Debug probes against LIVE
  backends (never in CI): `server-tool-live.mjs`, `md-ladder-live.mjs`, `proto-stream-live.mjs`,
  `capture-frames.mjs` (records real event-stream fixtures). The chat page's web build has its own: `chat-shots.mjs`
  (phone + desktop screenshots against the fake host, `SERVE=1` to just serve it) and `window.__chatFake` to script it
  (skill: `chat-web`). `dist-app/` is that client made INSTALLABLE — a manifest, icons and a service worker holding its
  own files (`src/chat/pwa/`, stamped in by `installable()` in build-web.mjs) — and CI publishes it to GitHub Pages
  from main, which is how a device with no packaged app (an iPad) gets one. Pairing with a REAL hub before the screens exist: `scripts/hub-root.mjs` (the account's
  root device on the command line) and the extension's `dev-hub-pair.html` (offers this browser, shows the
  connection's history for an idle test) (skill: `hub-pairing`). The phone app on an emulator or a plugged-in phone,
  OPTIONAL tooling: `scripts/android.mjs` and `scripts/ios.mjs`, same commands (boot, install, launch, screenshot,
  Maestro flows in `tests/mobile/`; the app is `mobile/`, and CI publishes its APK as the `android-latest`
  release) (skill: `phone`);
  phone-layout Playwright tests are tagged `@mobile` (`npm run test:mobile`). A nearly full disk:
  `scripts/check-disk.mjs` (the pre-commit hook warns under 20 GB free, with what to clear; never deletes) (skill:
  `disk-space`). One look at a page (a URL or a built file, phone or desktop, touch, dark, WebKit; an expression
  evaluated, errors and a screenshot printed): `scripts/probe.mjs` (skill: `probe`), instead of a throwaway spec.
  Narrated demos (watched, never asserting):
  `approval-demo`, `resource-demo` (`BOX=`), `line-map-demo`, `cursor-demo`, `panel-news-demo`, `whole-box-demo`,
  `stream-demo`, `bench-editor-demo`, `bench-completion-demo`, `pairing-demo` (the named grants and their switches,
  the one device that refreshes its pairing rather than renewing, and an account with nobody left to sign a removal;
  serves `dist-web/`, so it needs no extension),
  `run-log-demo` (the EXECUTION LOG panel, with the measured failure staged: a run whose delegated call is
  outstanding when its tab is discarded, then reloaded in place and retried — and a trap, measured: a real
  `chrome.tabs.discard` DESTROYS the target and takes Playwright's connection to the WHOLE browser with it, so a
  spec cannot stage one and this demo patches Chrome's own `discarded` flag once instead),
  `touch-tips-demo` (reading a tooltip with no pointer, on a PHONE context — and a trap for the next demo author:
  a synthetic hover cannot be held in a HEADFUL window, because the real cursor is elsewhere and Chromium corrects
  the pointer straight back out; it holds fine headless, which is why a spec can assert one and a watched demo
  cannot),
  `streak-demo` (the reading view folding runs of the same tool, appended ONE STEP AT A TIME — every rule
  here is about the turns AROUND a step, so a finished transcript cannot show you why a stretch folded and the
  one under it did not; part two is the ⋮ menu's "group all tool calls"; drives the fake host rather than a model,
  serves `dist-web/`, so it needs no extension),
  `table-demo` (fetching CSV/Parquet, then
  scanning, surveying and analysing them through pipe / readonly exec / full exec / python_exec; part two is the
  Arrow + cross-runtime pointer TARGET, captioned with what actually happened). Acceptance specs for unbuilt
  slices (`pointer-values.spec.mjs`) mark each test `pending(…)`; run `SHOW_PENDING=1` to read why each fails.
- **RULE — a demo says what it is doing, on screen: `narrate(page, "…", { sub: "…" })`** (harness.mjs). A
  demo is WATCHED, and a watcher who cannot tell which beat is running infers it from what moved — which is
  exactly backwards when the point of a beat is that something did NOT move. It draws a banner in the PAGE
  (top-left, its own element, very high z-index), deliberately not inside the extension's shadow hosts, so it
  can never be mistaken for part of the product and a demo about the sidebar cannot have its narration hidden
  by the sidebar. `narrate(page, null)` clears it for a screenshot that should show the product alone. Call it
  at every beat, not once at the start.

  The banner also says WHOSE WINDOW IT IS. A headful demo takes the pointer and the keyboard, and a watcher
  who cannot tell a finished demo from a paused one either waits for nothing or clicks into the middle of a
  beat — so every `narrate` marks the run as still driving, and **`narrateDone(page)` flips it** to "the
  browser is yours". Call `narrateDone` immediately before holding the browser open (or before exiting),
  never after a later `narrate`, which sets the status back to running.
- **RULE — a demo about what happens INSIDE a run must call `openRunInSidebar(page)`** (harness.mjs). The
  panel opens on the SESSIONS LIST, not on the run, so a demo that only slides the sidebar open queries an
  empty transcript, reads zero of everything, and reports that the feature does not work — which every demo
  here has done at least once. The helper slides the panel open, waits for the iframe, CLICKS the session row
  (optionally matched by task text) and waits for the detail view. It does not wait for the run to finish, so
  it is right for the live demos too.
- **A background run's events are not on the page's window: watch them with `watchRunEvents(ext, page, fn)`**
  (harness.mjs), which holds the DevTools panel's `ml-devtools` port for the page's tab from an extension page and
  hands each event to Node. Since attack 15 (docs/spec/SITE_ACCESS.md) the worker sends a run's events to the shell
  over `chrome.runtime` only; a `message` listener on the page now sees just the page's OWN events (a run the page
  hosts), so a spec keeps that listener for those and adds the watcher for the rest. Open the sidebar by CLICKING its
  tab (`#ml-sb-tab` in the `#ml-sb-root` shadow root), never by posting `__mlSidebarOpen` into its iframe: the app
  ignores window messages on a web page, because the page could send them too.
- **Real model:** point the extension at a real backend with `E2E_BACKEND=<chatUrl>
  E2E_MODEL=<id> E2E_KEY=<bearer>` (the observer also accepts `USE_ENV=1` to read
  `OPENWEBUI_URL/KEY/MODEL` + `OPENWEBUI_UTILITY_MODEL`/`OPENWEBUI_VISION_MODEL` from `.env`).
  Warm-up fires a 1-token completion before the timed window so the ~20GB cold load doesn't
  pollute timings (Ollama's keep-alive TTL keeps it warm between runs — only the first pays it).

**CI (`.github/workflows/tests.yml`):** two Playwright jobs. `e2e` is the **deterministic gate**
(fake-LLM, every push/PR, under `xvfb`). `e2e-real-model` is a **non-blocking** sanity check
(`continue-on-error`, `workflow_dispatch` + nightly) that runs **only the `@real-ok` tests** (everything
else scripts the model, so it skips or tests something a real model has no bearing on) against a free
hosted OpenAI-shaped model —
default **Groq**, enabled by the repo secret `GROQ_API_KEY_FREE`, overridable via repo variables
`E2E_REAL_BACKEND`/`E2E_REAL_MODEL`; it self-skips without the secret. Hard-won findings: a real model on this job produced a Groq
`tool_use_failed` 400 — `attempted to call tool 'orient' which was not in request.tools` — having invented
a tool from the system prompt's own numbered method ("1. ORIENT — get your bearings"). Groq validates tool
calls server-side, so a hallucinated name is a hard 400 rather than a recoverable step, which is one more
reason this job is non-blocking. **GitHub Models is retired** (its API 410s a "retirement brownout" — don't use it); **`llama-3.3-70b` on
Groq emits malformed `<function=…>` tool calls** — use an `openai/gpt-oss-*` model, which complies;
the Groq **free tier is 8000 TPM**, so a multi-turn agent (the ~3.2k-token system prompt re-sends
each turn) trips it — hence the rate-limit backoff (`docs/dev/architecture.md`). GPU-less CI runners can't run a real model
usefully (tiny CPU models botch tool-calling), so a free hosted API is the only real-model option in
CI; do real iteration on a local GPU box instead.
