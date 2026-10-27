// adopt-run.ts — registers a run's toolset on the document its tab holds now, outside a navigation's re-adopt.

import { pageRebuild } from "../agent/run-assembly";
import type { RebuildConfig } from "../contract";
import { delegateSend } from "./delegate-send";
import { NO_RECEIVER, restoreContentScripts } from "./sw-page-restore";
import { injectRunTools } from "./sw-presence";

/**
 * Push a run's builtin toolset into a tab and hear its page context: `ADOPT_RUN_NOW`, through `delegateSend` (which
 * waits out a navigation and rebuilds a discarded tab). A tab whose content script went with an extension reload gets
 * it put back and is asked once more, as the chat page's own page commands do (sw-page-restore.ts).
 * @param tabId the tab
 * @param runId the run
 * @param rebuild what the page needs to rebuild the toolset
 * @returns the page's answer; `{ error }` when it could not host the run, with `unanswered` when nothing in the tab
 *   answered at all (as opposed to a page that answered that it cannot)
 */
export async function adoptOnTab(tabId: number, runId: string, rebuild: RebuildConfig): Promise<{ pageInfo?: string; error?: string; unanswered?: true }> {
    // The content script posts this to the page's window: only what the page still needs of it (`pageRebuild`).
    const msg = { type: "ADOPT_RUN_NOW", payload: { runId, rebuild: pageRebuild(rebuild) } };
    const why = (e: unknown): string => String((e as Error)?.message || e);
    const silent = { error: "the page did not answer; it may still be loading, or the extension cannot run there", unanswered: true as const };
    // A hidden page (SITE_PRESENCE.md step 2) has no page script: the content script asks for one, the worker puts it in
    // this document, and sends the adopt again saying so, which is what lets the content script speak to the page.
    const send = async (): Promise<{ pageInfo?: string; error?: string; unanswered?: true } | undefined> => {
        const r = await delegateSend(tabId, msg) as { pageInfo?: string; error?: string; needInject?: boolean } | undefined;
        if (!r?.needInject) return r;
        await injectRunTools(tabId);
        return await delegateSend(tabId, { ...msg, payload: { ...msg.payload, injected: true } }) as { pageInfo?: string; error?: string } | undefined;
    };
    try {
        return (await send()) ?? silent;
    } catch (e) {
        if (!NO_RECEIVER.test(why(e))) return { error: why(e), unanswered: true };
    }
    try {
        if (!await restoreContentScripts(tabId)) return silent;
        return (await send()) ?? silent;
    } catch { return silent; }
}
