// fake-native-host.mjs — a stand-in for window-ml-host on the far end of the worker's native port, for tests that drive
// the built worker in node:vm (tests/helpers.js `onNative`). It speaks the host's protocol v1 (window-ml-host's
// docs/PROTOCOL.md): hello and configure as the real host answers them, spawn with facts the test supplies, start with
// a `done` the test supplies, read of held output by range. It records every call it was sent.

/**
 * A fake host. Pass `onNative: host.onNative` to loadBackground.
 * @param opts `sandbox`: whether a sandbox is available (default true); `protocol` (default 1); `facts(args)`: the
 *   spawn answer for a call (default: the argv resolved under /usr/bin, everything in the root); `done(id, spawnArgs)`: the
 *   done event (default exit 0 with "out\n"); `refuse`: { call: code } answers that call with an error
 */
export function fakeNativeHost(opts = {}) {
    const calls = [];
    const held = new Map();
    let n = 0, end = null;
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
                const { seq, call, args = {} } = msg;
                if (opts.refuse?.[call]) return reply({ seq, error: { code: opts.refuse[call], message: `${call} refused` } });
                if (call === "hello") return reply({ seq, value: { host: "window-ml-host", version: "0.2.0", protocol: opts.protocol ?? 1, platform: "macos", sandbox: { kind: "seatbelt", available: opts.sandbox !== false }, modes: ["host"] } });
                if (call === "configure") return reply({ seq, value: { roots: args.roots.map((r) => ({ given: r, path: r })), sandboxed: args.sandbox !== false && opts.sandbox !== false } });
                if (call === "spawn") {
                    const id = `c${++n}`;
                    const f = opts.facts?.(args) ?? {
                        argv: args.argv, program: { path: args.argv[0].startsWith("/") ? args.argv[0] : `/usr/bin/${args.argv[0]}`, inRoot: false, fingerprint: "1:2:3:4" },
                        cwd: { path: args.cwd, inRoot: true }, env: { set: Object.keys(args.env ?? {}), secrets: [], free: true },
                        repo: null, repoConfigRunsCode: null,
                        paths: (args.pathArgs ?? []).map((p) => ({ arg: p.arg, given: args.argv[p.arg], path: `${args.cwd}/${args.argv[p.arg]}`, inRoot: true, secret: false, exists: true, ...(p.walk ? { containsSecret: false } : {}) })),
                        effects: "unknown", mode: "host", sandboxed: opts.sandbox !== false, placement: opts.sandbox !== false ? "host-sandbox" : "host-plain",
                    };
                    msg.id = id;
                    return reply({ seq, value: { id, expiresInMs: 1800000, ...f } });
                }
                if (call === "start") {
                    reply({ seq, value: { id: args.id, pid: 4242 } });
                    const spawned = calls.find((c) => c.call === "spawn" && c.id === args.id);
                    const d = opts.done?.(args.id, spawned?.args) ?? { out: "out\n", err: "", code: 0 };
                    const ptr = (text) => { const p = `out:${held.size + 1}`; held.set(p, Buffer.from(text)); return { ptr: p, size: Buffer.byteLength(text), sha256: "x", truncated: false }; };
                    const oom = d.killed === "oom";
                    return reply({ event: "done", id: args.id, code: oom ? null : d.code, signal: oom ? "SIGKILL" : null, ok: !oom && d.code === 0, timedOut: false, cancelled: false, durationMs: 3,
                        stdout: ptr(d.out), stderr: ptr(d.err), ...(d.peakFootprint !== undefined ? { killed: d.killed ?? null, peakFootprint: d.peakFootprint, memoryBound: d.memoryBound } : {}) });
                }
                if (call === "read") {
                    const b = held.get(args.ptr);
                    if (!b) return reply({ seq, error: { code: "UnknownPtr", message: "no" } });
                    const part = b.subarray(args.offset, args.offset + args.length);
                    return reply({ seq, value: { ptr: args.ptr, offset: args.offset, length: part.length, size: b.length, eof: args.offset + part.length >= b.length, data: { $bytes: part.toString("base64") } } });
                }
                if (call === "discard" || call === "release") return reply({ seq, value: {} });
                return reply({ seq, error: { code: "BadRequest", message: `unknown call ${call}` } });
            };
        },
    };
    return host;
}
