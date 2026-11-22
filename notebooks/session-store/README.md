# Session store notebooks

Measurements for `docs/spec/SESSION_HISTORY_STORE.md`. Each notebook has a generator beside it (`make-<name>.py`, the
file to edit); its inputs are the committed files in `data/`, written by the script below.

- [chrome-bounds.ipynb](chrome-bounds.ipynb): slice 1, the bounds a Chrome extension actually has: how much an MV3
  service worker holds before it dies, the quota with and without `unlimitedStorage`, the largest single IndexedDB
  put and the runtime message limit. Generator: `make-chrome-bounds.py`.
- [ranged.ipynb](ranged.ipynb): one ranged reader over the shelf against an eager load, for 1, 4 and 8 sessions at
  once, each with a large directory, and what eager saves on small files (FILE_ATTACHMENTS.md, "`/files/` read by
  range, and `ml.fs`"). Generator: `make-ranged.py`.

The scripts, each saying how to run it in its header:

- `measure-chrome.mjs` (with `probe-ext/`, a worker and a page): loads the probe extension into the e2e harness's
  Chromium, without and with `unlimitedStorage`; writes `data/chrome.json`.
- `measure-ranged.mjs` (with `probe-ext/reader-worker.js`): the lazy and eager readers over IndexedDB Blobs; writes
  `data/ranged.json`.
