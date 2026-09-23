// ml-agent-handle.ts — driving a run from OUTSIDE it: the live handle, and rebuilding a toolset for one.
//
// `createAgent` returns a handle you can steer, cancel and append to while the run is going; `resumeAgent`
// gets one for a run already under way, by hash. `_rebuildToolset` and `_adoptRun` are the other direction --
// a run that crossed into THIS page after a navigation has to be given a toolset built here, because tools
// close over the document they were made for and the ones from the previous page are dead.
//
// The handle is a view, not an authority. It asks the run to do something and the run decides; a transcript
// still changes only through the session's own events.

import { resolveOutputs } from "./answer-set";
import { renderArgs } from "./approval";
import { makeBackgroundTaskPromise } from "./bridge";
import { setCdpEnabled } from "./builtin-tools";
import { handleRegistry, agentRegistry, enterAgentRun, emitDebug, exitAgentRun } from "./bus";
import type { MlApi, AgentOptions, MlAgentHandle, ApprovalRequest, RebuildConfig, MlTool, VisionMemory, AgentResult } from "./contract";
import { setPierceClosedShadow } from "./dom";
import { AgentHandle } from "./ml-agent";
import { registerRun, endRun, runAnswer } from "./run-delegation";
import { suspiciousArgsWarning } from "./security";

/**
 * A stateful agent session — the agent analogue of {@link module:ml.createChat}. Two primitives:
 * `say` writes a user message into the session, `run` executes the loop until the agent's turn is
 * complete; everything shares one hash. Call `run` again for the next turn; `say` mid-run STEERS
 * (injected at the next step boundary), idle it queues for the next `run`. `maxSteps` is live
 * (raise it mid-run to keep going); `messages` is the raw, mutable history; `fork()` branches it.
 *   const a = ml.createAgent({ maxSteps: 20 });
 *   const done = a.run("Reorganise these tabs by topic.");
 *   a.say("actually, keep the pinned ones where they are");   // steer mid-run
 *   await done;
 *   await a.run("Now close the empty groups.");               // another turn, same session
 * @param {AgentOptions} [opts] the same options as ml.agent (tools, model, vision, …)
 * @returns {MlAgentHandle} a handle: run/say/cancel/fork + hash/messages/maxSteps/running
 */
export const createAgent = function(this: MlApi, opts: AgentOptions = {}): MlAgentHandle {
    return new AgentHandle(this as unknown as MlApi, opts);
};

/**
 * Re-acquire a live agent handle by its session hash (shown/copied in the debug sidebar). The agent
 * analogue of {@link module:ml.resumeChat}: returns the SAME handle the run is using, so you can read
 * or mutate its `messages`, `say()`/`run()` to continue it, `fork()` it, or `cancel()` it — without
 * having kept the original `createAgent()` reference.
 *
 * Same-tab `createAgent` / HUD-started runs only. A one-shot `ml.agent(task)` (no handle) and a
 * background/off-mode run (its history lives in the service worker) aren't handle-resumable this way —
 * the low-level `ml.agent(task, { resume: hash })` still CONTINUES those.
 *
 * @param {string} hash The run's session hash.
 * @returns {MlAgentHandle} the live handle (run/say/cancel/fork + hash/messages/maxSteps).
 * @throws {Error} If no handle-backed run exists for the hash in this tab.
 */
export const resumeAgent = function(this: MlApi, hash: string): MlAgentHandle {
    if (!hash || typeof hash !== "string") throw new Error("ml.resumeAgent needs a run hash string.");
    const handle = handleRegistry.get(hash);
    if (!handle) throw new Error(
        `No resumable agent handle "${hash}" in this tab. Handles come from ml.createAgent (or a ` +
        `HUD-started run); a one-shot ml.agent(task) or a background/off-mode run isn't handle-resumable ` +
        `— use ml.agent(task, { resume: "${hash}" }) to continue it instead.`
    );
    return handle;
};

/**
 * A de-duplicating approval gate for {@link module:ml.agent}: prompts (via
 * confirm) the first time it sees a given call and remembers that answer per
 * **(tool + exact arguments)**. So an identical repeat isn't re-asked, but a
 * DIFFERENT call is — crucially, each distinct `exec` script must be approved
 * on its own (blanket-approving arbitrary eval would defeat the gate).
 * Denials are remembered too and fed back to the model. Pass it as `approve`:
 *   ml.agent(task, { approve: ml.approveOnce() })
 * @returns {(req: {tool: string, arguments: Object}) => boolean}
 */
export const approveOnce = function(this: MlApi): (req: ApprovalRequest) => boolean {
    const remembered: Record<string, boolean> = {};   // (tool + args) key -> remembered decision
    return ({ tool, arguments: args }: ApprovalRequest): boolean => {
        let key;
        try { key = tool + " " + JSON.stringify(args); }
        catch { key = tool + " " + String(args); }
        if (!(key in remembered)) {
            remembered[key] = (typeof window.confirm === "function") && window.confirm(
                `${suspiciousArgsWarning(args)}window.ml agent wants to run "${tool}":\n\n${renderArgs(args)}\n\n` +
                `Allow this call? (an identical repeat won't ask again)`
            );
        }
        return remembered[key];
    };
};

/**
 * Cross-page persistence: rebuild a run's BUILTIN toolset from a serializable {@link RebuildConfig}
 * (tool names + carried vision facts) on a fresh document after a same-site navigation. Only builtin
 * tools cross a nav — custom function tools (passed via `tools`/`extraTools`) don't serialize, so a
 * cross-page run is limited to the default/HUD kit by design. Vision facts are CARRIED (not re-probed),
 * so native-vs-delegated `look` on the new page matches the original run exactly.
 */
export const _rebuildToolset = function(this: MlApi, rebuild: RebuildConfig): MlTool[] {
    const ml = this;
    const want = new Set(rebuild.toolNames);
    const out: MlTool[] = [];
    // Read-only DOM base, filtered to the run's names.
    for (const t of (ml.domTools || [])) if (want.has(t.name)) out.push(t);
    // Builtin interaction/privileged tools (originally added via extraTools — e.g. the HUD kit).
    if (want.has("click")) out.push(ml.clickTool());
    if (want.has("type")) out.push(ml.typeTool());
    if (want.has("python_exec")) out.push(ml.pythonTool());
    if (want.has("chat_metadata")) out.push(ml.chatMetaTool());
    if (want.has("navigate")) out.push(ml.navigateTool({ crossOrigin: rebuild.crossOrigin }));
    if (want.has("fetch_url")) out.push(ml.fetchTool());
    // Auto-wired vision tools, rebuilt from the carried facts (no re-probe) with a fresh near-area memory.
    if (want.has("look") || want.has("locate")) {
        const memory: VisionMemory = { seen: [], boundariesSeen: new Set() };
        if (want.has("look")) out.push(rebuild.driverSees ? ml._nativeLookTool(memory) : ml.lookTool({ model: rebuild.visionModel, memory }));
        if (want.has("locate")) out.push(ml.locateTool({ model: rebuild.visionModel, groundingModel: rebuild.groundingModel, groundingRange: rebuild.groundingRange, memory }));
    }
    return out;
};

/**
 * Cross-page persistence: re-adopt a background-hosted run on a fresh document (after a same-site
 * navigation). Rebuild the run's builtin toolset from the carried config + re-register it under the
 * run id, so the background's held delegated tool can execute here. Re-applies the closed-shadow
 * flag first (a module flag the new document reset). Called from the CONTENT_READY → adopt round-trip.
 */
export const _adoptRun = function(this: MlApi, runId: string, rebuild: RebuildConfig): void {
    setPierceClosedShadow(!!rebuild.pierceClosed);
    setCdpEnabled(!!rebuild.cdp);
    const toolset = this._rebuildToolset(rebuild);
    const model = rebuild.model ?? null, driverSees = !!rebuild.driverSees, visionModel = rebuild.visionModel ?? null;
    registerRun(runId, toolset, model, driverSees, visionModel);
    // Re-register a RESUME handle so a HUD composer follow-up (a run() turn) can continue this
    // background run BY HASH — the original page's AgentHandle died with the navigation, so without
    // this a follow-up typed on the new page falls through to the chat path and is silently dropped.
    agentRegistry.set(runId, {
        hash: runId,
        resume: async (t: string, steps?: number): Promise<AgentResult> => {
            registerRun(runId, toolset, model, driverSees, visionModel);   // endRun clears the live tools each turn
            enterAgentRun();
            try {
                const res = await makeBackgroundTaskPromise<AgentResult>("RESUME_RUN_REQUEST", "RESUME_RUN_RESPONSE", { runId, task: t, ...(steps ? { maxSteps: steps } : {}) });
                const run = endRun(runId);
                const { tokenRenders, ...resClean } = res;   // loop-internal — don't leak to the caller
                const a = run ? runAnswer(run, res.summary) : { elements: [], media: [], answer: "" };
            const outputs = resolveOutputs(a.answer, res.summary, tokenRenders || []);   // structured data → res.outputs (headless)
                emitDebug({ kind: "agent-result", id: runId, ts: Date.now(), save: false, session: { hash: runId, turn: res.steps }, summary: res.summary, steps: res.steps, hitCap: !!res.hitCap, cancelled: !!res.cancelled, ...(a.media.length ? { answerMedia: a.media } : {}), ...(a.answer ? { answer: a.answer } : {}) });
                return { ...resClean, elements: a.elements, ...(a.media.length ? { answerMedia: a.media } : {}), ...(a.answer ? { answer: a.answer } : {}), ...(outputs.length ? { outputs } : {}), hash: runId };
            } finally { exitAgentRun(); }
        },
    });
};
