// The /api/events stream against its schema: the PIN, the generated types, and every REAL captured frame.
//
// The schema (`src/proto/events.proto`) is the fork's, kept true to its encoder by `api/events_proto_test.go` on the
// server. What can still go wrong is on THIS side: our pinned copy drifting from theirs, the generated types renaming a
// wire key, and a capture carrying something the schema does not declare. The last is checked the way the server checks
// the encoder, path by path, over the frames the panel is actually fed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkPin, protocVersion, generate } from "../scripts/gen-proto.mjs";
import { parseFrame } from "../src/resource-events.ts";

const PROTO = readFileSync(new URL("../src/proto/events.proto", import.meta.url), "utf8");

/** events.proto as a field map: message → field → { type, repeated, optional }. The file is flat and regular (the
 *  server generates its skeleton), so a line reader is enough, and a line it cannot read fails the test below. */
function schema() {
    const messages = new Map();
    let cur = null;
    for (const raw of PROTO.split("\n")) {
        const line = raw.replace(/\/\/.*$/, "").trim();
        if (!line) continue;
        const m = /^message (\w+) \{$/.exec(line);
        if (m) { cur = new Map(); messages.set(m[1], cur); continue; }
        if (line === "}") { cur = null; continue; }
        if (!cur) continue;
        const f = /^(optional |repeated )?([\w.]+) (\w+) = \d+;$/.exec(line);
        assert.ok(f, `unreadable field line in events.proto: ${raw}`);
        cur.set(f[3], { type: f[2], repeated: f[1] === "repeated ", optional: f[1] === "optional " });
    }
    return messages;
}
const MESSAGES = schema();

const SCALARS = {
    string: "string", bool: "boolean",
    int32: "number", int64: "number", uint32: "number", uint64: "number", double: "number", float: "number",
    "google.protobuf.Timestamp": "timestamp",
};

/** Every problem with one JSON value against a message type, as `path: what` lines. Nulls are allowed anywhere: the
 *  schema says `backfilled` is null on every non-hello frame and `details.families` is a null slice, and JSON null
 *  carries "nothing to report" wherever it appears. */
function check(value, type, path, out) {
    if (value === null) return;
    const scalar = SCALARS[type];
    if (scalar === "timestamp") {
        if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) out.push(`${path}: not an RFC 3339 timestamp (${JSON.stringify(value)})`);
        return;
    }
    if (scalar) {
        if (typeof value !== scalar) out.push(`${path}: ${typeof value}, schema says ${type}`);
        return;
    }
    const fields = MESSAGES.get(type);
    if (!fields) { out.push(`${path}: schema has no message ${type}`); return; }
    if (typeof value !== "object" || Array.isArray(value)) { out.push(`${path}: not an object, schema says ${type}`); return; }
    for (const [key, v] of Object.entries(value)) {
        const f = fields.get(key);
        if (!f) { out.push(`${path}.${key}: not declared in ${type}`); continue; }
        if (f.repeated) {
            if (v === null) continue;
            if (!Array.isArray(v)) { out.push(`${path}.${key}: not an array`); continue; }
            v.forEach((x, i) => check(x, f.type, `${path}.${key}[${i}]`, out));
        } else check(v, f.type, `${path}.${key}`, out);
    }
}

/** Every real capture the panel's tests run on: NDJSON lines, or a JSON array of frames. */
function captures() {
    const out = [];
    const hw = new URL("./fixtures/hw/", import.meta.url);
    for (const name of readdirSync(hw).filter((n) => n.endsWith(".ndjson")))
        for (const line of readFileSync(new URL(name, hw), "utf8").split("\n").filter((l) => l.trim())) {
            const frame = JSON.parse(line);
            if (typeof frame.kind === "string") out.push({ source: name, frame });   // some hw captures are poll bodies, not frames
        }
    const e2e = new URL("./e2e/fixtures/", import.meta.url);
    for (const name of ["events-gen-timings.json", "events-load-lifecycle.json"])
        for (const frame of JSON.parse(readFileSync(new URL(name, e2e), "utf8"))) out.push({ source: name, frame });
    return out;
}

test("events.proto: the vendored schema is byte-for-byte the file at the pinned commit", () => {
    assert.ok(checkPin({ remote: false, target: "events" }).local);
});

test("events.proto: the checked-in types are what the schema generates", () => {
    if (!protocVersion()) return;   // CI has no protoc; the pin above still holds there
    const tmp = mkdtempSync(join(tmpdir(), "protogen-"));
    try {
        const fresh = generate(tmp, "events");
        const shipped = readFileSync(new URL("../src/proto/events.gen.ts", import.meta.url), "utf8");
        assert.equal(fresh, shipped, "src/proto/events.gen.ts is stale — run `npm run gen-proto`");
    } finally { rmSync(tmp, { recursive: true, force: true }); }
});

// ts-proto camelCases by default, which would have typed keys the server never sends. The options in gen-proto.mjs turn
// that off; this is the check that they did, for every field of every message.
test("events.gen.ts: every property is the WIRE KEY, with a timestamp as a string and int64 as a number", () => {
    const gen = readFileSync(new URL("../src/proto/events.gen.ts", import.meta.url), "utf8");
    const body = (msg) => {
        const m = new RegExp(`export interface ${msg} \\{([\\s\\S]*?)\\n\\}`).exec(gen);
        assert.ok(m, `no interface for ${msg}`);
        return m[1].replace(/\/\*\*[\s\S]*?\*\//g, "");
    };
    for (const [msg, fields] of MESSAGES) {
        const src = body(msg);
        for (const [name, f] of fields) {
            const decl = new RegExp(`\\n\\s*${name}(\\?)?:\\s*([^;]+);`).exec(src);
            assert.ok(decl, `${msg}.${name} is not a property of the generated interface (renamed?)`);
            assert.equal(!!decl[1], f.optional, `${msg}.${name}: optional in TS exactly when the schema gives it presence`);
            if (f.type === "google.protobuf.Timestamp") assert.match(decl[2], /\bstring\b/, `${msg}.${name}: a timestamp is a string`);
            if (/int64/.test(f.type)) assert.match(decl[2], /\bnumber\b/, `${msg}.${name}: int64 is a number`);
        }
    }
});

test("every captured frame is declared by the schema, key by key and type by type", () => {
    const frames = captures();
    assert.ok(frames.length > 150, `enough real frames to mean something (${frames.length})`);
    const problems = [];
    for (const { source, frame } of frames) {
        const out = [];
        check(frame, "EventFrame", frame.kind, out);
        for (const p of out) problems.push(`${source}: ${p}`);
    }
    assert.deepEqual([...new Set(problems)], [], "a capture carries what the schema does not declare");
});

test("every captured frame parses, and its kind is one the schema's contract names", () => {
    const kindsBlock = PROTO.slice(PROTO.indexOf("// KINDS."), PROTO.indexOf("// A client must ignore"));
    const listed = new Set([...kindsBlock.matchAll(/^\/\/   ([a-z]+(?:\.[a-z]+)?)\s{2,}/gm)].map((m) => m[1]));
    assert.equal(listed.size, 18, `the schema's kind list (${[...listed].join(", ")})`);
    const seen = new Set();
    for (const { source, frame } of captures()) {
        const f = parseFrame(JSON.stringify(frame));
        assert.ok(f, `${source}: a ${frame.kind} frame did not parse`);
        assert.ok(listed.has(f.kind), `${source}: kind ${f.kind} is not in the schema's list`);
        seen.add(f.kind);
    }
    // The fork's vectors cover 17 of the 18 kinds; `evict` needs a runtime out-of-memory, which it will not manufacture on a
    // box in use. Pinned so a lost fixture is noticed.
    assert.ok(seen.size >= 17, `kinds covered by captures: ${[...seen].sort().join(", ")}`);
});
