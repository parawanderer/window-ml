# One describer: the host's Rust describer compiled to WebAssembly (spike, ruling 66)

Result, 2026-11-19, by `program-manifest-backfill` (session ee7315a7). A spike: nothing shipped changed. The decision
is Shane's; this file gives the numbers and the answers ruling 66 asked for, negative ones included.

## The question

window.ml describes an `ml.sh` call twice: `describeCall` in `src/shell/program-manifest.ts` (the extension), and
`describe_call` in window-ml-host's `src/manifest.rs` (the host). The shared vectors (`tests/fixtures/program-calls*`,
pinned by `VECTOR_PIN` in `tests/program-manifest.test.mjs`) hold the two to the same answers. Could the extension
run the host's describer, compiled to wasm32, and drop its own port?

Evidence both ways, as the ruling put it. Against two ports: the awk splice (#1989, host #53) needed two repairs and a
ruling to keep the ports equal (the order of the CR-LF and LF passes). Against one copy: both ports had the splice
defect and no vector carried it, so a single copy would not have caught it either.

## What was built

A wrapper crate outside both repos pulls in host `src/manifest.rs` and `src/script_grammar.rs` (host `cd82e8c`) by
`#[path]`. Neither file needed a change: the describer depends on `std`, `serde` and `serde_json` only, and built for
`wasm32-unknown-unknown` on the first try (rustc 1.99.1 stable; the host pins 1.98.1, not tried). The ABI is raw (no
wasm-bindgen): `alloc`, `dealloc`, and `describe(ptr, len)` taking JSON `{argv, manifest, version, envSet, flavour}`
and returning length-prefixed JSON, `describe_call_as` plus `harden_argv`. wasm-opt was not installed, so no figure
here has been through it.

A Node harness ran both describers on identical inputs: every vector row, then a differential fuzz. The extension
side is window-ml at `f304734d`. The harness lives in this session's scratchpad, not in the repo; it becomes a
notebook if the decision wants it rerun.

## The numbers

Vectors: 532 rows (507 plain, 25 flavoured, 17 programs). wasm against TS: 0 differences at every opt level. Each
against the recorded answers: 0.

Fuzz: argv mutated from the vectors (swap, duplicate, drop, spliced flags, `--`, `-`, `=`, backslash-newline, CR-LF,
astral and combining characters, NUL, lone surrogates, empty and very long strings), 2,000 calls per program, 34,000
per run. Ten runs (seeds 1 to 3 at opt `z`, `s` and `3`, and seed 7 at `z`), 340,000 calls. About 36% were described,
so both branches ran. Verdict, effects and hardened argv: 0 disagreements in every run. Every disagreement (148 to
159 per run) was one of three:

| Cause | Per run | Which side is wrong |
| --- | --- | --- |
| An astral character in a flag cluster: TS splits the surrogate pair in `why` (`-\ud83d`) | 68–80 | TS (text only) |
| Quoting in `why`: Rust `{:?}` writes `\0` and `\u{301}`, TS JSON writes `\u0000` and the raw mark | 67–75 | neither: two quoting conventions |
| A lone surrogate in argv: serde_json refuses the escape, wasm returns an error, TS describes | 4–7 | wasm, unless the wrapper fails closed |

Size, bytes (raw / gzip -9 / brotli -q11):

| Build | Raw | gzip | brotli |
| --- | --- | --- | --- |
| wasm opt `z` | 219,183 | 88,802 | 76,616 |
| wasm opt `s` | 244,731 | 95,167 | 81,126 |
| wasm opt `3` | 335,415 | 114,831 | 92,508 |
| TS describer, esbuild minified | 14,911 | 5,650 | 5,241 |

Time, Node 26 on darwin arm64: compile plus instantiate 2.1–3.0 ms (median of 20 fresh compiles; outliers 10–22 ms).
Per call over the vectors, median / p95: TS 3.2 / 6.1 µs; wasm `z` 86 µs / 3.5 ms, `s` 70 µs / 0.95 ms, `3` 66 µs /
0.75 ms. The wasm time is the manifest crossing the boundary as JSON and being parsed by serde on every call (by
program at `s`: `cat` 14 µs, `gh` 581 µs; manifests 283 B to 28 kB); passing the manifest pre-serialised saves only
about 20%. A handle ABI (parse each manifest once, describe by handle) would remove that; it was not built, so the
describer's own cost is not measured.

Not measured: anything in Chrome. Compile time in the service worker and its memory are Node figures above.

## The five answers

**A call before the module has loaded after a worker wake.** Every `describeCall` runs in the service worker
(`planSpawn` and `shFacts`, called from `sw-shell-call.ts` and `sw-manifest-proposal.ts`); the sidebar only renders
their results. A service worker may not use top-level `await`, so there are two shapes. (a) A ready promise that each
handler awaits before its first `planSpawn`: a few milliseconds on the first call after a wake, the describer stays
synchronous inside. (b) The bytes embedded in the bundle (about 292 kB as base64 at `z`) and compiled synchronously
with `new WebAssembly.Module` when the module evaluates: no not-yet-loaded state at all, at the cost of the bundle and
a synchronous compile on every wake; Chrome's limits on synchronous compile in a worker are unmeasured. (a) is the
smaller change. Either way a describer that failed to load must answer "not described" (the call asks), never throw
past the gate. The CSP already allows it (`'wasm-unsafe-eval'` in `manifest.json`), and `src/session/image-worker.ts`
already loads a module.

**The pin, and a loud absence.** The wasm is built from a host tag in the host's CI, published as a release asset, and
held in window-ml by sha256 the way `tools/pyodide-dist.json` holds the Pyodide core. The vectors keep `VECTOR_PIN`
and run against the wasm in window-ml's suite exactly as they run against the TS today. Absent or a hash mismatch:
every call asks, with a run-log record (`noteRunMechanic`) and a line in the housekeeping log. The build should refuse
without the pinned file: `pyodide-core/` is one of AGENTS.md's six silent absences, and this would otherwise be a
seventh, one that turns every `ml.sh` call into a question with no other sign.

**What replaces the cross-check two implementations give.** On this evidence, little is lost: 340,000 fuzzed calls
found no verdict-level disagreement beyond what the 532 vectors already pin, and the one defect of record (the awk
splice) was in both ports, where differential testing cannot see it. Review and the red team's targeted rows found it.
What one copy keeps: the vectors, the red-team suites, and a differential fuzz against the RECORDED vectors' mutations
with properties instead of a second port (a refused word stays refused under any splice; a described call stays
described when an operand is renamed). Not counted here: how often, before this spike, the cross-check caught a
divergence during review. The PR history of the two ports would give that figure, and it is the one number that could
turn this answer.

**The size.** At `z`, about 15 times the TS describer (219 kB raw, 89 kB gzip), against a Pyodide core the extension
already ships at 9.6 MB (`pyodide.asm.wasm`). Per call it is 20 to 30 times slower at the median, and up to 3.5 ms at p95 for the
largest manifests, on a call that then spawns a process; a handle ABI should close most of that. Size and time are not
the deciding cost.

**Whether the approach serves `riskyRegex`.** No. `riskyRegex` (`src/readonly-exec/limits.ts`) is pure string in,
verdict out, but it is the read-only exec dialect's backtracking guard, has no Rust counterpart, and is about V8's
regex semantics. There is no second port to collapse.

## Found on the way

- TS splits a surrogate pair when it quotes one character of a flag cluster in `why` (`-\ud83d`). Text only; no
  verdict changes. Rust's quoting is right.
- A lone surrogate in argv makes serde_json refuse the request. A page-supplied string can hold one; a wasm wrapper
  needs `String.prototype.toWellFormed()` before encoding, or must treat the error as "not described".
- The two `why` quoting conventions differ for NUL and combining marks. One describer would end that; two ports would
  need a vector if the text is to match.

## What a decision would still need

1. The cross-check's past catches, from the two repos' review history (above).
2. Compile time and memory in Chrome's service worker, cold after an eviction.
3. A handle ABI, to measure the describer's own time.
4. The build and release pipeline in the host's CI, and its review cost in window-ml.
