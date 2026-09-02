# Resource panel (VRAM / RAM) — spec

Replaces the sidebar's VRAM sparkline with a configurable, developer-grade resource view: several
metrics, several ways to combine them, session-long history you can scrub, per-model attribution,
and (later) events drawn onto the time axis.

Backend prerequisites, the endpoint shapes, and the server-side caveats live in
`tmp/vram-gauge-handover.md`. This document is the panel: the data model, the UI, and the
decisions. Read the handover's "Caveats" section first — three of them will otherwise produce a
confidently wrong display.

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

A device decomposes into **attributed / other / free**:

- **attributed** — one band per model, from `/api/ps` `gpus[].size_vram`
- **other** — `(total - free) - attributed`, memory in use that no model of ours accounts for
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

### 3.4 History has holes

`pollPs()` is gated on the sidebar being open, by design. So the sample series is discontinuous,
and `segments()` breaks the line at any gap over `MAX_SAMPLE_GAP_MS` rather than drawing across it.
An interpolated segment over a ten-minute hole is a confident claim about memory that was never
measured — the same rule as never inventing a timestamp for an unmarked output line.

## 4. UI

The panel lives in the sidebar (~300px wide) and the DevTools panel (much wider). Mocks are drawn
at the narrow width; the wide surface gets the same layout with more horizontal room for history.

### 4.1 Overview — one card, stacked by model

```
┌──────────────────────────────────────────────┐
│ Resources          [Overview ▾]  [⏸ live] ⚙ │
├──────────────────────────────────────────────┤
│ CUDA0                        41.2 / 102 GB   │
│  102 ┤                                       │
│      │                        ▁▂▃▅▅▅▅▅▅▅▅▅  │  ← free (unfilled)
│      │              ▁▂▂▃▃▃▃▃▃▃██████████████ │  ← qwen3.5:32b   (model colour)
│      │▂▂▂▂▂▂▂▂▂▂▂▂▂▂██████████████████████ │  ← gemma4:31b    (model colour)
│    0 ┼░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░ │  ← other processes (hatched)
│      └──────────────────────────────────────│
│       -30m            -15m              now  │
├──────────────────────────────────────────────┤
│ ● gemma4:31b      18.1 GB  128K  4m12s   ✕  │
│ ● qwen3.5:32b     22.5 GB  262K  1m03s   ✕  │
│ ░ other processes  0.6 GB   — not ours       │
│ ○ free            60.8 GB                    │
└──────────────────────────────────────────────┘
```

The hatched band is the point of the redesign: it is visibly *not ours*, so 41.2 of 102 never reads
as "our models are using 41 GB".

### 4.2 Placement — a track per card (default on a multi-card box)

```
┌──────────────────────────────────────────────┐
│ Resources         [Placement ▾]  [⏸ live] ⚙ │
├──────────────────────────────────────────────┤
│ CUDA0                        41.2 / 102 GB   │
│      │▂▂▂▃▃▃▃▅▅▅▅▅███████████████████████    │
│      └──────────────────────────────────────│
│ CUDA1                         0.6 / 102 GB   │
│      │░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░    │
│      └──────────────────────────────────────│
│ System RAM                  117 / 130 GB     │
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
│ MTL0 · unified memory        13.5 / 17.2 GB  │
│ 17.2 ┤- - - - - - - - - - - - - - - - - - -  │  ← system total (hard)
│ 12.7 ┤═══════════════════════════════════    │  ← recommended working set (soft)
│      │             ▁▂▃▅███████████████████    │
│    0 ┼░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░    │
│      └──────────────────────────────────────│
│ ⓘ This machine shares one pool between the   │
│   GPU and the system, so these are the same  │
│   memory — they are never added together.    │
│   Occupancy is read from the system: the     │
│   device reports itself 12.71/12.71 free     │
│   while 13.5 GB of that silicon is in use.   │
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

### 4.5 Events (later slice, but the buffer is shaped for it now)

```
│      │        ▂▂▃▃▅███████████████████        │
│  90% ┤- - - - - - - - - - - - - - - - - - -  │  ← threshold rule (horizontal)
│      │    ╷         ╷      ╷                  │  ← event rules (vertical)
│      └────┴─────────┴──────┴─────────────────│
│  events  ▲         ▲      ▲                   │  ← lane; hover for the label
│         run    load qwen  evict               │
```

Two orthogonal things, both cheap: **horizontal** rules are thresholds (capacity, a warning line),
**vertical** rules are events. The event lane mirrors the output cell's timestamp gutter — a tick
per instant, hover for detail.

Source: the debug bus already emits `agent` / `agent-step` / `chat-result`, which covers run start,
tool calls, and completion; load/evict come from residency diffs between samples.

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

## 5. Build order

Each step is useful on its own.

1. **Plumbing** — `ml.info()` as a new primitive (four files; copy `ml.serverTools()`, `2ceeb77`),
   `LoadedModel.gpus` plus exact byte fields at the `listLoadedModels` choke point.
2. **History + the stacked chart** — session-long samples in a module signal, three-band rendering,
   a real ceiling. Fixes the denominator and the attribution on its own.
3. **Series, tracks, presets** — the configurable panel.
4. **Scrub** — the overview strip and live pinning.
5. **Events** — the lane, vertical rules, threshold rules.

## 6. Open questions

- Sampling while the panel is CLOSED. History has holes by design today. A slow background sample
  (say 30s) would fill them at the cost of polling a box nobody is watching. Worth it, or are
  honest gaps better?
- Retention. 30 minutes at 2s is ~900 samples, kilobytes — cheap. Is a session enough, or should it
  survive a reload in `chrome.storage.local`?
- Does the context gauge (`UsageBar` in `sidebar/app.tsx`) fold into this panel, or stay separate?
  It is a different quantity (tokens, not bytes) but the same "usage against a ceiling" idea.
