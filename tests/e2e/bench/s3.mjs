// s3.mjs — the few S3 calls the bench's data store needs (put, get, list), signed with AWS Signature V4 and addressed
// path-style, as Garage on mlbox serves them (mlbox reports/ui-api/bench-data-store-answer.md). Node's own crypto and
// fetch: no SDK for three calls.

import { createHash, createHmac } from "node:crypto";

const sha256 = (data) => createHash("sha256").update(data).digest("hex");
const hmac = (key, data) => createHmac("sha256", key).update(data).digest();

/** RFC 3986 encoding as SigV4 wants it: everything but unreserved characters, and `/` kept in a path. */
const encode = (s, keepSlash = false) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
    .replace(keepSlash ? /%2F/g : /$^/, "/");

/**
 * The SigV4 `Authorization` header for one request. Pure, so it is checked against AWS's published example.
 * @param {{ method: string, host: string, path: string, query?: Record<string, string>, headers?: Record<string, string>,
 *   payloadHash: string, amzDate: string, region: string, keyId: string, secret: string }} r
 */
export function signV4({ method, host, path, query = {}, headers = {}, payloadHash, amzDate, region, keyId, secret }) {
    const date = amzDate.slice(0, 8);
    const all = { ...Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v).trim()])), host, "x-amz-content-sha256": payloadHash, "x-amz-date": amzDate };
    const names = Object.keys(all).sort();
    const canonical = [
        method,
        encode(path, true),
        Object.keys(query).sort().map((k) => `${encode(k)}=${encode(query[k])}`).join("&"),
        names.map((n) => `${n}:${all[n]}\n`).join(""),
        names.join(";"),
        payloadHash,
    ].join("\n");
    const scope = `${date}/${region}/s3/aws4_request`;
    const toSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256(canonical)].join("\n");
    const key = ["s3", "aws4_request"].reduce((k, part) => hmac(k, part), hmac(hmac(`AWS4${secret}`, date), region));
    const signature = createHmac("sha256", key).update(toSign).digest("hex");
    return { authorization: `AWS4-HMAC-SHA256 Credential=${keyId}/${scope}, SignedHeaders=${names.join(";")}, Signature=${signature}`, signedHeaders: all };
}

/**
 * A client for one bucket. `endpoint` is the store's base URL (`https://host:3900`); objects are at
 * `<endpoint>/<bucket>/<key>`.
 * @param {{ endpoint: string, bucket: string, keyId: string, secret: string, region?: string, fetchImpl?: typeof fetch }} cfg
 */
export function s3Client({ endpoint, bucket, keyId, secret, region = "garage", fetchImpl = fetch }) {
    const base = new URL(endpoint);
    const request = async (method, key, { query = {}, body = null, headers = {} } = {}) => {
        const path = `/${bucket}${key ? `/${key}` : ""}`;
        const payload = body == null ? "" : body;
        const payloadHash = sha256(payload);
        const amzDate = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
        const { authorization, signedHeaders } = signV4({ method, host: base.host, path, query, headers, payloadHash, amzDate, region, keyId, secret });
        const qs = Object.keys(query).sort().map((k) => `${encode(k)}=${encode(query[k])}`).join("&");
        const { host: _host, ...sendHeaders } = signedHeaders;
        const res = await fetchImpl(`${base.origin}${encode(path, true)}${qs ? `?${qs}` : ""}`, {
            method, headers: { ...sendHeaders, authorization }, ...(body == null ? {} : { body: payload }),
        });
        return res;
    };
    const fail = async (what, res) => { throw new Error(`${what}: HTTP ${res.status} ${(await res.text().catch(() => "")).slice(0, 200)}`); };
    return {
        /** Store `body` (a Buffer or string) at `key`; replaces what is there. */
        async put(key, body, contentType = "application/octet-stream") {
            const res = await request("PUT", key, { body, headers: { "content-type": contentType } });
            if (!res.ok) await fail(`put ${key}`, res);
        },
        /** The object at `key` as a Buffer, or null when there is none. */
        async get(key) {
            const res = await request("GET", key);
            if (res.status === 404) return null;
            if (!res.ok) await fail(`get ${key}`, res);
            return Buffer.from(await res.arrayBuffer());
        },
        /** Every object under `prefix` (ListObjectsV2, paged): `{ key, size }`. */
        async list(prefix = "") {
            const out = [];
            let token = null;
            do {
                const res = await request("GET", "", { query: { "list-type": "2", ...(prefix ? { prefix } : {}), ...(token ? { "continuation-token": token } : {}) } });
                if (!res.ok) await fail(`list ${prefix}`, res);
                const xml = await res.text();
                for (const m of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
                    const key = /<Key>([\s\S]*?)<\/Key>/.exec(m[1])?.[1];
                    if (key != null) out.push({ key: unescapeXml(key), size: Number(/<Size>(\d+)<\/Size>/.exec(m[1])?.[1] ?? 0) });
                }
                token = /<IsTruncated>true<\/IsTruncated>/.test(xml) ? unescapeXml(/<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/.exec(xml)?.[1] ?? "") || null : null;
            } while (token);
            return out;
        },
    };
}

const unescapeXml = (s) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&apos;/g, "'").replace(/&amp;/g, "&");
