// site-presence-step4.spec.mjs — the red team's SITE_PRESENCE step-4 rows: what a page whose origin may not use
// window.ml can read in its own DOM while a run the person starts acts in it (docs/spec/SITE_PRESENCE.md, step 4).
//
// The page is the detection probe (fixtures/detect/), driven by the clean browser (clean-browser.mjs): no Playwright
// client on the page, so what the page sees is the extension's own doing. The run is held at its first gate (a `type`
// on #field is a gated tool), and the rows read the page by CDP while that approval waits — no helper of the fix's
// (#1279 ships `highlightTag`/`highlightBox` in tests/e2e/harness.mjs; rule 10: these rows find the host by SHAPE,
// what the probe's own observer recorded, so they fail on main for the reason they claim).
//
// The landing form is tests/e2e/site-access.spec.mjs's: while a row's slice is `OPEN` it asserts the leak SUCCEEDED,
// positively (a broken fixture cannot pass it), and flipping the entry asserts the defended outcome. Flipping is a
// commit of mine on the fix's branch before it merges (the rule-10 amendment: a Playwright row that flips only on a
// merge sha reddens the fix's own CI while it waits).
//
// One shape a row cannot check from the page, said plainly: a page cannot tell a CLOSED shadow root from none. The
// rows pin what a page reads — nothing of ours inside the host — and the fix's own tests pin the root being closed.

import { test, expect } from "@playwright/test";
import { launchClean } from "./fixtures/detect/clean-browser.mjs";
import { startProbeSite, DETECT_RESOLVER_ARGS } from "./fixtures/detect/server.mjs";
import { openProbe, waitFor, sleep } from "./fixtures/detect/measure.mjs";
import { startFakeLlm } from "./fake-llm.mjs";

/** The slices of step 4 that have NOT landed. `step4a` is the anonymised highlight host and the hidden-page DOM
 *  silence (PR #1279). Flip the entry in the commit that lands the slice, on the fix's branch. */
const OPEN = { step4a: true };

/** Whether `slice` is still open, recording it on the test so the report says which holes this run demonstrated. */
function holeOpen(slice, what) {
    const open = OPEN[slice];
    if (open) test.info().annotations.push({ type: "open hole", description: `${slice}: ${what}` });
    return open;
}

/** Every host the probe site answers for, as secure contexts, so the browser sends `Sec-Fetch-*` as it would to https. */
const secureArgs = (site) => [`--unsafely-treat-insecure-origin-as-secure=${["probe.test", "other.test", "xo.test", "api.test"].map((h) => site.origin(h)).join(",")}`];

// `ml-` as a TOKEN, not as a substring: `html-` contains `ml-` and is not a name of ours. Case-insensitive, since a
// scan that only finds today's lowercase names would miss a rename.
const ML_TOKEN = /(?<![a-z])ml-/i;

/** A custom-element-shaped tag (a hyphen, the one a random per-session name must have to be a custom element at all). */
const CUSTOM_TAG = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)+$/i;

/**
 * What the PAGE reads of its own DOM, by CDP with no `Runtime.enable` (a page's debugger signals are the probe's own
 * subject): every child of `<html>` by shape, every `[popover]` element, every frame's src, and the outerHTML the
 * `ml-` scans run over.
 */
const READ_JS = `(() => {
    const shape = (el) => ({
        tag: el.tagName.toLowerCase(),
        id: el.id || null,
        cls: typeof el.className === "string" && el.className ? el.className : null,
        attrs: [...el.attributes].map((a) => [a.name, a.value.slice(0, 200)]),
        shadowOpen: !!el.shadowRoot,
        childCount: el.children.length,
        textLen: (el.textContent || "").length,
    });
    return {
        html: document.documentElement.outerHTML,
        kids: [...document.documentElement.children].map(shape),
        popovers: [...document.querySelectorAll("[popover]")].map(shape),
        frames: [...document.querySelectorAll("iframe,frame")].map((f) => f.getAttribute("src") || ""),
        winFrames: window.length,
    };
})()`;

/**
 * Read the page's DOM as the page itself could: attach a client, evaluate, detach. No `Runtime.enable`, so the read
 * leaves none of the debugger shapes the probe measures on the page.
 * @param {ReturnType<typeof launchClean>} b
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

/**
 * One row's scenario in a fresh clean browser: a probe tab on `host`, then a run the person starts on it, HELD at its
 * first gate (the `type` on #field) until `release` — so `during` is read while an approval waits, and `readAfter`
 * once the run has settled. `adds(lo, hi)` is the probe's own dom-add records in a window (its `t` and the test's
 * clock are the same machine).
 */
async function heldRun(host) {
    const site = await startProbeSite();
    const fake = await startFakeLlm({ model: "fake-model" });
    fake.setSide(() => ({ content: "1" }));
    const b = await launchClean({ args: [...DETECT_RESOLVER_ARGS, ...secureArgs(site)], extension: true });
    const close = async () => { await b.close(); await fake.stop(); await site.stop(); };
    try {
        await b.sw((c) => chrome.storage.sync.set(c), { chatUrl: fake.url, apiKey: "", apiFormat: "openai", model: "fake-model", modelFilter: "", autoApproveReadonly: false, defaultModelVision: "yes" });
        await b.sw((o) => chrome.storage.local.set({ ml_site_always: o }), [site.origin("probe.test")]);
        // The approval registers the page scripts for probe.test (sw-presence.ts); wait for it, as detection-surface's
        // scenario does, so the measured page is the first navigation under the new list. The ROWS' page is `host`:
        // `other.test` is a page the person never allowed — "hidden" in SITE_PRESENCE's sense.
        await b.sw(async () => {
            for (let i = 0; i < 100 && !(await chrome.scripting.getRegisteredContentScripts()).length; i++) await new Promise((r) => setTimeout(r, 20));
        });
        const page = await openProbe(b, site, host, "/");
        await sleep(1200);
        const before = await readDom(b, page.targetId);
        const t0 = Date.now();
        fake.setScript([{ tool: "type", args: { selector: "#field", text: "x" } }, { content: "done" }]);
        const driver = () => fake.calls().filter((c) => c.tools?.length).length;
        const n0 = driver();
        await b.sw(({ tabId }) => globalThis.__mlStartUserRunForTest(tabId, { task: "do the scripted step", surface: "hud", hud: "quiet" }, { approvalRouting: "both" }), { tabId: page.tabId });
        const gate = await waitFor(async () => (await b.sw(() => globalThis.__mlApprovals.list()))[0] ?? null, 30000, "the approval gate to open");
        // The mounts ride an async draw (the card's app asks for the approval highlight over a rendered reference):
        // measured 2026-10-29 the card lands at run start +27-66 ms and the highlight root at +141-239 ms, eight runs
        // of nine — once it had not arrived 1.2 s in. A fixed 3 s settle from the gate covers the tail without a
        // quiet-window that a slow round-trip walks straight through; the stamp closes the window after it.
        await sleep(3000);
        const during = await readDom(b, page.targetId);
        const tHeld = Date.now();
        await sleep(400);   // the probe flushes its buffer every 100 ms; let the window's records land
        let tEnd = null;
        return {
            site, fake, b, page, gate, before, during, t0, tHeld,
            adds: (lo, hi) => page.reports().filter((e) => e.kind === "dom-add" && e.t >= lo && e.t <= hi),
            /** Resolve the held gate (and any later one), wait for the run to finish, and stamp its end. */
            release: async () => {
                await b.sw((k) => globalThis.__mlApprovals.resolve(k, true), gate.key);
                await waitFor(async () => {
                    for (const g of await b.sw(() => globalThis.__mlApprovals.list())) await b.sw((k) => globalThis.__mlApprovals.resolve(k, true), g.key);
                    const st = await b.sw(() => globalThis.__mlRunStateForTest());
                    return driver() - n0 >= 2 && st.controllers.length === 0;
                }, 40000, "the run to finish");
                tEnd = Date.now();
            },
            /** The page's DOM once the run has ended and the probe's last records have flushed. */
            readAfter: async () => {
                await sleep(2400);
                const dom = await readDom(b, page.targetId);
                await sleep(400);
                return dom;
            },
            /** The window after the run's end, in the same clock as `adds`. */
            get tEnd() {
                if (tEnd === null) throw new Error("readAfter before release: the run has not ended");
                return tEnd;
            },
            close,
        };
    } catch (e) {
        await close();
        throw e;
    }
}

/** The element shapes in one read, as the probe's dom-add records name them: `tag#id`. */
const named = (recs) => recs.map((a) => `${a.tag}${a.id ? "#" + a.id : ""}`);

// --- the control: the probe on a VISIBLE page sees today's card (the machinery detects mounts) ---

test.describe("@security SITE_PRESENCE step 4: a hidden page and a run the person starts", () => {
    test("control: the probe on a visible page sees the HUD card — and stays green across the flip", async () => {
        test.setTimeout(90_000);
        const h = await heldRun("probe.test");
        try {
            expect(h.gate.tool, "the run gated on the scripted type (the run machinery's positive control)").toBe("type");
            const adds = h.adds(h.t0, h.tHeld);
            expect(named(adds), "the visible page's card mounts: the probe detects mounts").toContain("div#ml-sb-card");
            expect(h.during.html, "and the ml- scan finds its name on a visible page (the scan's control)").toContain("ml-sb-card");
        } finally {
            await h.close();
        }
    });

    // --- rows (a)-(e): the hidden page (other.test, never allowed) while the run waits and after it ends ---

    test("row (a): a waiting approval adds exactly one host element — a random custom-element name, nothing of ours on it", async () => {
        test.setTimeout(90_000);
        const h = await heldRun("other.test");
        try {
            expect(h.gate.tool, "the run gated on the scripted type (the run machinery's positive control)").toBe("type");
            const adds = h.adds(h.t0, h.tHeld);
            if (holeOpen("step4a", "the hidden page mounts the card and the highlight root under ml- names")) {
                // The card mounts at run start (measured +27-66 ms) and the highlight root on the app's later draw
                // (+141-239 ms, and once past 1.2 s): the card is the deterministic half of the leak, and nothing
                // anonymous is up yet — the negation of the defended "exactly one host".
                expect(named(adds), "today's leak: the named card mount is in the page's DOM").toContain("div#ml-sb-card");
                expect(named(adds).filter((n) => !ML_TOKEN.test(n)), "no anonymous host today: the leak is named ml-*").toEqual([]);
                return;
            }
            expect(named(adds), "domAdded while the approval waits is exactly one element").toHaveLength(1);
            const rec = adds[0];
            expect(rec.tag, "a random custom-element name (hyphenated, as one must be)").toMatch(CUSTOM_TAG);
            expect(`${rec.tag} ${rec.id ?? ""} ${(rec.attrs ?? []).join(" ")}`, "no ml- id, class or attribute").not.toMatch(ML_TOKEN);
            // A page cannot tell a closed root from none; what it must not get is anything readable inside the host.
            const kid = h.during.kids.find((k) => k.tag === rec.tag);
            expect(kid, "the host is an element of <html>, where the probe saw it added").toBeTruthy();
            expect(kid.shadowOpen, "the page reads no open root").toBe(false);
            expect([kid.childCount, kid.textLen], "and nothing inside the host in the light DOM").toEqual([0, 0]);
            expect(kid.attrs.map(([n, v]) => `${n}=${v}`).join(" "), "no ml- name or value on the host").not.toMatch(ML_TOKEN);
        } finally {
            await h.close();
        }
    });

    test("row (b): no ml- token anywhere in the hidden page's DOM, before, during or after the run", async () => {
        test.setTimeout(90_000);
        const h = await heldRun("other.test");
        try {
            expect(h.gate.tool, "the run gated on the scripted type (the run machinery's positive control)").toBe("type");
            await h.release();
            const after = await h.readAfter();
            if (holeOpen("step4a", "the hidden page's DOM carries our ml- names while the run acts in it")) {
                expect(h.during.html, "the names are in the page's outerHTML").toMatch(/ml-sb-(card|root-hl)/);
                return;
            }
            for (const [when, dom] of [["before", h.before], ["during", h.during], ["after", after]]) {
                expect(dom.html, `no ml- token in the DOM ${when} the run`).not.toMatch(ML_TOKEN);
            }
        } finally {
            await h.close();
        }
    });

    test("row (c): no sidebar.html frame in the page — the page's own cross-origin frame is the scan's control", async () => {
        test.setTimeout(90_000);
        const h = await heldRun("other.test");
        try {
            expect(h.gate.tool, "the run gated on the scripted type (the run machinery's positive control)").toBe("type");
            await h.release();
            const after = await h.readAfter();
            for (const [when, dom] of [["before", h.before], ["during", h.during], ["after", after]]) {
                expect(dom.frames, `the page's own #xo frame is the scan's control ${when} the run`).toContainEqual(expect.stringContaining("xo.test"));
                expect(dom.frames.filter((f) => /sidebar\.html|chrome-extension:/.test(f)), `no sidebar.html frame in the page's DOM ${when} the run`).toEqual([]);
                // Measured 2026-10-29: window.length does not count a frame inside a closed shadow root either (the
                // card's sidebar.html iframe is mounted through every hold and the count stays 1), so the page cannot
                // even count ours — the page's own #xo frame is the count's whole content.
                expect(dom.winFrames, `the page counts only its own frame ${when} the run`).toBe(1);
            }
        } finally {
            await h.close();
        }
    });

    test("row (d): no popover attribute of ours except on the anonymised host, whose shape is exactly the ruled one", async () => {
        test.setTimeout(90_000);
        const h = await heldRun("other.test");
        try {
            expect(h.gate.tool, "the run gated on the scripted type (the run machinery's positive control)").toBe("type");
            const pops = h.during.popovers;
            if (holeOpen("step4a", "a popover of ours carrying an ml- name is on the hidden page")) {
                expect(pops.map((p) => p.id).filter((id) => ML_TOKEN.test(id || "")), "today's leak: our named popovers").toContain("ml-sb-card");
                return;
            }
            expect(pops, "exactly one popover element: the anonymised host").toHaveLength(1);
            const host = pops[0];
            expect(host.tag, "the host is the random custom-element name").toMatch(CUSTOM_TAG);
            expect(host.id ?? null, "no id").toBe(null);
            expect(host.popover, `the top-layer keeper's popover="manual" (the ruled exception)`).toBe("manual");
            expect(host.attrs.map(([n]) => n).sort(), "its attributes enumerate to exactly popover and style").toEqual(["popover", "style"]);
            expect(host.attrs.find(([n]) => n === "style")?.[1] ?? "", "the inline style positions the box over the target").not.toBe("");
            expect(host.attrs.map(([n, v]) => `${n}=${v}`).join(" "), "no ml- name or value on the host").not.toMatch(ML_TOKEN);
        } finally {
            await h.close();
        }
    });

    test("row (e): after the run ends, domAdded is empty again", async () => {
        test.setTimeout(90_000);
        const h = await heldRun("other.test");
        try {
            expect(h.gate.tool, "the run gated on the scripted type (the run machinery's positive control)").toBe("type");
            expect(h.adds(h.t0, h.tHeld), "the run mounts something while the gate holds (the control: the probe records adds)").not.toEqual([]);
            await h.release();
            await h.readAfter();
            expect(h.adds(h.tEnd, Date.now()), "domAdded is empty again after the run ends").toEqual([]);
        } finally {
            await h.close();
        }
    });
});
