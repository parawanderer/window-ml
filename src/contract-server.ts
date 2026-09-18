// contract-server.ts — what the BACKEND reports about itself, and how to read it.
//
// The shapes Ollama and OpenWebUI answer with (/api/ps, /api/info, the model list, the server-side tool
// surface), plus the small pure functions that interpret them: which models generate text, which produce
// embeddings, which is a grounding model, and whether a failure means the backend is unreachable rather than
// unhappy. The functions live beside the shapes deliberately -- each is the single reading of a field that
// several surfaces would otherwise each guess at. Re-exported from contract.ts.
// Type-only, so the cycle with contract.ts (which re-exports this file) erases at build entirely.
import type { JsonSchema } from "./contract";

/** Does this model generate TEXT? The right test for the chat/utility/vision pickers.
 *
 *  Measured against a real Ollama (2026-09-03): the obvious rule — "hide anything with `embedding`" — is
 *  WRONG. `qwen3-embedding:0.6b` reports `['tools','thinking','embedding']` and `:8b` reports
 *  `['tools','embedding']`, so an embedding model can advertise other capabilities too. Requiring
 *  `completion` is the semantically correct test, and no embedding model has it.
 *
 *  Unknown (null) capabilities mean a cloud/non-Ollama model, which we CANNOT classify — so it passes.
 *  Failing open matches `modelFilter`: never hide a model we merely failed to interrogate. */
export const generatesText = (caps: string[] | null): boolean => !caps || caps.includes("completion");

/** Does this model produce EMBEDDINGS? Unlike {@link generatesText} this fails CLOSED — an unclassifiable
 *  model is not offered as an embedding model, because picking one that turns out not to embed produces a
 *  confusing runtime failure rather than a mildly shorter list. A user can still name one explicitly and
 *  have it validated by an actual embed call. */
export const producesEmbeddings = (caps: string[] | null): boolean => !!caps && caps.includes("embedding");

/** Is this error message a BACKEND-UNREACHABLE failure (server down / wrong host / refused / DNS / TLS) —
 *  as opposed to an HTTP status error (a reachable server that rejected the request)? The background
 *  translates a bare fetch reject into "Couldn't reach the server at …"; this also catches the raw forms
 *  in case one slips through (Failed to fetch / NetworkError / ERR_CONNECTION_* / ECONNREFUSED / Could not
 *  reach). Pure; shared by the HUD card + the devtools panel banner so both flag the same condition. An
 *  HTTP 4xx/5xx is NOT unreachable — the box answered. */
export function isBackendUnreachable(msg?: string | null): boolean {
    if (!msg) return false;
    if (/^HTTP\s\d/i.test(msg)) return false;   // "HTTP 500 from …" = reachable, it answered
    return /couldn't reach the server|could not reach|failed to fetch|networkerror|err_connection|err_name_not_resolved|econnrefused|enotfound|net::err/i.test(msg);
}

/** What the panel should SAY about the backend, given a failure and what else it knows.
 *
 *  "The request failed" and "the box is unreachable" are different claims, and we made the second from the
 *  first. Measured on the box during a 64-second load of a 142 GB model: `/api/ps` answered every poll in
 *  0.4–0.8 ms with zero failures, every endpoint stayed under 17 ms — while the request that TRIGGERED the
 *  load produced no bytes, not even headers, for the whole 64 s. So the panel told a user to go and check
 *  their Server URL about a server that was answering it a thousand times faster than the advice took to
 *  read, and the one thing genuinely wrong was that we had nothing to say about a load in progress.
 *
 *  The rule is that a claim of unreachability needs the ABSENCE of evidence, not the presence of a failure.
 *  Anything that proves the box is answering — a `/api/ps` poll that returned, a live event stream — vetoes
 *  it, and a load in flight is reported as what it is. `aliveMs` is how long ago that proof was: it must be
 *  bounded, because the evidence going stale is exactly what a box dying looks like.
 *
 *  Pure, so the decision is tested rather than inferred from a screenshot. */
export type BackendState = "ok" | "loading" | "unreachable";

/** The ONE decision of what to show when a backend has gone quiet: ok, loading, or unreachable. Both inputs
 *  matter -- a failure that looks like unreachability is only unreachability when nothing else proves the box
 *  answered recently, and that proof has to be bounded, because evidence going stale is exactly what a box
 *  dying looks like. Pure, so the decision is tested rather than inferred from a screenshot. */
export function backendStateFrom(input: {
    /** The failure, if a request just failed. */
    error?: string | null;
    /** Ms since the last proof the box answered, or null when there has never been one. */
    aliveMs?: number | null;
    /** Models the server says are loading right now — from `/api/ps` `state: "loading"`, or a `load.start`
     *  with no close yet. A load is the reason a request hangs, so it is the answer to give instead. */
    loading?: string[];
    /** How stale the proof of life may be before it stops vetoing. Defaults to a couple of poll intervals:
     *  one missed poll is a blip, several in a row is a box. */
    aliveWindowMs?: number;
}): BackendState {
    const { error, aliveMs, loading = [], aliveWindowMs = 15_000 } = input;
    const proven = aliveMs != null && aliveMs <= aliveWindowMs;
    // A LOAD OUTRANKS A FAILURE, and only while the box is also answering. Saying "loading" about a box that
    // has gone silent would be the same mistake in the other direction — a reassuring label over a dead host.
    if (proven && loading.length) return "loading";
    // Nothing failed, or it failed for a reason that is not about reachability (an HTTP status is a server
    // ANSWERING). Either way there is no unreachability to report.
    if (!error || !isBackendUnreachable(error)) return "ok";
    // The failure looks like unreachability. It only IS unreachability if nothing else says otherwise.
    return proven ? "ok" : "unreachable";
}

/** Pick a grounding model (the one that answers "where on screen is X" with a box) out of a model list, by
 *  preference: the 7B qwen2.5vl, then the 3B, then any qwen VL. Empty string when the server has none, which
 *  is a real answer -- grounded locate is then simply unavailable rather than silently delegated. */
export const detectGroundingModel = (models: string[]): string =>
    models.find(m => m === "qwen2.5vl:7b") || models.find(m => m === "qwen2.5vl:3b") || models.find(m => /qwen.*vl/i.test(m)) || "";

/** A model resident in Ollama, from OLLAMA_PS. `vramGB` is the portion in VRAM
 *  (null when fully on CPU); `sizeGB` is the total footprint — together they
 *  reveal CPU-only (vram 0) vs partial offload (0 < vram < size) vs full GPU.
 *  `contextLength` is the num_ctx it was LOADED with — Ollama preallocates the
 *  KV cache for the whole window, so it's a big share of `vramGB` (null when the
 *  server is too old to report it). */
/** How the user can invoke the HUD composer on THIS browser, read at runtime (GET_INVOCATION).
 *  The keyboard shortcut is user-rebindable at <scheme>://extensions/shortcuts, so it must never
 *  be hardcoded in a prompt or doc — `shortcut` is whatever is bound right now, `""` when the user
 *  cleared it, and `isDefault` says whether it still matches the manifest's suggested key. */
export interface InvocationInfo {
    /** e.g. "Alt+Space"; "" when the user removed the binding */
    shortcut: string;
    /** the manifest's suggested_key for this platform */
    defaultShortcut: string;
    /** shortcut === defaultShortcut (false also when unbound) */
    isDefault: boolean;
    /** an extension context-menu entry is registered (permission declared) */
    contextMenu: boolean;
}

/** One accelerator a resident model occupies, from `/api/ps` `gpus[]`. ABSENT entirely for a CPU-resident
 *  model — that is the server's contract for "on the CPU", not a missing field. */
export interface LoadedModelGpu { id: string; runner: string; vramBytes: number;
    /** This DEVICE's own memory split, raw from the server (see LoadedModel.memory). */
    memory?: unknown }

/** A model RESIDENT in the server right now, as `/api/ps` reports it: how much it occupies, where, and for
 *  how much longer. Both rounded GB and exact bytes are carried, because the readouts want the first and the
 *  resource panel bands want the second -- rounding accumulates visible error once you subtract. */
export interface LoadedModel {
    model: string;
    vramGB: number | null;
    sizeGB: number | null;
    /** EXACT bytes, beside the rounded GB the existing readouts use. The resource panel subtracts these from
     *  exact capacity figures to size its bands, so 0.1 GB rounding would accumulate visible error. */
    vramBytes: number | null;
    sizeBytes: number | null;
    /** Which devices it sits on, and how much on each. Absent (not empty) when the model is CPU-resident. */
    gpus?: LoadedModelGpu[];
    contextLength: number | null;
    expiresAt: string | null;
    /** WHAT the VRAM holds — weights / KV cache / compute / projector / … — carried RAW and parsed once by
     *  `memorySplit`, which checks the server's sum-to-`size_vram` invariant in one place instead of at every
     *  consumer. Needs a patched Ollama; absent means the server cannot split this figure, never that the
     *  parts are zero. */
    memory?: unknown;
    /** The same shape for whatever did NOT fit on a GPU. Present only on a spill. */
    memoryHost?: unknown;
    /** The size of the files it loaded from — beside the split, never inside it: it is not resident memory. */
    weightsOnDisk?: number;
    /** WHICH LAYERS went where, raw from the server and parsed once by `placementFrom`. Opt-in on the server
     *  (`OLLAMA_LAYER_PLACEMENT=1`), so absent is the normal case and means "not reported". */
    placement?: unknown;
    /** Whether this runner is SERVING a request right now, from its reference count. It is the only way to
     *  read `expiresAt` correctly: the deadline is rewritten when a request FINISHES, so during a generation
     *  it stands still while a countdown drawn against it keeps running down, and on a long enough one it
     *  crosses zero. It also covers traffic we never see (another client, a script, a terminal), which no
     *  local in-flight flag can. ABSENT on a stock server, which means "not known", never "idle". */
    busy?: boolean;
    /** The runner's lifecycle state. A `"loading"` entry carries its NAME and zeros for everything else,
     *  `expires_at` included, so every other field on it is "not yet known" rather than a measurement.
     *  Absent means resident. Both fields need a patched Ollama (see docs/FORKED-BACKENDS.md). */
    state?: string;
    /** WHAT THE RUNNER IS DOING and how full its KV cache is, raw from the server and parsed once by
     *  `activityFrom`. Read out of `llama-server`'s `/slots`, which ollama did not consult until the
     *  `activity3` build — so absent means "the runner could not be asked" (still loading, a backend with no
     *  `/slots`, a failed poll, or any older server), never "idle". Idle is a value it reports. */
    activity?: unknown;
    /** The DECODE CEILING the server computed for this placement, raw, parsed once by `rooflineFrom` — or its
     *  reason for not computing one (`{unavailable: "mixture_of_experts" | "partly_on_cpu" | …}`). Absent on a
     *  model on no GPU and on every server that predates it. */
    roofline?: unknown;
    /** The decode speed PREDICTED for this placement, raw, parsed once by `expectedDecodeFrom` — or its reason for
     *  having none (`{unavailable: "profile_pending" | "partly_on_cpu" | "memory_unknown"}`). Absent on a model on
     *  no GPU, on a `loading` row, and on every server before `ollama-slop:correction`. */
    expectedDecode?: unknown;
    /** WHICH BUILD of the model this is: its quantization (`"Q4_K_M"`), parameter size (`"27B"`) and family,
     *  from `details` on `/api/ps` — which stock Ollama sends too. The quant is the one users choose between
     *  (the same model at Q8_0 and Q4_K_M differs in size, speed and quality), and the name usually does not
     *  say which was pulled. Absent on a `loading` row, which reports every one of them as "". */
    quant?: string;
    paramSize?: string;
    family?: string;
}

/** One accelerator the machine has, from `/api/info` `compute.supported_gpus[]`. All memory figures are raw
 *  BYTES and all are BINARY — render through `formatBytes` (resource-model.ts), never a hand-rolled /1e9. */
export interface GpuInfo {
    gpu_id: string;
    name: string;
    runner: string;
    /** cuDeviceTotalMem — what ollama places against. */
    total_memory: number;
    /** The DRIVER's framebuffer total (what nvidia-smi shows). Newer servers only; absent on older ones. */
    physical_memory?: number;
    free_memory: number;
    /** CUDA/ROCm only — absent on Metal, which is itself a signal of unified memory. */
    compute?: string;
    driver?: string;
}

/** The HOST's own compute and memory, from the patched Ollama `/api/info` -- what is left for a model that
 *  spills off the GPU, and the pool itself on a unified-memory box. Every field is optional because a stock
 *  server reports none of it: absent means "this server does not say", never zero. */
export interface SystemCompute {
    cpu_cores?: number;
    total_memory: number;
    free_memory: number;
    /** 0 on macOS whether or not swap exists — treat 0 as UNKNOWN, not as "no swap". */
    free_swap?: number;
}

/** `/api/info` — the machine's CAPACITY, as opposed to `/api/ps`'s residency. Only a patched Ollama +
 *  OpenWebUI serves this route; everything else answers with the SPA's HTML, which is why `ml.info()`
 *  resolves to `null` rather than throwing. */
export interface OllamaInfo {
    models?: { store?: string; count?: number; filesystem_used?: number; running?: number; vram_used?: number };
    compute: { system_compute: SystemCompute; supported_gpus?: GpuInfo[] };
}

/** One function exposed by an OpenWebUI server-side tool. A tool bundles several
 *  (a Python tool class = one function per method), which is why `toolIds` selects
 *  the BUNDLE while the model calls an individual `name`. */
export interface ServerToolFunction {
    name: string;
    description: string;
    /** JSON-Schema parameters, exactly as the model would be shown them. */
    parameters: JsonSchema | null;
}

/** An OpenWebUI server-side tool, as listed by `ml.serverTools()`. `id` is what you
 *  pass in `ml.chat`'s `toolIds`. `kind` distinguishes a local Python tool from a
 *  proxied OpenAPI/MCP tool server — the servers list as a single entry whose
 *  functions OpenWebUI only resolves at call time, hence the empty `functions`. */
export interface ServerTool {
    id: string;
    name: string;
    description: string;
    kind: "local" | "openapi" | "mcp";
    functions: ServerToolFunction[];
}

/**
 * What `ml.execServerTool` resolves to.
 *
 * The two failure kinds are DIFFERENT SHAPES on purpose, because only one is something a model can act on.
 * `ok: true` with an `error` on the result is a tool that ran and threw — a normal step outcome to read and
 * correct. `ok: false` is a stream that could not be read at all, and reporting THAT to a model as a tool
 * returning nothing is a wrong answer dressed as an empty one, which it has no way to detect.
 */
export interface ServerToolResult {
    ok: boolean;
    /** The terminal frame, when the stream completed. Carries the tool's value or its `error`, plus the
     *  executor's own `durationMs`/`queuedMs` — which is what makes a remote span attributable at all. */
    result?: { result?: unknown; error?: string; name?: string; durationMs?: number; queuedMs?: number; truncated?: number };
    /** Why the stream could not be read, when `ok` is false. Never a tool's own failure. */
    transportError?: string;
    /** Everything the tool streamed. Human-facing: what the MODEL receives is `result.result`. */
    output: string;
    /** `[offset in output, epoch ms]`, anchored from the executor's offsets. Only where it stamped one. */
    marks: [number, number][];
    /** Structural frames (progress, attachments) — deliberately not folded into `output`. */
    events: { type: "event"; event: Record<string, unknown>; atMs?: number }[];
}
