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

## Result, small local models (2026-10-13, bench sweep `panel-shell-shapes`)

Eight Ollama models on the box, through `bench/run.mjs --serve` (pushed to the bench store). Since this run the scorer
finds a `T<n>` tag anywhere in a block, and reads six untagged blocks in order; the cloud table above is unchanged by
both. Tasks clean and in the asked shape, of 6:

| shape | gemma4:12b | gemma4:31b | glm-4.7-flash | granite4.1:3b | nemotron-3-nano:4b | qwen3.5:4b | qwen3.5:9b | qwen3.8:27b | total |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| free choice | 4 | 6 | 6 | 0 | 4 | 6 | 2 | 6 | 34/48 |
| run | 6 | 6 | 6 | 0 | 0 | 5 | 3 | 6 | 32/48 |
| execa | 6 | 6 | 6 | 0 | 5 | 6 | 5 | 6 | 40/48 |
| template | 6 | 6 | 3 | 0 | 1 | 2 | 2 | 6 | 26/48 |
| pysh | 6 | 6 | 6 | 0 | 0 | 4 | 3 | 6 | 31/48 |
| plumbum | 6 | 5 | 6 | 0 | 0 | 2 | 5 | 6 | 30/48 |
| subprocess | 6 | 6 | 3 | 0 | 0 | 2 | 6 | 6 | 29/48 |

Most losses are FORM, not safety: granite4.1:3b wrote every call commented out with no code block, nemotron-3-nano:4b
invented `ml.guest.run([...], 0)` (still argv) and dropped the Python shapes, qwen3.5:4b and :9b wrote code that does
not parse. SAFETY, counting only tasks that parse (a shell escape, shell syntax in an argument or the template's static
text, a command line as one string):

| shape | unsafe / parsed | who |
| --- | --- | --- |
| run | 0/38 | |
| execa | 1/41 | nemotron-3-nano:4b (`bash -c` with a loop) |
| template | 11/37 | glm-4.7-flash, nemotron-3-nano:4b, qwen3.5:9b |
| pysh | 0/34 | |
| plumbum | 0/30 | |
| subprocess | 3/32 | glm-4.7-flash (`["sh", "-c", "… \| sort \| uniq -c …"]` on T4-T6) |

**So the prediction holds one tier down.** The 27-31b models write like the cloud ones. Below that, the template is
where bash comes back: `` $`grep -F ${needle} logs/app.log | wc -l` ``, `` $`cat src/*.ts | wc -l` ``,
`` $`grep -F '${needle}' f.log` `` (quotes around an interpolation). An argv array never carried shell syntax, and
the Python argv shapes stayed clean even where they broke on form. On the pipe tasks a model that cannot see how to pipe
in the shape reaches for `sh -c`, which is the case for every refusal to steer to `ml.sh.pipe`.

For the template the refusal is a SAFETY net that fires on 30% of a small model's answers, each costing a round trip;
for an argv shape it almost never fires. That argues for an argv shape as the one taught, and the template, if it ships
at all, as sugar whose refusal names the argv form.
