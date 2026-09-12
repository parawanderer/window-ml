# The e2e harness, probes and demos

Implementation notes for the self-tools in `tests/e2e/`: observe, run-once, the bench, the live probes and the narrated demos. Each also has a skill in `.claude/skills/`, moved out of AGENTS.md on 2026-09-12 so they are read when that code is being
changed rather than loaded into every session. AGENTS.md keeps the repository's working rules and the traps that
bite; this file keeps how the subsystem works and why it is built that way. Paths name files by their bare name,
as in AGENTS.md — they are all under `src/`.

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
  (background-hosted) run, and drives a deliberately SLOW `exec` (paced `console.log`) and `python_exec`
  (paced `print`) so you can watch each Out fill in Jupyter-style. It also captures the two adjacent
  behaviours: the "captured, but NOT sent to the model" marking, and the in-cell Ctrl+F find bar.
  Screenshots land in `tests/e2e/artifacts/stream-demo/`; `HOLD=0` exits instead of holding the browser
  open. Deterministic (fake-LLM, approvals resolved via the SW `__mlApprovals` channel). The automated
  assertions are `python-stream.spec.mjs` (the reverse channel) and `output-scroll.spec.mjs` (tail-follow).
- **`bench-editor-demo.mjs`** — a **narrated demo, not a test** of the Python bench's editor:
  `npm run build && node --import tsx tests/e2e/bench-editor-demo.mjs` opens a headful browser, switches
  to the bench, and types numpy into it so you can watch the plain textarea upgrade to CodeMirror, the
  highlighting land, the completion popup filter, and Cmd/Ctrl+Enter run against the real Pyodide
  sandbox. `PACE` sets the keystroke delay, `HOLD=0` exits instead of holding the window open, and
  `HEADLESS=1` captures the screenshots (`tests/e2e/artifacts/bench-editor-demo/`) without a window.
  Deterministic — nothing here calls a model. The automated assertions are `bench-editor.spec.mjs`.
  Three things about the editor (`CodeEditor`, `src/sidebar/code-editor.tsx`) are easy to break:
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
  **`.bench-code` is the FRAME, not the field** — it sizes the editor in its pane. A test drives
  `.bench-code textarea` under jsdom (the bundle never loads there, so that is the fallback it gets) and
  `.bench-code .cm-content` in a real browser, where `inputValue()`/`toHaveValue()` no longer apply: read
  the document as `.cm-line`s joined by `\n`, since `toHaveText` normalises exactly the whitespace a
  reflow test is about.
