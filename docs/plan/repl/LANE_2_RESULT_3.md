# Lane 2, PR 3: the policy store, the policy page, and its first consumers (result)

Work slug `repl-lane2`, session `620310d6-e68e-4309-95a9-60fb03bcc73b`, model `claude-opus-5-5`, 2026-10-15.

## What landed

| PR | What |
| --- | --- |
| #699 (`af42be02`) | 3a: `src/sw/sw-policies.ts`, global and run scopes in `chrome.storage.local`; "Approve + remember these URLs" makes RUN policies; `fetch_url` is the first consumer, judged at the gate and again at the worker's fetch; `ml.current.policies`; the resume note's `kept` |
| #706 (`9beb2f48`) | the `sh` consumer for lane 4's `ml.sh`; `judgeCall` returns `"ask"` until storage is read; archiving a session removes its run policies |
| #716 (`fe0a2ce9`) | 3b: the `POLICIES` message (extension pages only), the policy page in DevTools Settings, a card already showing judged again on a policy change, an archive's loss told on resume |
| #723 (`9f7737cd`) | 3c: `propose_policy`: the model asks for a run policy, and only the person's answer on a card the worker built adds it |

How each works: `docs/dev/policies.md`.

## Rulings from `repl-specs` during the work (specs amended to match)

- Remembered URLs are RUN policies only. Before #699 "remember" wrote the tab's consent ledger, which the page's own
  `FETCH_URL` read, so the page could fetch any URL the person remembered for a run.
- The model reads policies through `ml.current.policies`. The resume note is not shown to the model; the docs that said
  so were corrected.
- A worker-built fork inherits run policies; a page-built fork inherits none.
- Archiving removes run policies, and the resumed session says which and when.
- A store not yet read means ASK, free tiers included. The rule lives in `judgeCall`; every consumer judges again at
  its choke point.

## Agreements with other lanes

- Lane 4: nested asks put `askId`, `consumer`, `facts`, `placement` on `PendingApprovalDescriptor`; 3b owns
  `rejudgePending`. After #710 merged first, 3b kept lane 4's looser types, and `rejudgePending` judges only `fetch`
  and `sh`, and only a card whose facts carry `effects`; one without is left to the person (repl-specs, #719). Requiring
  `effects` on the descriptor for those consumers goes to lane 4's `ml.sh` PR.
- Lane 1: `extractGrants` left unchanged; lane 1 edits `tabGrantsForCall`.
- Lane 3: the policy realm's cases are shared dialect vectors (#709).

## Found on the way

- `runFetchConsented(...) ?? fetchConsent...` never reached the tab ledger for a worker-hosted run, because the first
  operand is `false`, not `undefined`, for a run it knows. "Remember" never helped a worker run before #699.
- On a page-built run, "remember" no longer skips the run's later cards: its fetch runs in the page, and skipping would
  mean lending a run policy to the tab. The policy is still stored, and a `deny` still applies.

## propose_policy's red-team pass

A separate agent tried a hostile page and a steered model (`tests/propose-policy-redteam.test.mjs`, 14 tests). In every
attack, no policy was added without the person's approval of the worker's card. It found two holes, both fixed before
the PR:

1. A page-built run handed to the worker in the middle of a turn wrote its page's tool list back at the turn's end
   (`storedP`), so its next turn offered `propose_policy`. Both stored copies now go through `withoutProposals`.
2. The probe hosts that measure breadth were constants, so a policy could exclude them by name and be shown as
   reaching no other site. The probe is now drawn afresh for each proposal, plus loopback. Labels may not hold a double
   quote or a line break, so a label cannot pass for the worker's own sentence.

Then repl-specs pointed out the neighbouring hole (#719): random NAMES under a fixed SHAPE are still excludable, since
the dialect has `startsWith` and `endsWith`. The rule now: **the probe carries no fixed marker.** Random labels of random
length under common public suffixes (`.com`, `.org`, `.net`, `.io`) as well as the reserved ones; a sibling of each
host the proposal matched at every label depth (`a.b.c.d` gives `<random>.b.c.d`, `<random>.c.d`, `<random>.d`, so
`endsWith(".github.io")` is caught with no public suffix list); another path and the other scheme of each matched
URL; loopback and a private address fixed, since reaching them is past any site however a policy is written. The
card's zero-stray line reads "matched none of the N unrelated sites it was tried on", never "reaches no other site".

**Measured breadth is a sample, never a proof**: whatever probe is drawn, a policy can be written to miss it, and the card
says "Measured, not proven". That is the reason the derived-breadth root exists (the typed-node tree, unassigned): for a
policy inside the decidable fragment, which calls it can match is answered exactly rather than sampled.

## What did not work, or was left out

- Telling a run that RELIED on a removed policy, on its next call, why the call now asks (`POLICIES.md`, "A change
  takes effect at once"). The call asks; the reason is not said. Left out of this lane by repl-specs on 2026-10-15
  (#719); the spec keeps it as intended behaviour with a dated "not built" note.
- A page-built run's card is not judged again on a policy change: its fetch runs in the page, so an `allow` cannot
  answer it.
- Breadth is measured over this run's calls and a probe, not DERIVED; that needs the typed-node tree.
- `propose_policy` covers the `fetch` consumer only.
- CI flakes: e2e `detection-surface.spec.mjs:446` (tab visibility) failed once on #706 and the rerun was green.
