# Lane 8: the phone's UX for pairing a desktop runtime (Sonnet)

Read first: [`ROUND_3.md`](ROUND_3.md); `docs/spec/RUNTIME_HUB.md` ("Principals are keys": pairing in person, a QR code
or a short code shown on the runtime, confirmed on the phone; scopes per pairing); [`LANE_4_RESULT_HUB.md`](LANE_4_RESULT_HUB.md)
(what the hub side built, and the line "pairing works from the CLI only"); `mobile/AGENTS.md`; `docs/dev/hub-client.md`;
`docs/dev/chat-page.md`. The `phone` skill runs the app on a simulator or a device.

## The goal

Today a desktop runtime is paired from the CLI. This lane gives the phone the flow: show or scan the code, confirm
the runtime's identity, choose its scopes, and see it in the runtime list, with the same flow on Android and iOS.

## The invariants you must not bend

- **WHO THE ROOT IS: a phone in a pocket, never a runtime.** `scripts/hub-root.mjs` is a test tool, NOT the design;
  `extension-pairing.ts` refuses `createAccount`. The phone is the root that pairs; the runtime is paired.
- **A hub is trusted with nothing**: act on the signature inside the seal, never `Envelope.sender`. The pairing UI
  shows what the runtime proved, never what the hub relayed.
- **One design language**: the phone app and the chat page's calm view are one product (`mobile/AGENTS.md`).
- **Nothing about a session on a lock screen**; only a certificate's durable fields reach a notification.

## Deliverables, in order

1. **A design note first**, `LANE_8_DESIGN.md` next to this file, one page: the screens, which code shape (QR or
   short code) in which direction, where scopes are chosen, what the phone shows when the runtime's proof fails. Mail
   `repl-specs` when it is pushed and continue; the coordinator reads it the same hour. A flow choice that changes
   what a paired runtime may do is Shane's.
2. **The flow**, with a Maestro test that runs on both platforms (the `phone` skill).
3. **The runtime list** shows the new pairing with its scopes.

## Not this lane

No change to `src/hub/` or the hub's wire; if pairing needs something the hub does not give, that is a
`@hub-compat` finding: mail the coordinator with what is missing, do not build around it.

## Who reviews

Lane 4 (it built the hub result); the red team reads the design note for what a compromised hub could make the phone show.
