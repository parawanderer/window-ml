# shell-shapes: the ml.sh API-shape paper panel

The first measurement in `docs/spec/SHELL.md`, "The API's shape": six borrowed shapes (plain `ml.sh.run`, execa,
the argv-safe `$` template, Python `sh`, plumbum, a `subprocess` shim), six everyday tasks, scored mechanically by
`shell-shapes.score.ts`. Nothing runs: it measures what models WRITE.

## Prediction, written before the first run (2026-10-13, claude-opus-5-5)

- The argv-array shapes (`run`, `execa`, `subprocess`) score best, close to all clean: an array literal cannot hide a
  metacharacter by accident.
- The `$` template scores worst despite looking most natural: 30-50% of its answers put a quote, `|` or `*` in the
  static text, mostly on T1 (quoting `needle`), T5 (the glob) and T6 (the pipe, `cut -d' '`).
- Python `sh` parses but drifts on flags; plumbum's `|` does well on T6.
- Some models reach for `shell=True` or `sh -c` on T6 in the free-choice turn.
- The spread between shapes is larger than the spread between models.
