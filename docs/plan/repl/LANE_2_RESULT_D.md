# Lane 2, root D: the effect algebra (result)

Work slug `repl-lane2`, session `620310d6-e68e-4309-95a9-60fb03bcc73b`, model `claude-opus-5-5`, 2026-10-15.

## What landed

- **PR #672** (merged, `68872a17`): `src/effects.ts`, the algebra of `docs/spec/EFFECTS.md` as one pure module, and
  `tests/effects.test.mjs`.
- Lane 4 was told the exported shape before the merge and pinged on it. Its program manifests use `ProgramEffect`
  terms as they are and `union()` the projections.

## What the acceptance test showed

- One test per row of the projection table (library, program, `ml.fetch`, package install) and one per row of the
  placement table. All pass.
- The free tier is enumerated over every operation, every resource class and every placement: 5 operations × 14 resource
  classes × 6 placements, against a table written by hand. All pass.
- `unknown` is inside no bound, the empty bound included. The empty set is inside every bound.
- The plain-host default, written as a universal over `effectSet`, agrees with `free` on every single pair.

## Ruled by `repl-specs` during the work (the specs are amended to match)

1. **`free` is a universal over the set, never an exclusion list.** Every pair must be covered by the placement's
   bound, or be a read of a path the host resolved inside the roots and did not flag secret. `POLICIES.md`'s
   plain-host example listed excluded operations (`!has("write") && !has("exec") && …`) and so let `use(secret)` and
   `alloc` run free. The example is to be derived from `free` instead.
2. **A secret-flagged path is inside NO bound**, sandbox and container included, not only outside `ReadsInRoots`. The
   harm of reading it is disclosure to the model, the run log and the export, which no enforcer bounds.
3. **`PROGRAM_MANIFEST.md`'s bare `net(host)`** projects to `read(net(host))` and/or `write(net(host))`. A manifest
   states the direction per subcommand or flag; when it states none, the call is both, since any outbound request can
   carry data out (agreed with lane 4).

## Assumptions where the spec was silent

- A path whose `inRoot` the host did not resolve, and an unresolved `heap(arg i)`, are covered by nothing.
- `net(*)` is covered only by a `*` bound. Hosts compare case-insensitively.
- `ml.fetch` with a method other than GET/HEAD is `read` + `write` on the host. The spec listed only GET.
- Package install's `alloc` is `alloc(fs(site-packages))`. The spec wrote a bare `alloc`.

## Changed afterwards, in root E's PR (found by its red-team pass)

- The policy view of an undescribed call (`effectSet("unknown")`) had `pairs: []`, so `pairs.every(…)` and
  `pairs.length === 0` would grant. `pairs` now holds every operation over the `unknown` resource.
- `has(op, kind)` answered a misspelt operation or kind with a quiet `false`, so a `deny` on it never fired. It now
  throws, which the policy realm reports as a broken policy.
- Every resource in the view carries every field any resource kind has (`RESOURCE_FIELDS`, the absent ones
  `undefined`), so a policy over mixed reads is `false` rather than broken, while a typo'd field is still refused.

## Found on the way, not in D

The red-team pass on root E found that an auto-approved SURVEY could write through `Object.assign` into the page
(`document.body.innerHTML`) and into the host's own `Math`, `JSON` and `Array`. In the worker realm those are the
service worker's. The bug had been live on main since `Object.assign` joined the dialect. It is fixed in **PR #675**:
`ARG_WRITERS` in `src/readonly-exec/policy.ts` lists each argument an allowed method writes, the evaluator holds every
listed argument to the `o[k] = v` rule, and a test enumerates the table.

## What did not work, or was left out

Nothing in D's scope. The open questions of `EFFECTS.md` stay open: `net(host)` granularity, `alloc` as an effect
or only a cost, and how effects compose across a pipe. D took the simplest reading of each and records it above.
