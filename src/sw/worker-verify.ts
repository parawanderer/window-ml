// worker-verify.ts — the verify after an action of a run whose vision is the worker's: the page's request checked field by field, then the capture, the crop and the reader's call made in the worker.

// A click, type or wait with `verify: true` ends with a picture of what the action did. In a run the worker built (or was
// handed, `makeWorkerRun`), the page takes no picture and calls no model for it: it hands back a `verifyRequest`
// (builtin-tools.ts) saying what to picture, and the worker runs the same body (`captureVerify`,
// `captureVerifyElement`) over its own vision host, which asks the page for geometry only (worker-vision-host.ts). The
// request is the page's word: `checkVerifyRequest` rebuilds it from the fields its tool can ask for, bound to the call's
// own arguments, and a malformed one skips the verify with a fixed note. The CDP ring-backs (a click or a type the
// worker did through the debugger, a navigate's destination) build their request here, with no page involved.

import type { PageToolEnvelope, SubcallUsage, ToolContext, ToolFeedback, ToolResult, VerifyRequest } from "../contract";
import { captureVerify, captureVerifyElement } from "../tools/builtin-tools";
import { GEO_MAX, TEXT_CAPS } from "./geometry-check";
import { onWorkerHost, workerVisionHost, type WorkerVisionHostOpts } from "./worker-vision-host";
import { ensureRunState, spendDelta, workerSpend } from "./worker-tools";

/** The note for a request the worker would not read. Never says what was wrong: that is the page's to learn. */
export const VERIFY_REFUSED = "\n\n(The page's request for the verify was malformed, so no verify was taken. Look at the page to see the result.)";
/** The note for a verify with no document to pin it to: the browser does not say which page the tab holds. */
const NO_DOCUMENT = "\n\n(No verify: the browser does not say which page the tab holds now. Look at the page to see the result.)";

/** What each tool's verify is called in its sentences, and which requests it can make: a click pictures the area
 *  around a point, a type the field it typed into (or the area where it was), a wait the viewport. */
const ASKS: Record<string, { verb: string; kinds: readonly VerifyRequest["kind"][] }> = {
    click: { verb: "clicked", kinds: ["area"] },
    type: { verb: "typed", kinds: ["area", "element"] },
    wait: { verb: "wait", kinds: ["viewport"] },
};

/** Thrown inside a rebuild to refuse the whole request. */
class Malformed extends Error {}
const no = (): never => { throw new Malformed(); };
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : no());
/** A finite number, clamped to ±{@link GEO_MAX}, as every coordinate a page reports. */
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? Math.max(-GEO_MAX, Math.min(GEO_MAX, v)) : no());
const point = (v: unknown): { x: number; y: number } => { const p = obj(v); return { x: num(p.x), y: num(p.y) }; };
/** Control and format characters and the line separators, as geometry-check folds them in page text. */
const CONTROL = /[\p{Cc}\p{Cf}\u2028\u2029]+/gu;
/** The call's `index` argument as the tool reads it: a whole number, else 0. */
const indexOf = (args: Record<string, unknown>): number => (Number.isInteger(args.index) && (args.index as number) >= 0 ? args.index as number : 0);

/**
 * The verify a page asked for after one of its tool calls, rebuilt, or null when the call may not have one or the
 * request is malformed. Only a click, type or wait the model asked to verify may have one, of the kind that tool makes;
 * an element is the call's own selector and index (the page names no other element), with no backtick, control or
 * format character and at most 1000 long, as geometry-check holds a selector; its line is folded and cut to 200; every
 * coordinate is finite and clamped; any other field is dropped.
 * @param raw the page's `verifyRequest`
 * @param call the tool call it answers: its name and the model's arguments
 * @returns the rebuilt request, or null
 */
export function checkVerifyRequest(raw: unknown, call: { name: string; args: Record<string, unknown> }): VerifyRequest | null {
    const ask = Object.hasOwn(ASKS, call.name) ? ASKS[call.name] : undefined;
    if (!ask || !call.args?.verify) return null;
    try {
        const r = obj(raw);
        if (!ask.kinds.includes(r.kind as VerifyRequest["kind"])) no();
        if (r.kind === "viewport") return { kind: "viewport" };
        if (r.kind === "area") {
            if (r.mutated !== undefined && typeof r.mutated !== "boolean") no();
            return { kind: "area", center: point(r.center), ...(r.mutated ? { mutated: true } : {}) };
        }
        const selector = r.selector;
        if (typeof selector !== "string" || selector !== call.args.selector || selector.length > TEXT_CAPS.selector || /[\p{Cc}\p{Cf}\u2028\u2029`]/u.test(selector)) no();
        // The call's own index (a whole number), so nothing else passes.
        const index = r.index === undefined ? 0 : r.index;
        if (index !== indexOf(call.args)) no();
        if (r.line !== undefined && typeof r.line !== "string") no();
        const line = typeof r.line === "string" ? r.line.replace(CONTROL, " ").slice(0, TEXT_CAPS.line) : undefined;
        return { kind: "element", selector: selector as string, ...(index ? { index: index as number } : {}), ...(line ? { line } : {}), ...(r.center !== undefined ? { center: point(r.center) } : {}) };
    } catch (e) { if (e instanceof Malformed) return null; throw e; }
}

/** The verb a tool's verify uses in its sentences ("Here's the area where you clicked"). */
export const verifyVerb = (name: string): string => ASKS[name]?.verb ?? "acted";

/** What a verify adds to a tool's result: the text to append, the picture for a driver that sees, the feedback the
 *  sidebar and the exports show, and what its model call spent. */
export interface VerifyOutcome { content: string; image?: string; imageLabel?: string; feedback?: ToolFeedback; subUsage?: SubcallUsage }

/** What to picture, with the worker's own request kinds: the focused element (a trusted type into `@focus`). */
export type WorkerVerify = VerifyRequest | { kind: "focus" };

/**
 * Take a verify in the worker, over a vision host pinned to one document of the run's tab: the page answers geometry
 * only, and the capture, the crop and the reader's call are the worker's. A refused call (the page's geometry was
 * malformed or slow, or the tab went to another document) gives its sentence instead of a picture.
 * @param runId the run (its vision facts, its sub-call spend)
 * @param tabId the run's tab
 * @param documentId the document the action ran in (null: none known, no verify)
 * @param req what to picture
 * @param verb the action, in the verify's sentences
 * @param vision whether the driver sees, and its reader
 * @param tabUrl the tab's URL, for the run's worker state
 * @param opts the host's test seams
 * @returns what to add to the tool's result
 */
export async function workerVerify(runId: string, tabId: number, documentId: string | null | undefined, req: WorkerVerify, verb: string,
    vision: { driverSees: boolean; visionModel: string | null }, tabUrl: () => string, opts: WorkerVisionHostOpts = {}): Promise<VerifyOutcome> {
    if (!documentId) return { content: NO_DOCUMENT };
    ensureRunState(runId, tabId, tabUrl);
    const before = workerSpend(runId);
    const host = workerVisionHost(runId, tabId, documentId, opts);
    // The bodies read only these two facts of a context.
    const ctx = { driverSees: vision.driverSees, visionModel: vision.visionModel } as ToolContext;
    const r = await onWorkerHost(host, async () => {
        if (req.kind === "viewport") return captureVerify(host, ctx, null, verb);
        if (req.kind === "area") return captureVerify(host, ctx, req.center, verb, !!req.mutated);
        if (req.kind === "focus") {
            const focused = await host.geo.focus();
            return focused ? captureVerifyElement(host, ctx, { focus: true }, verb, `the focused element ${focused.line}`) : captureVerify(host, ctx, null, verb);
        }
        // The whole field, else (it can't be shot) the area where it was before the action, as the page's own type does.
        const v = await captureVerifyElement(host, ctx, req.selector, verb, req.line !== undefined ? `the field ${req.line}` : undefined, req.index ?? 0);
        if (v.content || v.image || v.feedback) return v;
        return req.center ? captureVerify(host, ctx, req.center, verb, true) : { content: " Re-run look/findByText to see the result." };
    }).catch((): Partial<ToolResult> => ({}));
    const subUsage = spendDelta(before, workerSpend(runId));
    if (typeof r === "string") return { content: `\n\n(No verify: ${r})`, ...(subUsage ? { subUsage } : {}) };
    return { content: r.content || "", ...(r.image ? { image: r.image, imageLabel: r.imageLabel } : {}), ...(r.feedback ? { feedback: r.feedback } : {}), ...(subUsage ? { subUsage } : {}) };
}

/** The tools whose vision still runs in the page in a run whose vision is the worker's: their picture, their reader's
 *  description and its spend are still the page's to report, until look and locate move (slice 2 part 3, PRs 6 and 7). */
export const PAGE_VISION_TOOLS: ReadonlySet<string> = new Set(["look", "locate"]);

/**
 * A page's envelope for a run whose vision is the worker's, without the fields through which a capture, a reader's
 * reply or a spend would enter the run: the inline image(s) the model is shown, the feedback the sidebar and the exports
 * show as what the model was fed, and the sub-call spend counted into the run's tally. A verify is the worker's to take
 * (`verifyRequest`); a page that takes one anyway gains nothing by it.
 * @param env what the page answered
 * @param name the tool the envelope is for
 * @returns the envelope without those fields (as it came, for a tool still in {@link PAGE_VISION_TOOLS})
 */
export function withoutPageVision<T>(env: T, name: string | undefined): T {
    if (!env || typeof env !== "object" || (name && PAGE_VISION_TOOLS.has(name))) return env;
    const { image: _image, imageLabel: _label, images: _images, feedback: _feedback, subUsage: _sub, ...rest } = env as Partial<PageToolEnvelope>;
    return rest as T;
}

/** Whether the model asked this call for a verify the worker may take: a click, type or wait with `verify` set. */
export const verifyAsked = (name: string, args: Record<string, unknown> | undefined): boolean => Object.hasOwn(ASKS, name) && !!args?.verify;
