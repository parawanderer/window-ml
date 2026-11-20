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
side is window-ml at `f304734d`. The harness and the wrapper's source are `notebooks/shell/one-describer/`; every
figure below is from [`notebooks/shell/one-describer.ipynb`](../../../notebooks/shell/one-describer.ipynb), which keeps
them with the commands that reproduce them.

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
| wasm opt `z` | 219,135 | 88,764 | 76,661 |
| wasm opt `s` | 244,675 | 95,110 | 80,998 |
| wasm opt `3` | 335,351 | 114,784 | 92,348 |
| TS describer, esbuild minified | 14,911 | 5,625 | 5,172 |

Time, Node 26 on darwin arm64, taken quiet (1-minute load 2.1): compile plus instantiate 0.20 ms at `z` and `s`,
0.33 ms at `3` (median of 20 fresh compiles; the slowest 1.5 ms at `z`). Per call over the vectors, median / p95: TS
1.7 / 3.3 µs; wasm `z` 39 / 402 µs, `s` 33 / 336 µs, `3` 31 / 302 µs. The wasm time is the manifest crossing the
boundary as JSON and being parsed by serde on every call (by program at `s`: `rmdir` 6 µs, `gh` 329 µs; manifests
262 B to 28 kB); passing the manifest pre-serialised saves only about 20%. A handle ABI (parse each manifest once, describe by handle) would remove that; it was not built, so the
describer's own cost is not measured.

Chrome's service worker, cold after an eviction: measured 2026-11-20 (item 2 below, the notebook's section 6).

## The five answers

**A call before the module has loaded after a worker wake.** Every `describeCall` runs in the service worker
(`planSpawn` and `shFacts`, called from `sw-shell-call.ts` and `sw-manifest-proposal.ts`); the sidebar only renders
their results. A service worker may not use top-level `await`, so there are two shapes. (a) A ready promise that each
handler awaits before its first `planSpawn`: a few milliseconds on the first call after a wake, the describer stays
synchronous inside. (b) The bytes embedded in the bundle (about 292 kB as base64 at `z`) and compiled synchronously
with `new WebAssembly.Module` when the module evaluates: no not-yet-loaded state at all, at the cost of the bundle and
a synchronous compile on every wake; Chrome compiles it synchronously in the worker (item 2 below). (a) is the
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
described when an operand is renamed). The review history agrees (the notebook's section 5): of 31 findings on the
describer's PRs in both repos, one, borderline, was caught by comparing the ports, and it is a validator gap one reader
could not have had. Every describer defect was found on one side and the other port followed.

**The size.** At `z`, about 15 times the TS describer (219 kB raw, 89 kB gzip; 16 times at gzip), against a Pyodide core the extension
already ships at 9.6 MB (`pyodide.asm.wasm`). Per call it is 18 to 23 times slower at the median, and about 0.4 ms at p95 for
the largest manifests, on a call that then spawns a process; a handle ABI should close most of that. Size and time are not
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

1. ~~The cross-check's past catches.~~ Counted 2026-11-19 from GitHub alone (window-ml #683 to #1989, window-ml-host
   #3 to #53; the notebook's section 5): 31 findings. **A** (caught by comparing the ports): 1, borderline, window-ml
   #995, where the TS `validateManifest` accepted an unknown `version` key the host's reader refuses; a validator, not
   `describeCall`, and with one reader the gap could not exist. **B** (one copy would have caught it: a vector, the red
   team, a review of one side): 15, the awk splice among them. **C** (a cost of two: a port lagging, an order
   mismatch, a pin bump, message text): 14. Unclear: 1 (#882 with host #19, a gap in both ports that the red team found
   while reading the host's side). The shared vectors never passed in one repo and failed in the other. One reader
   classed the 31 findings, and B against C is a judgment per row; `history.json` keeps each row's quote and
   reasoning.
2. ~~Compile time and memory in Chrome's service worker, cold after an eviction.~~ Measured 2026-11-20 (ruling 90;
   the notebook's section 6, raw timings in `notebooks/shell/data/one-describer/sw-cold.json`). The setup: Chromium
   151.0.7922.34 on darwin arm64, the built extension with a probe prepended to `background.js`. A control with no wasm
   ran beside shapes (a) and (b), each at `z` and `s`. Each variant had two fresh profiles of 35 wakes: stopped with
   DevTools' Stop, woken by a message from the popup page, one call alternating `rmdir` and `gh`. All 350 stopped wakes
   started a new worker, and every call was described. Chrome does not refuse the synchronous compile at 219 or 245 kB.
   What the describer adds to a cold wake over the control (the page's send to the answer, median / p95): shape (a)
   3.0 / 8.1 ms at `z` and 3.2 / 10.5 ms at `s`; shape (b) 3.2 / 8.0 ms at `z` and 5.2 / 13.0 ms at `s`. Inside the
   worker, the module is ready 12.4 ms after the script starts for shape (a), where the compile overlaps the bundle's
   own evaluation. For shape (b) it is ready after 2.2 ms, synchronously, base64 decode included. The whole wake takes
   32 to 34 ms at the median against the control's 29.0 ms. Most of that is the extension's own 3.8 MB script: the
   control alone answers 13.3 ms after its first line. One cost appears only in a fresh profile: the first compile of
   shape (a), at install, took 88 to 101 ms (4 starts), while shape (b) took 2.6 to 3.1 ms. Later wakes look like they
   read a code cache, which was not isolated. Heap after the answer (`Runtime.getHeapUsage`; `performance.memory` is
   undefined in a service worker): shape (a) adds about 220 to 240 kB, all of it embedder heap; shape (b) adds 324 to
   382 kB of JS heap, which is the base64 literal. The wasm memory is 1.7 MB in both. The caveat: the load average was
   6.5 at the start and 18.7 at the end, so other jobs were running. The control's own median round trip moved 4 ms
   between its two profiles (26.9 and 31.3 ms), as much as the describer adds, so the added figures above are upper
   bounds measured under load. Read as what the describer adds, the medians of both shapes at `z` are about 3 ms
   against a bar of 10, and the p95s about 8 ms against 50. Read as the whole wake, the control alone is already over
   10 ms.
3. A handle ABI, to measure the describer's own time.
4. The build and release pipeline in the host's CI, and its review cost in window-ml.
