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

## Result, first run (2026-10-13, six cloud models, console surface)

Sweep: `panel-shell-shapes-1791916404128` (deepseek-v4-pro, deepseek-flash, gemini-flash-latest, claude-opus-5-5,
kimi-k3, gpt-6-luna). Tasks clean and in the asked shape, of 6, after fixing the scorer's `run` pattern to count
`ml.sh.pipe` as that shape:

| shape | dsf | dsp | opus | gemini | kimi | luna | total |
| --- | --- | --- | --- | --- | --- | --- | --- |
| free choice | 6 | 6 | 6 | 6 | 6 | 6 | 36/36 |
| run | 6 | 6 | 6 | 6 | 6 | 6 | 36/36 |
| execa | 6 | 6 | 6 | 6 | 6 | 6 | 36/36 |
| template | 6 | 6 | 6 | 6 | 6 | 6 | 36/36 |
| pysh | 6 | 6 | 6 | 6 | 6 | 6 | 36/36 |
| plumbum | 5 | 5 | 6 | 6 | 6 | 6 | 34/36 |
| subprocess | 6 | 6 | 6 | 6 | 6 | 6 | 36/36 |

The two faults are the same one: `local["sort"][]`, an empty subscript, which is not Python.

**The prediction was wrong.** No model put a quote, `|`, `*` or `$` in a template's static text, in any turn. Every
literal that needed one went through an interpolation instead: `` $`awk ${"{print $1}"} …` ``, `` `cut -d ${" "} -f1` ``,
`` `-printf ${"%s %p\n"}` ``. Nobody reached for `sh -c` or `shell=True`. The doc stated the refusals in one sentence, and
that was enough for these models on paper. The spread between shapes is near zero. Untested: small local models, and
writing inside a real loop where a refusal comes back as an error.

Free choice: the template (Gemini all six, DeepSeek Pro five) or `run` (GPT all six, Opus five); Python only from Kimi.

**What the scorer could not see, and the reviews found:**

- **Option injection survives argv.** `needle` or `ref` starting with `-` is read as an option; `ref = "--output=f"` makes
  `git diff` write a file. T1 guarded with `--` or `-e` in every turn by four models, in none by DeepSeek Flash and Kimi.
  T2: no model used `--end-of-options`, and Opus noted a trailing `--` does not protect `ref`.
- **A pipe's result is its last stage's.** A failed `find` before `sort` reads as success (Opus); asked for: per-stage
  status, pipefail-style `ok`, `okCodes` for grep's 1.
- **One approval per pipe**, showing every argv, or T6 asks five times (Opus).
- **"No shell" is not "no further process":** `find -exec`, `xargs`, `env`, git aliases, and `npm test` itself (npm runs
  scripts through `sh -c`).
- **`env` is additive here but replaces in real subprocess/execa**; in Python, `env={**os.environ}` would ship the
  sandbox's environment to the host (Opus, Kimi).
- **The borrowed names promise borrowed behaviour:** execa throws on a non-zero exit, real `sh` globs `*` by default.
- **Template:** smuggling `${" "}` and `${"{}"}` works but "nobody will invent it unprompted" (Kimi); `{}`, `+`, `:` were
  not on the refused list and models were unsure. pysh pipes nest inside-out. Pipes take no per-stage `cwd`/`env`.

Votes for what ships: `run` + `subprocess` (Opus, Kimi, GPT), template + `run` (DeepSeek Pro), execa (DeepSeek Flash),
template + plumbum (Gemini).
