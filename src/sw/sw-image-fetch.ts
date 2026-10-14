// sw-image-fetch.ts — FETCH_IMAGE_B64: the worker's read of a public image's bytes for a page, without the person's
// cookies, from a public host only, and only when the bytes are an image.
//
// A page cannot read a cross-origin image's pixels itself (a canvas taints), so `ml._imageToDataUrl` asks the worker,
// whose host permissions bypass CORS. That makes it a "read this URL" primitive at the extension's origin, open to any
// approved page, and it was AS THE PERSON: a service worker's fetch in the default credentials mode carries the cookies
// of every host the extension may reach. What bounds it now, each held here and tested in
// tests/redteam-image-fetch.test.mjs:
//   - no cookies (`credentials: "omit"`), no referrer, and no HTTP cache, which the worker shares with its credentialed
//     fetches (FETCH_URL with credentials, FETCH_SHEET);
//   - a public host, named: no loopback, private, link-local, CGNAT/tailnet, single-label or LAN-suffix name, before the
//     request and again for the URL a redirect ended on;
//   - the bytes are a raster image (`imageMime`), and the content type does not say otherwise;
//   - a size cap, applied while reading;
//   - one failure text for everything after the request was made, so the answer says nothing about the server's status.
// A run the WORKER built never sends this: its `_imageToDataUrl` takes only data URLs (worker-ml.ts) and its answer media
// are crops of its own capture (worker-media.ts).

import { readCapped, imageMime } from "./body-read";

/** The most bytes an image read keeps; a longer body is refused, not cut (a prefix of an image is not an image). */
export const IMAGE_FETCH_MAX = 16_000_000;
/** The answer when the URL itself names a host the read never contacts: decided from the URL, so it says nothing new. */
export const IMAGE_REFUSED = "Refused: an image is read only from a public http(s) address.";
/** The ONE answer to every failure after the request was made (status, network error, not an image, too large,
 *  a redirect to a private address), so a page cannot tell a 401 from a 404 from a network error. */
export const IMAGE_FAILED = "Could not read that URL as an image.";

// Name suffixes that only ever resolve on a local network: mDNS, the reserved home and internal zones, and loopback.
const LOCAL_SUFFIXES = ["localhost", "local", "internal", "lan", "home.arpa"];

/** Is this IPv4 address one a public image is never served from: unspecified, private, loopback, CGNAT (a Tailscale
 *  tailnet is 100.64/10), link-local (the cloud metadata address), benchmarking, multicast or reserved? */
function isPrivateV4([a, b]: number[]): boolean {
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254)
        || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 198 && (b === 18 || b === 19)) || a >= 224;
}

/** The same for IPv6, as the URL parser canonicalises it (lower case, compressed, an embedded IPv4 in hex). */
function isPrivateV6(h: string): boolean {
    if (h === "::" || h === "::1") return true;
    // IPv4-mapped (::ffff:a.b.c.d), IPv4-compatible (::a.b.c.d) and NAT64 (64:ff9b::a.b.c.d): judge the IPv4 inside.
    const embedded = h.match(/^(?:::ffff:|::|64:ff9b::)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (embedded) {
        const hi = parseInt(embedded[1], 16), lo = parseInt(embedded[2], 16);
        return isPrivateV4([hi >> 8, hi & 255, lo >> 8, lo & 255]);
    }
    const first = parseInt(h.split(":")[0] || "0", 16);
    return (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80 || (first & 0xffc0) === 0xfec0 || (first & 0xff00) === 0xff00;
}

/** Does this URL name a host an image read must never contact: a non-http(s) scheme, an unparseable URL, a loopback,
 *  private, link-local, CGNAT or multicast address, or a name that resolves only locally (single-label, `.local`,
 *  `.internal`, `.lan`, `.home.arpa`, `localhost`)? Judged on the NAME: a public name that resolves to a private address
 *  is not caught, since a worker cannot resolve DNS. */
export function isBlockedFetchTarget(rawUrl: string): boolean {
    let u: URL;
    try { u = new URL(rawUrl); } catch { return true; }
    if (u.protocol !== "http:" && u.protocol !== "https:") return true;
    const h = u.hostname.toLowerCase();
    if (h.startsWith("[")) return isPrivateV6(h.slice(1, -1));
    const v4 = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (v4) return isPrivateV4(v4.slice(1).map(Number));
    const name = h.replace(/\.$/, "");
    if (!name.includes(".")) return true;   // a single label: a LAN, docker or tailnet (MagicDNS) name
    return LOCAL_SUFFIXES.some((s) => name === s || name.endsWith("." + s));
}

/** May a response with this content type be an image? `image/*` except SVG (XML text, which a vision model does not
 *  take), or the generic types static hosts send for an unlabelled file. The BYTES decide; this only refuses a body
 *  whose server says it is something else. */
function imageContentType(ct: string): boolean {
    const t = ct.split(";")[0].trim().toLowerCase();
    if (t === "" || t === "application/octet-stream" || t === "binary/octet-stream") return true;
    return t.startsWith("image/") && t !== "image/svg+xml";
}

/** Base64 of bytes, in chunks a multiple of 3 long so each chunk's encoding joins without padding in the middle. */
function toBase64(bytes: Uint8Array): string {
    const CHUNK = 3 * 8192;
    let out = "";
    for (let i = 0; i < bytes.length; i += CHUNK) {
        const part = bytes.subarray(i, i + CHUNK);
        let bin = "";
        for (let j = 0; j < part.length; j++) bin += String.fromCharCode(part[j]);
        out += btoa(bin);
    }
    return out;
}

/** Drop a response's body unread, so a refused one is not downloaded on our behalf. */
function discard(res: Response): void {
    try { void res.body?.cancel?.().catch(() => {}); } catch { /* no stream */ }
}

/**
 * Read a public image for a page, as a data URL labelled by its bytes.
 * @param url the URL the page named
 * @returns `{ data: "data:image/<type>;base64,…" }`, or `{ error }`: `IMAGE_REFUSED` for a URL never contacted,
 *   `IMAGE_FAILED` for every failure after the request was made
 */
export async function fetchImageDataUrl(url: string): Promise<{ data: string } | { error: string }> {
    if (isBlockedFetchTarget(url)) return { error: IMAGE_REFUSED };
    try {
        const res = await fetch(url, { credentials: "omit", referrerPolicy: "no-referrer", cache: "no-store", redirect: "follow" });
        // A redirect is followed by the browser, which reads no hop's Location for us (`manual` answers an opaque
        // response): the hops before the last were requested, but nothing of theirs is read, and the last is judged here.
        if (!res.ok || (res.url && isBlockedFetchTarget(res.url))) { discard(res); return { error: IMAGE_FAILED }; }
        const header = (name: string) => String(res.headers?.get?.(name) ?? "");
        const declared = Number(header("content-length"));
        if (!imageContentType(header("content-type")) || declared > IMAGE_FETCH_MAX) { discard(res); return { error: IMAGE_FAILED }; }
        const { bytes, truncated } = await readCapped(res, IMAGE_FETCH_MAX);
        const mime = truncated ? null : imageMime(bytes);
        return mime ? { data: `data:${mime};base64,${toBase64(bytes)}` } : { error: IMAGE_FAILED };
    } catch {
        return { error: IMAGE_FAILED };
    }
}
