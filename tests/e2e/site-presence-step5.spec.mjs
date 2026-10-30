// site-presence-step5.spec.mjs — the red team's SITE_PRESENCE step-5 rows: what a judged redirect on an
// auto-approved fetch does to the hop's TARGET (docs/spec/SITE_PRESENCE.md, "Redirects on auto-approved
// fetches"). The property is "the target was NEVER REQUESTED" — only a real server's request log can show
// it: a mocked fetch cannot observe the browser's internal `redirect: "follow"` hop (the code makes one
// fetch call either way), and the fix's `hopOnce` depends on `chrome.webRequest`, which only exists in a
// real browser. So these are e2e rows against the redirect fixture (fixtures/redirect/), whose logs are the
// oracle: `site.requestsTo(host)` is empty or not.
//
// The landing form is tests/e2e/site-access.spec.mjs's: while the slice is `OPEN` a row asserts the leak
// SUCCEEDED, positively (a broken fixture cannot pass it), and flipping the entry asserts the defended
// outcome. The flip is a commit of mine on the fix's branch (#1305, `feat/redirect-judge`) before it merges
// (the rule-10 amendment, #1307: a Playwright row that flips only on a merge sha reddens the fix's own CI
// while it waits — SITE_PRESENCE.md's older "the finder flips after each half merges" line predates it).
//
// What the worker half must hold (the lane's brief): a hop is followed when it stays on the same registrable
// domain, upgrades http→https on the same host, goes to an origin/URL already approved in this run, or is a
// declared pair (FETCH_SHEET: docs.google.com → *.googleusercontent.com); any other hop is refused BEFORE
// its target gets a request. Disclosure follows WHO READS THE RESULT: a page's own ml.fetch, and a run the
// PAGE started (its tool results live in the page's world), are told only "another site", never the
// Location; a WORKER-hosted run's model sees the full target ("Fetch that URL directly to approve it."),
// and so does the person. FETCH_SHEET's
// accounts.google.com sign-in hop is refused with "not signed in to Google in this browser". FETCH_IMAGE_B64
// is the declared exception: it keeps following a cross-site (CDN) hop, but the public-host raster check
// applies on EVERY hop before requesting it — a chain that hops a loopback/private host is IMAGE_FAILED
// with no request at or past the bad hop. A judged hop that is followed RETURNS ITS BODY: the same-site
// hop's body comes back (on main the final-origin guard withholds it), and that edge flips here too.

import { test, expect } from "@playwright/test";
import { launchExtension, configureExtension, waitForMl } from "./harness.mjs";
import { startFakeLlm } from "./fake-llm.mjs";
import { startRedirectSite, redirectResolverArgs, secureOriginArgs } from "./fixtures/redirect/server.mjs";

/** The slices of step 5 that have NOT landed. `step5worker` is the worker-fetch half (PR #1305): flip the
 *  entry in my commit on that PR's branch before it merges — the rows then assert the defended outcome. */
const OPEN = { step5worker: true };

/** Whether `slice` is still open, recording it on the test so the report says which holes this run demonstrated. */
function holeOpen(slice, what) {
    const open = OPEN[slice];
    if (open) test.info().annotations.push({ type: "open hole", description: `${slice}: ${what}` });
    return open;
}

/**
 * One row's scenario: a fresh browser (fetch consent is per-tab state, and "fetch_url remembers an approved
 * URL for the session" — a fresh tab per test is what makes a "fresh run" fresh), the redirect fixture and a
 * scriptable fake model, and a page on `host` that may use window.ml.
 * @param {string} host the page's fixture hostname
 * @param {{ selfApprove?: boolean }} [opts] `selfApprove` puts the host on the self-approval list (the site may act
 *  without asking): a credentialed FETCH_SHEET is refused for a merely-allowed tab, so the sheet rows need it.
 */
async function rowSetup(host, { selfApprove = false } = {}) {
    const site = await startRedirectSite();
    const fake = await startFakeLlm({ model: "fake-model" });
    const ext = await launchExtension({ args: [...redirectResolverArgs(site), ...secureOriginArgs(site), "--ignore-certificate-errors"] });
    await configureExtension(ext.sw, {
        chatUrl: fake.url, apiKey: "", apiFormat: "openai", model: "fake-model",
        modelFilter: "", debugMode: "off", autoApprovePython: true,
        ...(selfApprove ? { pageApprovalDomains: [site.origin(host)] } : {}),
    });
    const page = await ext.context.newPage();
    await page.goto(site.url(host, "/"));
    await waitForMl(page);
    return {
        site, fake, ext, page,
        close: async () => { await ext.close(); await fake.stop(); await site.stop(); },
    };
}

/** Approve every gate that appears until the fake model has had `want` calls (fetch-tables.spec.mjs's driver:
 *  NOT "wait for exactly one gate" — a remembered URL opens none). */
async function driveApprovals(ext, fake, want, before) {
    const deadline = Date.now() + 40000;
    while (Date.now() < deadline && fake.calls().length - before < want) {
        const pending = await ext.sw.evaluate(() => globalThis.__mlApprovals.list());
        for (const g of pending) await ext.sw.evaluate((key) => globalThis.__mlApprovals.resolve(key, true), g.key);
        await new Promise((r) => setTimeout(r, 200));
    }
}

/**
 * Drive a run's tool calls through a real agent run (the page's `window.ml.agent`, `approvalRouting: "both"`),
 * approving every gate, and return what the model saw on its final turn PER TOOL CALL: `results[i]` is the
 * content of the model turn answering step `i`. A row that claims something about one call reads its own
 * index — joining every result would let an earlier call's content satisfy an assertion about a later one
 * (W3a's first, direct fetch carries the same body its hop does).
 * @param {{ext: any, fake: any, page: any}} h
 * @param {Array<{tool: string, args: Record<string, unknown>}>} tools
 * @returns {Promise<string[]>} one content string per tool message, in call order
 */
async function runThroughTools(h, tools, task = "do the scripted steps and report") {
    const before = h.fake.calls().length;
    h.fake.setScript([...tools, (req) => ({ content: req.messages.map((m) => (typeof m.content === "string" ? m.content : "")).join("\n") })]);
    const runPromise = h.page.evaluate((t) => window.ml.agent(t, { env: false, approvalRouting: "both" }), task);
    await driveApprovals(h.ext, h.fake, tools.length + 1, before);
    await runPromise.catch(() => {});
    await expect.poll(() => h.fake.calls().length - before, { timeout: 30000 }).toBeGreaterThanOrEqual(tools.length + 1);
    const msgs = h.fake.calls().at(-1).messages;
    return msgs.filter((m) => m.role === "tool" && typeof m.content === "string").map((m) => m.content);
}

/** Every tool result of a run, joined: for a row whose claim spans the whole run ("the model saw X
 *  somewhere"), never for one that names a single call. */
const joined = (results) => results.join("\n---\n");

/** The worker's own request shape on the log — `sec-fetch-site: none`, no Referer/Origin (a tab navigation
 *  would send `mode: navigate` and a Referer). W9's distinguishing claim, folded into the rows whose hop is
 *  followed and so leaves a log on both sides. */
function expectWorkerFetchShape(q, why) {
    expect(q.headers, why).toMatchObject({ "sec-fetch-site": "none", "sec-fetch-mode": "cors", "sec-fetch-dest": "empty" });
    expect(q.headers, why).not.toHaveProperty("referer");
    expect(q.headers, why).not.toHaveProperty("origin");
}

/** The run rows' tab/frame claim: the worker's fetch is not a navigation, so no tab or frame appears. */
async function expectNoTabOrFrame(h, tabsBefore, why) {
    expect(await h.page.evaluate(() => window.length), why).toBe(0);
    expect(await h.ext.sw.evaluate(() => chrome.tabs.query({})), why).toHaveLength(tabsBefore.length);
}

// --- the control: a plain fetch works and the fixture logs it (a broken fixture cannot hide behind a red row) ---

test("@security SITE_PRESENCE step 5: control: a plain fetch succeeds and the server logs it", async () => {
    test.setTimeout(90_000);
    const h = await rowSetup("attacker.test");
    try {
        const tabsBefore = await h.ext.sw.evaluate(() => chrome.tabs.query({}));
        const r = await h.page.evaluate((u) => window.ml.fetch(u).then((x) => ({ ok: x.ok, text: x.text }), (e) => ({ ok: false, err: String(e) })), h.site.url("attacker.test", "/body"));
        expect(r.ok, "ml.fetch of the page's own origin is auto-approved and succeeds").toBe(true);
        expect(r.text).toContain("body from attacker.test");
        const logged = h.site.requestsTo("attacker.test").filter((q) => q.path === "/body");
        expect(logged, "and the server logged it").toHaveLength(1);
        expectWorkerFetchShape(logged[0], "the worker fetched it (no tab navigation behind ml.fetch)");
        await expectNoTabOrFrame(h, tabsBefore, "a worker fetch leaves no tab and no frame behind");
    } finally {
        await h.close();
    }
});

// --- W1: a page's own ml.fetch, same-origin first URL, cross-site hop ---

test("@security SITE_PRESENCE step 5: W1: ml.fetch's cross-site hop never requests the target, and the page is told only 'another site'", async () => {
    test.setTimeout(90_000);
    const h = await rowSetup("attacker.test");
    try {
        // The hop is registered SERVER-SIDE, so the first URL the page writes does not spell `victim.test`: with a
        // `?to=` first URL the page's own refusal echoes its request URL, and the "never names the Location" pin
        // below would be decided by the page's text rather than by the worker's.
        const first = h.site.url("attacker.test", h.site.hopTo(h.site.url("victim.test", "/secret")));
        const r = await h.page.evaluate((u) => window.ml.fetch(u).then((x) => ({ ok: true, text: x.text, url: x.url }), (e) => ({ ok: false, err: String(e) })), first);
        if (holeOpen("step5worker", "the worker follows the cross-site hop: the target is requested and the page's error names the Location")) {
            expect(h.site.requestsTo("victim.test").map((q) => q.path), "today's leak: the hop's target is requested").toContain("/secret");
            expect(r.ok).toBe(false);
            expect(String(r.err), "and the page's error names the Location").toContain("victim.test");
            return;
        }
        expect(h.site.requestsTo("victim.test"), "the hop's target was never requested").toEqual([]);
        expect(r.ok).toBe(false);
        expect(String(r.err), "the refusal names the hop only as another site").toMatch(/another site/i);
        expect(String(r.err), "never the Location").not.toContain("victim.test");
        expect(String(r.err)).not.toContain("/secret");
    } finally {
        await h.close();
    }
});

// --- W2: a PAGE-started run's fetch_url, cross-site hop (the refusal names only "another site": this run's tool
//     results pass through the page's own world, so the page must not learn where an opaque hop points) ---

test("@security SITE_PRESENCE step 5: W2: a page run's fetch_url cross-site hop never requests the target, and the page is told only 'another site'", async () => {
    test.setTimeout(90_000);
    const h = await rowSetup("attacker.test");
    try {
        const tabsBefore = await h.ext.sw.evaluate(() => chrome.tabs.query({}));
        // Server-side hop: the first URL does not spell the target, so the assertions below read the worker's
        // sentence and not an echo of the URL the run itself asked for.
        const first = h.site.url("attacker.test", h.site.hopTo(h.site.url("victim.test", "/secret")));
        const seen = joined(await runThroughTools(h, [{ tool: "fetch_url", args: { url: first } }]));
        if (holeOpen("step5worker", "the run's fetch follows the hop and requests the unapproved target")) {
            expect(h.site.requestsTo("victim.test").map((q) => q.path), "today's leak: the hop's target is requested").toContain("/secret");
            // Main names the target in its final-origin guard's error, which is the leak's own text reaching the model.
            expect(seen, "today: the target is named").toContain("victim.test");
        } else {
            expect(h.site.requestsTo("victim.test"), "the hop's target was never requested").toEqual([]);
            // The run is the PAGE's (`ml.agent`), so its tool results live in the page's world: the same rule as a
            // page's own `ml.fetch` (W1). Naming the Location here would hand the page what its own fetch could not
            // read. A WORKER-hosted run's refusal DOES name the target — that is W2b's row.
            expect(seen, "the page-relayed refusal names only another site").toMatch(/another site/i);
            expect(seen, "never the Location").not.toContain("victim.test");
            expect(seen).not.toContain("/secret");
        }
        expect(seen).toMatch(/redirect/i);
        await expectNoTabOrFrame(h, tabsBefore, "the judged hop is still a worker fetch: no tab, no frame");
    } finally {
        await h.close();
    }
});

// --- W2b: a WORKER-hosted run's fetch_url — nobody but the model reads this result, so the refusal names the target
//     ("Fetch that URL directly to approve it" is the ruled path for the person) ---

test("@security SITE_PRESENCE step 5: W2b: a worker-hosted run's refusal names the target it did not fetch", async () => {
    test.setTimeout(90_000);
    const h = await rowSetup("attacker.test");
    try {
        const first = h.site.url("attacker.test", h.site.hopTo(h.site.url("victim.test", "/secret")));
        const before = h.fake.calls().length;
        h.fake.setScript([
            { tool: "fetch_url", args: { url: first } },
            (req) => ({ content: req.messages.filter((m) => m.role === "tool").map((m) => String(m.content ?? "")).join("\n") }),
        ]);
        const tabId = await h.ext.sw.evaluate(async (u) => (await chrome.tabs.query({})).find((t) => t.url === u)?.id, h.page.url());
        void h.ext.sw.evaluate(({ tabId }) => globalThis.__mlStartUserRunForTest(tabId, { task: "read it", surface: "hud", hud: "quiet" }, { approvalRouting: "both" }), { tabId });
        await driveApprovals(h.ext, h.fake, 2, before);
        await expect.poll(() => h.fake.calls().length - before, { timeout: 30000 }).toBeGreaterThanOrEqual(2);
        const seen = h.fake.calls().at(-1).messages.filter((m) => m.role === "tool").map((m) => String(m.content ?? "")).join("\n");
        if (holeOpen("step5worker", "the worker-shape run's fetch follows the hop and requests the unapproved target")) {
            expect(h.site.requestsTo("victim.test").map((q) => q.path), "today's leak: the hop's target is requested").toContain("/secret");
        } else {
            expect(h.site.requestsTo("victim.test"), "the hop's target was never requested").toEqual([]);
        }
        // Both sides: the run is the WORKER's, so its result is read by the model and the run's own log, never by a
        // page script — naming the target is how the person is offered "Fetch that URL directly to approve it".
        expect(seen, "the model is told the target it was refused").toContain("victim.test");
    } finally {
        await h.close();
    }
});

// --- W3a: control — a hop to a URL the run PERSON-approved is followed (both sides) ---

test("@security SITE_PRESENCE step 5: W3a: a hop to a URL the run approved is followed and its body comes back", async () => {
    test.setTimeout(90_000);
    const h = await rowSetup("attacker.test");
    try {
        const ok = h.site.url("partner.test", "/ok");
        // Two calls on purpose, and read PER CALL: the first approves the URL by fetching it directly, the second
        // reaches the same URL through attacker.test's `/r`. The direct call's own result carries the body
        // whatever the hop does, so its evidence cannot be the row's — the hop's body is `results.at(-1)`, and
        // the log is asked for the exact `/ok` path TWICE (one per call; a refused hop leaves only the direct
        // one). `/ok` alone, not `/ok.md`: a text/plain body takes no Markdown-ladder alternate (measured — an
        // HTML target logs two per fetch).
        const results = await runThroughTools(h, [
            { tool: "fetch_url", args: { url: ok } },
            { tool: "fetch_url", args: { url: h.site.url("attacker.test", "/r?to=" + encodeURIComponent(ok)) } },
        ]);
        expect(results, "one tool result per call").toHaveLength(2);
        expect(results.at(-1), "the approved hop is followed on both sides").toContain("ok from partner.test");
        expect(h.site.requestsTo("partner.test").filter((q) => q.path === "/ok"), "exactly two: the direct call and the hop through /r").toHaveLength(2);
    } finally {
        await h.close();
    }
});

// --- W3b: the same hop in a FRESH run (no prior approval) is refused before its target is requested ---

test("@security SITE_PRESENCE step 5: W3b: the same hop in a fresh run never requests the target", async () => {
    test.setTimeout(90_000);
    const h = await rowSetup("attacker.test");
    try {
        const ok = h.site.url("partner.test", "/ok");
        // Server-side hop, so the refusal's naming of the target is the tool's own.
        const seen = joined(await runThroughTools(h, [{ tool: "fetch_url", args: { url: h.site.url("attacker.test", h.site.hopTo(ok)) } }]));
        if (holeOpen("step5worker", "the fresh run's fetch follows the hop and requests the unapproved target")) {
            expect(h.site.requestsTo("partner.test").map((q) => q.path), "today's leak: the hop's target is requested").toContain("/ok");
            expect(seen, "today: the target is named").toContain("partner.test");
        } else {
            expect(h.site.requestsTo("partner.test"), "the hop's target was never requested").toEqual([]);
            // A page's run, as W2: the page's world reads this result, so it is told only another site (W2b is the
            // worker-hosted half).
            expect(seen, "the page-relayed refusal names only another site").toMatch(/another site/i);
            expect(seen, "never the Location").not.toContain("partner.test");
        }
    } finally {
        await h.close();
    }
});

// --- W4: a chain mixing a judged-allowed hop (same registrable domain) and a disallowed one ---

test("@security SITE_PRESENCE step 5: W4: a mixed chain — the same-site hop is followed, the cross-site hop's target never requested", async () => {
    test.setTimeout(90_000);
    const h = await rowSetup("a.site.test");
    try {
        // Both hops are registered server-side, so neither URL spells the target: "the refusal names the target"
        // below is the tool's sentence, not an echo of what the model asked for.
        const hop2 = h.site.hopTo(h.site.url("victim.test", "/secret"));
        const chain = h.site.url("b.site.test", hop2);
        const first = h.site.url("a.site.test", h.site.hopTo(chain));
        const seen = joined(await runThroughTools(h, [{ tool: "fetch_url", args: { url: first } }]));
        // Hop 1 (b.site.test, same registrable domain) is followed on both sides: its log is the row's anchor.
        expect(h.site.requestsTo("b.site.test").map((q) => q.path), "the judged-allowed hop is followed (the anchor)").toContain(hop2);
        if (holeOpen("step5worker", "the chain's disallowed hop is followed: the target is requested")) {
            expect(h.site.requestsTo("victim.test").map((q) => q.path), "today's leak: the chain's last target is requested").toContain("/secret");
            expect(seen, "today: the target is named").toContain("victim.test");
        } else {
            expect(h.site.requestsTo("victim.test"), "the disallowed hop's target was never requested").toEqual([]);
            // A page's run, as W2: only "another site" reaches the page's world (W2b is the worker-hosted half).
            expect(seen, "the page-relayed refusal names only another site").toMatch(/another site/i);
            expect(seen, "never the Location").not.toContain("victim.test");
        }
    } finally {
        await h.close();
    }
});

// --- W5: a judged hop that is followed RETURNS ITS BODY (on main the final-origin guard withholds it) ---

test("@security SITE_PRESENCE step 5: W5: the same-site hop's body comes back", async () => {
    test.setTimeout(90_000);
    const h = await rowSetup("a.site.test");
    try {
        const tabsBefore = await h.ext.sw.evaluate(() => chrome.tabs.query({}));
        const first = h.site.url("a.site.test", "/r?to=" + encodeURIComponent(h.site.url("b.site.test", "/body")));
        const seen = joined(await runThroughTools(h, [{ tool: "fetch_url", args: { url: first } }]));
        // The hop is followed on BOTH sides — its request is the row's anchor, and its shape is the worker's.
        const logged = h.site.requestsTo("b.site.test").filter((q) => q.path === "/body");
        expect(logged, "the judged hop is followed and requested (the anchor)").toHaveLength(1);
        expectWorkerFetchShape(logged[0], "still a worker fetch");
        await expectNoTabOrFrame(h, tabsBefore, "no tab, no frame");
        if (holeOpen("step5worker", "the followed hop's body is withheld by the final-origin guard")) {
            expect(seen, "today's guard withholds the body and says the URL redirected").toMatch(/redirected/i);
            expect(seen, "and does not hand back the body").not.toContain("body from b.site.test");
            return;
        }
        expect(seen, "the judged hop that is followed RETURNS ITS body").toContain("body from b.site.test");
    } finally {
        await h.close();
    }
});

// --- W6: a judged hop that is followed RETURNS ITS BODY — the http→https upgrade edge (measured: main's
//     final-origin guard withholds the upgrade hop's body too, exactly as it does the same-site hop in W5) ---

test("@security SITE_PRESENCE step 5: W6: the same-host http→https upgrade hop's body comes back", async () => {
    test.setTimeout(90_000);
    const h = await rowSetup("a.site.test");
    try {
        const first = h.site.url("a.site.test", "/r?to=" + encodeURIComponent(h.site.tlsUrl("a.site.test", "/ok")));
        const seen = joined(await runThroughTools(h, [{ tool: "fetch_url", args: { url: first } }]));
        // The hop is followed on BOTH sides — the request reaches the TLS listener, which is the row's anchor.
        expect(h.site.requestsTo("a.site.test").filter((q) => q.via === "tls").map((q) => q.path), "the upgrade hop is requested over TLS (the anchor)").toContain("/ok");
        if (holeOpen("step5worker", "the followed upgrade hop's body is withheld by the final-origin guard")) {
            expect(seen, "today's guard withholds the body and calls the upgrade a different origin").toMatch(/redirected to a different origin/);
            expect(seen, "and does not hand back the body").not.toContain("ok from a.site.test");
            return;
        }
        expect(seen, "the judged upgrade hop that is followed RETURNS ITS body").toContain("ok from a.site.test");
    } finally {
        await h.close();
    }
});

// --- W7a: FETCH_SHEET's accounts.google.com sign-in hop is refused without requesting it ---

test("@security SITE_PRESENCE step 5: W7a: the sheet's accounts.google.com hop is refused without requesting it", async () => {
    test.setTimeout(90_000);
    const h = await rowSetup("attacker.test", { selfApprove: true });
    try {
        // Port-free ON PURPOSE: `googleSheetId` matches only `docs.google.com/…`, so a URL carrying the TLS
        // port is not recognised as a sheet at all and the load never starts. The resolver maps the Google
        // hosts to the fixture's TLS port instead (redirectResolverArgs).
        const exportUrl = "https://docs.google.com/spreadsheets/d/hop-accounts/export?format=csv&gid=0";
        // The SIGN-IN hop is told apart by its path, not its host: Chromium's own GAIA call (`/ListAccounts`)
        // lands on the same pinned hostname at startup, so the log is cleared and the assertion is the hop's URL.
        const signIn = () => h.site.requestsTo("accounts.google.com").filter((q) => q.path.startsWith("/ServiceLogin"));
        // The CALLER is the page's own table loader, not a run: FETCH_SHEET (and the redirect judgement inside
        // `fetchSheetCsv`) is the same worker code whichever caller asks — `_loadTable` is reachable from a
        // self-approving page with no approval gate and no python boot in the way, which is the stronger surface.
        h.site.clear();
        const r = await h.page.evaluate((u) => window.ml._loadTable("t", u).then((t) => ({ ok: true, rows: t.data.rows }), (e) => ({ ok: false, err: String(e) })), exportUrl);
        expect(h.site.requestsTo("docs.google.com").length, "the export itself is requested first (the anchor)").toBeGreaterThan(0);
        if (holeOpen("step5worker", "the sheet fetch follows the sign-in hop and requests accounts.google.com")) {
            expect(signIn().length, "today's leak: the sign-in hop is requested").toBeGreaterThan(0);
        } else {
            expect(signIn(), "the sign-in hop was never requested").toEqual([]);
        }
        // Both sides (a pin): the error is the ruled one.
        expect(r.ok, "the sign-in hop is never read as a sheet").toBe(false);
        expect(String(r.err), "the person is told to sign in to Google in this browser").toMatch(/not signed in to Google/i);
    } finally {
        await h.close();
    }
});

// --- W7b: control — the declared pair (docs.google.com → *.googleusercontent.com) is followed (both sides) ---

test("@security SITE_PRESENCE step 5: W7b: the sheet's declared-pair hop to *.googleusercontent.com is followed", async () => {
    test.setTimeout(90_000);
    const h = await rowSetup("attacker.test", { selfApprove: true });
    try {
        // Port-free for the same reason as W7a: the sheet-id extraction rejects a port.
        const exportUrl = "https://docs.google.com/spreadsheets/d/hop-cdn/export?format=csv&gid=0";
        h.site.clear();
        const r = await h.page.evaluate((u) => window.ml._loadTable("t", u).then((t) => ({ ok: true, rows: t.data.rows }), (e) => ({ ok: false, err: String(e) })), exportUrl);
        expect(h.site.requestsTo("u0.googleusercontent.com").map((q) => q.path.split("?")[0]), "the declared-pair hop is requested (the anchor)").toContain("/uc");
        expect(r.ok, `the table loads on both sides: ${r.err}`).toBe(true);
        expect(JSON.stringify(r.rows), "and its rows come back").toContain("Ada");
    } finally {
        await h.close();
    }
});

// --- W8a: FETCH_IMAGE_B64's declared exception has a hard edge: a chain hopping a loopback host ---

test("@security SITE_PRESENCE step 5: W8a: an image chain hopping a loopback host fails with nothing requested at or past the hop", async () => {
    test.setTimeout(90_000);
    const h = await rowSetup("attacker.test");
    try {
        const loop = h.site.loopbackUrl("/r?to=" + encodeURIComponent(h.site.url("victim.test", "/secret")));
        const first = h.site.url("img.test", "/r?to=" + encodeURIComponent(loop));
        const r = await h.page.evaluate((u) => window.ml._fetchImageBase64(u).then((d) => ({ ok: true, d: String(d).slice(0, 32) }), (e) => ({ ok: false, err: String(e) })), first);
        expect(r.ok, "IMAGE_FAILED on both sides (the pin: every failure is one text)").toBe(false);
        expect(String(r.err), "the one failure text").toContain("Could not read that URL as an image");
        // The liveness anchor, OUTSIDE the branch (the janitor's finding): the chain's first hop was really answered
        // with the redirect, so a fixture that stopped redirecting cannot green this row in either form — the closed
        // form's two empty-log assertions would otherwise hold on a dead hop, and the OPEN branch alone held its anchor.
        expect(h.site.requestsTo("img.test").map((q) => q.status), "the fixture answered the chain's first hop with a 302").toContain(302);
        if (holeOpen("step5worker", "the image fetch follows the private hop: the loopback host and what lies past it are requested")) {
            expect(h.site.requestsTo("localhost").length, "today's leak: the loopback host is requested").toBeGreaterThan(0);
            expect(h.site.requestsTo("victim.test").map((q) => q.path), "and so is the chain's last target").toContain("/secret");
            return;
        }
        expect(h.site.requestsTo("localhost"), "the private hop was never requested").toEqual([]);
        expect(h.site.requestsTo("victim.test"), "and nothing past it either").toEqual([]);
    } finally {
        await h.close();
    }
});

// --- W8b: control — the image fetch's declared exception follows a public CDN hop to the raster (both sides) ---

test("@security SITE_PRESENCE step 5: W8b: an image chain hopping a public CDN host is followed to the raster", async () => {
    test.setTimeout(90_000);
    const h = await rowSetup("attacker.test");
    try {
        const first = h.site.url("img.test", "/r?to=" + encodeURIComponent(h.site.url("cdn2.test", "/pixel.png")));
        const r = await h.page.evaluate((u) => window.ml._fetchImageBase64(u).then((d) => ({ ok: true, d: String(d) }), (e) => ({ ok: false, err: String(e) })), first);
        expect(r.ok, "the CDN hop is followed on both sides").toBe(true);
        expect(String(r.d), "and the raster comes back").toMatch(/^data:image\/png;base64,/);
        expect(h.site.requestsTo("cdn2.test").map((q) => q.path)).toContain("/pixel.png");
    } finally {
        await h.close();
    }
});

// --- W8c: pin — a non-raster body at any step is IMAGE_FAILED (both sides) ---

test("@security SITE_PRESENCE step 5: W8c: an image chain ending on a non-raster body is IMAGE_FAILED", async () => {
    test.setTimeout(90_000);
    const h = await rowSetup("attacker.test");
    try {
        // Both sides pass (a pin, not a hole): today's check is on the last response, and the discriminating
        // edge is W8a (the check on EVERY hop). What this row keeps is the failure text and the refusal to
        // hand a data URL for an HTML body.
        const first = h.site.url("img.test", "/r?to=" + encodeURIComponent(h.site.url("cdn2.test", "/page")));
        const r = await h.page.evaluate((u) => window.ml._fetchImageBase64(u).then((d) => ({ ok: true, d: String(d).slice(0, 32) }), (e) => ({ ok: false, err: String(e) })), first);
        expect(r.ok).toBe(false);
        expect(String(r.err)).toContain("Could not read that URL as an image");
    } finally {
        await h.close();
    }
});
