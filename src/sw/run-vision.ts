// run-vision.ts — the vision facts a run's look, locate and verify use in the worker, held to what the worker can vouch for.

// A run the worker built carries vision facts the worker resolved itself (run-assembly.ts). A page-built run handed to
// the worker (`makeWorkerRun`) carries the facts its page wrote in START_RUN: page text. Before the worker's look,
// locate or verify use them, they come through `runVision`, the one place: a model name is used only when the server
// lists it and the model filter lets it through (as sw-sessions `checkModel` holds a person's choice), else it is
// dropped and the run has no such model; whether the driver sees is the worker's own answer for the driver model
// (`_modelSees`, the capability source the worker-built path resolves its reader with), never the page's; and the
// grounding range is a whole number or the default.

import { DEFAULT_GROUNDING_RANGE } from "../contract";
import type { RebuildConfig } from "../contract";
import { getConfig, listAvailableModels } from "./sw-llm";
import { modelFilterAllows } from "../contract/contract-config";
import { workerMl } from "./worker-ml";
import { defineState } from "../state-registry";

/** The runs whose vision facts the worker resolved itself: the runs it assembled (sw-run-start.ts). Never set from a
 *  message, so neither a page's START_RUN nor a hand-over can claim it; after an eviction it is empty, and a run's facts
 *  are then checked as a handed-over run's are (a worker-built run's pass: they name models the runtime offers). */
const workerFacts = new Set<string>();   // see the defineState below

defineState({
    id: "run.visionFactsByWorker", scope: "run", realm: "worker", audience: "human", lostOn: ["worker-eviction"], heldOnly: true,
    describe: "Whether the worker chose this run's vision models itself; if not, they are checked against the models this runtime offers before each use.",
    read: ({ runId }) => (runId && workerFacts.has(runId) ? true : undefined),
});

/** Record that the worker resolved `runId`'s vision facts itself (it assembled the run). */
export function noteWorkerVision(runId: string): void { workerFacts.add(runId); }

/** Whether the worker resolved `runId`'s vision facts itself. */
export function workerWroteVision(runId: string): boolean { return workerFacts.has(runId); }

/** The largest grounding coordinate range accepted from a run's facts; past it (or not a whole number from 1) the
 *  default is used. */
export const GROUNDING_RANGE_MAX = 100_000;

/** A model name from a run's facts: a non-empty string, else none. */
export const modelName = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

/** A grounding range from a run's facts: a whole number from 1 to {@link GROUNDING_RANGE_MAX}, else the default. */
export const rangeOf = (v: unknown): number => (Number.isInteger(v) && (v as number) >= 1 && (v as number) <= GROUNDING_RANGE_MAX ? v as number : DEFAULT_GROUNDING_RANGE);

/** The vision facts a run's look, locate and verify are built from in the worker. */
export interface RunVision {
    /** Whether the driver sees the pixels itself (native look, an inline crop). */
    driverSees: boolean;
    /** The reader: the driver itself when it sees, else the run's delegated reader, or none. */
    visionModel: string | null;
    /** The grounding model, or none. */
    groundingModel: string | null;
    /** The grounding model's coordinate range. */
    groundingRange: number;
}

/** What `runVision` asks of the runtime (a test seam): the server's model list, the model filter, and whether a model
 *  takes images. */
export interface RunVisionDeps {
    listed(): Promise<string[]>;
    config(): Promise<{ model?: string; modelFilter?: string }>;
    sees(model: string | null): Promise<boolean>;
}

const realDeps: RunVisionDeps = {
    listed: async () => (await listAvailableModels()).ids,
    config: () => getConfig(),
    sees: (model) => workerMl("")._modelSees(model),
};

/**
 * A run's vision facts as the worker may use them.
 * @param rebuild the run's rebuild config (the worker's own copy)
 * @param worker whether the worker wrote these facts itself (it built the run): then they are used as they are, held to
 *   their kind only; else (a page-built run handed to the worker) every model name is checked against the server's list
 *   and the model filter, and whether the driver sees is asked of the driver model
 * @param driverModel the run's driver model now (null: the configured default)
 * @param deps the runtime ({@link RunVisionDeps}; the real one by default)
 * @returns the facts
 */
export async function runVision(rebuild: Partial<RebuildConfig> | undefined, worker: boolean, driverModel: string | null, deps: RunVisionDeps = realDeps): Promise<RunVision> {
    const groundingRange = rangeOf(rebuild?.groundingRange);
    if (worker) return { driverSees: rebuild?.driverSees === true, visionModel: modelName(rebuild?.visionModel), groundingModel: modelName(rebuild?.groundingModel), groundingRange };
    const [ids, cfg] = await Promise.all([deps.listed().catch(() => [] as string[]), deps.config().catch(() => ({} as { model?: string; modelFilter?: string }))]);
    const filter = cfg.modelFilter || "";
    /** A page-written name, used only when it is a model this runtime offers and lets through. */
    const offered = (v: unknown): string | null => { const m = modelName(v); return m && ids.includes(m) && modelFilterAllows(m, filter) ? m : null; };
    const driver = offered(driverModel ?? cfg.model);
    // The worker-built path's rule: the driver sees when the worker's own capability answer for it says so, and then it
    // is its own reader.
    const driverSees = !!driver && await deps.sees(driver).catch(() => false);
    // A delegated reader is one the worker-built path would also accept: offered, and positively able to take images.
    const reader = driverSees ? driver : offered(rebuild?.visionModel);
    const readerSees = driverSees || (!!reader && await deps.sees(reader).catch(() => false));
    return { driverSees, visionModel: readerSees ? reader : null, groundingModel: offered(rebuild?.groundingModel), groundingRange };
}
