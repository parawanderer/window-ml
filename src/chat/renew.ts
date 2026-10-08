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

/** What came of it, in the words a surface can show without rewording a failure it does not understand. */
export type RenewOutcome =
    | { ok: true; notAfterMs: number; installed: boolean }
    | { ok: false; problem: string };

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
    const online = runtimes.filter((rt) => rt.online);
    if (!online.length) return { ok: false, problem: "None of your browsers is connected right now. Open one and try again." };
    let first = "";
    for (const rt of online) {
        const r = await host.send({ type: "device.renew", runtime: rt.id, principal });
        if (!r.ok) { first ||= r.error.message; continue; }
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
