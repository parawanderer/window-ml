// host-protocol.ts — the process host's native-messaging protocol (window-ml-host's PROTOCOL.md, v1): its shapes, and a
// call layer over any port.

// The host resolves a call's facts and enforces; the worker decides (docs/spec/SHELL.md, "The host's language"). This
// module is the worker's half of the wire, with no `chrome`: a `HostPort` is whatever carries one JSON object each way
// (a `chrome.runtime.Port` from `connectNative` in the worker, a fake in a test). Answers are matched by `seq`; the one
// unsolicited message is `done`, which the host always sends after the `start` answer of the same call.

/** The name the host registers its native-messaging manifest under (window-ml-host's `install.rs`). */
export const HOST_NAME = "com.parawanderer.window_ml_host";

/** The protocol version this client speaks. A host answering another in `hello` is not used. */
export const HOST_PROTOCOL = 1;

/** The largest `length` one `read` may ask for: 512 KiB, which is 683 KiB as base64, inside Chrome's 1 MiB message. */
export const READ_CHUNK = 524288;

/** What `hello` answers: the host's identity, and what it can do on this machine. `sandbox.landlockAbi` (host K3) is
 *  a number on Linux, `null` on macOS, and absent from a host older than K3: its `start` silently ignores `envelope`. */
export interface HostHello {
    host: string;
    version: string;
    protocol: number;
    platform: string;
    sandbox: { kind: "seatbelt" | "bwrap" | null; available: boolean; reason?: string; landlockAbi?: number | null };
    modes: ("host" | "container")[];
}

/** The worker's narrowing envelope on `start`/`pipe`. Both keys are required and there are no others. `"today"` is the
 *  host's report name for the floor; a worker never sends it (the host refuses it as malformed). */
export type HostEnvelope = { write: "roots" | "none"; exec: "any" | "program-only" };

/** What `done` reports as applied. `"today"` is the floor, which is also what an absent envelope on `done` means from
 *  a worker that sent none; an absent `envelope` on `done` itself is an older host, which the extension reads as
 *  unknown, never as narrow. */
export type HostDoneEnvelope = { write: "today" | "roots" | "none"; exec: "any" | "program-only" };

/** Whether this host understands AND can hold `envelope` on `start`/`pipe`. K3 put `landlockAbi` on `hello.sandbox`,
 *  present on both platforms (`null` on macOS); an older host has `sandbox` without that key and silently ignores
 *  `envelope`. Key presence is only the wire test: the host still has to be able to APPLY the bound. Seatbelt always
 *  can; bwrap needs a numeric Landlock ABI, and without one it reports `landlockAbi: null` — the same null macOS
 *  reports — and refuses anything narrower than today's floor (`can_hold` in window-ml-host `src/sandbox.rs`). Every
 *  envelope the worker derives is `exec: "program-only"`, so that refusal would fail the call `SandboxFailed`. */
export function hostTakesEnvelope(hello: Pick<HostHello, "sandbox">): boolean {
    const s = hello.sandbox;
    if (s === null || typeof s !== "object" || !Object.hasOwn(s, "landlockAbi")) return false;
    return s.kind === "seatbelt" || typeof s.landlockAbi === "number";
}

/** The session's settings, from the person's DevTools Settings: never from a page or the model. */
export interface HostConfigure {
    roots: string[];
    sandbox: boolean;
    path?: string[];
    timeoutMs?: number;
    outputCap?: number;
}

/** What `configure` answers: each root as resolved, and whether calls will run under the OS sandbox. */
export interface HostConfigured { roots: { given: string; path: string }[]; sandboxed: boolean }

/** One argv slot the host resolves as a path: the whole argument, or the part after `split` (`--output=f`); `walk` adds
 *  `containsSecret` from a bounded walk beneath it. */
export interface HostPathArg { arg: number; split?: string; walk?: boolean; /** Hash the resolved file (host 0.4.0): an interpreted script's entrypoint. */ hash?: boolean }

/** `spawn`'s arguments: everything the host needs to resolve the call's facts. It starts nothing. */
export interface HostSpawn {
    argv: string[];
    cwd: string;
    env?: Record<string, string | { $secret: string }>;
    mode?: "host" | "container";
    pathArgs?: HostPathArg[];
    walkCwd?: boolean;
    repoArg?: number;
    timeoutMs?: number;
    /** Who the call is for, opaque to the host and listed by its `status` (host 0.3.0): the run and the step's seq. */
    owner?: { run: string; seq: number };
    /** The call's memory bound in bytes of physical footprint, clamped by the host to the person's ceiling (0.3.0). */
    memoryBound?: number;
    /** What happens to the call when the port closes: killed (the host's default) or kept as an orphan until a deadline. */
    onOwnerLoss?: "kill" | "orphan";
}

/** One resolved path argument. `containsSecret` only for a walked one: null past the walk's cap. */
export interface HostPathFact {
    arg: number;
    given: string;
    path: string;
    inRoot: boolean;
    secret: boolean;
    exists: boolean;
    containsSecret?: boolean | null;
    /** For a `hash` argument (host 0.4.0): the sha256 of the resolved file after symlinks, null for anything but a
     *  regular file of at most 16 MiB. `start` refuses with `PinChanged` once it changes. */
    sha256?: string | null;
}

/** The enforcer whose bound applies to a call (docs/spec/EFFECTS.md): the OS sandbox, nothing, or a container. */
export type HostPlacement = "host-sandbox" | "host-plain" | "container";

/** `spawn`'s answer: the RESOLVED FACTS of one pending call, which a policy and the card are given. */
export interface HostFacts {
    id: string;
    argv: string[];
    /** `fingerprint` is `<dev>:<ino>:<size>:<mtime_ns>` of the program file (host 0.2.0; null when unreadable): what the
     *  worker caches a program's reported version by. */
    program: { path: string; inRoot: boolean; fingerprint?: string | null };
    cwd: { path: string; inRoot: boolean; containsSecret?: boolean | null };
    env: { set: string[]; secrets: string[]; free: boolean };
    repo: { root: string; reasons: string[] } | null;
    repoConfigRunsCode: boolean | null;
    paths: HostPathFact[];
    effects: "unknown" | unknown[];
    mode: "host" | "container";
    sandboxed: boolean;
    placement: HostPlacement;
    expiresInMs: number;
    /** The bound the call will run under, after clamping (host 0.3.0; absent from an older host). */
    memoryBound?: number;
}

/** One stream of a finished call: a pointer to the bytes the host holds, or why it could not keep them. */
export type HostStream = { ptr: string; size: number; sha256: string; truncated: boolean } | { error: string };

/** The `done` event: how a started call ended. `ok` is the host's (`okCodes` [0]); the worker recomputes it. */
export interface HostDone {
    event: "done";
    id: string;
    code: number | null;
    signal: string | null;
    ok: boolean;
    timedOut: boolean;
    cancelled: boolean;
    durationMs: number;
    stdout: HostStream;
    stderr: HostStream;
    error?: { code: string; message: string };
    /** `"oom"`: the call passed its memory bound and the host killed it (host 0.3.0). */
    killed?: "oom" | null;
    /** The highest physical footprint the host measured, in bytes, and the bound it ran under (host 0.3.0). */
    peakFootprint?: number;
    memoryBound?: number;
    /** The scope the host APPLIED (host K3). Absent from an older host: unknown, never "narrow". */
    envelope?: HostDoneEnvelope;
}

/** `read`'s answer: a range of held output, as base64 bytes. */
export interface HostRead { ptr: string; offset: number; length: number; size: number; eof: boolean; data: { $bytes: string } }

/** The host's error codes (PROTOCOL.md, "Error codes"). */
export type HostErrorCode = "BadRequest" | "NotConfigured" | "BadRoot" | "ProgramNotFound" | "CwdOutsideRoots" | "EnvRefused"
    | "SecretUnavailable" | "Unsupported" | "UnknownId" | "UnknownPtr" | "SandboxFailed" | "SpawnFailed" | "Busy" | "Failed"
    | "TooLarge" | "Disconnected";

/** A call the host answered with an error, or the port closing under it (`Disconnected`). */
export class HostError extends Error {
    constructor(readonly code: HostErrorCode | string, message: string) { super(message); }
}

/** What carries one JSON object each way. `onClose` fires once, when the other end has gone. */
export interface HostPort {
    send(msg: unknown): void;
    onMessage(cb: (msg: unknown) => void): void;
    onClose(cb: (why: string) => void): void;
}

/**
 * The call layer over one port: sequence numbers, answers, and `done` events (including one that arrived before anyone
 * waited for it). When the port closes, every pending call and waiter fails `Disconnected`, and so does every later call.
 */
export class HostClient {
    private seq = 0;
    private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();   // state: plumbing — calls awaiting their answer on this port
    private readonly done = new Map<string, HostDone>();   // state: plumbing — done events nobody has claimed yet
    private readonly waiters = new Map<string, { resolve: (d: HostDone) => void; reject: (e: Error) => void }[]>();   // state: plumbing
    private closed: HostError | null = null;
    private readonly closeListeners: ((e: HostError) => void)[] = [];

    constructor(private readonly port: HostPort) {
        port.onMessage((m) => this.receive(m));
        port.onClose((why) => this.close(why));
    }

    /** Whether the port has closed: a closed client answers every call with `Disconnected`. */
    get isClosed(): boolean { return this.closed !== null; }

    private receive(msg: unknown): void {
        if (!msg || typeof msg !== "object") return;
        const m = msg as Record<string, unknown>;
        if (m.event === "done" && typeof m.id === "string") {
            const d = m as unknown as HostDone;
            const ws = this.waiters.get(d.id);
            if (ws) { this.waiters.delete(d.id); for (const w of ws) w.resolve(d); }
            else this.done.set(d.id, d);
            return;
        }
        const p = typeof m.seq === "number" ? this.pending.get(m.seq) : undefined;
        if (!p) return;
        this.pending.delete(m.seq as number);
        const err = m.error as { code?: unknown; message?: unknown } | undefined;
        if (err && typeof err === "object") p.reject(new HostError(String(err.code ?? "Failed"), String(err.message ?? "")));
        else p.resolve(m.value);
    }

    /**
     * Fail everything waiting, and every later call: the port is gone (the host exited, Chrome closed it, or the worker is
     * going away). Idempotent.
     * @param why what the port reported
     */
    close(why: string): void {
        if (this.closed) return;
        this.closed = new HostError("Disconnected", why || "the process host went away");
        for (const p of this.pending.values()) p.reject(this.closed);
        this.pending.clear();
        for (const ws of this.waiters.values()) for (const w of ws) w.reject(this.closed);
        this.waiters.clear();
        this.done.clear();
        for (const l of this.closeListeners.splice(0)) { try { l(this.closed); } catch { /* a listener's own problem */ } }
    }

    /**
     * Be told once when the port closes (at once, if it already has).
     * @param cb the listener
     */
    onClosed(cb: (e: HostError) => void): void {
        if (this.closed) cb(this.closed);
        else this.closeListeners.push(cb);
    }

    /**
     * Send one call and get its value, or a {@link HostError} with the host's code.
     * @param call the call's name
     * @param args its arguments
     */
    call<T = unknown>(call: string, args: object = {}): Promise<T> {
        if (this.closed) return Promise.reject(this.closed);
        const seq = ++this.seq;
        return new Promise<T>((resolve, reject) => {
            this.pending.set(seq, { resolve: resolve as (v: unknown) => void, reject });
            try { this.port.send({ seq, call, args }); }
            catch (e) { this.pending.delete(seq); reject(new HostError("Disconnected", (e as Error)?.message || String(e))); }
        });
    }

    /**
     * The `done` event of a started call, including one that arrived before this was asked. Claimed once: a second
     * wait for the same id waits for an event that will not come again.
     * @param id the call's id
     */
    waitDone(id: string): Promise<HostDone> {
        const have = this.done.get(id);
        if (have) { this.done.delete(id); return Promise.resolve(have); }
        if (this.closed) return Promise.reject(this.closed);
        return new Promise((resolve, reject) => {
            const ws = this.waiters.get(id) ?? [];
            ws.push({ resolve, reject });
            this.waiters.set(id, ws);
        });
    }

    hello(): Promise<HostHello> { return this.call("hello"); }
    configure(c: HostConfigure): Promise<HostConfigured> { return this.call("configure", c); }
    spawn(s: HostSpawn): Promise<HostFacts> { return this.call("spawn", s); }
    /**
     * Start a pending call after its verdict. `envelope` optionally narrows the sandbox further (host K3); absent is
     * today's floor. A host older than K3 silently ignores it, so the worker sends one only when `hello` has
     * `sandbox.landlockAbi` ({@link hostTakesEnvelope}).
     * @param id the call's id
     * @param envelope the narrowing to ask for, or absent for the floor
     */
    start(id: string, envelope?: HostEnvelope): Promise<{ id: string; pid: number }> {
        return this.call("start", envelope === undefined ? { id } : { id, envelope });
    }
    discard(id: string): Promise<Record<string, never>> { return this.call("discard", { id }); }
    cancel(id: string): Promise<{ signalled: boolean }> { return this.call("cancel", { id }); }
    release(ptr: string): Promise<Record<string, never>> { return this.call("release", { ptr }); }

    /**
     * One range of held output; `length` is capped at {@link READ_CHUNK}.
     * @param ptr the stream's pointer
     * @param offset the first byte
     * @param length how many bytes at most
     */
    read(ptr: string, offset: number, length: number): Promise<HostRead> {
        return this.call("read", { ptr, offset: Math.max(0, Math.floor(offset)), length: Math.max(0, Math.min(READ_CHUNK, Math.floor(length))) });
    }
}

/**
 * Bytes from the `{ $bytes: base64 }` form the host and the `ml` wire use.
 * @param b the tagged bytes
 */
export function bytesOf(b: { $bytes: string }): Uint8Array {
    const bin = atob(String(b?.$bytes ?? ""));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
}
