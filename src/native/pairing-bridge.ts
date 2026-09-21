// pairing-bridge.ts — PAIRING OVER THE BRIDGE, the page's side: the app's first-run, join, create and device screens are
// native, and the pairing itself stays where the keys are, in the page's `PairingApi` (src/pairing/api.ts). Each
// `pairing` call from the app runs the matching method and answers with plain data; failures are worded by the page's
// own `pairingProblem`, so the phone says what the web page says.
//
// Two things cannot cross as data and stay here, crossing as tokens: a found offer (it carries the library's own
// reference, handed back to `confirmOffer` untouched) and an offer in progress (it holds the promise that settles when
// the other device answers, reported to the app as `pairingDone`).

import { pairingProblem, type FoundOffer, type Grant, type OfferHandle, type PairingApi } from "../pairing/api";
import type { PairingInfo, ToNative, ToWeb } from "./bridge";

/** What the app's screens need to know about this device's pairing, from its `PairingApi`. */
export function pairingInfo(api: PairingApi): PairingInfo {
    return {
        canCreate: api.canCreate !== false,
        joinsAs: api.joinsAs,
        defaultLabel: api.defaultLabel,
        defaultHubUrl: api.defaultHubUrl,
        ...(api.rootKeptIn ? { rootKeptIn: api.rootKeptIn } : {}),
        canScan: !!api.lookupScanned,
        devices: !!api.devices,
    };
}

/** A grant as the app sent it, checked field by field: anything malformed is refused rather than passed to the library. */
function asGrant(v: unknown): Grant {
    const g = v as Partial<Grant> | null;
    if (!g || !Array.isArray(g.scopes) || !g.scopes.every((x) => typeof x === "string")
        || typeof g.mayPair !== "boolean" || typeof g.mayRevoke !== "boolean" || typeof g.validityMs !== "number" || !(g.validityMs > 0)) {
        throw new Error("That grant is not one this page can give.");
    }
    return { scopes: g.scopes, mayPair: g.mayPair, mayRevoke: g.mayRevoke, validityMs: g.validityMs };
}

/** The handler for the app's `pairing` messages, over `api`, answering through `post`. */
export function pairingBridge(api: PairingApi, post: (m: ToNative) => void): (m: Extract<ToWeb, { type: "pairing" }>) => Promise<void> {
    const found = new Map<string, FoundOffer>();
    const offers = new Map<string, OfferHandle>();
    let n = 0;
    const token = (prefix: string) => `${prefix}${++n}`;
    return async (m) => {
        const a = m.args ?? {};
        const str = (k: string) => (typeof a[k] === "string" ? a[k] as string : "");
        const reply = (value?: unknown) => post({ type: "pairingResult", id: m.id, ok: true, ...(value === undefined ? {} : { value }) });
        try {
            switch (m.call) {
                case "load": return reply(await api.load());
                case "createAccount":
                    return reply(await api.createAccount({ hubUrl: str("hubUrl"), label: str("label"), ...(str("invite") ? { invite: str("invite") } : {}) }));
                case "beginOffer": {
                    const h = await api.beginOffer({ hubUrl: str("hubUrl"), label: str("label") });
                    const t = token("o");
                    offers.set(t, h);
                    h.done.then(() => post({ type: "pairingDone", offer: t, ok: true }),
                        (e: unknown) => post({ type: "pairingDone", offer: t, ok: false, error: pairingProblem(e) }))
                        .finally(() => offers.delete(t));
                    return reply({ offer: t, code: h.code, fingerprint: h.fingerprint, qr: h.qr ?? null, expiresAt: h.expiresAt });
                }
                case "cancelOffer": {
                    const t = str("offer");
                    offers.get(t)?.cancel();
                    offers.delete(t);
                    return reply();
                }
                case "lookupOffer":
                case "lookupScanned": {
                    if (m.call === "lookupScanned" && !api.lookupScanned) throw new Error("This device cannot check a scanned code.");
                    const f = m.call === "lookupOffer" ? await api.lookupOffer(str("code")) : await api.lookupScanned!(str("text"));
                    const t = token("f");
                    found.set(t, f);
                    const { ref: _ref, ...plain } = f;
                    return reply({ ...plain, token: t });
                }
                case "confirmOffer": {
                    const f = found.get(str("token"));
                    if (!f) throw new Error("That device is no longer waiting here. Look its code up again.");
                    await api.confirmOffer(f, asGrant(a.grant));
                    found.delete(str("token"));
                    return reply();
                }
                case "devices": return reply(api.devices ? await api.devices() : []);
                case "revoke":
                    if (!api.revoke) throw new Error("This device cannot remove devices.");
                    return reply(await api.revoke(str("principal")));
                case "leave":
                    if (!api.leave) throw new Error("This device cannot leave its account from here.");
                    await api.leave();
                    return reply();
            }
        } catch (e) {
            post({ type: "pairingResult", id: m.id, ok: false, error: pairingProblem(e) });
        }
    };
}
