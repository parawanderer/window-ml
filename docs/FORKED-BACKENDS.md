# The forked backends

Most of `window.ml` runs against a stock Ollama behind a stock OpenWebUI. Two things do not, and this
page is the honest accounting of which — because a feature that silently needs a patched server is
worse than one that says so.

Nothing here is a hard requirement to *use* the extension. Everything degrades: the affected features
either turn themselves off or say "unknown", and the rest of the extension is unaffected.

## Ollama — `parawanderer/ollama`, branch `slop`

Formerly `local/ps-gpu-attribution`; that branch name is stale. Parts of it are upstream as
**#18197** (per-device `/api/ps` plus three fixes), **#18198** (VRAM prediction from measured loads) and
**#18201** (`physical_memory`). Some commits on the branch (`Wire up API for info UX`, `Add CLI for info
command`) are upstream work by Daniel Hiltgen carried along; the rest are local.

What it adds that the extension reads:

| Route | Field | Used by |
| --- | --- | --- |
| `GET /api/info` | `compute.supported_gpus[]` — per-device `total_memory`, `physical_memory`, `free_memory`, `runner`, `name`; `compute.system_compute` — host RAM | `ml.info()`, and every ceiling, band and share in the resource panel |
| `GET /api/ps` | `gpus[]` on a resident model — `gpu_id`, `runner`, `size_vram` | per-device attribution: which card a model is on, and how a split model is divided |
| `GET /api/ps` | `busy` on a resident model, from the runner's reference count | freezing the keep-alive countdown while the model is actually serving a request |
| `GET /api/ps` | `state` on an entry that is still loading | knowing that the entry's other fields are zeros, not measurements |
| `GET /api/events` | an NDJSON stream of the scheduler's own transitions — `load.start` / `load.weights` / `load.complete` (with `weights_ms`, `context_ms`) / `load.failed`, `busy.start` / `busy.end`, `expires`, `evict`, `unload`, plus `sample` frames embedding the `/api/ps` and `/api/info` bodies verbatim | the resource panel's whole machine half: load spans, serving spans, and evictions the server REPORTS |

**Without it.** `/api/info` is not a 404 on a stock setup — the route simply isn't there, so OpenWebUI
answers with its SPA's HTML, which is why the extension treats a non-JSON body as "unknown" rather than
as an error. Then:

- `ml.info()` returns `null` — **capacity unknown**, never zero.
- The resource panel drops to its no-ceiling fallback: an auto-scaled line labelled `no ceiling —
  capacity unknown`, with a tooltip explaining that this server doesn't answer `/api/info`. No bands,
  no free space, no per-device split.
- Without `gpus[]` on `/api/ps`, a model can still be *counted* (its `size_vram` is upstream), but not
  *placed*. On a single-GPU box that costs nothing — the total is the share. On a multi-GPU box the
  card a model sits on is unknowable, so it lands in the unattributed band rather than being assigned
  to a card it might not be on.
- Without `busy`, the TTL chip counts down against `expires_at` at all times. That stamp is only
  rewritten when a request *finishes*, so throughout a generation it stands still while the chip runs
  down against it, and a generation longer than the keep-alive takes the countdown past zero on a model
  that is right there, working. A local in-flight flag is not a substitute: the runs that matter most
  are the ones this browser never started.

**A load's memory is visible WHILE it happens (as of 2026-09-05).** This was reported as a client-side
puzzle — a six-second load with zero samples inside it, so the memory line could only ever step once — and
turned out to be four faults stacked on the server, each hiding the next: `EventFrame` had no `size_vram`
field at all (so every VRAM figure a client saw came from the embedded `ps` body, never from the edge);
`load.weights` carried no memory; the sampler chose its cadence *when a tick fired*, so a 6 s load inside a
15 s idle interval was never observed; and free memory came from two sources that differ by ~1.1 GiB. Now
events WAKE the sampler (~40 ms to the first reading after an edge) and it runs at **250 ms while a load is
in flight**, free memory is read from NVML on every reported figure, and `size_vram` rides on `load.weights`
and `load.complete`.

Three things follow for a client, all of them counter-intuitive enough to have caught us:

- **`vram_used` does NOT move during a load.** It is ollama's own accounting over registered runners, and
  the runner does not exist until the load returns — so it stays flat and jumps at the end. The two steps
  are visible in the DEVICE figures (`supported_gpus[].free_memory`), which is what the panel draws from.
  Measured on a 7.6 s load: `+0.55 GiB` (the driver context), then `+17.11` as the weights land — matching
  `load.weights size_vram` to the byte — then `+2.33` and `+0.36` as the context is allocated.
- **An event's `size_vram` and the device's own step differ by the CUDA context floor** (~0.69 GiB per
  card): the device figure includes the driver context, the model's does not. That is agreement, not drift.
  **Do not reconcile them to zero.**
- **A `sample` mid-load can arrive with `info: null`** — that reading learned nothing about capacity, and is
  not a claim that the box has none. `holdCapacity` is what keeps the ceiling across it.

**`unload` now names its model.** It previously did not — `unload()` cleared `runner.model` and the name was
read after it — so those frames were dropped rather than drawing an unnamed model leaving memory.

**The event stream is the one thing polling cannot approximate.** For most of a load there is no runner
object in Ollama at all — it is constructed only after the load returns — so `/api/ps` is not merely coarse
during a load, it is empty: measured on the box, `load.start` at t=4102, `load.complete` at t=48053, and
every poll across that span returned nothing. Every load span the panel drew before this was reconstructed
from the `load_duration` of whichever request happened to be waiting, which is why a model that loaded
because somebody else asked for it was invisible. The stream also draws distinctions inference cannot:
`evict` (made room for something) against `unload` (idle expiry) are two different answers, and diffing two
polls sees one disappearance either way.

Three details of the protocol matter to a client. `t` is milliseconds from **that connection's own hello**
and is NEGATIVE for backfill, so a replayed frame says it predates the connection instead of being
restamped as now. `?since=<ms>` is a DURATION, not an offset — an offset from a previous connection means
nothing to this one. And `hello` carries `retainedMs` (how far the ring actually reaches back, so asking
for more than exists tells you your record has a gap) beside `backfilled` (how many frames you actually
got, emitted even as `0`, because a client has to be able to read zero as a fact).

**The model names do not match `/api/ps`.** The stream reports fully-qualified names
(`registry.ollama.ai/library/gemma4:31b`) while `/api/ps`, in the very same `sample` frame, reports
Ollama's short name (`gemma4:31b`). A client that keys on them directly draws every model twice. `normModel`
reconciles it as the inverse of Ollama's own ShortName — the default registry, then the default `library`
namespace, then the implicit `:latest` — and only for the DEFAULTS, since a model pulled from elsewhere
keeps its prefix in `/api/ps` too.

`state` is the smaller of the two but the sharper edge: a still-loading entry carries its name and
zeros for everything else, and Go's zero time parses to a deadline in the year 1 — a countdown of minus
two thousand years, which is what a probe on the box actually printed. Read `state` before reading
anything else on an entry; its absence means resident.

**The engine's running token count on every streamed chunk (`ollama-slop:streamusage`, plus an OpenWebUI
`payload.py` overlay).** Asked for with `stream_options: {include_usage: true, continuous_usage_stats: true}`
on `/v1/chat/completions` (SSE `usage` on every chunk; protobuf `Delta.completion_tokens`, field 6) and on
OpenWebUI's `/api/chat/completions`, or `stream_metrics: true` on native `/api/chat` (`eval_count` on every
chunk). Opt-in, so no other client's stream changes. A running total, thinking tokens included; on ollama's
`/v1` SSE the finish chunk has none and the usage chunk after it holds the final figure. The same overlay
fixed OpenWebUI dropping `max_tokens` on `/api/chat/completions` (it now arrives as `options.num_predict`);
a response cut off by it still comes back from OpenWebUI's non-streamed route as `finish_reason: "stop"`
where OpenAI's contract says `"length"`.

**Which process on a card is whose (`processes` on `/api/info`, `ollama-slop:runnerpids2`).** Each card
lists the processes the driver reports on it, joined by pid to ollama's runners: `{pid, used_memory, name,
runner: {model, loading?}, ollama_helper?}`, plus `processes_scope` per card. The scope is the part to read
first. `"all"` means ollama shares the host's pid namespace and every process is listed. `"pid_namespace"`
(any Docker deployment, including the reference box) means the driver lists only ollama's own namespace:
another container's process holding 2.6 GB on a card was absent from the list and present in
`free_memory`. So under that scope a missing process proves nothing, and the unlisted remainder is drawn as
"outside ollama's view" rather than as overhead. A runner's own overhead (its process minus its model's
share of the card) is measured per runner and is not a constant: 444 MiB and 633 MiB on the same box. A
loading runner is marked `loading` and has no `/api/ps` figures yet, so nothing is subtracted from it.
Helpers (a fit probe, device discovery as a process named `ollama` briefly holding ~550 MiB on every card)
are flagged so they are not read as tenants. Absent on every older build, where the residual is still named
by its size. Captures: `tests/fixtures/hw/runner-pids-*-2026-09-11.*`.

**What a card IS, and which card a faulted one was (`ollama-slop:devicenames`, 2026-09-12).**
`supported_gpus[].description` is the driver's product string ("NVIDIA RTX PRO 6000 Blackwell Workstation
Edition"), from `ml.DeviceInfo.Description` — the same string the fault path already carried; `name` stays the
backend's label (`CUDA0`). Verified live on CUDA only; HIP/ROCm and Vulkan read their driver's device name by the
same code path, Metal is unchecked, and a CUDA card split into virtual devices gets ` (dev pN/vM)` appended, so the
string is shown, never matched. `unavailable_gpus[].last_name` / `last_seen` say what that bus address was called
when the server last saw it healthy, kept in `device-names.json` beside the models so they survive a restart
(`last_seen` exact within a run, within ten minutes across one). ABSENT means the server never saw that address
healthy — it never guesses from enumeration order, which shifts when a card drops out. The panel's fault banner
prefers `last_name`, then its own per-backend record. Capture:
`tests/fixtures/hw/gpu-description-one-card-faulted-2026-09-12.json` (the fault predates the build, so `last_name`
is absent there).

**Reachability, and a correction.** The extension finds Ollama through the same base discovery it uses for
`/api/ps`: `<origin>/ollama` first (OpenWebUI's passthrough), then `<origin>`. This file used to say
OpenWebUI proxies `/ollama/*` generically. **It does not** — it proxies NAMED ollama routes, so each new
route has to be added on the OpenWebUI side as well, and an unmodified OpenWebUI answers an unproxied one
with its SPA's HTML no matter how correct the ollama side is. That is what `/api/info` needed earlier and
what `/api/events` needed again; both are on the OpenWebUI branch below. So for the capacity and event work
the OpenWebUI fork IS in the path, and a patched Ollama behind a stock OpenWebUI is not enough.

## OpenWebUI — `parawanderer/open-webui`, branch `ml/tool-execute-api`

Two commits ahead of upstream: `POST /api/v1/tools/id/{id}/execute`, which runs exactly the callable the
chat pipeline would — local tools, OpenAPI tool servers, and MCP servers — so an external client can
drive its own agent loop while still using the tools configured in OpenWebUI. Upstream, tool execution
happens only *inside* the chat pipeline, so the only way to reach a tool from outside is to hand the
whole loop to a model.

**The extension does not call this endpoint yet.** Server-side tools today go through upstream's own
mechanism: `tool_ids` on the request plus the `function_calling` execution loop, which is why
`fetchLLM` probes `SERVER_TOOL_MODES` — that loop's label is version-dependent. The fork is what makes
the *other* shape possible (the extension running one tool itself, in its own loop, with the arguments
it chose), and this file is where to look when that lands.

It now also STREAMS its output and reports its own `durationMs`/`queuedMs` — without the latter a remote
tool's span is the tool plus the network as one unattributable number. Both are specified, as built, in
**[REMOTE_TOOL_EXECUTION.md](spec/REMOTE_TOOL_EXECUTION.md)**. Neither is proposed upstream yet, and
nothing on this side consumes them.

## Running them

Both forks build and run exactly like their upstreams; nothing about the extension's config changes.
Point `chatUrl` at the OpenWebUI as usual — the extension discovers Ollama through it.

If you are pointing at a machine whose Ollama is stock, that is a supported configuration: expect the
resource panel to say capacity is unknown, and expect multi-GPU attribution to be unavailable. If you
see either of those on a machine you believe is patched, check that `/api/info` is reachable through
the passthrough (`curl -s <origin>/ollama/api/info | head -c 200` — HTML means the route isn't there).
