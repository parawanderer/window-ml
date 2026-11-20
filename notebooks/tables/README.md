# Table notebooks

Each notebook has a generator beside it (`make-<name>.py`, the file to edit) and its pinned inputs under
`data/<name>/`.

- [decode-cache.ipynb](decode-cache.ipynb): what the decode of a 64 MB stored CSV costs, measured in Node's V8 rather than
  the service worker (wall time, the Arrow bytes the cache charges, what stays resident, a lower bound on the parse's
  peak), and the size of the decode cache set from it (`TABLE_DECODE_CACHE_BYTES`, 256 MiB). The figures come from `decode-bench.mjs` (`node --import tsx
  notebooks/tables/decode-bench.mjs`). Generator: `make-decode-cache.py`.
