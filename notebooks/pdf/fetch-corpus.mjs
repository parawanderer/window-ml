// fetch-corpus.mjs — downloads the pinned real-world PDF corpus in corpus.json into the gitignored cache and verifies every hash.

// The files are UNTRUSTED. This script only downloads, hashes and moves bytes: it never opens, parses or executes a PDF.
// Cache: tests/e2e/artifacts/pdf-corpus/<sha256>/doc.pdf (gitignored). Idempotent: an entry already present with the right
// hash is skipped. An entry with `zipMember` is one file inside a remote zip, read with HTTP range requests (no full zip download).
//
// Usage: node notebooks/pdf/fetch-corpus.mjs [--only <id-regex>]

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, existsSync, writeFileSync, renameSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { inflateRawSync } from "node:zlib";

export const MAX_BYTES = 64 * 1024 * 1024;
export const UA = "window-ml-pdf-corpus/1.0 (calibration corpus; contact shane@wander.dev)";
const HERE = dirname(fileURLToPath(import.meta.url));
export const CACHE = resolve(HERE, "../../tests/e2e/artifacts/pdf-corpus");
/** Delay in ms between downloads from hosts that ask for politeness (arXiv asks for about 3 s). */
const delayFor = (host) => (/(^|\.)arxiv\.org$/.test(host) ? 3000 : /(^|\.)archive\.org$/.test(host) ? 1500 : 0);

/** Sleeps for `ms` milliseconds. */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Hex sha256 of a buffer. */
export const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

/** Fetches `url` (optionally a byte range) and returns the body as a Buffer, refusing more than `limit` bytes. */
export async function getBytes(url, { range, limit = MAX_BYTES } = {}) {
    const headers = { "User-Agent": UA };
    if (range) headers.Range = range;
    const res = await fetch(url, { headers, redirect: "follow" });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    const declared = Number(res.headers.get("content-length") ?? 0);
    if (declared > limit) throw new Error(`refusing ${declared} bytes (limit ${limit})`);
    const chunks = [];
    let n = 0;
    for await (const c of res.body) {
        n += c.length;
        if (n > limit) throw new Error(`refusing: body exceeds ${limit} bytes`);
        chunks.push(c);
    }
    return Buffer.concat(chunks);
}

/** Reads a zip's central directory over HTTP range requests; returns [{name, method, csize, usize, offset}]. */
export async function listRemoteZip(url) {
    const tail = await getBytes(url, { range: "bytes=-131072", limit: 200000 });
    let e = tail.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    if (e < 0) throw new Error("no end-of-central-directory record");
    let count = tail.readUInt16LE(e + 10), cdSize = tail.readUInt32LE(e + 12), cdOff = tail.readUInt32LE(e + 16);
    if (cdOff === 0xffffffff || cdSize === 0xffffffff || count === 0xffff) {
        const l = tail.lastIndexOf(Buffer.from([0x50, 0x4b, 0x06, 0x07]));
        if (l < 0) throw new Error("zip64 locator missing");
        const z64 = Number(tail.readBigUInt64LE(l + 8));
        const rec = await getBytes(url, { range: `bytes=${z64}-${z64 + 55}`, limit: 100 });
        count = Number(rec.readBigUInt64LE(32)); cdSize = Number(rec.readBigUInt64LE(40)); cdOff = Number(rec.readBigUInt64LE(48));
    }
    if (cdSize > 32 * 1024 * 1024) throw new Error("central directory too large");
    const cd = await getBytes(url, { range: `bytes=${cdOff}-${cdOff + cdSize - 1}`, limit: cdSize + 10 });
    const out = [];
    let p = 0;
    for (let i = 0; i < count && p + 46 <= cd.length; i++) {
        if (cd.readUInt32LE(p) !== 0x02014b50) throw new Error("bad central directory entry");
        const method = cd.readUInt16LE(p + 10);
        let csize = cd.readUInt32LE(p + 20), usize = cd.readUInt32LE(p + 24), offset = cd.readUInt32LE(p + 42);
        const nl = cd.readUInt16LE(p + 28), xl = cd.readUInt16LE(p + 30), cl = cd.readUInt16LE(p + 32);
        const name = cd.toString("utf8", p + 46, p + 46 + nl);
        if (csize === 0xffffffff || usize === 0xffffffff || offset === 0xffffffff) {
            let q = p + 46 + nl; const end = q + xl;
            while (q + 4 <= end) {
                const id = cd.readUInt16LE(q), sz = cd.readUInt16LE(q + 2);
                if (id === 1) {
                    let r = q + 4;
                    if (usize === 0xffffffff) { usize = Number(cd.readBigUInt64LE(r)); r += 8; }
                    if (csize === 0xffffffff) { csize = Number(cd.readBigUInt64LE(r)); r += 8; }
                    if (offset === 0xffffffff) { offset = Number(cd.readBigUInt64LE(r)); }
                }
                q += 4 + sz;
            }
        }
        out.push({ name, method, csize, usize, offset });
        p += 46 + nl + xl + cl;
    }
    return out;
}

/** Extracts one member of a remote zip into memory (stored or deflate only). */
export async function readRemoteZipMember(url, member) {
    const ent = (await listRemoteZip(url)).find((x) => x.name === member);
    if (!ent) throw new Error(`no member ${member} in ${url}`);
    return readZipEntry(url, ent);
}

/** Reads the data of an already-listed zip entry. */
export async function readZipEntry(url, ent) {
    if (ent.usize > MAX_BYTES || ent.csize > MAX_BYTES) throw new Error(`refusing ${ent.name}: ${ent.usize} bytes`);
    const lh = await getBytes(url, { range: `bytes=${ent.offset}-${ent.offset + 29}`, limit: 100 });
    if (lh.readUInt32LE(0) !== 0x04034b50) throw new Error("bad local header");
    const start = ent.offset + 30 + lh.readUInt16LE(26) + lh.readUInt16LE(28);
    const raw = await getBytes(url, { range: `bytes=${start}-${start + ent.csize - 1}`, limit: ent.csize + 10 });
    if (ent.method === 0) return raw;
    if (ent.method === 8) return inflateRawSync(raw, { maxOutputLength: MAX_BYTES });
    throw new Error(`unsupported zip method ${ent.method}`);
}

/** Downloads one corpus entry's bytes (whole URL, or a zip member). */
export async function download(entry) {
    return entry.zipMember ? readRemoteZipMember(entry.url, entry.zipMember) : getBytes(entry.url);
}

/** Path of the cached copy for a hash. */
export const cachePath = (hash) => join(CACHE, hash, "doc.pdf");

/** Stores verified bytes at the cache path for their own hash, via a new directory and an atomic rename. */
export function store(buf) {
    const hash = sha256(buf);
    const dir = join(CACHE, hash);
    if (!existsSync(join(dir, "doc.pdf"))) {
        mkdirSync(dir, { recursive: true });
        const tmp = join(dir, "doc.pdf.part");
        writeFileSync(tmp, buf);
        renameSync(tmp, join(dir, "doc.pdf"));
    }
    return hash;
}

/** True when the cached file for `entry` exists with the right hash. */
function cached(entry) {
    const p = cachePath(entry.sha256);
    return existsSync(p) && sha256(readFileSync(p)) === entry.sha256;
}

/** Fetches every entry that is not yet cached; returns the number of failures. */
async function main() {
    const onlyIdx = process.argv.indexOf("--only");
    const only = onlyIdx > 0 ? new RegExp(process.argv[onlyIdx + 1]) : null;
    const corpus = JSON.parse(readFileSync(join(HERE, "corpus.json"), "utf8"));
    let ok = 0, got = 0, bad = 0, bytes = 0;
    for (const e of corpus) {
        if (only && !only.test(e.id)) continue;
        if (cached(e)) { ok++; bytes += e.bytes; continue; }
        try {
            const buf = await download(e);
            if (buf.subarray(0, 5).toString("latin1") !== "%PDF-") throw new Error("not a PDF (no %PDF- header)");
            const h = sha256(buf);
            if (h !== e.sha256) throw new Error(`sha256 mismatch: got ${h}, want ${e.sha256}`);
            store(buf);
            got++; bytes += buf.length;
            console.log(`fetched ${e.id} ${buf.length}`);
        } catch (err) {
            bad++;
            console.error(`FAILED ${e.id}: ${err.message}`);
        }
        await sleep(delayFor(new URL(e.url).hostname));
    }
    console.log(`${corpus.length} entries: ${ok} already cached, ${got} fetched, ${bad} failed; ${bytes} bytes verified`);
    return bad;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    process.exitCode = (await main()) ? 1 : 0;
}
