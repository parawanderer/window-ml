# Lane 8 design: the phone pairs a desktop runtime

Status: proposal, 2026-10-19. Mail slug `repl-lane8`. Read against [`LANE_8_PHONE_PAIRING.md`](LANE_8_PHONE_PAIRING.md).

## What already exists (audited, not assumed)

The flow is built for a phone that is the account root. `mobile/src/screens/DeviceScreens.tsx` (`PairScreen`) finds an offer by scanned QR (`lookupScanned`, full-fingerprint check) or typed code (`lookupOffer`, 12-char compare by eye), offers the named grants, and confirms; `AccountScreens.tsx` is the other direction (this phone shows a code and QR). `window-ml-host` `wmlhost hub pair` prints a code and fingerprint and asks to be a `Runtime`, so the phone's existing "Pair a device" already completes against it. Maestro: `pair-grant.yaml`, `demo-scan.yaml`, `device-remove.yaml` (demo build), `join.yaml` (real build).

So this lane is not a new flow. It is the gaps between "pairs a browser or a tablet" and "pairs a desktop host".

## Gaps found

1. **The phone hides the runtime half of a grant.** `PairScreen` confirms `{ ...found.grant, scopes }`. For a `runtime` offer `defaultGrant` is `mayPair: true`, `mayRevoke: !signerKnown`, `scopes: []`. The page shows both (`pairing-ui.tsx`: the "Pair other devices" checkbox and the revocation-signer sentences); the phone shows neither, and `Found` drops `signer`. A person scanning a desktop host therefore pairs it as a device that can add devices on its own, and possibly as the account's only revocation signer, without being told.
2. **The scope switches mean something else for a runtime.** For a client, scopes are what it may do to others. For a runtime, `scopes` is what it may pass on, and what a desktop caller needs (`desktop`) is held by the CALLER, not the host. "What it may do" over six switches is the wrong question for a runtime.
3. **Words.** `roleName("runtime")` is "a browser runtime", and the same role is the desktop host. The wire has one `ROLE_RUNTIME` for both.
4. **Proof failure on the phone is one sentence** (`pairingProblem`). It does not say which check failed in terms of what was relayed versus proven.
5. **No Maestro flow covers a runtime offer** (the demo world only has the tablet), and none runs the real-build join-then-pair path.

## Screens and direction

| Step | Screen | Code shape |
| --- | --- | --- |
| Runtime shows | the desktop: `wmlhost hub pair` prints code and fingerprint (CLI today; no GUI) | typed code; a QR where the host prints one (`WMLPAIR:1:<code>:<64 hex>`) |
| Phone finds | `PairScreen`, "Scan its QR code" first, typed code second | QR checks the whole fingerprint; typed needs the eye compare |
| Phone confirms | one card: identity, then what it receives, then Pair | |

Direction is runtime shows, phone scans or types. The phone never shows a code to a runtime: the root is the phone and the runtime is the one paired, so `AccountScreens` Join stays for client devices only.

## What the phone shows for a runtime offer

Order on the card, top to bottom:

- Name and role, with the label marked as the runtime's own word, unverified.
- Fingerprint block (typed) or "Scanned: the QR code named this device's keys, and they match" (QR). Both come from the phone's own computation over the offered keys, never from anything the hub relayed.
- "It receives" replaces "What it may do" for a runtime. Lines, each derived from the grant that will be sent: scopes it can pass on (none by default), "Can add devices without asking here" (`mayPair`, a switch, default as `defaultGrant`), "Will sign removals for this account" or "<signer> signs removals; this one will not" (`mayRevoke`, text only, never a switch: `api.ts` already forbids it as a profile).
- The named profiles stay for clients only.

The runtime list (`DeviceScreens`) already renders scope pills, "Pairs devices" and "Signs revocations" from the certificate the root issued, so the new pairing shows with exactly what was granted. Nothing new is needed there beyond the role word.

## When the runtime's proof fails

The phone shows only what the runtime proved: a QR whose keys do not match the offer under it is `mismatch`; an answer with the wrong principal, agreement key, role or chain is refused by the library and nothing is stored. Screen copy names the cause class and the action (cancel on the desktop, start again, distrust the hub if it repeats), says plainly that nothing was paired, and never prints a hub-relayed label, sender or error text as if it were fact. The `label` is shown only inside a block marked "its own word".

## Decisions that are not mine

- **D1, ruled by the coordinator (#815):** the phone defaults `mayPair` OFF for every runtime offer and shows the switch; its line says a browser runtime without it cannot re-sign certificates. No `@hub-compat` request (D3 dropped). Built in #816.
- **D2: `mayRevoke` to a host.** A host as the sole revocation signer is a poor fit (a laptop that sleeps). Proposed: unchanged rule (first runtime signs), but the new sentence makes it visible.
- **D3 (`@hub-compat`, not built here): a host-specific role or offer flag** for D1. Out of lane; mailed to `repl-specs` with this note.

## Tests and delivery

- Node test: a runtime `Found` carries `signer`, `mayPair`, `mayRevoke` through `pairing-bridge.ts` and the confirmed grant equals what the card showed (enumerate runtime x signer known/unknown x grantable null/limited, not a sample).
- Maestro `tests/mobile/<pair-runtime>.yaml` on Android and iOS against a demo-world runtime offer (added to the fake host): asserts the "It receives" lines, toggles "Can add devices", pairs, and checks the runtime list row carries the matching pills. `device-remove.yaml` stays as the removal path.
- Red-team read: the `label`, `signer` and `fingerprint` strings are rendered as text only; a hostile hub controls the label and `signer`, so the card truncates them and marks them unverified.
- Not touched: `src/hub/`, the wire, `extension-pairing.ts`, notifications.

> *Drafted by Claude Code · work: repl-lane8 · session 3d8f22b0 · claude-sonnet-5-5*
