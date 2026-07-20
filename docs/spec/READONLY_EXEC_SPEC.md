# Spec: auto-approve read-only `exec` via a mediated mini-interpreter

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
mediated closure as an arrow).

**Explicitly NOT in dialect** (→ fall back to approval): assignment of any kind
(`=` outside a declaration, `+=`, `++`), `new`, `delete`, `for`/`while`/`if`,
`try`, rest/destructuring, regex literals, `await`, labeled/`this`. Add cases as
they come up — each addition is opt-in and only *grows* the auto-approve surface.

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

## Integration (fail-closed, side-effect-free)

Because the interpreter can't cause side effects, wiring is trivial and safe:

In the agent loop's `requiresApproval` branch, for `tool === "exec"` when the
config flag is on:

```
try {
  const { value, logs } = evalReadonly(args.js, roots);   // throws if outside dialect / denied
  result = formatExecResult(value, logs);                 // reuse exec's own formatting
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
`injected.js` and also built standalone for unit tests. It takes the root scope
as a parameter (real globals in the page; jsdom's in tests).

## Config + UI

- New non-secret config `autoApproveReadonly: boolean` (default `false`).
  - `DEFAULT_CONFIG` in `background.ts` **and** `popup.ts` (kept in sync).
  - Returned by `GET_CONFIG` so the page/agent can read it via `ml.config()`.
- Sidebar Settings checkbox: **"Experimental: auto-approve read-only exec
  calls"** (under a suitable group), wired like `autoTitles`.

## Testing (`tests/readonly-exec.test.js`)

- **Runs the two canonical surveys** end-to-end against a jsdom DOM, asserting
  the returned summary objects.
- **Escape attempts all throw** (→ fall back): `(()=>document.querySelector('x')
  .ownerDocument.defaultView.fetch('/x'))()`, `({}).constructor.constructor('…')`,
  `el['owner'+'Document']`, bare `fetch(…)`, `window.location`, `.setAttribute`,
  `x = 1`, `document.body.innerHTML = 'x'`.
- **Out-of-dialect falls back** (throws `NotInDialect`, not a crash): `for`
  loops, `function(){}`, assignment, `new`.
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
