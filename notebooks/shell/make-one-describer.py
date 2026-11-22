"""make-one-describer.py — builds one-describer.ipynb: the host's Rust describer compiled to wasm, run beside window.ml's TS port.

    .venv/bin/python notebooks/shell/make-one-describer.py && node scripts/nb.mjs run notebooks/shell/one-describer.ipynb
    (or: node scripts/nb.mjs make notebooks/shell/one-describer.ipynb)

The cells are written here; edit this file, not the notebook. Their numbers come from data/one-describer/, pinned from
the harness's raw output in one-describer/out/ (gitignored). To measure again: `WML_HOST=<window-ml-host checkout> sh
notebooks/shell/one-describer/build.sh`, then the scripts named in the first cell, then NB_REFRESH=1. Section 7 (the run
with resolution) is built from the host's own `tools/build-describer.sh` and `one-describer/fuzz-resolved.mjs`.
"""

from pathlib import Path

import nbformat as nbf

HERE = Path(__file__).resolve().parent
cells = []
md = lambda s: cells.append(nbf.v4.new_markdown_cell(s.strip()))
code = lambda s: cells.append(nbf.v4.new_code_cell(s.strip()))

md("""
# One describer: the host's Rust describer as wasm, beside the TS port

Ruling 66's spike; the argument and the five answers are `docs/plan/repl/ONE_DESCRIBER_WASM_SPIKE.md`, which cites
this notebook for its figures. A decision (Shane's) rests on them, so they are kept here.

window.ml describes an `ml.sh` call in TypeScript (`describeCall`, `src/shell/program-manifest.ts`); window-ml-host
describes it again in Rust (`describe_call`, `src/manifest.rs`), and the shared vectors hold the two together. The
question: could the extension run the Rust describer compiled to `wasm32-unknown-unknown` and drop its own port?

**Method.** `one-describer/wrapper/` pulls the host's `src/manifest.rs` and `src/script_grammar.rs` in unmodified by
`#[path]` behind a raw ABI (JSON in, JSON out; no wasm-bindgen; no wasm-opt). `build.sh` builds it at opt `z`, `s`
and `3`. Then, from `notebooks/shell/one-describer/` with `node --import tsx`:

- `vectors.mjs <opt>`: every shared vector row through both describers, and each against the recorded answer.
- `fuzz.mjs 2000 <seed> <opt>`: 2,000 calls per program mutated from the vectors (swap, duplicate and drop
  arguments, flags spliced from the manifest, `--`, `-`, `=`, backslash-newline, CR-LF, astral and combining
  characters, NUL, lone surrogates, long strings), both describers, every disagreement grouped by the fields that
  differ and minimised.
- `sizes.mjs`; `bench.mjs` (compile, instantiate, per-call time); `bench2.mjs` (per program, and with the manifest
  JSON pre-serialised).

Normalisation before comparing: TS effects go through `effectKey`, as the vector test does; effect lists are sorted
(Rust sorts bytewise, JS by UTF-16 unit); object keys are sorted.
""")

code("""
import json
from pathlib import Path
import pandas as pd
import wmlnb

HERE = wmlnb.ROOT / "notebooks" / "shell"
OUT = HERE / "one-describer" / "out"
DATA = HERE / "data" / "one-describer"
VECTOR_FIELDS = {"described", "effects", "pathArgs", "actsOnDir", "runner", "okCodes", "echoes", "recursive", "hardened"}
pd.set_option("display.width", 160); pd.set_option("display.max_colwidth", 120)

def read_out():
    rows = [{"kind": "build", **json.loads((OUT / "build.json").read_text())},
            {"kind": "sizes", **json.loads((OUT / "sizes.json").read_text())},
            {"kind": "bench", **json.loads((OUT / "bench.json").read_text())},
            {"kind": "bench-by-program", **json.loads((OUT / "bench-by-program.json").read_text())}]
    for p in sorted(OUT.glob("vectors-*.json")):
        v = json.loads(p.read_text())
        rows.append({"kind": "vectors", **v})
    for p in sorted(OUT.glob("fuzz-*.json")):
        f = json.loads(p.read_text())
        # Keep each group's count, programs and up to 3 examples: the full examples stay in out/.
        f["groups"] = [{**g, "examples": g.get("examples", [])[:3]} for g in f["groups"]]
        rows.append({"kind": "fuzz", **f})
    return rows

rows = wmlnb.extract(DATA / "results.json", read_out, source={"harness": "notebooks/shell/one-describer/", "out": "notebooks/shell/one-describer/out/*.json"})
of = lambda k: [r for r in rows if r["kind"] == k]
build = of("build")[0]
pd.DataFrame(wmlnb.provenance(DATA / "results.json")).assign(host=build["host"][:12], rustc=build["rustc"])
""")

md("""
## 1. The vectors: 0 differences is the bar

Every row of `tests/fixtures/program-calls/` and `program-calls-flavoured/`, through both describers, at every opt
level. `wasmVsTs` counts rows where any output field differs; the two `…VsRecorded` columns compare the nine fields the
vector tests compare.
""")

code("""
pd.DataFrame([{k: v[k] for k in ("opt", "rows", "plain", "flavoured", "wasmVsTsDiffs", "wasmVsRecorded", "tsVsRecorded")} for v in of("vectors")])
""")

md("""
## 2. The differential fuzz: does the second port catch what the vectors do not?

A disagreement is **verdict-level** when it touches a field the vectors compare (described, effects, path arguments,
the hardened argv, …). Anything else is the `why` text or an error from the wasm side.
""")

code("""
def level(cause):
    if cause.startswith("WASM-ERROR"): return "wasm error"
    fields = set(cause.split(" / ")[0].split("+"))  # fuzz.mjs joins the differing fields with "+"
    return "verdict" if fields & VECTOR_FIELDS else "text"

# A split on the wrong separator would class every cause as text and make the verdict count 0 by construction.
assert level("described+effects") == "verdict" and level("why+effects / x") == "verdict"
assert level("why / why:non-ascii-quoting") == "text" and level("WASM-ERROR / lone-surrogate-in-argv") == "wasm error"

runs = []
for f in of("fuzz"):
    by = {"verdict": 0, "text": 0, "wasm error": 0}
    for g in f["groups"]: by[level(g["cause"])] += g["count"]
    runs.append({"opt": f["opt"], "seed": f["seed"], "calls": f["total"], "described by TS": f["tsDescribed"], "disagreements": f["disagreements"], **by})
runs = pd.DataFrame(runs).sort_values(["opt", "seed"])
display(runs)
print(f"{len(runs)} runs, {runs.calls.sum():,} calls, verdict-level disagreements: {runs.verdict.sum()}")
""")

code("""
causes = pd.DataFrame([{"opt": f["opt"], "seed": f["seed"], "cause": g["cause"], "level": level(g["cause"]), "count": g["count"]} for f in of("fuzz") for g in f["groups"]])
causes.pivot_table(index=["level", "cause"], columns=["opt", "seed"], values="count", fill_value=0)
""")

md("""
One example of each cause (seed 1, opt `z`). The astral case is TS splitting a surrogate pair when it quotes one
character of a flag cluster; the quoting case is Rust's `{:?}` (`\\\\0`, `\\\\u{301}`) against JSON (`\\\\u0000`, the raw
mark); a lone surrogate is refused by serde_json, so the wasm side errors where TS describes.
""")

code("""
import re
# A lone surrogate is one of the findings, and Jupyter cannot send one as UTF-8: show each value as JSON with surrogates escaped.
shown = lambda x: re.sub("[\\ud800-\\udfff]", lambda m: f"\\\\u{ord(m.group()):04x}", json.dumps(x, ensure_ascii=False))
f1 = next(f for f in of("fuzz") if f["opt"] == "z" and f["seed"] == 1)
pd.DataFrame([{"cause": g["cause"], **{k: shown(g["examples"][0].get(k)) for k in ("argv", "wasm", "ts")}} for g in f1["groups"] if g["examples"]])
""")

md("""
## 3. Size

The TS describer is `describeCall` and what it imports, bundled and minified by esbuild. The extension already ships
Pyodide's `pyodide.asm.wasm` at about 9.6 MB.
""")

code("""
s = of("sizes")[0]
sizes = pd.DataFrame([{"build": k, **v} for k, v in s.items() if k != "kind"]).set_index("build")
ts = sizes.loc["ts-describeCall"]
sizes.assign(**{f"x TS {c}": (sizes[c] / ts[c]).round(1) for c in ("raw", "gzip", "brotli")})
""")

md("""
## 4. Time (Node, this machine)

Compile and instantiate: median of 20 fresh compiles. Per call: every vector row, 25 timed passes after 5 warm-up
passes. None of this is Chrome's service worker, which is unmeasured.
""")

code("""
b = of("bench")[0]
print(b["node"], b["platform"], "load average", [round(x, 2) for x in b["loadavg"]])
display(pd.DataFrame(b["instantiate"]).T.round(2))
pd.DataFrame(b["latency"]).T.round(1)
""")

md("""
Where a wasm call's time goes (opt `s`): it grows with the manifest, because the whole manifest crosses as JSON and
serde parses it on every call. Pre-serialising it in JS saves only the stringify. A handle ABI (parse once, describe
by handle) was not built, so the describer's own cost is not separated.
""")

code("""
bp = of("bench-by-program")[0]
per = pd.DataFrame([{"program": p, "manifest bytes": v["manifestJsonBytes"], "ts µs": v["ts"]["medianUs"],
                     "wasm µs": v["stringifyEachCall"]["medianUs"], "wasm pre-serialised µs": v["preSerialised"]["medianUs"]}
                    for p, v in bp["byProgram"].items()]).sort_values("manifest bytes")
display(per.set_index("program"))
print("all rows, median / p95 µs:", bp["all"])
""")

md("""
## 5. What the cross-check caught in review

The number ruling 66's answer turns on: of the describer's PRs in both repos, how often did the SECOND port catch a
defect one copy would not have. Read from GitHub only (reviews, review comments, issue comments, commits); each
finding classed A (caught by comparing the ports), B (one copy would have caught it: a vector, the red team, a review
of one side), C (a cost of having two: one port lagging, an order mismatch, a pin bump, no defect), or unclear.
""")

code("""
def read_history():
    return json.loads((OUT / "history.json").read_text())

hist = wmlnb.extract(DATA / "history.json", read_history, source={"method": "gh only: PRs touching the describer's files in parawanderer/window-ml and parawanderer/window-ml-host; see the spike doc"})
h = pd.DataFrame(hist)
display(h["class"].value_counts().rename("findings").to_frame())
h[h["class"] == "A"]
""")

md("""
## 6. A cold wake in Chrome's service worker (ruling 90)

Ruling 90 asked for this before anything is built: in the real built extension, in a real Chromium, after the worker
is stopped, how long from the wake to a first described call. Ruling 90's bar is a median of at most 10 ms and a p95
of at most 50 ms for the chosen shape.

`one-describer/sw-cold.mjs` builds the extension once and makes five copies with a probe prepended to `background.js`:
`control` (the probe, no wasm), shape (a) at `z` and `s` (`describe.wasm` in the folder, `compileStreaming` started at
the top of the script, the message handler awaits it), and shape (b) at `z` and `s` (the bytes as a base64 literal,
`new WebAssembly.Module` and `Instance` run synchronously at the top). Each copy runs in two fresh profiles. Each
profile has 35 wakes: CDP `ServiceWorker.stopAllWorkers` (DevTools' Stop), wait until the target is gone, then
`chrome.runtime.sendMessage` from the extension's popup page. Each wake makes one call, alternating `rmdir` (the smallest
manifest) and `gh` (the largest). The install-time start is kept apart: it is the profile's first compile.

Three figures per wake, in ms:
- **init**: script start to the module being ready (shape (b): instantiated; shape (a): the promise resolved).
- **in worker**: script start to the first call's answer. This leaves out parsing the script before its first line,
  which is what shape (b)'s 330 kB literal adds.
- **round trip**: the page's send to the answer, the whole cold wake.

Each wasm variant's figure minus the control's median is what the describer adds.
""")

code("""
def read_sw_cold():
    d = json.loads((OUT / "sw-cold.json").read_text())
    keep = ("variant", "launch", "wake", "initial", "cold", "program", "loadavg1", "goneMs", "error", "describedField", "i", "ii", "iii")
    rows = [{"kind": "meta", **d["meta"]}]
    for r in d["records"]:
        rows.append({"kind": "wake", **{k: r.get(k) for k in keep}, "T": r.get("T"),
                     "heapUsed": (r.get("heap") or {}).get("usedSize"), "embedderHeapUsed": (r.get("heap") or {}).get("embedderHeapUsedSize"),
                     "wasmMemoryBytes": (r.get("mem") or {}).get("wasmBytes")})
    return rows

sw = wmlnb.extract(DATA / "sw-cold.json", read_sw_cold, source={"harness": "notebooks/shell/one-describer/sw-cold.mjs", "out": "notebooks/shell/one-describer/out/sw-cold.json"})
swmeta = next(r for r in sw if r["kind"] == "meta")
w = pd.DataFrame([r for r in sw if r["kind"] == "wake"])
print(swmeta["chrome"], swmeta["platform"], "| load average at start", [round(x, 1) for x in swmeta["loadavgStart"]], "at end", [round(x, 1) for x in swmeta["loadavgEnd"]])
print("wasm sha256:", {o: v["sha256"][:12] for o, v in swmeta["wasm"].items()}, "| background.js growth, bytes:", {k: v["backgroundGrowth"] for k, v in swmeta["variants"].items()})
cold = w[~w.initial]
assert (cold.cold.all() and cold.error.isna().all() and (cold[cold.variant != "control"].describedField == True).all()), "a wake that did not cold-start, errored or did not describe"
print(f"{len(cold)} stopped wakes, every one a new worker, no errors, every call described")
""")

code("""
VARIANTS = ["control", "a-z", "a-s", "b-z", "b-s"]
p95 = lambda s: s.quantile(0.95)
ctl = cold[cold.variant == "control"][["ii", "iii"]].median()
summ = []
for v in VARIANTS:
    c = cold[cold.variant == v]
    row = {"variant": v, "n": len(c)}
    for col, name in (("i", "init"), ("ii", "in worker"), ("iii", "round trip")):
        if c[col].notna().any(): row |= {f"{name} med": c[col].median(), f"{name} p95": p95(c[col]), f"{name} max": c[col].max()}
    if v != "control":
        for col, name in (("ii", "in worker"), ("iii", "round trip")):
            d = c[col] - ctl[col]
            row |= {f"{name} added med": d.median(), f"{name} added p95": p95(d)}
    summ.append(row)
summ = pd.DataFrame(summ).set_index("variant").round(1)
display(summ)
""")

md("""
The same by program, by launch and by wake 0 (the first stopped wake in each profile). If one of these split the
figures, the medians above would hide it.
""")

code("""
display(cold.pivot_table(index="variant", columns="program", values="ii", aggfunc="median").reindex(VARIANTS).round(1).add_prefix("in worker med, "))
display(cold.pivot_table(index="variant", columns="launch", values="iii", aggfunc="median").reindex(VARIANTS).round(1).add_prefix("round trip med, launch "))
display(cold[cold.wake == 0].groupby("variant")[["i", "ii", "iii"]].median().reindex(VARIANTS).round(1).add_prefix("wake 0 med, "))
""")

md("""
The install-time start (not stopped, the profile's first compile, before any code cache) for init only: its message
arrives about a second after the start, so its other figures mean nothing. Then the worker's heap after the answer
(`Runtime.getHeapUsage` on the worker target; `performance.memory` is undefined in a service worker).
""")

code("""
init = w[w.initial & (w.variant != "control")]
display(init.groupby("variant")["i"].agg(["count", "min", "median", "max"]).round(1).rename(columns=lambda c: f"install-time init {c}"))
heap = cold.groupby("variant")[["heapUsed", "embedderHeapUsed", "wasmMemoryBytes"]].median().reindex(VARIANTS)
heap["heap added, kB"] = ((heap.heapUsed - heap.loc["control", "heapUsed"]) / 1e3).round(0)
heap["embedder heap added, kB"] = ((heap.embedderHeapUsed - heap.loc["control", "embedderHeapUsed"]) / 1e3).round(0)
heap.round(0)
""")

md("""
## 7. The differential run with resolution

`docs/plan/repl/ONE_DESCRIBER_BUILD.md`, section 5, last paragraph: before `describeCall` is deleted, the fuzz runs once
more, with path resolution, against the describer the host now ships. The host returns the description BEFORE
resolution (`pre`); the extension resolves it with `resolvePre`. `describeCall` is `resolvePre(describePre(...))`, so the
two sides are:

- **TS**: `describeCall(argv, manifest, {version, flavour, envSet, resolve})`, the resolved effects, and `describePre`'s `pre`.
- **wasm**: the host's `describe.wasm` (built by the host's `tools/build-describer.sh`, which first replays every shared
  vector through it) gives `described` and `pre`; `resolvePre(pre, resolve)` gives the resolved effects.

The bar is 0 disagreements on `described`, on `pre` (the quantity that carries the information: equal `pre` and one
resolver give equal effects) and on the resolved effects. `why` is compared too, reported apart. `one-describer/fuzz-resolved.mjs` runs every vector row unmutated, then, per seed, 2,000 mutations per program from the
same generator and seeds as section 2 (`makeFuzzer` in `lib.mjs`, which `fuzz.mjs` now draws from too: its output is
unchanged by the move). A call with a lone surrogate in argv, `envSet` or the flavour is not described on the worker side
(plan section 4: the call asks), so it is counted as an ask and is neither an agreement nor a disagreement.

**The fake resolver** is one function both sides call, deterministic per argv index `i` (the placeholder's `arg`):

| placeholder | resolves to |
| --- | --- |
| `cwd`, `repo` | `/w`, the workspace root: in root, `isRoot` |
| `i mod 7` is 0 or 1 | the rule of `scripts/gen-resolved-calls.mjs` on the argument as given: normalised against `/w`, in root iff under it, secret iff the basename starts `.env` or `id_`, not existing iff it starts `new` |
| 2 | outside the roots: `/o/<i>/<basename>` |
| 3 | a secret: `/w/.env`, `secret: true` |
| 4 or 5 | the same path, `/w/shared`: two indices on one path |
| 6 | does not exist: `/w/new<i>`, `exists: false` |

The columns below say how often each case was actually reached by a described call, so a clean result cannot be a
resolver that never fired.

Two wasm files are run: the one built locally on macOS (the commits below), and the `describer` artifact of the host's CI
(GitHub Actions run 45058213783, Ubuntu 24.04), which is the build a release ships. Two more runs are controls.
""")

code("""
RUNS = ["macos", "ubuntu", "control-resolver", "control-pre"]

def read_resolved():
    rows = []
    for label in RUNS:
        d = OUT / "resolved" / label
        rows.append({"kind": "meta", **json.loads((d / "meta.json").read_text())})
        rows.append({"kind": "vectors", "label": label, **{k: v for k, v in json.loads((d / "vectors.json").read_text()).items() if k != "label"}})
        for p in sorted(d.glob("seed-*.json")):
            rows.append({"kind": "seed", "run": label, **json.loads(p.read_text())})
    for r in rows:
        if r["kind"] == "vectors": r["run"] = r.pop("label")
        for g in r.get("groups", []): g["examples"] = g["examples"][:3] if not r["run"].startswith("control") else []
    return rows

rr = wmlnb.extract(DATA / "resolved.json", read_resolved, source={"harness": "notebooks/shell/one-describer/fuzz-resolved.mjs", "out": "notebooks/shell/one-describer/out/resolved/<label>/*.json"})
metas = {r["label"]: r for r in rr if r["kind"] == "meta"}
runs_of = lambda label: [r for r in rr if r["kind"] in ("vectors", "seed") and r["run"] == label]
mac, ubu = metas["macos"], metas["ubuntu"]
assert mac["hostCommit"] == mac["describeJson"]["commit"], "the macOS wasm was built from another commit than the checkout the harness read"
sides = {"window-ml (TS) HEAD at the run": mac["windowMlCommit"] + " (the TS describer is unchanged since e6f4c5fb, the HEAD this branch was cut from)",
         "window-ml-host, macOS build": mac["describeJson"]["commit"], "window-ml-host, Ubuntu build (CI merge ref)": ubu["describeJson"]["commit"],
         "vectorPin (both)": mac["describeJson"]["vectorPin"][:16], "rustc, macOS build": mac["rustc"], "node": mac["node"],
         "per program / seeds": f"{mac['perProgram']} / {mac['seeds']}"}
assert mac["describeJson"]["vectorPin"] == ubu["describeJson"]["vectorPin"]
display(pd.Series(sides, name="the two sides").to_frame())
pd.DataFrame({m["label"]: {"sha256": m["wasmSha256"], "bytes": m["wasmBytes"], "built on": m["buildOs"], "CI run": m["runId"]} for m in (mac, ubu)})
""")

code("""
cols = ["calls", "asks", "compared", "described", "notDescribed", "withTargets", "twoArgsOnePath", "callsOutsideRoots", "callsWithSecret", "disagreements", "barDisagreements", "seconds"]
names = ["calls", "asks, lone surrogate", "compared", "described", "not described", "described with a path", "two args on one path", "a path outside the roots", "a secret", "disagreements (all fields)", "disagreements on described, pre or effects", "seconds"]
def table(label):
    runs = runs_of(label)
    t = pd.DataFrame([{k: r[k] for k in cols} for r in runs], index=["vectors" if r["kind"] == "vectors" else f"seed {r['seed']}" for r in runs])
    t.columns = names
    tot = t.sum(numeric_only=True); tot["seconds"] = round(tot["seconds"], 1)
    return pd.concat([t, tot.rename("total").to_frame().T])
t_mac, t_ubu = table("macos"), table("ubuntu")
display(t_mac.round(1))
print(f"wall time of the whole macOS run (build excluded): {mac['totalSeconds']:.1f} s; Ubuntu wasm: {ubu['totalSeconds']:.1f} s")
runs7 = runs_of("macos")
print("resolver cases reached by described calls (resource count), macOS run:", {k: sum(r["resolverUse"].get(k, 0) for r in runs7) for k in ("cwd", "repo", "rule", "outside", "secret", "shared", "missing")})
""")

code("""
# Every disagreement, by field and by cause. `described`, `pre` and `effects` (and an error or trap on either side) are the bar;
# `why` is reported apart.
causes7 = pd.DataFrame([{"run": "vectors" if r["kind"] == "vectors" else f"seed {r['seed']}", "cause": g["cause"], "in the bar": g["bar"], "count": g["count"]} for r in runs7 for g in r["groups"]])
by_field = pd.DataFrame([{"run": "vectors" if r["kind"] == "vectors" else f"seed {r['seed']}", **r["byField"]} for r in runs7]).set_index("run").fillna(0).astype(int)
display(by_field)
display(causes7.pivot_table(index=["in the bar", "cause"], columns="run", values="count", fill_value=0, aggfunc="sum") if len(causes7) else "no disagreements of any field")
bar_total = sum(r["barDisagreements"] for r in runs7)
n_desc = sum(r["described"] for r in runs7)
why_on_described = sum(r["whyOnDescribedCalls"] for r in runs7)
print(f"verdict: {bar_total} disagreements on described, pre or effects over {sum(r['compared'] for r in runs7):,} compared calls "
      f"({n_desc:,} described); `why` differs on {sum(r['byField'].get('why', 0) for r in runs7)}, of which on a described call: {why_on_described}")
assert bar_total == 0 and all(r["byField"].get(k, 0) == 0 for r in runs7 for k in ("described", "pre", "effects")), "a disagreement on described, pre or effects: the plan stops describeCall's deletion until it is understood"
print(f"What 0 bounds: with 0 disagreements in n = {n_desc:,} described calls, the 95% upper bound on the per-described-call disagreement rate is about 3/n = {3 / n_desc:.1e} (the rule of three), under this generator's distribution of mutations of the vectors, not over calls in general.")
""")

md("""
The `why` differences are section 2's text causes again, on calls both sides refuse to describe: TS splits an astral
character when it quotes one letter of a flag cluster (the wasm quotes the whole character), and Rust's `{:?}` writes
`\\\\u{301}` and `\\\\0` where JSON writes the mark and `\\\\u0000`. One example each (seed 1), `why` as each side wrote it.
""")

code("""
s1 = next(r for r in runs7 if r.get("seed") == 1)
pd.DataFrame([{"cause": g["cause"], "program": g["examples"][0]["program"], "argv": shown(g["examples"][0]["argv"]),
               "ts why": shown(g["examples"][0]["repro"]["ts"]["why"]), "wasm why": shown(g["examples"][0]["repro"]["wasm"]["why"])}
              for g in s1["groups"] if g["examples"]])
""")

md("""
**The Ubuntu build.** The same fuzz against the wasm the host's CI built (the release ships that one, not the macOS build).
The files differ in size (the toolchain and its linker differ across OS), the describer's answers must not: the per-run
counts below are asserted equal to the macOS run's, field by field.
""")

code("""
fields = ["calls", "asks", "compared", "described", "notDescribed", "withTargets", "twoArgsOnePath", "callsOutsideRoots", "callsWithSecret", "disagreements", "barDisagreements", "whyOnDescribedCalls", "byField", "resolverUse"]
for a, b in zip(runs_of("macos"), runs_of("ubuntu")):
    assert [a[k] for k in fields] == [b[k] for k in fields], (a.get("seed"), "the Ubuntu build's counts differ from the macOS build's")
print(f"{len(runs_of('ubuntu'))} runs: every count, and every disagreement by field, equals the macOS build's")
display(t_ubu.round(1))
print(f"wasm bytes: macOS {mac['wasmBytes']:,}, Ubuntu {ubu['wasmBytes']:,} (differ by {ubu['wasmBytes'] - mac['wasmBytes']:+d}); sha256 {mac['wasmSha256'][:12]} vs {ubu['wasmSha256'][:12]}")
""")

md("""
**Can this harness see a difference at all?** Two controls, each a run that has to disagree, neither of them the result:

- `control-resolver` (`CONTROL=resolver`): the wasm side's resolver reports every resource as in root and not secret, so the
  sides no longer share a resolver. `pre` is untouched; only the effects can differ.
- `control-pre` (`CONTROL=pre`): each described wasm reply's `pre` is perturbed before it is compared and resolved. If any
  term has a target, the last target of the last such term is dropped; else, if a term is `read` or `write`, the first
  such term's op is swapped. Calls with neither are left alone (runs-code, network terms without paths).
""")

code("""
ctl = []
for label in ("control-resolver", "control-pre"):
    for r in runs_of(label):
        ctl.append({"control": label, "run": "vectors" if r["kind"] == "vectors" else f"seed {r['seed']}", "described": r["described"], "disagreements on pre": r["byField"].get("pre", 0),
                    "disagreements on effects": r["byField"].get("effects", 0), "disagreements on described": r["byField"].get("described", 0), "on a bar field (calls)": r["barDisagreements"]})
ctl = pd.DataFrame(ctl).set_index(["control", "run"])
display(ctl)
cr, cp = ctl.loc["control-resolver"], ctl.loc["control-pre"]
assert (cr["disagreements on effects"] > 0).all() and (cr["disagreements on pre"] == 0).all()
assert (cp["disagreements on pre"] > 0).all() and (cp["disagreements on effects"] > 0).all()
""")

md("""
To measure again: in a `window-ml-host` checkout at the commit under test, `tools/build-describer.sh <out-dir>` (the host's
own script, replaying the vectors first; this section's run uses it, not the spike's `build.sh` and `wrapper/`), then from
`notebooks/shell/one-describer/` `node --import tsx fuzz-resolved.mjs <out-dir>/describe.wasm <host checkout> 2000 1,2,3,7 <label>`
(`BUILD_OS`, `RUN_ID` and `CONTROL=resolver|pre` are environment variables; output goes to `out/resolved/<label>/`), then
`NB_REFRESH=1 node scripts/nb.mjs run notebooks/shell/one-describer.ipynb`. The run's labels here are `macos`, `ubuntu`,
`control-resolver` and `control-pre`.
""")

nb = nbf.v4.new_notebook()
nb.cells = cells
nb.metadata["kernelspec"] = {"name": "python3", "display_name": "Python 3", "language": "python"}
nbf.write(nb, HERE / "one-describer.ipynb")
