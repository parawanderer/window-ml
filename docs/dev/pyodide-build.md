# The Pyodide core built from the restricted-mode fork

`python_exec` runs a Pyodide **core** (`pyodide.mjs`, `pyodide.asm.mjs`, `pyodide.asm.wasm`, `python_stdlib.zip`,
`pyodide-lock.json`) built from `parawanderer/cpython` branch `ml/restricted-mode`, so the dialect's restriction is
enforced under wasm and not only in the desktop tests. The wheels stay stock: the fork changes no object header and no
stable-ABI surface, so the `cp314-pyemscripten_2026_0_wasm32` wheels from the Pyodide CDN keep working.

## One pin

`tools/pyodide-dist.json` holds the Pyodide tag, CPython and emscripten versions, the fork commit, the patch-export rule
and the artefact (`tag`, `url`, `sha256`). The recipe, `npm run fetch-pyodide` and the CI cache keys all read it.
Hosting is a GitHub release on the fork (Shane's decision, 2026-10-19), tagged `pyodide-<pyodide>-ml-<fork sha8>`;
window-ml pins and verifies, as `scripts/fetch-hub.mjs` does for the hub binary.

## The flow

- `tools/build-pyodide-restricted.mjs` exports the fork's patches (`git format-patch v3.14.2..<commit> --start-number 10`,
  excluding `Tools/restricted`), checks the Pyodide tag's `Makefile.envs` against the pin, drops the 11 patches after
  Pyodide's own `0001`-`0009`, runs `make all-but-packages`, and packs the five core files.
- `scripts/fetch-pyodide-wheels.mjs` downloads the tarball into `pyodide-core/`, verifies the sha256 BEFORE unpacking,
  then fetches the wheels. An artefact with no sha256 is skipped. `--core <tarball>` installs a local build.
- `build.mjs` copies `pyodide-core/` into `dist/pyodide/`, else the stock npm core with a warning.

## Traps

- **Host tools.** The recipe needs GNU sed and GNU patch first on PATH (Pyodide's own dependency check never fails on BSD
  ones), `autoreconf`, and `CMAKE_POLICY_VERSION_MINIMUM=3.5` under CMake 4. `emsdk_env.sh` strips every PATH entry inside
  the emsdk tree, and emsdk's own ccache segfaults on macOS arm64: the recipe's shim dir carries a pass-through `ccache`.
- **A failed build leaves a half-made install tree** (`cpython/installs/`) that a rerun trusts; delete `cpython/installs`
  and `cpython/build/hiwire` before retrying from a failure.
- **The stdlib zip drops `test/`**, so `Lib/test/test_restricted.py` is not in the core; `restricted.py` is.
- **The vectors under wasm** (`tests/python-dialect-vectors-wasm.test.mjs`) self-skip on the stock core (no `_restricted`).
  Two halting vectors are pinned as `WASM32_GAPS`: wasm32 cannot make the allocation, so the cell ends in
  `MemoryError`/`OverflowError` and not `NotInDialect`. The test fails when the fork refuses them; delete the entry then.
