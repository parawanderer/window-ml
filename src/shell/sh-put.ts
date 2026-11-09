// sh-put.ts — one `ml.sh.put(file, path)` call: what a script passed, checked; the facts a policy and the card are given;
// and the sentences a refusal says.

// docs/spec/FILE_ATTACHMENTS.md ruling 3 (amended 2026-11-08) and SHELL.md's put slice. Pure: no `chrome`, no host. The
// worker (sw-shell-call.ts) carries these to the process host's `put`/`write`/`commit` and back. Where the file lands is
// the host's resolution (`HostPutFacts`), never what the script says about it.

import type { EffectsData } from "../effects";
import type { HostPutFacts } from "./host-protocol";
import type { ShCardLine } from "./sh-call";
import { ShRefused } from "./sh-call";
import { FILE_PREFIX } from "../pointers/token-prefixes";

/** The longest `path` one put may name, in characters: a path, not a payload. */
export const PUT_PATH_MAX = 4096;

/** One `ml.sh.put(file, path)` as checked: the attachment's reference and where the script asked for it. */
export interface ShPutRequest { ref: string; path: string }

/**
 * Check one `ml.sh.put` call's arguments, as the script passed them.
 * @param args `[file, path]`, exactly two
 * @returns the request
 * @throws {ShRefused} `BadRequest`, naming what is wrong
 */
export function parseShPut(args: readonly unknown[]): ShPutRequest {
    const usage = `ml.sh.put takes an attached file's ${FILE_PREFIX} handle and a path in a workspace folder: ml.sh.put("${FILE_PREFIX}3fa91c2", "inbox/report.pdf")`;
    if (args.length !== 2) throw new ShRefused("BadRequest", usage);
    const [ref, path] = args;
    if (typeof ref !== "string" || !ref.startsWith(FILE_PREFIX)) throw new ShRefused("BadRequest", usage);
    if (typeof path !== "string" || path === "") throw new ShRefused("BadRequest", usage);
    if (path.includes("\0")) throw new ShRefused("BadRequest", "ml.sh.put's path contains a NUL");
    if (path.length > PUT_PATH_MAX) throw new ShRefused("BadRequest", `ml.sh.put's path is longer than ${PUT_PATH_MAX} characters`);
    return { ref, path };
}

/** The attachment a put writes, as the card and a policy name it. */
export interface PutFile { name: string; type: string; bytes: number; sha256: string }

/** What a put shows a policy and the card: an sh call that runs nothing (the same keys, so a policy written for
 *  `ml.sh.run` reads them without throwing), with `put` saying what lands where and `effects` the one write. */
export interface PutFacts {
    argv: string[];
    program: { path: string; inRoot: boolean; version: string | null };
    cwd: { path: string; inRoot: boolean };
    env: { set: string[]; free: boolean };
    secrets: string[];
    paths: [];
    repo: null;
    repoConfigRunsCode: null;
    /** A put runs no program, so no manifest describes it: a policy freeing described calls never frees a put. */
    described: false;
    why: string[];
    runner: false;
    mode: "host";
    sandboxed: false;
    placement: "host-sandbox";
    credential: null;
    put: { file: string; type: string; size: number; sha256: string; path: string; root: string; rel: string; exists: boolean; existingSize: number | null;
        tilde: HostPutFacts["tilde"] };
    effects: EffectsData;
}

/**
 * The facts of one put, from the host's resolution. The write is judged as an in-root write under the sandbox's bound
 * (the ruling's "an in-root write today, no new tier"): the host itself holds what that bound holds for a child (the
 * parent's realpath in a root, through a held directory descriptor; protected and secret-looking names refused; never
 * through a link), so a new file below a root's top level is free and one that claims a top-level name asks. Whether
 * an EXISTING file asks is not the bound's to say: the caller always asks then.
 * @param f what `put` answered
 * @param file the attachment
 */
export function putFacts(f: HostPutFacts, file: PutFile): PutFacts {
    return {
        argv: [], program: { path: "", inRoot: false, version: null }, cwd: { path: f.root, inRoot: true }, env: { set: [], free: true }, secrets: [],
        paths: [], repo: null, repoConfigRunsCode: null, described: false, why: [], runner: false, mode: "host", sandboxed: false, placement: "host-sandbox", credential: null,
        put: { file: file.name, type: file.type, size: f.size, sha256: file.sha256, path: f.path, root: f.root, rel: f.rel, exists: f.exists, existingSize: f.existingSize, tilde: f.tilde },
        effects: [{ op: "write", res: { kind: "fs", path: f.path, inRoot: true, exists: f.exists, topLevel: !f.rel.includes("/") } }],
    };
}

/**
 * The card's lines for a put: what is written, where, and a warning when it replaces a file.
 * @param f the put's facts
 */
export function putCardLines(f: PutFacts): ShCardLine[] {
    const p = f.put;
    return [
        { label: "write", value: `${p.file} (${p.size.toLocaleString("en-US")} bytes)` },
        { label: "to", value: p.path },
        ...(p.exists ? [{ label: "replaces", value: `the file there now${p.existingSize !== null ? ` (${p.existingSize.toLocaleString("en-US")} bytes)` : ""}`, warn: true }] : []),
        ...p.tilde.filter((t) => t.index === "path").map((t) => ({ label: "~", value: t.to ? `${t.from} is ${t.to}` : `${t.from} stays literal (${t.reason ?? "no home"})`, warn: !t.to })),
    ];
}

/**
 * A put ask's one-line subject, for an answered ask's line and the export: the file and where it goes. Empty for facts
 * of another shape.
 * @param facts the ask's facts
 */
export function putSubject(facts: unknown): string {
    const p = (facts as Partial<PutFacts> | undefined)?.put;
    return p && typeof p.file === "string" && typeof p.path === "string" ? `${p.file} to ${p.path}` : "";
}

/**
 * What a host refusal of a put says, naming the path: the code word stays in the sentence so a script can match it.
 * @param code the host's error code
 * @param message the host's message
 * @param path the path the script asked for
 */
export function putRefusalText(code: string, message: string, path: string): string {
    const p = JSON.stringify(path);
    switch (code) {
        case "OutsideRoots": return `ml.sh.put: OutsideRoots: ${p} is outside the workspace folders (a "..", a path elsewhere, or a link leading out); nothing was written`;
        case "NoParent": return `ml.sh.put: NoParent: the folder ${p} would go in does not exist, and put never creates one; nothing was written`;
        case "IsSymlink": return `ml.sh.put: IsSymlink: ${p} is a symbolic link, and put never writes through or over one; nothing was written`;
        case "IsDirectory": return `ml.sh.put: IsDirectory: ${p} is a folder; name the file inside it; nothing was written`;
        case "Protected": return `ml.sh.put: Protected: ${p} is a protected name (git hooks and config, shell rc files, agent config) or looks like a credential, which nothing may write; nothing was written`;
        case "Exists": return `ml.sh.put: Exists: a file appeared at ${p} after it was checked; nothing was replaced`;
        default: return `ml.sh.put: ${code}: ${message}`;
    }
}

/**
 * The sentence for a file over the host's cap, naming both numbers.
 * @param size the file's bytes
 * @param max the host's `hello.put.max`
 */
export const putTooLargeText = (size: number, max: number): string =>
    `ml.sh.put: TooLarge: the file is ${size} bytes, and the process host takes at most ${max} bytes in one put; nothing was sent`;

/**
 * Base64 of bytes, in pieces small enough for `String.fromCharCode`'s argument limit.
 * @param bytes the bytes
 */
export function base64Of(bytes: Uint8Array): string {
    let bin = "";
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(bin);
}
