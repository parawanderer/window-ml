# Lane 9: tell a run why its next call asks (Sonnet)

Read first: [`ROUND_3.md`](ROUND_3.md); `docs/spec/POLICIES.md`, the scope table (the `run` row: "an unarchived or
resumed session is TOLD, person and model, that its run policies were removed at archive time"); `docs/dev/policies.md`;
[`LANE_2_RESULT_3.md`](LANE_2_RESULT_3.md) and [`LANE_2_POLICIES.md`](LANE_2_POLICIES.md) (the policy store and the
archive rule, #707); `docs/dev/run-log.md`; `docs/dev/output-and-code.md`.

## The goal

A call that ran without asking yesterday asks today because the policy that allowed it is gone: removed at archive
(#707), removed by the person, or narrowed. Today the ask carries no reason, so the model retries or rephrases and the
person sees a card they thought they had answered. The spec already decides the behaviour: the run is TOLD, person and
model. This lane builds the telling.

## Deliverables

1. **The ask knows its cause.** When `judgeCall` asks for a call a now-absent policy would have allowed, the ask
   carries which policy and why it is gone (archive, removed, narrowed, expired). Measure: a test per cause in the
   policy vectors; the decision stays the same, only the reason is new.
2. **The person sees it** on the approval card, one line, through the panel's tooltip for the detail (never `title`).
3. **The model sees it** in the tool result, one sentence, and the run log records it (`recordRunLog`, lowercase
   `subsystem`/`kind` or it is silently dropped). The export carries what the model saw (AGENTS.md, "Showing a run").
4. **On unarchive or resume**, the session is told once, up front, that its run policies were removed, as the spec
   says; the first ask afterwards says so again with its cause.

## The rules that bite here

- **Narrow beats wide**: a reason never re-allows. The cause is text on the ask, not an input to the decision.
- **Sender, never message**: nothing in a call's payload may name a policy to claim it.
- **State registry**: anything kept across calls to remember a removed policy is declared with `defineState`.
- Lane 7 is in the card and the run log too; message it before editing either, and whoever is second rebases.

## Not this lane

No change to what a policy allows, no new scope, no policy UI beyond the one line. Lane 2's session is closed: the
policy store's owner is now the coordinator for rulings and the generalist for code questions.

## Who reviews

Lane 4 (approval cards, nested asks); the red team for item 1's test if it is security-shaped.
