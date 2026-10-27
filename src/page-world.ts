// page-world.ts — which world the page-side bundle (injected.ts and what it bundles) runs in: the page's own, or ours.

/** Where the page-side bundle runs. `main` is injected.js, the page's world, where window.ml lives for a site that may see
 *  it. `isolated` is injected-isolated.js, put into the content scripts' world for a run the person starts on a page that
 *  may not (docs/spec/SITE_PRESENCE.md, step 3): the same tools, with nothing of ours in the page's world. */
export const pageWorld: { isolated: boolean } = { isolated: false };   // state: fixed — set once, before injected.ts runs, by injected-isolated.ts
