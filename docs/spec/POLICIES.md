# Spec (WIP): policies, or "decide this without asking me"

**Status: draft, nothing built.** The general mechanism behind every "run this without asking" in the extension. Moved
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
| Pages where a run's approvals are skipped, and the Sheets grant | `pageApprovalDomains` in `src/contract/contract-config.ts`, `SheetsGrant` in `src/sidebar/settings/settings.tsx` | a domain list; a spreadsheet source |
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

## A policy is a function over the call

**A policy is a function over one call, evaluated by the read-only dialect** (Shane, 2026-10-13). The person can say
"anything matching this runs without asking", globally or for one run, and say it as code over the call's resolved
facts, not as a pattern over text.

```js
// Global, set by the person: read-only git anywhere in my roots, except the flags that write or run code.
(c) => c.argv[0] === "git" && ["status", "diff", "log", "show", "blame"].includes(c.argv[1])
    && !c.argv.some((a) => /^--(output|ext-diff|exec|upload-pack)/.test(a))
    && c.paths.every((p) => p.inRoot)

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
- A regex is unanchored unless it says otherwise: `/git/.test(c.program)` matches `/tmp/notgit`. Anchor it, or compare
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

- A policy answers `allow`, `deny`, or nothing. `deny` wins over `allow` across policies; nothing means the tiers above
  decide. **"Always reject" is a policy like any other** (Shane, 2026-10-13): a call it matches is refused without a
  card, and the model is told which policy refused it, so it can stop trying rather than rephrase.
- It changes only **whether the person is asked**, never what is enforced: whatever bounds the call (for a shell call
  the container, the OS sandbox and the workspace roots) bounds it whatever a policy says.
- It never reaches the refused tier: a call from a page, or one made from the page's world, is refused before any policy
  runs.

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
call on the plain host, where nothing is bounded, that reduces to `(c) => c.effects.every((e) => e.op === "read" &&
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
| run | the person: at the start, or from an approval card ("calls like this, for this run") | with the session, keyed by its hash: it **survives a resume**, and a fork the WORKER builds inherits it (decided 2026-10-13, narrowed 2026-10-15: today's fork is page-side and arrives as a plain start the worker cannot tell from a new run, and a page naming a parent to inherit its grants would be an escalation route, so a page-built fork inherits NOTHING); listed with each session until removed, and removed when the session is archived |

The model may PROPOSE a run policy, which reaches the person as an approval like any other; it never adds one itself, and
a page never can. A policy reached over the hub is set by a principal holding `approve`.

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
  person (or was refused) because the policy that covered it was removed, not that the call itself changed.
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

**Code first, a tree later, and only as an option** (Shane, 2026-10-15). Policies are code in the read-only dialect, since
a code policy is dynamic and covers more than a tree can. If a typed-node tree turns out to cover enough of what people
write, it becomes the default, and code policies move behind a DevTools Settings toggle ("allow read-only exec
policies"), off by default. The two answer different questions: a call is always decidable for a code policy (it halts),
but WHICH calls it allows cannot be read off the code, since that is a question over every possible input, with regexes
and string operations inside. A tree small enough to analyse can answer it; code cannot, so the breadth shown for a code
policy is measured, never derived.

**Every allowed call says which policy allowed it**, in the run log and on the call's row, and a run's policies are
readable by the model without approval, since reading what you may do is not an escalation. Where that lands
(2026-10-15): the run's policies are declared in the state registry with audience `model` and reach the model as
`ml.current.policies`; the resume divider the PERSON sees names the policies a resumed session carried. (The
`session-resumed` event's text never reaches the model, whatever two older docs said; lane 2 of the plan found and
fixed the claim.) An agent that can see its
own grants stops asking for what it already has, and can say which grant it relies on.

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

Resolved on 2026-10-15 and moved into the text above: `==`/`!=` are refused in the policy realm; the effect vocabularies
are projections of one algebra ([`EFFECTS.md`](EFFECTS.md)).
