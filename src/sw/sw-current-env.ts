// sw-current-env.ts — `ml.current.env`: the environment a worker-hosted run acts in (site approval, isolation, where an
// approved exec would run, what runs without asking), computed by the same rules the extension applies, at each read.

import { defineState } from "../state-registry";
import { routeExec, type ExecRoute } from "./exec-routing";
import { isolationAvailable, pageApproved } from "./sw-isolated-exec";
import { getConfig } from "./sw-llm";
import { defaultExecWorld, type ExecWorld } from "../contract/contract-config";
import { activeRuns, bgRuns, tabPageUrl } from "./sw-runs";
import type { CurrentEnv, CurrentSnapshot, ExecWhere } from "../agent/current-context";

/** One script for each thing routing tells apart: it reads neither, `ml.current`, or a pointer (execNames). */
const PROBES = { readsNeither: "document.title", readsCurrent: "ml.current.run.step", readsPointer: "ml.dereference('x')" } as const;

/** The longest page URL `env` carries. */
const MAX_URL = 2048;

/** A route, as the model is told it. */
const whereOf = (r: ExecRoute): ExecWhere => (r.where === "main" ? "page" : r.where);

/**
 * The environment of a worker-hosted run, now. The exec column is `routeExec` itself run over a probe script per case,
 * so it cannot drift from where an exec actually goes.
 * @param tabId the run's tab (passed in: the worker records a run in `bgRuns` only when a turn ends)
 * @param readonlyAutoApprove the run's `autoApproveReadonly`
 * @param pageBuilt a run a page drives: its exec runs in the page's world, so the default world is not used (nor told)
 */
export async function currentEnv(tabId: number, readonlyAutoApprove: boolean, pageBuilt = false): Promise<CurrentEnv> {
    // A tab the browser no longer has is not approved on the strength of the URL the worker last saw it at: fail closed.
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    const url = tab ? (tab.url || tabPageUrl.get(tabId) || "") : "";
    const config = await getConfig();
    const [approved, isolation] = await Promise.all([pageApproved(url), isolationAvailable(!!config.cdp)]);
    // A run a page started runs its exec in that page's world, whatever the default: neither wrong there nor the page's to learn.
    return envOf(url, approved, isolation, readonlyAutoApprove, pageBuilt ? "page" : defaultExecWorld(config.execDefaultWorld));
}

/**
 * The environment from its inputs. Pure, so every combination can be checked against `routeExec` itself.
 * @param url the page the tab holds
 * @param approved whether its site is approved
 * @param isolation what the browser offers
 * @param readonlyAutoApprove the run's `autoApproveReadonly`
 * @param defaultWorld where an exec that names no `world` runs (the column is for such an exec)
 */
export function envOf(url: string, approved: boolean, isolation: { userScripts: boolean; cdp: boolean }, readonlyAutoApprove: boolean, defaultWorld: ExecWorld = "page"): CurrentEnv {
    const route = (js: string) => whereOf(routeExec(js, approved, isolation, { defaultWorld }));
    return {
        // The page controls its URL (pushState makes it megabytes): a long one is cut, so it cannot push ml.current
        // over what an approved exec is sent (EXEC_CURRENT_CHARS). Approval was decided on the whole URL above.
        page: { url: url.length > MAX_URL ? `${url.slice(0, MAX_URL)}…` : url, approved },
        isolation: { ...isolation },
        exec: { readsNeither: route(PROBES.readsNeither), readsCurrent: route(PROBES.readsCurrent), readsPointer: route(PROBES.readsPointer) },
        readonlyAutoApprove,
    };
}

/**
 * The snapshot with its `env` added, on a copy.
 * @param current the snapshot as the loop made it
 * @param tabId the run's tab
 * @param readonlyAutoApprove the run's `autoApproveReadonly`
 * @param pageBuilt a run a page drives now (see currentEnv)
 */
export async function withEnv(current: CurrentSnapshot, tabId: number, readonlyAutoApprove: boolean, pageBuilt = false): Promise<CurrentSnapshot> {
    return { ...current, env: await currentEnv(tabId, readonlyAutoApprove, pageBuilt) };
}

defineState({
    id: "run.env", scope: "run", realm: "worker", audience: "model", lostOn: [],
    exposedAs: "ml.current.env",
    describe: "The environment the run acts in, read now: the page and whether its site is approved, what isolation the browser offers, where an approved exec would run, and whether a read-only survey runs without asking.",
    // The inspector's read: the run's tab from the key or the tab→runs index, and the setting as configured now (a run
    // takes it at its start, so this differs only if it was changed during the run).
    read: async ({ runId, tabId }) => {
        const tab = tabId ?? (runId ? [...activeRuns].find(([, ids]) => ids.has(runId))?.[0] : undefined) ?? (runId ? bgRuns.get(runId)?.tabId : undefined);
        return tab === undefined ? undefined : currentEnv(tab, !!(await getConfig()).autoApproveReadonly);
    },
});
