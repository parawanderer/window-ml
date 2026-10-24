# Spec (WIP): library manifests for the read-only dialect

**Status: work in progress, nothing built.** Written down on 2026-10-12 from a discussion, to come back to. The
examples below are sketches of a syntax to be argued with, not a design. Open questions are at the end.

## The idea

A read-only dialect is an interpreter for a subset of a language that can prove two things about a script before or
while it runs: it has no effect outside the interpreter, and it halts within a bounded cost. The JavaScript `exec`
dialect ([`docs/dev/readonly-exec.md`](../dev/readonly-exec.md)) is one implementation of that concept. The concept
itself is language-independent: an interpreter, an ownership tracker that knows which values it created, and a step
budget.

The dialect can implement the language's PRIMITIVES itself. An imported library is the hard part: the interpreter
cannot see inside a native function, so today it has to refuse it. This spec proposes that a library can ship (or a
third party can write) a MANIFEST that tells the dialect how to treat each of its functions:

- what effects the function has, and on what;
- what it does with callbacks and what its return value aliases;
- how much it costs, as a function of its arguments, or "interpret my body".

**With no manifest, every function is refused**, exactly as now. A manifest can only widen what the dialect accepts;
it can never weaken a refusal the dialect would make anyway.

## It already exists, by hand

The JS dialect already carries hand-written manifests for the host calls it allows. Each row is a manifest entry
that was written in code instead of declared:

| Today | What it is in manifest terms |
| --- | --- |
| `BY_KIND` + `kindOf` in `src/readonly-exec/policy.ts` | which methods are allowed, per receiver kind (an effect annotation) |
| `MUTATING_METHODS` + the ownership check | "mutates argument 0 (the receiver)", accepted only when the dialect owns it |
| `PIPE_CHARS_PER_STEP` (`ml.pipe`) | a cost charged on input and output size, with a calibrated constant |
| `ml.jsonPath`, one step per node visited | a METERED cost: the host call charges as it works |
| the table facade's `preflight` | a closed-form bound checked BEFORE the call, refusing over `MAX_COLLECTION` |
| `riskyRegex` | a refusal for an input whose cost no bound can see (exponential backtracking inside one host call) |

The manifest generalises these into one declared format, and opens it to libraries the dialect's authors did not
write.

## Effects

A yes/no "readonly" flag is not enough. Each function carries an effect signature:

| Effect | Meaning | The dialect's decision |
| --- | --- | --- |
| `pure` | reads only its arguments, writes nothing | allowed |
| `mutates(i, …)` | writes into argument `i` | allowed only if the dialect OWNS argument `i` at the call; refused otherwise. The library says WHAT it mutates; whether that is acceptable is the interpreter's call, because only it tracks ownership. |
| `cache` | keeps internal state no caller can observe (a memo table) | allowed. The test is OBSERVATIONAL: same results, same order, same identities with or without the cache. A cache that changes iteration order or object identity fails it and is `external`. |
| `reads-external` | reads state the arguments did not carry (the clock, a random source, a global) | allowed or refused per dialect: it is not an effect, but it makes the result non-deterministic |
| `external` | any observable effect outside the interpreter | refused |

An effect may depend on an argument's VALUE: pandas `df.sort_values(…, inplace=True)` mutates `df`, and with
`inplace=False` it is pure. So an effect signature can be a function of the arguments, like a cost (below).

These five terms are the authoring vocabulary. What a policy reads is their projection onto the shared algebra of
(operation, resource) pairs in [`EFFECTS.md`](EFFECTS.md): `mutates(i)` is `write(heap(arg i))`, which the interpreter
resolves to owned or unowned at the call; `reads-external` is `read(entropy)`; `external` is `unknown` unless the manifest
names the resource. The algebra is what lets one policy read a library call, a program call and a fetch alike.

Two things the signature must also say, or the rest means nothing:

- **Callbacks.** For a higher-order function, which arguments get called, and that they are called BACK THROUGH THE
  INTERPRETER. Otherwise `lib.map(xs, f)` runs `f` outside mediation and the dialect has handed a native loop an
  unmediated function. A callback that is not a dialect function (a host function the script got hold of) is
  refused. The interpreter meters each callback invocation itself, so the callback's cost needs no annotation; the
  library's own work between callbacks still does.
- **Return aliasing.** Whether the return value is `fresh` (the dialect may treat it as owned), aliases argument
  `i` (owned exactly when that argument is), or aliases `internal` state (never owned: a later write through it
  would mutate the library).

## Cost: three tiers

From cheapest and most trusted to most expensive and self-verifying.

### 1. A closed-form bound, checked before the call

`cost(xs) = xs.length * log2(xs.length)`. Constraints:

- It is written IN THE DIALECT, so evaluating it is itself bounded and effect-free. A cost function that loops is
  refused like any script.
- It reads only SIZE MEASURES the interpreter can get cheaply and trustworthily: `length`, `size`, a byte count, an
  array's `shape`. The idea is sized types: the bound is a function of sizes, never of contents.
- It must be an UPPER bound. Its job is to refuse before any work happens, like the table `preflight`.

### 2. Metered

The library calls a `charge(k)` hook as it works (fuel, as in Wasm), and the dialect aborts the call when the budget
runs out. This covers data-dependent cost with no closed form (a graph search, a regex engine). Two conditions:

- Aborting mid-call must leave nothing behind, which holds only if the function is `pure` or mutates only what the
  dialect owns (and the dialect restores owned values on failure, as `evalReadonly` already does).
- Charging AFTER the call by output size alone is not a bound: the unbounded work already happened. It is
  acceptable only together with a hard cap known before the call.

### 3. "Interpret my body"

The library's source is in the dialect's language, so the interpreter steps into it and charges its primitives like
any script's. Effects come for free, by construction: a library function that writes to a global is refused at the
write, as a script would be. Only the NATIVE LEAVES the body reaches need a manifest entry, the way JS builtins sit
under JS code and C extensions under Python.

This tier is the only one that verifies itself. Its cost in JS is the interpretation slowdown: the JS dialect measures
about 3.2M steps/s, far below native speed. In Python it costs nothing, because the gate is in the runtime
([`PYTHON_DIALECT.md`](PYTHON_DIALECT.md)): any pure-Python body reached from a restricted frame is this tier by default. Issue
[#277](https://github.com/parawanderer/window-ml/issues/277) (a bytecode/WASM compiler for the evaluator) is what
would shrink that gap, and its ahead-of-time resolution of property names to integer ids is the natural place to
compile a manifest into: a manifest entry becomes a row in the same table as the built-in whitelist.

### Units: declare the shape, measure the constant

The step budget is calibrated to time (about a second of main thread). A library author does not know the host's
step rate and will get the constant wrong in the cheap direction. So a manifest declares the cost's SHAPE
(`n log n` in `xs.length`), and the host measures the constant on its own machine, as `PIPE_CHARS_PER_STEP` was
calibrated on the slowest pipe stage. A declared constant, if present, is a hint the host may raise but never lower.

## Format

The cost of a wrong annotation is what separates this from a type stub. A wrong type in a `.d.ts` is a compile error.
A wrong `@effects pure` is a side effect the user never approved. So a manifest is SECURITY POLICY, not
documentation, and that decides the format:

- **Inline annotations are the authoring form** for a library's own author: next to the code, less drift. In JS that
  means JSDoc tags, since decorators do not apply to plain functions. In Python, decorators work on any function.
- **A sidecar file is the overlay** for a library someone else wrote, as DefinitelyTyped is for types and `.pyi` stubs
  are for Python.
- **Both compile to one manifest** the interpreter consumes, PINNED to a content hash of the library build. A manifest
  for v1 never silently applies to v2.
- **Trust comes from who installed the manifest, never from the library.** The user installs it. A page or a package
  that vouches for itself is ignored: otherwise a hostile page ships `@effects pure` on its exfiltration function.

## Examples: JavaScript

Inline, in the library's own source:

```js
/**
 * Returns a sorted copy of `xs`, ordered by `key(x)`.
 * @effects pure
 * @calls key per-element
 * @returns fresh
 * @cost (xs) => xs.length * Math.ceil(Math.log2(xs.length + 1))
 */
export function sortBy(xs, key) { /* … */ }

/**
 * Shuffles `xs` in place.
 * @effects mutates(0)
 * @returns alias(0)
 * @cost (xs) => xs.length
 */
export function shuffleInPlace(xs) { /* … */ }

/**
 * Parses a date string. Memoizes parsed formats, invisibly.
 * @effects cache
 * @returns fresh
 * @cost (s) => s.length
 */
export function parseDate(s) { /* … */ }

/**
 * Written in the dialect's subset: step into it and charge its primitives.
 * @cost interpret
 */
export function groupBy(xs, key) { /* … */ }

/**
 * Shortest path; cost depends on the graph's shape, so it charges as it goes.
 * @effects pure
 * @returns fresh
 * @cost metered (g) => g.nodes.length * g.edges.length
 */
export function shortestPath(g, from, to) { /* … */ }
```

`metered` with a bound: the library calls `charge` as it works, and the expression is the hard cap checked before
the call.

A sidecar for a library you do not own. Its cost functions are dialect code too:

```js
// <name>.readonly.js, installed by the user, pinned to one build
export default {
  library: "lodash",
  version: "4.17.21",
  sha256: "<hash of the build>",
  functions: {
    chunk:   { effects: "pure", returns: "fresh", cost: (xs) => xs.length },
    sortBy:  { effects: "pure", returns: "fresh", calls: { 1: "per-element" },
               cost: (xs) => xs.length * Math.ceil(Math.log2(xs.length + 1)) },
    set:     { effects: { mutates: [0] }, returns: "alias(0)", cost: (obj, path) => path.length },
    // debounce, throttle, defer: not listed, so refused (they schedule work outside the interpreter)
  },
};
```

## Examples: Python

**A Python read-only dialect is decided and not yet built** ([`PYTHON_DIALECT.md`](PYTHON_DIALECT.md), 2026-10-15); until
it exists everything built is JavaScript. (`python_exec`'s `mode: "readonly"` shares only the name: it cuts the
sandbox's network and JS bridges ([`docs/dev/python-sandbox.md`](../dev/python-sandbox.md)), does not bound work, and
tracks no ownership; the dialect replaces it.) **The Python dialect is this spec's main consumer**: in JS the dialect has
few native libraries to worry about, while in Python every useful cell is numpy or pandas, so these examples are the
ones that matter first. The parser is `ast.parse`, the evaluator is CPython itself under a restricted mode the fork adds,
and the native leaves are C extensions, as builtins are in JS. Tier 1 is the practical tier for them (no charge hook
inside a C loop); tier 3 is the DEFAULT, because pure-Python code called from a restricted frame simply runs under the
gates at native speed, with no manifest and no interpretation cost.

Inline, as decorators in a pure-Python library:

```python
from readonly import effects, cost, returns, calls

@effects("pure")
@returns("fresh")
@calls(key="per-element")
@cost(lambda xs, key: len(xs) * ceil(log2(len(xs) + 1)))
def sort_by(xs, key): ...

@cost("interpret")          # pure Python in the subset: step into it
def group_by(xs, key): ...
```

A stub-style sidecar for numpy and pandas, whose bodies are native and can only be annotated:

```python
# <name>.readonly.pyi, installed by the user, pinned to one build
# library: numpy 2.1.3, sha256 <hash of the build>

@effects("pure"); @returns("fresh")
@cost(lambda a, axis=None: a.size)              # a size measure, never a content read
def sum(a, axis=None): ...

class ndarray:
    @effects(mutates=["self"]); @returns(None)
    @cost(lambda self, axis=-1: self.size * ceil(log2(self.size + 1)))
    def sort(self, axis=-1): ...

    @effects("pure"); @returns("alias(self)")   # a view shares memory with self
    def reshape(self, *shape): ...

# library: pandas 2.2.3, sha256 <hash of the build>

class DataFrame:
    # the effect depends on an argument's value
    @effects(lambda self, by, inplace=False: {"mutates": ["self"]} if inplace else "pure")
    @cost(lambda self, by, inplace=False: len(self) * ceil(log2(len(self) + 1)))
    def sort_values(self, by, inplace=False): ...

    @effects("pure"); @returns("fresh")
    @calls(func="per-row")                      # called back through the interpreter
    @cost(lambda self, func, axis=0: len(self))
    def apply(self, func, axis=0): ...

    # to_csv(path), to_sql, plot: not listed, so refused
```

`reshape` shows why return aliasing matters: a view aliases its source, so writing through it mutates an array the
dialect may not own.

**`lift` and `names` (Python only; lane 3, 2026-10-15).** Under CPython's restricted mode every allowed C callable runs
with the gate ON, so the lookups it performs from its arguments are judged like a cell's own. A leaf whose internals
legitimately touch dunders (numpy, pandas) is marked `@lift`, and runs with the gate lifted for its dynamic extent,
callbacks excepted. The rule that comes with it: **a lifted leaf never resolves a name it is given.** A leaf that turns
a string argument into an attribute lookup (`DataFrame.agg("sum")`, `apply("mean")`, `groupby(...).transform("max")`)
declares the admitted strings as a closed vocabulary, `@names(func=[...])`, which the entry checks before the call;
anything else is `NotInDialect`. `DataFrame.eval` and `DataFrame.query` are not listed: a string that is a program is
another language, and the dialect compiles no string.

**A callable handed to a lifted leaf is a `CO_RESTRICTED` function, or the call is refused** (lane 3, 2026-10-15, PR
#721). Inside a lifted leaf only a restricted Python frame turns the gate back on, and a C callable makes no frame: a
bound `str.format` (`df.a.apply("{0.__class__}".format)`), an `operator.attrgetter("__class__")` as a sort key, a bound
method, a `functools.partial`, would run their lookups ungated inside pandas' lift. So on entry to a lifted leaf the
entry walks the arguments, positional and keyword, into plain containers (`list`, `tuple`, `dict`, `set`; never into an
object such as a frame), and every callable found must be a `CO_RESTRICTED` Python function, every string in a `names`
position must be in the vocabulary, or the call is `NotInDialect` before the leaf runs. A gate-restoring shim around C
callables is the alternative and is rejected: it is complexity in the one place that must stay simplest. The corpus
count (lane 3, PR #722, `leaf-vocabulary.json` over 1,697 parsed cells) says the rule costs nothing measurable: no cell
passes a builtin or a bound method as a callback or `key=`; nine cells (about 0.5%) pass a MODULE function,
`.map(decimal.Decimal)` six times and `.apply(pd.to_numeric)` three, and the rule refuses all nine rightly, since
`Decimal` is a C type and `to_numeric` is pandas' own Python, either of which would run ungated inside the lift. So
there is no general list of callback-safe builtins. If a leaf is ever admitted in that position, it is marked on ITS
OWN manifest entry ("may also appear as a callback"), judged entry by entry under the same burden as `lift` (it resolves
no name it is given), with `decimal.Decimal` and `pandas.to_numeric` the two candidates the corpus names. The same count
sets the `names` vocabulary: one cell passes a string to a name-resolving leaf (`agg("sum")`), none use `transform` or
`aggregate`, so the vocabulary starts at the pandas reductions; `query` appears once and `eval` never, so leaving them out
costs nothing.

```python
class DataFrame:
    @lift; @effects("pure"); @returns("fresh")
    @names(func=["sum", "mean", "median", "min", "max", "count", "size", "nunique", "std", "var", "first", "last"])
    @cost(lambda self, func, axis=0: self.size)
    def agg(self, func, axis=0): ...           # the vocabulary above is an example; the corpus count sets the real one
```

## Generating and importing a manifest into the runtime

With `ml.sh` enabled, a user or an agent in the loop can use the wrapper itself to inspect a library (or annotate a
library they just wrote in the workspace) and import the resulting manifest into the active runtime without rebuilding
the extension.

Whether a generated manifest requires trust or is self-verifying depends on which cost tier it uses:

| Target | How it runs | Trust & verification boundary on import |
| --- | --- | --- |
| **Pure-JS or pure-Python module at Tier 3 (`@cost interpret`)** | The JS dialect AST evaluator or CPython `CO_RESTRICTED` mode steps directly into the library's functions | **Zero trust in annotations.** Ownership (`heap(owned)`), forbidden globals/dunders, and the step budget are enforced by construction on every primitive step inside the body. Importing the manifest into the runtime only admits the module (`sha256`-pinned) into the dialect's import allowlist and compiles its functions with `CO_RESTRICTED` (Python) or registers its parsed AST (JS). |
| **Native C extension / unmediated host function at Tier 1 (`@lift` + closed-form `@cost`)** | The interpreter lifts its gate (`@lift`) for the dynamic extent of the call and charges the closed-form `@cost` expression beforehand | **Trusted claim; requires evidence before approval.** Unlike a CLI [`PROGRAM_MANIFEST.md`](PROGRAM_MANIFEST.md) call (where Seatbelt/Landlock enforces `write: none` and `net: deny` at the kernel boundary even if the manifest lies), a `@lift` library entry suspends the in-process gate. When an agent drafts a Tier 1 sidecar (`propose_manifest`), the proposal harness runs an isolated probe over representative inputs to verify non-mutation of inputs (`@effects pure`), return non-aliasing (`@returns fresh`), and empirical runtime scaling against the declared `@cost` bound before raising the human's two-button approval card. |
| **Interpreted CLI script (`node scripts/<name>.mjs`, `python3 <tool>.py`)** | Spawned as a separate process through `ml.sh.run` | Uses a **program manifest** (`(program, entrypoint)` pinned by script `sha256` in [`PROGRAM_MANIFEST.md`](PROGRAM_MANIFEST.md), "Interpreted script tools"), not a library manifest: the OS sandbox enforces the effect envelope externally, and process timeout + Root L's physical-footprint bound replace the in-interpreter cost tiers. |

### The runtime import loop

1. **Author or synthesize.** The user or agent either writes inline JSDoc / `@decorators` in their own workspace module
   or generates a sidecar (`<name>.readonly.js` / `<name>.readonly.pyi`) from the library's source and type declarations.
2. **Pin and propose (`propose_manifest`).** Parallel to `propose_policy` ([`POLICIES.md`](POLICIES.md)) and Root K in
   [`PROGRAM_MANIFEST.md`](PROGRAM_MANIFEST.md), the compiled manifest is pinned to the content `sha256` of the target
   module (or wheel) and submitted with its scope (`workspace` for repo-local modules, `global` for user-installed
   packages) and verification evidence (Tier 3 AST/bytecode admission check, or Tier 1 isolated probe results).
3. **Approve once, load live.** Once the person approves the card (or installs the file in DevTools Settings), the worker
   and the Pyodide / CPython runtime merge the manifest's entries into the active lookup table keyed by `(module, sha256)`
   for the current and subsequent runs. If the underlying file changes on disk, the `sha256` pin mismatches and calls
   into it drop back to `unknown` (asking the person) until re-pinned.

**RULED 2026-10-24 for the first build of Tier 3 entries** (root K's (c2), measured on the pinned fork core 0169c4fd;
the finder is the root-k session; the spec is updated with the build's PR). Four rulings and one finding:

- **Source origin.** The model names a file inside a workspace root. The worker reads it as a RECORDED `ml.sh` call of
  `cat` on that one operand, spawn then discard, under `cat`'s own manifest, so a secret path is refused by the rule
  that already refuses it and the read is size-capped (the cap is the build's to set and the card states it). The
  card shows the path, the sha256 and byte size of what was read, the module name, each admitted name with its
  signature, and the source itself behind a disclosure. A file outside every root, a dotted module name, and a name
  already importable (stdlib, a whitelist module, anything in `sys.modules`) refuse before the card.
- **Nothing executes before the person's word, here too.** The admission result on the card is DERIVED: the
  dialect's node check over the module's AST, plus a MODULE-SHAPE rule that needs no run: the body is a docstring,
  `import`s of modules the gate already admits, `def`s whose every default is a literal of an immutable kind (a
  scalar, `str`, `bytes`, a tuple or frozenset of such), and assignments whose right side is such a literal. Any
  other top-level statement (a call, a list or dict literal, a class, a loop, a comprehension) refuses the module
  and the card names the line. The load, `restricted.check` + `mark(compile)` + `_restricted.run` under the budget,
  runs AFTER approval, and the post-load check of every global (a `CO_RESTRICTED` function with no closure, an
  immutable, an admitted module, a builtin function) is the ENFORCE layer behind it: a global the shape rule
  admitted and the post-load check refuses is not stored, the card reports it, and the disagreement is a finding
  for the shape rule's owner the same day. A refused module leaves nothing in `sys.modules` and no `allow_module`.
- **The stored entry IS the pinned source.** A snapshot of the approved bytes, with the path and sha256 beside it: a
  cell imports exactly what the person approved, and a change on disk reaches the runtime only through a new
  proposal. The disk-hash mismatch above is withdrawn for Tier 3 entries (it needs the host on every worker start,
  and a snapshot is safe under Tier 3's zero trust); the registration page may show that the disk now differs.
- **Global scope only this round.** The python worker is shared across runs, and the fork has no unload (below), so
  a workspace-scoped entry would need a worker restart per run. Workspace scope is a left item. Removing a Tier 3
  entry on the registration page restarts the worker, and the page says so.
- **Finding (the fork's, not fixed here).** An object created by a load run stays OWNED for the rest of the worker's
  life, through `_restricted.reset()`: a module-global list or a mutable default is mutated by later cells and
  carries state across runs (measured: `keep(1)` → `[1]`, `keep(2)` → `[1, 2]`, after a reset `keep(3)` →
  `[1, 2, 3]`). The shape rule above makes such a global unexpressible in an admitted module; the general fact goes
  to the fork as an issue the finder files, named in the root K result's left items for Shane's rebuild.

The red-team pass (rule 10: a separate session, failing-first tests in its own file) covers the new message types
and the shape rule; the code review goes to a free session that neither built nor found it.

**As built** (root K's (c2), `propose_manifest` with `library`; how it works: `docs/dev/python-sandbox.md` and
`docs/dev/shell.md`). Where the build differs from the rulings or fills a gap they left:

- The size cap is 64 KiB (`LIBRARY_MAX_BYTES`), the head `ml.sh` returns whole. The read must hash to the sha256 the
  host resolved before the read, or the card says the file changed while it was read.
- A name that already imports is asked of the sandbox before the card, as a shape op over an empty source, so nothing
  of the library reaches it. "Already importable" is `sys.modules`, `sys.stdlib_module_names`, the whitelist's modules,
  the bundled packages' imports, and anything `importlib.util.find_spec` finds.
- The shape rule takes the admitted modules and names from the gate's own tables (`load_manifests`), so `from m import
  n` is admitted only for a name the gate admits on `m`. It refuses an annotated assignment (`X: int = 3`): on 3.14 it
  compiles to a `__conditional_annotations__` set the load refuses. Measured by listing every admitted form and
  loading each; the three disagreements this found were fixed before the build.
- The post-load check is stricter than the ruling's list: a global may be frozen data, a `CO_RESTRICTED` function with
  no closure and frozen defaults, or by identity an admitted module or an admitted name of one. A builtin function is
  admitted only as an admitted name (`from math import fsum`).
- The card shows the source as a Python code block; the Settings page "Python libraries" shows it behind a disclosure.
  The page does not yet say that the file on disk now differs.
- Removing an entry restarts only the Python workers that were handed a library (an inside run's, the proposal's own),
  not every worker; each run that kept names in one is told on its next cell.
- The owned-through-reset finding is window-ml #1102 (the fork's issues are off).

**RULED 2026-10-24 for the two left items** (root-k asked which to take after #1110; the coordinator's answer, before
any build):

- **"The file on disk differs" is a button, not a side effect of opening the page.** Opening Settings reads nothing:
  a read that happens because a page was looked at is a read nobody asked for (the describe layer must not cost a
  call on the host). The entry carries a "Check the file" control; pressing it is a recorded `ml.sh cat` of the
  stored path, the same read the proposal made, under the same cap, hashed and compared to the stored sha256. The
  result is DESCRIBED on the entry ("differs since <date>", "unchanged", "missing", "unreadable") and nothing else
  happens: the stored snapshot stays what a cell imports, nothing is removed, nothing is re-proposed. Re-pinning is a
  new `propose_manifest` the model or the person starts, with its own card. Small; no red-team pass beyond pinning
  that the check cannot change the store.
- **Workspace scope is PARKED until it has a ruling,** and the ruling waits for a build that needs it. The open
  question is how a workspace entry combines with a global one on the same module name; the shape of the answer is
  the policy store's (narrow wins: a workspace entry SHADOWS a global of the same name inside that workspace and never
  widens it, the delivered set is per run, and the worker handed a workspace set is restarted when it changes), but
  nothing is written as a rule until there is a workspace-scoped manifest to write it for.

## Open questions

- **Size measures.** Which ones does an interpreter trust? `xs.length` on a host array is cheap and honest. On an
  object the library controls, `length` may be a getter: it can lie or have its own cost.
- **Who writes manifests for the big libraries,** and who audits them? Ten thousand DefinitelyTyped-style manifests
  are each a security claim.
- **Composition.** A manifest function calling another library's function: does the outer bound have to include the
  inner one, or does the inner one get charged separately when the call is mediated?
- **`reads-external`.** Refused outright, or allowed and the result marked non-deterministic? The JS dialect already
  allows `Date.now()`-style reads in places.
- **Tier 3 across languages.** "Interpret my body" needs the body in the dialect's subset. How much of a real
  pure-Python or pure-JS library falls inside a subset strict enough to halt?
- **Calibration at install time.** Measuring the cost constant needs representative inputs. Where do they come from:
  the manifest, or a generator from the size measures?
- **Granularity of a refusal.** One unlisted function refuses the whole script (and sends it to approval), as now, on
  the page. Under an async evaluator (a worker-side survey, a Python dialect cell) a gated call can instead SUSPEND on
  a card for that call only ([`ML_WIRE.md`](ML_WIRE.md), "Per-call asking"); whether a manifest may mark a function
  "ask for this call" and get the same treatment is the remaining half.

## The shipped files' JSON Schema

The four data files the Python dialect loads (`notebooks/python-dialect/data/manifest-{stdlib,numpy,pandas,pil}.json`)
have a schema, [`library-manifest.schema.json`](library-manifest.schema.json), for editor validation and field hints
(`.vscode/settings.json` associates them). Unlike [`program-manifest.schema.json`](program-manifest.schema.json) it is
HAND-MAINTAINED: this format has no TypeScript type or validator here (its reader is `restricted.load_manifests` in the CPython
fork), so it states the narrowest shape the four files justify, and the fork stays the authority. The shape may change with
the design above, which is still WIP. `tests/manifest-schemas.test.mjs` checks every file against it and that each name a
file lists has its row.

## Related

- Issue [#277](https://github.com/parawanderer/window-ml/issues/277): the evaluator as bytecode, which makes tier 3
  affordable and gives manifests a compiled form.
- [`docs/dev/readonly-exec.md`](../dev/readonly-exec.md): the JS dialect, its halting table and its adversarial-test rule,
  which every manifest-driven extension inherits.
- [`docs/spec/SECRET_HANDLES.md`](SECRET_HANDLES.md): the same move ("what the dialect cannot say, the model cannot
  do") applied to credentials.
- [`PROGRAM_MANIFEST.md`](PROGRAM_MANIFEST.md): the same idea with PROGRAMS in place of libraries (effect per program,
  subcommand and flag, which arguments are paths, where operands start, whether it runs or echoes), split out on
  2026-10-15 because it needs none of the cost tiers and should not wait on them; it supplies the facts the free tier
  of `ml.sh` ([`SHELL.md`](SHELL.md)) is decided on.
- [`EFFECTS.md`](EFFECTS.md): the algebra every effect vocabulary projects onto.
- [`PYTHON_DIALECT.md`](PYTHON_DIALECT.md): the consumer that makes the Python examples real.
- [`docs/spec/POLICIES.md`](POLICIES.md): what DECIDES on those facts. A manifest describes a call the same way for
  everyone; a policy, the person's, decides whether it needs them, and the free tier is the built-in default policy.
