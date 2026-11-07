# Spec (WIP): skills, the scripts a model writes for itself and finds again

**Status: idea, not started (2026-11-07, Shane).** Nothing here is built. It joins four things that each have a
spec or a note already and ties them into one unit; the open questions are at the end.

## The idea

A model that has worked out how a site works should not have to work it out again. Today a task on a site is a
sequence of UI actions, re-derived every run; a site with a public API is driven through its UI all the same. The
proposal is a store the model writes to, holding two kinds of entry:

- **Notes**: what it learned about a site, a context or the person (the memory system of the 2026-10-08 backlog note:
  scoped, inspectable entries).
- **Skills**: scripts with a name, a purpose, prerequisites and a description, written by the model after it learned
  how a site works, kept so a later run can find and reuse them. "Fetch every mail of type X" on a webmail site with
  no public API is one skill; it was scraped from how the page's own requests look.

A skill can name the network inspection surface and a secret handle, and a policy can be written over it, so a skill
the person has approved runs free inside its envelope.

Two kinds of skill exist, and the split is the one the effect algebra already draws:

| Kind | Runs where | Its prerequisites | Example |
| --- | --- | --- | --- |
| **In-page**: depends on the page's state (a logged-in session, the DOM, the page's own `fetch`) | the page's isolated world, on an approved origin, the way an approved `exec` does | "on origin X, signed in" | read the current folder's mail ids from the list the page rendered |
| **Standalone**: works from anywhere with a credential | the worker (an `ml.fetch` with a handle) or the process host (a program with a secret in `env`) | "secret S granted; origin X reachable" | call the site's internal `list` endpoint with the person's token |

## It is mostly built or specified already

Nothing in the proposal needs a new primitive. Each part has a home:

| Part of the idea | Where it already lives | What this spec adds |
| --- | --- | --- |
| a name, a purpose, what it needs | a program manifest ([`PROGRAM_MANIFEST.md`](PROGRAM_MANIFEST.md)): `effects`, `operands`, `echoes`, a pin by `sha256` | a skill IS a program manifest plus a body; nothing new to describe it |
| which functions it may call, at what cost | the library manifest's effect signatures ([`READONLY_LIBRARY_MANIFEST.md`](READONLY_LIBRARY_MANIFEST.md)) | a skill body in the read-only or Python dialect gets its signature DERIVED by the interpreter, never claimed |
| a credential it uses but never reads | a secret handle ([`SECRET_HANDLES.md`](SECRET_HANDLES.md)): the scope is a policy, `use(secret)` exists and `read(secret)` does not | a skill names handles, holds no values; the skill's scope is a subset of the secret's |
| learning how the site's backend works | network inspection (the `ml.network` note: safelisted headers, bodies as shapes by default, egress as the boundary) | the skill records the request shapes it was derived from as its evidence |
| when a skill runs without asking | a policy ([`POLICIES.md`](POLICIES.md)), proposed with evidence, decided by the person | a skill's policy is written over its manifest's facts, as any program's is |
| where the store lives | the state registry (`defineState`, scope and audience; the 2026-10-08 note), or a skills folder on disk ([`AGENT_FILES.md`](AGENT_FILES.md), "an index read up front, the text fetched on demand") | the materialisation is a choice, not a design point; both are index-plus-body |
| the model drafting what it then uses | `propose_policy` and `propose_manifest`: a card with evidence, enforced before believed | a skill is proposed the same way; it runs as `unknown` (asks) until approved |

**Prerequisites are the effect signature's resources.** A skill that reads `dom(origin X)` needs to be on X; one that
names `secret(S)` and `fetch(origin Y)` needs S granted and Y in S's scope. So "look up by domain, prerequisites and
description" is an index over the manifest's resources plus a text field, and the lookup is free: it reads the index,
not the bodies ([`AGENT_FILES.md`](AGENT_FILES.md), "The context budget").

## The security shape

The new risk is not in any part; it is in the loop. A model writes code during a run on a hostile page, the code is
kept, and a later run executes it with a credential. That is a persisted prompt injection with a credential attached,
and the design has to break the loop at a point the page cannot reach.

1. **Writing a skill is proposing, not installing.** A skill the model writes lands as a PROPOSAL in the store, scoped to
   the origin the run was on, running as `unknown` (every call asks) until the person approves its manifest on the one
   page that lists skills. The same rule as a model-drafted program manifest: evidence before trust.
2. **The body is dialect code.** A skill is written in the read-only dialect or the Python dialect, so its effects are
   what the interpreter derives, never what the body claims; a body the dialect refuses is a skill that does not exist.
   Full JavaScript skills are an approved `exec` each time, with no free tier.
3. **A skill never holds a secret.** It names handles; the value is injected at the sink (the worker's fetch, the host's
   spawn), and a skill's scope is checked against the handle's scope at every call. A skill whose destination is outside
   its secret's scope fails closed.
4. **A skill never runs in the main world**, by the rule that already routes `ml.current` and `ml.sh` to an isolated
   world (`execNames` in `exec-routing.ts`). An in-page skill reads the page; the page never reads the skill.
5. **A skill is pinned by its hash.** An edit by the model is a new proposal, and the old approval does not carry.
6. **Scope by origin, as policies are scoped.** A skill written on X is offered on X; it is not offered on Y unless the
   person widens it. Notes follow the same scopes as the memory note proposed: page, origin, context, session, global.
7. **Internal APIs change.** A skill carries the shapes it was derived from (network inspection's schema view) and a
   self-check; a mismatch at run time makes the skill fall back to asking, never to acting on a different shape. A skill
   is also a claim about a site the site did not make: the person decides whether driving a site's private endpoints is
   something they want done in their name, which is what the approval is for.

## What a run does with it

1. The run starts on a site; the index of skills whose prerequisites hold here is offered (names and purposes only).
2. The model calls a skill by name, as it calls a program through `ml.sh`: a typed call, values staying home.
3. An approved skill with a policy runs free inside the envelope; a proposed skill asks per call; a skill whose
   prerequisite fails (no handle, wrong origin) is refused with the missing prerequisite named.
4. When the model works out a site by hand (network inspection, UI actions, a secret the person supplied), it may
   write what it learned as a note or a skill; the write is a proposal the person sees on the skills page, with the
   evidence.

## Not in this spec

- The memory store's own design (the 2026-10-08 backlog note; the state registry is where it goes).
- Network inspection's surface (its own note and its row in [`ASYNC_CALLS.md`](ASYNC_CALLS.md)).
- Reading another tool's skills folder ([`AGENT_FILES.md`](AGENT_FILES.md)).
- A plugin system, or skills as code outside the dialects.

## Open

- Store first in the state registry (works with no process host, inspectable, in the backup) or on disk from the start
  (readable by other tools, needs host mode)? Recommendation: the registry first, with an export to a folder later; a
  folder convention is data under AGENT_FILES either way.
- Does a skill's policy need anything a program's policy does not? The one candidate: a bound on how many calls a
  skill may make per run against a credential, which no program has today.
- How is a standalone skill's secret granted to it: per skill at approval (a skill names S and the approval grants S to
  that skill), or per run as today? The former is narrower and matches "a skill is a program".
- Sharing: a skill one person approved on a site is useful to another; whether skills can be exported with their
  evidence and imported as proposals, never as approved, is a later question.
