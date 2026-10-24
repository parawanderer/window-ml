// sw-run-start.ts — starting a run the USER asked for, assembled in the worker rather than in the page it acts on.
//
// docs/spec/SITE_ACCESS.md, slice 0. Before this, a run started from the HUD Commander or the chat page was assembled
// by the page's own `ml.agent`: the page saw the request first and could change the task, the tools or the system
// prompt. Now the worker assembles it (run-assembly.ts, with `workerMl`), pushes the builtin toolset into the tab the
// way a navigation's re-adopt does, and hosts the loop it always hosted (sw-run-host.ts). The page supplies its own
// page context and runs the tools. It never supplies the task, the model, the prompt, the toolset or the approval
// flags.

import type { ElementContext } from "../contract";
import type { StartRunPayload } from "../contract/contract-messages";
import { shortHash, type PromptDisplay, type PromptOrigin } from "../contract/contract-run";
import { framePrompt } from "../agent/prompts";
import { promptSurfaceOf } from "../agent/prompt-surface";
import { stepBudget } from "../agent/step-budget";
import { assembleRun, rebuildFor, startPayload, userRunOptions, withPageContext, type UserRunRequest } from "../agent/run-assembly";
import { relayDebugEvent } from "./sw-debug";
import { getConfig } from "./sw-llm";
import { dropLocalTools, registerLocalTools } from "./sw-local-tools";
import { buildWorkerTools } from "./worker-tools";
import { pyMediaFor } from "./worker-media";
import { hostRun } from "./sw-run-host";
import { bgRuns, bufferReplay, isWorkerRun, makeWorkerRun, runControllers, runInboxes, tabPageUrl, workerRunsStarting, beginStart, endStart } from "./sw-runs";
import { originOf } from "../site-access";
import { siteDecision } from "./sw-site-access";
import { ingestSessionEvent, keepSession } from "./sw-sessions";
import { workerMl } from "./worker-ml";
import { noteWorkerVision } from "./run-vision";
import { capPageContext } from "./page-answer-caps";
import { proposePolicyTool } from "../tools/propose-policy-tool";
import { proposeManifestTool } from "../tools/propose-manifest-tool";
import { shellTurnedOn } from "./sw-shell";
import { defineTool } from "../ml/ml-tool-factories";
import { notePersonTurn } from "./sw-start-approval";
import { adoptOnTab } from "./adopt-run";
import { holdStands } from "./nav-arrival";

/** What a run is given when the person set no step budget: the same default `ml.agent` and `createAgent` use. */
const DEFAULT_MAX_STEPS = 10;

/**
 * Start a run the user asked for on `tabId`. Resolves with the run's session hash once the run is under way (its
 * toolset registered in the page and the loop started), not when it finishes: the run reports itself through its
 * session events like any other.
 * @param tabId the tab the run acts on
 * @param req what the person asked for
 * @param opts `keep`: this browser's own UI keeps its sessions past the worker's life (`config.persistUiRuns`).
 *   `approvalRouting`: TEST-ONLY, set by `__mlStartUserRunForTest` alone (the SW realm, which no page reaches), so a
 *   harness can rule on the gates through `__mlApprovals` as it does for a console run; every real route leaves it "ui".
 *   `answer`: TEST-ONLY, the same way: give the run the `answer` tool, which no surface's kit has
 * @returns the run's session hash
 * @throws when the tab is not an ordinary web page, there is nothing to do, or the page cannot host the run
 */
export async function startUserRun(tabId: number, req: UserRunRequest, opts: { keep?: boolean; approvalRouting?: "both"; answer?: true; sender?: Omit<PromptOrigin, "surface"> } = {}): Promise<{ hash: string }> {
    // The URL and title are the BROWSER's, never something the page said about itself.
    const tab = await chrome.tabs.get(tabId);
    const url = tab.url || "";
    if (!/^https?:/i.test(url)) throw new Error("An agent run can only start on an ordinary web page (http or https).");
    const ml = workerMl(url);
    const recipe = userRunOptions(ml, req, opts.sender);
    if (!recipe.task && !(req.images && req.images.length)) throw new Error("Nothing to do: the run has no task and no image.");
    // propose_policy only here: a run the worker builds for the person may ask them for a policy; no page's run can. And
    // propose_manifest when the settings turn ml.sh on, which the run's scripts then reach.
    const shellOn = await getConfig().then(shellTurnedOn, () => false);
    const extraTools = [...(recipe.options.extraTools ?? []), proposePolicyTool(defineTool), ...(shellOn ? [proposeManifestTool(defineTool)] : [])];
    const asm = await assembleRun(ml, recipe.task, { ...recipe.options, extraTools, ...(opts.answer ? { answer: true } : {}) });
    const runId = shortHash();
    const rebuild = rebuildFor(asm, true, "worker");
    noteWorkerVision(runId);   // its vision facts are the worker's own (run-vision.ts)
    // Remote tools, and the builtins that never read the page, run HERE (sw-local-tools.ts, worker-tools.ts); everything
    // else is registered in the page by the adopt below.
    const names = asm.toolset.map((t) => t.name);
    registerLocalTools(runId, [...asm.toolset.filter((t) => !!t.remote), ...buildWorkerTools(runId, tabId, () => tabPageUrl.get(tabId) || url, names, pyMediaFor(runId, tabId))],
        { model: asm.runModel, driverSees: asm.driverSees, visionModel: asm.runVisionModel });
    // Marked worker-built BEFORE its id reaches the page (the push below carries it): from then on a page's own
    // START_RUN, RESUME_RUN or INJECT_MESSAGE naming it is refused, so the page cannot host its own run under the hash
    // the person's UI is about to be given.
    workerRunsStarting.add(runId);
    // A CANCEL_ALL_RUNS (or a Stop once the id is out) during the adopt/config awaits must stop this start: without
    // the registration the panic button sees nothing live and the run starts anyway. `hostRun` takes the
    // registration over when it registers the turn's real controller.
    const starting = beginStart(runId, tabId);
    let cfg: Awaited<ReturnType<typeof getConfig>>;
    let adopted: Awaited<ReturnType<typeof adoptOnTab>>;
    try {
        adopted = await adoptOnTab(tabId, runId, rebuild);
        if (adopted.error) throw new Error(`The run could not start on this page: ${adopted.error}.`);
        cfg = await getConfig();
        if (starting.signal.aborted) throw new Error("Cancelled before the run started.");
    } catch (e) {
        endStart(runId, starting);
        workerRunsStarting.delete(runId);
        dropLocalTools(runId);
        throw e;
    }
    const surface: StartRunPayload["surface"] = cfg.debugMode === "overlay" || cfg.debugMode === "devtools" ? cfg.debugMode : "off";
    const payload: StartRunPayload = {
        ...startPayload(asm, {
            runId, systemPrompt: withPageContext(asm.systemPrompt, capPageContext(adopted.pageInfo)), think: null,
            maxSteps: recipe.maxSteps ?? DEFAULT_MAX_STEPS, surface, stream: recipe.stream, toolTokens: true, origin: recipe.origin,
            navigate: true, crossOrigin: true, approvalRouting: opts.approvalRouting ?? "ui",
            page: { origin: new URL(url).origin, url, title: tab.title || undefined },
            builtBy: "worker",
        }),
        ...(recipe.display ? { display: recipe.display } : {}),
    };
    if (opts.keep) keepSession(runId);
    // The run's result reaches every surface through its own lifecycle events (`builtBy: "worker"`), so nobody
    // waits on this reply. Same tick as the registration's end: a cancel after this check finds the live
    // controller (or, if `hostRun` refuses a race, nothing to cancel).
    if (starting.signal.aborted) {
        endStart(runId, starting);
        workerRunsStarting.delete(runId);
        dropLocalTools(runId);
        throw new Error("Cancelled before the run started.");
    }
    endStart(runId, starting);
    hostRun({ type: "START_RUN", payload }, tabId, () => { workerRunsStarting.delete(runId); });
    return { hash: runId };
}

let steerSeq = 0;

/**
 * Show a session event on every surface of a run the worker hosts: the page's card or overlay, a DevTools panel, the
 * session index, and the replay buffer a re-adopting page reads. The fan a background run's own events get, for an
 * event the run did not emit itself (a person's message).
 * @param tabId the run's tab
 * @param event the session event
 */
export function announce(tabId: number, event: Record<string, unknown>): void {
    chrome.tabs.sendMessage(tabId, { type: "ML_DEBUG_TO_PAGE", event }).catch(() => { /* tab gone */ });
    relayDebugEvent(tabId, event);
    ingestSessionEvent(event, { tabId, trusted: true });
    bufferReplay(tabId, event);
}

/**
 * Steer a RUNNING background run: the text goes into its inbox, which the loop drains at its next step boundary, and
 * shows as the person's message (marked seen when drained).
 * @param hash the run
 * @param text what the person said
 * @param origin where it was typed, when known
 * @param display how to show it, when `text` is not what the person typed
 * @returns false when the run is not live in this worker
 */
export function steerRun(hash: string, text: string, origin?: PromptOrigin, display?: PromptDisplay): boolean {
    const inbox = runInboxes.get(hash);
    if (!inbox) return false;
    const sayId = `sc_${Date.now().toString(36)}_${++steerSeq}`;
    inbox.queue.push({ id: sayId, text, ...(origin ? { origin } : {}) });
    announce(inbox.tabId, { kind: "agent-say", id: hash, ts: Date.now(), save: false, session: { hash, turn: 0 }, text, sayId, ...(display ? { display } : {}) });
    return true;
}

/**
 * A person's message or "Continue" on a run the WORKER built: steer it when it is running, or start its next turn
 * when it has settled, from the worker, so the page never carries the message. Null when the hash is not such a run
 * (or not on `fromTabId`), so the caller can fall back to the page, which still owns the runs and chats it built.
 * @param hash the run
 * @param action "send" a message, or "continue" a capped run with no message
 * @param body the message (text, images, a right-clicked element), a Continue budget, and where it was typed
 * @param fromTabId when the request came from a tab, the tab it came from: a run is only driven from its own tab
 * @param sentFrom where the message was typed, as the channel it came over knows it (a hub command's sender); wins over
 *   the body's `surface`
 * @returns what happened, or null when this is not the worker's run to drive
 */
export async function userRunAction(hash: string, action: "send" | "continue", body: { text?: string; images?: string[]; elementContext?: ElementContext; maxSteps?: number; surface?: string }, fromTabId?: number, sentFrom?: PromptOrigin): Promise<"steer" | "turn" | "continued" | "busy" | "none" | null> {
    const stored = bgRuns.get(hash);
    const live = runInboxes.get(hash);
    const tabId = stored?.tabId ?? live?.tabId;
    if (tabId == null || (fromTabId != null && fromTabId !== tabId)) return null;
    // A run a PAGE built is the page's to drive while that page may: its handle keeps the history in step. Once the
    // tab is on a site that may not use window.ml (the run navigated off its builder's origin), the page's RESUME_RUN
    // would be refused, and nothing page-side owns the run any more: it is handed to the worker.
    if (!isWorkerRun(hash)) {
        const here = originOf(await chrome.tabs.get(tabId).then((t) => t.url, () => undefined));
        const decision = here ? await siteDecision(here) : "unknown";
        if (decision === "always" || decision === "session") {
            // The page relays it, as the run's handle lives there: its copy of exactly this text is the person's turn,
            // not one of the site's (docs/spec/SITE_ACCESS_SLICE3.md, Q2). Framed as the page frames it (injected.ts).
            await notePersonTurn(hash, action === "send" ? framePrompt(String(body.text || ""), body.elementContext).text : "", action === "send" ? body.images : [], stepBudget(body.maxSteps));
            return null;
        }
        makeWorkerRun(hash);
    }
    const surface = promptSurfaceOf(body.surface);
    const origin: PromptOrigin | undefined = sentFrom ?? (surface ? { surface } : undefined);
    const { text, display } = action === "send" ? framePrompt(String(body.text || ""), body.elementContext) : { text: "", display: undefined };
    if (action === "send" && !text && !(body.images && body.images.length)) return "none";
    if (runControllers.has(hash)) {
        if (action === "continue") return "busy";
        return steerRun(hash, text, origin, display) ? "steer" : "busy";
    }
    if (!stored) return "none";
    // Re-register the builtin toolset in the page first: the document may not be the one the last turn ran on.
    // Registered as a start for that await: a CANCEL_ALL_RUNS there must stop this resume, not find nothing live.
    // Not on a page the run is still held on (nav-arrival.ts): the turn judges it again, and the person answers first.
    const starting = beginStart(hash, tabId);
    try {
        if (!stored.p.rebuild || (!await holdStands(tabId, hash) && (await adoptOnTab(tabId, hash, stored.p.rebuild)).error)) { endStart(hash, starting); return "none"; }
        if (starting.signal.aborted) { endStart(hash, starting); return "none"; }
    } catch (e) {
        endStart(hash, starting);
        throw e;
    }
    if (text) announce(tabId, { kind: "agent-say", id: hash, ts: Date.now(), save: false, session: { hash, turn: 0 }, text, ...(display ? { display } : {}) });
    const steps = stepBudget(body.maxSteps);
    if (starting.signal.aborted) { endStart(hash, starting); return "none"; }
    endStart(hash, starting);
    hostRun({ type: "RESUME_RUN", payload: { runId: hash, task: text, ...(steps ? { maxSteps: steps } : {}) } },
        tabId, () => { /* reported through the session's events */ }, action === "send" ? origin : undefined);
    return action === "continue" ? "continued" : "turn";
}
