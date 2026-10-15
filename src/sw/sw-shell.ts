// sw-shell.ts — the process host from the worker's side: the one native-messaging port, the session's configuration
// from the person's settings, and what this browser may say about it (the shell capabilities).

// docs/spec/SHELL.md. The host (window-ml-host) resolves facts and enforces; this worker decides. Chrome starts the host
// over stdio when `connectNative` is first called and keeps it while the port is open; the host's own manifest names
// this extension's id, so nothing else reaches it. Only this module opens the port, and only for a call the worker
// itself makes for a run (sw-shell-call.ts): no message a page can start reaches it (tests/redteam.test.js).
//
// What it keeps dies with the worker: an MV3 eviction closes the port, the host then ends its session and deletes the
// output it held. The next call reconnects and configures afresh.

import { HostClient, HostError, HOST_NAME, HOST_PROTOCOL, type HostConfigured, type HostHello, type HostPort } from "../shell/host-protocol";
import { getConfig } from "./sw-llm";
import { defineState } from "../state-registry";
import type { MlConfig } from "../contract";

/** How long the port stays open with nothing running and nothing held, before it is closed (the host exits with it). */
export const SHELL_IDLE_MS = 5 * 60_000;

/** The settings a session is configured from, as they were when it was. */
type ShellSettings = Pick<MlConfig, "shellEnabled" | "shellRoots" | "shellSandbox" | "shellPath">;

/** A connected, configured host. */
export interface ShellHost {
    client: HostClient;
    hello: HostHello;
    configured: HostConfigured;
    /** The settings it was configured from, as one string, so a change is noticed. */
    key: string;
}

/** Why there is no host to use: off in settings, no root, not installed, or the host refused the configuration. */
export class ShellUnavailable extends Error {
    constructor(readonly reason: "off" | "no-roots" | "not-installed" | "protocol" | "config", message: string) { super(message); }
}

/** What the settings page and the capabilities say about the host, from the last time it was reached. */
export interface ShellStatus {
    enabled: boolean;
    /** Reached and configured the last time it was tried: `ml.sh` can run here (the port may be closed while idle). */
    ready: boolean;
    /** Calls will run under the OS sandbox (asked for, and available on this machine). */
    sandboxed: boolean;
    host?: { version: string; platform: string; sandbox: HostHello["sandbox"] };
    roots?: HostConfigured["roots"];
    /** Why it is not ready, in words for the settings page. */
    error?: string;
    reason?: ShellUnavailable["reason"];
}

let current: ShellHost | null = null;   // state: declared below as "shell.host"
let connecting: Promise<ShellHost> | null = null;   // state: plumbing — one connection attempt at a time
let status: ShellStatus = { enabled: false, ready: false, sandboxed: false };   // state: declared below as "shell.host"
let inFlight = 0;   // state: plumbing — calls running on the host now; the port is not closed under them
let held = 0;   // state: plumbing — outputs the host holds for runs; the port is not closed under them
let idleTimer: ReturnType<typeof setTimeout> | undefined;   // state: plumbing
const statusListeners = new Set<() => void>();   // state: plumbing — the capabilities' refresh

defineState({
    id: "shell.host", scope: "browser", realm: "worker", audience: "human", lostOn: ["worker-eviction", "browser-restart"],
    describe: "The process host behind ml.sh: whether it is connected, its version, whether calls run under the OS sandbox, and the workspace roots it was configured with. An eviction closes the port, and the host deletes the output it held.",
    read: () => ({ ...status, inFlight, held }),
});

/** The settings as one string: a different string is a different session. */
const settingsKey = (s: ShellSettings): string => JSON.stringify([!!s.shellEnabled, s.shellRoots ?? [], s.shellSandbox !== false, s.shellPath ?? []]);

/**
 * Wrap a `chrome.runtime.Port` from `connectNative` as the protocol client's port. Chrome reports why a native port
 * closed only in `chrome.runtime.lastError`, read inside the disconnect listener.
 * @param port the native port
 */
function nativePort(port: chrome.runtime.Port): HostPort {
    return {
        send: (m) => port.postMessage(m),
        onMessage: (cb) => port.onMessage.addListener((m) => cb(m)),
        onClose: (cb) => port.onDisconnect.addListener(() => cb(chrome.runtime.lastError?.message || "the process host closed the connection")),
    };
}

/** Tell whoever draws the capabilities that the status changed. */
function setStatus(s: ShellStatus): void {
    const changed = JSON.stringify(s) !== JSON.stringify(status);
    status = s;
    if (changed) for (const l of statusListeners) { try { l(); } catch { /* a listener's own problem */ } }
}

/**
 * The host, connected and configured from the current settings: reused while the settings are the same and the port is
 * open, reconnected otherwise. Never called for a page's message.
 * @returns the host
 * @throws ShellUnavailable saying why there is none
 */
export async function shellHost(): Promise<ShellHost> {
    const cfg = await getConfig();
    const key = settingsKey(cfg);
    if (current && !current.client.isClosed && current.key === key) return current;
    if (connecting) return connecting;
    connecting = connect(cfg, key).finally(() => { connecting = null; });
    return connecting;
}

async function connect(cfg: ShellSettings, key: string): Promise<ShellHost> {
    const enabled = !!cfg.shellEnabled;
    const fail = (reason: ShellUnavailable["reason"], message: string): never => {
        setStatus({ enabled, ready: false, sandboxed: false, error: message, reason });
        throw new ShellUnavailable(reason, message);
    };
    if (current) { const old = current; current = null; old.client.close("the settings changed"); }
    if (!enabled) return fail("off", "Running programs (ml.sh) is turned off in Settings.");
    const roots = (cfg.shellRoots ?? []).map((r) => String(r).trim()).filter(Boolean);
    if (!roots.length) return fail("no-roots", "No workspace folder is set: ml.sh runs programs only inside the folders named in Settings.");
    let port: chrome.runtime.Port;
    try { port = chrome.runtime.connectNative(HOST_NAME); }
    catch (e) { return fail("not-installed", `The process host could not be started: ${(e as Error)?.message || e}`); }
    const client = new HostClient(nativePort(port));
    client.onClosed(() => { if (current?.client === client) { current = null; setStatus({ ...status, ready: false, error: "The process host closed the connection." }); } });
    let hello: HostHello;
    try { hello = await client.hello(); }
    catch (e) { client.close("hello failed"); return fail("not-installed", notInstalledText((e as Error)?.message)); }
    if (hello?.protocol !== HOST_PROTOCOL) { client.close("protocol"); return fail("protocol", `The process host speaks protocol ${hello?.protocol}; this extension speaks ${HOST_PROTOCOL}. Update one of them.`); }
    let configured: HostConfigured;
    try {
        configured = await client.configure({ roots, sandbox: cfg.shellSandbox !== false, ...(cfg.shellPath?.length ? { path: cfg.shellPath.map(String) } : {}) });
    } catch (e) {
        client.close("configure failed");
        return fail("config", `The process host refused the settings: ${(e as Error)?.message || e}`);
    }
    current = { client, hello, configured, key };
    setStatus({ enabled, ready: true, sandboxed: configured.sandboxed, host: { version: hello.version, platform: hello.platform, sandbox: hello.sandbox }, roots: configured.roots });
    touch();
    return current;
}

/** What a port that would not start says, turned into what to do about it. */
function notInstalledText(why: string | undefined): string {
    return `The process host is not installed or would not start (${why || "no answer"}). Install it with \`wmlhost install --extension-id ${chrome.runtime.id}\`.`;
}

/** The port is in use: restart its idle clock. */
function touch(): void {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
        // Never under a call, nor while the host holds output a run may still read.
        if (inFlight > 0 || held > 0) { touch(); return; }
        // The host is still there to reach, so the status (and the capabilities) stay: the next call reconnects.
        if (current) { const c = current; current = null; c.client.close("idle"); }
    }, SHELL_IDLE_MS);
}

/**
 * Run `fn` with the host, counted as in flight so the port is not closed under it.
 * @param fn what to do with the host
 */
export async function withShell<T>(fn: (h: ShellHost) => Promise<T>): Promise<T> {
    const h = await shellHost();
    inFlight++;
    try { return await fn(h); } finally { inFlight--; touch(); }
}

/**
 * Count output the host holds for a run (+1) or no longer holds (−1): the port stays open while any is held.
 * @param delta the change
 */
export function holdOutput(delta: number): void {
    held = Math.max(0, held + delta);
}

/** The status as last measured, for the settings page. */
export const shellStatus = (): ShellStatus => ({ ...status });

/**
 * Measure the status now: connect and configure if the settings say so, or record why not. For the settings page and
 * the capabilities; never throws.
 */
export async function refreshShell(): Promise<ShellStatus> {
    try { await shellHost(); } catch (e) { if (!(e instanceof ShellUnavailable) && !(e instanceof HostError)) setStatus({ ...status, ready: false, error: String((e as Error)?.message || e) }); }
    return shellStatus();
}

/**
 * The shell capabilities this runtime declares (docs/spec/SHELL.md, "What the model sees"): `shellHost` when ml.sh can
 * run on this machine's real filesystem, `shellSandboxed` when such calls run under the OS sandbox. `shellContainer`
 * stays absent: no container runner exists. Absent means no.
 */
export function shellCapabilities(): { shellHost?: true; shellSandboxed?: true } {
    if (!status.ready) return {};
    return { shellHost: true, ...(status.sandboxed ? { shellSandboxed: true as const } : {}) };
}

/**
 * Be told when the status changes (the runtime's description re-announces its capabilities).
 * @param fn the listener
 */
export function onShellStatus(fn: () => void): void { statusListeners.add(fn); }

/** Whether a settings change touches the shell. */
export const SHELL_KEYS = ["shellEnabled", "shellRoots", "shellSandbox", "shellPath"] as const;
