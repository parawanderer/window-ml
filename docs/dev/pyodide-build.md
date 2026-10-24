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
  ones), `autoreconf`, `wget` (`cpython/Makefile` fetches the CPython source with it; the preflight checks it since
  2026-10-24, when its absence surfaced only after emsdk had built), libtool (libffi's `autoreconf` fails on an undefined
  `LIBTOOL` without its m4), and `CMAKE_POLICY_VERSION_MINIMUM=3.5` under CMake 4.
  `emsdk_env.sh` strips every PATH entry inside the emsdk tree, and emsdk's own ccache segfaults on macOS arm64: the
  recipe's shim dir carries a pass-through `ccache`.
- **Moving the fork commit moves three pin fields**: `cpython.commit`, `cpython.restrictedPySha256` (the commit's
  `Lib/restricted.py`) and `patches.count`, the number of commits `format-patch` exports from base to commit with
  `Tools/restricted` excluded. The recipe refuses a count that disagrees (`ca282158`, 2026-10-24: 21 to 24).
- **A shallow `--cpython` clone is not used**: `format-patch` needs the whole range down to the base, so the recipe
  makes its own full clone of the fork in the work dir instead, which adds a clone to a clean build.
- **A failed build leaves a half-made install tree** (`cpython/installs/`) that a rerun trusts; delete `cpython/installs`
  and `cpython/build/hiwire` before retrying from a failure.
- **Pyodide's make applies the CPython patches once, when it unpacks the source**, and skips CPython while its install
  stamp and stdlib exist, so a moved fork commit used to be packed as the OLD interpreter under the new name (the
  symptom: a 15 s build that holds none of the branch's code). The recipe stamps the patch set's hash
  (`cpython/.ml-patchset`) and, when it changes, clears the patched source, the installed stdlib and `libpython` first:
  a new commit costs about 5 minutes, a rerun of the same one about 15 s.
- **A link failure on undefined `_Py_LibHacl_*`** means parallel make generated CPython's Makefile before
  `Modules/Setup.local`'s rules were in it, so `libpython` was archived without the HACL hash builtins. Touch
  `cpython/build/Python-<ver>/Modules/Setup.local`, delete `libpython3.*.a` (build and install trees) and
  `cpython/.installed-pyodide`, then rerun (lane 12's release build of `0169c4fd`).
- **The core's `restricted.py` is checked twice.** The recipe fails the build unless the zip's file is the pinned
  commit's, byte for byte, and `cpython.restrictedPySha256` in the pin must be that file's hash;
  `tests/python-dialect-vectors-wasm.test.mjs` fails a shipped core whose file does not hash to it. The first `77376876`
  release (`pyodide-314.0.3-ml-77376876`) was built on a stale tree and carried `a9f034a2`'s `restricted.py` with
  `77376876`'s C: replaced by `-r2`, 2026-10-21.
- **The stdlib zip drops `test/`**, so `Lib/test/test_restricted.py` is not in the core; `restricted.py` is.
- **The vectors under wasm** (`tests/python-dialect-vectors-wasm.test.mjs`) self-skip on the stock core (no `_restricted`).
  Under CI they FAIL instead of skipping once an artefact sha256 is pinned. All 87 pass on the wasm32 build: with
  `--without-pymalloc` the memory cap wraps the MEM and OBJ allocator domains (fork #2), and a repeat's size is judged
  before CPython's overflow guards, so "a" * 10**11 ends in `NotInDialect`, not `OverflowError`.
- **The regex corpus** (the `regex` entries of `tests/fixtures/dialect-vectors/halting.json`) is checked against the
  fork's own `restricted.py` by its `Lib/test/test_restricted.py`, not against the shipped core: a core older than the fork
  (today 0169c4fd, before #10 and #11) carries the older regex check until it is rebuilt.
