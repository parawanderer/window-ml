// renew.ts — RENEWING THIS DEVICE'S OWN CERTIFICATE, which is two halves that belong to different things.
//
// Asking belongs to whatever talks to runtimes (`SessionHost.send`); installing belongs to whatever owns the keys
// (`PairingApi.install`, which verifies before it keeps). Neither should learn about the other, so this composes them
// and is the only thing that knows a renewal is both.
//
// Why a device asks for its own: a certificate lives in the keyring of the device it is about and nothing can push one
// there, so the asker has to be the recipient (docs/spec/SESSION_CONTRACT.md, `device.renew`).
import { type PairingApi } from "../pairing/api";
import { certChanged } from "../pairing/pairing-state";
import type { RuntimeInfo, SessionHost } from "../session/session-host";
import { noSignerOnline } from "./attention";

/** What came of it, in the words a surface can show without rewording a failure it does not understand. */
export type RenewOutcome =
    | { ok: true; notAfterMs: number; installed: boolean }
    | { ok: false; problem: string };

/** A runtime that can SIGN a renewal now: online, and not known to have been paired without permission to pair devices.
 *  Absent `mayPair` counts as able (the local host, an older client's list), as every online runtime did before. */
export const canSignRenewal = (rt: RuntimeInfo): boolean => rt.online && rt.mayPair !== false;

/** What the inbox needs to say who can renew this device: the names of the runtimes that may sign one (online or
 *  not), and of the ones online right now that may not. */
export function renewalSigners(runtimes: readonly RuntimeInfo[]): { signers: string[]; cannot: string[] } {
    return {
        signers: runtimes.filter((rt) => rt.mayPair === true).map((rt) => rt.name),
        cannot: runtimes.filter((rt) => rt.online && rt.mayPair === false).map((rt) => rt.name),
    };
}

/** A runtime's refusal because it was paired without permission to pair devices: #817's own (`unsupported`, "…paired
 *  without permission to pair devices…"), or, from a runtime before it, the chain checker's "an intermediate may not
 *  pair" after it had signed. Neither is shown as it is: the older one means nothing to a person, and #817's (as first
 *  merged, "renew it from the root device", which nothing does; reworded at 12639d95) does not say WHICH browser can. */
const NO_PAIR = /an intermediate may not pair|without permission to pair devices/i;

/**
 * Renew this device's certificate through any runtime that will. Tries each online one in turn, because the reasons a
 * particular runtime refuses are about that runtime — it may be too near its own expiry to sign a useful window — and
 * another may simply answer. The first refusal is what gets reported if they all do: later ones say the same thing.
 *
 * `installed: false` is a success with nothing to keep: the runtime found the certificate not yet due and answered with
 * the window it already has. That is the idempotent path, not a failure, and a caller should say nothing about it.
 */
export async function renewSelf(host: SessionHost, pairing: PairingApi, runtimes: readonly RuntimeInfo[], principal: string): Promise<RenewOutcome> {
    if (!pairing.install) return { ok: false, problem: "This device cannot keep a certificate, so it cannot renew one." };
    const online = runtimes.filter(canSignRenewal);
    if (!online.length) {
        const { signers, cannot } = renewalSigners(runtimes);
        if (cannot.length) return { ok: false, problem: noSignerOnline(signers, cannot) };
        return { ok: false, problem: "None of your browsers is connected right now. Open one and try again." };
    }
    let first = "";
    for (const rt of online) {
        const r = await host.send({ type: "device.renew", runtime: rt.id, principal });
        if (!r.ok) {
            first ||= NO_PAIR.test(r.error.message) ? noSignerOnline(renewalSigners(runtimes).signers.filter((n) => n !== rt.name), [rt.name]) : r.error.message;
            continue;
        }
        if (!r.data.chain?.length) return { ok: true, notAfterMs: r.data.notAfterMs, installed: false };
        try {
            await pairing.install(r.data.chain);
            certChanged.value++;
            return { ok: true, notAfterMs: r.data.notAfterMs, installed: true };
        } catch (e) {
            // A chain that does not check out is not another runtime's problem to solve: stop, and say so plainly.
            return { ok: false, problem: (e as Error)?.message || "The certificate it answered with could not be used." };
        }
    }
    return { ok: false, problem: first || "No browser would renew it." };
}
