# Design: telling a desktop host from a browser runtime at pairing

Status: proposal, 2026-10-20. Mail slug `repl-lane8`. `@hub-compat`: two PRs, window-ml-hub first, then this repo. Reads against [`RUNTIME_HUB.md`](../../spec/RUNTIME_HUB.md) "Principals and scopes" and [`LANE_8_RESULT.md`](LANE_8_RESULT.md).

## Worth first

After #816 the phone already makes a host safe: `mayPair` starts off for every runtime. What a flag buys is wording and one switch. The card says "a browser or a desktop host" because it cannot know which; for a host the "Can add devices" switch never applies and its hint talks about browser certificate renewal. If the coordinator or the Chat Page session judge that too small, this lane stops at this note.

## The constraint

The flag may never widen what a runtime can do, only what the phone shows. So it must be impossible for it to be read as authority by anyone.

## Options

| | What | Cost | Verdict |
| --- | --- | --- | --- |
| A | a new `Role` value `ROLE_HOST` | the role is in the Hello transcript, hub routing, presence and every reader's enum; older peers see an unknown role | no: it changes what the hub routes and signs for a cosmetic gain |
| B | an optional `PairingOffer.kind` string | schema field plus the connector's `Offer::new`; the hub stores the offer and does not read it, so no relay code | recommended |
| C | `CertificateBody.kind`, issuer-signed | renewal equality (`comparable`), chain vectors, a second implementation to match, `NEVER_DELEGABLE`-style divergence risk | later, only if the device list must show it |

## B in detail

- **Wire.** `string kind = 6;` on `PairingOffer`, open set, same shape rule as a scope name (1 to 16 bytes of `a-z 0-9 . _ -`). Known values: `host`, `browser`. Absent or unknown means today's behaviour exactly. Recorded in `proto/wmlhub/CHANGES.md` (additive) and the vendored pin in this repo bumped.
- **Hub.** No relay change. The offer is opaque to it. `wmlbox`/`wmlhost` pass `kind` into `Offer::new`; `wmlhost hub pair` sends `host`, the extension sends `browser`.
- **Not authenticated, by design.** The fingerprint covers the two keys only, so a hostile hub can edit `kind` as it can edit `label`. The role is already checked at the answer (`wrong-role`); `kind` is not and cannot be. Hence it is never in a certificate, never signed, never a gate.
- **What the phone does with it.** `host`: the card says "a desktop host", the "Can add devices" switch is not shown and the grant is sent with `mayPair` false. `browser`, absent or unknown: unchanged from #816. A hub that lies `host` for a browser runtime hides a switch it would have shown (the browser keeps `mayPair` off and cannot re-sign: a denial, visible in the inbox); a hub that lies `browser` for a host shows a switch whose default is off. Neither widens anything.
- **Name marking.** `kind` is shown only inside the existing "its own word, not checked" line.

## After pairing

The device list reads a certificate, which carries no `kind`, so a host there is still "a browser runtime". Option C fixes that and is not proposed now. A cheap local alternative is for the phone to remember the `kind` it saw, keyed by principal, as display text only; not built unless asked.

## Tests

- Hub: a round-trip of an offer with and without `kind`; a peer that never saw the field ignores it; an over-long or ill-shaped `kind` is refused where the label is.
- Client: enumerate `kind` x (absent, host, browser, unknown, ill-shaped) through `phoneGrant` and the card lines: `mayPair` is never true unless the person turned the switch on, and only for non-`host`. The red team reads the hub side before merge.

## Decisions that are not mine

- Whether C is wanted, and whether the value above justifies B at all.
- The `kind` vocabulary beyond `host` and `browser` (a mobile runtime? a headless one?).

> *Drafted by Claude Code · work: repl-lane8 · session 3d8f22b0 · claude-sonnet-5-5*
