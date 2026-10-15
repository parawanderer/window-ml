# Lane 2, root E: the policy realm of the read-only dialect (result)

Work slug `repl-lane2`, session `620310d6-e68e-4309-95a9-60fb03bcc73b`, model `claude-opus-5-5`, 2026-10-15.

## What landed

- **PR #686** (merged, `d56fb860`): `evalPolicy` in `src/readonly-exec/policy-realm.ts`, the `"policy"` realm of the
  mediated evaluator, and `tests/readonly-policy.test.mjs`. How it works: `docs/dev/readonly-exec.md`, "The policy
  realm".
- **PR #675** (merged, `3dbdbd90`): a security fix the red-team pass on E found (below).
- **PR #709** (merged, `4b5b70e3`): the policy realm's cases as lane 3's shared dialect vectors (env `"policy"`: 51
  abuse cases, 118 halting cases), approved by lane 3.

## The contract

A policy is a dialect script whose value is a function `(c) => boolean`. `evalPolicy(source, facts, effect)` answers
`{ decision }` when the function returns a boolean, and `{ broken }` (no opinion) on anything else: a parse or dialect
refusal, a throw, the step budget (`POLICY_STEPS`, 50 000) or call depth spent, a result that is not a boolean.
Every failure fails closed: a broken `allow` allows nothing and a broken `deny` refuses nothing, and the call asks.

- `c` is a frozen, strict facade over a copy of the facts. Reading a field it does not have is refused through every
  binding form (member access, destructuring, spread), so a typo is a broken policy, never `undefined`.
- Refused in the realm: `==` and `!=` (at parse time, so an unreached branch is caught too, and in the evaluator),
  ordering between values of different types, reading a property of `null`/`undefined`, `Date`, `ml`, the DOM.
- The effects view: `c.effects.has(op, kind)` and `c.effects.uses(kind)` throw on a name outside the algebra;
  `c.effects.pairs` on an undescribed call holds every operation over the `unknown` resource.
- Parses are cached (an LRU of 256): a policy is judged on every call it could match.

## What the acceptance tests showed

Every case in `tests/readonly-policy.test.mjs` passes: the realm's answers on well-formed policies, each refusal above,
halting under the budget in a worker with a timeout, and nothing a policy does reaching its facts.

## Found by the red-team pass

1. **`Object.assign` wrote into the page and into host intrinsics from any auto-approved survey**, live on main since
   `Object.assign` joined the dialect: `Object.assign(document.body, { innerHTML: … })`, and into `Math`, `JSON`,
   `Array`, which in the worker realm are the service worker's. Fixed in #675: `ARG_WRITERS` in
   `src/readonly-exec/policy.ts` lists each argument an allowed method writes, the evaluator holds each to the
   `o[k] = v` rule, and a test enumerates the table in both directions.
2. In the effect algebra (D, changed in #686): `pairs` was empty on an undescribed call, so `pairs.every(…)` granted;
   `has("wirte")` answered `false`, so a `deny` on a typo never fired.
3. In the realm itself, before merge: a string typo compared with `===` and an ordering between mixed types both
   answered `false` quietly. Both are refused now.

## What did not work, or was left out

- A typed-node policy tree, and the DERIVED breadth it allows, are not built; policies are code (`POLICIES.md`, "Code
  first, a tree later").
- Timing tests across the dialect (`ADVERSARIAL (cost)… REAL budget`, the pipe budget, `HALTING` on a long string) time
  out under machine load when several lanes run the full suite at once, and pass alone.
- CI flake: e2e `site-access.spec.mjs` 16a failed once on #675, passed 3/3 locally, and the rerun was green.
