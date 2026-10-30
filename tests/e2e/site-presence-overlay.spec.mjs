// site-presence-overlay.spec.mjs — the red team's SITE_PRESENCE gap (7) rows: the in-page overlay on a page whose site
// may not use window.ml. `sidebar-shell.js` is a statically registered content script (`<all_urls>`), so it runs
// everywhere, and on main it mounts its host into the page as soon as the config says `debugMode: "overlay"` — even on
// a page that gets nothing else of ours until a run the person starts there (docs/spec/SITE_PRESENCE.md, step 4).
// The card already waits for the worker's word before it puts anything into a page; the overlay does not.
//
// Measured on main 2026-10-30 (probe tab on other.test, never allowed, `debugMode: "overlay"`, no run): the page's DOM
// gains `<div id="ml-sb-root" popover="manual" style="all: initial !important;">` as a direct child of `<html>`, ~40 ms
// after the config lands — and the same mount happens when the mode is switched to overlay with the page already open.
// That host is not the id alone: its SHAPE is a child of `<html>` carrying `popover` and an inline `style` (or, if a fix
// renames it, a random custom-element tag). These rows find ours by that shape, never by `#ml-sb-root` — and the
// allowed page's control proves the machinery that finds it is live.
//
// The landing form is site-access.spec.mjs's: while a row's slice is `OPEN` it asserts the leak SUCCEEDED, positively,
// and flipping the entry asserts the defended outcome. `gap7` flips in a commit of mine on the branch of the PR that
// lands the fix, before that PR merges (the rule-10 amendment for Playwright rows).
//
// The page is the detection probe (fixtures/detect/), driven by the clean browser: no Playwright client on the page, so
// what the page records is the extension's own doing. This file keeps its own copies of `readDom` and the config
// helper rather than reaching into another spec: a row file that reads the page by its own hand is the point.

import { test, expect } from "@playwright/test";
import { launchClean } from "./fixtures/detect/clean-browser.mjs";
import { startProbeSite, DETECT_RESOLVER_ARGS } from "./fixtures/detect/server.mjs";
import { openProbe, waitFor, sleep } from "./fixtures/detect/measure.mjs";
import { startFakeLlm } from "./fake-llm.mjs";

/** The slices that have NOT landed, one per fix. `gap7` is SITE_PRESENCE gaps (7), the security lane's fix to come. */
const OPEN = { gap7: true };

/** Whether `slice` is still open, recording it on the test so the report says which holes this run demonstrated. */
function holeOpen(slice, what) {
    const open = OPEN[slice];
    if (open) test.info().annotations.push({ type: "open hole", description: `${slice}: ${what}` });
    return open;
}

const HIDDEN = "other.test";   // a page the person never allowed: hidden in SITE_PRESENCE's sense
const ALLOWED = "probe.test";  // the control: an origin that may use window.ml

/** Every host the probe site answers for, as secure contexts, so the browser sends `Sec-Fetch-*` as it would to https. */
const secureArgs = (site) => [`--unsafely-treat-insecure-origin-as-secure=${["probe.test", "other.test", "xo.test", "api.test"].map((h) => site.origin(h)).join(",")}`];

/** A custom-element-shaped tag (a hyphen, the one a random per-session name must have to be a custom element at all). */
const CUSTOM_TAG = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)+$/i;
/** The fixture page's own custom element, the one anonymous tag its markup ships with. */
const FIXTURE_TAGS = new Set(["sealed-box"]);

/**
 * Whether one element the page saw ADDED is ours, by shape and not by name: a child of `<html>` that is not the
 * document's own `head`/`body` (where the shell's host goes), an element carrying `popover` or an inline `style` (the
 * two attributes every host of ours wears), or a random custom-element tag the fixture did not write.
 * @param {{parent?: string, tag?: string, attrs?: string[]}} a one `dom-add` record
 */
const ours = (a) => {
    const tag = String(a.tag ?? "");
    const attrs = a.attrs ?? [];
    return (a.parent === "html" && tag !== "head" && tag !== "body")
        || attrs.includes("popover") || attrs.includes("style")
        || (CUSTOM_TAG.test(tag) && !FIXTURE_TAGS.has(tag));
};

/** What the PAGE reads of its own DOM: every child of `<html>` by shape, and the HTML the name scans run over. */
const READ_JS = `(() => ({
    kids: [...document.documentElement.children].map((el) => ({ tag: el.tagName.toLowerCase(), id: el.id || null, attrs: [...el.attributes].map((a) => a.name) })),
    html: document.documentElement.outerHTML,
}))()`;

/**
 * Read the page's DOM as the page itself could: attach a client, evaluate, detach.
 * @param {ReturnType<typeof launchClean>} b the clean browser
 * @param {string} targetId the probe tab's target
 */
async function readDom(b, targetId) {
    const { sessionId } = await b.cdp.send("Target.attachToTarget", { targetId, flatten: true });
    try {
        const r = await b.cdp.send("Runtime.evaluate", { expression: READ_JS, returnByValue: true }, sessionId);
        return r.result.value;
    } finally {
        await b.cdp.send("Target.detachFromTarget", { sessionId }).catch(() => {});
    }
}

/** The four storage keys every row sets, on top of the defaults `DEFAULT_CONFIG` supplies. */
const BASE = (fake) => ({ chatUrl: fake.url, apiKey: "", apiFormat: "openai", model: "fake-model", modelFilter: "", autoApproveReadonly: false, defaultModelVision: "yes" });

/**
 * One row's scene: a probe site, the fake model, a clean browser with `probe.test` allowed and `other.test` not, and
 * `debugMode` as the row needs it. Resolves with the browser, the site and a `page` opener — the caller opens the page
 * so it can watch the config land before or after, which is the difference between rows (1) and (2).
 * @param {string} debugMode the mode the config carries when the browser starts ("off" or "overlay")
 */
async function scene(debugMode) {
    const site = await startProbeSite();
    const fake = await startFakeLlm({ model: "fake-model" });
    fake.setSide(() => ({ content: "1" }));
    const b = await launchClean({ args: [...DETECT_RESOLVER_ARGS, ...secureArgs(site)], extension: true });
    const setConfig = (mode) => b.sw((c) => chrome.storage.sync.set(c), { ...BASE(fake), debugMode: mode });
    const close = async () => { await b.close(); await fake.stop(); await site.stop(); };
    try {
        await setConfig(debugMode);
        // Only probe.test may use window.ml: its approval is what registers the page scripts (sw-presence.ts). Waiting
        // for that registration keeps every row's page the FIRST navigation under the list the row means to measure.
        await b.sw((o) => chrome.storage.local.set({ ml_site_always: o }), [site.origin(ALLOWED)]);
        await b.sw(async () => {
            for (let i = 0; i < 100 && !(await chrome.scripting.getRegisteredContentScripts()).length; i++) await new Promise((r) => setTimeout(r, 20));
        });
        return { site, fake, b, setConfig, close };
    } catch (e) {
        await close();
        throw e;
    }
}

/** The elements ours put into the page, from the probe's own records. */
const oursAdded = (page) => page.reports().filter((e) => e.kind === "dom-add" && ours(e)).map((e) => `${e.tag}${e.id ? "#" + e.id : ""}`);

// --- gap (7): the overlay never mounts on a page whose site may not use window.ml ---

test.describe("@security SITE_PRESENCE gap (7): the overlay on a page that gets nothing of ours", () => {
    test("row (7.1): a hidden page with debugMode overlay and no run gets nothing of ours", async () => {
        test.setTimeout(90_000);
        const s = await scene("overlay");
        try {
            const page = await openProbe(s.b, s.site, HIDDEN, "/");
            // Measured on main 2026-10-30: the mount lands ~40 ms after the config reaches the shell; 1.5 s covers a
            // cold worker start (the config read is the shell's first async step) without turning a slow run into a pass.
            await sleep(1500);
            const adds = oursAdded(page);
            const open = holeOpen("gap7", "the overlay mounts its host on a page that may not use window.ml");
            if (open) expect(adds, "today's leak: the overlay's host, on a page with no run").toContain("div#ml-sb-root");
            else expect(adds, "nothing of ours was added to the hidden page").toEqual([]);
            const dom = await readDom(s.b, page.targetId);
            expect(dom.kids.map((k) => k.tag), `the page's children, as the row means them: ${JSON.stringify(dom.kids)}`).toEqual(open ? ["head", "body", "div"] : ["head", "body"]);
            if (!open) expect(dom.html, "and no host in the HTML the page reads").not.toMatch(/popover=|all: initial/);
        } finally {
            await s.close();
        }
    });

    test("row (7.2): switching debugMode to overlay with the hidden page already open adds nothing", async () => {
        test.setTimeout(90_000);
        const s = await scene("off");
        try {
            const page = await openProbe(s.b, s.site, HIDDEN, "/");
            await sleep(1200);
            const tSwitch = Date.now();
            await s.setConfig("overlay");
            await sleep(1500);
            const after = page.reports().filter((e) => e.kind === "dom-add" && e.t >= tSwitch);
            const adds = after.filter(ours).map((e) => `${e.tag}${e.id ? "#" + e.id : ""}`);
            const open = holeOpen("gap7", "the overlay mounts into a page already open, when the mode changes");
            if (open) expect(adds, "today's leak: the host appears on the running page").toContain("div#ml-sb-root");
            else expect(adds, "the mode change put nothing into the hidden page").toEqual([]);
            const dom = await readDom(s.b, page.targetId);
            expect(dom.kids.map((k) => k.tag), "the page's children, as the row means them").toEqual(open ? ["head", "body", "div"] : ["head", "body"]);
        } finally {
            await s.close();
        }
    });

    test("row (7.3): control — on an allowed page the overlay still mounts, so the scan can find a host", async () => {
        test.setTimeout(90_000);
        const s = await scene("overlay");
        try {
            const page = await openProbe(s.b, s.site, ALLOWED, "/");
            await sleep(1500);
            // The control finds the host by the same SHAPE the other rows scan for — and by its ml- name too, so a
            // silent rename would redden this row rather than quietly making the scan vacuous.
            expect(oursAdded(page), "the allowed page's overlay host is added, and the shape scan sees it").toContain("div#ml-sb-root");
            const dom = await readDom(s.b, page.targetId);
            expect(dom.kids.map((k) => k.tag), "the allowed page keeps the overlay as a child of <html>").toEqual(["head", "body", "div"]);
        } finally {
            await s.close();
        }
    });

    test("row (7.4): during a run the person starts on a hidden page, the overlay adds nothing either", async () => {
        test.setTimeout(90_000);
        const s = await scene("overlay");
        try {
            const page = await openProbe(s.b, s.site, HIDDEN, "/");
            await sleep(1200);
            const t0 = Date.now();
            // A run held at its first gate (a `type` on #field is gated), so the shell is live in the page for as long
            // as this row reads — the state in which the overlay would mount if it mounted at all.
            s.fake.setScript([{ tool: "type", args: { selector: "#field", text: "x" } }, { content: "done" }]);
            await s.b.sw(({ tabId }) => globalThis.__mlStartUserRunForTest(tabId, { task: "do the scripted step", surface: "hud", hud: "quiet" }, { approvalRouting: "both" }), { tabId: page.tabId });
            const gate = await waitFor(async () => (await s.b.sw(() => globalThis.__mlApprovals.list()))[0] ?? null, 30000, "the approval gate to open");
            expect(gate.tool, "the run gated on the scripted type (the run machinery's positive control)").toBe("type");
            const tHeld = Date.now();
            // Measured on main 2026-10-30: the overlay's mount lands ~40 ms after the shell's config read, and the
            // shell here starts with the run. The 2 s settle is from the gate, after the shell was loaded.
            await sleep(2000);
            const adds = oursAdded(page);
            const open = holeOpen("gap7", "the overlay mounts while a run the person started acts on the page");
            if (open) expect(adds, "today's leak: the overlay's host, while the run acts").toContain("div#ml-sb-root");
            else expect(adds, "the shell put nothing of the overlay into the page during the run").toEqual([]);
            const dom = await readDom(s.b, page.targetId);
            expect(dom.kids.map((k) => k.tag), "the page's children, with a run live").toEqual(open ? ["head", "body", "div"] : ["head", "body"]);
            expect(tHeld).toBeGreaterThan(t0);
        } finally {
            await s.close();
        }
    });
});
