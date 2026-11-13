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
import { imagesRefusal, shortHash, type AttachedFile, type PromptDisplay, type PromptOrigin, type SentFile } from "../contract/contract-run";
import { FilesRefused, checkFilesField, cleanFiles, isPdfFile, pdfToPageRun } from "../attached-files";
import { PageGone, pageRouteFor } from "./page-route";
import { ImagesRefused } from "../image-gate";
import { framePrompt } from "../agent/prompts";
import { promptSurfaceOf } from "../agent/prompt-surface";
import { stepBudget } from "../agent/step-budget";
import { assembleRun, rebuildFor, routeTurnImages, startPayload, userRunOptions, type UserRunRequest } from "../agent/run-assembly";
import { relayDebugEvent } from "./sw-debug";
import { getConfig } from "./sw-llm";
import { dropLocalTools, registerLocalTools } from "./sw-local-tools";
import { buildWorkerTools } from "./worker-tools";
import { pyMediaFor } from "./worker-media";
import { hostRun } from "./sw-run-host";
import { bgRuns, bufferReplay, isWorkerRun, makeWorkerRun, runControllers, runInboxes, runModelFor, runRebuilds, startingControllers, tabPageUrl, workerRunsStarting, beginStart, endStart, sessionTokens, releaseSessionTokens, turnByRun } from "./sw-runs";
import { attachFiles, attachPaste, readPdfOffscreen } from "./sw-attach";
import type { FilePointer } from "../pointers/file-pointer";
import { storeHeld } from "./sw-values";
import { originOf } from "../site-access";
import { siteDecision } from "./sw-site-access";
import { ingestSessionEvent, keepSession } from "./sw-sessions";
import { workerMl } from "./worker-ml";
import { noteWorkerVision } from "./run-vision";
import { capPageContext } from "./page-answer-caps";
import { proposePolicyTool } from "../tools/propose-policy-tool";
import { proposeManifestTool } from "../tools/propose-manifest-tool";
import { pythonInstallTool } from "../tools/python-install-tool";
import { offersTask, taskTool } from "../tools/task-tool";
import { shellTurnedOn } from "./sw-shell";
import { defineTool } from "../ml/ml-tool-factories";
import { notePersonTurn } from "./sw-start-approval";
import { adoptOnTab } from "./adopt-run";
import { holdStands } from "./nav-arrival";
import { toPageUi } from "./sw-side-panel";

/** Whether a run the worker builds offers `python_install`. Off until the install step exists (docs/plan/repl/
 *  PACKAGES_INSTALL.md, slice 4): before it, an approved card installs nothing, so offering it would only mislead. */
export const OFFER_PYTHON_INSTALL = false;

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
    // Past the cap a start is refused, never cut: the composers say so first, and this is the half no surface can skip.
    const tooMany = imagesRefusal(req.images?.length ?? 0);
    if (tooMany) throw new ImagesRefused(tooMany);
    // The one rule for a message's files, whichever surface sent them (a tab's USER_START_RUN included).
    const checked = checkFilesField(req.files, "agent");
    if (checked.reason) throw new Error(checked.reason);
    const ml = workerMl(url);
    // Minted before the task is framed: an attached PDF is held for this session, and its outline names its pointer.
    const runId = shortHash();
    try {
        return await startMinted(tabId, tab, url, ml, runId, req, checked.files, opts);
    } catch (e) {
        // Nothing hosts the run: what it stored (an attached PDF's rows) and its shelf go with it.
        if (!runControllers.has(runId) && !bgRuns.has(runId)) releaseSessionTokens(runId);
        throw e;
    }
}

/** {@link startUserRun} once the run has its id: attach the files, assemble, adopt, host. */
async function startMinted(tabId: number, tab: chrome.tabs.Tab, url: string, ml: ReturnType<typeof workerMl>, runId: string, req: UserRunRequest, files: SentFile[] | undefined, opts: { keep?: boolean; approvalRouting?: "both"; answer?: true; sender?: Omit<PromptOrigin, "surface"> }): Promise<{ hash: string }> {
    const shelf = sessionTokens(runId).files;
    const attached = await attachFiles(runId, files, 1, { read: readPdfOffscreen, store: storeHeld, shelf });
    const recipe = userRunOptions(ml, { ...req, files: attached.files }, opts.sender);
    if (!recipe.task && !(req.images && req.images.length)) throw new Error("Nothing to do: the run has no task and no image.");
    const typed = String(req.task || "").trim();
    const paste = await attachPaste(runId, typed, 1, { store: storeHeld, shelf });
    if (paste) Object.assign(recipe, withPasteLine(recipe, typed, paste.line));
    // propose_policy only here: a run the worker builds for the person may ask them for a policy; no page's run can. And
    // propose_manifest when the settings turn ml.sh on, which the run's scripts then reach.
    const shellOn = await getConfig().then(shellTurnedOn, () => false);
    // `task` wherever a call can detach: an ml.sh call, or a python_exec cell past its lease (sw-python-task.ts).
    const base = [...(recipe.options.tools ?? (ml as { domTools?: { name: string }[] }).domTools ?? []), ...(recipe.options.extraTools ?? [])];
    const extraTools = [...(recipe.options.extraTools ?? []), proposePolicyTool(defineTool), ...(shellOn ? [proposeManifestTool(defineTool)] : []), ...(offersTask(shellOn, base.map((t) => t?.name)) ? [taskTool(defineTool)] : []),
        ...(OFFER_PYTHON_INSTALL ? [pythonInstallTool(defineTool)] : [])];
    const asm = await assembleRun(ml, recipe.task, { ...recipe.options, extraTools, ...(opts.answer ? { answer: true } : {}) });
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
            runId, systemPrompt: asm.systemPrompt, pageContext: capPageContext(adopted.pageInfo), think: null,
            maxSteps: recipe.maxSteps ?? DEFAULT_MAX_STEPS, surface, stream: recipe.stream, toolTokens: true, origin: recipe.origin,
            navigate: true, crossOrigin: true, approvalRouting: opts.approvalRouting ?? "ui",
            page: { origin: new URL(url).origin, url, title: tab.title || undefined },
            builtBy: "worker",
        }),
        ...(recipe.display ? { display: recipe.display } : {}),
        ...(shelf.size ? { files: shelf.all() } : {}),
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
    toPageUi(tabId, { type: "ML_DEBUG_TO_PAGE", event });
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
export function steerRun(hash: string, text: string, origin?: PromptOrigin, display?: PromptDisplay, images?: string[], shown?: string[]): boolean {
    const inbox = runInboxes.get(hash);
    if (!inbox) return false;
    const sayId = `sc_${Date.now().toString(36)}_${++steerSeq}`;
    inbox.queue.push({ id: sayId, text, ...(origin ? { origin } : {}), ...(images?.length ? { images } : {}) });
    announce(inbox.tabId, { kind: "agent-say", id: hash, ts: Date.now(), save: false, session: { hash, turn: 0 }, text, sayId, ...(display ? { display } : {}), ...(shown?.length ? { images: shown } : {}) });
    return true;
}

/** A message's framing with a long paste's naming line after it: the model reads the line, and the display keeps
 *  what the person typed, so the line is never shown as theirs. */
function withPasteLine(framed: { task: string; display?: PromptDisplay }, typed: string, line: string): { task: string; display: PromptDisplay } {
    return { task: framed.task ? `${framed.task}\n\n${line}` : line, display: framed.display ?? { typed, context: [] } };
}

/** The payloads a run's next message is recorded on: the live turn's (written back when the turn ends) and the stored
 *  one a later turn starts from. Either may be absent. */
const runPayloads = (hash: string): StartRunPayload[] =>
    [turnByRun.get(hash)?.().payload, bgRuns.get(hash)?.p].filter((p): p is StartRunPayload => !!p);

/** The turn the person's next message to a run arrives in, 1-based: one past the messages already sent. A payload with
 *  no count was written before messages were counted, and holds the first message alone. */
const nextSend = (hash: string): number => Math.max(1, ...runPayloads(hash).map((p) => p.sends ?? 1)) + 1;

/**
 * Record a message the person sent a run the worker built: its turn, and the files it attached, on every payload the
 * run is carried on, so a later turn's shelf and a worker restart's (`sessionTokens`) hold them.
 * @param hash the run
 * @param turn the message's turn ({@link nextSend})
 * @param added the pointers it added
 */
function noteSend(hash: string, turn: number, added: readonly FilePointer[]): void {
    for (const p of runPayloads(hash)) {
        p.sends = Math.max(p.sends ?? 1, turn);
        const fresh = added.filter((a) => !(p.files ?? []).some((g) => g.id === a.id));
        if (fresh.length) p.files = [...(p.files ?? []), ...fresh];
    }
}

/**
 * Say in a run's step list that a message was not sent, and why: for a surface whose send has no answer to carry it.
 * @param hash the run
 * @param why the refusal's sentence
 */
export function noteRefusedTurn(hash: string, why: string): void { noteRunLine(hash, `Your message was not sent: ${why}`); }

/**
 * Say one line in a run's step list, in the worker's own voice (an `agent-note`): for something that happened to the
 * run with no turn running to say it, such as the idle reap of its Python namespace. Nothing when the run has no tab.
 * @param hash the run
 * @param text the line
 */
export function noteRunLine(hash: string, text: string): void {
    const tabId = bgRuns.get(hash)?.tabId ?? runInboxes.get(hash)?.tabId;
    if (tabId != null) announce(tabId, { kind: "agent-note", id: hash, ts: Date.now(), save: false, session: { hash, turn: 0 }, text });
}

/** A worker-built run's vision facts, for routing a later turn's images: the model it is on now, and what its build
 *  decided about seeing (`rebuild.driverSees`, `rebuild.visionModel`), and the model it was built on. */
function turnVision(hash: string): { driverSees: boolean; runModel: string | null; visionModel: string | null } {
    // The live turn's rebuild while it runs (the first turn is not in `bgRuns` until it ends), the stored one after.
    const rb = runRebuilds.get(hash) ?? bgRuns.get(hash)?.p.rebuild;
    return { driverSees: rb?.driverSees === true, runModel: runModelFor(hash) ?? bgRuns.get(hash)?.p.model ?? rb?.model ?? null, visionModel: rb?.visionModel ?? null };
}

/**
 * A person's message or "Continue" on a run the WORKER built: steer it when it is running, or start its next turn
 * when it has settled, from the worker, so the page never carries the message. Null when the message is the page's to
 * frame (`pageRouteFor`: the tab and site that built the run or chat), so the caller hands it to the page. A page-built
 * run off its builder is handed to the worker; a message for a run the worker drives, sent from another tab, is refused.
 * The message's files and a long paste become the run's pointers only when it is delivered ("steer" or "turn"): on
 * any other outcome, or a throw, the pointers this call added are taken back and the run's message count is left;
 * their value-store rows stay held until the session is released.
 * @param hash the run
 * @param action "send" a message, or "continue" a capped run with no message
 * @param body the message (text, images, a right-clicked element), a Continue budget, and where it was typed
 * @param fromTabId when the request came from a tab, the tab it came from: a run is only driven from its own tab
 * @param sentFrom where the message was typed, as the channel it came over knows it (a hub command's sender); wins over
 *   the body's `surface`
 * @returns what happened, or null when this is not the worker's run to drive
 * @throws {FilesRefused} the files break the rule, a PDF will not read, or one would go to a page
 * @throws {ImagesRefused} the images may not be sent
 * @throws {PageGone} no page may frame the message here and the worker may not drive it from this tab
 */
export async function userRunAction(hash: string, action: "send" | "continue", body: { text?: string; images?: string[]; files?: SentFile[]; elementContext?: ElementContext; maxSteps?: number; surface?: string }, fromTabId?: number, sentFrom?: PromptOrigin): Promise<"steer" | "turn" | "continued" | "busy" | "none" | null> {
    const stored = bgRuns.get(hash);
    const live = runInboxes.get(hash);
    const tabId = stored?.tabId ?? live?.tabId;
    // A run the worker drives (it built it, or took it over) is driven only from its own tab: from another, or one it no
    // longer holds, no page owns it either, so the message is refused rather than handed to the sending tab's page.
    if (isWorkerRun(hash) && (tabId == null || (fromTabId != null && fromTabId !== tabId))) throw new PageGone();
    // A run or chat a PAGE built is the page's to drive only on the tab that built it, on the site that built it, while
    // that site may use window.ml (page-route.ts): its handle keeps the history in step. Anywhere else the page the tab
    // shows did not build it, so the worker takes the run over if it holds it, and refuses the message if it does not.
    if (!isWorkerRun(hash)) {
        const at = fromTabId ?? tabId;
        const url = at == null ? undefined : await chrome.tabs.get(at).then((t) => t.url, () => undefined);
        const route = at == null ? "off" : await pageRouteFor(hash, at, url);
        if (route === "page" && tabId == null) {
            // A chat, or a run this worker no longer holds (it was evicted since): the page frames the message, and it
            // never gets a PDF's bytes, so a message carrying one is refused here rather than sent without it. Past the
            // image cap it is refused, never cut, as everywhere.
            const tooMany = action === "send" ? imagesRefusal(body.images?.length ?? 0) : null;
            if (tooMany) throw new ImagesRefused(tooMany);
            const pdf = action === "send" ? (cleanFiles(body.files) ?? []).find(isPdfFile) : undefined;
            if (pdf) throw new FilesRefused(pdfToPageRun(pdf.name));
            return null;
        }
        if (route === "page") {
            // Past the cap the message is refused, never cut, whoever built the run.
            const tooMany = action === "send" ? imagesRefusal(body.images?.length ?? 0) : null;
            if (tooMany) throw new ImagesRefused(tooMany);
            // The page frames the message, so it takes text files whole only: a PDF, or text past what is sent whole,
            // is refused here with its reason, before the page is told anything, never dropped on the way.
            const pageFiles = action === "send" ? checkFilesField(body.files, "page-run") : {};
            if (pageFiles.reason) throw new FilesRefused(pageFiles.reason);
            // The page relays it, as the run's handle lives there: its copy of exactly this text is the person's turn,
            // not one of the site's (docs/spec/SITE_ACCESS_SLICE3.md, Q2). Framed as the page frames it (injected.ts).
            await notePersonTurn(hash, action === "send" ? framePrompt(String(body.text || ""), body.elementContext, pageFiles.files as AttachedFile[] | undefined).text : "", action === "send" ? body.images : [], stepBudget(body.maxSteps));
            return null;
        }
        // Nothing here holds it, or it is another tab's run: no page may frame it and the worker cannot drive it.
        if (tabId == null || at !== tabId) throw new PageGone();
        makeWorkerRun(hash);
    }
    if (tabId == null) return null;   // every branch above has answered a run no tab holds
    // Past the cap the message is refused, never cut, whoever built the run.
    const tooMany = action === "send" ? imagesRefusal(body.images?.length ?? 0) : null;
    if (tooMany) throw new ImagesRefused(tooMany);
    const surface = promptSurfaceOf(body.surface);
    const origin: PromptOrigin | undefined = sentFrom ?? (surface ? { surface } : undefined);
    // The one rule for a message's files, whichever surface sent them: this run holds each one as a pointer.
    const checked = action === "send" ? checkFilesField(body.files, "agent") : {};
    if (checked.reason) throw new FilesRefused(checked.reason);
    const typed = String(body.text || "");
    const attached = action === "send" ? (body.images ?? []).filter((i) => typeof i === "string" && i.startsWith("data:image/")) : [];
    if (action === "send" && !typed.trim() && !attached.length && !checked.files && !body.elementContext) return "none";
    // The images go where the run's first turn's went: to a driver that sees, or as the reader's notes. Decided before
    // anything is announced or held, so a refusal (vision not known, no reader) reaches the sender and nothing is sent.
    const routed = attached.length ? await routeTurnImages(workerMl(tabPageUrl.get(tabId) || ""), attached, turnVision(hash)) : {};
    // The files, and a long paste, held as this message's pointers before anything is announced: a PDF that will not
    // read refuses the message whole. They are this message's only once it is delivered (a steer or a turn): on any
    // other outcome the pointers this call added are taken back off the shelf, and the run's count and payload are left
    // as they were. The value-store rows stay held until the session is released (`releaseSessionTokens`).
    let framed: { text: string; display?: PromptDisplay } = { text: "" };
    const turn = nextSend(hash);
    const added: FilePointer[] = [];
    const shelf = sessionTokens(hash).files;
    const takeBack = <T>(outcome: T): T => { shelf.drop(added.map((f) => f.id)); return outcome; };
    const deliver = async (): Promise<"steer" | "turn" | "continued" | "busy" | "none"> => {
        // A message with nowhere to go holds nothing: a run at the end of its turn (its inbox closed) is busy, and one
        // neither running nor stored is gone. Checked again after the awaits below, which a turn can end during.
        if (runControllers.has(hash) ? action === "continue" || !runInboxes.has(hash) : !stored) return runControllers.has(hash) ? "busy" : "none";
        if (action === "send") {
            const deps = { read: readPdfOffscreen, store: storeHeld, shelf };
            const files = await attachFiles(hash, checked.files, turn, deps);
            added.push(...files.added);
            framed = framePrompt(typed, body.elementContext, files.files);
            const paste = await attachPaste(hash, typed.trim(), turn, deps);
            if (paste) {
                added.push(...paste.added);
                const lined = withPasteLine({ task: framed.text, display: framed.display }, typed.trim(), paste.line);
                framed = { text: lined.task, display: lined.display };
            }
        }
        const { display } = framed;
        if (action === "send" && !framed.text && !attached.length) return takeBack("none");
        const text = routed.notes ? (framed.text ? `${framed.text}\n\n${routed.notes}` : routed.notes) : framed.text;
        const shown = attached.length ? { images: attached } : {};
        if (runControllers.has(hash)) {
            if (action === "continue") return "busy";
            // A run with an inbox takes the steer (steerRun): only then is the message, and what it attached, the run's.
            if (!runInboxes.has(hash)) return takeBack("busy");
            noteSend(hash, turn, added);
            return steerRun(hash, text, origin, display, routed.images, attached) ? "steer" : "busy";
        }
        if (!stored) return takeBack("none");
        // A resume already starting (another send still in the awaits below) makes this one busy: a second RESUME_RUN
        // would be refused by `hostRun` with no one listening, the message shown as sent and then lost.
        if (startingControllers.has(hash)) return takeBack("busy");
        // Re-register the builtin toolset in the page first: the document may not be the one the last turn ran on.
        // Registered as a start for that await: a CANCEL_ALL_RUNS there must stop this resume, not find nothing live.
        // Not on a page the run is still held on (nav-arrival.ts): the turn judges it again, and the person answers first.
        const starting = beginStart(hash, tabId);
        try {
            if (!stored.p.rebuild || (!await holdStands(tabId, hash) && (await adoptOnTab(tabId, hash, stored.p.rebuild)).error)) { endStart(hash, starting); return takeBack("none"); }
            if (starting.signal.aborted) { endStart(hash, starting); return takeBack("none"); }
        } catch (e) {
            endStart(hash, starting);
            throw e;
        }
        if (starting.signal.aborted) { endStart(hash, starting); return takeBack("none"); }
        // Delivered from here on, with no await before the turn is hosted: recorded BEFORE `hostRun` copies the stored
        // payload into the turn's, so the turn and what it stores at its end carry them.
        if (action === "send") noteSend(hash, turn, added);
        if (text || attached.length) announce(tabId, { kind: "agent-say", id: hash, ts: Date.now(), save: false, session: { hash, turn: 0 }, text, ...(display ? { display } : {}), ...shown });
        const steps = stepBudget(body.maxSteps);
        endStart(hash, starting);
        hostRun({ type: "RESUME_RUN", payload: { runId: hash, task: text, ...(steps ? { maxSteps: steps } : {}) } },
            tabId, () => { /* reported through the session's events */ }, action === "send" ? origin : undefined, undefined, routed.images);
        return action === "continue" ? "continued" : "turn";
    };
    try {
        return await deliver();
    } catch (e) {
        throw takeBack(e);
    }
}
