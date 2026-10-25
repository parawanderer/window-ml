// ml-access.ts — `ml.requestAccess`: a site asking the person for more than it has, from the page's main world.
//
// docs/spec/SITE_ACCESS.md "Requesting access" and docs/spec/SITE_ACCESS_SLICE3.md PR 4. This side only posts the
// request: the content script adds whether the person just acted on the page, and the worker applies every rule
// (site-requests.ts). It resolves with the answer and never throws, so a page can call it without a try.

import { makeBackgroundTaskPromise } from "../bridge";
import type { AccessAnswer } from "../contract/contract-config";

/**
 * Ask the person for the agent level or self-approval (`ml.requestAccess`).
 * @param opts what to ask for, and the site's reason in its own words
 * @returns the answer: granted (with the agent level's state), pending, denied, or refused with why
 */
export async function requestAccess(opts?: { agents?: boolean; level?: "self-approve"; reason?: string }): Promise<AccessAnswer> {
    const o = opts && typeof opts === "object" ? opts : {};
    const payload = { agents: o.agents === true, level: o.level === "self-approve" ? "self-approve" : undefined, reason: typeof o.reason === "string" ? o.reason : undefined };
    try {
        const r = await makeBackgroundTaskPromise<AccessAnswer>("REQUEST_ACCESS_REQUEST", "REQUEST_ACCESS_RESPONSE", payload);
        return r && typeof r === "object" && typeof (r as { state?: unknown }).state === "string" ? r : { state: "refused", reason: "no answer" };
    } catch (e) {
        return { state: "refused", reason: String((e as Error)?.message ?? e) };
    }
}
