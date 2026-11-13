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
    /** `tilde`: the host expands a leading `~` in argv and cwd (`hello.tilde`). */
    host?: { version: string; platform: string; sandbox: HostHello["sandbox"]; tilde?: boolean };
    roots?: HostConfigured["roots"];
    /** Why it is not ready, in words for the settings page. */
    error?: string;
    reason?: ShellUnavailable["reason"];
    /** The last attempt to say hello to the host, in this worker: true if it answered, false if not, absent if none was made. */
    hostAnswers?: boolean;
    /** A host has answered in this profile at some time (stored): with `hostAnswers`, whether Settings still offers the installer. */
    hostSeen?: boolean;
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
    // Nothing while ml.sh is off and the host idle: a session with nothing live must read as such (the Run state panel).
    read: () => (status.enabled || inFlight || held ? { ...status, inFlight, held } : undefined),
});

const HOST_SEEN_KEY = "shellHostSeen";
let hostSeen = false;   // state: declared below as "shell.hostSeen"
let hostAnswers: boolean | undefined;   // state: plumbing — the last hello attempt's outcome, remeasured by the next
const hostSeenRead: Promise<void> = (async () => {
    try { hostSeen = (await chrome.storage.local.get(HOST_SEEN_KEY))[HOST_SEEN_KEY] === true; } catch { /* no storage (a test harness) */ }
})();

defineState({
    id: "shell.hostSeen", scope: "browser", realm: "worker", audience: "human", lostOn: [],
    describe: "Whether a process host has ever answered in this profile. Stored; it decides whether Settings and the attention list offer the installer.",
    read: () => ({ hostSeen, hostAnswers }),
});

/**
 * Whether Settings and the attention list should still offer to install the host: no host has answered, by the last
 * attempt this worker made or, with none yet, by any earlier one in this profile.
 */
export const hostMissing = (): boolean => !(hostAnswers ?? hostSeen);

/** A hello got an answer (or did not): remember it, and tell the status's listeners when the offer changes. */
function noteHello(answered: boolean): void {
    const before = hostMissing();
    hostAnswers = answered;
    if (answered && !hostSeen) { hostSeen = true; void chrome.storage.local.set({ [HOST_SEEN_KEY]: true }).catch(() => undefined); }
    if (before !== hostMissing()) for (const l of statusListeners) { try { l(); } catch { /* a listener's own problem */ } }
}

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

/** The workspace folders the settings name, blanks dropped. */
const settingsRoots = (cfg: Pick<ShellSettings, "shellRoots">): string[] => (cfg.shellRoots ?? []).map((r) => String(r).trim()).filter(Boolean);

/**
 * Whether the settings turn ml.sh on with a folder to run in: what a run's tools are decided by, so a run started while
 * the host is still connecting (a worker just woken) is offered the same tools. Whether the host answers is each call's.
 * @param cfg the settings
 */
export const shellTurnedOn = (cfg: Pick<ShellSettings, "shellEnabled" | "shellRoots">): boolean => cfg.shellEnabled === true && settingsRoots(cfg).length > 0;

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
    const roots = settingsRoots(cfg);
    if (!roots.length) return fail("no-roots", "No workspace folder is set: ml.sh runs programs only inside the folders named in Settings.");
    let port: chrome.runtime.Port;
    try { port = chrome.runtime.connectNative(HOST_NAME); }
    catch (e) { noteHello(false); return fail("not-installed", `The process host could not be started: ${(e as Error)?.message || e}`); }
    const client = new HostClient(nativePort(port));
    client.onClosed(() => { if (current?.client === client) { current = null; setStatus({ ...status, ready: false, error: "The process host closed the connection." }); } });
    let hello: HostHello;
    try { hello = await client.hello(); }
    catch (e) { client.close("hello failed"); noteHello(false); return fail("not-installed", notInstalledText((e as Error)?.message)); }
    noteHello(true);
    if (hello?.protocol !== HOST_PROTOCOL) { client.close("protocol"); return fail("protocol", `The process host speaks protocol ${hello?.protocol}; this extension speaks ${HOST_PROTOCOL}. Update one of them.`); }
    let configured: HostConfigured;
    try {
        configured = await client.configure({ roots, sandbox: cfg.shellSandbox !== false, ...(cfg.shellPath?.length ? { path: cfg.shellPath.map(String) } : {}) });
    } catch (e) {
        client.close("configure failed");
        return fail("config", `The process host refused the settings: ${(e as Error)?.message || e}`);
    }
    current = { client, hello, configured, key };
    setStatus({ enabled, ready: true, sandboxed: configured.sandboxed, host: { version: hello.version, platform: hello.platform, sandbox: hello.sandbox, ...(hello.tilde === true ? { tilde: true } : {}) }, roots: configured.roots });
    touch();
    return current;
}

/** What a port that would not start says, turned into what to do about it. */
function notInstalledText(why: string | undefined): string {
    return `The process host is not installed or would not start (${why || "no answer"}). The person installs it from Settings, Extension, Advanced, Programs (ml.sh) (\`settings/extension/advanced/shell\`), which shows the one line to paste.`;
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
    // Where timers can be unreferenced (Node, which the tests run the worker in), this one alone keeps nothing alive.
    (idleTimer as { unref?: () => void }).unref?.();
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
export const shellStatus = (): ShellStatus => ({ ...status, hostSeen, ...(hostAnswers === undefined ? {} : { hostAnswers }) });

/**
 * Ask whether a host answers, whatever the settings say: connect, say hello, close. For the "Check again" the person
 * presses in the installer guide, so ml.sh can be off and no folder set. Nothing is configured and nothing runs; extension
 * pages only (background.ts). A port already open answers without a second one.
 */
export async function probeShell(): Promise<ShellStatus> {
    await hostSeenRead;
    if (current && !current.client.isClosed) { noteHello(true); return shellStatus(); }
    try {
        const client = new HostClient(nativePort(chrome.runtime.connectNative(HOST_NAME)));
        try { await client.hello(); noteHello(true); } catch { noteHello(false); } finally { client.close("probe"); }
    } catch { noteHello(false); }
    return shellStatus();
}

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
 * run on this machine's real filesystem, `shellSandboxed` when such calls run under the OS sandbox, `shellTilde` when the
 * host expands a leading `~`. `shellContainer` stays absent: no container runner exists. Absent means no.
 */
export function shellCapabilities(): { shellHost?: true; shellSandboxed?: true; shellTilde?: true } {
    if (!status.ready) return {};
    return { shellHost: true, ...(status.sandboxed ? { shellSandboxed: true as const } : {}), ...(status.host?.tilde ? { shellTilde: true as const } : {}) };
}

/**
 * Be told when the status changes (the runtime's description re-announces its capabilities).
 * @param fn the listener
 */
export function onShellStatus(fn: () => void): void { statusListeners.add(fn); }

/** Whether a settings change touches the shell. */
export const SHELL_KEYS = ["shellEnabled", "shellRoots", "shellSandbox", "shellPath"] as const;
