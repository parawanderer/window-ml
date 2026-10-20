# Lane 9: tell a run why its next call asks (result)

Work slug `repl-lane9`, session `1708dc48-f3e2-4f25-9541-2694868e350f`, model `claude-sonnet-5-5`, 2026-10-19 to 2026-10-20. PR #818, merged as `60d0c704`.

## What was built

- The store (`src/sw/sw-policies.ts`) keeps an allowing policy that is removed, edited (`narrowed`) or archived, source included (`ml_policies_lapsed`, state `policies.lapsed`, 20 per key). `judgeCall` returns `lapsed` only when its decision is `undefined` and a gone policy would have allowed the call. The decision never changes, a live allow wins over a gone one, and a removed deny is not kept.
- The approval card (sidebar and HUD) shows one line, `AskWhyLine`, with the model's sentence as the panel tooltip. The sentence is appended to the tool result, so the export's `result` carries what the model read. A nested `sh` ask carries it as `StepAsk.why` and in its refusal text. `policy`/`lapsed` goes to the run log with the cause slug as `reason` and the label in `detail`. `askWhy` is in `export.schema.json`.
- A session resumed after an archive is told once, before its first model call, by a SYSTEM message marked as the extension's. The record is marked `told` in storage; the resume note's `dropped` and `ml.current.policiesRemoved` are unchanged.
- How it works: `docs/dev/policies.md`, "Why a call asks". The spec's "not built" note in `POLICIES.md` is replaced.

## What was measured

- Tests: one per cause in `tests/sw-policies.test.mjs`, loop tests for the card hand-over, the result, the throwing and cancelled gates (`tests/agent-loop.test.mjs`), a run-log round trip through `sanitizeRunReport`. Full `npm test`: 0 hard failures on the first run; the second local run showed 12 failures in files this lane did not touch (`readonly-*`, `isolated-pointer`, a 5 s budget check), all timing or load shaped, and CI on the merged head was green.
- Not run: e2e locally (CI ran it), the phone app, a real model.

## Red-team pass (a separate agent, tests only: `tests/lapsed-ask-redteam.test.mjs`, 23 tests, in the `redteam` genre)

17 held at once. Six failed first, and each was fixed before the merge:

1. A page's own `ML_DEBUG_EVENT` or `ML_SESSION_EVENT` could carry `askWhy` or `asks[].why` onto its own run's card in the extension's voice. Now stripped (`withoutPageWhy`, `src/event-admission.ts`).
2. A proposal's label refused `"`, CR and LF but took U+2028, U+2029, U+0085, `\v`, `\f`, `\0`. Now refuses control and line-separator characters.
3. The card's "remember" label was the model-written `ml.fetch` URL, unfiltered and uncapped, then quoted inside the worker's sentence. A new `speakable` makes any label one line, with no double quote or control character, at most 200 characters, before it is quoted anywhere (sentence, card line, archive note), and the remembered label is cleaned at its source.
4. A page's resume on a hash with another origin's stored snapshot consumed that session's archive note and received its labels. The note now goes only to a resume the worker built (`p.builtBy`).
5. The person-written label is stored as written; what is said of it is made safe the same way.

## Assumptions where the spec was silent (accepted by repl-specs 2026-10-19, going into `POLICIES.md`)

- `expired` has no producer today: no policy has a lifetime. The type carries it.
- A credentialed `fetch_url` carries no reason: it asks regardless of policy.
- "Told up front" is a message before the first model call of a resumed run; per repl-specs it is the worker's note, not a user-role message.
- An allowed nested `sh` ask shows its reason on the card only: the script reads that result, not the model.

## What is left

- A reason for a page-built run's `fetch_url`: its fetch is not judged in the worker, so there is nothing to explain (`docs/dev/policies.md`, "Not built yet").
- The unified view of lapsed reasons on the policy page (no UI beyond the one line, by the lane's scope).
- The mobile and chat-page surfaces draw no reason line; they read the same step event.
