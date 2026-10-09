// worker-vision-host.ts — the worker's VisionHost for a run's tab: the page answers only layout questions, as messages the worker checks; the capture, the model call and the drawing are the worker's.

// A vision body (look, locate, the verify after an action) asks its host where things are, for a capture, and for a
// model call (tools/vision-host.ts). Over this host the page's part is GEOMETRY only: each question goes to the run's
// page as `RUN_TOOL_IN_PAGE { runId, geometry: { seq, op, ...args } }`, pinned to the document the call is about, and
// the page answers from its DOM (page-geometry.ts `answerGeometry`). Nothing else crosses: no capture, no prompt, no
// reply, no model name. Every answer is rebuilt by `checkGeometry` before a body reads it, bounded by a per-question
// timeout, and correlated to its question. A malformed or late answer, or a document change, refuses the WHOLE call:
// the host remembers the first refusal and every later question gets it too (`refusal()`, `onWorkerHost`).
// Nothing builds one yet: look and locate move onto it in later PRs (docs/spec/SITE_ACCESS.md, slice 2 part 3).

import type { GeoView, Geometry, Shot, StitchBegin, TargetQuery, VisionHost } from "../tools/vision-host";
import { shootVia } from "../ml/ml-vision";
import { workerRaster, type Raster } from "../raster";
import { checkGeometry, DPR_MAX, GEOMETRY_MOVED, GEOMETRY_REFUSED, GEOMETRY_SLOW, GEOMETRY_UNREACHABLE, STITCH_TILES, type GeoAsked, type GeoOp } from "./geometry-check";
import { delegateSend } from "./sw-run-host";
import { recordRunLog } from "./sw-run-log";
import { topDocument, visionMemoryFor, workerShot, workerVisionChat } from "./worker-vision";

/** How long the page has to answer one layout question, on top of the frozen-tab watch every delegated send has. A
 *  live page answers in milliseconds; the slowest op (a stitch tile) waits two frames. */
export const GEOMETRY_OP_MS = 10_000;
/** The tallest a stitched image may be, in device pixels (it sizes the canvas the tiles are drawn on). */
export const STITCH_MAX_PX = 65_536;
/** How far a page's reported pixel ratio may be from the capture's own scale before the capture's is used. */
const DPR_TOLERANCE = 0.02;
/** How long a capture taken to measure the pixel ratio stays the next capture a body asks for. */
const PENDING_MS = 2_000;


/** A worker host: a VisionHost that also says whether the call it serves was refused, and why. */
export interface WorkerVisionHost extends VisionHost {
    /** The first refusal any question of this call met (the sentence for the tool's result), or null. */
    refusal(): string | null;
}

/** What a test may set: the per-question bound, the raster (a vm has no OffscreenCanvas), and the capture's bounds. */
export interface WorkerVisionHostOpts { opMs?: number; raster?: Raster; rectsMs?: number; cdpTimeoutMs?: number }

/**
 * The worker's VisionHost for one vision call of a run on `tabId`, pinned to `documentId`: every layout question and
 * every capture of the call is about that document or is refused.
 * @param runId the run (its sub-call spend, its vision memory, its execution log)
 * @param tabId the run's tab
 * @param documentId the tab's top-frame document the call is about
 * @param opts test seams ({@link WorkerVisionHostOpts})
 * @returns the host; `refusal()` says whether the call must be refused
 */
export function workerVisionHost(runId: string, tabId: number, documentId: string, opts: WorkerVisionHostOpts = {}): WorkerVisionHost {
    const opMs = opts.opMs ?? GEOMETRY_OP_MS;
    let refused: string | null = null;
    let seq = 0;
    let stitchIds = 0;
    let stitch: { id: number; total: number; tiles: number } | null = null;
    let dims: { w: number; h: number } | null = null;                 // the last capture's pixel size
    let pending: { shot: Required<Shot>; at: number } | null = null;  // a capture taken to measure, not yet handed out
    let noted = false;

    /** Refuse the call: the first sentence sticks, and is what this and every later question throws. */
    const fail = (sentence: string): never => { refused ??= sentence; throw new Error(refused); };
    /** Whether the tab still holds the call's document. */
    const sameDocument = async (): Promise<boolean> => (await topDocument(tabId).catch(() => null)) === documentId;

    /** Ask the page one question, and rebuild its answer. */
    const ask = async (op: GeoOp, args: Record<string, unknown>, asked: GeoAsked = {}, stitchId?: number): Promise<unknown> => {
        if (refused) throw new Error(refused);
        const n = ++seq;
        const geometry = { ...args, seq: n, op, ...(stitchId !== undefined ? { stitch: stitchId } : {}) };
        const SLOW = Symbol("slow");
        let timer: ReturnType<typeof setTimeout> | undefined;
        const sent = Promise.resolve().then(() => delegateSend(tabId, { type: "RUN_TOOL_IN_PAGE", payload: { runId, geometry } }, documentId));
        sent.catch(() => { /* a late failure after the timeout is already a refusal */ });
        let env: unknown;
        try {
            env = await Promise.race([sent, new Promise<typeof SLOW>((r) => { timer = setTimeout(() => r(SLOW), opMs); })]);
        } catch {
            // A send pinned to a document the tab no longer holds is refused by the browser, and is a document change.
            return fail((await sameDocument()) ? GEOMETRY_UNREACHABLE : GEOMETRY_MOVED);
        } finally { clearTimeout(timer); }
        if (env === SLOW) return fail(GEOMETRY_SLOW);
        const g = (env as { geometry?: unknown } | null)?.geometry as { seq?: unknown; stitch?: unknown; reply?: unknown; error?: unknown } | undefined;
        if (!g || typeof g !== "object" || g.seq !== n || g.error !== undefined || (stitchId !== undefined && g.stitch !== stitchId)) return fail(GEOMETRY_REFUSED);
        const checked = checkGeometry(op, g.reply, asked);
        return checked.ok ? checked.value : fail(GEOMETRY_REFUSED);
    };

    /** A capture of the call's document, its size kept for the pixel ratio. A shot of another document refuses the call. */
    const shoot = async (): Promise<Required<Shot>> => {
        if (refused) throw new Error(refused);
        let shot: Required<Shot>;
        try { shot = await workerShot(tabId, { documentId, ...(opts.rectsMs !== undefined ? { rectsMs: opts.rectsMs } : {}), ...(opts.cdpTimeoutMs !== undefined ? { cdpTimeoutMs: opts.cdpTimeoutMs } : {}) }); }
        catch (e) { if (!(await sameDocument())) fail(GEOMETRY_MOVED); throw e; }
        dims = { w: shot.w, h: shot.h };
        return shot;
    };

    /**
     * The pixel ratio a crop of this call uses: the capture's width over the viewport's, cross-checked with the
     * heights. More than 2% from what the page reported, the capture's own scale is used and the run's log says so.
     */
    const scaleFor = (v: GeoView, d: { w: number; h: number }): number => {
        const sw = d.w / v.w, sh = d.h / v.h;
        if (!(sw > 0 && sw <= DPR_MAX)) return fail(GEOMETRY_REFUSED);
        const off = Math.abs(sw - v.dpr) > DPR_TOLERANCE * v.dpr;
        // A shorter capture is a crop of the top (as under the debugger's infobar), so the width decides; a height that
        // disagrees is only noted.
        const aspect = Math.abs(sh - sw) > DPR_TOLERANCE * sw;
        if ((off || aspect) && !noted) {
            noted = true;
            recordRunLog(runId, { level: "warn", subsystem: "routing", kind: off ? "dpr-mismatch" : "capture-aspect", detail: { reported: v.dpr, measured: Math.round(sw * 1000) / 1000, height: Math.round(sh * 1000) / 1000 } });
        }
        return off ? sw : v.dpr;
    };

    /** Forget a measuring capture once the page may have scrolled under it. */
    const scrolled = (): void => { pending = null; };

    const geo: Geometry = {
        view: async () => {
            const v = await ask("view", {}) as GeoView;
            if (!dims) pending = { shot: await shoot(), at: Date.now() };
            return { ...v, dpr: scaleFor(v, dims!) };
        },
        target: async (q: TargetQuery) => {
            if (!("token" in q) && q.scroll !== false) scrolled();
            if ("selector" in q && q.measure !== undefined && q.measure !== "viewport" && q.measure !== "client") throw new Error("measure is viewport or client");
            return ask("target", { ...q }) as ReturnType<Geometry["target"]>;
        },
        marks: async (q) => ask("marks", { ...q }, { badge: q.badge }) as ReturnType<Geometry["marks"]>,
        snap: async (q) => ask("snap", { ...q }) as ReturnType<Geometry["snap"]>,
        cell: async (q) => ask("cell", { ...q }) as ReturnType<Geometry["cell"]>,
        mint: async (q) => ask("mint", { ...q }, { mint: "box" in q ? "box" : "pt" }) as ReturnType<Geometry["mint"]>,
        legend: async (q) => ask("legend", { ...q }) as ReturnType<Geometry["legend"]>,
        crossesText: async (q) => ask("crossesText", { ...q }) as ReturnType<Geometry["crossesText"]>,
        focus: async () => ask("focus", {}) as ReturnType<Geometry["focus"]>,
        stitchBegin: async () => {
            // The stitch's pixel ratio sizes its canvas, so it is the measured one too.
            const { dpr } = await geo.view();
            const id = ++stitchIds;
            scrolled();
            const b = await ask("stitchBegin", {}, {}, id) as StitchBegin;
            if (b.total * dpr > STITCH_MAX_PX) return fail(GEOMETRY_REFUSED);
            stitch = { id, total: b.total, tiles: 0 };
            return { ...b, dpr };
        },
        stitchTile: async ({ y }) => {
            const s = stitch;
            if (!s) throw new Error("stitchTile before stitchBegin");
            // The worker's loop, not the page's isLast, ends a stitch: a page that never reaches its bottom gets nine tiles.
            if (++s.tiles > STITCH_TILES) return fail(GEOMETRY_REFUSED);
            scrolled();
            return ask("stitchTile", { y }, { total: s.total }, s.id) as ReturnType<Geometry["stitchTile"]>;
        },
        stitchEnd: async () => {
            const s = stitch;
            stitch = null;
            if (!s) return;
            scrolled();
            // Restores the page's scroll and overlays. Not sent once the call is refused (the page is gone, or is the
            // one that broke it), and never throws over the stitch's own error: a failure here is still the call's refusal.
            if (refused) return;
            await ask("stitchEnd", {}, {}, s.id).catch(() => undefined);
        },
    };

    const host: WorkerVisionHost = {
        capture: async () => {
            const p = pending;
            pending = null;
            if (p && Date.now() - p.at <= PENDING_MS) {
                if (refused) throw new Error(refused);
                return p.shot;
            }
            return shoot();
        },
        geo,
        shoot: (target, o) => shootVia(host, target, o),
        chat: (prompt, o) => {
            if (refused) return Promise.reject(new Error(refused));
            return workerVisionChat(runId, prompt, o);
        },
        raster: opts.raster ?? workerRaster,
        memory: visionMemoryFor(runId),
        refusal: () => refused,
    };
    return host;
}

/**
 * Run a vision body over a worker host, and hand back the host's refusal instead of whatever the body made of a
 * refused call (a body that swallows an error, as the legend does, would otherwise return half a result).
 * @param host the call's host
 * @param body the tool body over it
 * @returns the body's result, or the refusal sentence
 */
export async function onWorkerHost<T>(host: WorkerVisionHost, body: () => Promise<T>): Promise<T | string> {
    try {
        const r = await body();
        return host.refusal() ?? r;
    } catch (e) {
        const r = host.refusal();
        if (r) return r;
        throw e;
    }
}
