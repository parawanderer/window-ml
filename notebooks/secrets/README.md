# Secrets notebooks

Measurements for `docs/spec/SECRET_HANDLES.md`. Each notebook has a generator beside it (`make-<name>.py`, the file to
edit); its inputs are the committed files in `data/`, written by the script below.

- [mask-matcher.ipynb](mask-matcher.ipynb): ruling 32's hash-only matcher at 64 entries on a 1 MiB result: the forms a
  secret really gives, the false candidates, the filter pass against the plaintext scrub, the slow confirm's cost, and
  one filter hit against the pass's spread (the timing oracle). Generator: `make-mask-matcher.py`.

The script, which says how to run it in its header:

- `measure-matcher.mjs`: runs the matcher in Node with the forms from the registry's `valueForms` (`secret-registry.ts`, from #1948); writes
  `data/mask-matcher/matcher.json`.
