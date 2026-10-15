# Lane 2: the effect algebra, the policy realm, the policy store with its first consumer

Read `README.md` in this folder first. Work slug `repl-lane2`; clone `~/git/window-ml-repl-lane2`. Labels
`@exec,@security,@ui`. You own `src/readonly-exec/`, `src/sw/sw-consent.ts`, `src/sw/grant-extract.ts`, the settings
panel and a new `effects.ts` at the top of `src/` this round.

## Read before coding

- `docs/spec/EFFECTS.md` (all), `docs/spec/POLICIES.md` (all; "The policy realm", "Built-in defaults are policies too",
  "Showing what was approved"), `docs/spec/SECRET_HANDLES.md` ("How it meets the other specs", for the shape of a scope
  you are NOT building yet).
- `docs/dev/readonly-exec.md` (the whole thing, and "The rule for extending the dialect" twice), `docs/dev/state.md`
  (the grant stores as they are today, and the registry), `docs/dev/sidebar.md` (the Settings panel, `cursorTipOn`,
  the gallery), `docs/dev/run-log.md` (where "which policy allowed it" is written).
- The code: `src/readonly-exec/policy.ts` (`ReadonlyRealm`, `mlFacade`, `BY_KIND`, `DENIED_PROPS`), `evaluator.ts`,
  `limits.ts` (`NotInDialect`, `STEP_BUDGET`), `src/readonly-exec.ts` (the entry), `src/sw/sw-consent.ts`
  (`grants.fetch`, `grants.call`), `src/sw/grant-extract.ts`, `src/contract/contract-config.ts`
  (`pageApprovalDomains`), `src/sidebar/settings/settings.tsx`.

## Root D: the effect algebra as code (first PR, small)

- `effects.ts` at the top of `src/` (a pure rule, so it sits beside `site-access` and `page-relay`): the operation and resource types, an effect SET with
  the helpers the spec names (`has`, `reads`, `writes`, `uses`), the projections (`fromLibraryEffect`,
  `fromProgramEffect`, `fromFetch`, `fromInstall`), `unknown` as top, and `free(effects, bound)` as the subset test with
  `ReadsInRoots` excluding `secret`.
- **Enumerate, do not sample** (AGENTS.md): a test per row of the two tables in `EFFECTS.md`, and a test that
  `unknown` is inside no bound, including the empty one.
- Header comment and a docstring first sentence on every export (the `--new` ratchet of the code index).

## Root E: the policy realm (second PR)

- `ReadonlyRealm` gains `"policy"`. In it: no `ml`, no `document`, no `getComputedStyle`; the only root is `c`.
- **`c` is a facade that refuses an absent field.** Build it the way the worker's `ml` is built (an allow list of what
  exists, reaching anything else raises), not with a `Proxy`: the dialect's own member-read path decides, so an alias
  (`const x = c; x.argv0`) cannot get past it. Nested objects (`c.paths[i]`, `c.effects`) are facades too.
- **`==` and `!=` are `NotInDialect` in this realm**, accepted as before in the others. One place in the evaluator,
  keyed on the realm.
- An entry point `evalPolicy(source, facts) → "allow" | "deny" | undefined`, where ANY throw, budget exhaustion or
  refusal is `undefined` plus a `broken: reason` the caller stores against the policy. A policy is parsed once and
  evaluated many times; keep the parse cached by source.
- **Adversarial tests, without being asked** (the dialect rule), in a new `readonly-policy.test.mjs` under `tests/`, under
  sections: reach `ml`, `document`, `window`, `constructor`, `__proto__`, a realm through a callback; a policy with a
  loop over `c.argv` (allowed, bounded) and one that recurses past the depth (refused); a throwing policy fails CLOSED;
  a typo'd field is `broken`, never `undefined`-and-silent; `==` refused; a regex policy with a backtracking pattern is
  refused by `riskyRegex` as in a survey. HALTING tests in a worker with a timeout. FAILURE tests: a refused policy
  leaves `facts` untouched (they are frozen; assert it).
- `docs/dev/readonly-exec.md` gets a "The policy realm" section, and its realm table a third column.

## Then: the store, the page, the first consumer (third PR, may split in two)

- A new `sw-policies.ts` under `src/sw/`: policies by scope (global in `chrome.storage.sync` or `local`, decide and say why;
  workspace later; run in the session store so it SURVIVES RESUME and a fork inherits it, per the spec). **Declared in
  the state registry** with scope, realm `worker`, audience `human`, what loses it.
- Evaluation order: `deny` wins across scopes; nothing means the tiers above decide; the built-in default policy is the
  subset rule from `EFFECTS.md` and lives beside the person's as code, visible on the page.
- **First consumer: the approved-URL grants from an `exec` card** ("Approve + remember these URLs",
  `grant-extract.ts`, `grants.fetch`). Each remembered URL becomes a run-scoped policy
  `(c) => c.kind === "fetch" && c.url === "<literal>"`, and the old store is read through the new one. **Test the
  upgrade** with a fixture of what the old code wrote. The run log records which policy allowed each fetch.
- **One page lists every policy**: a row per policy in DevTools Settings (the superset rule), editable and deletable,
  the broken ones marked with their reason; the gallery gets the row component with an `@gallery` example. A change
  takes effect on the next call and re-judges a card already showing (the spec's "A change takes effect at once"); the
  re-judging may be a follow-up if the card plumbing resists, say so.
- The model may PROPOSE a run policy only as an approval card; no API that adds one without a person. Breadth on a
  proposal: measured over this run's log (the cheap half); the derived breadth for the decidable fragment is later.

## Questions already answered

Code first, a typed-node tree later as an option. `ml.sh` is not the first consumer. The default policy is one rule
over the algebra, not a per-mode table. A policy never changes what is enforced.

## Report back

`LANE_2_RESULT_<root>.md` in this folder, per root. Lane 4 waits on D: mail `repl-lane4` when it merges.
