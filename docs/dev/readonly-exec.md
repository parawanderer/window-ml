# The read-only `exec` dialect

How `exec` runs a script with no approval prompt, what that promises, and what it is for. Keep this file current: any
change to `pointer-macro.ts` or `readonly-exec.ts` that changes what a script can do changes a section here. The
original design spec is [`docs/spec/READONLY_EXEC_SPEC.md`](../spec/READONLY_EXEC_SPEC.md); it describes v1 and is
out of date on most of the grammar.

## What it is for

The agent's `exec` tool runs JavaScript in the page, so every call needs a human's approval. Most of what models
write there is a read-only survey: query the DOM, filter, map to a summary. Approving those one by one is friction,
and on a Trusted Types page (Gmail) the normal `eval` path cannot run at all.

So a survey is first handed to a small interpreter for a subset of JavaScript. If the whole script is inside that
subset, it runs there and its result is the tool's result, with no prompt. If anything is outside it, the interpreter
throws, nothing it did is left behind, and the script goes to the normal approval gate and real `eval`. A gap in the
dialect costs a prompt; it can never cost a side effect.

Good for:

- DOM surveys: `querySelectorAll`, attributes, text, computed style, geometry, shadow- and iframe-piercing queries
  through `ml.queryAll`.
- Computing over what was read: filtering, grouping into a `Map` or an object, sorting, string and regex work.
- Reading the run's own earlier outputs (`@tool:` pointers, `ml.dereference`) and its own setup (`ml.config()`,
  `ml.getModel()`, `ml.ps()`).
- Curating the run's answer (`ml.answer.add(…)`).
- Walking a nested structure recursively, to a bounded depth.

Not for, and falls back to approval: anything with an effect (a click, typing, a fetch of a new URL, changing the
page), a long computation (use `python_exec`), `while` loops, classes, generators, `await` inside a callback, and
calling a function stored on an object.

## The contract

These hold for every script, and every extension of the dialect has to keep them. Each has adversarial tests in
`tests/readonly-exec.test.mjs`.

1. **Read-only with respect to the page.** Nothing outside the script changes, with one exception: `ml.answer`,
   the run's own answer set, which a survey may curate.
2. **A failed attempt leaves nothing behind.** That is what makes trying the interpreter first safe. The only
   thing a survey can change outside itself is the answer set, and `evalReadonly` restores it when the survey
   falls out of dialect.
3. **No escape.** No string is ever compiled, the realm (`window`, `Function`, a constructor chain) is unreachable
   through the object graph, and no effectful method can be called.
4. **Every script halts, and its cost is bounded.** Two separate properties; see [Halting](#halting).
5. **Deterministic in its inputs.** The inputs are the page, what `ml` reads return, and the clock (`new Date()`).
   There is no randomness: `Math.random` is not callable.

## Three stages

A script goes through three passes, each of which can refuse it.

### 1. The pointer macro (`pointer-macro.ts`)

Models write `@tool:abc1234` inline as though it were JavaScript, because that is how a captured output is named
everywhere else they see it. It is not JavaScript, so no parser can find it: the macro is a lexical pass that runs
first, the way the C preprocessor runs before the compiler.

- Every `@tool:` reference in CODE position becomes `ml.dereference("@tool:…")`. The three reference forms (quoted
  label, 7-hex id, bare tool name) come from the same grammar sources the rest of the pointer machinery uses.
- Strings, template text, comments and regex literals are skipped, and `${…}` inside a template is code again. A
  pointer inside a log line stays text.
- The expansion is a fixed template naming one method. Nothing in a payload chooses what gets called.

`dereference` is in the dialect's read-only `ml`, so a pointer read is free. That is the reason the macro runs
before the dialect: without it, `@tool:abc` is a tokenizer error and the survey falls to approval, while the same read
spelled `ml.dereference("@tool:abc")` is free. The macro would be teaching the model the expensive spelling.

In the dialect a pointer read is a value, because facade calls are awaited for you. On the approved path (real
`eval`), `tools.ts` resolves every pointer the script mentions before it runs, so there too `@tool:abc.length` is a
number and not `undefined` read off a promise.

`ml.dereference` reads whichever run's resolver is BOUND (`currentDeref` in `tool-exec.ts`), which is what stops a
page's own console from reading a run's outputs. `executeTool` binds it during a tool call, but the read-only attempt
runs before any tool call, so both call sites bind it themselves with `withRunDeref`. Until they did, every pointer
read in a survey threw and went to the approval gate, on both paths, while the dialect's own tests (which stub `ml`)
passed.

### 2. Tokenizer and parser

`tokenize` and the `Parser` class in `readonly-exec.ts`. The grammar is the first whitelist: a shape the parser does
not know throws `NotInDialect`, so the parser can be deliberately incomplete and stay safe.

- Tokens: numbers (no exponent or hex), strings, template literals (each `${…}` is re-tokenized and parsed as an
  expression and must consume fully), regex literals (told from division by the previous token), identifiers,
  punctuators. Comments are skipped.
- Expressions, by precedence climbing (the `BP` table): literals, identifiers, member access (`.x`, `?.x`, `[e]`,
  `?.[e]`), calls (`f(a)`, `?.(a)`, spread arguments), arrows and function expressions, array and object literals
  (with spread and shorthand), `new Ctor(…)` for a bare name, unary `! - typeof`, binary arithmetic and comparison,
  `&& || ??`, the ternary, `await`, and a simple `=` whose target is a member.
- Statements: `const`/`let`/`var` with one declarator (or a shorthand array or object destructuring pattern),
  `if`/`else`, `for (const x of …)`, `try`/`catch`/`finally`, `return`, blocks, expression statements. The value of
  a program is its last expression statement or its `return`.
- Deliberately absent: `while`, `do`, C-style `for(;;)`, `for…in` (a prototype-chain read), compound assignment
  and `++`, assignment to a bare name, classes, generators, getters, labels, `this`, `delete`.

### 3. The evaluator

The `Evaluator` class walks the AST. It is where every read and call is mediated, and where ownership and halting
are enforced.

**Scope.** The root scope holds `document`, `Array`, `Object`, `JSON`, `Math`, `String`, `Number`, `Boolean`,
`Promise`, the parse and test functions, `console` (captured, not the real one), `getComputedStyle` bound to the
page's view, and `ml` (a facade, below). Nothing else is reachable by name: an unknown identifier is `Denied`.

**Reads.** Every property read goes through `guardKey`: `DENIED_PROPS` (`constructor`, `__proto__`, `prototype`,
`ownerDocument`, `defaultView`, `contentWindow`, `location`, `cookie`, `window`, the CSS-object hops back to a
document, …) throws, whether the key is static or computed at run time. A method read as a value becomes
`METHOD_REF`, an inert stand-in that is truthy and typed `function`, so `el.closest && el.closest('x')` works, but
calling it throws, so a method can never be carried past the call gate. A live DOM collection read as a property
becomes a real array.

**Calls.** A call runs only if one of these holds:

- `obj.method(…)` where the method is allowed FOR THAT KIND of receiver (`BY_KIND`): DOM queries on an
  element, array methods on an array, string methods on a string, `Set`/`Map` operations on those,
  `Object`/`JSON`/`Math` statics on those namespaces, `console` on the captured console. See
  [Scoping](#the-method-gate-is-scoped-by-receiver) — this used to be one flat list of names and the flat
  version was the bug;
- a method of the `ml` facade or the `ml.answer` facade, checked by identity (`obj === this.ml`), so their names
  never become callable on anything else;
- a name in `CALLABLE_ROOTS` (`String(x)`, `Number(x)`, `parseInt`, `Array(n)`, `getComputedStyle`, …);
- `new` on a name in `SAFE_CONSTRUCTORS` (`Set`, `Map`, `Array`, `Date`, `RegExp`, …), resolved by name so it
  cannot be rebound;
- one of the script's own arrows, called directly or handed to a host method as a callback.

### The method gate is scoped by receiver

The allowlist was one flat set of NAMES, allowed on every object the dialect could reach, and that was never
what anyone meant: `querySelector` on a string and `map` on an element were already nonsense — they were
simply nonsense that was permitted.

The cost is not tidiness. **A name harmless on one kind can be effectful on another**, and a flat list cannot
tell them apart. `select` is the case that forced the change: on a table facade it picks columns, on an
`<input>` it changes the page's text selection. Adding it for the first would have handed every auto-approved
survey the second.

The codebase had already invented the fix twice, ad hoc — `ANSWER_METHODS` and `ML_READONLY_METHODS` sit
outside the flat set precisely so `x.remove()` and `x.schema()` on a page object stay out of dialect. Scoping
generalises that, and those two become ordinary entries.

Three rules make it a mechanism rather than a lookup table:

- **`kindOf` defaults to DENY.** An unrecognised receiver gets no methods at all and never falls back to `"*"`.
- **`"*"` holds only what is harmless on EVERY receiver** — which is exactly the property that failed for
  `select` — so it stays as close to empty as the language allows (`then`, because the dialect applies a
  callback to a non-thenable; `toString`).
- **Kinds are decided structurally**, never by `instanceof` or a constructor name. The dialect can hold a value
  from an iframe's realm (`ml.queryAll` pierces them), and a page can name a class anything it likes. `Set` and
  `Map` are identified by borrowing their prototype's own `size` getter, which throws on anything that is not
  one — a brand no shape-copying can fake.

Ownership stays a SEPARATE, orthogonal gate: the kind answers "is this name meaningful here", `owned` answers
"may I mutate THIS object". A `Set` reached off a page object is still a `Set`, and must still not be mutable.

### A missing method is not a refusal

Two different "no"s share this gate, and confusing them costs a person's attention.

A method the receiver HAS but the dialect withholds — `input.select()`, `el.click()` — is a real capability.
Escalating is right: approving it is a decision someone can meaningfully make.

A method that DOES NOT EXIST cannot be fixed by any approval. The approved run throws the same `TypeError` a
moment later, having spent a human interrupt on a typo. So it fails immediately, as the runtime error it is,
and is reported to the model — which reads it and corrects itself, with nobody interrupted.

That distinction only works if the CALLER honours it too: `tryReadonly` used to catch every error and fall
through to the gate, so the evaluator's precision was thrown away one level up. `readonlyRefused` (approval.ts)
is the single predicate both loops ask, so the page path and the background path cannot drift on the question
of who gets interrupted.

The curated facades are exempt, and must be: on `ml`, a missing name is a deliberate withholding — the real
`window.ml` has `setModel` and `chat` — so absence there escalates rather than being reported as a typo.

**Ownership: what may be changed.** The `owned` set holds the containers the script created: literals, `new`
instances, and the fresh arrays and objects allowlisted methods return (`.map`, `.filter`, `Object.entries`,
`JSON.parse`). Only those can be written: `o[k] = v` needs an owned plain object or array, and the mutators
(`push`, `sort`, `add`, `set`, `delete`, …) need an owned receiver. A container reached by reading a page value is
never owned, so page state cannot be written. Marking method results as owned cannot launder a page container,
because no allowlisted method returns one; they all build new ones.

**The `ml` facade.** A null-prototype object holding only `ML_READONLY_METHODS` (`getModel`, `config`, `models`,
`capabilities`, `ps`, `serverTools`, `queryAll`, `range`, `a11y`, `dereference`, `info`, `schema`) bound to the real
API, plus two special members. `ml.fetch` answers only from the cache of URLs a human already approved and throws on
a miss, so a new URL goes to approval. `ml.answer` curates the run's answer set.

**Async.** `eval` is a generator: yielding a value asks the driver to await it. `runAsync` drives the top level and
directly called arrows, so `await` works there. `runSync` drives an arrow a host method calls (`.map`, `.filter`),
where there is nowhere to await, so an `await` inside a callback is out of dialect. A facade call that returns a
promise is awaited even without `await`.

**Errors.** `NotInDialect` and `Denied` are guard signals, not program errors: a dialect `try`/`catch`/`finally`
can never swallow one, so wrapping a refused operation in `try` does not make it run. Ordinary runtime errors (a
`TypeError` on a missing element, a `JSON.parse` failure) are catchable as usual.

## Halting

Two properties, kept apart on purpose.

**A. Every script halts, by construction.** This is a property of the language: no script can express an infinite
loop.

- The only loops iterate collections: `for…of`, and the callbacks host methods run over one. There is no `while`,
  no `for(;;)`, no generator and no custom iterator (`Symbol` is not in scope).
- A collection cannot change while it is being iterated. `for…of` holds its iterable for the loop's whole life, and a
  host call that is handed a callback holds its receiver (and `Array.from`'s source) for the call. A mutator or a
  property write on a held collection is `Denied`. So every loop's trip count is fixed when it starts.
- Calls nest at most `MAX_CALL_DEPTH` (256) deep. Recursion is allowed, the way `ml.range` allows a loop: bounded.
  A call tree of bounded depth in which every call does finitely much is finite.

**B. Every script's cost is bounded.** This is a resource policy, not a language property. A script that halts can
still take hours: loops nested over large collections, an array doubled forty times.

| Limit | Value | What it stops |
| --- | --- | --- |
| `STEP_BUDGET` | 3,000,000 steps | Every node evaluated and every element iterated costs one. About a second of main thread when exhausted (measured at 3.2M steps/s); a filter-and-map survey over 20,000 table rows uses 207k. Deterministic. |
| `MAX_COLLECTION` | 1,000,000 | The largest array, `Set` or `Map` one step may produce, checked before `Array(n)`, `new Array(n)` and `Array.from({ length })` run and after every host call. |
| `MAX_STRING` | 10,000,000 chars | The longest string one step may produce: checked before `repeat`, `padStart`, `padEnd` and `join`, and after `+`, templates and host calls. |
| `riskyRegex` | pattern check | A repeated group that contains a quantifier or an alternation (`(a+)+`, `(\w+\s?)*`, `(a\|a)+`) can backtrack exponentially inside one host call, where no budget reaches. Refused before it runs, for regex literals, `new RegExp` and string patterns given to `match`, `matchAll` and `search`. |

Going over any limit throws `NotInDialect`, so the script goes to the human, who sees the code.

**How it was lost once.** Recursion has been possible since the first version (2026-07-20), bounded only by a
5000-deep guard the JS stack overflowed before reaching, and exponential when a function called itself twice.
`for…of` arrived on 2026-08-29 with the argument that nothing could grow an iterable. The next day, writes to
script-owned objects and `Set`/`Map` mutators arrived, and `for (const x of a) a.push(x)` ran forever: an extension
invalidated an argument made for an earlier one, and nothing re-checked it. Regex literals (also 2026-08-29) brought
catastrophic backtracking, and making `ml.answer` free (2026-09-01) broke "a failed attempt leaves nothing behind".
All four are fixed, and each has tests that fail on the old code.

## Working on fetched tables

A survey can read a table the run already fetched, and this needed no extension to the dialect — which is the
point worth recording. A `TableLike` (see `docs/dev/wire-and-fetch.md`) is plain arrays, strings and numbers,
so the existing read mediation already traverses it:

```js
const t = ml.fetch("https://example.com/sales.csv").table;   // cache-only here: no egress, no prompt
const r = t.columns.indexOf("region");
return t.rows.filter(row => row[r] === "west").length;
```

`@tool:<id>.table` reads the same object out of a pointer. Neither needs `await`: the evaluator awaits a host
read before the value is used, and in a full `exec` the pointers are pre-resolved before the script runs.

Two properties are worth stating because they are what make it safe rather than merely convenient. **The table
is not the script's**, so it is READ-ONLY under the ownership rule: `rows.push(...)`, `rows.sort()`, assigning
into a cell and deleting a dtype are all refused, and a survey cannot edit the evidence a later step or the
export reads back. Copy it (`rows.slice()`) to build on it. **The work is bounded by the table**: a traversal
runs over a row count fixed before it starts, and since nothing can mutate the pointer's array there is no way
to grow a collection while iterating it — the halting argument the collection types needed, inherited rather
than re-made. Both have tests; a new kind of value flowing through an existing surface gets the contract
re-checked even when no construct was added.

### The table facade: a receiver kind of its own

Every table a caller receives is a FACADE (`asTable`, table-data.ts; the `Table` type in contract.ts): the data
above, plus `col(name)`, `select(names)`, `records()` and `head(n)`, and a Proxy that THROWS on any other key
instead of answering `undefined` — `t.revenue` or `t[["a","b"]]` gets a message naming `t.col("revenue")` or
`t.select([...])`. That one did need the dialect, as the `table` kind in `BY_KIND`:

- **Recognised by BRAND, never by shape.** `table-brand.ts` holds a WeakSet that only `asTable` adds to, and
  `kindOf` checks it before anything structural. A shape test would trip the facade's own throw, and a
  property or `Symbol.for` brand could be copied by a page onto an `<input>` — whose `select()` is the
  page-mutating method this whole scoping exists to keep out. A spread copy of a facade is a plain object, and
  gets nothing.
- **The facade is ruled out before structural probes.** `isDomCollection` reads `.length` and `.item`; on a
  facade that throws. Any new structural probe over arbitrary values must check `isTable` first.
- **A pandas reach is a RUNTIME error**, reported to the model and catchable in-dialect: no approval can make
  `t.revenue` exist.
- **Cost is checked BEFORE the call** (`preflight`): `records()`, `select()` and `head()` build rows × width in
  one host call, which the step budget never sees, so over `MAX_COLLECTION` cells they are refused (→
  approval). None of the four takes a callback, so none can grow what it walks or recurse; size is the whole
  halting argument.
- **Nothing reaches the source.** Results are fresh (owned by the script, so `col(...).sort()` is fine); `head`
  and `select` copy the column list and keep the SOURCE's dtypes rather than re-measuring a prefix; the facade
  refuses set, delete and defineProperty; the source's own arrays are not owned, so the ownership gate refuses
  mutating them through any path.
- **A prefix stays a prefix.** `head(n)` counts only its rows, except over a truncated table holding fewer than
  `n`, where it is still missing rows and keeps `truncated`.

Tests: the `table facade` block at the end of `tests/readonly-exec.test.mjs` (use, forgery, escapes, mutation
through every path, the pre-call size check with its timing, a failed survey leaving the table intact).

## Where it is called

- **Page-hosted runs**: `tryReadonly` in `injected.ts` expands pointers, binds the run's resolver, calls
  `evalReadonly`, and returns the result as the tool's; on any throw it returns null and the loop goes to the
  approval gate.
- **Background-hosted runs**: `readonlyTry` in `run-delegation.ts` does the same inside the page for a loop that
  lives in the service worker; its resolver rings the worker, where the pointer store lives.
- **After approval**: the real `exec` tool (`tools.ts`) expands pointers, resolves them, and runs the code with
  `eval`, or through CDP on a page whose CSP forbids `eval`.

Both read-only callers format through ONE function, `formatReadonlyExec` (approval.ts), which returns the model's
string (`console:` then `value:`, clipped at 500) AND the UI's `exec-out` descriptor — console and value as their
own sections, `seen` at the model's cut — so an auto-approved survey renders like an approved `exec` instead of as
one raw blob. A script error already had one. An element result is the exception: it keeps the hoverable
element list. The read-only console carries no produced-at marks, so its output has no timestamp gutter.

## Extending the dialect

The rule is in AGENTS.md. Every new construct, method or facade member needs, in the same change:

1. **Escape tests**: try to use the new thing to reach the realm, call an effectful method, write to a page object,
   or smuggle a method out as a value. Each must be refused or inert.
2. **Halting tests**: can it loop without a fixed trip count? Can it change a collection that something is iterating?
   Can it recurse past the depth cap by a route the cap does not see? Can one host call do work proportional to an
   argument, with no budget or size check in front of it?
3. **Failure tests**: if a script uses the new thing and then falls out of dialect, is everything it changed restored?
4. **This file**, updated.

Tests for anything that could loop run in a worker with a timeout (see `inWorker` in the test file), so a regression
fails in seconds instead of hanging the runner.

## Known gaps

- The regex check is conservative and incomplete. It refuses `(?:x|y)+` along with the dangerous shapes, and it
  does not catch polynomial backtracking from many adjacent overlapping quantifiers (`\s*\s*\s*x`). A linear-time
  regex engine would close it and is not worth the weight today.
- The halting rules are conservative too: a callback that mutates the array its own `.map` is walking is refused,
  although array methods fix their length and would halt.
- `join` on an array of very long strings can allocate up to V8's string limit before the result check refuses it.
- It is not a sandbox against a determined attacker crafting new reflection tricks; that is what SES (Hardened
  JavaScript) is for. It is an approval-fatigue reducer for an honest model that fails closed.

## Related designs

- **Starlark** (Bazel's configuration language) guarantees termination the same way: no `while`, no recursion by
  default, and mutating a collection while iterating over it is an error. The halting rules here arrived at the
  same place independently.
- **The eBPF verifier** admits a program into the kernel only if it can show the program terminates and stays in
  bounds, and refuses it otherwise. Same shape: execution gated on what the program provably cannot do.
- **smolagents' local executor** walks agent-written Python with an import allowlist and an operation cap.

What this dialect adds is using membership as the approval decision: in the dialect, it runs without a prompt; one
construct outside it, and a person is asked.
