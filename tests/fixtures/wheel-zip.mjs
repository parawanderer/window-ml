// wheel-zip.mjs — test fixtures: a minimal zip writer, with knobs for lying archives, and a wheel built on it (tests/pkg-archive.test.mjs, tests/python-install.test.mjs).

import { crc32, deflateRawSync } from "node:zlib";

/**
 * @param {Array<{name:string, data?:string|Buffer, method?:number, mode?:number, flags?:number, dir?:boolean, usize?:number, madeBy?:number, crc?:number}>} items
 * @param {{ zip64?: boolean, comment?: string }} [opt]
 */
export function zip(items, opt = {}) {
    const parts = [];
    const cd = [];
    let off = 0;
    for (const it of items) {
        const name = Buffer.from(it.name, "utf8");
        const raw = Buffer.from(it.data ?? "");
        const method = it.method ?? 0;
        const body = method === 8 ? deflateRawSync(raw) : raw;
        const usize = it.usize ?? raw.length;
        // The real CRC-32 unless a test lies: Python's zipfile, which Pyodide's unpackArchive uses, checks it.
        const crc = it.crc ?? crc32(raw);
        const lh = Buffer.alloc(30);
        lh.writeUInt32LE(0x04034b50, 0);
        lh.writeUInt16LE(20, 4);
        lh.writeUInt16LE(it.flags ?? 0, 6);
        lh.writeUInt16LE(method, 8);
        lh.writeUInt32LE(crc >>> 0, 14);
        lh.writeUInt32LE(body.length, 18);
        lh.writeUInt32LE(usize, 22);
        lh.writeUInt16LE(name.length, 26);
        const c = Buffer.alloc(46);
        c.writeUInt32LE(0x02014b50, 0);
        c.writeUInt16LE(it.madeBy ?? 0x031e, 4);
        c.writeUInt16LE(20, 6);
        c.writeUInt16LE(it.flags ?? 0, 8);
        c.writeUInt16LE(method, 10);
        c.writeUInt32LE(crc >>> 0, 16);
        c.writeUInt32LE(body.length, 20);
        c.writeUInt32LE(usize, 24);
        c.writeUInt16LE(name.length, 28);
        const mode = it.mode ?? (it.name.endsWith("/") ? 0o040755 : 0o100644);
        c.writeUInt32LE((mode << 16) >>> 0, 38);
        c.writeUInt32LE(off, 42);
        cd.push(Buffer.concat([c, name]));
        parts.push(lh, name, body);
        off += 30 + name.length + body.length;
    }
    const cdBuf = Buffer.concat(cd);
    const comment = Buffer.from(opt.comment ?? "");
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(opt.zip64 ? 0xffff : items.length, 8);
    end.writeUInt16LE(opt.zip64 ? 0xffff : items.length, 10);
    end.writeUInt32LE(cdBuf.length, 12);
    end.writeUInt32LE(off, 16);
    end.writeUInt16LE(comment.length, 20);
    return new Uint8Array(Buffer.concat([...parts, cdBuf, end, comment]));
}

const csvq = (s) => (/[",]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
/** A wheel for `pkg-1.0`: `files` are [name, content] pairs; RECORD is derived unless given. */
export function wheel(files, { record, extra = [], dist = "pkg-1.0.dist-info", recordMethod = 0 } = {}) {
    const all = [...files, [`${dist}/METADATA`, "Name: pkg\n"], ...extra.map((e) => [e.name, e.data ?? "", e])];
    const names = all.map((f) => f[0]).filter((n) => !n.endsWith("/"));
    const rec = record ?? [...names, `${dist}/RECORD`].map((n) => (n === `${dist}/RECORD` ? `${csvq(n)},,` : `${csvq(n)},sha256=x,1`)).join("\n") + "\n";
    return zip([...all.map(([name, data, o]) => ({ name, data, ...(o ?? {}) })), { name: `${dist}/RECORD`, data: rec, method: recordMethod }]);
}
