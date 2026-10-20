# Lane 5 result: the Pyodide core built from the restricted-mode fork

Built and measured by two sessions in succession: `a2228a73` (first build, release, PR #835) and `59bbce80` (Claude
Code, `claude-sonnet-5-5`; the re-pins, the vectors under wasm, the CI guard), 2026-10-19 to 2026-10-20. Plan:
[`LANE_5_PYODIDE_BUILD.md`](LANE_5_PYODIDE_BUILD.md). The build recipe's notes: [`../../dev/pyodide-build.md`](../../dev/pyodide-build.md).
Figures are from an Apple M4 with 10 cores.

## What was built

- **The recipe**, `tools/build-pyodide-restricted.mjs`: exports the fork's patch series (`v3.14.2..<commit>`, without
  `Tools/restricted`) as `0010`-onward after Pyodide's `0001`-`0009`, asserts the count and contiguity, checks the
  Pyodide tag's `Makefile.envs` against the pin, runs `make all-but-packages` under emscripten 5.0.3, collects the five
  core files and writes a tarball and a build report.
- **The pin**, `tools/pyodide-dist.json`: the one place Pyodide version, emscripten, ABI, fork commit, patch count and
  artefact (tag, URL, sha256) live. The CI cache key includes it.
- **The artefact**: a GitHub release on `parawanderer/cpython`, tag `pyodide-<pyodide>-ml-<sha8>`. Currently
  `pyodide-314.0.3-ml-b0bbaa52`, 14 patches, 6.4 MB. The wheels are stock: the fork changes no object header, so
  `pyodide-lock.json` is the npm package's.
- **The consumer**: `npm run fetch-pyodide` downloads the core into `pyodide-core/`, verifies the sha256 before
  unpacking and writes `pyodide-core/.pin`; `build.mjs` copies `pyodide-core/` into `dist/pyodide/` when present and
  throws if the `.pin` hash disagrees with the pin.
- **The acceptance test**, `tests/python-dialect-vectors-wasm.test.mjs`: all 87 `py` vectors in one Pyodide instance
  from `dist/pyodide/`, plus the build gate (`specialization`, `specialization_ft`, `tier2`, `jit` all off). It skips on
  the stock core; under `CI` a job that fetched the fork core fails if the stock core shipped.
- **Skill** `.claude/skills/pyodide-build`, AGENTS.md row.

## What was measured

- **Build time:** 448 s from nothing (emsdk, CPython, Pyodide checkout, `make all-but-packages`); 47 s incremental.
  Each work tree takes about 2.7 GB.
- **Size:** tarball 6.4 MB; unpacked wasm 9.62 MB, stdlib zip 2.55 MB, `pyodide.asm.mjs` 1.25 MB, lock 0.11 MB.
- **Vectors under wasm:** the first build (`8f6a50ab`) passed 85 of 87. "a doubling list" raised `MemoryError` and "a
  string repeated past memory" raised `OverflowError`, neither `NotInDialect`: under `--without-pymalloc` the per-cell
  byte count counted almost nothing and a 32-bit `size_t` overflowed first. Fork #2 (`de165bb7`) wrapped the MEM and OBJ
  allocator domains and judged the repeat size first: 87 of 87. Fork head `b0bbaa5` (fork #4): 87 of 87, no wasm32
  change.
- **Cost of the cap**, 1,000,000 `(i, i+1)` tuples appended in a loop, minimum of 4 alternating rounds: metered cell
  0.31 s before, 0.46 s after (about 1.5x); unmetered 0.15 s before, 0.20 s after (about 1.3x). The laptop is noisy: the
  same core ranged 0.31 to 0.45 s.
- **Not byte-reproducible:** a clean rebuild of `8f6a50ab` gave a different sha256 from the release (`pyodide.mjs`, wasm
  and stdlib zip differ; `pyodide.asm.mjs` is identical). Cause not investigated. The pin is to the released file, not
  to a rebuild.
- **CI:** a forced cache miss exercised the whole fetch path (download, sha256, unpack, `.pin`). The python genre passes
  (217 pass, 0 fail, 2 todo) and `python-stream.spec.mjs` 2 of 2 on the `b0bbaa52` core.

## What is left

- **The MEM and OBJ wrappers stay installed after the first restricted run**, which is the unmetered 1.3x. Recorded open
  in `PYTHON_DIALECT.md` (#844); batched with the next fork change.
- **The `build.mjs` mismatch throw is tested locally only.** No CI job ships a deliberately wrong `.pin`.
- **Reproducibility** (above) is uninvestigated; a rebuild cannot be checked against the release by hash.
- `annotate-diff.spec.mjs:163` is a known flake that also fails on main; the CI janitor owns it.
