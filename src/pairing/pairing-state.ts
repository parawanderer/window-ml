// pairing-state.ts — the LIVE pairing state a web surface re-renders from: which step the devices screen opens
// on, and the two bumps that say this device's certificate or its revocation signer has changed underneath.
//
// Split out of `api.ts` because that module is SHARED WITH THE PHONE. The phone takes only pure functions and
// types from it (`groupFour`, `roleName`, `SCOPES`, …) and none of these signals, but a module-scope
// `import { signal } from "@preact/signals"` is not tree-shaken by Metro: it is resolved the moment the file is
// reached, and `mobile/` has no Preact, so the release bundle failed with "Unable to resolve module" while every
// PR stayed green. Keep this file OUT of anything the phone imports — what belongs beside it is state a browser
// renders from, and what belongs in `api.ts` is the data and the words both surfaces share.

import { signal } from "@preact/signals";

/**
 * WHICH STEP THE DEVICES SCREEN SHOULD OPEN ON, set before navigating to it and consumed once.
 *
 * It exists so the inbox's "Refresh pairing" lands on the code rather than on a list: an item that says what to do
 * and then drops somebody one screen short of doing it is the dead-button failure in a politer costume. Null means
 * the screen opens on its own default, which is what every other way in does.
 */
export const devicesStep = signal<"refresh" | null>(null);

/**
 * Bumped whenever this device's certificate has been REPLACED, so whatever is showing its end re-reads at once.
 *
 * Without it the keyring is only re-read on a timer (`CERT_POLL_MS`, an hour), and nothing told the inbox that the
 * thing it was warning about had just been fixed: a successful renewal left the card saying "your access runs out in
 * 5 days" for up to an hour, which reads as a press that did nothing. That was true of the button before anything
 * renewed itself, and silent renewal would have made it the normal case.
 */
export const certChanged = signal(0);

/**
 * WHETHER ANY DEVICE ON THIS ACCOUNT CAN SIGN A REMOVAL, as the hub's own record answers it. Written by the host when
 * a connection's welcome is read (`readRevoker`, already verified against the account root), read by the inbox
 * (`revokerItems`).
 *
 * `"unknown"` is the floor and the default: no record, one that did not verify, or a hub that does not keep one. Only
 * `"none"` is a hub that keeps the record and holds none, and it is the only value anything is allowed to warn on.
 *
 * It SURVIVES A BLIP on purpose. A websocket dropping does not grant anybody the ability to sign a removal, so
 * resetting this on every reconnect would flicker the item for the same reason the runtime list does not empty and
 * refill. `close()` clears it, because leaving the account is the one event that makes it another account's answer.
 */
export const accountRevoker = signal<"unknown" | "signer" | "none">("unknown");
