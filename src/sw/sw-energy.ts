// sw-energy.ts — the worker's energy hold: while a local runtime generates for one of our sessions, keep the event
// stream up (with or without a resource panel open) and write each session's share of what the box drew, at each of its
// generations' ends, to storage.local. The page reads the stored record, never the frames
// (docs/spec/SESSION_SUMMARY.md, "Energy and its cost"; the attribution is src/spend/energy.ts).
//
// One stretch at a time, because there is one event stream: every session generating at once shares it. A call holds
// the stream only for a server already SEEN reporting power: the first sample frame of each connection says whether it
// does, from a panel's stream or an earlier hold, and the answer is kept per origin. So a cloud backend, or a stock
// Ollama, costs no request at all; the price is that a box is first learned about while a resource panel streams it.

import { defineState } from "../state-registry";
import { hintSession } from "../contract/contract-run";
import { EnergyStretch, cutOpen, hasPower, type StretchRecord } from "../spend/energy-stretch";
import { getConfig } from "./sw-llm";
import { electricityForCall } from "./sw-prices";
import { holdResourceEvents, onResourceFrame, recentFrames } from "./sw-events";
import type { MlConfig } from "../contract/contract-config";

/** storage.local key of a session's records (`hint.session`, `wml-<hash>`): `{ <stretch id>: StretchRecord }`. */
export const energyKey = (session: string): string => `ml_energy_${session}`;

defineState({
    id: "session.energy", scope: "session", realm: "worker", audience: "human", lostOn: [],
    describe: "A session's local-model energy and cost, one entry per stretch of generations, written at each generation's end; `cut` marks a stretch the worker stopped inside, whose tail is missing.",
    read: async ({ runId }) => {
        if (!runId) return undefined;
        const key = energyKey(hintSession(runId));
        const got = await chrome.storage.local.get(key).catch(() => ({} as Record<string, unknown>));
        return (got[key] as Record<string, StretchRecord> | undefined) ?? undefined;
    },
});

/** storage.local key of what each server origin's stream said about power: `{ <origin>: true | false }`. */
export const POWER_KEY = "ml_power_seen";

interface Live { s: EnergyStretch; release: () => void; unlisten: () => void; timer: ReturnType<typeof setTimeout> | null }
let live: Live | null = null;   // state: plumbing — the readings it holds are dropped at its close; what it wrote is `session.energy`
let powerBy: Promise<Record<string, boolean>> | null = null;   // state: cache — of POWER_KEY, read once per worker

const originOf = (c: MlConfig): string | null => { try { return new URL(c.chatUrl).origin; } catch { return null; } };

/** What the stream last said about `origin`'s power, or undefined when it has not been seen. */
async function poweredAt(origin: string): Promise<boolean | undefined> {
    powerBy ??= chrome.storage.local.get(POWER_KEY).then((g) => ({ ...(g[POWER_KEY] as Record<string, boolean> | undefined ?? {}) })).catch(() => ({}));
    return (await powerBy)[origin];
}

/** Keep what a connection's first sample said about the server's power, when it changed. */
async function notePower(powered: boolean): Promise<void> {
    const origin = originOf(await getConfig());
    if (!origin || (await poweredAt(origin)) === powered) return;
    const all = await powerBy!;
    all[origin] = powered;
    await chrome.storage.local.set({ [POWER_KEY]: { ...all } }).catch(() => {});
}

/** Listen to every connection for whether its server reports power (its first sample after a hello). Once, at start. */
export function watchPower(): () => void {
    let next = true;
    return onResourceFrame((frame) => {
        if (frame.kind === "hello") next = true;
        else if (frame.kind === "sample" && next) { next = false; void notePower(hasPower(frame)).catch(() => {}); }
    });
}

// Serialized: two sessions' records written at one gen.end would otherwise race the read-modify-write.
let writing: Promise<void> = Promise.resolve();   // state: plumbing
function store(session: string, id: string, rec: StretchRecord): void {
    writing = writing.then(async () => {
        const key = energyKey(session);
        const got = await chrome.storage.local.get(key);
        await chrome.storage.local.set({ [key]: { ...(got[key] as Record<string, StretchRecord> | undefined ?? {}), [id]: rec } });
    }).catch(() => { /* storage unavailable: nothing to keep it in */ });
}

/** End the stretch: write it complete (when the runtime reported power) and let the stream go. */
function close(write: boolean): void {
    const l = live;
    if (!l) return;
    live = null;
    if (l.timer) clearTimeout(l.timer);
    l.unlisten();
    l.release();
    if (write && l.s.powered) l.s.record(false);
}

/** Re-arm the close for when the stretch may end, or disarm it while a request is out. */
function arm(): void {
    const l = live;
    if (!l) return;
    if (l.timer) { clearTimeout(l.timer); l.timer = null; }
    const at = l.s.closesAt();
    if (at != null) l.timer = setTimeout(() => close(true), Math.max(0, at - Date.now()));
}

/** A model call for `session` is starting: when its server has been seen reporting power, open the stretch (or join
 *  it) and hold the stream. Returns what to call when the call ends. Wired as sw-llm.ts's request observer. */
export function energyRequest(session: string): () => void {
    let ended = false, end: (() => void) | null = null;
    void (async () => {
        const config = await getConfig();
        const origin = originOf(config);
        if (!origin || (await poweredAt(origin)) !== true) return;
        end = join(session, config);
        if (ended) end();
    })().catch(() => {});
    return () => { ended = true; end?.(); };
}

/** Join the live stretch, opening it (and the hold) when there is none. */
function join(session: string, config: MlConfig): () => void {
    if (!live) {
        const s = new EnergyStretch(Date.now(), store);
        const l: Live = { s, release: () => {}, unlisten: () => {}, timer: null };
        live = l;
        const feed = (frame: Parameters<EnergyStretch["frame"]>[0], at: number): void => {
            if (live !== l) return;
            const ours = s.frame(frame, at);
            if (s.powered === false) { close(false); return; }
            if (ours) arm();
        };
        // Frames this connection already holds come first: a panel may have had the stream up, and then no backfill
        // arrives to find the rest in.
        for (const { frame, at } of recentFrames()) feed(frame, at);
        if (live === l) {
            l.unlisten = onResourceFrame(feed);
            l.release = holdResourceEvents();
        }
    }
    const l = live;
    if (!l) return () => {};
    if (l.timer) { clearTimeout(l.timer); l.timer = null; }
    l.s.requestStarted(session);
    l.s.setPrice(session, electricityForCall(config));
    let ended = false;
    return () => {
        if (ended || live !== l) return;
        ended = true;
        l.s.requestEnded(session, Date.now());
        arm();
    };
}

/** At a worker's start: every record still `open` was written by a worker that died inside its stretch, so it is marked
 *  `cut`. Runs before any write this worker makes. */
export function cutOpenStretches(): Promise<void> {
    return (writing = writing.then(async () => {
        const all = await chrome.storage.local.get(null);
        const fix: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(all)) {
            if (!k.startsWith("ml_energy_") || !v || typeof v !== "object") continue;
            const cut = cutOpen(v as Record<string, StretchRecord>);
            if (cut) fix[k] = cut;
        }
        if (Object.keys(fix).length) await chrome.storage.local.set(fix);
    }).catch(() => { /* storage unavailable */ }));
}

/** Test seam: forget the stretch between cases. */
export function _resetEnergy(): void {
    if (live?.timer) clearTimeout(live.timer);
    live?.unlisten(); live?.release();
    live = null; powerBy = null; writing = Promise.resolve();
}
