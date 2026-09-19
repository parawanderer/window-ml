// sw-hub.ts — this browser as a runtime on a hub, in the worker: read what pairing stored in the keyring, keep the
// connection up (hub-runtime.ts), and say where it stands. Pairing itself happens in an extension PAGE, which holds the
// offering socket while a person carries the code (the worker could be stopped in the meantime); the page tells the
// worker when it is done, and the worker reads the keyring again.
//
// The connection keeps the worker alive while it is up: the hub pings every 20 s, and a websocket's traffic extends a
// service worker's life. When the browser stops the worker anyway, the alarm below starts it again within a minute.
import { CertificateBody } from "./proto/wmlhub/v1/identity.gen";
import { HubClient } from "./hub/client";
import { bytes } from "./hub/hpke";
import { Keyring } from "./hub/keyring";
import { Role } from "./hub/wire";
import { HubRuntime, type HubRuntimeStatus } from "./hub-runtime";
import { DeviceRegistry, type DeviceState } from "./hub-devices";
import type { DeviceInfo } from "./session-host";
import { LOCAL_RUNTIME, localRuntimeId, runSessionCommand, sessionServer } from "./sw-sessions";

/** Where this browser stands with a hub, for Settings. `unpaired` is the usual state and not an error. */
export type HubState =
    | { state: "unpaired" }
    | ({ hubUrl: string; hubName: string } & HubRuntimeStatus);

const ALARM = "ml-hub-keepalive";
/** The connection's recent history, in storage so it outlives the worker: what an idle test reads afterwards. */
const LOG_KEY = "ml_hub_log";
const LOG_MAX = 200;

/** One line of that history. */
export interface HubLogEntry { atMs: number; event: string }

let logging: Promise<void> = Promise.resolve();
function note(event: string): void {
    logging = logging.then(async () => {
        const got = await chrome.storage.local.get({ [LOG_KEY]: [] });
        const log = [...(got[LOG_KEY] as HubLogEntry[]), { atMs: Date.now(), event }].slice(-LOG_MAX);
        await chrome.storage.local.set({ [LOG_KEY]: log });
    }).catch(() => { /* a log line is not worth failing anything over */ });
}

/** When this worker last proved it was running, so a later start can say how long the connection was down. */
const ALIVE_KEY = "ml_hub_alive";
const ALIVE_EVERY_MS = 60_000;
/** When this worker's module ran: a wake-up. An alarm arriving just after it is what did the waking. */
const wokeAtMs = Date.now();
let aliveTimer: ReturnType<typeof setInterval> | null = null;

/** Start stamping `ALIVE_KEY` once a minute while connected; a timer does not keep a worker alive, so this costs none. */
function stampAlive(): void {
    const stamp = () => { void chrome.storage.local.set({ [ALIVE_KEY]: Date.now() }).catch(() => {}); };
    stamp();
    aliveTimer ??= setInterval(stamp, ALIVE_EVERY_MS);
}

/** The connection's history, oldest first: every start, every state it reached, and why it went offline. */
export async function hubLog(): Promise<HubLogEntry[]> {
    return ((await chrome.storage.local.get({ [LOG_KEY]: [] }))[LOG_KEY] as HubLogEntry[]);
}
let runtime: HubRuntime | null = null;
let status: HubState = { state: "unpaired" };
let starting: Promise<void> | null = null;
let devices: DeviceRegistry | null = null;

/** Where the connection stands now. */
export function hubState(): HubState {
    return status;
}

/**
 * Start the connection if the keyring says this browser is a paired RUNTIME and it is not already running. Safe to
 * call as often as anything likes: at worker start, on the alarm, after a page finished pairing.
 */
export function ensureHubRuntime(): Promise<void> {
    if (runtime) return Promise.resolve();
    starting ??= (async () => {
        let ring: Keyring | null = null;
        try {
            ring = await Keyring.open();
            const me = await ring.load();
            const m = me?.membership;
            if (!me || !m) { unpaired(); return; }
            // A browser that created the account (or was paired as a client) holds a membership too, but is not a
            // runtime to anyone: only a leaf issued for ROLE_RUNTIME connects as one.
            const leaf = CertificateBody.decode(m.chain[0].body);
            if (leaf.role !== Role.ROLE_RUNTIME) { unpaired(); return; }
            const where = { hubUrl: m.hubUrl, hubName: m.hubName };
            // The allowlist lives beside the keys. Each write opens the keyring for itself: the worker may outlive
            // many of them, and a database held open for the worker's life blocks an upgrade from another context.
            devices = await DeviceRegistry.open(
                () => ring!.record<DeviceState>("devices"),
                async (st) => { const w = await Keyring.open(); try { await w.putRecord("devices", st); } finally { w.close(); } },
            );
            const r = new HubRuntime({
                membership: m,
                devices,
                signer: me.identity,
                side: {
                    localIds: [localRuntimeId(), LOCAL_RUNTIME],
                    list: () => sessionServer.index.list(),
                    watch: (sink) => sessionServer.watch(sink),
                    command: (c) => runSessionCommand(c),
                },
                connect: () => HubClient.connect({
                    url: m.hubUrl, hubName: m.hubName, identity: me.identity, agreement: me.agreement,
                    chain: m.chain, accountRoot: bytes(m.accountRoot), role: Role.ROLE_RUNTIME,
                }),
                onStatus: (s) => {
                    status = { ...where, ...s };
                    note(s.state === "offline" ? `offline: ${s.reason}` : s.state === "online" ? `online (${s.devices} devices)` : s.state);
                },
            });
            runtime = r;
            // A worker that was stopped logs nothing on its way out, so the start says when the last one was last seen.
            const last = (await chrome.storage.local.get({ [ALIVE_KEY]: 0 }).catch(() => ({})) as Record<string, number>)[ALIVE_KEY];
            note(`start (${m.hubName})${last ? `; a worker was last alive at ${new Date(last).toLocaleString(undefined, { hour12: false })}` : ""}`);
            stampAlive();
            // Only while paired: an alarm that woke every browser's worker each minute to find nothing to do would
            // cost the ones that never pair.
            try { chrome.alarms?.create(ALARM, { periodInMinutes: 1 }); } catch { /* no alarms */ }
            void r.run().finally(() => { if (runtime === r) runtime = null; });
        } catch (e) {
            unpaired();
            console.warn("[window.ml] hub runtime did not start:", e);
        } finally {
            ring?.close();
            starting = null;
        }
    })();
    return starting;
}

function unpaired(): void {
    status = { state: "unpaired" };
    if (aliveTimer) { clearInterval(aliveTimer); aliveTimer = null; }
    try { void chrome.alarms?.clear(ALARM); } catch { /* no alarms */ }
}

/** The account's devices as this runtime lists them, for its own Settings; empty when unpaired. */
export function hubDevices(): DeviceInfo[] {
    return devices?.list() ?? [];
}

/** Revoke a device from this browser's own Settings: see `HubRuntime.revoke`. */
export async function revokeHubDevice(principal: string): Promise<"revoked" | "already" | "self" | "unpaired"> {
    await ensureHubRuntime();
    return runtime ? runtime.revoke(principal) : "unpaired";
}

/** Stop the connection: this browser left its account, or is about to pair again. */
export function stopHubRuntime(): void {
    runtime?.stop();
    runtime = null;
    devices = null;
    unpaired();
}

try {
    chrome.alarms?.onAlarm.addListener((a) => {
        if (a.name !== ALARM) return;
        // Within a few seconds of the module running, this alarm is what started the worker.
        if (Date.now() - wokeAtMs < 5_000) note("woken by the keepalive alarm");
        void ensureHubRuntime();
    });
} catch { /* no alarms (a test harness) */ }
void ensureHubRuntime();
