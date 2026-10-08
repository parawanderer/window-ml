# The read-only `exec` dialect

How `exec` runs a script with no approval prompt, what that promises, and what it is for. Keep this file current: any
change to `pointer-macro.ts`, `readonly-exec.ts` or `readonly-exec/` that changes what a script can do changes a
section here. The original design spec is [`docs/spec/READONLY_EXEC_SPEC.md`](../spec/READONLY_EXEC_SPEC.md); it
describes v1 and is out of date on most of the grammar.

## Where things live

`src/readonly-exec.ts` is the entry every caller imports: `evalReadonly`, plus a re-export of every public name
below, so nothing outside the folder imports `readonly-exec/` directly. The pieces:

| File | Holds |
| --- | --- |
| `readonly-exec.ts` | `evalReadonly`: builds the root scope, parses, runs the evaluator, restores on failure, attaches the failing line |
| `readonly-exec/limits.ts` | the refusals (`NotInDialect`, `Denied`, `NeedsPage`), the halting rationale and bounds (`STEP_BUDGET`, `MAX_COLLECTION`, `MAX_STORED_CELLS`, `MAX_STRING`, `MAX_CALL_DEPTH`, `PIPE_CHARS_PER_STEP`), `riskyRegex` |
| `readonly-exec/tokenizer.ts` | `tokenize`, regex-vs-division, template literals, the punctuators and `COMPOUND` |
| `readonly-exec/parser.ts` | the `Parser` (Pratt, the `BP` table) and the AST `Node` type |
| `readonly-exec/policy.ts` | what may be read, called, built and written: `DENIED_PROPS`, the method gate (`BY_KIND`, `kindOf`, `methodAllowed`, the Set/Map brand checks), `CALLABLE_ROOTS`, `isWritableTarget`, `SAFE_CONSTRUCTORS`, `MUTATING_METHODS`, `ANSWER_METHODS`, `ML_READONLY_METHODS`, and `mlFacade`, the `ml` object the dialect sees |
| `readonly-exec/print.ts` | the print boundary's helpers: `abridgeRow` (`ABRIDGE_OVER`), `PrintSwap`, `describeSwaps` and the JSONPath that names a substitution |
| `readonly-exec/evaluator.ts` | the `Evaluator` (scope, reads, calls, writes, ownership, iteration guard, `printable`) and its two drivers, `runAsync` and `runSync` |

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

`tokenize` (`readonly-exec/tokenizer.ts`) and the `Parser` class (`readonly-exec/parser.ts`). The grammar is the
first whitelist: a shape the parser does not know throws `NotInDialect`, so the parser can be deliberately incomplete
and stay safe.

- Tokens: numbers (no exponent or hex), strings, template literals (each `${…}` is re-tokenized and parsed as an
  expression and must consume fully), regex literals (told from division by the previous token), identifiers,
  punctuators. Comments are skipped.
- Expressions, by precedence climbing (the `BP` table): literals, identifiers, member access (`.x`, `?.x`, `[e]`,
  `?.[e]`), calls (`f(a)`, `?.(a)`, spread arguments), arrows and function expressions, array and object literals
  (with spread and shorthand), `new Ctor(…)` for a bare name, unary `! - typeof`, binary arithmetic and comparison,
  `**` (tighter than `*`, right-associative; an unparenthesised unary operand on its left — `-2 ** 2`, `await x ** 2`
  — is refused, as JavaScript refuses it; a BigInt operand is refused because its cost grows with the exponent inside
  one operation), `&& || ??`, the ternary, `await`, assignment (`=` and `+= -= *= /= %=`) and `++`/`--`, prefix or
  postfix, whose target is either a member of a container the script built or a bare name the script declared.
- Statements: `const`/`let`/`var` with one declarator (or a shorthand array or object destructuring pattern),
  `if`/`else`, `for (const x of …)`, `try`/`catch`/`finally`, `return`, blocks, expression statements. The value of
  a program is its last expression statement or its `return`.
- Deliberately absent: `while`, `do`, C-style `for(;;)`, `for…in` (a prototype-chain read), the short-circuiting
  compound forms `||= &&= ??=` (whether the write happens at all depends on the value, and a form whose effect you
  have to evaluate the operand to predict is the wrong one for a dialect that exists to be predictable), classes,
  generators, getters, labels, `this`, `delete`.

#### Assignment to a bare name

A binding the evaluator created has no existence outside it, so writing to one cannot be observed by the page —
the same argument that already lets a script build an array and push to it. Without this, one `let n = 0; … n += 1`
sent an entire read-only survey to the human gate, which is the counter idiom a model reaches for constantly.

What makes it safe to tell apart is the SCOPE SHAPE. Frames are a prototype chain of plain objects, one per block,
loop iteration and arrow call. The frame at the end of that chain — the host's `document`, `ml`, `Math`, `console` —
is built with `Object.create(null)`, and the script is given a frame of its own over it. So "does this name belong
to the environment?" is answered by `Object.getPrototypeOf(frame) === null`, not by a list of names that would go
stale the next time one is added.

Three refusals, each a different way the page could otherwise be reached:

| | why |
| --- | --- |
| `document = 1`, `ml += 1`, `Math++` | the name resolves to the null-prototype frame |
| `leaked = 1` | nothing declared it; in real JS this creates a global, so here it is refused rather than created |
| `const n = 1; n = 2` | accepting it would make the dialect compute a value real JavaScript would not |

The target is resolved BEFORE the right-hand side is computed, so `ml += 1` is refused rather than coercing the
facade on its way to a refusal and reporting "Cannot convert object to primitive value" — a runtime error about the
wrong thing. Const-ness is tracked as an own, non-enumerable `Set` per frame: read through the prototype chain it
would be the ENCLOSING frame's set, and an inner `const x` would freeze an outer `let x` that merely shares its name.

Rebinding launders nothing. `owned` is a property of the VALUE, not of the name holding it, so moving a DOM node
into a local changes nothing about what may be written through it, and a method lifted off a host object stays the
inert `METHOD_REF` sentinel however many names it passes through.

### 3. The evaluator

The `Evaluator` class (`readonly-exec/evaluator.ts`) walks the AST, consulting the tables in
`readonly-exec/policy.ts`. It is where every read and call is mediated, and where ownership and halting
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

Two properties, kept apart on purpose. The bounds below, and the comment stating both properties, are in
`readonly-exec/limits.ts`.

**A. Every script halts, by construction.** This is a property of the language: no script can express an infinite
loop.

- The only loops iterate collections: `for…of`, and the callbacks host methods run over one. There is no `while`,
  no `for(;;)`, no generator and no custom iterator (`Symbol` is not in scope).
- A collection cannot change while it is being iterated. `for…of` holds its iterable for the loop's whole life, and a
  host call that is handed a callback holds its receiver (and `Array.from`'s source) for the call. A mutator or a
  property write on a held collection is `Denied`. So every loop's trip count is fixed when it starts.
- Calls nest at most `MAX_CALL_DEPTH` (256) deep. Recursion is allowed, the way `ml.range` allows a loop: bounded.
  A call tree of bounded depth in which every call does finitely much is finite.
- A MUTABLE BINDING does not change any of that, which is the obvious worry about it and the reason the argument is
  written out here. A `while` is what a mutable counter buys you in a normal language, and there is no `while` to
  buy: `for…of` over an iterable captured at loop entry is the only loop form. Rebinding the NAME the iterable came
  from is invisible to a loop already holding the value, so `let a = [1]; for (const x of a) a = a.concat([x])`
  terminates — while `a.push(x)` on the same loop is still `Denied`, because the hold is on the value. And a counter
  cannot buy call depth, which is fixed by the source.

**B. Every script's cost is bounded.** This is a resource policy, not a language property. A script that halts can
still take hours: loops nested over large collections, an array doubled forty times.

| Limit | Value | What it stops |
| --- | --- | --- |
| `STEP_BUDGET` | 3,000,000 steps | Every node evaluated and every element iterated costs one. About a second of main thread when exhausted (measured at 3.2M steps/s); a filter-and-map survey over 20,000 table rows uses 207k. Deterministic. |
| `MAX_COLLECTION` | 1,000,000 | The largest array, `Set` or `Map` one step may produce, checked before `Array(n)`, `new Array(n)` and `Array.from({ length })` run and after every host call. |
| `MAX_STRING` | 10,000,000 chars | The longest string one step may produce: checked before `repeat`, `padStart`, `padEnd` and `join`, and after `+`, templates and host calls. |
| `riskyRegex` | pattern check | A repeated group that contains a quantifier or an alternation (`(a+)+`, `(\w+\s?)*`, `(a\|a)+`) can backtrack exponentially inside one host call, where no budget reaches. Refused before it runs, for regex literals, `new RegExp`, string patterns given to `match`, `matchAll` and `search`, every pattern `ml.pipe`'s `grep`/`sed` stages are about to compile, and every `ml.jsonPath` `match()`/`search()` pattern. |
| `PIPE_CHARS_PER_STEP` | 64 chars | `ml.pipe` is one host call doing work proportional to its input, which the step count never sees: a pipe inside a `.map` would cost one step per call. So each stage is charged its input and its output at this rate. Calibrated on the slowest stage (`sort`, ~200M chars/s) so a budget spent on pipes is about a second, like everything else. |
| `ml.jsonPath` | 1 step per node | One query is one host call whose work the step count never sees, and `$..[?@..x]` is quadratic in depth. Every node a descent visits, every member a selector or filter reads, every step of a `==` comparison and every key of a printed Normalized Path is charged to `STEP_BUDGET`. Each `match()`/`search()` pattern passes `riskyRegex` after translation from I-Regexp. Only a sanitized `{ paths }` is forwarded. Data is read as DATA: a getter (on a member or an array index), a `Map` or a DOM node is an error, not a walk, and a cycle under `..` is an error (`tests/readonly-jsonpath.test.mjs`). |
| `OUTPUT_CEILING` | 32,000,000 chars | The console output one survey KEEPS (output-clip.ts, shared with every tool). `MAX_STRING` bounds one string, not how many are printed: 200 prints of a 9 MB string were 1.8 GB held and then `Invalid string length` when joined. Past it a line is counted, not kept and not streamed. |

Going over any limit throws `NotInDialect`, so the script goes to the human, who sees the code. The exception is
`OUTPUT_CEILING`: printing too much is not a reason to ask anyone, so the survey answers, and the model is told after
its clip what was not kept and to print less.

**`ml.pipe` is the one host call that can GROW its input by more than a constant factor**, so `MAX_STRING` alone does
not bound it: that check runs after a host call returns, and there the allocation already happened. Two stages are
refused BEFORE they build: `sed` (a copy of the replacement per match, and a match per character with `g`; a `$&`
counts as a whole line) and the JSON stages that pretty-print (`.path`, `values`), which are quadratic in nesting
depth: `"[".repeat(3000) + "]".repeat(3000)`, 6,000 characters, re-emitted through `.` as 18,000,000 in one call
(measured), bounded by an iterative walk since the recursive one overflows the stack at the same depth stringify
does. Every other stage's output is checked after it runs, which catches the linear growers (`grep -on .` is four
times its input). The pipe's SOURCE is unwrapped by the dialect from own DATA properties, never by the host, so a
getter on a page object never runs, and a third argument from the script is never forwarded, so it cannot pass limits
of its own (`tests/readonly-pipe.test.mjs`).

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

### A stored table: the same kind, reads that are requests

A pointer's table whose whole value is in the value store (POINTER_VALUES slice 7) is the same `table` receiver
with the same four methods, but `col`, `select`, `records` and a `head` past the preview read EVERY row through a
reader bound to the run, and return promises. No construct was added, and the contract was re-checked for the new
value:

- **Awaited like `ml` calls.** A call on a stored facade (`isStoredTable`, a second brand granted only by `asTable`)
  that returns a promise is yielded to the driver, so a survey writes `t.col("x").length` with no `await`. Inside
  a `.map` callback there is nowhere to await, so the read falls out of dialect rather than leaking a promise into
  the data.
- **Sized by `shape`, before the request.** The preflight measures a stored table by `shape[0]`, not by the preview
  in `rows`, so a column of a two-million-row table is refused (→ approval) without being fetched.
- **Bounded in total.** Each read is one host call doing work proportional to the table, which the step budget
  never sees, so reads across one script are capped at `MAX_STORED_CELLS` (5M). A loop of under-cap reads stops
  there.
- **The reader is unreachable.** It is a closure inside the facade: not a property, not extractable as a method
  (the METHOD_REF rules apply to `col` as to any method), and the returned promise leads nowhere (`.then` is not a
  callable in dialect).
- **Nothing is left behind.** A read only fetches, and the column handed back is a fresh array owned by the script.

Tests: the `stored table` block in `tests/readonly-exec.test.mjs`.

## Where it is called

- **Page-hosted runs**: `tryReadonly` in `ml-agent-run.ts` expands pointers, binds the run's resolver, calls
  `evalReadonly`, and returns the result as the tool's; on any throw it returns null and the loop goes to the
  approval gate.
- **Background-hosted runs**: `tryReadonly` in `sw-run-host.ts` evaluates the survey in the WORKER first
  (`sw-readonly.ts`, with the `ml` of `worker-readonly-ml.ts`, which reads the run's pointers in-process). Only one
  that reaches for the page is sent there, to `readonlyTry` in `run-delegation.ts`, which REFUSES every pointer read:
  a survey needing both the page and the run's pointers goes to the approval gate. Each decision is an execution-log
  record, subsystem `routing`: `readonly-worker` (`no-page-reads` or `out-of-dialect`) or `readonly-page`
  (`reads-page` or `refused-in-page`). The step's In is drawn in the worker too (`execCodeIn`), so a survey the
  worker answers never sends its script to the page.
- **After approval**: the real `exec` tool (`tools.ts`) expands pointers, resolves them, and runs the code with
  `eval`, or through CDP on a page whose CSP forbids `eval`.
- **The Run state panel's watches** (`sw-run-state.ts`, `state-watch.ts`): a watch that is not JSONPath is a dialect
  expression, evaluated in the worker realm with `ml.current` the live snapshot and one more root, `inspector`, bound
  through `evalReadonly`'s `globals` (the panel's tree of the run's other state). `globals` is plain data, COPIED;
  a name the environment already has (`document`, `ml`, `Math`…) or a denied one is not bound, and a function cannot be
  (the copy refuses it). The dialect already refuses a write to anything the script did not build, so the copy is a
  second wall. A watch runs on a smaller budget (`WATCH_STEPS`), since the panel re-reads every watch every two seconds.
  Its adversarial, halting and failure tests are `tests/readonly-globals.test.mjs`.

Both read-only callers format through ONE function, `formatReadonlyExec` (approval.ts), which returns the model's
string (`console:` then `value:`, clipped at 500) AND the UI's `exec-out` descriptor — console and value as their
own sections, `seen` at the model's cut — so an auto-approved survey renders like an approved `exec` instead of as
one raw blob. A script error already had one. An element result is the exception: it keeps the hoverable
element list.

### It streams, and a refused try takes its lines back

On a streaming run (`stream: true`) a survey's console lines stream live, as an approved `exec`'s do. The loop hands
`tryReadonly` the call's live sink (`LiveOutput`, agent-loop.ts), and `evalReadonly` calls `opts.onLog` with each
line as it prints: the SAME string it pushes to `logs`, through the print boundary, so what streams is what the model
will be given, abridged rows included. Each host carries it to the sink: the page-hosted path directly, the
background-hosted path through `PAGE_TOOL_STREAM` and `delegateStreams` like any delegated tool, the worker realm
through `WorkerReadonlyDeps.live`. Lines carry produced-at marks, so a streamed survey has a timestamp gutter; one
that did not stream has none.

A try can be refused PART WAY through, at run time, after lines have printed. Those are output from a run that did
not happen, and the dialect's promise is that a refusal leaves nothing behind. So when `tryReadonly` returns null the
loop calls the sink's `discard()`, before the gate opens: it cancels a pending throttled emit, empties the fan, and,
if anything had been shown, emits an empty `streamOutput`, which the reducer reads as "nothing streamed". The
approved run, if any, streams into the same sink from empty. The background host drops its `delegateStreams` entry
before returning, so a chunk still in flight from the refused try finds no sink instead of landing after the
discard. The worker realm discards on `needs-page` too, since the page's retry prints the same lines again.

Holding the lines until the try is known to be in dialect was the alternative, and it defeats the point: refusal is
decided at run time, so nothing could stream until the survey had finished. Tests: `tests/readonly-stream.test.mjs`
and `tests/e2e/readonly-stream.spec.mjs`.

## Two realms: the page, and the worker

A delegated survey used to be evaluated only in the page's main world, so anything it read about the RUN (another
origin's content, the system prompt, a `@tool:` value) landed in a realm a hostile page controls, and a read-only
survey AUTO-APPROVES, so a prompt-injected one would hand it over with no human asked. `evalReadonly` now takes a
`realm`, and the two have DISJOINT capabilities:

| realm | has | has not |
| --- | --- | --- |
| `page` (default) | `document`, `getComputedStyle`, `ml.queryAll`/`a11y`/`fetch` (cached)/`answer` | the run's context: `ml.current` is a REFUSAL, not `undefined` |
| `worker` (`sw-readonly.ts`) | `ml.current`, and whatever read-only `ml` the host hands in, `fetch` included (cache-only, over the run's own `fetch_url` reads) | the page: every route to it raises `NeedsPage` |

The host tries the worker first and delegates to the page on `NeedsPage`. A survey needing both trips in the worker
and is refused on the page, so it reaches the human in either order. Nothing lexical decides it: an alias
(`const m = ml; m.current`) cannot add a capability a realm does not have, which a scan for member names could not
promise.

- **The worker's `ml` is an ALLOW list.** Built by leaving out what reads the page, and reaching ANY member it does
  not carry (by a read, a call or a destructuring) raises `NeedsPage`, so a page-reading member added later costs an
  extra hop and never a hole. The page roots `document` and `getComputedStyle` are getters that raise it.
- **`ml.fetch` is cache-only in both realms, each over its own cache.** In the worker a miss, or any mode the cache does
  not hold, raises `NeedsPage`: the page's cache (an approved exec's inline fetch) or its live document may answer it.
  On the page a miss is a refusal. Both caches hold frozen copies, so a survey that writes to a re-read result gets a
  `TypeError` and the next re-read is unchanged.
- **`NeedsPage` subclasses `NotInDialect`**, so it inherits every refusal guarantee for free: `try/catch` re-raises it,
  the evaluator rolls back on it, and a caller that does not know the class reads it as a refusal and asks the human.
- **On the page, `ml.current` refuses rather than reading `undefined`.** An absent member has always read as
  `undefined` there, which is right for an existence guard and wrong here: `document.title + ml.current.messages.length`
  would auto-approve with the answer `"titleundefined"`. The name is reserved.
- **`ml.current.messages` is protected**: a write, a mutator or a nested write throws a `TypeError` the model reads,
  never a refusal, because the human gate would then run the script on the page where there is no `ml.current`. `run`,
  `meta` and `log` are copies the script owns.
- **`ml.current.debug`** (`{ userWatches }`, the watches the person shared from the Run state panel) is there only when
  the host adds it, which a worker-hosted run's does (`sw-shared-watches.ts`). It is protected the same way, with its
  own `TypeError` ("ml.current.debug is read-only"), since it is the person's words. Its values are computed before the
  survey, each over `{ ml: { current } }` alone, so nothing the model may not read gets into it.
- **The print boundary** abridges a large message row (over `ABRIDGE_OVER` characters) into its role, size, a preview
  and the expression that prints it whole, in `console.log` and in a returned value. The VALUE is untouched.
- **Every substitution says so, and the sentence is generated.** `printable` is the one place a print may differ from
  the value, and it records each substitution as a DIFF of the printed object against the original (fields removed,
  added, retyped). `describeSwaps` turns those into notes in JSONPath, relative to what was printed, with sibling
  places as one union: `[console.log printed a VIEW: $[0,3].content REPLACED by virtual $[0,3]['chars','preview','abridged']; …]`.
  The evaluator returns the substitutions STRUCTURED (`prints`), each with its compact JSON, and the FORMATTER writes
  the notes, because only it knows where each part is cut: the model is told of a substitution only if it starts
  inside the part the model was sent, and the panel of those inside its longer copy. The notes go AFTER the clip,
  where the cut cannot remove them, and the panel draws them inside the section they describe, in a cell of their
  own after the output. They stay short however many places there are: a run of indices is a slice (`$[0:40]`, a
  stride `$[0:39:2]`), and past eight places a note names the first and says how many there were. A new kind of
  substitution is described the day it exists, and a test fails if a print differs from its value without a note
  whose paths select exactly the substituted objects.

**What the realms do not cover**: a survey's RESULT. It is a tool result, and reaches the page the way every tool result
does, through the debug stream relayed through the page's window, in every `debugMode` (measured by the
`demo/ml-current-e2e` demo). The realms keep the snapshot from being evaluated in the page; closing that channel is the
site-access work's.

The worker realm is wired for background-hosted runs (`tryReadonly` in `sw-run-host.ts`, above). Its `ml` carries
`dereference` when the host has the run's pointer store, answered in-process; `.pipe()` on the value stays out of
dialect, as on the page. A page-hosted run still evaluates on the page, where its loop and its own pointers live.
Tests: `tests/readonly-current.test.mjs` (the realm, the worker's `ml`, its adversarial and halting cases),
`tests/delegation.test.mjs` (the page leg refuses pointer reads) and `tests/run-start.test.mjs` (the routing, against
the bundle).

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

## The rule for extending the dialect

**RULE — extending the dialect requires adversarial tests.** Any time you add a construct to the
read-only dialect (a new statement/operator/pattern, a new allowed method, a new facade member),
you MUST — without being asked — add ADVERSARIAL tests that try to abuse the NEW pattern to reach
something it shouldn't (extract/invoke an effectful method, walk to `window`/`constructor`/a realm,
mutate, spend tokens, loop unbounded) and assert each is REJECTED (`NotInDialect`/`Denied`) or
rendered inert (the `METHOD_REF` sentinel). A new binding form (e.g. destructuring) must be probed
for whether it can bind a live method or reach a denied prop; a new allowed method for whether its
return leaks the realm. The invariant is unchanged: gaps degrade to "asks the human," never to "runs
unsafely" — new tests prove the new surface keeps that.

  **The escape tests are not enough on their own: re-check the whole CONTRACT, not just the new surface.** An
  extension can break an argument made for an EARLIER one, and nothing notices: `for…of` was argued terminating
  because nothing could grow an iterable, and the next day's owned `Set`/`Map` mutators made
  `for (const x of a) a.push(x)` run forever. So every extension also gets, in the same change: HALTING tests (can it
  loop without a trip count fixed at the start, change a collection something is iterating, recurse by a route
  `MAX_CALL_DEPTH` does not see, or do work proportional to an argument inside one host call with no budget or size
  check in front of it?), FAILURE tests (a script that uses it and then falls out of dialect leaves nothing behind),
  and an update to `docs/dev/readonly-exec.md`. Anything that could loop is tested in a worker with a timeout, so a
  regression fails instead of hanging the runner.
