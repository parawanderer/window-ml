// fake-native-host.mjs — a stand-in for window-ml-host on the far end of the worker's native port, for tests that drive
// the built worker in node:vm (tests/helpers.js `onNative`). It speaks the host's protocol v1 (window-ml-host's
// docs/PROTOCOL.md): hello and configure as the real host answers them, spawn with facts the test supplies, start with
// a `done` the test supplies, read of held output by range. It records every call it was sent.

import { createHash } from "node:crypto";

/**
 * A fake host. Pass `onNative: host.onNative` to loadBackground.
 * @param opts `sandbox`: whether a sandbox is available (default true); `sandboxKind`: `"seatbelt" | "bwrap" | null`
 *   (default `"seatbelt"`); `landlockAbi`: the `hello.sandbox.landlockAbi` value (a number on Linux, `null` on
 *   macOS); absent = pre-K3 (the key is not sent); `facts(args)`: the spawn answer for a call (default: the argv
 *   resolved under /usr/bin, everything in the root); `done(id, spawnArgs)`: the done event (default exit 0 with
 *   "out\n"); `refuse`: { call: code } answers that call with an error; `startError(id, n)`: an error code for the
 *   n-th `start` (0-based), as `PinChanged` when a hashed script changed since its spawn; `fs`: the files in the roots, by
 *   absolute path to its sha256, which a path fact's `exists` and `sha256` read (absent: every path exists); a test's
 *   `done` changes it to make a call write; `peek`: true puts `peek: true` in hello (host 0.7.0+); `peekAnswer(args)`:
 *   the value of a `peek` ({ stdout, stderr }, or { error }); returning nothing answers `UnknownId`; `tilde`: a host that expands a leading `~` (PROTOCOL.md, `spawn`): `{ home }`,
 *   an absolute path, or `null` for an unset HOME (`reason: "no-home"`), or a relative string (`"home-not-absolute"`). The hello
 *   says `tilde: true`; spawn rewrites argv and cwd (an argument that is exactly `~` or starts with `~/`) BEFORE it
 *   resolves, so the facts carry the expansion, and lists them as `tilde: [{ index, from, to, reason? }]` (always, `[]` when
 *   none). With it, `inRoot` is computed from the configured roots (else every path is in the root) and an absolute
 *   path argument is its own path. The calls it recorded keep the argv and cwd as the worker sent them (`args`), the expanded ones on `expanded`. Absent: no
 *   `tilde` key anywhere, nothing else changes
 */
export function fakeNativeHost(opts = {}) {
    const calls = [];
    const held = new Map();
    let n = 0, end = null, roots = [];
    const tilde = opts.tilde;
    /** The host's `~` rule: the entry for one argument, or null when it is not expanded. */
    const expand = (index, from) => {
        if (!(from === "~" || from.startsWith("~/"))) return null;
        const home = tilde.home;
        if (home === null || home === undefined || home === "") return { index, from, to: null, reason: "no-home" };
        if (!home.startsWith("/")) return { index, from, to: null, reason: "home-not-absolute" };
        return { index, from, to: home + from.slice(1) };
    };
    const inRoots = (p) => roots.some((r) => p === r || p.startsWith(`${r.replace(/\/+$/, "")}/`));
    const reply = (m) => end?.send(m);
    const host = {
        calls,
        names: () => calls.map((c) => c.call),
        /** Close the port from the host's side, as an exit does. */
        exit: (why = "host exited") => end?.close(why),
        onNative: (name, e) => {
            if (name !== "com.parawanderer.window_ml_host") return null;
            end = e;
            return (msg) => {
                calls.push(msg);
                const { seq, call } = msg;
                let { args = {} } = msg;
                if (opts.refuse?.[call]) return reply({ seq, error: { code: opts.refuse[call], message: `${call} refused` } });
                if (call === "hello") {
                    const sandbox = { kind: opts.sandboxKind === undefined ? "seatbelt" : opts.sandboxKind, available: opts.sandbox !== false };
                    if (opts.landlockAbi !== undefined) sandbox.landlockAbi = opts.landlockAbi;
                    return reply({ seq, value: { host: "window-ml-host", version: "0.2.0", protocol: opts.protocol ?? 1, platform: "macos", sandbox, modes: ["host"], ...(tilde ? { tilde: true } : {}), ...(opts.credentials ? { credentials: opts.credentials } : {}), ...(opts.peek ? { peek: true } : {}) } });
                }
                if (call === "configure") roots = args.roots;
                if (call === "configure") return reply({ seq, value: { roots: args.roots.map((r) => ({ given: r, path: r })), sandboxed: args.sandbox !== false && opts.sandbox !== false } });
                if (call === "spawn") {
                    const id = `c${++n}`;
                    const sent = args;
                    let entries = [];
                    if (tilde) {
                        const e = [...sent.argv.map((a, i) => expand(i, a)), ...(sent.cwd === undefined ? [] : [expand("cwd", sent.cwd)])].filter(Boolean);
                        entries = e;
                        args = { ...sent, argv: sent.argv.map((a, i) => e.find((t) => t.index === i)?.to ?? a), ...(sent.cwd === undefined ? {} : { cwd: e.find((t) => t.index === "cwd")?.to ?? sent.cwd }) };
                    }
                    // The real spawn refuses an expanded cwd outside the roots (window-ml-host src/session.rs, CwdOutsideRoots), so a cwd fact is always in a root.
                    if (tilde && args.cwd !== undefined && !inRoots(args.cwd)) return reply({ seq, error: { code: "CwdOutsideRoots", message: `${args.cwd} is outside every root` } });
                    const f = opts.facts?.(args) ?? {
                        argv: args.argv, program: { path: args.argv[0].startsWith("/") ? args.argv[0] : `/usr/bin/${args.argv[0]}`, inRoot: false, fingerprint: "1:2:3:4" },
                        cwd: { path: args.cwd, inRoot: true }, env: { set: Object.keys(args.env ?? {}), secrets: [], free: true },
                        repo: null, repoConfigRunsCode: null,
                        paths: (args.pathArgs ?? []).map((p) => {
                            const given = p.split ? args.argv[p.arg].slice(args.argv[p.arg].indexOf(p.split) + 1) : args.argv[p.arg], path = tilde && given.startsWith("/") ? given : `${args.cwd}/${given}`;
                            const exists = opts.fs ? path in opts.fs : true;
                            return { arg: p.arg, given, path, inRoot: tilde ? inRoots(path) : true, secret: false, exists, ...(p.walk ? { containsSecret: false } : {}), ...(p.hash ? { sha256: opts.fs ? opts.fs[path] ?? null : opts.sha256?.(n) ?? "0".repeat(64) } : {}) };
                        }),
                        effects: "unknown", mode: "host", sandboxed: opts.sandbox !== false, placement: opts.sandbox !== false ? "host-sandbox" : "host-plain",
                        // A host that lists credentials honours one asked for (the real one also checks the manifest's hash).
                        ...(opts.credentials ? { credential: args.credential ? { provider: args.credential.provider, ports: [443], hosts: ["api.github.com", "github.com"], profile: `credentialed:${args.credential.provider}` } : null } : {}),
                    };
                    msg.id = id;
                    if (tilde) msg.expanded = args;
                    return reply({ seq, value: { id, expiresInMs: 1800000, ...f, ...(tilde ? { tilde: entries } : {}) } });
                }
                if (call === "start") {
                    const code = opts.startError?.(args.id, calls.filter((c) => c.call === "start").length - 1);
                    if (code) return reply({ seq, error: { code, message: `${call} refused` } });
                    reply({ seq, value: { id: args.id, pid: 4242 } });
                    const spawned = calls.find((c) => c.call === "spawn" && c.id === args.id);
                    const d = opts.done?.(args.id, spawned?.args) ?? { out: "out\n", err: "", code: 0 };
                    const ptr = (text) => { const p = `out:${held.size + 1}`; held.set(p, Buffer.from(text)); return { ptr: p, size: Buffer.byteLength(text), sha256: createHash("sha256").update(text).digest("hex"), truncated: false }; };
                    const oom = d.killed === "oom";
                    return reply({ event: "done", id: args.id, code: oom ? null : d.code, signal: oom ? "SIGKILL" : null, ok: !oom && d.code === 0, timedOut: false, cancelled: false, durationMs: 3,
                        stdout: ptr(d.out), stderr: ptr(d.err), ...(d.peakFootprint !== undefined ? { killed: d.killed ?? null, peakFootprint: d.peakFootprint, memoryBound: d.memoryBound } : {}), ...(d.cpuMs !== undefined ? { cpuMs: d.cpuMs } : {}), ...(d.envelope !== undefined ? { envelope: d.envelope } : {}),
                        ...(d.protectedChanged !== undefined ? { protectedChanged: d.protectedChanged } : {}), ...(d.protectedChangedTruncated ? { protectedChangedTruncated: true } : {}) });
                }
                if (call === "read") {
                    const b = held.get(args.ptr);
                    if (!b) return reply({ seq, error: { code: "UnknownPtr", message: "no" } });
                    const part = b.subarray(args.offset, args.offset + args.length);
                    return reply({ seq, value: { ptr: args.ptr, offset: args.offset, length: part.length, size: b.length, eof: args.offset + part.length >= b.length, data: { $bytes: part.toString("base64") } } });
                }
                if (call === "peek") {
                    const r = opts.peekAnswer?.(args);
                    if (!r) return reply({ seq, error: { code: "UnknownId", message: "no such running call" } });
                    if (r.error) return reply({ seq, error: r.error });
                    return reply({ seq, value: { id: args.id, ...r } });
                }
                if (call === "discard" || call === "release") return reply({ seq, value: {} });
                return reply({ seq, error: { code: "BadRequest", message: `unknown call ${call}` } });
            };
        },
    };
    return host;
}
