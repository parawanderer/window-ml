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

**What a request is FOR (`hint`, `ollama-slop:hints2`, live 2026-09-12).** Every generation request may carry
a top-level `hint`: `use` (who waits for the output: `interactive`, `agent`, `utility`, `batch`), `session`
(shared by one conversation or run), `after` (`human` or `tool`, what the session waited on since its previous
request), `synthetic` (generated traffic, kept out of learned usage) and `request` (echoed on that request's
`gen.end`). The server only RECORDS it today, beside the request's timings on `gen.end`; placement (splitting a
model across cards for agent loops) and keep-alive (learned from a session's gaps) are what it will be learned
into. Open WebUI's `/api/chat/completions` passes it through (fork overlay, `payload.py`) and fills in
`use: utility` and an `owui-` session for its own task calls when a request carries none. What we send
(`wireHint`, contract.ts): agent steps are `agent` in `wml-<run hash>`, with `after` from the loop (a person at an
approval gate, or a follow-up turn, is `human`; otherwise a tool that ran); a tool's own model calls — the
vision reader, grounding, OCR, a fetch's reader — are `agent` in the parent run's session, bound while the tool
runs (`currentRunSession`); the sidebar's summaries, notes and titles are `utility` in the session they are about;
`createChat` turns carry the chat's session and `use` only when the caller gave one; a one-shot `ml.chat` carries
no session; the observe and bench harnesses set `ml_synthetic_traffic` so their requests say `synthetic: true`.
Every request also carries our own `request` id (`wml-r-…`, minted per request in the worker); it comes back on
the call's usage (`TokenUsage.requestId`) and on the server's `gen.end`, which is how the panel joins the two
exactly (`joinGens`). `after: "human"` is sent only for a gate a PERSON decided: one resolved through the external
approval channel (a harness, an orchestrator) adds no `after`. A STRICT OpenAI-compatible backend may 400 on the
unknown field: the request is retried once without it, and the refusal is remembered for that URL only if the
retry succeeds. The agreement and the reasoning behind each value
are in the two mlbox reports `handover-request-hints.md` and `handover-request-hints-answer.md`.

**Measured decode speed (`ollama-slop:correction`, 2026-09-13).** `compute.profile` on `/api/info`: each card's decode
bandwidth and per-token/per-layer costs, measured on the box once it is idle (`state` `pending` → `measuring` →
`measured`, joined to `supported_gpus` by `pci_id`). `expected_decode` on each `/api/ps` row: the predicted empty-cache
decode speed for that placement, `basis` `profile` or `profile_corrected` (by the model's own clean generations), or
`unavailable` with a reason. `predicted_decode` on `gen.end` (`ollama-slop:genpredict`): the server's prediction for that
generation, made before it ran (`ms_per_token` at `occupancy_tokens` = `prompt_tokens + decoded / 2`, its `basis`,
`correction_samples` when corrected, `excludes_cache_read` for a sliding-window model). The client shows all three (see
`docs/dev/resource-panel.md`).

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

## How the extension reads these (moved from AGENTS.md, 2026-09-12)

Most of this runs against stock Ollama + stock OpenWebUI. Three capabilities do not, and
**`docs/FORKED-BACKENDS.md`** is the accounting — read it before assuming a resource-panel field is
broken:

- **`GET /api/info`** (machine capacity) and **`gpus[]` on `/api/ps`** (which card a model is on, and how
  a split is divided) come from `parawanderer/ollama`, branch `slop` (the old `local/ps-gpu-attribution`
  name is stale). Stock Ollama
  doesn't serve `/api/info` at all — OpenWebUI answers with its SPA's HTML, which is why a non-JSON body
  is read as "unknown", never as an error. Without them `ml.info()` is `null`, the panel draws no ceiling
  and says so, and a multi-GPU box cannot attribute a model to a card.
- **`GET /api/events`** (the same branch) is an NDJSON stream of the scheduler's own transitions, and it
  is the one thing polling cannot approximate: for most of a load there is no runner object in Ollama at
  all, so `/api/ps` is not coarse during a load, it is EMPTY (measured: `load.start` t=4102,
  `load.complete` t=48053, every poll across it empty). It also tells `evict` (made room) from `unload`
  (idle expiry), which diffing polls sees as one disappearance either way. `sw-events.ts` holds ONE
  connection per worker while a panel is open, `resource-events.ts` is the pure frame model + NDJSON
  reader, and `machineEventFrom` (vram.tsx) turns edges into lane spans. Everything falls back to polling
  when the route answers with HTML. Three protocol details: `t` is ms from THAT CONNECTION'S hello and is
  negative for backfill; `?since=` is a DURATION, not an offset; and **the stream names models
  fully-qualified while `/api/ps` names them short**, which `normModel` reconciles at the
  `machineEventFrom` boundary — miss it and every model is drawn twice, once as a phantom "off-box" row.
  A load is SAMPLED while it happens now (250 ms, and events wake the sampler), and its two halves each
  carry a `size_vram` — but **`vram_used` stays flat through a load** (it counts registered runners, and the
  runner does not exist yet), so the two steps show in the per-device free memory and nowhere else. See
  `docs/FORKED-BACKENDS.md` for the rest, including why an event's `size_vram` is ~0.69 GiB per card below
  the device's own step and must not be reconciled to it.
  Recorded fixtures come from `tests/e2e/capture-frames.mjs`; the fake backend replays them via
  `setEvents`/`pushFrame` and `tests/e2e/resource-stream.spec.mjs` is the coverage.
- **`activity` on `/api/ps`** (the same branch, `ollama-slop:activity3`) is what the runner is DOING — phase,
  KV occupancy, prefill progress, prefix-cache hits — read from `llama-server`'s `/slots`, which ollama did
  not consult before. Absent on every stock server AND whenever the runner could not be asked, which is not
  the same as idle. `tests/e2e/fixtures/runner-activity.json` is a real capture off the box (169 samples at
  ~40 ms across a cold prefill, a decode, an idle stretch and a cache-hit repeat) and
  `tests/runner-activity.test.mjs` asserts against it directly rather than against shapes written here —
  two of its cases are ones nobody would have invented: an idle runner still reporting occupancy, and a
  generation containing no prefill sample at all.
- **`POST /api/v1/tools/id/{id}/execute`** comes from `parawanderer/open-webui`, branch
  `ml/tool-execute-api` — it runs the callable the chat pipeline would, so an external client can
  drive its own loop over OpenWebUI-configured tools. **The extension does not call it yet**: server
  tools go through upstream's `tool_ids` + `function_calling` loop (hence the `SERVER_TOOL_MODES` probe).
  It now also STREAMS its output (NDJSON delta frames) and reports its own `durationMs`/`queuedMs`, which
  is what makes a remote tool's span attributable instead of "the tool plus the network" as one number.
  `docs/spec/REMOTE_TOOL_EXECUTION.md` is the contract, corrected against what was built. Expect little
  output: OpenWebUI has no streaming tool protocol, so frames come from `__event_emitter__` and a tool that
  only `print()`s streams nothing.

**Remote tool execution — `src/tool-protocol.ts`.** Two things that must not be confused. A PUBLISHED MCP
EXTENSION: one `_meta` key (`dev.wander.windowml/timing` → `{durationMs, queuedMs?}`) that anyone can
implement, because MCP results carry no timing at all and a client's own wall clock is the tool plus the
network as one unattributable number. Documented here rather than by forking MCP's schema — MCP's own rules
say a vendor extension is specified in its owner's docs, and a fork would be a large surface we do not
control, going stale every revision, published as something that looks like MCP and is not. And OUR
NORMALIZED MODEL (`ToolFrame`: `output`/`event`/`result`), which every source is adapted into — MCP
notifications, OpenWebUI's NDJSON, a local container over IPC. Typed and schema-generated so a consumer gets
real models, NOT advertised as a wire format: inventing a rival to MCP is the mistake the shape avoids.
`anchorFor`/`anchorOffset` are shared because a remote host's clock is not the user's, so frames carry
OFFSETS and the client anchors at the first frame's arrival — two adapters each inventing that rule is the
drift a normalized model exists to prevent. **The schema pins frame SHAPES, never sequencing**: "result is
last and mandatory", "output frames are deltas", "a closed connection means cancel" live in the spec.
The generator is now TABLE-DRIVEN (`SCHEMAS` in `scripts/gen-export-schema.mjs`) — three documents from one
line scanner, because two copies of a scanner drift exactly the way a generated schema is meant to prevent.
**`createToolStream`** is the contract's reference reader: NDJSON chunks in, `{output, marks, events,
result}` out, shared so the OpenWebUI reader and a future MCP one differ only in where frames come FROM.
It buffers a partial trailing line (a frame split across two network reads is the failure that only shows
up on a slow link), accepts a final line with no newline (a server ending without one is not malformed, and
dropping its `result` would turn a completed call into a failure), ignores an unreadable or UNKNOWN line
rather than abandoning the rest, and treats **a stream that ends with no `result` frame as a TRANSPORT
FAILURE** — partial output reported as a tool that returned nothing is a wrong answer dressed as an empty
one, and the model cannot tell the difference. **`ml.execServerTool(toolId, name, args, {onOutput, signal})`**
runs ONE OpenWebUI-configured tool in OUR loop with OUR arguments — the other shape from `toolIds` +
`function_calling`, which hands the whole loop to the model. The usual three files (`SERVER_TOOL_REQUEST` →
`SERVER_TOOL_EXEC`), with `sw-tools.ts` doing the privileged fetch and `SERVER_TOOL_STREAM` as the reverse
channel for live frames (the twin of `PYTHON_STREAM`). **CHOKE POINT, and a real escalation if missed**: the
fetch spends the user's API key and the tool is caller-chosen, so a hostile page reaching the handler could
otherwise invoke any tool the user has configured — "send an email" is a different capability from spending
tokens. An untrusted page therefore needs a per-call grant (`TabGrants.serverTools`), minted in
`delegateTool` when a run APPROVED that exact call; `serverToolKey` hashes the bundle, the function AND the
arguments, because approving "search for THIS" must not authorise searching for something else. A
non-streaming endpoint degrades to one `result` frame rather than failing, so a server without the patch
still works, just without liveness. **Agent-facing:** `ml.agent({ serverTools: ["srv1"] })` exposes a bundle as ONE TOOL PER FUNCTION
(`buildServerTools`), named `<bundle>__<fn>` and carrying that function's own JSON Schema — a generic
`run_server_tool(tool, fn, args)` would hand the model an opaque `arguments` object to guess at, which is
the difference between a tool it uses and one it fumbles. Opt-in BY ID, never "all of them", and always
`requiresApproval`: this is the first gate where the risk is not "this might change your page" but "this
sends your data somewhere", and there is no read-only version of that to auto-approve. An unresolvable
bundle is skipped rather than failing the run. **The tool declares `remote: {via, toolId, fn}`** and BOTH
the approval card and the background's grant read THAT rather than the tool's name — so a page choosing a
friendly name cannot make the card say `search_web` while the grant authorises `send_email`. Its `render`
is an `action` descriptor whose note says the arguments leave the machine, styled like a navigation because
something is departing. **Settings → Advanced → "Server-side tools"** is the read-only browser for what the backend exposes, since
discovery otherwise meant calling `ml.serverTools()` and reading JSON. It renders through the SAME
`ToolDefsView` an agent run's "agent options" block uses for the LOCAL toolset, so a remote tool and a local
one are read the same way rather than in two dialects, and it lists ONE ENTRY PER FUNCTION under the name
`ml.agent({serverTools})` would expose — what a run would actually be given, not a bundle to unpack.
Fetched on EXPAND, not on mount: a settings panel opening should not call the backend for a section nobody
looked at. An empty list SAYS it is empty (a bare-Ollama endpoint has no such concept) rather than
rendering blank, which would read as a failure.

**`ml.dynamicTools.<bundle>.<fn>(args)`** is the same tools as a callable NAMESPACE (`dynamic-tools.ts`).
Namespaced by BUNDLE, not flattened: function names come from the server and two bundles can both expose
`search`, so flattening would silently call the wrong one. Each callable carries **`.schema`** (the
function's JSON Schema) and `.spec` — the SAME object the call is validated against by `validateArgs`
BEFORE dispatch, so a console typo fails with the reason instead of as a 400 from the far end or a call that
succeeded with an argument dropped; a second copy for humans to read would drift from the one that checks.
It is a **Proxy AND real keys**, because `window.ml` is defined synchronously at document_start while the
list needs a fetch: the Proxy dispatches by name immediately (so a call works before any list arrived, and
an unlisted one dispatches without validating rather than refusing a tool that may exist), and `load()`
fills in enumerable keys so the console can complete them. A run-scoped `allow` list makes an
out-of-whitelist bundle THROW with the reason rather than being `undefined`, since "undefined is not a
function" sends the reader hunting for a typo.

**The `@tool:` POINTER MACRO (`pointer-macro.ts`).** Models write `@tool:abc1234` inline as though it were
JS, because that is how a reference is spelled everywhere else they meet it. `exec` makes it real: in CODE
position it expands to `ml.dereference("@tool:abc1234")` — the same accommodate-don't-fight tack as the
`read_csv` redirect and the `tables['name']` alias.
**LEXICAL, not AST, and that is forced** — `@tool:abc` is not valid JavaScript, so a parser cannot find it;
a parser only finds syntax it accepts. Which is why the C preprocessor is a separate pass, and why this
inherits its central rule: **a macro does not expand inside a string or a comment**, the single likeliest
place a model writes a pointer being a line it is logging. Template `${…}` re-enters code, regex literals
are skipped, and pointer-free source comes back BYTE-IDENTICAL (exec already works; rewriting code that
contains no macros would be pure downside). The AST still gets a job — the EXPANDED source parses, so acorn
can verify what the un-expanded source never could.
**And the pointers are SYNCHRONOUS**, which is the point of the macro rather than a detail of it. The
lexical pass knows every handle before a line runs, so `exec` resolves them all up front (concurrently) and
shadows `ml` with a shim whose `dereference` is an ordinary call — `@tool:abc.length` is a number, not
`undefined` on a promise, which is the plausible-wrong-answer shape this codebase keeps designing out. It
also deletes a line of prompt surface. `DerefRead` is a String subclass, so a sync return needs no further
explanation. Three rules make it safe: a FAILED pre-read is stored and thrown only when READ (a bad handle
in a branch the script never reaches must not fail a working program — eager fetch, lazy failure); a
COMPUTED handle or a `pipe` falls through to the real async method, so nothing loses a capability; and the
`ml` parameter is introduced ONLY when there is something to substitute, since passing it unconditionally
would shadow the page's real `ml` with `undefined` whenever the lookup failed and break every other `ml.*`
call in exec.
**And it is expanded BEFORE the read-only dialect sees the source too**, which is not an optimisation but a
correction: `@tool:abc` is not JavaScript, so the tokenizer rejects it and the whole survey falls through to
the approval gate — while the same read spelled `ml.dereference("@tool:abc")` is FREE, since `dereference`
is in `ML_READONLY_METHODS`. Without expanding first, the macro would have taught the model the more
expensive spelling of a read it is allowed to do for nothing. Nothing is pre-hydrated on that path: the
dialect auto-awaits a facade call, so a pointer is a value there too — same semantics, reached differently.
Adversarial tests per the dialect rule: a crafted quoted label cannot break out of the generated string
literal, introduce a template, or name a method other than `dereference` (the expansion is a fixed template
around a `JSON.stringify`d match). The In render shows the EXPANDED source (`@tool:` is not JS, so a highlighter mangles the line or
gives up) with a `note` saying how many expanded and `marks` for where; the model's own text stays in
`arguments.js` for the raw view, and the note is what stops the two reading as a contradiction.

**The timeline splits a remote step** into `net` / `queue` / `tool` phases — but ONLY because the executor
reports its own numbers (`ToolResult.remoteMs` → the step → `model-stats`). Our `toolMs` is wall clock
around the whole dispatch, so it contains the network and the far end's overhead; `tool` is what the
executor said it spent evaluating, `queue` what it spent getting started, and `net` is the REMAINDER, drawn
first because the request has to arrive before anything happens (the return leg is folded in with it, since
nothing measures the two halves apart). A local tool is all `tool`, which is exactly true rather than a
fallback. An executor claiming MORE time than we measured is ignored rather than drawn backwards, and a
queue longer than what remains is clamped.

A patched Ollama behind a STOCK OpenWebUI is fine — the `/ollama/*` passthrough is generic, so the
OpenWebUI fork is not needed for the capacity work.
