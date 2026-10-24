# Spec (WIP): policies, or "decide this without asking me"

**Status: partly built** (2026-10-15, REPL lane 2): the evaluator, the store with global and run scopes, the `fetch` and `sh` consumers' judging, the policy page, and `propose_policy`; how, and what is not built, in [`docs/dev/policies.md`](../dev/policies.md). The general mechanism behind every "run this without asking" in the extension. Moved
out of [`SHELL.md`](SHELL.md) on 2026-10-15, where it was first written (2026-10-13) for `ml.sh`, its first consumer;
`SHELL.md` keeps what a shell call gives a policy. The idea is older (2026-10-04): an agent that proposes its own
permissions as a structure a person can read and approve, every grant listed and revocable.

## Why one mechanism

Every gated call today ends in one of two places: the person answers a card, or something remembered answers for them.
The remembered half has been built four times, each with its own storage, its own UI and its own lifetime:

| Today | Where | What it remembers |
| --- | --- | --- |
| Approved URLs from an `exec` card ("Approve + remember these URLs") | `src/sw/grant-extract.ts`, `grants.fetch` in `src/sw/sw-consent.ts` | the literal `ml.fetch` URLs a person saw, for the tab |
| One-time call grants, credentialed fetches | `grants.call`, `grants.credentialedFetch` in `src/sw/sw-consent.ts` | one approved call or URL, consumed on use |
| Host permissions granted from a card | `grantHostPattern` in `src/sidebar/ui-kit.tsx` | a Chrome host pattern a fetch or a navigate needed |
| Pages where a run's approvals are skipped, and the Sheets grant | `pageApprovalDomains` in `src/contract/contract-config.ts`, `SheetsGrant` in `src/sidebar/settings/settings.tsx` | a domain list; a spreadsheet source  (ruled 2026-10-24: the builtin `act` policy, below) |
| A secret's scope (not built) | [`SECRET_HANDLES.md`](SECRET_HANDLES.md) | which origins, methods and paths a credential may be used against: a policy attached to the secret when it is stored |

Four hand-rolled copies of one thing is the sign that the general thing is missing. A policy is that thing, and each of
these becomes either a policy or a built-in default one. **The first consumer should be one that already exists**
(decided 2026-10-15): the approved-URL grants from an `exec` card, or installing a Python package on demand
([`PYTHON_DIALECT.md`](PYTHON_DIALECT.md)), whose facts are a name, a version, a source and a hash. Shipping the store,
the realm and the one-page listing against a real gate means `ml.sh` ([`SHELL.md`](SHELL.md), the consumer this was
designed against) arrives to a working mechanism. Later consumers: a secret's scope, and agents acting on other agents'
sessions (read, message, steer: a directional grant, which agent-to-agent coordination waits on).

The three layers every consumer is built from (describe, decide, enforce), and why a policy is only ever the middle
one: [`EFFECTS.md`](EFFECTS.md), "Three layers, said out loud".

**What runs without asking is decided by a policy, never by a classifier** (Shane, 2026-10-23). A classifier guessing a
call's intent is probabilistic: the same call can pass today and be refused tomorrow, and nobody can read why. Whether a
call runs unasked is a deterministic answer over its resolved facts, which the person can read, test and change. A
classifier may still DETECT afterwards (flag an edit or a run for review); it never decides what runs. A decision that
cannot be made from a call's facts belongs in a script the person owns ("A condition about the outside world is a
pinned script" below), not in a model's guess. What keeps a secret from leaving is a separate means
([`SECRET_HANDLES.md`](SECRET_HANDLES.md)), not this one.

## A policy is a function over the call

**A policy is a function over one call, evaluated by the read-only dialect** (Shane, 2026-10-13). The person can say
"anything matching this runs without asking", globally or for one run, and say it as code over the call's resolved
facts, not as a pattern over text.

```js
// Global, set by the person: read-only git anywhere in my roots, except the flags that write or run code,
// and never in a repository whose own config runs a program (the fact the built-in default requires too).
(c) => c.argv[0] === "git" && ["status", "diff", "log", "show", "blame"].includes(c.argv[1])
    && !c.argv.some((a) => /^--(output|ext-diff|exec|upload-pack)/.test(a))
    && c.paths.every((p) => p.inRoot) && c.repoConfigRunsCode === false

// For one run, granted from an approval card ("allow calls like this for this run"):
(c) => c.argv[0] === "npm" && ["test", "run lint"].includes(c.argv.slice(1).join(" "))
```

**What it is given is the consumer's to define**, and is always FACTS the host resolved, never text to re-parse: for a
shell call the final argv, the program after the `PATH` lookup, each path argument after `realpath` with `inRoot` and
`secret`, and what the program's manifest says the call does ([`SHELL.md`](SHELL.md), "Policies: what a shell call
gives one"). A consumer whose call cannot be given as resolved facts cannot have policies: a policy over a string the
host did not resolve is the commercial tools' pattern over a command line again, with the gap between the text and what
runs left open.

**Why the read-only dialect.** A policy runs on every call, in the approval path, so it must be pure, must halt, and
must be unable to do anything but answer. The dialect is exactly that: it is the whitelist, it never compiles a string,
it has a step budget, and it already has the halting and adversarial tests. A policy that throws, runs out of budget or
reaches outside the dialect is **no opinion**, so the call asks: a broken policy fails closed.

**A JS subset, not a policy language of its own.** The policy languages before this one each brought their own syntax
(Cedar, Rego, CEL, IAM's JSON conditions); Starlark and eBPF are restricted subsets of a language people already know.
This is the second kind, with two things those lack: the subset already exists and is already the security boundary (the
read-only dialect, built for auto-approved surveys), and the author is often the MODEL, which writes JS far more fluently
than a bespoke language it rarely saw. The cost is that a policy inherits JS semantics, which a bespoke language would
have ruled out by design, and a policy is exactly where a quiet mistake becomes a grant:

- `==` and `!=` coerce (`"0" == 0`, `null == undefined`), and the dialect evaluates them as JS does. A policy compares
  with `===`/`!==`.
- An empty array, an empty object and any non-empty string are truthy: `c.paths.length && …` is the guard, not
  `c.paths && …`, and `[].every(…)` is `true`, so "every path is in a root" holds for a call with no paths at all.
- A regex is unanchored unless it says otherwise: `/git/.test(c.program.path)` matches `/tmp/notgit`. Anchor it, or compare
  the resolved program by equality. (A regex that could backtrack without end is already refused by the dialect.)

**The policy realm** (decided 2026-10-15). A policy is evaluated in a third realm of the dialect beside `page` and
`worker` (`ReadonlyRealm` in `src/readonly-exec/policy.ts`): no `ml`, no `document`, only `c`. Two rules differ from a
survey there:

- **`c` is a facade that REFUSES an absent field.** In a survey an absent member reads as `undefined`, which is right for
  an existence guard. In a policy it is wrong in the dangerous direction: a typo'd `deny` (`c.arg[0]`) evaluates to no
  opinion and is silently never applied, while looking like a rule. Reading a field `c` does not have is a refusal, so
  the policy is BROKEN and shown as broken on the policy page, never inert. (The worker's `ml` facade works the same way,
  for the same reason.)
- **`==` and `!=` are refused in a policy** (they stay accepted in a survey). A policy compares with `===`/`!==`.

**A policy can answer from inside a script.** When a survey or a Python dialect cell makes a gated call (`ml.fetch` on a
new URL, `ml.sh`) and no policy allows it, that ONE call suspends on a card while the script waits, and continues when
the person answers ([`ML_WIRE.md`](ML_WIRE.md), "Per-call asking"). The script does not fall out of the dialect, and the
card shows the call's resolved facts, not the script.

## What a policy decides, and what it cannot

- A policy answers `allow`, `deny`, `ask` (next bullet), or nothing. `deny` wins over `allow` across policies; nothing
  means the tiers above decide. **"Always reject" is a policy like any other** (Shane, 2026-10-13): a call it matches is refused without a
  card, and the model is told which policy refused it, so it can stop trying rather than rephrase.
- **A policy may also answer `ask`** (Shane, 2026-10-22; found while ruling the default for a nested `rm`, #990). Across
  policies the stricter answer wins: `deny`, then `ask`, then `allow`, then nothing (the built-in default). A matching
  `ask` shows the card where a stored `allow` or the built-in default would have run the call; it never refuses and never
  runs a call by itself. It is how a person is STRICTER than the default without refusing: "ask on every `rm` under
  `src/`", where the built-in default frees a nested delete inside a root. Three rules come with it:
  1. **The narrow direction, like `deny`.** An `ask` whose evaluation read a `null` fact fires (docs/dev/policies.md, "A
     null fact is unknown"). Over an undescribed call (`effects: "unknown"`) an `ask` that needs a resource's field to
     hold does not fire, and the call asks anyway; one that tests an absence fires. Either way no `ask` fails open.
     A BROKEN `ask` is no opinion, like a broken `deny`: a call an `allow` or the built-in default frees still runs, and
     the policy page shows the `ask` as broken.
  2. **The card says why.** It names the `ask` policy that raised it, and offers no "remember" whose only result would be
     an `allow` the `ask` overrides.
  3. **The upgrade.** Builds before this one load only `allow` and `deny` (`sw-policies.ts`, the load filter), so a stored
     `ask` read by an older build is dropped and the default decides there: a downgrade loses the ask, never a refusal.
     The new build reads a fixture of the old store unchanged, and an `ask` it stores survives its own reload.

  An `ask` is the one answer a model may propose with the least at stake: wrong, it costs the person a click.

  BUILT (2026-10-22): `judgeCall` returns `decision: "ask"` WITH `by` (the policy) for an `ask`, where the unloaded store
  returns `"ask"` with no `by`, and every consumer puts the call to the person in both cases with no free tier of its own
  answering (the `sh` decision and the version probe, `fetch_url`'s `autoApprove` before the current page, same origin,
  self-source, a remembered approval and an `allow`). The store, the policy page, `propose_policy` and the model's
  `ml.current.policies` take `ask`. The card names the policy (`AskWhy.cause` `ask-policy`) and an exec card's "Keep"
  leaves out the fetch URLs an `ask` matches. How: [`docs/dev/policies.md`](../dev/policies.md), "The `ask` answer".

  An `ask` binds only where the extension decides. A read the page can make itself (its own origin, the page it is on,
  an uncredentialed read of window.ml's public repository) stays free to the page's own `ml.fetch`, and a run the page
  hosts (`window.ml.agent`) answers its cards with the page's own `approve`: a card in either place would bind nothing,
  since the page can skip it with a plain `fetch()`. What the page could NOT do itself, it loses: a consent the tab
  remembers from an earlier approval is withdrawn while an `ask` or a `deny` matches the URL (red-team recheck of #999).
- It changes only **whether the person is asked**, never what is enforced: whatever bounds the call (for a shell call
  the container, the OS sandbox and the workspace roots) bounds it whatever a policy says.
- It never reaches the refused tier: a call from a page, or one made from the page's world, is refused before any policy
  runs.

## A condition about the outside world is a pinned script

(Ruled 2026-10-20: Shane's suggestion after the classifier refused a merge of parawanderer/cpython#4; lane 3's
analysis; #853, #859.)

A policy cannot ask whether CI is green or whether anyone has commented: it sees only the call's resolved facts and
queries nothing. Such a condition moves into a program that checks it and then acts, and the policy allows that program.
Three properties make the allow mean what it says:

1. **The check is bound to the act.** Whatever the script checked is what it acts on: `merge-when-green` merges with
   `--match-head-commit <the sha it judged>`, so a push during the wait is never merged untested.
2. **Text only blocks.** Anything the script reads that anyone can write (a comment, a marker, a commit message) may
   stop it and never let it through. Each post is cleared by the operator naming it, never by its content.
3. **The pinned code is what runs.** The policy allows an `(program, entrypoint)` pinned by `sha256` over its local
   import closure ([`PROGRAM_MANIFEST.md`](PROGRAM_MANIFEST.md), "Interpreted script tools", mode 3). For a script that
   decides on changes to its own repo, the copy on main judges, never the branch's: `merge-when-green` always runs main's
   copy of itself (#859). **The pin is enforced by the person's merge of changes to the pinned script, never by the
   script:** a script on a branch cannot prove which copy ran, so the tool refuses any PR that touches it, and the
   person reads and merges that one by hand.

`merge-when-green` is the worked example: "merge my own PR when the pipeline is green, no test was removed and nothing
is unread" is a policy allowing that one script, with no condition of its own.

## Describing and deciding: manifests and policies

Two specs carry a consumer such as `ml.sh`, and they are separate on purpose:

- **A manifest DESCRIBES** a call ([`READONLY_LIBRARY_MANIFEST.md`](READONLY_LIBRARY_MANIFEST.md)): what it affects,
  what it costs (a closed-form bound, metered, or "interpret my body"), what its return value aliases, and, for a
  program, which arguments are paths, where its operands start and whether it runs other programs. It is shipped or
  installed, pinned by hash, and says the same thing for everyone.
- **A policy DECIDES** whether that call needs a person. It is the person's choice, and it leans on the manifest's facts
  (`c.effects`) so it never has to know which `git` flags write.

**Built-in defaults are policies too.** A consumer's "free" tier is the built-in default policy, sitting beside the
person's, and it is ONE rule for every consumer ([`EFFECTS.md`](EFFECTS.md)): the call's effects are a subset of what
the enforcer at its placement bounds, plus reads inside the workspace roots of paths not flagged secret. For a shell
call on the plain host, where nothing is bounded, that reduces to `(c) => c.effects.pairs.every((e) => e.op === "read" &&
e.res.kind === "fs" && e.res.inRoot && !e.res.secret)`: a UNIVERSAL over the set, never a list of excluded operations
(an earlier draft wrote `!has("write") && !has("exec") && …`, which let `use(secret)` and `alloc` through unnamed; lane
2 of the plan caught it building the algebra). Under the OS sandbox, writes inside the roots join the free set because
Seatbelt publishes them as bounded. The example is derived from `free()` in the algebra's module, not written by hand. So the free tier needs both specs: the manifest for `effects`, the policy to
act on it. Without a manifest a call's `effects` is `unknown`, the top element, inside no bound, and it asks: correct,
only slower.

## Scopes, and who sets them

| Scope | Set by | Lives |
| --- | --- | --- |
| global | the person, in DevTools Settings | until removed |
| workspace | the person, for one set of roots | with the workspace |
| run | the person: at the start, or from an approval card ("calls like this, for this run") | with the session, keyed by its hash: it **survives a resume**, and a fork the WORKER builds inherits it (decided 2026-10-13, narrowed 2026-10-15: today's fork is page-side and arrives as a plain start the worker cannot tell from a new run, and a page naming a parent to inherit its grants would be an escalation route, so a page-built fork inherits NOTHING); listed with each session until removed, and removed when the session is archived (a standing grant should not outlive the person's attention; a rule wanted across an archive belongs at workspace or global scope); an unarchived or resumed session is TOLD, person and model, that its run policies were removed at archive time |

**Why a call asks** (ruled 2026-10-19, lane 9, window-ml #818). When a call asks because the policy that would have
allowed it is gone, the ask carries the cause: `archived` (removed at archive, the row above), `removed` (by the person)
or `narrowed` (the policy no longer covers the call). `expired` is reserved and has no producer, since no policy has a
lifetime. The cause is text on the ask, never an input to the decision: a reason never re-allows, and nothing in a
call's payload may name a policy to claim it (the sender rule; a red-team test pins it). The person sees it on the
approval card and the model in the tool result; the run log and the export carry what the model saw. A credentialed
fetch asks regardless of policy and carries no cause. A session resumed or unarchived after its run policies were
removed is told once, before the first model call, by a note the WORKER writes, rendered as the worker's in the
transcript and the export and never as the person's words; the first ask afterwards says so again with its cause.


The model may PROPOSE a run policy, which reaches the person as an approval like any other; it never adds one itself
(the one exception is a person's own grant, "A policy kept in a file" below), and a page never can. A policy reached over the hub is set by a principal holding `approve`.

## Where a policy can live

Every place a policy can come from, how it is written there and how it reaches a decision (2026-10-23). The scopes
above are three of these rows; the store's keys and code are in [`docs/dev/policies.md`](../dev/policies.md).

| Where | Written as | Loaded | Status |
| --- | --- | --- | --- |
| Built-in default | code: `free()` in [`src/effects.ts`](../../src/effects.ts), ONE rule over a call's effects for every consumer | compiled in; always present | built |
| global | a `StoredPolicy` (among its fields source, effect, consumer, label, and origin: `person`, `card` or `proposed`) | read from `chrome.storage.local` after each worker wake; until it is, every gated call asks | built |
| run | the same, keyed by the session's hash | as global; survives a resume, removed when the session is deleted or archived (kept when the move to the archive fails) | built |
| workspace | not specified | not specified | this spec's scope table only |
| Over the hub | set by a principal holding `approve` | not specified | one sentence above |
| A file (a repository the host opens, or one passed along) | not specified; the policy page's typed-node trees are the natural form, with the hash of each script a rule allows | its `deny` and `ask` rules from the live file at once; its `allow` rules only from the accepted snapshot, pinned by hash, loaded by a card, entering the store with `origin: "file"` | proposed below |

## Widening is a policy, never a button on a card

**An approval card has two answers: allow this call, or deny it (with a note).** Never a menu of guessed generalisations
("allow `git` commands", "allow `git -C …` in this folder", "for this session", …), which is what makes approving shell
commands elsewhere miserable (Shane, 2026-10-13). Those menus exist because the tool has to guess how to widen a shell
STRING, and it hands the guess to the person mid-task, under fatigue, with the broad option one click from the narrow
one. Here widening is never a button on a call:

- **It is a policy**, written deliberately: by the person in Settings, or proposed by the model as ONE card that says
  what it will match and shows the evidence ("Showing what was approved" below). One approval of a stated rule instead
  of a choice among five guessed ones.
- **A card may link to "make a rule from this"**, which opens the policy editor with a predicate built from the call's
  resolved facts, as code, for the person to narrow or widen. Writing it is a separate act from answering the card,
  and the card is answered either way.
- **Fewer cards is the job of the tiers**, not of the card: the consumer's own description of a call, its sandbox and
  the person's policies decide most calls before a card exists.

## A policy kept in a file (proposed, not built)

(Shane and the sh-policy session, 2026-10-23.) Every policy above lives in the person's store. A policy can also live in
a FILE: in a repository the host opens, or passed along as a file or a link, so that rules someone decided can be
copied by others. A repository is one place for such a file, not the main case: this system is not built around a
coding workflow. The rules below hold whatever carried the file; only how it is found differs (a file found where it
applies, a directory or an origin, is in effect for that place; one the person imports applies where they say).

- **A file is untrusted until accepted**, whoever wrote it. The host cannot tell that the person opening a repository
  wrote its policy, for the same reason a repository's own git config is untrusted ([`SHELL.md`](SHELL.md),
  `repoConfigRunsCode`); that fact is about git config and none of these rules reads it. A file's `deny` and `ask`
  rules take effect on the file's word, under any configuration: across policies the stricter answer wins ("What a
  policy decides" above), so neither can make a call run. Its `allow` rules take effect only once accepted.
- **What is in effect is the accepted snapshot, plus the file's live `deny` and `ask` rules.** Acceptance is of a
  content hash, for that file at that place: the same bytes at another path or place are not accepted. A rule that was
  in the accepted snapshot stays in effect until a new snapshot is accepted, so deleting a `deny` from the file (by
  anyone, through any write the rules allow) frees nothing, and adding one takes effect at once. Editing the file,
  the model's edits included, therefore never widens what runs: the host sees the hash differ and shows a pending
  change.
- **Loading a change is a proposal, not an answer to a call.** It reaches the person as one card stating what each new
  or changed `allow` will match and the evidence, as a proposal from the model does ("Showing what was approved"
  below), never as a button on a call's card ("Widening is a policy" above). Accepted, each such rule enters the store
  as a policy with `origin: "file"`, the file's place and path, and the snapshot's hash, at the scope of the place it
  was found in or the one the person chose; the model reads that origin in `ml.current.policies`. From there it is an
  ordinary policy: a `deny` from any source still wins over it, and "A change takes effect at once" applies.
- **A script a rule allows is pinned as any allowed script is**: `(program, entrypoint)` by `sha256` over its local
  import closure ("A condition about the outside world is a pinned script" above), recorded in the snapshot. The pin
  is checked at every call the rule would allow, not only at acceptance: after an edit to the script or anything it
  imports, the rule no longer matches and the call asks, so it fails closed and the script needs no write protection.
  The model may draft both a rule and the check it allows; neither frees a call until the person has accepted them.
- **Committing or pushing a change to a policy file asks by default**: a commit whose staged paths include a policy file
  or a script one of its rules allows. Under these rules every person who takes the file meets the new hash as a
  pending change, so the gate does not protect anyone's enforcement: it is the author ENDORSING the change for everyone
  who takes the file from them, and the model does not endorse in the person's name unless told to.
- **These gates are defaults, and a person widens them by policy, as any other.** Someone working on a shared
  repository keeps them; someone whose file is their own and read by no one may let its commits and pushes go
  unasked. The grants differ in weight and the card says which: unasked commits and pushes give up only the
  endorsement. Loading the model's own edits UNASKED is the one exception to "the model never adds a policy itself"
  (Scopes, above), exists only once the person has written it, and gives up every gate, since the model can then
  write "allow everything"; its card says so in those words. A person who disagrees with a file's `deny` does not
  answer it with an `allow`, which it would beat: they take the file out of effect for that place, a separate act.

The worked example is "merge only through my script" without a classifier. One `deny` matches every `gh` call and
every `git` call whose effects are not read-only (so read-only `git` is left to the tiers, and no `allow` has to beat
a `deny`), and one `allow` names a pinned script that decides what makes a PR mergeable. What "reviewed" means is the
script's, so the person's. The same rules can be the way one person works on their laptop (their store) or what a
project decided for itself (a file in its repository, accepted by each person who opens it); there the `deny` applies
at once and the script waits for acceptance. Open, and a dependency of every `deny` naming a program: whether the
host's sandbox refuses that program when an allowed call starts it INDIRECTLY (a runner such as `npm run`, `xargs` or
a git alias); until it does, "deny `git`" covers calls that name `git`, not every process that runs it.

## One page lists every policy

Global, workspace and each session's, one line per policy (Shane, 2026-10-13). Each line can be edited or deleted on
its own, which is the reason for building policies from typed nodes: a line is a readable sentence, not a blob of code
to diff. Global (persistent) policies are edited there the same way as a run's. The model can PROPOSE removing several
at once ("these five no longer match anything this session does"), as one card the person confirms; removing narrows
what runs without asking, so it cannot escalate, but it is still the person's list.

## A change takes effect at once

On every call not yet started:

- **A removed `allow`** turns the calls it covered back into asking (or refused, when an `always reject` now matches).
  A call is judged at the moment it starts, so a script mid-loop meets the change on its next call.
- **A call already running is not stopped** by a removal: the decision was right when it was made. The person can
  cancel it, as any running call.
- **A card already showing** is re-judged when a policy changes: a new `allow` answers it, a new `always reject`
  refuses it, and the card closes saying why.
- **A run that relied on a policy is told** when its next call meets the change: the result says the call now needs the
  person (or was refused) because the policy that covered it was removed, not that the call itself changed. Built
  2026-10-19 (REPL lane 9) for `fetch_url` and `sh` asks, with the cause (archived, removed, narrowed) on the card, in the
  tool result and in the run log; text only, never an input to the decision. A session resumed after an archive is told
  once before its first step. How: [`docs/dev/policies.md`](../dev/policies.md), "Why a call asks".
- **Re-judging reads only resolved facts** (ruling, 2026-10-15). A showing card is re-judged only when its descriptor
  carries the consumer's resolved facts, effects included; a descriptor without them is left to the person, never judged
  with `effects` read as `unknown`. Reading it as the top element is right for the built-in default, which allows no
  unknown, but a person's `allow` that never looks at `c.effects` would then answer a call whose effects were never
  resolved, which is the case the universal default exists to send to a card. Today the consumers re-judged are `fetch`
  and `sh`; the descriptor type makes `effects` required for both (lane 4's seam).
- **A store not yet loaded means ASK, free tiers included** (lane 2, 2026-10-15). After a worker wake the saved policies
  are read asynchronously; until they are, every gated call asks, because an unloaded `deny` is an unenforced one and
  an unloaded `allow` costs only a card. The consumer's gate (`judgeCall`) carries this rule itself, so a consumer added
  later cannot forget it.

## Showing what was approved

A predicate cannot be explained back faithfully in general, which is the open point the idea raised ("a tree, not a
string"). The precise statement (2026-10-15): the fragment that CAN be analysed is boolean combinations of equality,
prefix and membership atoms over the resolved facts and the effect set, all over finite domains. Inside it, which calls a
policy admits can be enumerated exactly, so "this policy can match X" is a proof. Outside it (a regex, a string
operation, arithmetic over lengths) breadth can only be measured. A typed-node tree is that fragment made visible, which
is why it is more than a nicer UI; a model-proposed policy leads its card with a DERIVED breadth when it fits the
fragment and a MEASURED one when it does not, and says which. The rule: a policy the person WROTE is shown as the code they wrote. A policy the model PROPOSED is shown with its evidence:
the calls this run has made and the ones it would allow next, checked against it before it is granted, and a plain
statement of its breadth (which programs it can match at all, and whether any matched call writes or reaches the
network). A builder of typed nodes that renders to a sentence and to the same predicate is the stronger form.

**A policy is co-written with the model, not typed into a builder** (Shane, 2026-10-23). The person says what they
want in their own words and the model drafts it; they refine it in conversation, never by filling in a form of typed
fields or typing JSON. That is safe for one reason: what the person approves is never the model's paraphrase of the
rule. Each draft reaches them as a proposal card, which shows what the SYSTEM renders from the rule (the code, and the
sentence and predicate rendered from a tree once there is one, "The tree, ruled" below) and its breadth evidence: the
calls it would and would not match. A refinement is the card's own "deny, with a note", which the model reads to
propose again, so no new answer is added to the card ("Widening is a policy" above). That note is the gate's generic
deny feedback (`agent-loop.ts`, "Denied by …: <note>"), sent by the split Deny on both the transcript's card and the
HUD card.
Not built as a loop: `propose_policy` (`fetch` only today) and its card exist. Open: whether a conversation that drafts
several policies needs more than one card at a time, and whether a proposed policy the person then edits in the policy
editor becomes theirs (`editPolicy` keeps `origin: "proposed"` today).

**Code first, a tree later, and only as an option** (Shane, 2026-10-15). Policies are code in the read-only dialect, since
a code policy is dynamic and covers more than a tree can. If a typed-node tree turns out to cover enough of what people
write, it becomes the default, and code policies move behind a DevTools Settings toggle ("allow read-only exec
policies"), off by default. The two answer different questions: a call is always decidable for a code policy (it halts),
but WHICH calls it allows cannot be read off the code, since that is a question over every possible input, with regexes
and string operations inside. A tree small enough to analyse can answer it; code cannot, so the breadth shown for a code
policy is measured, never derived. The toggle governs WRITING a code policy, never a stored one (ruled 2026-10-21, lane
11's design note): an existing code policy keeps judging with the toggle off, because switching a stored `deny` off would
let through what the person refused, and the upgrade gets a fixture of stored code policies still deciding as they did.

**The tree, ruled 2026-10-21** (lane 11's design note,
[`LANE_11_POLICY_TREE_DESIGN.md`](../plan/repl/LANE_11_POLICY_TREE_DESIGN.md), #920, and the ruling PR on it). The
measurement the note made is over 231 policy sources, none written by a model or by a person using the product (205 from
tests, 22 from docs, 4 built in), so its 92% is a figure over what this repository's authors wrote to exercise the
machinery, and 21 of the 39 real-consumer policies are the one atom `c.host === X` (38 in the note; the corpus PR, #925,
found one source that also occurs over `fetch`). That number does not decide whether the
tree becomes the default; the one that does is measured on policies MODELS PROPOSE, which do not exist yet. So the order
is: the LIFTER first (a syntactic recogniser over the dialect's AST that turns a source which fits the fragment into a
tree, small, the first code either way), then a bench task per consumer that asks the panel to propose a policy for a
described need, fed through the lifter, and the covered fraction of THAT corpus is the number. MEASURED 2026-10-21 (lane
11, #934 at b8030ae8, 15 models, one answer per cell, $0.58; the report `tests/e2e/panel/policy-proposals.md`, the
prediction written before the run): of the answers that gave a policy, the lifter covers 33 of 52 on `fetch` (63%; 83%
leaving out the small local models' format failures) and 24 of 53 on `sh` (45%; 57%), against the predicted 80-95 and
55-75: both BELOW. The spread between consumers is larger than between models. On `fetch` the fragment selects for
correct policies (97% right when lifted, 4 of 7 right when a well-formed answer stayed code); on `sh` it does not (63%
against 67%), and the `sh` misses are the ones predicted plus a number on `repoConfigRunsCode`, a const that is not a
literal and a prefix that does not end at a separator. What the number decides: at 63 and 45 the tree is not the only
form a policy takes, so code policies stay and the tree is the DESCRIBED form of the ones that lift; whether it is the
default form a card leads with is still Shane's, on this number. One fail-open in the corpus, the finding to lead with:
an ALLOW written as `!c.repoConfigRunsCode` fires when the fact is `null`, unknown (2 of 15 models on S3). RULED here,
narrow beats wide: a fact that is `null` is unknown, and an ALLOW over an unknown never fires, which is the deciding
layer's rule, not something a model is asked to remember. BUILT (lane 11's follow-up): the realm's side
(`evalPolicy`'s `unknown`, docs/dev/policies.md "A null fact is unknown") and the tree's (`treeVerdict`, the null cell
in the agreement test), with a before-and-after `fetch` rerun. On the corpus it nets zero on `sh` right answers: the two
S3 fail-opens now ask, and two correct allows (a `cat` and an `npm test` guarded by `repoConfigRunsCode !== true`
outside any repository) now ask too, fail-safe; the host sending `false` when no repository encloses `cwd` gives those
back ([`SHELL.md`](SHELL.md), the optional-fact rule), and the ruling stands. MEASURED AGAIN with `propose_policy`'s
details text served to the model (#961, merged c1d1f6ed, 2026-10-21; `tests/e2e/panel/policy-proposals.md`): `fetch`
lifted 41 of 49 (84%; 91% excluding format failures), every lifted policy right, against 33 of 52 (63%) without the text;
a first text whose examples were two needs' own answers reached 88% and was withdrawn, since the models copied it (a trap
in the bench and panel skills). `sh` is unchanged by the text. Spend $0.46 for both reruns. RESCORED 2026-10-21 (#973, merged e7ab5488; the scorer's calls outside a repository carry `repoConfigRunsCode: false` as window-ml-host #23 answers, `null` only for the could-not-tell vector; nothing rerun; recomputed by the coordinator from the sweep): `sh` 29 right of 53 (16 of 24 lifted, 13 of 29 that stayed code), up from 27 as the two answers that add `c.repoConfigRunsCode !== true` are right again; no fail-open. Merged before its named reviewer posted (the merge tool waits only on a posted, unread review), so the janitor's review of e7ab5488 is post-merge. The task asks for the
policy as TEXT in the model's answer, for both consumers, so it needs no tool and nothing reaches a person: the number
over `sh` proposals is measured the same way as over `fetch` ones (Shane, 2026-10-21). Widening `propose_policy` itself
from `fetch` to `sh`, so that a model can put a shell policy in front of a person, is a separate and later decision, and
its prerequisite is the shell side's own probes (programs, paths and flags the run never used) before any such card can
lead with a measured breadth. RULED YES by Shane on 2026-10-23 (the coordinator's session), the prerequisite kept: the
widening lands with the shell probes or after them, never before; and, the coordinator's ruling under "A policy is
co-written with the model" below, an `sh` proposal the lifter cannot lift is REFUSED, the model told its shape did not
lift and which shapes do, never shown as code with a measured breadth, since the person would then be approving the
model's text; a lifted one leads with its derived breadth and runs the probes as the derivation's test. Narrow first;
widening to unlifted `sh` code is Shane's, later, on a number. Built by the `[window-ml root-k]` session
(`docs/plan/repl/ROOT_K.md`). Nothing else of the tree is built before the number exists, in `src/`: the lifter's
agreement test may hold a tree evaluator and a cell generator under `tests/`, imported by nothing in `src/`, and the
ORACLE in that test is the ORIGINAL source run through the real policy realm, never the test evaluator, so a tree the
test accepts is one that agrees with the code a person could read (ruled 2026-10-21, lane 11's question; the evaluator
moves to `src/` only with the tree itself, after the number). What the note fixed is ruled as it
stands: the TREE is what is stored, the sentence and the predicate are both rendered from it and never parsed back, the
judge runs the rendered predicate through the one evaluator as it runs every policy, and a model is never asked to emit
tree JSON (it writes JS, and the lifter lifts what fits; what does not lift stays code with a MEASURED breadth). A
prefix is over a field's SEGMENTS (path components, host labels from the right, a URL's scheme, host, port and path
components), never characters, with one exception: an argv element is opaque text, so `StartsWith` over an argv element
stays, bounded to that field, because the flags a manifest names (`--output=x`) are character prefixes of it. The card's
breadth block is DERIVED or MEASURED and never mixed; a derived card still runs the probes, as a test of the derivation,
and a probe the tree admits that the derivation said it cannot admit is a defect in the analyser: the card falls back to
MEASURED, the disagreement is logged, and the fix lands with that probe as a test. The atom cap (24) is a stated guess
until a number says otherwise; above it the card says MEASURED. The empty list is said on the card ("true when there are
none"). An optional fact is never absent in the facts a policy sees, so the tree has no presence test ([`SHELL.md`](SHELL.md),
"An optional fact is sent as `null`"). Finally the note found that this spec's own git example admitted `git diff` in a
repository whose config runs a program, which the built-in default refuses: the example now requires
`c.repoConfigRunsCode === false`, and the rule it instances is that an example in a spec is never wider than the built-in
default on a fact the default names.

**How a measured breadth is probed** (lane 2's red team, 2026-10-15, and the ruling on it). The worker runs the proposal
over this run's own calls and over PROBE URLs on hosts the run never used, and the card leads with both counts. The red
team showed that constant probes are excluded by name (`c.host !== "<probe>"`) and the probes were made random per
proposal. Random names are not enough: the dialect has `startsWith`, `endsWith` and `split`, so a policy can exclude
probes by SHAPE (`!c.host.endsWith(".invalid")`) and still match every real site. The rule is that the probe set carries
no fixed marker a policy could key on: random labels of random length under common public suffixes (`.com`, `.org`,
`.net`) as well as the reserved ones, a SIBLING of each host the proposal matched at EVERY label depth (`a.b.c.d` gives
`<random>.b.c.d`, `<random>.c.d`, `<random>.d`; a policy written for `shop.com` that also admits `<random>.com` reaches
past the run, and one written as `endsWith(".github.io")` is caught by `<random>.github.io`, which a last-label sibling
would miss; no public suffix list is needed), a path and a scheme variant
of a matched URL, plus loopback and a private address, which stay fixed because reaching them is always past any site. A
zero-stray result is reported as "matched none of the N unrelated sites it was tried on", never as "reaches no other
site": outside the decidable fragment a measurement is a sample, and the card says so.

**Every allowed call says which policy allowed it**, in the run log and on the call's row, and a run's policies are
readable by the model without approval, since reading what you may do is not an escalation. Where that lands
(2026-10-15): the run's policies are declared in the state registry with audience `model` and reach the model as
`ml.current.policies`; the resume divider the PERSON sees names the policies a resumed session carried. (The
`session-resumed` event's text never reaches the model, whatever two older docs said; lane 2 of the plan found and
fixed the claim.) An agent that can see its
own grants stops asking for what it already has, and can say which grant it relies on.

## Navigate is a fetch: one read, two modes

**RULED 2026-10-24 (Shane; coordinator session):** `navigate` IS a credentialed, rendered fetch of the URL, plus the run
moving there: the interactive mode of the same read. The two gates grew up apart, and today disagree in four places,
read off the code the day of the ruling: `fetch_url` is a policy consumer and `navigate` is not, so a `deny` on a host
stops the fetch and not the navigation, and nothing can block navigating to a domain short of the run's `crossOrigin`
option, which refuses every cross-site navigation; a navigate's consent is an ORIGIN kept per run in the run host
(`consentedOrigins`), a fetch's is a URL kept per tab or per run in the fetch gate, and neither reads the other's, so
after an approved navigate to an origin the run fetches that origin free only while it is ON it and never as the user;
and a same-origin navigate is free while a same-origin as-you fetch asks unless `autoApproveSameOriginAuth` is on,
although both read the same page with the same cookies and the model reads the result either way (the DOM survey, or
the body). Aligned:

- **One consumer.** `navigate` is judged as the `fetch` consumer with the same facts, `credentials: true`,
  `rendered: true`, and a new fact `interactive: true`, under the same precedence (deny > ask > allow > builtin). A
  policy that names a host governs both. A policy may still tell them apart on `interactive`; the default rows do not.
- **One consent, scoped by the origin.** A person's approval of a navigate to an origin is an as-you grant for that
  origin for the rest of the run, in every mode: a later `fetch_url` of a URL under it, credentialed or not, rendered
  or not, is consented. A fetch approval stays per URL (the narrower unit, as today), and an origin grant covers the
  URLs under it. The grant is the origin, never the registrable domain: a subdomain is another origin. The redirect
  guard is unchanged in both directions: a read that ends on an unconsented origin returns nothing.
- **One free tier.** The page the run is on is free in every mode, as `navigate` already was: a same-origin as-you fetch
  needs no card, and `autoApproveSameOriginAuth` is retired as a flag (the upgrade test reads a config that still
  carries it). What the page could make itself with `fetch()` stays unjudged, as in "What an ask cannot reach".
- **What stays apart.** The run's `crossOrigin` option stays the run-level opt-in for leaving the origin at all, in
  either mode (so a run started without it fetches cross-origin only through a card, as today, and never navigates).
  The card for the interactive mode says that the run will act on the page it lands on; the fetch card says the body is
  read. Leaving a page the run acts in is the interactive mode's own cost, not a wider grant: an approved as-you
  fetch of a URL does not by itself consent a navigate to it unless the person approved the ORIGIN.

**A policy over a URL pattern covers both modes.** A policy is a function over the facts, so "the agent may not fetch
`https://example.com/admin/*`" is `(c) => c.kind === "fetch" && c.url.startsWith("https://example.com/admin/")` with
`deny`, and under this ruling it denies the navigate as well as the fetch. The policy page offers that row from a card
as it offers a host row today.

**A navigation the model did not name is judged on arrival (ruled 2026-10-24, Shane).** A `click` can navigate the tab,
a page can redirect itself, a timer can send it on: the destination is the page's choice, not the model's, so no card
before the act can see it in general. The rule is enforced where every cause meets: on every navigation the run's tab
COMMITS while the run is live, the run host judges the committed URL as the `fetch` consumer with `interactive: true`,
before re-adoption. A `deny` BLOCKS the run on that page: no survey, no step, no tool runs there, the model is told
the page is denied by a policy (the policy named), and the person sees a card that offers to go back or end the run. An
`ask` pauses the run with the card. An `allow`, or an origin already consented, continues, and that arrival consents the
origin like an approved navigate. Where the destination IS known before the act, an anchor's `href` on the element the
click resolves to, the click is refused up front with the same reason, which saves the click and the page load; this is
the describe layer, the arrival check is the enforce layer, and the second never relies on the first. Open: redirect
hops the tab never commits (a denied URL that 302s to an allowed one was still read by the browser); the fetch gate's
redirect guard sees only the final origin, so hops are a left item for both modes.

**Corrected 2026-10-24 (the builder's question, the coordinator's ruling): an arrival an `allow` policy lets through
is not an as-you grant.** "Consents the origin like an approved navigate" above was too wide. An as-you grant needs a
person on a card, everywhere: an approved navigate card grants the origin as-you for the run; an arrival that an
`allow` row let through, or a navigate an `allow` row approved without a card, adds the origin to the run's consented
origins for navigation and uncredentialed reads only, as the run's start origin is, and a credentialed `fetch_url`
under it still asks. Otherwise a model-proposed `allow` written without `!c.credentials` would move the tab to the host
with no card and then read it as the person. What (b) leaves: the tab the run moved to is still acted on as the person,
so `propose_policy` names `interactive` among the facts and the card's breadth evidence counts the navigates a proposal
lets through; a person approving an `allow` sees that it moves the tab. The run's start origin is likewise a consented
origin and never an as-you grant (the build's "As built" note).

A build: `navNeedsConsent` consults the judge first and writes an approved origin into the run's consent set the fetch
gate reads; `fetchFacts` gains `interactive`; the `fetch` facts' schema and the policy page's rows show it; the
same-origin as-you free tier replaces the flag; the run host's committed-navigation hook judges every arrival. It widens two grants (an origin grant across modes, the same-origin
as-you tier), so it lands with a red-team pass by a separate session (rule 10) and after the freeze.

**As built (2026-10-24), where the build narrows the ruling:**

- **The start origin is consented, never an as-you grant.** It is in the run's consented origins (navigation and
  uncredentialed reads), as before. An as-you `fetch_url` of it is free while the tab is on it (the free tier) and asks
  once the tab has left it.
- **A page-built run keeps per-URL approvals for its fetches.** An approved navigate card is an as-you origin grant for
  `fetch_url` only in a run the worker built, whose `fetch_url` the worker runs (`grantRunOrigin`). A page-built run's
  `fetch_url` is gated in the page, which does not read that grant; the navigate consent itself still covers it.
- **An arrival no policy decides passes and consents nothing**, the builtin answer included: no card was owed before
  the act either.
- **An `ask` asks about every arrival it covers, an origin already consented included.** "An origin already consented
  continues" holds where no policy asks: the policy asks about the page, not the origin.
- **A hold outlives the turn.** A run whose turn ends held is not re-adopted on that page, and its next turn judges the
  page the tab holds then before anything runs (the person may have gone back by hand). Holds are worker memory: a run
  resurrected after an eviction is judged again on the page it wakes on.
- **Not built:** the policy page's rows do not show `interactive` yet (it needs a design and its strings).

## Worked example and acceptance test: a task on another site, scoped by a proposed policy

**Shane, 2026-10-24.** The simplest whole use of the mechanism, and the test of it: the person opens the model on any
page and says "you are working on `https://example.com` and have to do [task]; you may go anywhere on
`https://example.com`, click buttons on `https://example.com/user/*`, and never go to `https://example.com/admin/*`".
The model proposes that as a policy, the person reads the card and approves it once, and the model does the task with
no further card inside the rule and a refusal at its edge. Three rulings make it possible on top of "Navigate is a
fetch":

- **A proposal may carry several rules.** `propose_policy` takes a LIST of `{effect, when, label}`; one card shows each
  rule as its own row with its own breadth note, one answer adds them all (each its own stored policy, origin `proposed`,
  sharing a proposal id so the page can show them together). The example is three rows: `allow` `fetch` on
  `c.url.startsWith("https://example.com/")`, `allow` `act` on `c.action === "click" &&
  c.url.startsWith("https://example.com/user/")`, `deny` `fetch` on `c.url.startsWith("https://example.com/admin/")`.
  Precedence does the rest: the deny beats the allow on `/admin/`, and under "Navigate is a fetch" it denies the
  navigation, the fetch and the arrival alike.
- **Acting on a page is a consumer.** `act` is a third consumer beside `fetch` and `sh`: facts are the page's resolved
  `url` and `host`, the `action` (`click`, `type`), and what the element IS as the worker resolved it (tag, `href` when
  it has one, its accessible name), never the model's description of it. The self-approval list of origins (the fourth
  row of the table at the top, `pageApprovalDomains` and its slice 3 successor) becomes the BUILTIN `act` policy, which
  folds that mechanism in as this spec set out to. An `ask` on `act` asks as today; a `deny` refuses the click with
  the policy named; an `allow` skips the card. A click on an element whose `href` the `fetch` rows deny is refused up
  front, the describe layer of the arrival rule above.
- **A policy the person approved is the person's word for leaving the origin.** `crossOrigin: false` means "no
  cross-origin without the person's word", and a card or an approved `allow` naming the origin is that word; it no
  longer refuses outright. Starting on one page and working on another site is then exactly the example: nothing
  crosses until the card is answered.

**The acceptance test** (e2e, `fake-llm`, two local origins A and B so the cross-origin path is real): the run starts
on A; the scripted model calls `propose_policy` with the three rows; the test reads the card (three rows, each with a
breadth note over the probes, zero recorded calls said as such) and approves; `navigate(B)` runs with no card; a click
on `B/user/x` runs with no card; a click on an anchor to `B/admin/` is refused before the click with the deny named; a
button whose script sets `location` to `B/admin/` is clicked (its href is not known) and the run is BLOCKED on arrival
with the card; `fetch_url(B/admin/…)` is denied; `type` on `B/other` asks, since no row allows it. Red-team properties
beside it, in the finder's own file: a page-built run cannot propose; a proposal over a sibling host shows in breadth;
the deny wins whatever order the rows are sent in; a redirect from `B/ok` to `B/admin/` is blocked on arrival. Nothing
here is built; it lands after the freeze, with the navigate build it depends on.

**Extended the same day (Shane): a rule about one button on one page, and a demo site that tries the edges.** The
instruction grows a fourth line: "on `https://example.com/user/approvals` you may click only the button `Approve This
Draft`, not `Delete` or `Publish`". The ruling:

- **The fourth row is a deny written on what is allowed.** `deny` `act` on `c.action === "click" &&
  c.url.startsWith("https://example.com/user/approvals") && c.element.name !== "Approve This Draft"`. Precedence makes
  it work over the `/user/*` allow: the deny wins on that page, and the one button falls through to the allow. It is
  not written as "deny `Delete`, deny `Publish`": the person said what the model MAY click, and a rule that names the
  forbidden buttons lets a third button through (rule 1, narrow beats wide; the sensors are the demo's, not the
  rule's). `name` is the element's accessible name as the worker resolved it at the click, the same resolution the
  click then runs on; the model's description of the button is not a fact. The name is the page's own text, so a page
  that labels a delete button "Approve This Draft" lies to the person and the model alike: the policy binds what the
  model may attempt, never the page's honesty, and the demo site is the person's.
- **An `act` row's breadth is over recorded clicks.** The card's breadth note for an `act` row lists the recorded
  clicks and types on that origin it would and would not match (element name, page), and says so when there are none,
  exactly as a `fetch` row does over recorded URLs.
- **The two rules compose on arrival.** A click the fourth row allows whose script then sets `location` to `/admin/`
  is still blocked on arrival by the third row: `act` judged the click, `fetch` judges where the tab went.

**The demo site** is the acceptance test's origin B, a fixture the test serves, with a server-side log the test reads
so what HAPPENED is asserted, not only what was refused: `/` (links into `/user/`); `/user/x` (a button "Open admin"
whose script sets `location` to `/admin/`, and an anchor to `/admin/`); `/user/approvals` (three buttons, "Approve This
Draft", "Delete", "Publish", each posting its click to the log; "Approve This Draft" on a second variant of the page
also redirects to `/admin/`); `/admin/` (posts the arrival to the log); `/other` (a text input). Added assertions: the
proposal card shows four rows; the "Approve This Draft" click runs with no card and the log holds one approve; "Delete"
and "Publish" are refused before the click with the fourth row named and the log holds no delete and no publish; the
"Open admin" click is allowed, the arrival at `/admin/` is blocked with the card, the log shows the arrival and the
run makes no survey, step or tool there; the anchor to `/admin/` is refused up front; on the redirecting variant the
approve lands in the log and the arrival is blocked. Red-team properties for the finder's file: a button renamed by
script between the model's survey and the click is judged on the name at the click; a `type` into `/user/approvals`
is refused by no row and so asks; a click on "Approve This Draft" on `/user/approvals/../other` resolves to the
normalised URL before the rows see it. Still nothing built; same place in the order as the paragraph above.

## Open questions

- **Measuring breadth.** A proposal, not decided: run a proposed policy over a corpus and show what it changes, namely
  every call in the run log, from all sessions, that today asks or is refused, plus calls generated from each consumer's
  descriptions (for a shell, one per effect class of each installed manifest). "Would have allowed 14 past calls
  without asking, 2 of them writes" is evidence about reach, not only about this run; it is a sample, not a proof, and
  the card says so. The dialect makes it affordable: every evaluation halts and has no effects.
- **A model proposing a broad policy** because a broad one saves it cards: the breadth statement is the defence, which
  argues for it leading the card rather than following the evidence.
- **Which of today's grant stores become policies first**, and which stay as they are (a one-time credentialed fetch is
  consumed on use by design; it may be a built-in "always ask" rather than a policy at all). The first consumer is
  decided above; the order of the rest is not.
- **Where a policy is evaluated when no browser is attached.** The decision lives in the browser's worker first
  ([`SHELL.md`](SHELL.md), "The host's language"); a desktop runtime driven over the hub with no browser needs the
  dialect at the host, and the person's policies with it.
- **A condition no script can check: "reviewed by another agent"** (2026-10-20, same provenance as "A condition about
  the outside world is a pinned script"). Every session posts through the owner's GitHub
  account, so GitHub cannot tell one agent's approval from the author's own, and a marker is text (property 2 above).
  It is no resolved fact today. The answer is a reviewer identity the reviewed agent cannot produce, such as an
  approval signed with the reviewing session's key, in the way the hub acts only on a signature. No recipe yet. A test
  of the merge-when-reviewed case waits for a `gh` program manifest and a host-side fact probe.

Resolved on 2026-10-15 and moved into the text above: `==`/`!=` are refused in the policy realm; the effect vocabularies
are projections of one algebra ([`EFFECTS.md`](EFFECTS.md)).
