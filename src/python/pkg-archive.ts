// pkg-archive.ts — checks a Python wheel's bytes before they are unpacked into the sandbox's site-packages: the zip's structure, the paths it would write, its RECORD, its size and the import names it would take. No `chrome`, no network.

// docs/plan/repl/PACKAGES_INSTALL.md, slice 4, item 5. The bytes are UNTRUSTED: they were checked against the sha256
// the person approved, but their content is whatever the uploader wrote. The zip is read by hand (end record, central
// directory, local header) so that nothing is unpacked, and nothing is trusted, until every entry has passed. Nothing
// here inflates but RECORD, and that one under a bound.

/** Bounds on one wheel and one install call. */
export const ARCHIVE_BOUNDS = {
    /** Declared uncompressed bytes of a wheel over its own byte length. */
    inflation: 8,
    /** Declared uncompressed bytes over all the wheels of one install call. */
    perCall: 512 * 1024 * 1024,
    /** Entries in one archive. */
    entries: 20_000,
    /** Bytes of one entry name. */
    name: 1024,
} as const;

/** A refused wheel: `reason` is the class, `why` a short sentence naming the entry. */
export type ArchiveRefusal = { ok: false; reason: "bad-archive" | "name-collision" | "too-large"; why: string };
/** A wheel that passed: the names it would add to the import path, and its size. */
export type ArchiveOk = { ok: true; topLevel: string[]; modules: string[]; uncompressed: number; files: number };

/** What RECORD may inflate to, whatever it declares. */
const RECORD_MAX = 8 * 1024 * 1024;
/** Import names no wheel may take, whatever the caller's `taken` says. */
const ALWAYS_TAKEN = new Set(["pyodide", "pyodide_js", "js", "micropip", "_pyodide"]);

type Entry = { name: string; dir: boolean; method: number; csize: number; usize: number; offset: number };

const bad = (why: string): ArchiveRefusal => ({ ok: false, reason: "bad-archive", why });

/**
 * PEP 503 normalisation of a project name.
 * @param n the name
 */
function norm(n: string): string {
    return n.replace(/[-_.]+/g, "-").toLowerCase();
}

/**
 * The end record's offset, or -1. Searched from the end over the last 65,557 bytes (22 plus a 65,535-byte comment).
 * @param b the archive
 * @param dv a view of `b`
 */
function findEnd(b: Uint8Array, dv: DataView): number {
    const lo = Math.max(0, b.length - 65557);
    for (let i = b.length - 22; i >= lo; i--) {
        if (dv.getUint32(i, true) === 0x06054b50 && i + 22 + dv.getUint16(i + 20, true) <= b.length) return i;
    }
    return -1;
}

/**
 * Whether an entry name is safe: relative, no backslash or control character, no empty, `.` or `..` segment.
 * @param name the name, a trailing `/` (a directory) allowed
 * @returns the problem, or null
 */
function nameProblem(name: string): string | null {
    if (name === "") return "an entry has an empty name";
    if (name[0] === "/") return `entry ${JSON.stringify(name)} is an absolute path`;
    if (name.includes("\\")) return `entry ${JSON.stringify(name)} has a backslash`;
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u001f\u007f]/.test(name)) return `entry ${JSON.stringify(name)} has a control character`;
    const segs = (name.endsWith("/") ? name.slice(0, -1) : name).split("/");
    if (segs.some((s) => s === "" || s === "." || s === "..")) return `entry ${JSON.stringify(name)} has an empty, "." or ".." segment`;
    return null;
}

/**
 * Read the central directory into entries, refusing anything that is not a plain, bounded, unencrypted zip.
 * @param b the archive
 */
function readEntries(b: Uint8Array): Entry[] | ArchiveRefusal {
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    const end = findEnd(b, dv);
    if (end < 0) return bad("not a zip archive (no end record)");
    const count = dv.getUint16(end + 10, true);
    const cdSize = dv.getUint32(end + 12, true);
    const cdOff = dv.getUint32(end + 16, true);
    if (count === 0xffff || cdSize === 0xffffffff || cdOff === 0xffffffff || (end >= 20 && dv.getUint32(end - 20, true) === 0x07064b50)) {
        return bad("zip64 archives are not accepted");
    }
    if (dv.getUint16(end + 4, true) !== 0 || dv.getUint16(end + 6, true) !== 0 || dv.getUint16(end + 8, true) !== count) return bad("multi-part zip archives are not accepted");
    if (count > ARCHIVE_BOUNDS.entries) return bad(`the archive has ${count} entries, over ${ARCHIVE_BOUNDS.entries}`);
    if (cdOff + cdSize > end) return bad("the central directory runs past the archive");
    const out: Entry[] = [];
    const dec = new TextDecoder("utf-8", { fatal: true });
    let p = cdOff;
    for (let i = 0; i < count; i++) {
        if (p + 46 > cdOff + cdSize || dv.getUint32(p, true) !== 0x02014b50) return bad(`central directory entry ${i} is malformed`);
        const made = dv.getUint16(p + 4, true);
        const flags = dv.getUint16(p + 8, true);
        const method = dv.getUint16(p + 10, true);
        const csize = dv.getUint32(p + 20, true);
        const usize = dv.getUint32(p + 24, true);
        const nameLen = dv.getUint16(p + 28, true);
        const extra = dv.getUint16(p + 30, true);
        const comment = dv.getUint16(p + 32, true);
        const ext = dv.getUint32(p + 38, true);
        const offset = dv.getUint32(p + 42, true);
        if (nameLen > ARCHIVE_BOUNDS.name) return bad(`central directory entry ${i} has a name of ${nameLen} bytes`);
        if (p + 46 + nameLen + extra + comment > cdOff + cdSize) return bad(`central directory entry ${i} runs past the directory`);
        let name: string;
        try {
            name = dec.decode(b.subarray(p + 46, p + 46 + nameLen));
        } catch {
            return bad(`central directory entry ${i} has a name that is not UTF-8`);
        }
        if (csize === 0xffffffff || usize === 0xffffffff || offset === 0xffffffff) return bad(`entry ${JSON.stringify(name)} needs zip64`);
        if (flags & 0x41) return bad(`entry ${JSON.stringify(name)} is encrypted`);
        if (method !== 0 && method !== 8) return bad(`entry ${JSON.stringify(name)} uses compression method ${method}`);
        if (method === 0 && csize !== usize) return bad(`stored entry ${JSON.stringify(name)} declares two sizes`);
        if (made >>> 8 === 3) {
            const type = (ext >>> 16) & 0o170000;
            if (type !== 0 && type !== 0o100000 && type !== 0o040000) return bad(`entry ${JSON.stringify(name)} is not a regular file or directory`);
        }
        const dir = name.endsWith("/");
        if (dir && usize !== 0) return bad(`directory entry ${JSON.stringify(name)} has content`);
        if (offset + 30 > cdOff) return bad(`entry ${JSON.stringify(name)} starts past the archive's data`);
        out.push({ name, dir, method, csize, usize, offset });
        p += 46 + nameLen + extra + comment;
    }
    return out;
}

/**
 * Inflate one entry (RECORD) from its local header, under a byte bound.
 * @param b the archive
 * @param e the entry
 * @returns its text, or a refusal
 */
async function readEntry(b: Uint8Array, e: Entry): Promise<string | ArchiveRefusal> {
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    if (dv.getUint32(e.offset, true) !== 0x04034b50) return bad(`entry ${JSON.stringify(e.name)} has no local header`);
    const start = e.offset + 30 + dv.getUint16(e.offset + 26, true) + dv.getUint16(e.offset + 28, true);
    if (start + e.csize > b.length) return bad(`entry ${JSON.stringify(e.name)} runs past the archive`);
    if (e.usize > RECORD_MAX) return { ok: false, reason: "too-large", why: `${e.name} declares ${e.usize} bytes, over ${RECORD_MAX}` };
    const data = b.subarray(start, start + e.csize);
    let bytes: Uint8Array;
    if (e.method === 0) {
        bytes = data;
    } else {
        const ds = new DecompressionStream("deflate-raw");
        const w = ds.writable.getWriter();
        w.write(data as Uint8Array<ArrayBuffer>).catch(() => {});
        w.close().catch(() => {});
        const r = ds.readable.getReader();
        const chunks: Uint8Array[] = [];
        let n = 0;
        try {
            for (;;) {
                const { done, value } = await r.read();
                if (done) break;
                n += value.length;
                if (n > e.usize || n > RECORD_MAX) {
                    await r.cancel().catch(() => {});
                    return { ok: false, reason: "too-large", why: `${e.name} inflates past its declared ${e.usize} bytes` };
                }
                chunks.push(value);
            }
        } catch {
            return bad(`entry ${JSON.stringify(e.name)} is not valid deflate data`);
        }
        bytes = new Uint8Array(n);
        let o = 0;
        for (const c of chunks) {
            bytes.set(c, o);
            o += c.length;
        }
    }
    if (bytes.length !== e.usize) return bad(`entry ${JSON.stringify(e.name)} is not the size it declares`);
    try {
        return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
        return bad(`${e.name} is not UTF-8`);
    }
}

/**
 * The first field of every row of a RECORD, read as CSV with quoted fields.
 * @param text the RECORD
 */
function recordPaths(text: string): string[] {
    const paths: string[] = [];
    let i = 0;
    while (i < text.length) {
        let field = "";
        let first = true;
        let quoted = false;
        for (; i < text.length; i++) {
            const c = text[i];
            if (quoted) {
                if (c === '"') {
                    if (text[i + 1] === '"') {
                        if (first) field += '"';
                        i++;
                    } else quoted = false;
                } else if (first) field += c;
            } else if (c === '"' && field === "" && first) quoted = true;
            else if (c === "," ) first = false;
            else if (c === "\n") break;
            else if (c === "\r") continue;
            else if (first) field += c;
        }
        i++;
        if (field !== "") paths.push(field);
    }
    return paths;
}

/**
 * Check a wheel's bytes before they are unpacked.
 * @param bytes the wheel, already checked against the sha256 the person approved
 * @param filename the wheel's filename (`{name}-{ver}(-{build})?-{py}-{abi}-{plat}.whl`)
 * @param taken import names already provided (stdlib, lock imports, dialect, harness, earlier installs)
 * @param budget when given, the uncompressed bytes of the wheels of this call so far; this wheel's are added to it
 * @returns what the wheel would add to the import path, or the first refusal
 */
export async function checkWheel(bytes: Uint8Array, filename: string, taken: ReadonlySet<string>, budget?: { used: number }): Promise<ArchiveOk | ArchiveRefusal> {
    const entries = readEntries(bytes);
    if (!Array.isArray(entries)) return entries;

    // Names: safe, unique, and none a symlink-free, hook-free layout would refuse.
    const seen = new Set<string>();
    for (const e of entries) {
        const p = nameProblem(e.name);
        if (p) return bad(p);
        const key = (e.dir ? e.name.slice(0, -1) : e.name).toLowerCase();
        if (seen.has(key)) return bad(`entry ${JSON.stringify(e.name)} is listed twice`);
        seen.add(key);
    }

    // Layout: top-level names, one dist-info, and at most its own `.data` directory.
    const distInfos = new Set<string>();
    const dataDirs = new Set<string>();
    const rootFiles: string[] = [];
    const rootTop = new Set<string>();
    const files: Entry[] = [];
    for (const e of entries) {
        const segs = (e.dir ? e.name.slice(0, -1) : e.name).split("/");
        if (!e.dir) files.push(e);
        if (e.name.toLowerCase().endsWith(".pth")) return bad(`entry ${JSON.stringify(e.name)} is a .pth file`);
        const rel = segs;
        if (segs[0].endsWith(".dist-info")) {
            distInfos.add(segs[0]);
            if (!e.dir && segs.length === 1) return bad(`entry ${JSON.stringify(e.name)} is not a file under a dist-info directory`);
            continue;
        }
        // Pyodide's `unpackArchive` leaves `<dist>.data/` as it is in site-packages, purelib and platlib included (measured on
        // fonttools' `.data/data/share/man/man1/ttx.1`): a directory whose name is no identifier, so nothing under it can be
        // imported. It is inert, and takes no import name; only a `.pth` in it is refused, above.
        if (segs[0].endsWith(".data")) { dataDirs.add(segs[0]); continue; }
        if (rel.length === 1 && !e.dir) {
            const m = /^([^.]+)(\..*)?$/.exec(rel[0]);
            if (!m || !/(\.py|\.pyi|\.so)$/.test(rel[0])) return bad(`entry ${JSON.stringify(e.name)} is not a module, a package or under one`);
            rootFiles.push(rel[0]);
            rootTop.add(m[1]);
        } else rootTop.add(rel[0]);
        if (/^(sitecustomize|usercustomize)(\.|$)/i.test(rel[0])) return bad(`entry ${JSON.stringify(e.name)} is a site hook`);
    }
    if (distInfos.size !== 1) return bad(distInfos.size === 0 ? "the wheel has no .dist-info directory" : "the wheel has more than one .dist-info directory");
    const distDir = [...distInfos][0];
    const base = distDir.slice(0, -".dist-info".length);
    const dash = base.lastIndexOf("-");
    const fields = filename.endsWith(".whl") ? filename.slice(0, -4).split("-") : [];
    if (dash <= 0 || fields.length < 5 || fields.length > 6) return bad(`${filename} is not a wheel filename, or ${distDir} is not <name>-<version>.dist-info`);
    const sameVer = (a: string, b2: string) => a.replace(/[-_]/g, "_").toLowerCase() === b2.replace(/[-_]/g, "_").toLowerCase();
    if (norm(base.slice(0, dash)) !== norm(fields[0]) || !sameVer(base.slice(dash + 1), fields[1])) return bad(`${distDir} does not match the filename ${filename}`);
    for (const d of dataDirs) if (d !== `${base}.data`) return bad(`${d} does not belong to ${distDir}`);

    // RECORD lists exactly the files.
    const record = files.find((e) => e.name === `${distDir}/RECORD`);
    if (!record) return bad(`${distDir}/RECORD is missing`);
    const text = await readEntry(bytes, record);
    if (typeof text !== "string") return text;
    const listed = recordPaths(text);
    const listedSet = new Set(listed);
    if (listedSet.size !== listed.length) return bad("RECORD lists a path twice");
    for (const e of files) if (!listedSet.has(e.name)) return bad(`${e.name} is in the archive but not in RECORD`);
    const have = new Set(files.map((e) => e.name));
    for (const p of listed) if (!have.has(p)) return bad(`${p} is in RECORD but not in the archive`);
    for (const e of files) {
        if (e === record) continue;
        const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        if (dv.getUint32(e.offset, true) !== 0x04034b50) return bad(`entry ${JSON.stringify(e.name)} has no local header`);
        if (e.offset + 30 + dv.getUint16(e.offset + 26, true) + dv.getUint16(e.offset + 28, true) + e.csize > bytes.length) return bad(`entry ${JSON.stringify(e.name)} runs past the archive`);
    }

    // Sizes.
    let total = 0;
    for (const e of files) total += e.usize;
    if (total > ARCHIVE_BOUNDS.inflation * bytes.length) return { ok: false, reason: "too-large", why: `the wheel unpacks to ${total} bytes, over ${ARCHIVE_BOUNDS.inflation} times its ${bytes.length}` };
    if (budget) {
        budget.used += total;
        if (budget.used > ARCHIVE_BOUNDS.perCall) return { ok: false, reason: "too-large", why: `this install unpacks to ${budget.used} bytes, over ${ARCHIVE_BOUNDS.perCall}` };
    }

    // Names it would take.
    const topLevel = [...rootTop].sort();
    const takenLower = new Set([...taken].map((t) => t.toLowerCase()));
    for (const n of topLevel) {
        const l = n.toLowerCase();
        if (l.startsWith("_ml_") || ALWAYS_TAKEN.has(l) || taken.has(n) || takenLower.has(l)) {
            return { ok: false, reason: "name-collision", why: `${n} is already provided to the sandbox` };
        }
    }

    // Modules to import: every top-level name an import statement can spell, a namespace package (no __init__.py, as
    // mpl_toolkits is) included; a module file counts by its stem.
    const stubOnly = (n: string) => rootFiles.some((f) => f.split(".")[0] === n) && !rootFiles.some((f) => f.split(".")[0] === n && /\.(py|so)$/.test(f));
    const modules = [...rootTop].filter((n) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(n) && !stubOnly(n)).sort();
    return { ok: true, topLevel, modules, uncompressed: total, files: files.length };
}
