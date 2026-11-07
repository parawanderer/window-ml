# Spec: auto-approve read-only `exec` via a mediated mini-interpreter

> The original v1 design, kept for its reasoning. The dialect has grown well past it (loops, `try`, `new`, regex,
> destructuring, owned mutation, halting rules), so for what the code does now read
> [`docs/dev/readonly-exec.md`](../dev/readonly-exec.md).

Status: experimental / incremental. It's fine if it's incomplete — anything the
interpreter doesn't understand **falls back to the existing approval + `eval`
path**, so gaps degrade to "asks the human," never to "runs unsafely."

## Motivation

The agent's `exec` tool is `requiresApproval: true` — every call blocks on a
human. But the overwhelmingly most common `exec` is a **read-only DOM survey**:

```js
Array.from(document.querySelectorAll('input, textarea, [contenteditable="true"]'))
  .filter(el => el.placeholder === 'Ask Gemini'
             || el.innerText.includes('Ask Gemini')
             || el.getAttribute('aria-label')?.includes('Ask Gemini'))
  .map(el => ({ tagName: el.tagName, id: el.id, className: el.className,
                outerHTML: el.outerHTML.slice(0, 100) }))
```

These do nothing but read the DOM and return a plain-object summary. Approving
them one-by-one is pure friction, and on Trusted-Types pages (Gmail) the normal
`eval` path is *dead* anyway (`require-trusted-types-for 'script'` throws on
`eval`/`Function`).

## Goals (one artifact, three wins)

1. **Auto-approve** the stereotypical read-only survey dialect (no human prompt).
2. **Bypass Trusted Types** for those cases — we walk the AST and call real
   methods by reflection; **no string is ever compiled**, so the TT script-sink
   is never hit.
3. **Stay safe** — not by hoping, but by *mediating* every property read and
   every call. The interpreter is the boundary because it interposes on every
   operation.

A tree-walker gives all three at once **because** it's the whitelist (only the
dialect it models runs), it never compiles strings, and it can say "no" at each
member/call.

## Threat model (what we're actually defending)

`exec` runs in the **page's main world with the page's own privileges** — no
escalation to prevent. The approval gate exists to protect the *user* from the
*model* doing an unintended side-effecting action (submit, delete, exfiltrate via
the authenticated session). So the goal isn't a hard sandbox against a
determined attacker; it's: **auto-run the provably read-only stuff, and never
let the auto-approved path do anything observable.** The model is honest-but-
fallible (possibly nudged by page-injected text), not an exploit author probing
for `.constructor.constructor` — but we close that anyway because it's cheap.

## The dialect (v1 grammar)

Expressions: literals (string/number/`true`/`false`/`null`/`undefined`),
template literals, identifiers (resolved against a curated root scope), member
access `.x` / `?.x` / `[e]` / `?.[e]`, calls `f(a)` / `?.(a)`, arrow functions
(`x => e`, `(a,b) => e`, `x => { … }`), array/object literals, unary
(`! - typeof`), binary (`=== !== == != < > <= >= + - * / %`), logical
(`&& || ??`), ternary.

Statements (for arrow blocks + program): `const`/`let` (single declarator),
`return`, expression statements. Program value = the last expression, or a
returned value.

Also supported (added after models kept falling back on them): **spread** in
array literals and call args (`[...querySelectorAll(...)]`, `Math.max(...xs)`) and
**function expressions / IIFEs** (`(function(){ … })()`, parsed to the same
mediated closure as an arrow), and **`if`/`else` statements** (guard clauses —
control flow over read-only ops, still no effectful operations).

**Explicitly NOT in dialect** (→ fall back to approval): assignment of any kind
(`=` outside a declaration, `+=`, `++`), `new`, `delete`, `for`/`while`, `try`,
rest/destructuring, regex literals, `await`, labeled/`this`. Add cases as they
come up — each addition is opt-in and only *grows* the auto-approve surface.

## Mediation (the boundary)

The evaluator is handed a **curated root scope** and nothing else:
`{ document, Array, Object, JSON, console, Math, String, Number, Boolean,
parseInt, parseFloat, isNaN }`. No `window`, `fetch`, `location`, `localStorage`.

Two lines of defense, together robust:

- **Calls are allowlisted (the real boundary).** A `CallExpression` runs only
  when the callee is `obj.method(...)` with `method ∈ ALLOWED_METHODS`
  (read/query/pure names only: `querySelector*`, `getAttribute`, `closest`,
  `matches`, `map`, `filter`, `reduce`, `find`, `some`, `every`, `includes`,
  `slice`, `join`, `split`, `toLowerCase`, `trim`, `startsWith`, `keys`,
  `values`, `entries`, `stringify`, `from`, `isArray`, `log`, …), OR the callee
  is a whitelisted root builtin (`Number(x)`, `parseInt(x)`, `Array.from(x)`),
  OR the callee is an in-dialect arrow (so `(() => …)()` works and `.map(cb)`
  runs its callback). **No side-effecting/exfil method is in the list**, so even
  if the code somehow holds `window`, `window.fetch(...)` is `method: "fetch"` ∉
  allowlist → fall back. `.click()`, `.submit()`, `.setAttribute()`,
  `.appendChild()`, `.remove()` are all absent → never auto-run.
- **Reads are denylisted (defense in depth).** A member read throws `Denied` for
  `constructor`, `__proto__`, `prototype`, `ownerDocument`, `defaultView`,
  `contentWindow`, `contentDocument`, `location`, `cookie`, `parent`, `top`,
  `opener`, `self`, `window`, `globalThis`, `eval`, `Function`,
  `__define*`/`__lookup*`. This kills `.constructor.constructor` → `Function`
  and stops grabbing `window` off a node. Computed keys (`el[expr]`) get the
  **runtime** key checked against the same denylist, so `el['owner'+'Document']`
  is caught too.

A member read that yields a **function** value outside call position →
`NotInDialect` (we don't support passing methods around), so `const f =
el.getAttribute; f(x)` can't smuggle a call past the allowlist.

Result of both: the auto-approved path can **read** the DOM and compute, and can
**call nothing that has an effect**. `Function`/`eval` are unreachable.

## The read-only `ml` slice (self-introspection)

The agent asked "which model am I?" writes `await ml.getModel()` in `exec` — a pure
read that was costing a human approval. So the dialect gets an `ml`, but **not**
`window.ml`: `mlFacade` builds a null-prototype object holding only
`ML_READONLY_METHODS` — `getModel`, `config`, `models`, `capabilities`, `ps`,
`serverTools` — bound to the real API. The free set is enforced by *what exists*,
not only by a name check.

- Excluded on purpose: `setModel`/`unload` **mutate** (`setModel` would re-point the
  model the run itself is using), `chat`/`agent`/`read` spend tokens+VRAM and can
  recurse, `pythonExec`/`screenshot` are **privileged**.
- Those names deliberately never join `ALLOWED_METHODS` (which is keyed by *name*
  across every object): the facade carries its own allowlist, checked by identity
  (`obj === this.ml`) in `evalCall`.
- No new capability. `window.ml.config()` is callable from the page's own console,
  and `config()` is already the non-secret `MlPublicConfig` subset (no URL, no API
  key). This lifts an approval **prompt**, not a privilege boundary.
- Returns are structured-clone JSON off `chrome.runtime.sendMessage` — no DOM nodes,
  no realm references — and every read on them still goes through the denylist.

**Async.** Every one of those methods is a Promise, so `Evaluator.eval` is a
**generator**: `yield` a value to have the driver await it. Two drivers —
`runAsync` at the top level, and `runSync` for an arrow a host method invokes
(`arr.map(fn)` calls `fn` synchronously, so there is nowhere to await). An `await`
inside a callback therefore throws `NotInDialect` and the survey falls back to
approval — never a silently Promise-valued answer. A facade call is auto-awaited
even without `await`, so a forgotten one still reads the value.

Models don't write one call at a time, so the async shapes they actually produce
are supported too: `Promise.all([ml.models(), ml.getModel()])` (`Promise` is in
scope as a **namespace only** — `all`/`allSettled` are allowlisted; it is not a
`CALLABLE_ROOT` and `new` isn't in the dialect, so no promise can be minted around
anything the gates didn't already allow), and `ml.getModel().then(m => …)`, where
auto-await has already left a plain value so `then` applies the callback to it —
`Promise.resolve(x).then(cb)` semantics, driven by our own driver so an `await`
inside the callback still works. The callback must be **inline**: a method
reference can't be smuggled through `then()`.

**How the model learns this.** Not the system prompt — every run would pay for it.
It's a runtime section of the `agent_api_docs` tool (`selfIntrospectionSection`),
beside the HUD-shortcut section and for the same reason: it's true only while
`autoApproveReadonly` is on, so it's resolved live from `GET_CONFIG` and omitted
entirely when the flag is off (saying otherwise would be a lie the model acts on).

## Integration (fail-closed, side-effect-free)

Because the interpreter can't cause side effects, wiring is trivial and safe:

In the agent loop's `requiresApproval` branch, for `tool === "exec"` when the
config flag is on:

```
try {
  const { value, logs } = await evalReadonly(args.js, document, window.ml);   // rejects if outside dialect / denied
  result = formatExecResult(value, logs);                                     // reuse exec's own formatting
  // → skip approval, skip eval; TT never touched
} catch {
  // NotInDialect or Denied → do nothing observable happened; fall through to the
  // normal approval prompt + eval path, exactly as today
}
```

No separate static analysis: *attempting* the interpreter is free (read-only), so
"run it; on any throw, fall back" is both simplest and safe. A partial evaluation
before a throw is harmless — nothing in the dialect mutates or fetches.

`evalReadonly` lives in its own dep-free module `readonly-exec.ts`, bundled into
`injected.js` and unit-tested directly under the `tsx` loader. It takes the
`document` and (optionally) `window.ml` as parameters — the real ones in the page,
jsdom's + a stub in tests. Both call sites (`injected.ts`'s page loop and
`run-delegation.ts`'s design-A delegate) `await` it inside their existing
`catch → fall back` blocks, so a rejected `ml` call (server down) simply degrades to
the approval path.

## Config + UI

- New non-secret config `autoApproveReadonly: boolean` (default `false`).
  - `DEFAULT_CONFIG` in `background.ts` **and** `popup.ts` (kept in sync).
  - Returned by `GET_CONFIG` so the page/agent can read it via `ml.config()`.
- Sidebar Settings checkbox: **"Experimental: auto-approve read-only exec
  calls"** (under a suitable group), wired like `autoTitles`.

## Testing (`tests/readonly-exec.test.mjs`)

- **Runs the two canonical surveys** end-to-end against a jsdom DOM, asserting
  the returned summary objects.
- **Escape attempts all throw** (→ fall back): `(()=>document.querySelector('x')
  .ownerDocument.defaultView.fetch('/x'))()`, `({}).constructor.constructor('…')`,
  `el['owner'+'Document']`, bare `fetch(…)`, `window.location`, `.setAttribute`,
  `x = 1`, `document.body.innerHTML = 'x'`.
- **Out-of-dialect falls back** (throws `NotInDialect`, not a crash): `for`
  loops, `function(){}`, assignment, `new`.
- **The `ml` slice**: the six free reads resolve (with and without `await`, and
  composed mid-expression); the gated half (`setModel`/`unload`/`chat`/`agent`/
  `read`/`screenshot`/`pythonExec`, plus the `ml['set'+'Model']` computed dodge) is
  rejected **at the gate** — the stubs throw a distinct `RAN:` error, so a test can
  tell "refused" from "actually invoked". The facade is not a path back to the realm
  (`ml.constructor`, `ml.__proto__`, method-as-value), an `await` inside a `.map`
  callback fails closed, and no `ml` argument leaves `ml` out of scope entirely.
- **Pure computation works**: arrows, `.map/.filter/.reduce`, ternaries,
  optional chaining, template literals, object/array literals.

## Residual risks (honest)

- Denylist/allowlist **completeness** is the boundary's quality. The allowlist-
  for-calls is the strong line (no effectful method is listed); the read denylist
  is defense-in-depth. Audit both when extending. A missed *read* name is only
  dangerous if it yields something with an effectful method that's *also*
  allowlisted — which none are.
- Not a defense against a determined attacker crafting novel reflection (that's
  SES/realms territory, disproportionate here). It's a proportionate
  approval-fatigue reducer for an honest model, and it **fails closed**.
- On Trusted-Types pages the *fallback* eval is still dead (no worse than today);
  the win is that in-dialect surveys now run there at all.

## Red-team findings on the kind dispatch (2026-10-30)

The red team's `ml.embed` pass (#1336, `feat/readonly-ml-embed`) landed two test-only PRs, both verified at
their heads, each a `{ todo }` row asserting the defended outcome beside controls that pin what holds today:

- **A page picks its own kind.** `kindOf` in `src/readonly-exec/policy.ts` decides the `string` and `regexp`
  kinds by the `Object.prototype.toString` tag, which a page sets through `Symbol.toStringTag`, so a tagged
  page object chooses its member set and the dispatch then calls the object's OWN method: measured on main,
  `o.toUpperCase()` and `o.split("x")` run the page's functions and return its values, and a claimed `RegExp`
  gets its own `test`, `exec` and `source`. Any other tag is `NotInDialect`. The Date, Set and Map branches
  beside it already refuse the trick by a borrowed getter. Pinned by #1381 (base main,
  `redteam-brand-tag.test.mjs`, two todos, two controls). RULED: this is a defect of the dialect on main,
  not of `ml.embed`, since every member inherits the dispatch, so the fix lands on MAIN as its own PR (`@exec`
  `@security`, by #1336's builder, and #1336 rebases onto it; UPDATE the same day: that builder's session was gone, so Shane started the dialect lane, `[window-ml dialect] brand fix + ml.embed` on Sonnet, briefed by the coordinator with both fixes and #1336 itself from here), by the same
  borrowed-brand pattern the Date branch uses; it merges after #1381 and the janitor's comment, and the red
  team flips its todos after as a flip-only PR on main (rule 10). A fix on the embed branch alone would leave
  the hole on main until that branch merges and was refused for that reason.
- **The tag getter runs before the shape is refused.** `ml.embed`'s `textOf` (`policy.ts`) brand-checks with
  the same tag, so a page-installed `Symbol.toStringTag` getter runs, twice per call, before a String-shaped
  object is refused. Pinned by #1380 (base `feat/readonly-ml-embed`, `redteam-embed.test.mjs`, one todo,
  five rows holding: a String-shaped object refused with its `valueOf` never run; a Proxy bounded, its traps
  stated; an inherited index and a hole each a TypeError naming the index with no host call; `ml.embed` absent
  from a policy's predicate realm; no site-access e2e row since the member adds no message type and no
  privileged fetch). RULED: fixed on the embed branch by its builder before #1336 merges, the borrowed getter
  again; the red team flips its todo as its own commit on that branch, its own file only, before the merge
  (the 2026-10-28 amendment to rule 10).

Both PRs also claim three stray `redteam-*` files for the `redteam` genre in `scripts/test.mjs`, which
`--check-genres` was refusing every commit over; whichever merges first carries the claim.

LANDED 2026-10-30 (verified): the main fix is #1393 OPEN (head 93e5d62f, `@exec @security`, the dialect lane on Sonnet:
`policy.ts`, `evaluator.ts`, five adversarial rows in `tests/readonly-exec.test.mjs` failing on main, readonly-exec.md
updated); it merges after #1381 and the janitor's comment. #1381 MERGED 0b2b0932 on 2026-10-30 (verified): the two todos and two controls are on main. e3 flips the todos as a flip-only PR on main after #1393 merges, carrying the control-1 `ran` destructure fix in the same commit. UPDATE 2026-10-30 (verified): #1393 is at 8f281314 with the janitor's two findings answered (the cross-realm clause struck from readonly-exec.md, the janitor having measured that such an iterator still drains; the pattern row asserting per leg, with the `replaceAll` tag read pinned as a todo and named in the doc's open list beside join and the `String(obj).length` charge); re-reviewed clean (comment 6518194363), the lane re-arms its merge. The control fix is e3's own test-only PR #1399 (`redteam/brand-tag-control`, 7fb5eab1: the control asserted on a local `ran` for the `undefined` tag, so "Thing" and "Object" could never red it; it now keeps `pageObject`'s return and filters the getter's own tag read; the second janitor reviews, behind `--await-review`), so the flip-only PR after #1393 carries the two todo flips alone. #1399 MERGED 2026-11-07 at 10c9ecce (run 41024823336 green after an e2e rerun; verified). The re-read found three more tag-decided kinds in the
evaluator, fixed in the same PR by the same borrowed brand and measured on main first: a tagged page object as a search
pattern had its `source`/`flags` getters run; `expanded()` ran its `toString` through `String(x)`; one returned from a
host call had its own `Symbol.iterator` run. One consequence, not handled: an iterator from another realm is no longer
drained (a one-line reason in readonly-exec.md; a control row for the red team). The unchanged `redteam-brand-tag`
rows pass against the branch. RULED 2026-10-30 on two gaps the lane found, neither tag-dependent, each its own PR on
main after #1393 and #1336, behind the red team's rows (e3, after its #1358 (c) pin): `[o].join("")` and
`concat(o).join("")` run a page object's own `toString`, fixed by refusing any non-primitive element at `join`; a
genuine String object carrying an own `toString` has it run by native ToString(this) in `split`/`replace`, fixed by
dispatching string-kind methods on `String.prototype.valueOf.call(obj)` when the receiver is an object. MEASURED 2026-10-30 by the janitor on #1380's
head (comment 6517655342, verified): the embed todo row's `tag === 0` needs BOTH fixes, because the tag getter runs
from two sites in one `ml.embed` call, the `isRegExp` preflight in the evaluator (#1393's fix) and `textOf` in the
policy. RULED: #1393 merges first; the embed branch is rebased onto main with it; the `textOf` fix lands and is
measured on that head; the red team's flip is on that head and never on a `textOf`-only one. #1393 MERGED 471c2e9e on 2026-10-30 (verified): the brand decides String, RegExp and iterator kinds on main. Open now, in this order: the dialect lane rebases the embed branch onto main and lands the `textOf` fix there, measured on that head; e3 flips #1380's row on that head; e3's flip-only PR on main for #1381's two todos may open now (the two flips alone, per the ruling above); the join and String-receiver PRs follow behind e3's rows (e3's rows for them are #1425 OPEN 2026-11-07, head 83142e91, test-only, @exec @security, `redteam-coercion.test.mjs` under tests plus its genre line, verified: eleven todo rows for the coercion hole readonly-exec.md's Traps record as open, `String(o)`, a template, `o + ""`, `[o].join("")`, concat-then-join, `[o].toString()`, a genuine `new String` with its own `toString` inside `split` and `replace`, a pattern object coerced by the native `replace`, and `s + ""` when its own `valueOf` answers, each failing on main at its own assertion, three plain controls passing; the second janitor reviews after #1396 and the #1380 re-check; the dialect lane's fix follows it under rule 10, e3 flipping on the fix branch). e3's flip-only PR is #1407 OPEN 2026-10-30 (head 255cc9e5, `tests/redteam-brand-tag.test.mjs` alone, base main 471c2e9e, four pass and no todo there, verified), the second janitor reviewing; REVIEWED 2026-10-30 by the second janitor at 255cc9e5 (comment 6705720480): the flip holds, four pass and no todo on 54f7cf5d, and with policy.ts's two branches put back on the tag both flipped rows red at their own assertions while both controls stay green; one comment-only finding, routed to e3 the same hour: the file header's first paragraph still describes kindOf as reading `Object.prototype.toString.call(o)` with a tagged object's method running, the pre-#1393 shape (policy.ts now uses `isStringObject` and `isRegExpObject`), and the section marker at :41 still says "the hole"; e3 rewrites both to the defended shape and arms with no re-review, the comment-only exemption of #1386; #1407 MERGED de06516f on 2026-11-07 (head 64db3b33, the header rewrite in; verified): the brand-tag rows assert the defended side on main; the control's `ran` destructure repair is #1399's, not #1393's, so #1407 leaves the control alone and merges main in if #1399 lands first. The embed branch's rebase could not be pushed (a force push, refused by the lane's classifier, and #1380 is a PR into that branch, which a rewritten history would strand), so RULED: the lane merges main forward and cherry-picks the `textOf` repair on top, no force; e3 flips #1380's row on that pushed head. LANDED 2026-10-30: the flip is on #1380 at 924c8e21 (verified: contains 17419a43, base `feat/readonly-ml-embed`, two files, the red team's embed test and its genre line), not on the embed branch itself, because the red team's file exists only in #1380; the branch carried ten todos before it and nine after, 621 pass 0 fail on the redteam genre at 17419a43, and the route that turned the row is 17419a43's `isStringObject` brand check, noted in #1380's body. RULED: #1380 merges into `feat/readonly-ml-embed` first (the second janitor re-reviews 924c8e21 before e3 arms, a test-row change on a head its earlier comment did not cover), then #1336 to main, its head moved by that merge and reviewed by the first janitor on the moved head before the dialect lane arms; the lane merges main forward again only if CI needs it, saying so. RE-REVIEWED 2026-11-07 by the second janitor at 924c8e21 (comment 6705949306, CI green): the flip is sound, six of six and the row reds with `textOf` reverted; three findings, ROUTED to e3 the same hour: one gating, the flipped row still swallows the call's outcome (redteam-embed test :56-57), so a run that throws early is green, and the row must red on a throw; two body-only, the `--check-genres` justification is stale on this head (the genre entry removed, the check passes with 217 files across 21 genres) and the pre-flip figure mixes two trees (the base alone 625/616/9 todo, the head 631/622/9). The second janitor re-reviews the pushed head before e3 arms. ANSWERED 2026-11-07 at 41a1acea (verified): the row requires the exact refusal, a `TypeError` matching `ml.embed takes a string`, with the tag count 0 and no host call, so any other throw reds and the failing-first side is unchanged (the pre-fix code resolves, a missing rejection); the body's genre sentence says the line is what makes the redteam genre run the file, and the counts are split by tree (the head before the flip 631/620/10 todo, 41a1acea 631/621/9, the base alone 625/616/9 as the janitor measured). The second janitor re-reviews 41a1acea, then #1396 at 002c4a6b; e3 arms each after its comment. RE-REVIEWED 2026-11-07 at 41a1acea (comment 6706374307, CI green): the gating finding is fixed, six of six, a throw that is not the refusal reds; two non-gating items, applied by e3 before arming: the property assertion at :57 moves before the refusal check at :56 (on the tag-read mutant the row reported only the TypeError and hid the tag count), and the body's genre sentence names `node scripts/test.mjs redteam` with the measured 217; the reorder is a test-row change, so the second janitor re-checks that row at the new head. PUSHED as e2f59799 (file only, verified): with `textOf` reverted to a tag read the row now reds on the toStringTag getter having run, where before it reported only the TypeError; the body corrected. NEAR MISS, recorded: e3 armed a plain merge-when-green on that head before the re-check comment existed, caught the coordinator's message, stopped it unmerged and re-armed with `--await-review --read 6706374307`. CORRECTED 2026-11-07: `--await-review` cannot hold for a re-check on a PR that already carries a review post (the plan, the #1396 paragraph); e3 stopped the arm, #1380 stays OPEN and unarmed at e2f59799 until the second janitor posts its re-check of that head, then arms plain with `--read`. #1380 MERGED 2026-11-07 at 71dd11b8 into `feat/readonly-ml-embed` (run 42369161555 green, +23 test lines; the second janitor's re-check of e2f59799 is comment 6706642205, no findings, read before the arm, which also needed `--read` for the three older comments it counted unread; verified). #1336's head is therefore 71dd11b8 (verified: the embed branch's tip, mergeable against main), named to the first janitor as the last of its order after #1422 and #1423. MOVED the same hour to 15666066 (verified: a fast-forward merge of main into `feat/readonly-ml-embed` over 71dd11b8, no force; the one conflict was the redteam genre list in `scripts/test.mjs`, taken as the union, `--check-genres` clean; full suite on it 8279 pass, 0 fail, 16 todo, the lane's measurement): #1380 had left the PR conflicting with main. The lane named 15666066 to the first janitor itself; #1336 stays a draft until that review comment is posted, then is marked ready and armed plain with `--read`. Two notes on the tool from that: `--await-review` is satisfied by a post from anyone but the arming session, so a bot or a stale thread can satisfy it, and the arming lane reads the surfaced comment before calling the merge reviewed; and a lane arming after a test-row change uses `--await-review` always, never plain. #1410 refreshed onto main at 9c17d9ed after two "Base branch was modified" arms, its clean review standing (merge-forward only). #1410 MERGED 2026-11-07 at 86fba14d (verified). CORRECTED 2026-11-07: the "`--await-review` always, never plain" rule two sentences back is withdrawn; the flag is met by any prior other-session post, so after a post-review commit a lane does not arm until the re-check naming the new head is posted, then arms plain with `--read` (the plan, the #1396 paragraph). #1425 REVIEWED 2026-11-07 at 83142e91 by the second janitor (comment 6706686580, verified): the eleven rows and the control check out, untagged and each failing on its own assertion; but the PR conflicted with main at `scripts/test.mjs:120` (a genre-line collision), so it had no checks and could not be armed, and its body named `npm run test:redteam`, which is not a script. e3 rebased onto main keeping the act-consumer, person-word and coercion genre lines, head 6e54dfc9 (verified mergeable; the file runs 1 pass / 11 todo there; genre tests 648, pass 630, fail 0, todo 18; body command and counts fixed). The rebase moved the head, so the second janitor's re-check of 6e54dfc9, asked, comes before any arm. RE-CHECKED 2026-11-07 at 6e54dfc9 (comment 6707116835, every check green, mergeable, no findings; the rebase changed nothing measured: the same blob for the test file, the intended genre resolution; verified). #1425 MERGED 2026-11-07 at 7e937260 (run 42370823659 green, +12 test lines; the arm named all three comments; verified): the eleven coercion todo rows are on main, and the join and String-receiver PRs follow behind them as ruled. JOIN PR OPEN 2026-11-07 (the dialect lane): #1454, branch `fix/join-coercion`, head a90dd6df on main, @exec @security, verified (three files: the evaluator, its test file, readonly-exec.md); e3's `[o].join("")`, concat-then-join and `[o].toString()` rows pass on it, the lane's two refusal rows red on main, 8,275 pass. The gate also covers `+` and a template over an array, which are `join` underneath. Behaviour change, in the body in these words: `[obj].join()` over a script-built object or a Date is now refused. RULED the same hour: `sort()` with no comparator, which coerces its elements the same way, goes INTO #1454 (same hazard, same predicate, one more call site, review not started), with a `sort` row of e3's beside it; e3's three flips and the sort row are e3's own commit onto the branch, own files only, before the merge, after the lane pushes the sort gate and names the head; janitor-2's comment names the final head before any arm. The four rows in neither ruling (`String(o)`, a template of a plain object, `o + ""` on a page object, `s + ""` when a real String's own `valueOf` answers) are RULED for a THIRD dialect PR after the String-receiver PR: refuse a non-primitive operand that is not a script-owned data value in `coerces` and the `String` call, as `joinsData` does, and unwrap a String-object operand with the borrowed `valueOf`; the native pattern-object `replace` row goes with the String-receiver PR. No row stays open. e3 MEASURED 2026-11-07 on a90dd6df: the three rows flip green, control green; the ruled-in sort row is red as expected, `[o, 2].sort()` running the page's `toString` (measured `ran: ["toString"]`; a one-element array does not coerce, so `[o].sort()` would be vacuous, hence two elements). e3's commit 37c8a1ce (the three flips, the sort row, a plain-sort control line) is HELD unpushed so no head is red, until the dialect lane names the head carrying the sort gate; then rebase, re-measure (5 pass expected, the 8 ruled-later rows still todo), push, and the lane and janitor-2 get the head. SORT GATE IN 2026-11-07: #1454 at 65dc212c (verified, same three files): a comparator-less `sort()` goes through the same `joinsData` as `join`, a sort with a comparator unchanged, with controls that a default sort of data and a comparator sort of objects still work; the body names both behaviour changes in the ruled words; 8,275 pass, 27 todo. e3 rebases its held commit onto 65dc212c and pushes; the lane names the final head to janitor-2 and pushes nothing further itself. e3 PUSHED 2026-11-07: #1454 at d260cbb2 (verified, e3's commit the head: the three flips and the sort row); janitor-2 reviewing, its e2e and unit checks pending at the time. REVIEWED 2026-11-07 by janitor-2 at d260cbb2 (comment 6708139132, verified), four findings merged locally and measured: (1) `[1,2].join(o)` with a PAGE OBJECT as the separator returns "1P2" and runs the page's `toString` twice, the guard walking elements and never the separator while the doc bullet claims otherwise; (2) `sort(undefined)` guarded but unpinned, one token from reopening; (3) four guard branches no test reds (the `expands` call in `coerces`, `joinsData`'s `MAX_EXPANDED` cap, its tick, its length check); (4) the sort refusal prints join's message. janitor-2 called none gating; RULED the same hour that (1) IS gating, the same hazard one argument over: fixed in #1454 before the merge, the separator through the same predicate as the elements and the bullet made true, (2) to (4) in the same commit; then e3's separator row and `sort(undefined)` row as its own commit, janitor-2 re-reading and naming the final head before any arm. e3 MEASURED the same hour on d260cbb2, commit 394bca2f HELD unpushed until the lane names the gated head: `[1, 2].join(o)` with a page object as the separator answers "1PAGE2" and the page's `toString` runs TWICE, once in the preflight's own `String(args[0] ?? ",")` and once inside `join`, so the fix must judge the separator before anything stringifies it (routed to the lane; the row asserts the page's `toString` never runs and the answer is never the page's text); `[o, 2].sort(undefined)` is ALREADY refused on d260cbb2 (`args[0] === undefined` covers an explicit undefined), so that row is green and pins the clause, the `args.length === 0` mutant reding it; the string-separator control (`o.join("-")` on the page's own strings) already sits in the control row. File state with the held commit: 5 pass, 9 todo; 6 pass, 8 todo expected after the flip on the gated head. GATED 2026-11-07: #1454 at 5d8d5098 (verified, a fast-forward over e3's d260cbb2), all four findings in one push: the separator judged by `typeof` before anything stringifies it, so the page's `toString` never runs, and the doc bullet true; `sort(undefined)` pinned in the lane's rows; each guard branch reds a test when removed (each mutated), the `tick` in `joinsData` removed since `expands` already charges the walk; the refusal names the method that reached the guard; 8,282 pass. e3 rebases 394bca2f on top, flips the separator row and names the final head; janitor-2's comment names it before any arm. e3 PUSHED: #1454 at da2fc75e (verified, e3's commit the head); janitor-2 holds its review until the head is green, two e2e rows off the diff's path having failed (`review-look.spec.mjs:705`, `site-access.spec.mjs:564`; run 42382595453 rerun in progress, nine other checks green); janitor-2 reports the four findings closed and each of the seven branch mutants reding a test; the lane pushes nothing and arms only on the comment naming da2fc75e. DEFECT ON MAIN 2026-11-07 (janitor-2, measured at da2fc75e; not #1454's): a PAGE FUNCTION handed to a host callback method runs page code during a survey, `[1,2].sort(o)` and `[1,2].map(o)` with `o` from `ml.models()` running the page's function once and twice; the join guard checks element and separator coercion, and a callback is a call the host makes. RULED the same hour: it jumps the queue, being more direct than coercion (the survey running the page's own function unprompted). Rule 10: e3 writes the rows first as a test-only PR on main, ENUMERATING every whitelisted host method that takes a callback (sort, map, filter, find, findIndex, some, every, reduce, forEach, flatMap, replace with a function, and any other the whitelist admits), each asserting the page function never runs and the survey is refused naming the method, with a control that a script-defined function in the same position works; then the dialect lane's NEXT PR after #1454, ahead of the String-receiver PR: refuse any function argument to a host method that is not one of the script's own functions (`ourFns`), one predicate at the call site and not a list, the refusal naming the method, the doc's Open list and the extending-the-dialect checklist updated in that PR (not on #1454, which would move the head under review); e3's flips as its commit on the branch; janitor-2 reviews. e3's PASS UP 2026-11-07: test-only PR #1470, `redteam/host-callbacks` at b5e50ff0 on main, @exec @security, verified: 16 todo rows enumerated off the whitelist in `policy.ts` (map, filter, forEach, reduce, reduceRight, find, findIndex, findLast, findLastIndex, some, every, flatMap, sort, `Array.from`'s mapFn, `Set.prototype.forEach`, `JSON.stringify`'s replacer; toSorted/toReversed/with not admitted), each asserting the page function never ran, the survey refused, and the refusal NAMES the method; three plain rows for shapes already defended (replace, replaceAll, then); one CONTROL exercising all 16 positions with script-written arrows so a fix refusing every callback reds it; 4 pass, 16 todo on main, each position measured running the page function (counts in the PR). The last three positions are not array methods, the argument for one predicate at the host-call site. janitor-2 reviews after #1462; the dialect lane starts its fix branch once #1454 is armed, names it to e3 for the flips. EMBED FILTER 2026-11-07: janitor-2's #1336 facts (the plan has the decision) are e3's test-only PR #1462, `redteam/embed-filter` at 14fcbbaf on main, @security @api, two `todo` rows red on main at the assertions they carry plus three controls (allowing filter, no filter, the request's own model and inputs), verified. Measured: with `modelFilter: "^qwen"` and `embeddingModel: embeddinggemma:300m`, one line of PAGE script, `ml.embed(["…"])` with no model, sent one request to the server carrying `"model":"embeddinggemma:300m","keep_alive":-1,"options":{"num_gpu":0}`; both facts came off that one request. e3's correction of the framing, accepted as the record: `ml.embed` is a PAGE member (#1336's `hostEmbed` is gated on `!worker` and the worker's facade omits it), so a worker survey defers to the page's interpreter and the call is the page's own `ml.embed`; the finding is therefore ANY approved page, not a survey, and no survey-shaped row is needed (ruled). The fix site follows: where the embed request is BUILT in the background's handler, one site for page and survey alike, `modelFilterAllows` on the resolved embedding model failing closed with an error naming the filter (no host or key in it) and `keep_alive` not -1 while the request still goes out and answers vectors; the dialect lane's PR after #1336 merges, #1462 merging first under janitor-2's review, e3's flips as its commit on the fix branch. #1462 REVIEWED 2026-11-07 by janitor-2 at 14fcbbaf (comment 6708334568, verified), two findings, RULED the same hour as janitor-2 argued: (1) the `keep_alive: -1` pin is NOT a defect, it is `embeddingKeepAlive`, a documented Setting on by default (contract-config.ts line 298) for a model placed on the CPU that uses no VRAM, and a page's `ml.chat` keeps the chat model resident with no rule against it; the pin row is withdrawn as a finding, kept only if rewritten as a CONTROL that the setting is honoured both ways; (2) the filter row sent only from a page sender, so a fix gating on `sender.tab` would pass while a worker-built run's unasked embed still reached an excluded model; the row gains the same refusal assertion with NO sender, so only the resolved-model fix passes. The fix is therefore the FILTER ONLY: `modelFilterAllows` on the resolved embedding model where the request is built (the gap is `background.ts` line 1148, `if (asked && …)`, so the resolved `cfg.embeddingModel` never meets the filter), failing closed naming the filter, `keep_alive` unchanged. e3 answers in the file and asks janitor-2 to re-check before arming. DEFECT ON MAIN 2026-11-07 (found by the async lane's real-host e2e; `ASYNC_CALLS.md` has the full record): under `autoApproveReadonly` the survey's PAGE LEG runs for a script the routing forces isolated (`ml.sh`, and so a pointer or `ml.current` too), because `pageLegOk` in `tryReadonly` excludes only the isolated default world; the page realm evaluates the script and answers a TypeError, and every `ml.sh` call from exec fails in the default config. The fix (the async lane, own PR, `@exec @security`) gives no page leg to any forced-isolated reason, enumerated; e3's row beside it. Refined: decided on the script alone, a page leg only for the `plain` reason; the page-derived `unapproved-page` keeps its survey, as the invariant allows a user-started run there.
