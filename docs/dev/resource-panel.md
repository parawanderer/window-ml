# The resource panel and event lane

Implementation notes for the VRAM/RAM panel (`resource-model.ts`, `resource-chart.tsx`, `vram.tsx`) and its event lane. The spec with ASCII mocks is docs/spec/RESOURCE_PANEL.md, moved out of AGENTS.md on 2026-09-12 so they are read when that code is being
changed rather than loaded into every session. AGENTS.md keeps the repository's working rules and the traps that
bite; this file keeps how the subsystem works and why it is built that way. Paths name files by their bare name,
as in AGENTS.md — they are all under `src/`.

**`ml.info()` — machine capacity.** `ml.ps()` says what is RESIDENT; `ml.info()` says what there is room for
(Ollama `/api/info`, via the same base discovery `/api/ps` uses). Returns **null** when the route isn't served
— only a patched Ollama behind an OpenWebUI passthrough answers it, everything else replies with the SPA's
HTML — which must read as "capacity unknown", never as zero. `LoadedModel` also gained exact
`vramBytes`/`sizeBytes` beside the rounded GB, and `gpus[]` for per-device placement; a CPU-resident model has
**no `gpus` key at all**, and that absence is the server's signal, preserved rather than normalised to `[]`.

**Resource panel (VRAM/RAM).** `resource-model.ts` is the pure, unit-tested layer (parsing, bands, ceilings,
series/tracks/presets, history segmentation); `src/sidebar/resource-chart.tsx` only draws. Spec + ASCII mocks +
live captures from both a CUDA box and a Metal Mac: `docs/spec/RESOURCE_PANEL.md`. **Read it before touching
this** — several of the numbers are counter-intuitive and getting one wrong produces a confidently wrong
display rather than an obvious bug:
- **All memory figures are raw BYTES and BINARY.** A card sold as "96GB" reports 94.97 GiB; dividing by 1000³
  gives 101.97 GB, which reads as plausible and is 7.4% wrong. Keep bytes internally, convert once at the
  render boundary through **`formatBytes`** — one formatter, never a hand-rolled `/1e9`, and never a bare
  number. Model FILE sizes are normalised to GiB too, even though `ollama list` prints them decimal.
- **Three totals, all correct**: nominal (no API reports it — never synthesise it by rounding), the driver
  framebuffer total (`physical_memory`, what nvidia-smi shows — DISPLAY this), and `cuDeviceTotalMem`
  (`total_memory`, what ollama places against — decide FIT against this).
- **A device decomposes into three bands, never two**: attributed per model, the residual, then free. The
  residual is named by MAGNITUDE — under ~1 GiB it is ollama's own driver context (an idle card holds ~0.55
  GiB), above it something genuinely else is there. Calling it "other processes" invents a process.
  **The residual is explained in ITS backend's terms** (`residualNotes(runner)`, `HOST_RAM_NOTE`,
  `UNIFIED_NOTE`): a CUDA context on NVIDIA, a HIP (ROCm) context on AMD, generic wording on other backends, the
  operating system and other programs for host RAM, and the one shared pool on a Mac. The 0.7–1.8 GiB range was
  measured on CUDA only, so only CUDA quotes it. It used to be one CUDA sentence under every pool, System RAM
  included. Every band carries its own note; the legend's fallback is backend-neutral.
- **Once the driver NAMES the processes, the residual is split by them instead** (`processes` +
  `processes_scope` on `/api/info`, `processBands`): each runner's overhead (its process minus its model's
  share of the card, 444 vs 633 MiB on one box, so never a constant) stacked directly on its model in a wash
  of its colour, a loading runner drawn whole as its load (which `pendingAllocation` then reads directly),
  ollama's helpers as one band, and any other listed process as a named tenant. **Read `processes_scope`
  before trusting an empty list**: under `"pid_namespace"` (any container) another container's process is
  not listed at all while its memory is still out of `free`, so the unlisted remainder is "outside ollama's
  view" and never "overhead". Every residual key must be in `bandOrder`, or its band silently drops out of
  the stack. **Only a list WITH a scope is trusted**: an earlier server build listed bare `{pid, used_memory}`
  entries with neither the scope nor the runner marks (the recorded `events-load-lifecycle.json` is one), and
  read as authoritative that list named ollama's own 88 GiB runner as a stranger's process.
- **A model row says which BUILD it is** (`quant`/`paramSize`/`family` from `details` on `/api/ps`, which stock
  Ollama sends too), IN WORDS: `quantPlain` turns `Q4_K_M` into "4-bit weights" and keeps the code and what it
  means for the tooltip. Integer and float formats are kept apart — `Q4_*` is a 4-bit integer with a scale per
  block, `MXFP4` a real 4-bit float — and an unknown code is shown as itself rather than guessed at.
- **THE VRAM PREDICTOR'S FIGURES, off by default** (gear → Predictor → "load predictions", `predictView`,
  `ml_res_predict`). For tuning the server's predictor, not for a user: an `estimate` frame (`estimateFrom`) is
  carried on the load it predicted, beside `load.complete`'s measured `memory`, and the load's tooltip sets them
  against each other (`PredictionRows`). Every difference is taken against `predicted_for_load`, the figure
  placement fits against; weights and KV are compared term by term and never summed. **VRAM is not monotonic
  through a load** (a fit probe and discovery come and go, the context allocates, it settles below its peak), so
  `loadTrace` reports the PEAK beside where it SETTLED: the runner's own process memory when the driver lists it
  (`runner` basis), else the cards' growth over their pre-load level (`device` basis, skewed by an eviction at the
  same time). A dashed line on the card (`PredictLines`) marks where the prediction said it would land — only on
  a one-card load, since dividing a whole-model figure between cards would be pro-rating. **`ml.__loads()`** hands
  the same comparison back as DATA: `LoadRecorder` (load-records.ts) builds one record per load in the service
  worker once its settling reading arrives, keeps it in storage.local while the toggle is on (deduped against a
  reconnect's replay, capped), with the server's `estimate` and `load.complete` fields verbatim and the trace as
  `[ms since start, bytes]`. `{ clear: true }` empties it. The panel must be open while loads happen.
- **Unified memory (Metal) is one pool**: `runner` is the discriminator, occupancy comes from the HOST (a
  Mac's device reported itself 11.84/11.84 GiB free while the system was 12.6 GiB deep in the same silicon),
  and a GPU-resident model is attributed in FULL there (`size == size_vram`, so attributing only the spill
  attributes nothing).
- **History is session-only and per-BOX**: `boxSignature` identifies the machine, and pointing at a different
  backend drops the old box's samples — including those taken before capacity was known, which would
  otherwise be backfilled with the NEW ceiling. Gaps stay gaps (`segments`), because polling is gated on the
  panel being open and a line across a ten-minute hole is a confident claim about memory nobody measured.
- **Presets are derived from the catalog** and validated by `presetRefusal` against `stackRefusal` — a preset
  may never propose a layout the rule then rejects (Overview stacked several cards until a drift guard caught
  it). Stacking asserts the parts sum to a real whole: true within one pool, false across cards or across
  device+host on unified memory.
- **Capacity is a fact about the BOX, not about a poll** (`holdCapacity`): a `/api/info` that answers with
  nothing means THIS request learned nothing, and forgetting what was measured swapped the whole panel for
  the no-ceiling fallback until some later poll happened to succeed. A box that has NEVER answered still
  degrades — and SAYS so, since an unexplained bare line reads as the panel having regressed.
- **A model keeps its identity for as long as it is DRAWN.** Band colour/name came from the last frame only,
  so an evicted model's whole history turned anonymous grey — in the view whose job is saying what WAS there.
  Identity comes from any frame in the window, and the model list carries GHOST rows for models still drawn
  but no longer resident, because the rows are the chart's legend and a colour with no row explains nothing.
- **Tracks TILE at width** (auto-fit 300px columns) rather than stretching, and the learned drag floor is
  keyed by width as well as layout — tiling needs less height, and the correction only ever grows.
- **The keep-alive countdown STOPS while the model is working** (`busy` on `/api/ps`, patched server only).
  Ollama rewrites `expires_at` when a request FINISHES, so during a generation the deadline stands still
  while a clock drawn against it keeps running down — on a generation longer than the TTL, past zero, with
  the panel claiming a model should already have been evicted while it is visibly serving. The chip reads
  `in use` instead, dashed with a pause glyph, because a frozen NUMBER reads as a stalled panel rather than
  as a stopped clock. A local in-flight flag would not do: the point is the traffic this browser never
  started. And read `state` before anything else on a ps entry — a `"loading"` one carries its name and
  ZEROS, including a Go zero-time `expires_at` that parses to a deadline in the year 1.

**What a model's VRAM is HOLDING, not just how much (`memory` on `/api/ps`).** `size_vram` alone cannot tell
a big MODEL from a big CONTEXT — lots of weights with a small cache, and modest weights with an enormous one,
are the same number and want opposite responses (a smaller quant vs. less context). A patched Ollama splits
it: `weights` / `kv_cache` / `compute` / `recurrent_state` / `output` / `projector` / `other`, per model AND
per device, in bytes.
- **The parts SUM TO `size_vram` EXACTLY**, to the byte, which is what lets a band be subdivided with no
  remainder slice. `memorySplit` REFUSES a split that does not add up rather than inventing the difference —
  a mismatch is the server's bug to report, and papering over it would hide exactly the thing worth seeing.
- **Absent is not zero.** The object is omitted whenever the server cannot divide the figure (a `loading`
  row, an MLX runner, any build predating it), so check that `memory` is PRESENT rather than that its fields
  are non-zero, and fall back to the total alone.
- **`recurrent_state` is context too.** Hybrid/SSM layers keep a per-sequence state INSTEAD of a KV cache —
  there are literally no keys or values in them — so the FIGURE adds it to the cache (`contextBytes`) while
  the LABEL never calls it one. Not small: 784 MB on a 27b.
- **`projector` is a worst-case reservation** (sized for the largest image the model accepts, not for what is
  held with none loaded), and often the largest non-weights term — 2.32 GB of a 5.46 GB model.
- **`weights_on_disk` sits BESIDE the split, never inside it**: it is not resident memory and including it
  would break the sum. Against `memory.weights` it says what the load cost over the file, in either
  direction. **`memory_host`** is the same shape for what did NOT fit — present only on a spill, which is
  otherwise silent since the model loads, answers and is merely slow.
- **`estimate.breakdown` is NOT a total**: only `weights`/`kv_cache` are populated, it does not sum to
  `estimate.predicted`, and it must never be drawn as a stacked bar. Compared field by field against
  `load.complete` it is genuinely informative — on one 27b load the weights model was within 10% while the
  cache estimate was 4x over, which is the half a single "predicted 26 GB, used 20 GB" cannot name.
- **A SPLIT MODEL DECOMPOSES PER CARD, and NOTHING is ever pro-rated.** `gpus[].memory` sums to that entry's
  own `size_vram`, exactly, so each card's band subdivides with no remainder — pinned against a real capture
  of `qwen3:235b` across two 96 GB cards rather than a fixture, because every synthetic one agrees with
  itself. Weights and KV do track the layer share, so a proportional guess would be nearly right for them —
  but **`compute` is FLAT PER DEVICE**: forced 3:1, one card held 31 layers to the other's 10 and both held
  115 MiB of compute; on the real split the two figures are byte-identical. A chart dividing a whole-model
  `compute` by a layer or byte ratio would be right about two buckets and quietly wrong about the third, more
  so the more lopsided the split. So a multi-card model whose server reported only the whole-model figure
  decomposes into NOTHING, which is the correct outcome and not a gap to fill.
- **A SPLIT IS NOT A SPILL.** `memory_host` is populated only when something is on the HOST, so it is absent
  on a multi-card split (`size_total == size_vram`). The two are different things and the panel treats them
  so.
- **`placement` — AVAILABLE, UNBUILT.** `/api/ps` and `load.complete` can carry which layers went where
  (`{num_layers, devices:[{device, first_layer, last_layer, layers}], swa_layers}`), behind
  `OLLAMA_LAYER_PLACEMENT=1` and absent by default, so treat it as optional exactly like `gpus[].memory`.
  It wants its OWN visual rather than folding into the memory hover, and four things decide how: which card a
  run is on is its `gpu_id` (since 2026-09-13; see the next paragraph), never its position, and a mismatch is
  unknown rather than a guessed mapping; `devices` is a list of RUNS, so `len(devices)` is not the number of cards; **layers are not a
  proxy for memory and must not share a scale** — on an even split one card held MORE layers and LESS weight,
  because the output layer is large and carries no KV; and `swa_layers` is a list rather than a count because
  the pattern is irregular (`gemma2` alternates 1:1, `gemma4:31b` is 50 of 61).
- **THE ARROW KEYS READ THE CHART, on the two axes the data actually has** (`kbFocus` in vram.tsx). The chart
  asks two questions of one pointer — x is WHEN, y is WHAT AM I READING — so changing one disturbs the other,
  and the y targets are a 10px hit stroke or a band three pixels tall. UP/DOWN steps along the LIST (the
  models the panel lists, wrapping through the overview at index 0); LEFT/RIGHT along the DEPTH (summary →
  what that model's memory is holding). That is the tree convention and ARIA's `tree` model, and separating
  the axes is what stops one key meaning "next sibling" at the top level and "descend" once you are on a
  model. Two consequences are load-bearing: **depth PERSISTS across up/down**, so you can step between models
  and stay drilled in (which is the actual task — "what are these two cards each holding"); and **LEFT at
  depth 0 does nothing** rather than wrapping, because a no-op boundary is how a tree says you are at the
  root. The keys answer only while the pointer is on the chart (`crosshair` is set), and `preventDefault` is
  called only when one was used, so the panel never eats scrolling it had no use for. **Esc unwinds one rung
  at a time** — tip, then keyboard focus, then zoom.
- **THE KEYS WORK FROM A HOVER, with no click** (`chartKey`, `chartKeysWanted`, the shell's `relayChartKey`).
  Hovering does not move focus and the browser delivers keys only to the focused document, so with the page
  focused the hint offered `↑↓` and the keys went to the page until you clicked into the panel. While the
  pointer is over a plot (`pointerOnChart`, which unlike `crosshair` does not outlive the pointer), the app posts
  `__mlSidebarApp: "chartKeys"` naming exactly the keys `chartKey` would use; the overlay's shell takes those from
  the page (capture phase, `preventDefault` + `stopImmediatePropagation`) and posts them in as
  `__mlSidebarChartKey`. It never takes focus: focus on hover would blur the page's focused element, closing its
  menus and pulling the caret out of a field because the mouse crossed the panel. A key typed into an editable
  field is never taken. The DevTools panel cannot relay (keys typed in another DevTools pane never reach an
  extension panel), so there the hints say "click, then ↑↓" (`ClickFirst`, from `keysReach`) instead of
  promising keys that go elsewhere.
- **THE SAME KEY STEPS THROUGH WHAT THE VIEW DRAWS.** Overview draws pool LINES, the stacked view draws model
  bands, so `↑↓` cycles pools there (`kbPool`/`stepPool`, its own signal — the two views focus genuinely
  different kinds of thing, and unifying them would be a wrapper over two two-element enums). Leaving the keys
  live in one view and dead in the other was the worse option: the same key then meant "change what I am
  reading" or "scroll the page" depending on where the pointer happened to be. **Nothing else is copied
  over** — a pool has no memory breakdown of its own, so `←→` do nothing there and the hint on that tip offers
  only the pair it can honour.
  **Pool lists are published PER SURFACE** (`notePools(surface, …)`): the overlaid view and a whole-box track both
  draw pools, and the keys step the list of the surface being read. One shared list meant whichever rendered last
  owned the keys, and the whole-box view published none — so ↑↓ there fell through to stepping MODELS (nothing, on
  an idle box) under a tip promising "↑↓ pick a line". The tip says "pick a pool" there.
- **A KEYBOARD FOCUS HOLDS UNTIL THE POINTER MOVES** (`releaseFocus`, called from the plot's `pointermove`
  and nothing else). A band sliding under a parked cursor as samples arrive raises `pointerenter` with nobody
  having touched anything, so honouring that would let an arriving poll overwrite a selection the keys just
  made. The tip is then **anchored to its TRACK** rather than to the cursor: a reader who is not moving the
  mouse does not want an answer that moves, and a split model shows one tip per card, which under one cursor
  would be two tooltips on the same few pixels. They alternate sides when there are several, because a
  drilled-in tip is taller than the ~110px track it belongs to.
- **DRILLED IN, THE AXIS IS SCALED TO THE MODEL — and to the SAME height on every card it is on.** A model is
  often a few percent of a card, so its decomposition draws into three pixels; here the band lifts to the
  baseline and everything else drops away. Scaling each track to its OWN contents would draw a card holding
  1,991 MiB and one holding 878 MiB at the same height — the pro-rating mistake in a different costume, in
  the one view built to show that the cards hold different things. The shared ceiling is computed
  independently and identically by every track from the samples they all share, so there is no cross-track
  state to get out of step. **The header says so** (`full height …`): a chart that changes what its height
  means without announcing it is a confidently wrong picture.
- **A SPLIT MODEL ANSWERS ON EVERY CARD IT IS ON**, each tip decomposing its own, and **both carry the whole
  model's size** — the per-card figure answers "how much of this card" and cannot answer "how big is this
  thing", and 1.94 GiB beside 878 MiB under two identical denominators invites the reader to take either one
  for the model. The whole-model figure is read the SAME WAY THE BAND IS (falling back to the last frame that
  held it): reading it from the hovered sample alone meant the tip drew a band from one instant and looked
  for its size at another, found nothing, and silently printed nothing.
- **`other` IS A SIGNAL, NOT A SLICE.** It is what the server could not name, so a large one means the
  breakdown is behind the engine it is reporting on — the one part whose SIZE is the message. Flagged beside
  the row, and only above 1%, since a rounding crumb is not news.
- **`placement` — BUILT, and still opt-in on the server** (`OLLAMA_LAYER_PLACEMENT=1`, absent by default).
  `placementFrom` parses it; the drilled-in tip draws it as its OWN section with its OWN units, never a bar
  beside the memory ones — layers are not a proxy for memory (on an even split one card held MORE layers and
  LESS weight, because the output layer is large and carries no KV), so drawn on a shared scale the two would
  disagree, correctly, and read as a bug. **Matched by `gpu_id`** (`layersOnCard`): since the server's
  placement naming fix (2026-09-13) each run carries the ollama `gpu_id` that `gpus[]` uses. Before it, `device`
  was the RUNNER's own enumeration, so with GPU0 leased away a model on GPU1 said `CUDA0` and the panel, matching
  by name, drew its layers on the wrong track with nothing to show it. An entry without a `gpu_id` (an older
  build) still matches by name, which is right only while the runner sees every card; a card with no entry shows
  nothing rather than being handed one by position. Real capture: `tests/fixtures/hw/ps-placement-gpu-id-2026-09-13.json`.
  `devices` is a list of RUNS, so entries are summed per card and `devices.length` is never a card count. `swa_layers` is counted for THIS card, since the pattern is irregular.
- **WHAT THE RUNNER IS DOING, AND HOW FULL ITS CACHE IS (`activity` on `/api/ps`).** Read out of
  `llama-server`'s `/slots`, which ollama did not consult until the `activity3` build. `activityFrom` parses
  it, `kvOccupancy` divides it. Two DIFFERENT KINDS of fact live in one object and reading them alike is the
  mistake its shape invites: `prompt_tokens` is `n_past` — OCCUPANCY, which SURVIVES the task that filled it,
  because those tokens really are still in the cache — while `phase`/`decoded`/`prompt_tokens_done` describe
  the task IN FLIGHT and the server clears them the moment it ends. So an idle runner reports a full cache and
  no work, and `phase` is the discriminator for everything else. **Absent is not idle**: the object is omitted
  when the runner could not be asked (still loading, no `/slots`, a failed poll, every older build), and
  `idle` is a positive answer with a figure attached — collapsing them draws a full cache as an empty one on
  every stock server. The occupancy chip sits beside the CONTEXT chip because it is the second half of that
  fact: that chip's tooltip has always advised a smaller `num_ctx` and had no way to know whether the advice
  applied, since Ollama reserves the cache for the whole window at load and the bytes never move — a 256K
  window at 2% and at 90% are identical everywhere else in the panel. `<1%` rather than `0%` for a
  nearly-empty one, because "0%" beside a reserved 40 GiB is the claim the reader is about to act on.
  **`prompt_tokens_cached` is the explanation for a prefill too short to draw** — measured on the box, a
  repeat of the same 4098-token prompt hit 4097 of them, leaving one token to compute, so the phase did not
  last long enough to be sampled at all. An impossibly fast prompt is a cache hit, not a broken clock. The
  phase chip is kept SEPARATE from the keep-alive chip rather than folded into its "in use": they are
  different facts and they disagree exactly where it matters — a request in flight while the slot has not
  started reads `busy: true, phase: idle`.
- **PHASE IS NEVER DRAWN FROM SAMPLES — and now it is drawn from the ENGINE's durations** (`genSpan`,
  `joinGens`). In the real capture (`tests/e2e/fixtures/runner-activity.json`) the event stream delivered ONE
  `prefill` frame and ZERO `decode` frames across two generations that a 40 ms poll resolved completely; our
  cadence is 1–2 s against a ~400 ms prefill, so a boundary inferred from samples would be an invented
  timestamp beside a measured memory trace. The `activity` phase chip stays a STATE for that reason. The SPAN
  comes from `gen.end.timings` instead — `prompt_ms`/`eval_ms` are the executor's own figures — anchored at
  `gen.end` and built BACKWARDS (decode the last `eval_ms`, prefill the `prompt_ms` before it). `gen.start` is
  OLLAMA's stamp, so what lies between it and the prefill is a third phase, `other`, named as neither rather
  than folded into one; a load of the same model that ended inside the generation clips its start, since the
  load is its own span (the real capture has one: granite's `gen.start` lands 1 ms before its own
  `load.complete`). One stretch each — the engine reports one pair per request, so a context-shift re-entry is
  unrecoverable. Keyed PER MODEL: generations interleave across models. **Our own calls arrive twice** with
  the stream carrying — as the session's step block and as the server's span — so `joinGens` joins them. **By
  request id first**: each request carries our `hint.request` (minted in the worker, back on the call's usage as
  `requestId`, on the session event), a patched server echoes it on `gen.end` (`hintFrom` → the span's `hint`),
  and an equal id is a match however the two clocks disagree — two calls of one model ending together cannot
  swap. When BOTH sides carry an id and they differ, it is someone else's call (another tab, another browser),
  however close. Only when either side has none does it fall back to TIMING (same model, ends within
  `GEN_JOIN_TOLERANCE_MS`, nearest first, each once). The session block wins and takes the
  figures, its pre-first-token stretch split `other | prefill` (the channel phases ARE the decode), a
  non-streamed call's `model` phase split `other | prefill | decode`; a split that does not FIT is not drawn.
  Unmatched spans are other clients' traffic and say so — WHOSE and what kind of work when the server echoed a
  hint (`serverGenNote`: Open WebUI's `owui-` task calls, a window.ml session this panel is not showing, or
  another client, with `use` in words). A hint whose session IS one of this panel's (`sessionMap`) is the panel's
  own side task — a session title or a step summary, which are not lane events of their own — and says so; a
  live run caught it being called "a session this panel isn't showing" about the run on screen. A replay is deduped by the END and the figures, never
  the start, which moves when a replay lost its `gen.start`.
- **WHAT EACH CARD WAS DOING: the phase ribbon** (`ribbonSpans`, `PhaseRibbon`). A thin row per model along the
  top of a per-card track, drawing only TIMED phases — the engine's prefill/decode, our own streamed channels
  (which ARE the decode), a prompt-cache swap — in the lane's own fills, so the two read as one legend. So the
  card tracks answer "reading the prompt or generating?" with the lane collapsed. A span goes to the cards the
  nearest sample places its model on (a split model's work shows on each). Empty ribbon claims nothing, idle
  included: an unpatched server times no phases. It follows the lane's kind toggles ("calls" off removes it).
  Rows are per model because two models on one card generate at once (the real capture has four).
- **THE HOST-RAM PROMPT CACHE, AND THE SWAP NO OTHER TIMING CONTAINS** (`GenTimings.swap`, `SwapChips`,
  `RunnerActivity.promptCache`; `ollama-slop:promptcache2`). Two conversations on one model share its single
  slot; when they take turns, llama-server parks the outgoing one's KV cache in host RAM (`--cache-ram`, 8 GiB
  per model by default) and reads the incoming one back — BEFORE the prefill, so it is in no engine timing: a
  turn with a 24 ms prefill took 670 ms, 500 of them swapping. `gen.end.timings.prompt_cache_swap` is the
  engine's own measure, drawn as a `swap` phase between `other` and `prefill` (striped, like a load — it is
  memory being copied, not the model working), on server spans and on joined calls of ours alike. Its tooltip
  row says whether THIS conversation was restored (`restored` is always present; `false` is information — a
  full prefill follows) and warns on `evicted`: a conversation dropped from RAM pays a full prefill next time,
  and when two conversations take turns under a limit too small for both, every turn evicts the one about to
  be needed — the thrash, which reads as that warning turn after turn (real capture: 1.3 s of swap plus a 7 s
  prefill, every turn). `activity.prompt_cache` is the per-model RAM cache (conversations, tokens, bytes,
  limit) — a chip on the model row that turns to the warn colour near its limit. Host RAM, never VRAM; absent
  until the model's first request. A swap is reported only on a one-slot model (the log cannot attribute it
  otherwise). Real captures in `tests/fixtures/hw/prompt-cache-*.ndjson`.
- **WHAT A GENERATION LEFT IN THE KV CACHE** (`kvFill`, `KvFill`, `KvBar`). The cache is reserved in full at
  load and its bytes never move, so its FILL is visible nowhere else. Hovering a span that carries engine
  figures shows it, bottom to top: the prefix REUSED from the cache (dotted), the prompt COMPUTED this turn
  (dense), the tokens DECODED (light), then the reserved remainder. Two surfaces, one legend (the textures are
  shared by class): a bar in the span's TOOLTIP, which works in every preset — Overview's pool lines have no
  cache part, and a one-card box defaults to Overview — and a fill INSIDE the drilled-in cache part on the
  per-card tracks, which the hover drills into (the mode the keys enter, so the scale is shared across cards).
  Hover shows it; double-clicking the span frames the panel on it; nothing zooms on hover. Rules: shares of
  TOKENS against `context_length × slots`, never bytes (sliding-window and recurrent layers do not grow per
  token); a COMPOSITION, not a ramp, since the engine reports counts, not a token timeline; an unreported
  cached count draws ONE hatched `prompt` layer rather than a guessed split; more tokens than the capacity is a
  context SHIFT, scaled to fit and flagged. The capacity comes from the first sample at or after the
  generation's end (`genCtx`, attached in `timeline()` where the history is).
- **A HOLE THE SERVER REPORTS BREAKS THE LINE (`dropped` → `lostSince` → `ResourceSample.gapBefore`).** Every
  frame carries a cumulative count of what this subscriber lost when it fell behind, and nothing read it — so
  under a burst the panel drew a continuous line across frames that never arrived, which is exactly the claim
  `segments()` refuses to make about a sampling gap, and a worse one: frames are dropped when the box is
  busiest, so the interpolation lands on the movement the chart exists to show. Three things about the
  counter decide the arithmetic and each is a way to get it silently wrong. The news is the **DELTA**, not
  the value — read as a value, one hiccup breaks the chart at every subsequent sample forever after, which
  teaches a reader to ignore breaks. It is **PER SUBSCRIBER**, so a `hello` RESETS it rather than reading as a
  recovery, and the seam across the reconnect is covered by the backfill `sinceFor` already asks for. And a
  counter going **BACKWARDS** is a server restart we did not see: claiming a loss there would invent a number
  and draw it as a hole in a specific place. It is resolved in `sw-events.ts` because the counter belongs to
  the CONNECTION and one connection feeds every open panel. `gapBefore` is checked separately from the
  interval because a drop leaves no interval to notice — the readings either side can be adjacent in time.
- **AN EDGE SAYS WHERE IT CAME FROM** (`ResourceEvent.via`). A load or an eviction reaches the lane two ways:
  INFERRED by diffing `/api/ps` (a model was there and then was not — which is the most polling can say, since
  for most of a load there is no runner object at all and an eviction that made room is indistinguishable from
  an idle expiry), or REPORTED by the server's event stream, which knows both. The instant tooltip was
  hardcoded per KIND, so it told you "nothing reports an eviction, so this is the sample where it stopped
  being resident" about an edge the server had just reported WITH ITS REASON — false on precisely the setup
  the stream exists for, and it hid the one thing polling can never recover. A reported edge now says what
  the server said (`serverSaid`, with the model's name stripped off the front, because the name is the line
  above and the width belongs to the reason).
- **"OFF-BOX" IS A CLAIM THAT NEEDS EVIDENCE, and the window is not it.** The label says a model was NEVER
  resident here, and it was decided from the models drawn in the CURRENT window — while the scrub gesture
  WRITES that window (`resWindowS`; the zoom chip is what it reports). So narrowing to 42s pushed a model
  evicted a minute ago out of the ghost list, the lane went on naming it, and its row came back as "never
  resident here" about a model the panel had just watched load and evict. A window is a question about what
  to DRAW; whether something was ever here is answered over the whole history (`everResident`), and anything
  the lane still names that WAS resident gets an "evicted" row rather than falling through to off-box. **And
  "off-box" needs evidence of ELSEWHERE, which only the server's provenance list can give** (`isCloudModel`:
  affirmatively not one of its models, and false while the list is still loading). It was the fall-through
  label for anything not seen resident, so asking for a LOCAL model that was not loaded yet called it off-box
  for the whole stretch between the request going out and the server's `load.start` — then it flipped to
  "loading", then to resident: two corrections of a claim that never should have been made. A local model the
  panel has not seen resident is `not loaded`, so the sequence reads not loaded → loading → resident.
- **SWITCHING A MODEL OFF SWITCHES IT OFF EVERYWHERE THE PANEL DRAWS IT.** The colour dot took it out of the
  stack and the totals and left its LANE blocks standing — most visibly on an off-box model, whose only
  presence IS the lane, so its row offered a control that could not remove the one thing it drew. `timeline()`
  filters on `hiddenModels`, ghost rows get a working dot, and the keyboard's list skips hidden models because
  there is no shape left to point at.
- **A MODEL'S MEMORY IS PIECEWISE-CONSTANT, SO ITS BAND IS A STEP.** A resident model does not drift: the
  runner appears holding its whole footprint, and the KV cache is preallocated for the FULL context window at
  load and never grows (verified on the box — byte-identical before and after 4,217 tokens). A straight line
  between two samples therefore drew a decay that cannot happen, and an eviction drew the worst version of
  it: at the stream's 15 s idle cadence, two samples with the model resident at one end and gone at the
  other became fifteen seconds of memory gently draining away, while the `unload` rule sat at the true
  instant — so the lane and the chart disagreed by up to a whole sample interval and it read as the lane
  being misaligned. Held at its last value and dropped where the next reading says, the descent lands on the
  sample that reported it (2 ms after the edge, in the capture that prompted this) and the two agree without
  either being moved to suit the other. **The DEVICE's own bands stay lines**, and the difference is the
  point rather than an inconsistency: a card's free memory really does fall progressively while weights land
  (the server calls it a continuous progress signal), so stepping it would be the same error pointed the
  other way. A band is stepped when its top is a MODEL's, which is what `identity` already answers for the
  fill. Adjacent bands SHARE an edge, so a floor is drawn with the step-ness of the band BELOW, never its
  own — otherwise the two disagree by a step's height and the stack opens a seam. That also makes a residual
  sitting on models exactly right: its base jumps when a model goes, while its own thickness varies smoothly.
  **Every polygon that draws a model's memory steps — the band, the hover breakdown and the drilled-in parts.**
  It was first applied to the band edges alone, so the band held flat while the parts drawn INSIDE it still
  sloped: a flat band with diagonal lines across it, which reads as the breakdown disagreeing with the total
  it breaks down. One helper (`stepEdge`, taking the y-mapper since the drilled-in view draws against its own
  shared ceiling) serves all three, defined right after `x`/`y` because the drilled-in branch returns early.
  **And so does what BELONGS to a model** (`isStep`: identity, or a tint that is not a `load:`): a runner's
  overhead band is that runner's memory, constant while it lives and gone at the same eviction. Drawn as a line
  on top of the stepped model it sloped from the last sample to the next — a `\` wedge beside the model's `|` at
  every eviction, which snapped square only when a hover subdivided the band. A LOADING runner stays a line: its
  memory really does climb as the weights land.
  **Two rules keep a mixed stack from drawing wedges** (`stepBands`, `bandEdge`). Steps run only in an UNBROKEN
  run from the bottom of the stack: tops are cumulative, so a stepped band stacked on a line (a loading runner,
  climbing) held its top while its floor rose, and the inverted polygon filled as a wedge. And a line band above
  the steps turns THEIR corners and interpolates only its own thickness — interpolating the cumulative top made it
  climb before a model arrived (a pale wedge ahead of each step) and fall under its floor at an eviction. That was
  always the stated rule ("its base jumps, its thickness varies smoothly"); the edge did not implement it until
  `bandEdge`. So a device band turns a corner exactly where the model beneath it steps, and nowhere of its own.
- **THE SNAP MARK CARRIES THE MODEL'S COLOUR.** A model's colour is its identity across the whole panel, and
  a mark sitting ON that band was drawn in the panel's accent — saying "a reading" where every other surface
  says "this model", with nothing to tell several marks apart. It reads from `identity`, the same source
  `bandFill` colours the band from, so the mark and the thing it marks cannot disagree. A boundary with NO
  model keeps the accent rather than taking `bandFill`'s grey: the residual and driver overhead are drawn in
  `--fg-faint`, and a faint grey mark on a faint grey band is one you cannot find.
- **THE PANEL'S OWN SETTINGS LIVE IN THE PANEL** (the track editor behind its gear). How far back the chart
  draws and which palette a model's colour comes from were in Settings, which is a surface you have to LEAVE
  the chart to reach — and the whole argument for putting them there, a paragraph each explaining what they
  do, stops applying the moment the chart is on screen while you change them. Neither is a `MlConfig` flag,
  so the "every user-editable setting also appears in DevTools Settings" rule does not reach them; they are
  storage.local display preferences like the lane's height, and the cursor-snap toggle moved there first.
  **The window picker shows a PREFERENCE, never the live window**: scrubbing writes the window, so bound to
  one quantity the control read "56 seconds (dragged)" — a reading of the moment dressed as a setting, which
  also needed an extra option to render at all, since a value no preset names leaves a select BLANK.
  `RESWIN_PREF_KEY` is where the chart OPENS and `RESWIN_KEY` is where it currently IS; the picker edits the
  first and applies it at once (a preference you cannot see take effect reads as broken, so it clears a
  pinned zoom too), the scrub writes only the second, and a dragged window still survives a reload.
- **A FAULTED GPU IS REPORTED ABSENT, NOT BROKEN** (`unavailable_gpus`, `GpuFaults`). A card whose firmware
  faults vanishes from `supported_gpus` entirely, so `/api/ps` looks normal, `/api/info` returns one healthy
  card and every figure agrees with every other — a two-GPU box with a dead card renders identically to a
  one-GPU box, and one sat faulted for five and a half hours that way. The server lists such cards separately
  in `compute.unavailable_gpus[]`, and the panel draws a MACHINE-level banner, because there is no card to
  badge. Four rules, each a bug found or designed out:
  - **Read it off `hello`, on every connect.** A fault can begin hours before anything subscribes; an
    edge-only signal is silent in exactly that case. `hello` was used purely as a clock anchor before.
  - **A full `/api/info` body is AUTHORITATIVE, and an absent key CLEARS it.** On a healthy box the field is
    absent, not `[]`. A first version kept the last report whenever the key was absent, which left the banner
    up for good after a card RECOVERED. It was written to survive a test whose hello carried a fault its next
    sample did not — a combination the real server cannot produce, since both come from one cached probe. The
    fixture was inconsistent, not the server; the recovery case now has its own assertion.
  - **Never a device, never capacity.** Kept in a separate list rather than folded into `supported_gpus` with
    a state flag, which would make every existing consumer wrong until it learned the flag — failing open on
    broken hardware. It carries no memory fields, so nothing can be summed by accident.
  - **An empty list is not a clean bill of health** ("nothing to report OR could not look"), so it may drive a
    warning and never a reassurance; `not_offered_by_backend` is a HEALTHY card no backend claimed and draws
    nothing. `pci_id` is the identity (two cards share a name); `name`/`uuid` are absent under
    `not_reported_by_driver` and on AMD. AMD's `reset_in_progress` is still a fault but usually TRANSIENT
    (a reset takes seconds), so `gpuFaultNote` says so; drawn like `reset_required` it sends someone to
    power-cycle a machine that is fixing itself. `detail` and `recovery` render verbatim — `detail` is the driver's
    own string and is only useful if it can be searched as shown.
  **It says WHICH card, as an error.** A faulted card has left the enumeration, so it has no CUDA index today,
  and the indices can shift once one drops out — so the banner names it by what its bus address was LAST SEEN
  as ("CUDA1 · … — its label when last seen"): the server's `last_name` when it sends one, else `seenCards`, a
  per-backend record the panel keeps in storage.local because the card is usually already down when the panel
  opens. The banner is in the error tone (`--err`); only an AMD `reset_in_progress`, usually over in seconds,
  stays amber.
- **A CARD'S OWN FACTS ARE ON ITS NAME** (`DeviceFacts`, a hover on the track header). The part that earns the
  space is the TWO TOTALS: ollama places against `total_memory` while the header draws `physical_memory`,
  ~638 MiB apart, and a reader who notices the difference elsewhere has no way to learn it is expected. The
  trigger WRAPS `.rc-name` rather than being it — a `.tt-pop` inside the name element made the label's own
  text "CUDA0" plus three sentences of prose, which every reader of that element then picked up. **Its links
  to every other card** (`DeviceLinks`), one line per PEER, direct fabric first — interconnect is a property of
  a PAIR (consumer NVLink is 2-way, so a four-card box has some NVLinked pairs and some on PCIe), never one
  value for a card. Three non-answers are kept apart and none of them says "PCIe only", which on a bridged
  4x3090 is a confident lie: NOT REPORTED (no `topology` at all), COULD NOT BE MEASURED (`status:
  "unavailable"`, with the driver's own `detail`), and a pair MISSING from a list the server promised was
  complete (a bug on one side). What it still does NOT say: **link speed or width**, which are LIVE readings
  rather than capabilities (an idle Blackwell reads 2.5 GT/s under ASPM while perfectly healthy, and x8-of-x16
  is by design on a board that splits its lanes).
  **Laid out as a grid, not sentences**: a header with what the card IS (the driver's `description`, from a
  patched server — never derived from `name`, which is the backend's enumeration label) and its bus address,
  then label · figure · meaning rows, then one quiet footnote. It was a column of two-weight sentences with the
  figures buried in them. The popup is `wide`, which the floating layer honours with a larger max-width.
- **A CARD'S CEILINGS, AND DECODE AGAINST THE CEILING AT ITS CONTEXT** (`ceilingsOf`, `rooflineFrom`,
  `decodeCeiling`, `CeilingChip`; `ollama-slop:hwceil`). Each `supported_gpus[]` entry carries fixed ceilings
  read once at discovery — memory bandwidth (derived by the server from bus width × clock, checked against
  three memory types), and the PCIe generation and width, where the width is the NARROWER of card and slot (x8
  on gpubox, whose cards each say x16 — a link cannot train wider than its narrower end). The card hover shows
  bandwidth as "the ceiling decode is bound by" and the host link as governing LOAD time only. Each `/api/ps`
  row carries `roofline`: the EMPTY-context decode ceiling, per-device bytes and KV rate, or `{unavailable:
  reason}` (MoE, part on CPU, bandwidth unknown — a reason, so the tooltip can say why). **The measured decode
  rate is compared against the ceiling AT ITS OCCUPANCY, never the empty one**: the cache is read every token,
  and at 38k tokens a 32B model reads 9.9 GB of cache against 19.8 GB of weights — decode fell 30%, and against
  the empty ceiling a box holding a steady 80% reads as collapsing to 53%. `decodeCeiling(r, prompt + decoded/2)`
  = `1 / Σ_d ((bytes_d + occ × kv_d) / bw_d)`, per device — layer split is sequential, so a SUM, never an
  average (identical split-vs-single speeds measured, as that predicts). A device with no KV rate (a
  sliding-window cache) yields NO figure rather than the weights-only overstatement. It reproduces the
  server's own `ceiling_at_occupancy` to 1e-9 off the real capture (`tests/fixtures/hw/`). Over 100% on a dense
  model is said, not clamped.
- **HOW BUSY, NOT HOW FULL: THE ACTIVITY PRESET** (`util.<id>` series, `UtilView`, `kindRefusal`;
  `ollama-slop:util`). `supported_gpus[].utilization` is NVML's `gpu_percent` and `memory_percent` (AMD:
  `gpu_busy_percent` / `mem_busy_percent`), drawn per card in its colour — SOLID GPU, DASHED memory controller,
  the one to watch while decoding. A share of TIME, so it is its own series scope (`"util"`): never in a stack
  (nothing to add up), never on the Whole-box axis (no capacity), and never in one track with memory series in
  ANY mode (`kindRefusal` — a card "90% busy" beside one "90% full" compares nothing), enforced in the editor and
  at restore. Both figures are driver averages over a window the call does not report, so the header says
  "averaged by the driver" and never implies an instant (it cannot show two cards alternating within a token).
  The two figures are INDEPENDENT (the AMD iGPU has no memory counter at all), `0` is idle, and ABSENT is "not
  reported" — a gap in the line, "—" in the legend, never 0 — and not a fault signal either: a dead card and a
  card without the counter answer alike; faults come from `unavailable_gpus`. Offered only where some card
  reports a reading; `BOXES.cuda` (both figures) and `BOXES.amd` (GPU only) carry it for the six-shape guard.
- **THE PREFIX-CACHE HIT ON OUR OWN CALLS** (`TokenUsage.cachedTokens`). OpenAI's standard
  `usage.prompt_tokens_details.cached_tokens` (ollama's own `/v1` route), ollama-native
  `prompt_eval_cached_count`, and the protobuf `End.cached_tokens` — `optional` on the wire, because proto3 has
  no presence and an encoder skips a zero, which would turn every cold prefill into "not reported". `0` is cold,
  absent is unreported, and the two are never collapsed. **OpenWebUI's `/api/chat/completions` drops it** (its
  `convert_ollama_usage_to_openai` built a fixed dict); fixed in `parawanderer/open-webui@72ddabd1e`, deployment
  pending (it needs the OpenWebUI container recreated). The schema pin moved to `parawanderer/ollama@2f5706f`
  for it; the decoder was regenerated, not edited.
- **TOPOLOGY: A PAIR LIST, BUILT AGAINST MOCKS** (`topologyFrom`, `linkBetween`, `bridgeOrder`, `bridgeWalls`,
  `linkPhrase`). The server's shape (agreed with mlbox, `handover-interconnect-topology.md` §4): `status` /
  `detail`, the `gpus` by `pci_id`, and every unordered pair exactly once, an unclassifiable one as `type:
  "unknown"` with a `reason` — so coverage is checkable, and `missing` names any pair a `measured` list omits.
  Keyed on `pci_id`, which `supported_gpus[]` now carries (`DeviceCapacity.pciId`); `gpu_id` is an index into
  one enumeration and can change. Read from `compute.topology` — WHERE it sits is a GUESS until a capture.
  **The NVLink-populated fixtures in `tests/fixtures/boxes.mjs` (`TOPOLOGIES`) are UNVERIFIED against real
  hardware, by agreement**: the box that builds it has no NVLink PHY, so the client was written against the
  design doc, and the first real capture replaces the matching mock — whichever side disagrees is wrong. In
  the Whole-box view: cards are REORDERED so directly-linked pairs sit side by side (a wall between adjacent
  bands is the only place a bridge can be drawn on one axis — bridges 0–2 and 1–3 lay out 0, 2, 1, 3), a wall
  is a hatched BRIDGE only where that exact pair is linked, and fills are never merged (which card is full is
  what decides where the next load goes). **Per-wall honesty is not enough**: on a DGX-1 cube-mesh (each card
  linked to 4 of 7) the ordering finds a chain in which every ADJACENT pair is linked, which would draw exactly
  like an all-to-all NVSwitch box — so `bridgeWalls` checks each RUN of bridged cards as a whole, and a run
  that is not a full mesh is drawn lighter and its unlinked pairs named. The walls open no tooltip (a hover
  target inside the plot stacks a second tip); what each bridge is, in words, is a section of the pool tip,
  said PER RUN of bridged cards — a full mesh of more than two is one line ("all 8 cards, every pair directly linked"; listing its adjacent
  walls read as a chain), and a partial mesh names its unlinked pairs once, not under each of its bridges. AMD's
  fabric is `xgmi` and draws exactly like NVLink (`TOPOLOGIES.amdBridged`, `.xgmi8`, MOCKS).
  Nothing is reordered or bridged unless `status` is `measured`.
- **A THIRD MODE, `total`: THE WHOLE BOX ON ONE AXIS** (`boxAxis`, `BoxView`). Pools DO combine — ollama
  splits a model too big for one card across several and spills the rest into RAM — but not one-for-one:
  each extra card a model spans carries its own compute buffer and driver context, layers do not divide (free
  space smaller than the next layer is stranded), and a RAM spill is far slower. **This text used to say the
  opposite** ("40 GiB free as 20+20 cannot hold a 30 GiB model", "a model can use one pool's room, never the
  sum") while the same panel drew split models; it was wrong everywhere it appeared, the stack refusal's
  tooltip included. So the pools are laid END TO END up the axis rather than merged: each owns a band the
  height of its own capacity and fills it from its own floor, with the WALLS drawn between them. The axis
  total is then a true total, every fill is a real reading against a real ceiling (which card is full is what
  decides where the next load lands), and the boundaries a split pays to cross are visible. It also makes the
  box's SHAPE visible, which the per-pool tracks cannot — they give every pool the same height whatever its
  size. The header says what is HELD and never what is FREE — a free total would overstate the room and count
  slow RAM as VRAM; hiding
  a pool shrinks the axis rather than leaving a hole. Offered only where there is more than one pool, and it
  has its OWN PRESET ("Whole box"). It had none for a while and could be reached only by hand-editing tracks,
  which made Custom carry a whole VIEW rather than what Custom should mean — a preset with something excluded
  or a mode changed. A mode nobody can find is a mode nobody uses. The three presets are three different
  QUESTIONS, not three scopes: how full is each pool (Overview), what is in each (GPU + RAM), what shape is
  this box (Whole box) — the last being the one the per-pool tracks cannot answer, since they give every pool
  the same height whatever its capacity. **It answers a hover like every other view** (`PoolsTip`, the overlaid view's reading): it shipped
  with none, so pointing at the plot or a legend key said nothing one preset away from a view where both did.
  The pool it picks is the band the pointer is INSIDE (`bandOf`), not the overlaid view's nearest line —
  that rule compares the pointer against each pool's own fill SHARE, which means nothing on this axis and
  agrees with the band by coincidence at some heights, which is how a one-probe test passed with the band rule
  removed. Its test probes one height per band.
- **THE STACKING RULE JUDGES THE MODE, not only the series.** `stackRefusal` guarded the series CHECKBOXES —
  it stopped you adding a series that would make an unstackable track — and left the mode select unguarded, so
  a three-pool Overview track could simply be switched to "stack". `TrackView`'s stack branch reads
  `def.series[0]` and ignores the rest, so two series were silently dropped; when that card happened to be
  empty it read as the panel rendering nothing at all. The option is disabled now, with the refusal as its
  tooltip. A SAVED layout carrying one was already refused at restore (`restoreLayout` → `presetRefusal`),
  which is what makes the editor guard sufficient — and is why a renderer-side fallback written for this was
  DEAD CODE and removed: its test passed without it, because that path was doing the work.
- **A TRACK CAN BE DROPPED FROM ITS OWN HEADER** (`HideTrack` → `editLayout`, so the view becomes Custom and
  the layout is remembered). Not offered on the last one — a panel with no tracks is not a layout — but it
  keeps its SPACE, because a header that reflows when a control appears shifts every surface below it. Its
  tooltip has to say that NOTHING IS UNLOADED: the same glyph on a model row is *Evict from VRAM*. **A
  `.tt-pop` only works inside an element carrying the `tt` class** — the floating layer finds triggers by it —
  so without that class the explanation is display:none markup nobody can ever see, which is how this one
  shipped mute.
- **A FRAME THE SERVER COULD NOT SPLIT IS NOT AN EMPTY ONE.** In the drilled-in view, stacking nothing for a
  frame with no `memory` drops the area to ZERO, which says the model was not resident — it was; what is
  unknown is the composition. Those stretches draw at the model's real height, flat and dashed
  (`.rc-part-unsplit`), so the trace stays continuous and only the SUBDIVISION goes missing. A frame with no
  band at all really is zero, and that is the difference the two cases are told apart by.
- **THE SNAP MARK IS DRAWN OVER THE CROSSHAIR, NOT UNDER IT** (`.rc-snapdot` z-index 6 against `.rc-cross`'s
  5). The dot rides ON the line, and its legibility over a band of any shade comes entirely from a 1.5px ring
  of the panel's own colour — so painted underneath, the line cut that ring and the mark read as a rendering
  fault rather than as a reading. Pinned in PIXELS (`the crosshair does not cut the mark's ring`), because no
  DOM assertion can see it: the elements, positions and computed styles are identical either way. The test
  shoots the mark twice, once with the rule's own `background` made transparent, and asserts the ROWS the
  mark occupies carry no difference — the line is interrupted by it. Row counts rather than sampled points,
  since a 7px dot's rendered centre is not exactly where its box says. The bug's signature is worth knowing:
  the FILL rows look untouched (a 55%-opacity accent line over an accent fill is invisible) and only the
  ring rows differ, so the zero-run went 10 → 7.
- **HOVERING A MODEL SUBDIVIDES ITS BAND IN PLACE** (`.rc-part`), rather than opening a second picture of the
  same memory somewhere else — and it is the chart that earns it: weights sit still while the cache steps
  with the context, which is visible over TIME and in no total. The split rides on the `Band` (attached in
  `deviceBands`, where the device is known — a split model's cards hold different things and one average
  describes neither), and is drawn OVER the solid band, so a frame the server could not split shows the band
  it always had instead of the decomposition vanishing or stretching a neighbour's shares across a gap
  nobody measured. Parts are told apart by WEIGHT of the model's own colour, not by hue: four hues inside one
  band would lose the identity the band exists to carry.

**The event lane (§4.5 of the spec).** Under the tracks, on the SAME segmented axis: what happened, against
what memory was doing while it did. Nothing new is collected — `src/sidebar/model-stats.ts` derives it from what
sessions already record. `usageByModel` is the per-model ledger (attributed to the model that RAN, with
delegated sub-calls charged to the READER); `eventsFrom` builds the timeline.
- **Spans run BACKWARDS from when a call finished** — the timestamp we hold is the end — else every bar sits
  one generation to the right of the memory movement it caused, which defeats the shared axis.
- **A tool step is ONE block with PHASES**: the model generating the call, the PLUMBING between (parsing it,
  validating the args, the hop to the page — `dispatchMs`, measured in the loop like the others rather than
  inferred), the human at the approval gate, the tool running. Dispatch is counted in the block's extent and
  not merely labelled, because the start is RECONSTRUCTED by subtracting the parts we know about: an
  unmeasured part shifts the whole block later than the work happened, which on an axis shared with the
  memory trace draws a block after the movement it caused. `toolMs` and `approveMs` are measured separately in `agent-loop.ts` for exactly that
  reason — a human deciding is the step's wall time but not the machine's work, and the wait draws as a
  hollow neutral so a wide bar can never read as work.
- **A generation is SPLIT by what the model was emitting** — `think` / `call` / `answer` phases inside the
  model's own stretch, beside `wait` and `tool`. Observable in exactly one place: `handleLine` in
  `streamAgentTurn` (sw-llm.ts), where the parsed chunk still says which channel each SSE line arrived on;
  everything downstream sees only the accumulated strings. So the marks are stamped THERE, in the service
  worker — the executor, per the same rule as the output gutter — appended only on a CHANGE, and carried as
  `TokenUsage.genPhases` (offsets from the call's start, so they line up with `genMs` instead of drifting
  against it). They are a SEQUENCE, not three buckets: a model that resumes reasoning after emitting
  tool-call fragments is ordinary, and bucketing collapses the re-entry into a block that never happened.
  **Streamed calls only** — a non-streamed response is one object with one `eval_duration`, so we know the
  composition of the text but not when the boundary fell, and splitting it by length would be inventing a
  timestamp. That case stays one `model` phase, which is also what the stretch before the first token is
  (prompt eval, queue, network — the model's time but none of its channels).
- **A turn's usage rides the model's OWN record**, not the tool call it decided on: the loop emits the prose
  and usage as one event and the call as another sharing its `step`, and only the second has a `seq`. So a
  composite block's model half is a CROSS-RECORD lookup — reading `st.usage` on the tool record finds
  nothing, which is what shipped, invisibly, because `resource-demo.mjs` fabricated both on one record and
  drew a shape the product never emits. Folded only when the turn made exactly one call; parallel calls
  share one generation and charging it to each draws the same seconds twice.
- **Work IN FLIGHT is drawn while it happens.** `eventsFrom(sessions, now)` synthesizes OPEN spans
  (`event.open`, `until` = where it had reached): a generation underway, a tool running, a person at an
  approval gate. Without a `now` you get finished work only, which is what a durable document takes. A
  generation had no stamp at all before this — the pending step START fires when a TOOL is about to run,
  i.e. AFTER the generation, and a turn emitting nothing but a tool call produces no stream deltas either —
  so the loop emits **`agent-turn`** the instant the request goes out, and again on each phase change; the
  reducer holds it as the transient `Session.liveTurn`, cleared when the step lands and ignored for an
  already-ended session so a replayed event cannot strand a live bar. The export carries open events only
  on request (`ExportProvenance.includeInFlight`), as `open: true` + `elapsedMs` and no `endedAt`.
- **`load_duration`** (captured as `TokenUsage.loadMs`) is the only place the difference between "the model
  was slow" and "the model wasn't there yet" exists. Drawn as its own span in front of the block, floored at
  a second so a resident model's few ms of bookkeeping doesn't fill the lane.
- **Sub-calls are drawn under the step that spawned them** (`bus.ts` keeps each one's ts/duration beside the
  totals), and events carry a lineage (`id`/`parent`); hovering one lights its chain and dims the rest.
  Ancestors go all the way up; descendants come only from the hovered event, or one sub-call lights every
  sibling step.
- **The axis is LINEAR IN TIME within each run of samples; only GAPS collapse** (`runWeight`, `runFrac`). A
  run is as wide as it is long and a time sits linearly across it, and EVERY mapping between the screen and
  time goes through those two — the bands, the lines, the cache fill, event placement, the crosshair, the snap
  and the selection — so none can disagree. It used to space samples EVENLY (sample i at i/(n-1), runs
  weighted by sample count). Harmless under a fixed 2 s poll; under the stream's adaptive cadence (250 ms
  during a load, 1 s working, 15 s idle) busy stretches stretched and idle ones shrank, scrolling changed the
  mix of samples in view and so the warp — the chart "compressing at random" — and events, which `placeEvents`
  placed linearly while the bands were drawn by index, landed at the right TIME and the wrong PLACE (an unload
  ruled over a band still resident). A gap still breaks the line and takes no width, because nothing was
  measured there. An event is placed inside the run that CONTAINS it, one in a gap is dropped, and the window
  admits a poll's grace past the last sample — without it the newest events were the only ones never shown.
  **A TIME GRID shows it** (gear → Grid → "time grid", off by default, `timeGrid`): faint vertical lines at a
  round LOCAL-clock interval (`gridStep` picks the smallest that keeps them 48 px apart at a track's 300 px
  minimum; `gridTimes` places them inside each run), the same on every track, the interval captioned in each
  plot's corner. Vertical only — memory gridlines would mean a different amount on every card.
  **A BREAK SAYS WHAT IT CUT OUT** (`runGap`, `GapMark`, `GapTip`). Collapsed to 3px, a missing minute and a
  missing ten hours looked the same. Each break is a 3px flex item where the plot's `gap: 3px` used to be (so
  nothing moved, and the lane's own 3px gap still lines up), with a wider hit area like a ruled instant's.
  Hovering it says how long, from when to when, and why: nothing sampled (the panel was closed, or the box did
  not answer) or frames the server reported dropping (`gapBefore`, drawn dashed in the warning colour). A lone
  reading inside the stretch, too few to draw, is counted rather than the stretch called empty. While a break is
  hovered the plot's reading, crosshair and snap mark stand down (`gapHover`, the same owner rule as
  `eventHover`), and the same break lights in every track. The scrub strip, linear in clock time, hatches the
  hole at its true width (`.rc-scrub-gap`) and lets a drag pass straight through it.
- **Instants rule through the plot** (dashed — a solid line reads as part of the chart), and one eviction is
  drawn in every track, so hovering it anywhere thickens it everywhere. **So do a load's two internal edges**
  (`loadEdges`): weights loaded, then KV cache and compute buffers allocated (ready to serve), each with the
  bytes that half moved — they are exactly the two steps a load draws in the device trace, and with the lane
  collapsed that ramp otherwise had nothing on the plot saying what either step was. Only for a load whose
  boundary the server reported; an inferred load has no boundary, and a rule is a claim about when.
- **A ROW is a claim that two bars OVERLAP**, so the lane spends one only when they do. Bars are packed at
  their DRAWN width (a very short event is widened to stay visible, so packing has to reserve the same
  width), with a hair of separation reserved after each — but that separation is dropped rather than
  costing a row, because a bar pushed below the bar it merely ABUTS asserts an overlap that is not there.
  Not an edge case: a model `load` ends exactly where the step it precedes begins, so every load was drawn
  under its own step. A `run` is the container the rest sit inside and the widest bar on screen, so it is
  drawn as a CHECKERBOARD rather than a solid fill (built from its own `--model`, so it keeps the identity
  the lane reads by) — solid, it read as the heaviest work in the lane rather than the thing holding it.
- **Double-clicking any block scopes the panel to it** (`scopeToSpan`, pure/tested), widening a block too
  short to frame around its own centre — a 40ms window contains no samples and draws as an empty plot. An
  open block has no end, so `now` stands in. A single click still navigates to the step: framing the time
  around a step and going to read it are the same intent from two sides.
- **The lane and the model list each hide** (Settings live in the panel's own track editor, beside which
  tracks it draws — the same question). Both compete with the chart for whatever height the panel was
  dragged to, and which of the three you want depends on what you are doing.
- **ONE set of event-kind toggles, obeyed everywhere** (`LANE_KINDS`, `toggleLaneKind`): the lane's bars, the
  scrub strip's ticks and the rules ruled through the plots all read `laneHidden`, switched from the lane's
  chip row OR the chart's gear (the lane is collapsed by default, which left the chart's lines with no control).
  Unticking "loads" removes the load bars and the load-step rules together. Deliberately not a second,
  chart-only set: that would let one surface show what another has hidden.
- **A load ATTEMPT is not the request.** The server ends a `load.failed` reason with `; retrying` when it
  evicted something or shrank the context and is trying again, and the next attempt brings its own
  `load.start` — so one request reads start → failed → start → complete. It is labelled "load attempt failed,
  retrying", never "failed to load", or the lane reports a failure for a load that went on to succeed. Since
  `ollama-slop:loadguard` every `load.start` is followed by exactly one `load.complete` or `load.failed`; before
  it, an abandoned load (the requesting client disconnected — ollama ABANDONS a load then, it does not finish
  it) left a `state: "loading"` row on `/api/ps` forever.
- **A reconnect must not draw the lane twice.** `sinceFor(null, …)` asks for the FULL retained ring whenever
  the worker is fresh — which an MV3 respawn guarantees — so every span in that window arrives a second time.
  Caught on a real box, where four serving periods read as `serving 8` and two loads as three (one load's
  opening edge fell outside the replayed window, so only its duplicate closed). `addMachineEvent` dedupes on
  kind + model + when, with a TOLERANCE: each connection anchors on its own hello, so the same edge lands
  within the jitter between two hellos rather than on the same millisecond. Pinned against the real capture
  in `tests/fixtures/real-edges.mjs`.
- **`ml.__events({ download: true })` dumps what the panel derives its timeline FROM** — this tab's
  `__mlDebug` stream, the server's event frames with the wall clock each resolved to, the current `ps`/`info`
  and the stream's status. For a lane doing something that makes no sense: the drawn events are derived by
  pure functions, so the inputs let the exact picture be rebuilt and turned into a test, where a screenshot
  can only be described. Two capture rules: the resource panel must be OPEN (nothing subscribes to the stream
  when nobody is looking, so `frames` would be empty), and the `debug` ring holds everything only in
  `debugMode: "devtools"`. Underscored because it is a debugging aid, not API.
- **The event LANE is collapsed by default**, and its chip row is the control. The lane is CONTENT (what
  happened); the scrub strip above it is NAVIGATION (where you are), so only this half folds — which also
  stops the panel jumping in height the first time anything runs. Collapsed, the whole chip row opens it (the
  chips already say what you would get, which promises more than a bare chevron, and none of their own
  meanings apply to a lane that is not drawn); open, the chevron closes it and the chips filter again. Tests
  that are about what the lane DRAWS seed `ml_res_sections: { lane: true }` rather than relying on the
  default — which is pinned by its own test.
- **The panel HEADER holds its height.** It gains and loses controls as you use the panel — the zoom chip
  arrives when you scrub, the view picker only once capacity is known — and a row that reflows when one
  appears shifts every surface below it, the scrub strip included. Adding one control to that row made the
  chip's arrival push the strip 12px down mid-drag, so every later drag landed above the track and did
  nothing at all, which reads as the scrubber being broken rather than as the row growing. It never wraps,
  carries a `min-height`, and the total gives up width first (it is the longest item and still legible at
  half length).
- **ONE switch decides what the panel is about** (`ScopeSwitch`, in the panel header): `session` or `full`.
  It drives the time window (`sessionWindow` — the session's own stretch, floored so a short run is not a
  slit), which model rows are listed, and which events the lane draws. These were three separate controls
  and they disagreed: a qwen session's lane drew gemma loading and evicting, above a list of gemma models,
  on a chart showing ten minutes of a shared box either side of the run. Scoping a machine event asks
  whether the model is one the session RAN, since such an event has no session of its own; the model list
  FOLDS the rest into a count rather than hiding them, because what else is resident is exactly the context
  for why your model got evicted. As a chip in the lane's filter row it read as one more kind-filter beside
  "loads 4", which is why it moved. **A memo over the lane's events must key on `events.length`, never on
  `events`** — `timeline()` rebuilds that array every render, so keying on it recomputes per render rather
  than per poll, and a window that closes over `Date.now()` then walks its right edge ahead of the last
  sample between a render and the drag that reads it, silently emptying the scrub strip.
- **A wheel over the panel scrolls the transcript underneath it** (`wheelThroughPanel` in `app.tsx`). The
  panel is a fixed-height sibling of the scroll container rather than content inside it, so the gesture used
  to do nothing at all; it is forwarded only when the panel cannot take the scroll itself, and `deltaMode`
  is honoured because a wheel reports LINES, not pixels.  A wheel over the CHART means something more specific and claims the
  gesture first (`scrubNudge`): the plot is a viewport onto a timeline, so scrolling it scrolls the window
  along the session, by a fraction of the window's OWN width so one notch travels the same visible distance
  at any zoom. It only fires when there IS a window to move, and signals that by calling `preventDefault` —
  which is what `wheelThroughPanel` then checks, so a gesture the chart declined still scrolls the page.
- **WHERE you grab the scrub window decides what the drag does** (`scrubZone` → `scrubResize`/`scrubTo`, all
  pure/tested): the edges resize, the middle pans. Recentring on the cursor wherever it landed is what made
  a narrowed window impossible to widen again, since every grab was a pan including a grab on a handle. The
  handle is a constant PIXEL size converted to a fraction of the track, capped at a third of the window so a
  very narrow one is not all handle; a resize reads from the window captured AT the grab, so the fixed edge
  does not drift as each move rewrites the range it is measured from.
- **A person at the approval gate is STRIPED, like a model load** — it is the step's wall time but none of
  the machine's work, and flat, a wide block reads as a lot of work having happened. Drawn as an overlay
  element over the flat neutral (`phaseSpans` → `.rc-ev-wait`) rather than into the phase gradient, because
  a gradient stop takes a colour and a stripe is a pattern.
- **Cursor tooltips share `useTipPlacement`** and are placed against the VIEWPORT from their own MEASURED
  size: they flip when they do not FIT (not at an arbitrary fraction of the width), never sit under the
  pointer, and only the surface the pointer is on renders one. Pinned by `tests/e2e/tooltips.spec.mjs`, which
  sweeps positions in a narrow and a wide panel rather than probing one point.


**An ASIDE on the lane — a model call YOU triggered while reading.** The code annotator and the on-demand
summary spend tokens on this box and take visible time, so hiding them from the timeline would be dishonest;
they are also not the agent's work, and charging them to the run would make two runs incomparable on the
strength of how much someone poked at one. So: its own `aside` kind, drawn OUTLINED rather than filled,
carrying **no `cost` and no `parent`** — which is how "not part of the run" is enforced rather than
remembered (hovering a step cannot light it, and it cannot enter `usageByModel`). It keeps a `ref`, so
clicking still goes to the step you asked about, and its tooltip says outright that you triggered it. Stored
in `store.ts` `asides` (a Map by hash, session-scoped and in memory only — it describes this READING session,
not the run's record) and merged in at the `eventsFrom` call site rather than written into the session the
debug reducer builds. Its tooltip is the ONE place a span names its model, because an aside runs on the
UTILITY model while every other span runs on the session's own — which the panel already says in three
places. `tests/e2e/aside-lane.spec.mjs` covers the seam neither unit test can: the merge, and the class the
lane paints. It also has to SEED A BOX (`setCapacity`/`setResident`) — with no samples the panel draws no
tracks and no lane, and a lane that was never drawn cannot be missing a bar, so the first version of that
test would have passed the day the feature broke.
