# Policies

A policy is a short script in the read-only dialect's policy realm that looks at one gated call's resolved facts and
answers allow, deny, or nothing. The store (`sw-policies.ts`) keeps them by scope and judges a call against them; a
consumer asks it before it asks the person. This file is how that is built and where it can go wrong. What a policy
is FOR, and the design around it: [`../spec/POLICIES.md`](../spec/POLICIES.md). The effect algebra behind the built-in
default: [`../spec/EFFECTS.md`](../spec/EFFECTS.md). The language a policy is written in, and why it cannot do harm:
[the policy realm](readonly-exec.md#the-policy-realm).

## Where things live

| What | Where |
| --- | --- |
| The store, `judgeCall`, `rememberFetchUrls`, `withPolicies`, `forgetRunPolicies` | `src/sw/sw-policies.ts` |
| The evaluator (`evalPolicy`) | `src/readonly-exec/`, exported through `src/readonly-exec.ts` |
| The built-in default (`free`, `boundFor`, `fromFetch`) | `src/effects.ts` |
| The first consumer's gate: policy consulted first, `reused` on the call's row | `autoApprove` in `src/agent/agent-host.ts` |
| That gate's inputs (`fetchPolicy`), the run log records, "Approve + remember" | `src/sw/sw-run-host.ts` |
| The fetch's own choke point, which judges again | `consented` in `runMl`, `src/sw/worker-tools.ts` |
| A call a policy refused (`refused` on the `autoApprove` result) | `src/agent/agent-loop.ts` |
| Deleting a session removes its policies | `forgetRun` in `src/background.ts`; `onEvicted` in `src/sw/sw-sessions.ts` |
| `kept` on the resume note | `runPolicyLabels` in `src/sw/sw-sessions.ts`, `src/session/session-commands.ts` |
| What the model reads | `policies` on `CurrentSnapshot` (`src/agent/current-context.ts`) |

State is declared in the registry as `policies.global` and `policies.run` (audience `model`, exposed as
`ml.current.policies`). Both keep a policy as `StoredPolicy`: `id`, `scope`, `consumer` (`"fetch"`, and `"sh"` for `ml.sh`, whose facts its own consumer builds),
`effect`, `source`, `label`, `origin` (`person` or `card`) and `created`.

## Scopes and lifetime

| Scope | Whose | Stored in |
| --- | --- | --- |
| `global` | the person, for every run | `chrome.storage.local`, key `ml_policies_global` |
| `run` | one session, by its hash | `chrome.storage.local`, key `ml_policies_run` (an object keyed by hash) |

Both are `local`, never `sync`. A policy about this browser's backend and the sites it reaches has no business following
the person to another machine, and a `sync` quota (8 KB per item) would cap the list the first time a run remembers a few
dozen URLs.

A run policy is keyed by the session hash, so it survives a resume: the resumed session has the same hash. The resume
note (`session-resumed`) lists the labels in `kept`, for the person reading the divider and the exports. The note is
not shown to the model; the model reads the policies themselves in `ml.current.policies`.

A run's policies go when its session does, deleted or archived (the scope table in
[`POLICIES.md`](../spec/POLICIES.md), "Scopes"): `forgetStored` calls `forgetRun`, which calls `forgetRunPolicies`, and
`onEvicted` does the same for an eviction whose outcome is `"deleted"` or `"archived"`. An archived session that comes
back starts with none; an eviction whose move to the archive failed (`"kept"`) keeps them.

A fork the WORKER builds inherits a run's policies and a fork a PAGE builds inherits nothing (`POLICIES.md`, "Scopes"):
today's fork is page-side and reaches the worker as a plain start it cannot tell from a new run, and a page naming a
parent hash to inherit its grants would be an escalation route. No worker-built fork exists yet, so nothing inherits.

The run scope is capped at 500 sessions (`RUN_POLICY_SESSIONS_MAX`). Past it, `saveRuns` drops the session whose
policies were written longest ago; `addRunPolicy` re-inserts the session last, so the one being written is never the one
dropped.

## How a call is judged

`judgeCall(runId, consumer, facts, placement)`:

1. Before the saved policies are read after a worker wake, return `"ask"` and do nothing else (see Traps).
   Otherwise collect the global policies and the run's, and keep those of the call's `consumer`.
2. Evaluate each with `evalPolicy(source, facts, effect)`. A policy that breaks (does not parse, falls out of the
   dialect, throws, returns something that is not a boolean) is NO OPINION. It is recorded: `brokenReason(id)` for the
   policy page, and the caller writes a `policy`/`broken` run log record with the policy id.
3. A `deny` from any policy, in either scope, returns at once. Deny wins across scopes.
4. Otherwise the first `allow` returns, with the policy that gave it in `by`.
5. With no answer from the person, the built-in default applies: `free(facts.effects, boundFor(placement))` from
   `src/effects.ts` allows the call when its effects are inside what the placement bounds, and `by` is `"builtin"`.
   That never allows a network fetch, so for `fetch_url` the default is always "nothing".
6. Otherwise `decision` is `undefined` and the tiers above the store (the free tiers, then a card) decide.

A caller that wants only the PERSON's answer ignores `by === "builtin"`; both callers of the fetch consumer do.

`fetchFacts(url, { credentials, rendered })` builds the facts a `fetch` policy sees: `kind: "fetch"`, `url`, `host`
(lowercased hostname), `method: "GET"`, `credentials`, `rendered`, and `effects`. Add a consumer by widening
`PolicyConsumer` and `validList`, and give it a facts builder.

## The first consumer: remembered URLs

`fetch_url` is the consumer. In `autoApprove` (`agent-host.ts`) the policy is consulted FIRST, through `deps.fetchPolicy`,
which `sw-run-host.ts` builds over `judgeCall`:

- A `deny` refuses the call without a card: the loop sets approval `"denied"` and the model's result names the policy
  and says not to retry. It wins over the free tiers below it (same origin as the run, the current page, self-source).
- An `allow` covers an UNCREDENTIALED fetch only (the credentialed branch always asks), and only for a run whose
  `fetch_url` the worker itself runs (`byWorker() && runsInWorker(p, "fetch_url")`). The call then goes through as
  `consented`, with `reused: [{ kind: "policy", detail: label }]` on its row.
- Every answer that is not the built-in default is written to the run log: subsystem `policy`, kind `allow` or `deny`,
  reason the policy's label, detail the policy id, scope, tool and URL.

Why an `allow` is limited to worker-run fetches. The worker's fetch has its own choke point (`consented` in
`worker-tools.ts`), which calls `judgeCall` again over the same policies instead of trusting the gate's earlier answer.
A page-built run's `fetch_url` runs in the page, under the TAB's grants, and the only way to let a run policy skip its
card would be to lend it to the tab. The tab's grants are what the page's own `FETCH_URL` message reads, so that would
let any script on the page fetch what the person remembered for one run. That hole is closed, not narrowed: see below.

"Approve + remember" on an `exec` card calls `rememberFetchUrls(runId, urls)`. The URLs are the static `ml.fetch`
literals the card showed (`extractGrants`), not anything the page sent. Each becomes one run policy with `origin: "card"`,
label `fetch <url>` and source `(c) => c.kind === "fetch" && c.url === <literal>`, the literal built with
`JSON.stringify` so a URL cannot close the string. `addRunPolicy` does not add a second policy with the same consumer,
effect and source.

It used to write the TAB's consent ledger (`fetchConsent`, through `persistGrants`, now removed). A hostile page on that
tab could then fetch a URL the person had remembered for a run. A second bug sat beside it: `runFetchConsented` returns
`false` for a run it knows, never `undefined`, so `runFetchConsented(...) ?? fetchConsent.get(tabId)?.has(url)` never
reached the tab's ledger for a worker-hosted run. The remember button never helped a worker run before this.

## What the model and the person see

- The model: `ml.current.policies`, added to the snapshot by `withPolicies` for the global policies and the run's. Each
  entry is `{ scope, effect, label, source }`; the key is absent when there are none. It is added on a copy, in the two
  places the worker builds a snapshot for an `exec` (`sw-run-host.ts`). A refused call's result names the policy.
- A call a policy allowed: its row carries `reused: [{ kind: "policy", detail: <label> }]`.
- The person: the run log records above, and the resume note's `kept`.

## Traps

- A page-built run's "remember" does not skip its later cards. Its fetch runs in the page, and skipping the card would
  mean lending a run policy to the tab. It is still stored; a `deny` still applies to it.
- Never lend a run policy to the tab (`consentFetch`, `fetchConsent`, `credFetchGrants`). The tab's grants belong to
  whatever script runs on that page.
- Consult `deny` BEFORE the free tiers. Putting the policy after the same-origin and current-page checks makes a deny a
  rule that applies only to cross-origin fetches.
- A broken policy fails closed in both directions: a broken `allow` does not allow, a broken `deny` does not deny, and
  the call asks. Nothing breaks silently, but nothing breaks loudly either: look for `policy`/`broken` in the run log.
- Storage is read asynchronously when the worker starts (`policiesReady`). Until it resolves, `judgeCall` returns
  `"ask"` (`POLICIES.md`, "A store not yet loaded means ASK, free tiers included"), and the consumer must ask WITHOUT
  letting its own free tiers answer: `fetchPolicy` maps it to `"unknown"`, on which `autoApprove` returns before the
  same-origin and current-page checks. Otherwise a `deny` saved before an eviction would go unenforced for the first
  calls after the worker woke. The rule is in `judgeCall` so a new consumer gets it; honouring `"ask"` is still the
  consumer's.
- A stored entry that is not a well-formed policy of its scope is dropped on read, not repaired (`validList`).
- The choke point judges again. A new path that fetches for a run in the worker must go through `consented` in
  `worker-tools.ts`, or an `allow` from the gate is the only check.
- Do not build a source by concatenating a URL. `fetchUrlPolicySource` uses `JSON.stringify`; keep it the only builder.
- The `by` of a judgement may be `"builtin"`, a string, not a policy. Check it before reading `by.id`.
- Run policies are a worker-memory map backed by storage. A write goes to storage without awaiting; a failed write is
  lost until the next one.

## The policy page, and a change taking effect at once

- **`POLICIES`** (`background.ts`) is how the policy page reads and changes the store: `{}` reads, `{ op: "add" }` adds a
  GLOBAL policy, `{ op: "edit" | "remove", id }` changes any. It answers `policyView()`: the global policies, each
  session's, the built-in default as code, and why any broke. EXTENSION PAGES ONLY (`isExtensionSender`, the sender the
  browser reports): a page, or a content script relaying for one, that could add or widen a policy would be approving
  itself. A run policy is added only by an approval card's "remember", never from the page.
- **The page** is the `Policies` section of DevTools Settings, Permissions tab (`settings.tsx`): one `PolicyRow` per
  policy (effect, label, source as code, an inline editor, remove), the reason a broken one decides nothing, the
  built-in default read-only, and each session's run policies under its hash. It re-reads on `chrome.storage.onChanged`
  for the store's keys, which it duplicates rather than import worker code (a test holds the two lists together).
- **A card already showing is judged again** on every change (`onPoliciesChanged` → `rejudgePending`, `sw-consent.ts`).
  Only a pending entry whose descriptor carries `consumer` and `facts` is judged: the facts the WORKER resolved when the
  card opened (the `fetch_url` card of a run whose fetch the worker runs, today). A new `deny` closes it as refused, a
  new `allow` as answered, both with `source: "policy"` on the decision, which only the worker sets (every resolver
  that takes a person's or an orchestrator's answer builds its own decision). The model reads "Denied by a policy the
  person set while the card was showing: the policy "…" refuses it".
- **What an archive took is said, never silent.** Archiving a session removes its run policies and records which and
  when (`archivedPolicyLoss`, storage key `ml_policies_archived`). When the session is resumed, the note's `dropped`
  names them with the time, and the model reads them as `ml.current.policiesRemoved`. Deleting the session drops the
  record too.

## Not built yet

- A model PROPOSING a run policy, as a card that shows its breadth, computed by the worker over the run's log (3c: a
  new tool, so the tool registry and its own red-team pass).
- Telling a run that RELIED on a removed policy, on its next call, that the call now asks because the policy went
  (`POLICIES.md`, "A change takes effect at once"). The call asks; the reason is not said yet.
- A page-built run's card is not judged again when a policy changes: its descriptor carries no facts, because its
  fetch runs in the page and an `allow` cannot answer it (see Traps). A `deny` would; it is left for the run's next call.
