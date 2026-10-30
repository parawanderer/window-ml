// site-presence-render.spec.mjs — the red team's SITE_PRESENCE step-5 rows for the TAB-RENDER half (#1316): what a
// rendered fetch's tab does with a navigation nobody authorised (docs/spec/SITE_PRESENCE.md, "Redirects on
// auto-approved fetches"). The property is "the hop's target was NEVER REQUESTED", and only a real server's request
// log can show it: a rendered fetch opens a TAB and the browser follows the Location chain itself, so no mock and no
// unit test sees the hop. These rows run against the render fixture (fixtures/render/), whose log is the oracle.
//
// The driver is an agent run on a merely-allowed page (`fetch_url` with `rendered: true`, every gate approved from
// `__mlApprovals`): an uncredentialed render is the INCOGNITO one, which is why the browser launches with incognito
// on. That is the caller the issue names — a rendered fetch for an UNTRUSTED caller — and the approval is what makes
// the first URL reachable at all.
//
// The landing form is tests/e2e/site-access.spec.mjs's: while the slice is `OPEN` a row asserts the leak SUCCEEDED,
// positively (a fixture that never redirects cannot pass it), and flipping the entry asserts the defended outcome.
// The flip is a commit of mine on the fix's branch before it merges (the rule-10 amendment, #1307).

import { test, expect } from "@playwright/test";
import { launchExtension, configureExtension, waitForMl } from "./harness.mjs";
import { startFakeLlm } from "./fake-llm.mjs";
import { startRenderSite, renderResolverArgs, renderSecureArgs } from "./fixtures/render/server.mjs";

/** The slices of step 5's render half that have NOT landed. */
const OPEN = { renderGuard: true };

/** Whether `slice` is still open, recording it on the test so the report says which holes this run demonstrated. */
function holeOpen(slice, what) {
    const open = OPEN[slice];
    if (open) test.info().annotations.push({ type: "open hole", description: `${slice}: ${what}` });
    return open;
}

test.describe.configure({ mode: "default" });

/** One browser for the file: incognito on (a rendered fetch for an untrusted caller is the private one), the render
 *  fixture (its resolver flags name its port, so it has to outlive the launch) and a scriptable fake model. */
let site, fake, ext;
test.beforeAll(async () => {
    site = await startRenderSite();
    fake = await startFakeLlm({ model: "fake-model" });
    ext = await launchExtension({ incognito: true, args: [...renderResolverArgs(site), ...renderSecureArgs(site)] });
    await configureExtension(ext.sw, {
        chatUrl: fake.url, apiKey: "", apiFormat: "openai", model: "fake-model",
        modelFilter: "", debugMode: "off",
    });
});
test.afterAll(async () => { await ext?.close(); await fake?.stop(); await site?.stop(); });

/**
 * One row's scene: a FRESH PAGE on `attacker.test` — a tab of its own, which is what makes a fresh approval set, since
 * fetch consent and the remembered URL are per tab — that may use window.ml but is NOT self-approving, so the fetch
 * takes the untrusted path the issue is about. The fixture's log is cleared after the page's own load, so every row
 * counts only what its run asked for.
 */
async function scene() {
    const page = await ext.context.newPage();
    await page.goto(site.url("attacker.test", "/"));
    await waitForMl(page);
    site.clear();
    return { site, fake, ext, page, close: async () => { await page.close(); } };
}

/** Approve every gate that appears until the fake model has had `want` calls (fetch-tables.spec.mjs's driver). */
async function driveApprovals(ext, fake, want, before) {
    const deadline = Date.now() + 40000;
    while (Date.now() < deadline && fake.calls().length - before < want) {
        const pending = await ext.sw.evaluate(() => globalThis.__mlApprovals.list());
        for (const g of pending) await ext.sw.evaluate((key) => globalThis.__mlApprovals.resolve(key, true), g.key);
        await new Promise((r) => setTimeout(r, 200));
    }
}

/**
 * Drive a run's tool calls through a real agent run and return what the model saw PER TOOL CALL: `results[i]` is
 * the content of the model turn answering step `i`. A row that claims something about one call reads its own index.
 * @param {{ext: any, fake: any, page: any}} h
 * @param {Array<{tool: string, args: Record<string, unknown>}>} tools
 * @returns {Promise<string[]>} one content string per tool message, in call order
 */
async function run(h, tools) {
    const before = h.fake.calls().length;
    h.fake.setScript([...tools, (req) => ({ content: req.messages.map((m) => (typeof m.content === "string" ? m.content : "")).join("\n") })]);
    const runPromise = h.page.evaluate((t) => window.ml.agent(t, { env: false, approvalRouting: "both" }), "read what I asked for");
    await driveApprovals(h.ext, h.fake, tools.length + 1, before);
    await runPromise.catch(() => {});
    await expect.poll(() => h.fake.calls().length - before, { timeout: 30000 }).toBeGreaterThanOrEqual(tools.length + 1);
    const msgs = h.fake.calls().at(-1).messages;
    return msgs.filter((m) => m.role === "tool" && typeof m.content === "string").map((m) => m.content);
}

/** Every tool result of a run, joined: for a row whose claim spans the whole run. */
const joined = (results) => results.join("\n---\n");

/** A rendered fetch of `path` on attacker.test, as one tool call, approved. */
const renderOf = (site, path) => [{ tool: "fetch_url", args: { url: site.url("attacker.test", path), rendered: true } }];

/** The page's own load, logged before every row: the rows compare paths, never the whole log. */
const pathsTo = (site, host) => site.requestsTo(host).map((q) => q.path);

// --- the control: a rendered fetch works, and the tab is born with its URL ---

test("@security SITE_PRESENCE step 5 (render): the rendered page comes back, and its first request is not a navigation FROM anywhere", async () => {
    test.setTimeout(120_000);
    const h = await scene();
    try {
        const results = await run(h, renderOf(h.site, "/ok"));
        expect(joined(results), "the rendered body comes back (a fixture that renders nothing cannot pass this)").toContain("ok from attacker.test");
        const ok = h.site.requestsTo("attacker.test").filter((q) => q.path === "/ok");
        expect(ok.length, "the tab loaded the URL it was given, once").toBe(1);
        // (f) THE PIN for the fix's own shape: the tab must be CREATED with its URL. An `about:blank` tab then
        // `tabs.update` sends `Sec-Fetch-Site: cross-site` on the first request (the issue's measurement), which
        // this row would catch on the fix's side — on main the tab is created with its URL and this holds too.
        expect(ok[0].headers["sec-fetch-site"], "the first request has no initiator: the tab was born at its URL").toBe("none");
    } finally {
        await h.close();
    }
});

// --- R1: a cross-site 302 at the first hop never requests its target ---

test("@security SITE_PRESENCE step 5 (render): R1: a cross-site 302 is refused with its target never requested", async () => {
    test.setTimeout(120_000);
    const h = await scene();
    try {
        const results = await run(h, renderOf(h.site, "/start"));
        // The anchor, both sides: the fixture really answered, so a fixture that never redirects reddens the row
        // in either form rather than passing it.
        expect(pathsTo(h.site, "attacker.test"), "the first URL was requested (the anchor)").toContain("/start");
        if (holeOpen("renderGuard", "the tab follows the off-site 302 and requests its target")) {
            expect(pathsTo(h.site, "victim.test"), "today's leak: the hop's target is requested by the render's tab").toContain("/secret");
        } else {
            expect(h.site.requestsTo("victim.test"), "the hop's target was never requested").toEqual([]);
        }
        // Both sides (a pin): the model is told the target, and is never handed the other site's content as if it
        // were the page it asked for.
        expect(joined(results), "the refusal names the target").toContain("victim.test");
        expect(joined(results), "and the model does not get the other site's body").not.toContain("top secret");
    } finally {
        await h.close();
    }
});

// --- R2: the same at a chain's SECOND hop, after an allowed first one ---

test("@security SITE_PRESENCE step 5 (render): R2: a chain is refused at its cross-site second hop", async () => {
    test.setTimeout(120_000);
    const h = await scene();
    try {
        const results = await run(h, renderOf(h.site, "/hop1"));
        expect(pathsTo(h.site, "attacker.test"), "the same-site first hop was followed (the anchor, both sides)").toContain("/hop2");
        if (holeOpen("renderGuard", "the tab follows the chain and requests the second hop's target")) {
            expect(pathsTo(h.site, "victim.test"), "today's leak: the chain's last target is requested").toContain("/secret");
        } else {
            expect(h.site.requestsTo("victim.test"), "the second hop's target was never requested").toEqual([]);
        }
        expect(joined(results), "the refusal names the target (both sides)").toContain("victim.test");
    } finally {
        await h.close();
    }
});

// --- R3: a SCRIPT navigation is held the same way ---

test("@security SITE_PRESENCE step 5 (render): R3: a script navigation to another site is held", async () => {
    test.setTimeout(120_000);
    const h = await scene();
    try {
        const results = await run(h, renderOf(h.site, "/script"));
        expect(pathsTo(h.site, "attacker.test"), "the page itself was rendered (the anchor, both sides)").toContain("/script");
        if (holeOpen("renderGuard", "the rendered page's script navigates the tab off-site and its target is requested")) {
            expect(pathsTo(h.site, "victim.test"), "today's leak: the script's target is requested").toContain("/secret");
        } else {
            expect(h.site.requestsTo("victim.test"), "the script's target was never requested").toEqual([]);
        }
        expect(joined(results), "the model is told, and not handed the navigated-to page").not.toContain("top secret");
    } finally {
        await h.close();
    }
});

// --- R4: an off-site iframe is not loaded, a same-site one is ---

test("@security SITE_PRESENCE step 5 (render): R4: a cross-site frame is not requested, a same-site frame is", async () => {
    test.setTimeout(120_000);
    const h = await scene();
    try {
        const results = await run(h, renderOf(h.site, "/frames"));
        expect(joined(results), "the page itself was rendered (the anchor, both sides)").toContain("frames");
        // The same-site frame (same registrable domain, `sub.attacker.test`) loads on BOTH sides: a rule that
        // blocks every frame, or a rule keyed to the exact host rather than the domain, breaks here.
        expect(pathsTo(h.site, "sub.attacker.test"), "the same-site frame is requested (both sides)").toContain("/frame-ok");
        if (holeOpen("renderGuard", "the rendered page's cross-site iframe is requested")) {
            expect(pathsTo(h.site, "victim.test"), "today's leak: the cross-site frame is requested").toContain("/frame-secret");
        } else {
            expect(h.site.requestsTo("victim.test"), "the cross-site frame was never requested").toEqual([]);
        }
    } finally {
        await h.close();
    }
});

// --- R5: a hop to a URL the run ALREADY approved is followed, and its body comes back ---

test("@security SITE_PRESENCE step 5 (render): R5: a hop to a URL this run already approved is followed and read", async () => {
    test.setTimeout(120_000);
    const h = await scene();
    try {
        const ok = h.site.url("partner.test", "/ok");
        // Two calls, read per call: the first approves partner.test/ok by fetching it directly, the second reaches
        // it through attacker.test's `/to-partner` — so the direct call's own evidence cannot satisfy the row.
        const results = await run(h, [
            { tool: "fetch_url", args: { url: ok } },
            { tool: "fetch_url", args: { url: h.site.url("attacker.test", "/to-partner"), rendered: true } },
        ]);
        expect(results, "one tool result per call").toHaveLength(2);
        expect(results.at(-1), "the approved hop is followed and its body comes back (both sides)").toContain("ok from partner.test");
        // More than one `/ok` means the render's tab asked for the target itself: the direct call is one, so a
        // refused hop leaves exactly one. Not an exact count — a followed hop may reload the chain after widening.
        expect(h.site.requestsTo("partner.test").filter((q) => q.path === "/ok").length, "the target was requested by the tab too").toBeGreaterThan(1);
    } finally {
        await h.close();
    }
});

// --- R6: the same hop in a FRESH run (no approval) is refused before its target is requested ---

test("@security SITE_PRESENCE step 5 (render): R6: the same hop in a fresh run never requests the target", async () => {
    test.setTimeout(120_000);
    const h = await scene();
    try {
        const results = await run(h, renderOf(h.site, "/to-partner"));
        expect(pathsTo(h.site, "attacker.test"), "the first URL was requested (the anchor, both sides)").toContain("/to-partner");
        if (holeOpen("renderGuard", "the fresh run's render follows the hop and requests the unapproved target")) {
            expect(pathsTo(h.site, "partner.test"), "today's leak: the unapproved target is requested").toContain("/ok");
        } else {
            expect(h.site.requestsTo("partner.test"), "the unapproved target was never requested").toEqual([]);
        }
        expect(joined(results), "the refusal names the target (both sides)").toContain("partner.test");
    } finally {
        await h.close();
    }
});

// --- R7: a hop to a SUBDOMAIN (same registrable domain) is followed, and its body comes back ---

test("@security SITE_PRESENCE step 5 (render): R7: a subdomain hop is followed and its body comes back", async () => {
    test.setTimeout(120_000);
    const h = await scene();
    try {
        const results = await run(h, renderOf(h.site, "/sub"));
        expect(pathsTo(h.site, "sub.attacker.test"), "the subdomain is the same registrable domain, so the hop is made (both sides)").toContain("/ok");
        if (holeOpen("renderGuard", "the followed hop's body is withheld by main's final-origin guard")) {
            // Today the chain IS followed and the tab renders it, but main's guard compares ORIGINS, so the body is
            // withheld for a subdomain hop. Asserted positively — the leak on this side is the hop being made at
            // all (above) and the reader getting an error instead of the page, so a dead fixture cannot pass it.
            expect(joined(results), "today: the followed hop's body is withheld").toMatch(/redirected to a different origin/i);
        } else {
            expect(joined(results), "the followed hop RETURNS its body").toContain("ok from sub.attacker.test");
        }
    } finally {
        await h.close();
    }
});

// --- R8: a render leaves no session rule behind ---

test("@security SITE_PRESENCE step 5 (render): R8: no declarativeNetRequest session rule outlives a render", async () => {
    test.setTimeout(120_000);
    const h = await scene();
    try {
        await run(h, renderOf(h.site, "/start"));
        // Both sides: on main the API is not even in the manifest (no `declarativeNetRequest` permission), so the
        // row is the FIX's to keep — a guard that forgets to remove its session rule would leave every later tab
        // held to a dead render's site, and nothing else in the suite would see it.
        const rules = await h.ext.sw.evaluate(async () => {
            const dnr = /** @type {any} */ (chrome).declarativeNetRequest;
            if (!dnr?.getSessionRules) return "no-api";
            return (await dnr.getSessionRules()).map((r) => ({ id: r.id, action: r.action?.type, condition: r.condition }));
        });
        expect(rules === "no-api" ? [] : rules, "a render removed its session rule").toEqual([]);
    } finally {
        await h.close();
    }
});
