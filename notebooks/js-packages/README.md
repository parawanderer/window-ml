# JavaScript package notebooks

The npm counterpart of [python-packages/](../python-packages/README.md): what a page-side runtime could load from npm
on demand, measured by installing and running the packages, not by reading their metadata alone. Each notebook has a
generator beside it (`make-<name>.py`, the file to edit) and its pinned inputs under `data/<name>/`.

- [npm-compat.ipynb](npm-compat.ipynb): the 1,000 most-downloaded npm packages, each installed with
  `npm install --ignore-scripts`, bundled by esbuild as a browser ES module with no Node polyfills, and evaluated in a
  module Worker in headless Chromium: how many load, what stops the rest (a Node built-in, a Node global, cross-origin
  isolation), whether a static scan of the dependency closure predicts it, and the same table as pypi-compat's.
- `npm.py`: registry reads (the ranking from `npm-high-impact`, `/latest` manifests, tarballs) and the static scan:
  the built-ins reachable from each entry file, over the package and its dependency closure.
- `sandbox.mjs`: the install, bundle and Worker evaluation, one package per job (`--top N` or a names file;
  `--shims` defines `global` and `process.env.NODE_ENV`). Each install goes to a fresh directory under the cache, never inside the repo.

Both read and write a cache at `NPMPKG_CACHE` (default: `window-ml-npm-cache` in the temp directory).
