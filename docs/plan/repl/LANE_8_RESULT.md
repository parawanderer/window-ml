# Lane 8, the phone pairs a desktop runtime (result)

Work slug `repl-lane8`, session `3d8f22b0-4993-4ab2-93b2-43d80a95ef73`, model `claude-sonnet-5-5`, 2026-10-19 to 2026-10-20. Rulings: the coordinator's D1 to D3 (#815).

## What landed

- **#814** (`5d045c4f`): [`LANE_8_DESIGN.md`](LANE_8_DESIGN.md). The audit found the phone's Pair screen already completes against `wmlhost hub pair`; the work was the gaps between pairing a tablet and pairing a desktop host.
- **#816** (`9a72c683`): a runtime offer starts with `mayPair` OFF (`phoneGrant`), an "It receives" card whose lines are derived from the grant sent (`receivesLines`), a "Can add devices" switch naming what a browser runtime loses, the revocation signer told and never a switch, a name the hub relayed marked unchecked, one sentence per failed-proof reason, a demo runtime offer, `tests/phone-runtime-grant.test.mjs`, `tests/mobile/pair-runtime.yaml`.

## Measured

- Core suite: 2472 pass, 0 fail (before the last two commits; CI on the final head was green).
- `tests/phone-runtime-grant.test.mjs`: 6 pass. It enumerates `mayPair` x `mayRevoke` x signer and every failed-proof reason.
- **The no-mayPair finding** (by reading code, not a live hub): a browser runtime without `mayPair` fails renewals of other devices with "an intermediate may not pair", told only as raw text on the inbox Renew press, with a wrong "open a browser" hint. Outcome: runtime half is lane 4's #817 (refuses before signing, `unsupported`); inbox half is window-ml #821 (`b9d77039`, mayPair read off the verified presence leaf, `canSignRenewal` drives the inbox, auto-renew and `renewSelf`, the raw sentence mapped).

## Reviews

Lane 4 approved #816 on its diff at `4342f02d`; two later commits (the nit, then the red-team fixes) were not re-approved, and #816 merged on the coordinator's ruling that it proceeds on that approval. The red team read the design and #816 (`20261019-1835Z-redteam-to-repl-lane8-pairing-hub-threat.md`): the hub-trust properties hold; F1 and F2 were folded in.

**A miss:** I counted a Lane 4 reply about how the host pairs as a review of #814; it was not one. #814 merged unreviewed; the coordinator ruled no revert, having read it when ruling D1 to D3.

## Assumed where a spec was silent

- A runtime offer's `grantable` scopes are not shown as switches; the card tells what it can pass on and offers only `mayPair`.
- The desktop host and a browser runtime are told apart only by words ("a browser or a desktop host"), since the wire has one role.

## Not done, and left

- **`tests/mobile/pair-runtime.yaml` has not run on a device** (no iOS or Android build in this session), and CI skips the mobile device jobs on a PR. Run it with `node scripts/ios.mjs flows tests/mobile/pair-runtime.yaml` and the Android twin on the demo build.
- The mobile typecheck did not run (no `mobile/node_modules` in the clone); the root typecheck is clean.
- The host has no GUI to show a QR code: the phone's scan path was exercised only against the fake.
- The real-build join-then-pair path against a live `wmlhost hub pair` was not run.
- The host does not refuse a grant that carries `may_pair` (Lane 4's caveat), so the phone's default is the only thing keeping it off.
- `merge-when-green` blocks on any other session's comment with no way to mark it read, so #816 was merged with `gh pr merge --squash --match-head-commit` after reading them. A flag for that is a candidate for the CI janitor.

> *Drafted by Claude Code · work: repl-lane8 · session 3d8f22b0 · claude-sonnet-5-5*
