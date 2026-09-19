// keyring-view.ts — WHAT THE SCREENS SHOW OF A KEYRING: this principal's membership as a label, a role, a fingerprint
// and what it may do, read off its certificate and its keys. Shared by the extension's adapter (a runtime) and the
// client's (a phone, a desktop app, a web page), so both describe a device the same way.

import { CertificateBody } from "../proto/wmlhub/v1/identity.gen";
import type { Principal } from "../hub/keyring";
import { principalId } from "../hub/keys";
import { pairingFingerprintHex } from "../hub/pairing";
import { Role } from "../hub/wire";
import type { Membership, PairRole } from "./api";

/** The certificate's role, as the screens name it. */
export function roleOf(role: Role | undefined): PairRole {
    return role === Role.ROLE_RUNTIME ? "runtime" : role === Role.ROLE_BOX_CONNECTOR ? "box-connector" : "client";
}

/** Bytes as lower-case hex, the way a principal is written everywhere a person or a list sees one. */
const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");

/**
 * This principal's membership as the account view draws it, or null when it is in no account. `mayPair` is what its
 * certificate (or its root) allows; a surface that does not pair from here overrides it.
 */
export async function membershipOf(me: Principal | null, fallbackLabel: string): Promise<Membership | null> {
    if (!me?.membership) return null;
    const leaf = me.membership.chain[0];
    const body = leaf ? CertificateBody.decode(leaf.body) : null;
    return {
        label: body?.label || fallbackLabel,
        role: roleOf(body?.role),
        hubUrl: me.membership.hubUrl,
        fingerprint: await pairingFingerprintHex(me.identity.publicKey, me.agreement.publicKey),
        root: !!me.root,
        mayPair: !!me.root || !!body?.mayPair,
        principal: hex(await principalId(me.identity.publicKey)),
    };
}
