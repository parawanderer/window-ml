#!/usr/bin/env node
// Generate the protobuf chat-stream decoder from `src/proto/chat.proto`.
//
// The schema is the CONTRACT and it is not ours: it lives in slop-zone on the box, and the copy here is
// pinned (see the header in chat.proto). Everything about the wire — field numbers, wire types, which fields
// exist at all — is derived from it rather than written down a second time, because a hand-written decoder
// is a second copy of the field numbers and the whole failure mode with a schema you do not own is drifting
// away from it silently. The generated decoder also means a field the server does not emit YET (tool_calls,
// logprobs, both already in the schema) is decoded the day it starts arriving, with no change here.
//
// The OUTPUT IS CHECKED IN, unlike the other generated files, for the same reason the export schema is: CI
// has no protoc. `tests/proto.test.mjs` regenerates and diffs, so a stale copy cannot ship — and it skips
// itself where protoc is absent rather than failing a machine that never asked for it.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PROTO_DIR = join(ROOT, "src", "proto");
const OUT = join(PROTO_DIR, "chat.gen.ts");
const PLUGIN = join(ROOT, "node_modules", ".bin", "protoc-gen-ts_proto");

/** ts-proto options, fixed here so the checked-in output is reproducible from one command. */
const OPTS = [
    // DECODE ONLY. We never encode one of these — the server does — and the encoders are most of the output.
    "outputEncodeMethods=decode-only",
    "outputJsonMethods=false",
    "outputClientImpl=false",
    // A 64-bit field as a NUMBER rather than a Long, which would pull in the `long` package for one unix
    // timestamp. `created` is seconds since the epoch; it is exact in a double until the year 285000000.
    "forceLong=number",
    "esModuleInterop=true",
    "useOptionals=none",
];

const PIN = JSON.parse(readFileSync(join(PROTO_DIR, "chat.proto.pin.json"), "utf8"));

/**
 * Is the vendored schema BYTE-FOR-BYTE the file at the pinned commit?
 *
 * A git blob id is content-addressed — sha1 over `blob <len>\0` and the bytes — so this answers the question
 * offline, which is the point: a copy of someone else's contract that can only be checked when a private
 * host is reachable is a copy nobody checks. The remote half is a bonus, run only where `gh` is authed.
 */
export function checkPin({ remote = true } = {}) {
    const local = execFileSync("git", ["hash-object", join(PROTO_DIR, "chat.proto")], { encoding: "utf8" }).trim();
    if (local !== PIN.blob)
        throw new Error(`chat.proto is not the pinned file: ${local} != ${PIN.blob}. `
            + `Replace it from ${PIN.repo}:${PIN.path} and update the pin, or fix the pin if the schema moved on.`);
    if (!remote) return { local, remote: null };
    let sha = null;
    try {
        sha = execFileSync("gh", ["api", `repos/${PIN.repo}/contents/${PIN.path}?ref=${PIN.commit}`, "--jq", ".sha"],
            { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    } catch { return { local, remote: null }; }   // no gh, no auth, no network — the offline check still held
    if (sha !== PIN.blob)
        throw new Error(`the pinned commit no longer carries the pinned blob: ${sha} != ${PIN.blob}`);
    // …and the question the blob id CANNOT answer: whether the schema has moved on WITHOUT us. Our pin says
    // "this copy is commit X", which stays true forever and is exactly as true the day X becomes ancient. So
    // where the remote is reachable, also ask what the newest commit touching that path is. A warning rather
    // than a failure: upstream moving is news, not a broken build, and we may be pinned deliberately.
    let tip = null;
    try {
        tip = JSON.parse(execFileSync("gh", ["api", `repos/${PIN.repo}/commits?path=${PIN.path}&sha=${PIN.branch}&per_page=1`],
            { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }))[0]?.sha ?? null;
    } catch { /* the blob check already held */ }
    return { local, remote: sha, tip, stale: !!tip && tip !== PIN.commit };
}

/** Is protoc available? Returns its version, or null. */
export function protocVersion() {
    try { return execFileSync("protoc", ["--version"], { encoding: "utf8" }).trim(); } catch { return null; }
}

/** Generate into a directory and hand back the source text, without touching the checked-in file. */
export function generate(intoDir) {
    if (!protocVersion()) throw new Error("protoc is not installed");
    mkdirSync(intoDir, { recursive: true });
    execFileSync("protoc", [
        `-I${PROTO_DIR}`, `--plugin=protoc-gen-ts_proto=${PLUGIN}`,
        `--ts_proto_out=${intoDir}`, `--ts_proto_opt=${OPTS.join(",")}`, "chat.proto",
    ], { stdio: ["ignore", "ignore", "pipe"] });
    return readFileSync(join(intoDir, "chat.ts"), "utf8");
}

if (import.meta.url === `file://${process.argv[1]}`) {
    if (process.argv.includes("--check")) {
        const r = checkPin();
        console.log(`chat.proto matches ${PIN.repo}@${PIN.commit.slice(0, 7)} (${r.remote ? "verified against GitHub" : "offline check only"})`);
        if (r.stale)
            console.log(`NOTE: upstream has moved on — newest commit touching ${PIN.path} is ${r.tip.slice(0, 7)}. `
                + "Re-vendor and re-pin if you want it.");
        if (!protocVersion()) { console.log("protoc absent — cannot diff the generated decoder"); process.exit(0); }
    }
    checkPin({ remote: false });
    const tmp = join(ROOT, "node_modules", ".cache", "protogen");
    rmSync(tmp, { recursive: true, force: true });
    const src = generate(tmp);
    const before = existsSync(OUT) ? readFileSync(OUT, "utf8") : null;
    writeFileSync(OUT, src);
    rmSync(tmp, { recursive: true, force: true });
    console.log(before === src ? `unchanged ${OUT}` : `generated ${OUT}`);
}
