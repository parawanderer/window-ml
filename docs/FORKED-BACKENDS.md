# The forked backends

Most of `window.ml` runs against a stock Ollama behind a stock OpenWebUI. Two things do not, and this
page is the honest accounting of which — because a feature that silently needs a patched server is
worse than one that says so.

Nothing here is a hard requirement to *use* the extension. Everything degrades: the affected features
either turn themselves off or say "unknown", and the rest of the extension is unaffected.

## Ollama — `parawanderer/ollama`, branch `local/ps-gpu-attribution`

Eight commits ahead of `ollama/ollama`. Two of them (`Wire up API for info UX`, `Add CLI for info
command`) are upstream work by Daniel Hiltgen carried on the branch; the rest are local.

What it adds that the extension reads:

| Route | Field | Used by |
| --- | --- | --- |
| `GET /api/info` | `compute.supported_gpus[]` — per-device `total_memory`, `physical_memory`, `free_memory`, `runner`, `name`; `compute.system_compute` — host RAM | `ml.info()`, and every ceiling, band and share in the resource panel |
| `GET /api/ps` | `gpus[]` on a resident model — `gpu_id`, `runner`, `size_vram` | per-device attribution: which card a model is on, and how a split model is divided |
| `GET /api/ps` | `busy` on a resident model, from the runner's reference count | freezing the keep-alive countdown while the model is actually serving a request |
| `GET /api/ps` | `state` on an entry that is still loading | knowing that the entry's other fields are zeros, not measurements |

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

`state` is the smaller of the two but the sharper edge: a still-loading entry carries its name and
zeros for everything else, and Go's zero time parses to a deadline in the year 1 — a countdown of minus
two thousand years, which is what a probe on the box actually printed. Read `state` before reading
anything else on an entry; its absence means resident.

**Reachability.** The extension finds Ollama through the same base discovery it uses for `/api/ps`:
`<origin>/ollama` first (OpenWebUI's passthrough), then `<origin>`. OpenWebUI proxies `/ollama/*`
generically, so a patched Ollama behind a *stock* OpenWebUI answers `/ollama/api/info` fine — the
OpenWebUI fork below is not needed for any of this.

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
