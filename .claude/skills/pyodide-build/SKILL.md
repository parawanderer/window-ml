---
name: pyodide-build
description: Rebuild the Pyodide core from the restricted-mode CPython fork (tools/build-pyodide-restricted.mjs), publish it as a release on the fork, and bump the one pin (tools/pyodide-dist.json) that `npm run fetch-pyodide` and CI read. Use when the fork's commit moves, Pyodide or emscripten is upgraded, or python_exec must run a core you built locally.
---

# pyodide-build

Notes, traps and the numbers: `docs/dev/pyodide-build.md`.

```bash
# 1. change the pin in tools/pyodide-dist.json, then build. Hours on a clean tree. A new fork commit moves cpython.commit,
#    cpython.restrictedPySha256 and patches.count; a Pyodide upgrade moves pyodide, emscripten, abi, python, pythonArchiveSha256.
node tools/build-pyodide-restricted.mjs [--work ~/git/window-ml/tmp/pyodide-build] [--cpython ~/git/cpython-restricted] [--jobs 10]
#    run it in the background (the background-work skill); it prints the tarball's sha256 and writes BUILD_REPORT.md.
#    The work dir defaults to MAIN's tmp/ from any clone, so the emsdk + Pyodide tree outlives the clone; a rerun rebuilds only CPython

# 2. try it locally without publishing: unpack the tarball into pyodide-core/, then build the extension.
#    --core checks the tarball against the pin's artefact.sha256, so set artefact (sha256, tag, name, url) first.
node scripts/fetch-pyodide-wheels.mjs --core <work>/pyodide-restricted-<pyodide>-<sha8>.tar.gz
npm run build && node scripts/test.mjs python && npx playwright test tests/e2e/python-stream.spec.mjs

# 3. publish on the fork, then put the sha256 (and tag/url) in tools/pyodide-dist.json
gh release create <tag> <tarball> -R parawanderer/cpython --target <fork commit> --notes "<fork commit, Pyodide, emscripten, sha256>"
```

The vector test (`tests/python-dialect-vectors-wasm.test.mjs`) self-skips on the stock core. A host trap during the build is
almost always one of the four in the recipe's header.
