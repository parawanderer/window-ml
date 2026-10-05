// run-log-demo.mjs — a NARRATED VISUAL demo (not a test) of the EXECUTION LOG: what the machinery did underneath
// a run, which the run's own steps never say.
//
//   npm run build && node tests/e2e/run-log-demo.mjs        # headful; HOLD=0 to exit instead of waiting
//
// The run this exists for lost 13 minutes 57 seconds inside a single `pageInfo`, and nothing anywhere said why:
// the browser had discarded the tab in the background, so the content script was registered and simply not
// running. From the loop's point of view nothing had gone wrong yet. That is the shape of everything in this
// panel — work that happens, matters, and is invisible.
//
// So the demo stages it rather than drawing it: a run with a long delegated call, and the tab reported discarded
// out from under it while you watch the panel. Every record on screen is one this browser actually produced.
//
// ONE BOOLEAN IS FAKED, and it is a harness limit rather than a choice: a real `chrome.tabs.discard` destroys the
// target and takes Playwright's connection to the WHOLE browser with it (measured — the context dies, with no run
// in flight and nothing else open). So the demo patches Chrome's own `discarded` flag, once, on the one tab. What
// the worker does about it — notice on the next probe, reload the tab in place, wait for the re-adopt, retry the
// call once — is all real.
//
//   1. THE GOOD CASE IS EMPTY. A run where nothing struggled says so, and says it in a way that cannot be
//      confused with a panel that is broken.
//   2. THE TAB IS PINNED the moment a run is hosted in it (`autoDiscardable: false`), and let go when the run
//      ends. Both halves are invisible, and the second one is the one that leaves a tab un-discardable for the
//      rest of the browser's life if it is forgotten.
//   3. THE TAB GOES ANYWAY, because the pin only stops the browser's own memory saver, never an explicit
//      discard — and this is the measured case: the call is outstanding, the document is gone.
//   4. WHAT WE DID ABOUT IT. The tab is reloaded in place (it has no document, so a reload costs nothing already
//      lost), the run re-adopted, the call retried once. Four lines, and the run just carries on.
//
// Not staged here: the CDP lines (`cdp refused (permission)` — "CDP not enabled" — and the attach/detach pair
// that brackets how long a run held the debugger on someone's tab). They need a page whose CSP forces that path,
// which is a different demo; they are recorded by the same emitter and read as the same rows.
//
// Screenshots land in tests/e2e/artifacts/run-log-demo/.
import fs from "node:fs";
import path from "node:path";
import { launchExtension, configureExtension, waitForMl, narrate, narrateDone, openRunInSidebar } from "./harness.mjs";
import { startFakeLlm } from "./fake-llm.mjs";
import { startPageServer } from "../../examples/cross-page/serve.mjs";

const HOLD = process.env.HOLD !== "0";
const BEAT = Number(process.env.BEAT || 2000);
const ART = path.join(import.meta.dirname, "artifacts", "run-log-demo");
fs.mkdirSync(ART, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const fake = await startFakeLlm({ model: "fake-model" });
const site = await startPageServer({});
const ext = await launchExtension({ headful: true });
const errors = [];
let n = 0;
// The page every beat is watched from, set once the chat page exists: a discard can take a tab out of
// `context.pages()` mid-beat, so "the last page" is not a stable thing to photograph.
let watch = null;
const shot = async (name) => {
    if (!watch) return;
    try { await watch.screenshot({ path: path.join(ART, `${String(++n).padStart(2, "0")}-${name}.png`) }); }
    catch (e) { console.log(`  [shot ${name} failed: ${String(e).split("\n")[0]} | closed=${watch.isClosed()} pages=${ext.context.pages().length}]`); }
};

try {
    await configureExtension(ext.sw, { chatUrl: fake.url, apiKey: "", apiFormat: "openai", model: "fake-model", debugMode: "off" });

    // The page the run will happen on, and the chat page we watch it from. The chat page is opened SECOND and
    // stays in front, because Chrome will not discard the tab you are looking at — which is also why the
    // measured failure only ever happened to a run someone had walked away from.
    const target = await ext.context.newPage();
    await target.goto(site.url + "/");
    await waitForMl(target);
    const chat = await ext.context.newPage();
    chat.on("pageerror", (e) => errors.push(e.message));
    await chat.goto(`chrome-extension://${ext.extensionId}/chat.html`);
    await chat.locator(".chat").waitFor();
    watch = chat;

    const openPanel = async () => {
        await chat.locator(".chat-gear-btn").click();
        await chat.getByRole("menuitem", { name: "Panels" }).click();
        await chat.getByRole("menuitemcheckbox", { name: /Execution log/ }).click();
    };
    const panel = chat.locator(".chat-dock-right");

    await narrate(chat, "1 · The panel, with nothing open", { sub: "it follows whatever session you are reading, so with none it says so rather than showing some other run's mechanics under nothing" });
    await openPanel();
    await sleep(BEAT); await shot("panel-with-nothing-open");

    // A run whose first step is a long delegated call: `wait` for an element that never appears. No approval
    // gate, no tool of its own to go wrong — the whole beat is about what happens to the TAB while it runs.
    await narrate(chat, "2 · A run starts on the other tab", { sub: "its first step is a `wait` that will sit there for twelve seconds — long enough for the browser to take the tab out from under it" });
    fake.setScript([
        { tool: "wait", args: { selector: "#never-appears", timeout: 12000 } },
        { content: "the page never settled, so there is nothing to report" },
    ]);
    await target.evaluate(() => { void window.ml.agent("Wait for something that never arrives.", { env: false }); });
    await chat.bringToFront();
    await chat.locator(".chat-row").first().click();
    await sleep(BEAT); await shot("run-open-and-pinned");

    await narrate(chat, "3 · The tab was pinned, and it says so", { sub: "`tab pinned (hosting)` — the browser is asked not to discard a tab while work is happening in it. Nothing else on the page mentions this" });
    await sleep(BEAT + 600); await shot("tab-pinned");

    // THE MEASURED FAILURE, staged — and ONE BOOLEAN of it is faked, which is worth being exact about. A real
    // `chrome.tabs.discard` takes the automation connection to the whole browser with it (see the header), so
    // what this patches is Chrome's own `discarded` flag, once, on this one tab. Everything the worker then does
    // is real: the probe that notices, the reload in place, the re-adopt, the one retry.
    await narrate(chat, "4 · The browser discards the tab", { sub: "while the `wait` is still outstanding: the content script is still registered, and there is no document left to run it. Chrome reports the tab discarded, and the watch asks every four seconds" });
    const tabId = await ext.sw.evaluate(async (u) => (await chrome.tabs.query({})).filter((t) => t.url?.startsWith(u)).pop()?.id, site.url);
    await ext.sw.evaluate((id) => {
        const real = chrome.tabs.get.bind(chrome.tabs);
        let fired = false;
        chrome.tabs.get = async (asked) => {
            const t = await real(asked);
            if (asked !== id || fired) return t;
            fired = true;                       // once: the retry must be able to succeed
            return { ...t, discarded: true };
        };
    }, tabId);
    await sleep(BEAT); await shot("discarded");

    await narrate(chat, "5 · What it did about it", { sub: "the tab is reloaded in place — it has no document, so a reload costs nothing already lost — the run is re-adopted, and the call is retried once" });
    // The watch probes every four seconds, so give it the probe plus the retry's own wait.
    for (let i = 0; i < 12; i++) { await sleep(2000); await shot(`recovering-${i}`); }
    await narrate(chat, "6 · And the run carried on", { sub: "every line here is one this browser actually produced. Without them, a run that took half a minute longer than it should have looks like a slow page tool" });
    await sleep(BEAT + 800); await shot("the-whole-log");

    // THE PANEL IS THE LOG. Everything that was a toolbar and a paragraph on top of it is one menu in the dock's
    // own bar, and the tab's tooltip.
    await narrate(chat, "7 · The panel is the records", { sub: "its filters and its three exports are one menu in the dock's bar — a row of buttons was competing for the width the log needs" });
    await chat.locator(".runlog-menu button").first().click();
    await sleep(BEAT + 400); await shot("the-one-menu");
    await chat.keyboard.press("Escape");

    await narrate(chat, "8 · And what it IS, on the tab", { sub: "under a rule, where it is read once by whoever is wondering — rather than a paragraph every reader scrolls past every time" });
    {
        const tab = chat.locator('.dock-tab', { hasText: "Execution log" });
        const box = await tab.boundingBox();
        await chat.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        await chat.mouse.move(box.x + box.width / 2 + 1, box.y + box.height / 2);
    }
    await sleep(BEAT + 400); await shot("what-it-is-on-the-tab");

    console.log("\n--- the records, as the worker holds them ---");
    const log = await ext.sw.evaluate(async () => (await chrome.storage.session.get("ml_run_log"))["ml_run_log"] || []);
    for (const e of log) console.log(`  ${e.subsystem} ${e.kind}${e.reason ? ` (${e.reason})` : ""}${e.ms != null ? ` ${e.ms}ms` : ""} ${JSON.stringify(e.detail || {})}`);
    console.log(`\n${log.length} record(s); run(s): ${[...new Set(log.map((e) => e.run))].join(", ")}`);
    console.log(`panel text:\n${(await panel.locator(".runlog").innerText()).split("\n").map((l) => "  " + l).join("\n")}`);
    console.log(`\nscreenshots in ${ART}`);

    await narrateDone(chat);
    if (errors.length) console.error("page errors:\n" + errors.join("\n"));
    if (HOLD) await new Promise(() => {});
} finally {
    if (!HOLD) { await ext.context.close(); await site.stop(); await fake.stop(); }
}
