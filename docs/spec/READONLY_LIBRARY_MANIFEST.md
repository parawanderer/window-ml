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

This tier is the only one that verifies itself. Its cost is the interpretation slowdown: the JS dialect measures
about 3.2M steps/s, far below native speed. Issue
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

## Examples: Python (hypothetical)

**There is no Python read-only dialect: none of this exists, even in part.** Everything built so far is JavaScript,
the main REPL language here. (`python_exec`'s `mode: "readonly"` shares only the name: it cuts the sandbox's network
and JS bridges ([`docs/dev/python-sandbox.md`](../dev/python-sandbox.md)), does not bound work, and tracks no
ownership.) A Python implementation of this concept starts with a Python-subset interpreter with the same three
properties: ownership, a step budget, refusal on anything outside it. The manifest format would be shared, and the
native leaves here are C extensions, as builtins are in JS.

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
- **Granularity of a refusal.** One unlisted function refuses the whole script (and sends it to approval), as now. Or
  could a manifest mark a function as "ask a human for this call only"?

## Related

- Issue [#277](https://github.com/parawanderer/window-ml/issues/277): the evaluator as bytecode, which makes tier 3
  affordable and gives manifests a compiled form.
- [`docs/dev/readonly-exec.md`](../dev/readonly-exec.md): the JS dialect, its halting table and its adversarial-test rule,
  which every manifest-driven extension inherits.
- [`docs/spec/SECRET_HANDLES.md`](SECRET_HANDLES.md): the same move ("what the dialect cannot say, the model cannot
  do") applied to credentials.
- [`docs/spec/SHELL.md`](SHELL.md): the same manifest with PROGRAMS in place of libraries (effect per program,
  subcommand and flag), which decides the free tier of `ml.sh`.
