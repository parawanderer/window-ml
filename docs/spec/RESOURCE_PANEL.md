# Resource panel (VRAM / RAM) — spec

Replaces the sidebar's VRAM sparkline with a configurable, developer-grade resource view: several
metrics, several ways to combine them, session-long history you can scrub, per-model attribution,
and events drawn onto the time axis.

**Status: built, and past what this document originally planned.** §5's build order shipped in
order; §4.7–4.9 are the parts it did not anticipate — the keyboard reading model, the per-model
memory breakdown, and which instant a figure describes. Where this document and the code disagree,
the code is right and this is a bug in the document.

**What this document is for**, now that it is not a plan: the CAPTURES (§2, real readings from a
CUDA box and a Metal Mac, several of them counter-intuitive) and the REFUSALS — the places the panel
declines to draw something, each with the measurement that forced it. Implementation detail lives in
AGENTS.md and should not be copied here.

Backend prerequisites, the endpoint shapes, and the server-side caveats live in
`tmp/vram-gauge-handover.md`. Read the handover's "Caveats" section first — three of them will
otherwise produce a confidently wrong display.

## 1. Why the current one is not enough

`VramPanel()` (`sidebar/vram.tsx`) draws a 240x34 sparkline of *total* VRAM with no axis, no
ceiling, and no per-model breakdown, over 45 samples at 2s (90 seconds), in component state that
is wiped every time the panel closes. It already collects per-model snapshots and then sums them
away — its own comment says that array is what a v2 would build on.

Four things are missing:

1. **A denominator.** "18 GB in use" without "of 102" answers nothing.
2. **Attribution.** Which model, and on which card.
3. **History.** Ninety seconds, lost on close, is not enough to answer "what happened during that
   run".
4. **Configurability.** This is a devtools surface. Which series are shown, and whether they are
   bundled or separated, should be the user's choice.

## 2. Data the panel needs

Two endpoints, both reachable through the normal OpenWebUI passthrough
(`findOllamaBase()` in `sw-llm.ts` already derives the base — reuse it, do not hardcode):

- `GET {base}/api/info` — capacity: per-device totals and free, system RAM. Slow-moving.
- `GET {base}/api/ps` — residency: which models are loaded, how much each holds, on which devices.

### 2.1 Captured samples — CUDA (gpubox, 2x RTX PRO 6000, live)

Idle, nothing of ours resident:

```json
{
  "compute": {
    "system_compute": { "cpu_cores": 32, "total_memory": 130142785536,
                        "free_memory": 12330946560, "free_swap": 3330347008 },
    "supported_gpus": [
      { "gpu_id": "0", "name": "CUDA0", "total_memory": 101972967424,
        "free_memory": 101386813440, "compute": "12.0", "driver": "13.2", "runner": "CUDA" },
      { "gpu_id": "1", "name": "CUDA1", "total_memory": 101972967424,
        "free_memory": 101386813440, "compute": "12.0", "driver": "13.2", "runner": "CUDA" }
    ]
  },
  "models": { "count": 32, "filesystem_used": 1057594659641, "running": 0, "vram_used": 0 }
}
```

Note ~0.59 GB per card is in use with nothing loaded, and `/api/ps` returns `{"models":[]}`.

A few minutes earlier the same box reported `free_memory: 18196987904` on card 0 — 18.2 GB in use
— still with `models.running: 0`. **That is caveat 3 in the wild, and it is the single strongest
argument for the three-band decomposition below**: a panel that showed "18 of 102 GB" would have
been reporting memory that no model of ours held, with no way for the reader to tell.

### 2.2 Captured samples — Metal (16 GB Mac, live)

`/api/info` — one device, `compute`/`driver` absent as predicted, `free_swap: 0`:

```json
{
  "models": { "store": "/Users/sb/.ollama/models", "count": 2,
              "filesystem_used": 1766784634, "running": 0, "vram_used": 0 },
  "compute": {
    "system_compute": { "cpu_cores": 10, "total_memory": 17179869184,
                        "free_memory": 3682385920, "free_swap": 0 },
    "supported_gpus": [
      { "gpu_id": "0", "name": "MTL0", "total_memory": 12712935424,
        "free_memory": 12711886848, "runner": "Metal" }
    ]
  }
}
```

`/api/ps`, GPU-resident — Metal **does** report `gpus[]`, and `size == size_vram`:

```json
{ "name": "qwen3:0.6b", "size": 1039086387, "size_vram": 1039086387,
  "context_length": 4096, "expires_at": "2026-09-02T16:32:54.167053+02:00",
  "gpus": [ { "gpu_id": "0", "runner": "Metal", "size_vram": 1039086387 } ] }
```

`/api/ps`, forced to the CPU with `options: {"num_gpu": 0}` — `gpus` absent entirely:

```json
{ "name": "qwen3:0.6b", "size": 1018523810, "size_vram": 0, "context_length": 4096 }
```

Confirmed, and now fixtures in `tests/resource-model.test.mjs`:

| Question | Answer |
| --- | --- |
| Metal's `runner` literal | `"Metal"` — matched positively now, not as "not discrete" |
| Device label | `"MTL0"` (not "Metal") — that is what a track header shows |
| `compute` / `driver` | Absent, as the handover predicted |
| Working set vs system | 12.71 GB of 17.18 GB — a ~74% soft ceiling inside the hard one |
| `gpus[]` on Metal | Present, `gpu_id: "0"` — per-device attribution works |
| CPU-forced | `gpus` absent, not empty — the "absence means CPU" contract holds |
| `free_swap` | `0` on macOS — unknown, not "no swap" |

**ROCm is assumed to match CUDA** (discrete, `runner: "ROCm"`), untested. It sits in
`DISCRETE_RUNNERS` on that assumption; if it ever behaves like unified memory, that set is the one
line to change.

#### 2.2.1 What these samples changed

Two corrections the capture forced, both now covered by tests:

1. **A unified device's own `free_memory` is blind to the rest of the machine.** The Mac reported
   12.711 of 12.713 GB device-free while the *system* was 13.5 GB deep in the same silicon. So
   occupancy on a unified box must come from `system_compute`, not from the device. Reading the
   device would have drawn a nearly-empty machine as nearly empty while it was nearly full.
2. **A GPU-resident model on Metal has `size == size_vram`, so its `ramBytes` is 0.** Attributing
   only the spill — correct on a discrete box, where the GPU half lives in another pool — would have
   attributed *nothing* and left a plainly-resident model invisible. On unified memory the whole
   footprint is attributed to the one pool.

Together these mean `deviceBands()` for a unified device delegates to the host decomposition, and
`seriesCatalog()` emits a single `mem` series rather than a device/host pair — one pool gets one
ceiling, so the UI can't offer the double-count that `stackRefusal` would then have to block.

### 2.3 Samples still wanted

Also worth capturing on either box when convenient, because neither is represented in any sample
yet and both drive real UI:

- `/api/ps` with **two or more models resident** — per-model stacking is a headline feature and has
  never been seen against real data.
- `/api/ps` for a model placed on **card 1 only** — the handover's caveat 2 says it reports
  `size_vram: 0` per device under a correct total. The panel renders that as an explicit
  "placement unknown" band, and the exact shape should be pinned before that path is trusted.

## 2.4 Units: everything is binary, always labelled

**Every memory figure these endpoints return is raw bytes, and every one of them is BINARY.** Render
with 1024, label `GiB`/`MiB`, and never emit a bare number.

```
101,972,967,424 bytes  / 1024^3 =  94.97 GiB   <- correct
                       / 1000^3 = 101.97 GB    <- wrong for this quantity
```

That second line is what a card sold as "96GB" looks like divided by the wrong power. It reads as a
plausible number rather than an obvious error, which is exactly what makes it dangerous.

GPU and system memory are sold and reported in binary units while spelled "GB", and the whole
toolchain around this box agrees: `nvidia-smi` reports MiB, llama.cpp logs MiB, ollama's scheduler
logs GiB. Rendering decimal would make this panel the only component disagreeing with every other —
by 7.4%, large enough to look like a real discrepancy and small enough to be believed.

**Do not mix rulers on one screen.** `ollama list` prints model file sizes with a *decimal*
formatter while everything about memory uses a binary one. Both are correctly labelled at their
source and they are still a trap:

| Shown | Bytes | In GiB |
| --- | --- | --- |
| `ollama list` → 111 GB | 119,057,326,592 | 110.9 GiB |
| `/api/info` total → a card | 101,972,967,424 | 94.97 GiB |

A reader comparing "111 GB model" with "94.97 GiB card" concludes it cannot fit. It does fit, at
76.8 GiB, because ~26.8 GiB of that file is a per-layer embedding table that never reaches VRAM. So
**normalise everything on a screen to GiB, model file sizes included**, even though `ollama list`
shows GB for those. Consistency within a comparison beats matching each source's own convention,
because users subtract adjacent numbers.

Implementation: keep **bytes internally** (every derivation in `resource-model.ts` does) and convert
once at the render boundary through `formatBytes` — one formatter, one place, never a hand-rolled
`/1e9` at a call site. Two decimals below 100, one above (`94.97 GiB`, `110.9 GiB`): VRAM decisions
turn on hundreds of MiB, so a whole-number render hides the margin that matters.

## 2.5 Which number means what

Per entry in `compute.supported_gpus`:

| Field | Meaning |
| --- | --- |
| `total_memory` | what the driver reports for the card, already minus its own reserve |
| `free_memory` | what is currently unallocated |

### Three different totals, all correct

```
1  96.00 GiB   nominal / marketing        no API reports this
2  95.59 GiB   driver framebuffer total   nvidia-smi, NVML     (417 MiB below nominal)
3  94.97 GiB   cuDeviceTotalMem           ollama total_memory  (638 MiB below driver)
```

Tier 1 is a spec-sheet figure and cannot be queried from anything. The 417 MiB below it is board
firmware reservation that is never addressable; the further 638 MiB is the CUDA driver's own
reservation. **None of that gap is memory occupied by another process** — other processes appear in
`free_memory`, which tracks them correctly, so never present the gap as an error.

Which to display:

- **"Total VRAM on the machine" → tier 2**, the driver framebuffer total. This is the devtools-facing
  number: it is what `nvidia-smi` shows, so a panel using it agrees with everything else on the user's
  machine rather than appearing to lose a gigabyte.
- **"Will this model fit" → tier 3** (`total_memory`), or more precisely `total_memory` minus ollama's
  minimum reserve (94.4 GiB here). This is what placement is actually decided against.

Tier 2 is **not in the API yet** — a follow-up PR adds `physical_memory` alongside `total_memory`.
`parseInfo` already reads it when present, and `ceilingsFor` returns `displayBytes` plus
`displayIsFit`, so until it lands the panel shows `total_memory` and labels it honestly. **Never
synthesise 96 GiB by rounding** — that breaks on any card with ECC enabled or a non-round config.

### Do not compute "used by other processes" naively

The obvious formula does not return zero on an idle card:

```
capacity - free - sum(ollama models)
GPU0 (model loaded)   94.97 - 81.10 - 11.97 = +1.90 GiB
GPU1 (nothing loaded) 94.97 - 94.42 -  0.00 = +0.55 GiB   <- no third party involved
```

The floor is ollama's own discovery context, held on every visible card whether or not anything is
loaded; the rest is a loaded model's CUDA overhead that no buffer line reports. So the residual band
is named by MAGNITUDE (`DRIVER_OVERHEAD_FLOOR`, ~1 GiB): below it, "driver overhead"; above it,
"unattributed". Without that, every idle card displays phantom third-party usage.

### The unattributed band is not "other processes"

`size_vram` is llama-server's own buffer accounting, not the driver's. The driver consistently
reports **0.7-1.8 GiB more per model**, roughly constant regardless of model size: the CUDA context,
which no buffer line reports. So "model is using X" and "card has Y free" will never reconcile to
the card total, and the residual is that context.

This is why the middle band is labelled **unattributed**, not "other processes" — a large part of it
is our OWN models' overhead, and a reader told it is other processes will go hunting for a process
that does not exist. Not worth trying to correct; worth a tooltip (`OTHER_BAND_NOTE`).

From `/api/ps`, `size_vram` is the total and `gpus[].size_vram` the per-device split. These sum
exactly on the current build (verified across 13 models), so a disagreement in the UI is a real bug,
not a rounding artifact.

## 3. Data model

`resource-model.ts` (root, pure — no DOM, no chrome, no preact, like `timestamps.ts` and
`locate.ts`). The chart is a function of this; every derivation is unit-testable with no mounting.

```
parseInfo(raw)            -> Capacity | null      null = capacity unknown (stock Ollama 404s → SPA HTML)
residencyFrom(psEntry)    -> ModelResidency       bytes, not the rounded GB LoadedModel carries
ResourceSample            = { t, models[], capacity }

deviceBands(sample, id)   -> Band[]               the three-band split, below (unified → hostBands)
hostBands(sample)         -> Band[]               attributes the FULL footprint when unified
ceilingsFor(sample, id)   -> Ceilings | null      hard limit + the soft working-set line (unified only)
seriesCatalog(sample)     -> SeriesDef[]          generated from the devices the box reports
stackRefusal(defs, cap)   -> string | null        why these series may not share a stacked axis
presetsFor(sample)        -> Preset[]             starting layouts, chosen by device count
segments(samples, gapMs)  -> ResourceSample[][]   history split at holes; never interpolated
eventsIn(events, a, b)    -> ResourceEvent[]
```

### 3.1 Three bands, never two

A device decomposes into **attributed / unattributed / free**:

- **attributed** — one band per model, from `/api/ps` `gpus[].size_vram`
- **unattributed** — `(total - free) - attributed`: mostly our own models' CUDA contexts (§2.5), plus anything genuinely foreign. NOT "other processes"
- **free** — `free_memory`

Plus an **unknown** band when a model's total is non-zero but its per-device share reports 0
(caveat 2). Unknown is never folded into "other" and never treated as zero.

### 3.2 Unified vs discrete

`runner` decides. `CUDA`/`ROCm` are separate pools: device and host totals are independent, real
numbers, and a track combining them is meaningful. Anything else (Metal today) is one physical
pool where the device total is a *recommended working set* overlapping system RAM.

The conservative default for an unrecognised runner is **unified**, because the failure mode of
guessing "discrete" is a summed number that is simply wrong, while guessing "unified" only declines
to add two figures.

### 3.3 Stacking is a claim, and it is checked

Stacking asserts the parts sum to a meaningful whole. `stackRefusal()` refuses the two cases where
that is false, with a reason the UI shows:

- **Two cards in one stack** — a model can only use one card's capacity, so their sum is not a
  quantity anything is measured against.
- **Device + host on unified memory** — the two totals describe the same silicon; stacking
  double-counts.

`overlay` makes no claim about a total, so it is always allowed. Configurable, but not configurable
into lying.

**The rule judges the MODE, not only the series.** It first guarded the series checkboxes — you could
not ADD a series that broke a stack — and left the mode select alone, so a three-pool track could
simply be switched to `stack`. The renderer reads `def.series[0]` and ignores the rest, so two series
were dropped in silence; on a card that happened to be empty that reads as the panel rendering
nothing at all. The option is disabled now, with the refusal as its tooltip. A SAVED layout carrying
one is refused at restore (`restoreLayout` → `presetRefusal`), which is what makes the editor guard
sufficient — and is why a renderer-side fallback written for it was dead code and removed.

**`total` is the honest version of the thing `stack` refuses.** The question behind "add up my box"
is real. Pools do combine — ollama splits a model across cards and spills the rest into RAM — but not
one-for-one: each extra card a model spans carries its own compute buffer and driver context, layers
do not divide, and a RAM spill is far slower. So it only misleads when the pools are MERGED into one.
`boxAxis()` lays them END TO END up one axis — each owns a band the height of its own capacity and
fills it from its own floor, with the walls drawn between them. The axis total is then a true total of
capacity, every fill is a real reading against a real ceiling, and the boundaries a split pays to
cross are visible rather than something the reader has to know. It also
shows the box's SHAPE, which a track per pool cannot: those give every pool the same height whatever
its size, so a 12 GiB card and a 96 GiB one look alike.

```
320 ┤                                    ← the whole box
    │  ░░░░░░░░░░░░░░  System RAM 21/128
192 ┼───────────────────────────────────  ← wall: nothing crosses it
    │  ▓▓  CUDA1 7/96
 96 ┼───────────────────────────────────  ← wall
    │  ██████  CUDA0 18/96
  0 ┴───────────────────────────────────
```

The header says what is **held** and never what is **free**: those bytes are genuinely held, so the
figure is true, while the space above a fill belongs to that pool alone. Hiding a pool shrinks the
axis rather than leaving a hole, which is what makes "just my two cards" a view instead of arithmetic
the reader has to do.

### 3.4 History has holes

`pollPs()` is gated on the sidebar being open, by design. So the sample series is discontinuous,
and `segments()` breaks the line at any gap over `MAX_SAMPLE_GAP_MS` rather than drawing across it.
An interpolated segment over a ten-minute hole is a confident claim about memory that was never
measured — the same rule as never inventing a timestamp for an unmarked output line.

**And some holes have no interval to notice.** The event stream reports, cumulatively per subscriber,
how many frames it dropped when we stopped reading fast enough. Nothing read it, so under a burst the
panel drew a straight line across frames that never arrived — the same claim `segments()` refuses to
make about a sampling gap, and a worse one, because frames are dropped when the box is busiest and the
interpolation therefore lands on the movement the chart exists to show. The two readings either side of
a drop can be an ordinary two seconds apart, so `MAX_SAMPLE_GAP_MS` sees nothing wrong.
`ResourceSample.gapBefore` carries the reported hole and `segments()` checks it separately from the
interval. Three things about the counter decide the arithmetic and each is a way to be silently wrong:
the news is the DELTA (read as a value, one hiccup leaves the chart in permanent pieces); it is PER
SUBSCRIBER, so a `hello` resets it and the reconnect seam is covered by the backfill `sinceFor` already
asks for; and a counter going BACKWARDS is a restart we did not see, where claiming a loss would invent
a number and draw it as a hole somewhere specific.

## 4. UI

The panel lives in the sidebar (~300px wide) and the DevTools panel (much wider). Mocks are drawn
at the narrow width; the wide surface gets the same layout with more horizontal room for history.

### 4.1 Overview — one card, stacked by model

```
┌──────────────────────────────────────────────┐
│ Resources          [Overview ▾]  [⏸ live] ⚙ │
├──────────────────────────────────────────────┤
│ CUDA0                      38.4 / 94.97 GiB  │
│ 95.0 ┤                                       │
│      │                        ▁▂▃▅▅▅▅▅▅▅▅▅  │  ← free (unfilled)
│      │              ▁▂▂▃▃▃▃▃▃▃██████████████ │  ← qwen3.5:32b   (model colour)
│      │▂▂▂▂▂▂▂▂▂▂▂▂▂▂██████████████████████ │  ← gemma4:31b    (model colour)
│    0 ┼░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░ │  ← other processes (hatched)
│      └──────────────────────────────────────│
│       -30m            -15m              now  │
├──────────────────────────────────────────────┤
│ ● gemma4:31b     16.9 GiB  128K  4m12s   ✕  │
│ ● qwen3.5:32b    21.0 GiB  262K  1m03s   ✕  │
│ ░ unattributed   0.59 GiB  incl. CUDA ctx    │
│ ○ free           56.5 GiB                    │
└──────────────────────────────────────────────┘
```

The hatched band is the point of the redesign: it is visibly *not ours*, so 41.2 of 102 never reads
as "our models are using 41 GB".

### 4.2 Placement — a track per card (default on a multi-card box)

```
┌──────────────────────────────────────────────┐
│ Resources         [Placement ▾]  [⏸ live] ⚙ │
├──────────────────────────────────────────────┤
│ CUDA0                      38.4 / 94.97 GiB  │
│      │▂▂▂▃▃▃▃▅▅▅▅▅███████████████████████    │
│      └──────────────────────────────────────│
│ CUDA1                       0.59 / 94.97 GiB │
│      │░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░    │
│      └──────────────────────────────────────│
│ System RAM                  109 / 121 GiB    │
│      │▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓    │
│      └──────────────────────────────────────│
└──────────────────────────────────────────────┘
```

Small multiples, not a shared axis — a model can only use one card's capacity, so a combined axis
would be a lie. This is the honest answer to the handover's open "per card or aggregate" question.

### 4.3 Unified memory (Mac) — one pool, soft ceiling

```
┌──────────────────────────────────────────────┐
│ Resources            [Memory ▾]  [⏸ live] ⚙ │
├──────────────────────────────────────────────┤
│ MTL0 · unified memory      12.6 / 16.00 GiB  │
│ 16.0 ┤- - - - - - - - - - - - - - - - - - -  │  ← system total (hard)
│ 11.8 ┤═══════════════════════════════════    │  ← recommended working set (soft)
│      │             ▁▂▃▅███████████████████    │
│    0 ┼░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░    │
│      └──────────────────────────────────────│
│ ⓘ This machine shares one pool between the   │
│   GPU and the system, so these are the same  │
│   memory — they are never added together.    │
│   Occupancy is read from the system: the     │
│   device reports itself 11.84/11.84 free     │
│   while 12.6 GiB of that silicon is in use.  │
└──────────────────────────────────────────────┘
```

Two ceilings, one axis: the working set as a solid rule (will this model fit?) inside the system
total as a dashed one. No second track, because there is no second pool.

### 4.4 Scrub — session-long history

```
│      │        ▂▂▃▃▅███████████████████        │  ← main chart: the selected window
│      └──────────────────────────────────────│
│  ┌────────────────────────────────────────┐  │
│  │▁▁▂▂▃▃▂▂▁▁▁▁▁▂▂▃▅▅▅▅▅▅▅[▒▒▒▒▒▒▒▒]▃▃▂▂▁│  │  ← overview strip, drag the window
│  └────────────────────────────────────────┘  │
│   14:02                              14:47   │
```

Dragging the window off the tail unpins live; the `⏸ live` button re-pins. Same tail-follow rule as
the tool output cell: parked at the tail follows, dragged back holds.

A gap renders as a gap:

```
│      │▂▂▃▃▅▅▅▅        ╎        ▅▅▅▃▃▂▂       │
│      └────────────────╎──────────────────────│
│                 panel closed, not sampled     │
```

### 4.5 Events: what happened, and what it cost

This is the slice that changes what the panel is *for* — from "what is in memory" to "what happened,
and what did it cost". The memory trace answers the first; events answer the second, on the same axis.

Two kinds, and they are orthogonal:

- **Instants** — vertical rules: a model loaded or evicted, a run started, a context reloaded, an OOM.
- **Spans** — horizontal bars under the plot: a generation, from first token request to completion.
  A span has a duration, which an instant does not, and that duration is the interesting part.

```
│ 95.0 ┤                                        │
│      │        ▂▂▃▃▅███████████████████        │
│  90% ┤- - - - - - - - - - - - - - - - - - -   │  ← threshold rule (horizontal)
│      │    ╷         ╷            ╷            │  ← instants (vertical)
│      └────┴─────────┴────────────┴────────────│
│ runs   ▐███████▌   ▐████▌   ▐██████████▌      │  ← spans: one generation each
│        ▲         ▲              ▲             │
│      run start  load qwen     evict           │
```

**Hover a span** for what it cost: tokens in / out, tokens per second, which model, how long.
`RunStats` (contract.ts) already computes exactly that per call — `runStats(usages)` returns
`{ inTokens, outTokens, tokPerSec, genBasis }`, and `genBasis` says whether the rate came from
Ollama's own eval timings or from wall clock, which the tooltip should show rather than implying a
precision it does not have.

**Per-model stats on hover** belong to this slice too, for the same reason: they need usage aggregated across
the session, which is what events collect. Hovering a model ROW (which already shows placement and splits from
residency) should also carry what that model has COST — average tokens/second, tokens in and out, how many
calls — aggregated from this session's `chat-result` events for that model id. Residency answers "what is
loaded"; this answers "and was it worth the VRAM". Note the same `genBasis` caveat: say whether the rate came
from Ollama's own eval timings or from wall clock.

**Click a span** to jump to that generation — the session detail for that run, scrolled to the step.
Sessions are already addressable by hash and steps by `seq`, so the target exists; the event only
needs to carry `{ hash, seq }`.

**Why it belongs on THIS chart specifically.** A generation span sitting next to the memory trace
answers a question neither view answers alone: *did that 40-second turn spend its time loading a
model?* A span that begins right after a step in the VRAM curve says yes, and one that begins during
a flat stretch says the model was already resident and the time went elsewhere. That is the whole
argument for putting them on a shared axis rather than in a separate list.

**Source.** Nothing new needs collecting:

| Event | Where it comes from |
| --- | --- |
| run start / end | the debug bus's `agent` and `agent-result` |
| generation span | `chat-result` — it already carries model, usage and timing |
| tool step | `agent-step` (instant, or a span for a long tool) |
| model load / evict | a residency diff between consecutive samples — no source needed at all |

**What the data model already has.** `ResourceEvent { t, kind, label, model? }` and
`eventsIn(events, from, to)` are written and tested. Samples carry epoch `t`, so events and memory
already share an axis. Two additions are needed: an optional `until` on an event (making it a span
rather than an instant), and a `ref?: { hash, seq }` for the click target.

**Ordering note.** Events arrive from a different source than samples and on a different cadence, so
they must be looked up by TIME, never by sample index — and a span may begin before the window and
end after it, so clipping is the window's job, not the event's.

### 4.6 Track editor

```
┌──────────────────────────────────────────────┐
│ Tracks                              [+ Add]  │
├──────────────────────────────────────────────┤
│ ⠿ CUDA0            stack ▾   [96px]     ✕   │
│    ☑ CUDA0 total    ☑ gemma4:31b             │
│    ☑ qwen3.5:32b    ☐ other processes        │
│ ⠿ System RAM       stack ▾   [96px]     ✕   │
│    ☑ System RAM     ☐ gemma4:31b (CPU)       │
├──────────────────────────────────────────────┤
│ ⚠ CUDA0 and System RAM can't share a stacked │
│   axis — different pools. Overlay them?      │
└──────────────────────────────────────────────┘
```

Bundling and splitting are the same operation on a list: everything in one track is combined, one
series per track is small multiples. Drag to reorder, drag the height grip to resize (the same grip
and Settings-backed default as the output cell). Layout persists in `chrome.storage.local`; the
knobs appear in DevTools Settings per the superset rule.

### 4.7 Reading the chart: two questions, two inputs

The chart asks two questions of one pointer — **x is WHEN**, **y is WHAT AM I READING** — so changing
one disturbs the other, and the y targets are hostile: a 10px hit stroke on a pool line, a band that
may be three pixels tall. The second question therefore gets its own input, on the two axes the data
actually has:

```
↑ ↓   along the LIST    the things this view draws, wrapping through "nothing picked out" at 0
← →   along the DEPTH   a model's summary → what its memory is holding
```

That is the tree convention (and ARIA's `tree` model). Separating the axes is what stops one key
meaning "next sibling" at the top level and "descend" once you are on a model. Two consequences are
load-bearing: **depth PERSISTS across up/down**, so you can step between models and stay drilled in —
which is the actual task, "what are these two cards each holding" — and **left at depth 0 does
nothing** rather than wrapping, because a no-op boundary is how a tree says you are at the root.

**The same key steps through what the VIEW draws.** Overview draws pool lines, the stacked view draws
model bands, so `↑↓` cycles pools there. Leaving the keys live in one view and dead in the other was
the worse option: the same key then meant "change what I am reading" or "scroll the page" depending
on where the pointer happened to be. Nothing else is copied over — a pool has no memory breakdown of
its own, so `←→` do nothing there and the hint offers only the pair it can honour.

**A keyboard focus holds until the pointer MOVES.** A band sliding under a parked cursor as samples
arrive raises `pointerenter` with nobody having touched anything, and a re-layout can pull the plot
out from under a still cursor — the drill-down does exactly that, since it collapses the cards the
model is not on. So a `pointerleave` clears only the cursor-following tips; the focus, the crosshair
and the instant being read all stand. Only a real move or Escape ends it. **Esc unwinds one rung at a
time**: the tooltip, then the keyboard focus, then the zoom.

**Discoverability is the whole feature or none of it.** The hint was first shown only once the keys
were already driving — that is, exclusively to readers who had found them — while everybody arrives
from the mouse. It appears whenever a tip is up, and the keys work from a hover exactly as they do
from a keyboard focus, because a hint that advertises a key which silently does nothing is worse than
no hint.

### 4.8 Drilled in: what a model's memory is holding

Depth 1 answers the question `size_vram` cannot: a big MODEL and a big CONTEXT are the same number
and want opposite responses. It is drawn as rows whose swatches are the exact fills the band is
subdivided with, so the tip and the plot are one picture rather than two pictures of the same memory.

- **Per card, and nothing is pro-rated.** `gpus[].memory` sums to that entry's own `size_vram`
  exactly, so each card's figures are measurements — while a whole-model split divided by a layer or
  byte ratio would be right about weights and cache and quietly wrong about `compute`, which is FLAT
  per device (measured: 31 layers against 10, both cards holding 115 MiB of it).
- **A split model answers on EVERY card it is on**, tiled down a column in track order — a drilled-in
  tip is taller than its ~110px track, so they would otherwise land on each other. Alternating SIDES
  also prevents that and is worse: which side a tip sits on then says nothing about which card it is
  for, and being anchored per track is the entire point.
- **Both tips carry the WHOLE model's size** and what share sits on that card. The per-card figure
  answers "how much of this card" and cannot answer "how big is this thing", and 1.94 GiB beside
  878 MiB under two identical denominators invites the reader to take either one for the model.
- **The axis is scaled to the model, and to the SAME height on every card it is on.** A model is
  often a few percent of a card, so its decomposition draws into three pixels. Scaling each track to
  its own contents would draw a card holding 1,991 MiB and one holding 878 MiB at the same height —
  the pro-rating mistake in a different costume, in the one view built to show they differ. The
  header announces the rescale, because a chart that changes what its height means without saying so
  is a confidently wrong picture.
- **A frame the server could not split is not an empty one.** `memory` is omitted whenever it cannot
  divide the figure, and stacking nothing drops the area to zero — which says the model was not
  resident. It was; the composition is what is unknown. Those stretches draw at the model's real
  height, flat and dashed. A frame with no band at all really is zero, and that is the difference the
  two are told apart by.
- **`other` is a signal, not a slice.** It is what the server could not name, so a large one means the
  breakdown is behind the engine reporting it — the one part whose SIZE is the message.
- **LAYERS get their own section with their own units.** `placement` is opt-in on the server
  (`OLLAMA_LAYER_PLACEMENT=1`) and absent by default. Layers are not a proxy for memory — on an even
  split one card held MORE layers and LESS weight, because the output layer is large and carries no
  KV — so drawn on a shared scale the two would disagree, correctly, and read as a bug. Matched on the
  ENGINE's device name, never the ollama `gpu_id`; a card whose name is not in the list shows nothing
  rather than the entry at its ordinal.

### 4.9 Which instant a figure describes

A track's header and legend read the last sample of the DRAWN window. The panel's own total used to
read the LIVE resident set whatever the window was, so scrubbing back put two different moments one
above the other with nothing saying so — "6.53 GiB in use" over a track whose own edge read 19.95 GiB
unattributed, which reads as arithmetic going wrong rather than as two clocks. The header follows the
window now (one shared `chartWindow()`, since deriving it twice is how they drifted apart) and stamps
the instant when it is not the present.

The model ROWS stay live, deliberately: their content is a keep-alive countdown, a busy flag and an
evict button, and a button that acts on *now* inside a row describing two minutes ago acts on a
different world than the one it is drawn in.

**And an edge says where it came from.** A load or an eviction reaches the lane two ways — INFERRED by
diffing `/api/ps`, or REPORTED by the event stream, which knows things polling cannot (above all
whether an eviction made room or was an idle expiry). The instant tooltip was hardcoded per KIND, so
it said "nothing reports an eviction" about an edge the server had just reported WITH ITS REASON, on
precisely the setup the stream exists for. `ResourceEvent.via` carries the distinction and a reported
edge says what the server said.

### 4.10 What the runner is doing, and how full its cache is

`activity` on `/api/ps` (patched server, `activity3` and later) is read out of `llama-server`'s
`/slots`, which ollama did not consult before. It answers two questions the memory figures cannot.

**Occupancy.** `prompt_tokens` is `n_past` — tokens resident in the KV cache — against the model's own
`context_length`, which the server has already divided by the parallel slot count, so it is a straight
ratio. This is the missing half of the context chip: Ollama reserves the cache for the WHOLE window when
the model loads and the bytes never move, so a 256K window at 2% and the same window at 90% are
identical everywhere else in the panel, while only one of them is worth reloading with a smaller
`num_ctx`. It is drawn as a chip beside that context chip, whose tooltip has always given that advice
with no way to know whether it applied. `<1%` rather than `0%` for a nearly-empty cache: 30 tokens of a
262,144 window rounds to zero, and "0%" beside a reserved 40 GiB is a wrong answer sitting exactly where
the reader is about to act on it.

**Two kinds of fact, one object.** Occupancy SURVIVES the task that filled it — those tokens really are
still in the cache — while `phase`, `decoded` and `prompt_tokens_done` describe the task in flight and
the server clears them when it ends. So an idle runner reports a full cache and no work, and `phase` is
the discriminator for everything else. Reading the survivor as work in progress is the mistake the shape
invites.

**Absent is not idle.** The whole object is omitted when the runner could not be asked — still loading, a
backend with no `/slots`, a failed poll, every build before this one — while `idle` is a positive answer
with a figure attached. Collapsing the two draws a full cache as an empty one on the majority of installs.

**A prefill too short to draw is a cache hit, not a broken clock.** `prompt_tokens_cached` is how much of
the prompt came from the prefix cache and was never computed. Measured on the box: a repeat of the same
4098-token prompt hit 4097 of them, leaving one token to compute, and the phase did not last long enough
to be sampled at all.

**Phase is drawn as a STATE, not as a span, and that is resolution rather than preference.** In the real
capture the event stream delivered one `prefill` frame and zero `decode` frames across two generations
that a 40 ms poll resolved completely; the 200 ms cache-hit generation produced no non-idle frame at all.
Our own poll is 2 s, and stream sampling pulls to 1 s during a body change, against a prefill lasting
~400 ms. Inferring the boundary from two samples would be reconstructing an edge by sampling — the error
§4.5 already avoids by MEASURING `dispatchMs` rather than subtracting it, and worse here because the
invented timestamp would be drawn beside a memory trace that is measured. A span needs the executor to
stamp it (`gen.start`/`gen.phase`/`gen.end`, requested upstream); until then a reading is drawn as what
it honestly is. The phase chip is also kept separate from the keep-alive chip rather than folded into its
"in use": they are different facts and they disagree exactly where it matters, since a request in flight
while the slot has not started reads `busy: true, phase: idle`.

## 5. Build order — SHIPPED

All five steps are built, along with several things this document did not anticipate (§4.7–4.9). Kept
as a record of the order, which held up: each step was useful on its own and none of them had to be
unpicked.

1. **Plumbing** — `ml.info()` as a new primitive (four files; copy `ml.serverTools()`, `2ceeb77`),
   `LoadedModel.gpus` plus exact byte fields at the `listLoadedModels` choke point.
2. **History + the stacked chart** — session-long samples in a module signal, three-band rendering,
   a real ceiling. Fixes the denominator and the attribution on its own.
3. **Series, tracks, presets** — the configurable panel.
4. **Scrub** — the overview strip and live pinning. History is 900 samples (~30 min at 2s),
   session-only, so this is a window onto what is already in memory.
5. **Events** — spans and instants on the shared axis, hover for cost, click to jump (§4.5).

Since then, and not planned here: the memory BREAKDOWN (§4.8) once the server could split `size_vram`;
the keyboard reading model (§4.7); the `total` axis (§3.3); and `placement`. The implementation notes
live in AGENTS.md — this document is the design and the captures, and should not grow a second copy
of them.

## 5.1 Decided while building

- **Preset picker**: a dropdown in the header row the panel already has (`.vram-head`), not tabs — tabs
  cost a permanent row in a panel competing for height, and imply switching more often than this is
  switched. The track editor sits behind a small badge that expands it.
- **Presets and the editor are one state**: `TrackDef[]`. A preset populates it; editing it flips the
  picker to *Custom*. `presetRefusal` keeps the two honest — a preset may never propose a layout
  `stackRefusal` then rejects, which it did (Overview stacked several cards) until a drift guard caught it.
- **A layout that does not fit the box** falls back to the default preset rather than rendering a track
  for a card that is not there.
- **Capacity is re-fetched every 5 polls (10s)**, not once per open: `free_memory` rides in the same
  payload and is not slow-moving, so fetching once froze the free and residual bands.
- **History is per-box.** `boxSignature` identifies the machine; pointing the extension at a different
  backend drops the old box's samples, including those taken before capacity was known (which would
  otherwise be backfilled with the NEW ceiling — an 18 GiB reading clipped against an 11.84 GiB pool).
- **Hover names the band**: the same facts as the legend row, from one shared component, so a badge
  added later appears in both.

## 6. Open questions

**Answered since:**

- *Sampling while the panel is closed.* Still gated on the panel being open, and the gaps are still
  honest — but the event STREAM closed most of the need: a load or an eviction that happened while
  nobody was watching arrives as a backfilled edge rather than as a hole with a model on the far side
  of it. The samples remain discontinuous; the story no longer is.
- *Does the context gauge fold in?* No, and the reason turned out to be sharper than "different
  quantity": the gauge is the LATEST call's occupancy (each call re-sends the history, so summing
  would double-count the prefix) while the panel is a series over time. They sit beside each other in
  the composer and answer different questions. The join worth making is the other direction — see
  below.

**Still open:**

- **Retention.** 30 minutes at 2s is ~900 samples, kilobytes — cheap. Is a session enough, or should
  it survive a reload in `chrome.storage.local`? Unchanged, and unforced.
- **Reserved KV against tokens actually used.** `memory.kv_cache` is the bytes RESERVED, and Ollama
  preallocates for the whole context window, so the panel can say what a context COSTS and not what
  of it is used. The DevTools session view already counts the tokens our own sessions pushed through
  it — "this session put 6.2k tokens through a cache reserved for 262k" is one join away, and it is
  the same fact from two ends. For traffic this browser did not cause it needs the server (asked for
  in `tmp/handover-execution-phase.md`).
- **Prefill vs decode.** The lane draws a generation as one block. `prompt_eval_duration` and
  `eval_duration` already split it for calls we made, so the block can be split with no new data —
  the gap is other clients' traffic, where `busy` is one bit. Also in that handover.
- **What a drilled-in tip does to the track below it.** Tiling stopped the tips landing on each other
  and the cards the model is not on give up their height, but a tip can still cover part of a
  neighbouring plot. The structural answer is more height for the tracks that are drawing something,
  which moves the layout mid-mode.
