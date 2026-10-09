// redteam-capture.test.mjs — the red-team pass on CAPTURE_TAB's own-tab rule (#479; src/sw/sw-capture.ts and the
// CAPTURE_TAB branch of src/background.ts). A hostile page that may send CAPTURE_TAB (an approved origin, or a tab
// hosting a worker-built run) must get the pixels of its OWN tab or nothing: never the tab its window shows instead,
// whatever it puts in the payload, whenever it sends, from whichever frame, and however the window changes meanwhile.
//
// The oracle is the pixels. `captureVisibleTab` here answers with the URL of the tab its window shows AT THE MOMENT it
// is called, as the real one shoots whatever is showing, so a test asserts on what came back rather than on which code
// path ran. Each test has a positive control (the sender's own pixels come back when it is showing). A property that
// does not hold yet carries a `todo` naming the gap.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";

const require = createRequire(import.meta.url);
const { jsonResponse, loadBackground } = require("./helpers");

const baseConfig = (o = {}) => ({ chatUrl: "http://host/api/chat/completions", apiKey: "sk-SECRET-KEY", model: "default-model", apiFormat: "openai", ocrModel: "", ...o });
const OWN = "https://hostile.example/";
const OTHER = "https://bank.example/account?balance=12345";
const OTHER_TITLE = "Balance: 12,345 - Bank";
const shotOf = (url) => `data:image/png;base64,${Buffer.from(url).toString("base64")}`;
const sender = (id = 3, extra = {}) => ({ tab: { id, windowId: 1, url: OWN }, url: OWN, origin: "https://hostile.example", frameId: 0, documentId: `doc-${id}`, ...extra });

/**
 * A browser with the hostile page in tab 3 and another site in tab 4, both in window 1, and a third tab in window 2.
 * `captureVisibleTab(windowId)` shoots the tab that window shows at that moment. `during` hooks run where the window
 * can change under the capture: `before`/`after` (inside the first/second `tabs.get`, after the browser answered),
 * `capture` (inside captureVisibleTab, before the shot is taken) and `shot` (inside it, after).
 */
function browser({ showing = 3, cdp = false, during = {}, onCaptureTab, onDebuggerCommand, siteGate = false, local = {} } = {}) {
    const tabs = [
        { id: 3, windowId: 1, active: showing === 3, url: OWN, title: "Hostile" },
        { id: 4, windowId: 1, active: showing === 4, url: OTHER, title: OTHER_TITLE },
        { id: 8, windowId: 2, active: true, url: "https://elsewhere.example/", title: "Elsewhere" },
    ];
    let gets = 0;
    let bg;
    const shoot = (windowId) => {
        const t = tabs.find((x) => x.windowId === windowId && x.active);
        return shotOf(t ? t.url : "nothing");
    };
    bg = loadBackground({
        config: baseConfig({ cdp }), siteGate, local, openTabs: tabs,
        onFetch: () => jsonResponse({}),
        onDebuggerCommand,
        onTabsGet: async (id) => {
            const phase = gets++ % 2 === 0 ? "before" : "after";
            if (during[phase]) await during[phase](bg, tabs);
        },
        onCaptureTab: onCaptureTab ? (...a) => onCaptureTab(bg, tabs, ...a) : async (windowId) => {
            if (during.capture) await during.capture(bg, tabs);
            const px = shoot(windowId);
            if (during.shot) await during.shot(bg, tabs);
            return px;
        },
    });
    return { bg, tabs };
}

/** Move a tab to another window the way Chrome reports it: the old window shows its next tab (onActivated there), the
 *  moved tab is the active one in the new window (onActivated there). */
function moveTab(bg, tabs, id, toWindow) {
    const t = tabs.find((x) => x.id === id);
    const from = t.windowId;
    t.windowId = toWindow;
    for (const o of tabs) if (o.windowId === toWindow && o.id !== id) o.active = false;
    t.active = true;
    const next = tabs.find((x) => x.windowId === from);
    if (next) bg.activateTab(next.id);
    bg.activateTab(id);
}

const capture = (bg, s = sender(), payload = {}) => bg.send({ type: "CAPTURE_TAB", payload }, s);
const noOther = (res, what) => {
    assert.notEqual(res?.data, shotOf(OTHER), `${what}: the other tab's pixels were handed to the page`);
    assert.notEqual(res?.data, shotOf("https://swapped.example/"), `${what}: a swapped-in document's pixels were handed to the page`);
    if (res?.data != null) assert.equal(res.data, shotOf(OWN), `${what}: anything returned is the page's own tab`);
};

// --- CAPTURE_TAB: a page's screenshot is of its own tab (#479) ---

test("positive control: a page whose tab is showing gets its own pixels, without and with CDP", async () => {
    const { bg } = browser();
    assert.equal((await capture(bg)).data, shotOf(OWN));
    const cdp = browser({ cdp: true, onDebuggerCommand: (m) => (m === "Page.captureScreenshot" ? { data: "T1dO" } : undefined) });
    assert.equal((await capture(cdp.bg)).data, "data:image/png;base64,T1dO");
});

test("no field of the payload retargets the capture: a background tab gets nothing, a CDP shot attaches to the sender's tab", async () => {
    const payloads = [{}, { tabId: 4 }, { windowId: 1 }, { windowId: 2 }, { tabId: 4, windowId: 1, frameId: 0 }, { target: { tabId: 4 } }, { tab: { id: 4, windowId: 1 } }, null, "x"];
    for (const payload of payloads) {
        const { bg } = browser({ showing: 4 });
        const res = await capture(bg, sender(), payload);
        noOther(res, `CDP off, payload ${JSON.stringify(payload)}`);
        assert.match(res.error || "", /isn't the one showing/, `CDP off, payload ${JSON.stringify(payload)}: refused`);
        assert.equal(bg.captures.length, 0, "captureVisibleTab never called");

        const c = browser({ showing: 4, cdp: true, onDebuggerCommand: (m) => (m === "Page.captureScreenshot" ? { data: "T1dO" } : undefined) });
        assert.equal((await capture(c.bg, sender(), payload)).data, "data:image/png;base64,T1dO", `CDP on, payload ${JSON.stringify(payload)}`);
        const targets = c.bg.debuggerCalls.map((x) => x[1]?.tabId);
        assert.ok(targets.length > 0 && targets.every((t) => t === 3), `CDP on, payload ${JSON.stringify(payload)}: every debugger call targets tab 3 (${targets})`);
        assert.equal(c.bg.captures.length, 0);
    }
});

test("CDP failing does not open a way round: the fallback is the own-tab capture, refused for a tab in the background", async () => {
    // The page cannot choose how CDP fails, but whatever the reason (no data, an attach conflict), the fallback is
    // captureOwnTab, never the window's showing tab.
    const failures = [() => undefined, () => { throw new Error("Another debugger is already attached to the tab with id: 3."); }];
    for (const fail of failures) {
        const { bg } = browser({ showing: 4, cdp: true, onDebuggerCommand: (m) => (m === "Page.captureScreenshot" ? fail() : undefined) });
        const res = await capture(bg);
        noOther(res, "CDP failed");
        assert.equal(bg.captures.length, 0, "no fallback capture of the window");
        // positive control: the same failure with the page showing falls back to its own pixels
        const ok = browser({ showing: 3, cdp: true, onDebuggerCommand: (m) => (m === "Page.captureScreenshot" ? fail() : undefined) });
        assert.equal((await capture(ok.bg)).data, shotOf(OWN));
    }
});

test("every moment the window can switch tabs around the capture yields own pixels or a refusal, never the other tab", async () => {
    const away = (bg) => bg.activateTab(4);
    const awayAndBack = (bg) => { bg.activateTab(4); bg.activateTab(3); };
    // `before`: after the first tabs.get answered "active" but before the onActivated listener is registered: the
    // listener cannot see this switch, so the after-read is what must catch it.
    const cases = [];
    for (const phase of ["before", "capture", "shot", "after"]) for (const [name, fn] of [["away", away], ["away and back", awayAndBack]]) cases.push([phase, name, fn]);
    const phases = ["before", "capture", "shot", "after"];
    for (let i = 0; i < phases.length; i++) for (let j = i + 1; j < phases.length; j++) cases.push([`${phases[i]}..${phases[j]}`, "away, back later", { [phases[i]]: away, [phases[j]]: (bg) => bg.activateTab(3) }]);
    for (const [phase, name, fn] of cases) {
        const { bg } = browser({ during: typeof fn === "function" ? { [phase]: fn } : fn });
        const res = await capture(bg);
        noOther(res, `switch ${name} during ${phase}`);
        assert.ok(res.data != null || /isn't the one showing/.test(res.error || ""), `switch ${name} during ${phase}: own pixels or the refusal (${res.error})`);
    }
    // A switch away and back ENTIRELY before the listener exists leaves the window showing the page at the shot: its
    // own pixels, correctly returned.
    const { bg } = browser({ during: { before: awayAndBack } });
    assert.equal((await capture(bg)).data, shotOf(OWN));
});

test("a page that opens a tab in its own window right after asking gets nothing from the new tab", async () => {
    // window.open from a click puts a new tab in front in the same window: the page CAN cause the switch itself.
    const { bg, tabs } = browser({
        during: {
            capture: (b) => { tabs.push({ id: 5, windowId: 1, active: false, url: OTHER }); b.activateTab(5); },
        },
    });
    const res = await capture(bg);
    noOther(res, "opened a tab during the capture");
    assert.match(res.error || "", /isn't the one showing/);
});

test("the sender's tab replaced under a new id (prerender, discard restored) during the capture: nothing is returned", async () => {
    const swap = (b, tabs) => { b.replaceTab(3, 30); tabs.find((t) => t.id === 30).url = "https://swapped.example/"; };
    for (const phase of ["before", "capture", "shot"]) {
        const { bg } = browser({ during: { [phase]: swap } });
        const res = await capture(bg);
        noOther(res, `replaced during ${phase}`);
        assert.equal(res.data, undefined, `replaced during ${phase}: no pixels`);
    }
});

test("the tab moved to another window and back during the capture: the shot of the window it left is thrown away", async () => {
    const { bg } = browser({ during: { capture: (b, tabs) => moveTab(b, tabs, 3, 2), shot: (b, tabs) => moveTab(b, tabs, 3, 1) } });
    const res = await capture(bg);
    noOther(res, "moved away and back");
    assert.match(res.error || "", /isn't the one showing/);
    // and moved away for good
    const gone = browser({ during: { capture: (b, tabs) => moveTab(b, tabs, 3, 2) } });
    noOther(await capture(gone.bg), "moved away");
});

test("a subframe, or a sender with a tab but no id, gets nothing; an extension frame in a background tab is held to the same rule", async () => {
    for (const s of [sender(3, { frameId: 1 }), sender(3, { frameId: 7, origin: "https://ad.example", url: "https://ad.example/f" })]) {
        const { bg } = browser({ showing: 3 });
        const res = await capture(bg, s);
        assert.match(res.error || "", /Refused: only a page's top frame/, `frame ${s.frameId}: refused at the gate`);
        assert.equal(bg.captures.length, 0);
    }
    // a subframe of a tab hosting a run is not let through by the run allowance either
    {
        const { bg } = browser({ showing: 3, siteGate: true });
        bg.context.__mlSeedActiveRunForTest(3, "run-on-tab");
        assert.match((await capture(bg, sender(3, { frameId: 1 }))).error || "", /Refused/);
        assert.equal((await capture(bg, sender(3))).data, shotOf(OWN), "positive control: the run tab's top frame gets its own pixels");
        assert.equal(bg.captures.length, 1);
    }
    {
        const { bg } = browser({ showing: 4 });
        const res = await capture(bg, { tab: { windowId: 1, url: OWN }, url: OWN, origin: "https://hostile.example", frameId: 0 });
        noOther(res, "tab without id");
        assert.equal(bg.captures.length, 0);
    }
    // The web-accessible sidebar.html framed by the hostile page is an extension sender (the gate lets it through), but
    // its tab is the hostile one: the own-tab rule still applies.
    {
        const { bg } = browser({ showing: 4 });
        const res = await capture(bg, { tab: { id: 3, windowId: 1, url: OWN }, url: "chrome-extension://test/sidebar.html", origin: "chrome-extension://test", frameId: 2 });
        noOther(res, "extension frame in a background tab");
        assert.equal(bg.captures.length, 0);
    }
});

test("the tab-less path (captureVisibleTab of the current window) is not reachable from a web page", async () => {
    // A no-tab sender skips the gate and shoots the CURRENT window. Only the extension's own pages send without a tab;
    // a web page could do so only through externally_connectable / onMessageExternal, and neither exists.
    const manifest = JSON.parse(readFileSync(new URL("../manifest.json", import.meta.url), "utf8"));
    assert.equal(manifest.externally_connectable, undefined, "no web origin may message the extension directly");
    const bundle = readFileSync(new URL("../dist/background.js", import.meta.url), "utf8");
    assert.doesNotMatch(bundle, /onMessageExternal\.addListener|onConnectExternal\.addListener/, "the worker listens to no external sender");
});

test("each quota retry re-checks the own-tab rule: a switch while waiting out the quota gets nothing", async () => {
    let n = 0;
    const { bg } = browser({
        onCaptureTab: (b, tabs, windowId) => {
            n++;
            if (n === 1) {
                b.activateTab(4);   // the window switches while the worker waits out the quota
                throw new Error("Failed to execute 'captureVisibleTab': MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND quota exceeded.");
            }
            return shotOf(tabs.find((t) => t.windowId === windowId && t.active).url);
        },
    });
    const res = await capture(bg);
    noOther(res, "retry after a switch");
    assert.match(res.error || "", /isn't the one showing/);
    assert.equal(n, 1, "the retry refused before calling captureVisibleTab again");
});

test("the refusal says nothing about the tab that is showing", async () => {
    const { bg } = browser({ showing: 4 });
    const res = await capture(bg);
    assert.match(res.error, /isn't the one showing/);
    for (const leak of ["bank.example", "12345", OTHER_TITLE, "Balance"]) assert.ok(!res.error.includes(leak), `refusal names ${leak}`);
});

test("a capture that FAILS while the window shows another tab reports the refusal, not the browser's description of that tab", async () => {
    const { bg } = browser({
        onCaptureTab: (b) => {
            b.activateTab(4);
            throw new Error(`Cannot access contents of url "${OTHER}". Extension manifest must request permission to access this host.`);
        },
    });
    const res = await capture(bg);
    assert.equal(res.data, undefined);
    assert.ok(!res.error.includes("bank.example"), `the error names the other tab: ${res.error}`);
    assert.match(res.error, /isn't the one showing/, "the page is told what the person would be told: its tab was not showing");
    // positive control: with no switch, the browser's own error about the page's own tab is surfaced as before
    const own = browser({ onCaptureTab: () => { throw new Error("cannot capture this page"); } });
    assert.match((await capture(own.bg)).error, /cannot capture this page/);
});

test("a failed capture after a switch made before the capture's listener existed is refused the same way", async () => {
    // The switch lands inside the first tabs.get, before onActivated is listened to: only a re-read can tell.
    const { bg } = browser({
        during: { before: (b) => b.activateTab(4) },
        onCaptureTab: () => { throw new Error(`Cannot access contents of url "${OTHER}".`); },
    });
    const res = await capture(bg);
    assert.equal(res.data, undefined);
    assert.ok(!res.error.includes("bank.example"), `the error names the other tab: ${res.error}`);
    assert.match(res.error, /isn't the one showing/);
});

test("two pages asking at once in one window: the one in front gets its own pixels, the one behind gets nothing", async () => {
    const { bg } = browser({ showing: 3 });
    const behind = { ...sender(4), tab: { id: 4, windowId: 1, url: OTHER }, url: OTHER, origin: "https://bank.example" };
    const [a, b] = await Promise.all([capture(bg), capture(bg, behind)]);
    assert.equal(a.data, shotOf(OWN));
    assert.equal(b.data, undefined);
    assert.match(b.error, /isn't the one showing/);
    // the listener from each capture is gone: a later switch does not spoil a later capture of the tab in front
    bg.activateTab(4); bg.activateTab(3);
    assert.equal((await capture(bg)).data, shotOf(OWN));
});
