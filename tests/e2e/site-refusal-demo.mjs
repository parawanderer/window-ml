// site-refusal-demo.mjs — a NARRATED demo (not a test) of a website being REFUSED by window.ml's site access.
//
//   npm run build && node tests/e2e/site-refusal-demo.mjs        (HEADLESS=1 captures the screenshots without a window)
//
// Six beats, each captioned on screen (`narrate`) and photographed to tests/e2e/artifacts/site-refusal-demo/:
//   1. a site nobody allowed calls window.ml: refused, and the page's readout shows the text it actually received
//   2. the toolbar popup for that site: it is not allowed, and where the person would allow it
//   3. the person presses Deny: the next call is refused, and Settings lists the site as denied
//   4. the https:// origin of a host is allowed, its plain-http copy is refused: each scheme and port is its own site
//   5. the person starts an agent themselves on the refused site: it works, because the WORKER builds that run
//   6. the person allows the site in Settings: the page's call now works
//
// The backend is fake-llm.mjs (a scriptable OpenAI-shaped server); the key is a recognisable fake so a leak into a
// page's readout would be visible. One local server answers for several hostnames through Chromium's
// --host-resolver-rules (fixtures/hostile/server.mjs), so each hostname is a distinct origin.
// Env: BEAT=<ms> pacing between beats, HOLD=0 exits at the end instead of leaving the browser open.
// What is asserted is tests/e2e/site-access.spec.mjs; this file is the one to watch.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync } from "node:fs";
import { launchExtension, configureExtension, waitForMl, narrate, narrateDone, openRunInSidebar, inShell, waitInShell } from "./harness.mjs";
import { startFakeLlm } from "./fake-llm.mjs";
import { startHostileSite, HOSTILE_RESOLVER_ARGS } from "./fixtures/hostile/server.mjs";

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), "artifacts", "site-refusal-demo");
mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const BEAT = +(process.env.BEAT || 2200);
const HOLD = process.env.HOLD !== "0";
const KEY = "sk-demo-secret-key-0123456789";

const fake = await startFakeLlm({ model: "fake-model" });
const site = await startHostileSite();
const ext = await launchExtension({ headful: process.env.HEADLESS !== "1", args: HOSTILE_RESOLVER_ARGS });
const shot = async (page, name) => { await page.screenshot({ path: path.join(OUT, `${name}.png`) }); console.log(`   ${name}.png`); };
/** Narrate a beat, give the watcher time to read it, and photograph it. */
const beat = async (page, text, sub, name, ms = BEAT) => { console.log(`\n${text}`); await narrate(page, text, { sub }); await sleep(ms); if (name) await shot(page, name); };
const NEWS = site.origin("news.test");
const SHOP_HTTP = site.origin("shop.test");
const SHOP_HTTPS = SHOP_HTTP.replace("http://", "https://");

/** Draw what the PAGE received from a window.ml call, bottom-left in the page, apart from the narration. */
async function readout(page, title, lines, ok) {
    await page.evaluate(([t, ls, good]) => {
        let el = document.getElementById("demo-readout");
        if (!el) {
            el = document.createElement("pre");
            el.id = "demo-readout";
            el.style.cssText = "all: initial; position: fixed; left: 14px; bottom: 14px; z-index: 2147483646; max-width: 62ch;"
                + " padding: 10px 14px; border-radius: 8px; white-space: pre-wrap; font: 13px/1.5 ui-monospace, Menlo, monospace;"
                + " color: #111; background: #fff; border: 2px solid #999;";
            document.documentElement.append(el);
        }
        el.style.borderColor = good ? "#16a34a" : "#dc2626";
        el.textContent = `${t}\n${ls.join("\n")}`;
    }, [title, lines, ok]);
}

/** The page calls window.ml, and the readout says what came back and whether the backend heard anything. */
async function pageCalls(page, what, extra = []) {
    const before = fake.calls().length;
    const out = await page.evaluate(() => window.ml.chat("Summarise today's headlines").then((r) => ({ ok: r }), (e) => ({ err: String(e?.message ?? e) })));
    const heard = fake.calls().length - before;
    const text = JSON.stringify(out);
    if (text.includes(fake.url) || text.includes(KEY) || text.includes(new URL(fake.url).host)) throw new Error(`the page was handed a secret: ${text}`);
    console.log(`   page received: ${text}   (backend requests: ${heard})`);
    await readout(page, `${what}: ml.chat("Summarise today's headlines")`,
        out.err ? [`page received an error:`, `  ${out.err}`, `backend requests: ${heard}`, ...extra] : [`page received an answer:`, `  ${out.ok}`, `backend requests: ${heard}`], !out.err);
    return out;
}

/** The toolbar popup as it looks for `url`'s tab. The popup reads the active tab of its own window, so the tab query is
 *  answered here with the tab the person is "on"; the popup's own code, its buttons and its worker messages are real. */
async function openPopup(url) {
    const popup = await ext.context.newPage();
    await popup.setViewportSize({ width: 1100, height: 900 });
    await popup.addInitScript((u) => { chrome.tabs.query = async () => [{ id: 1, url: u, active: true }]; }, url);
    await popup.goto(`chrome-extension://${ext.extensionId}/popup.html`);
    await popup.addStyleTag({ content: "body { margin-left: 520px !important; }" });   // clear of the narration banner
    await popup.locator("#siteAccess").waitFor({ state: "visible" });
    return popup;
}
/** An edit of the site lists, sent the way the popup and Settings send it (an extension page to the worker). */
async function siteEdit(edit) {
    const via = await ext.context.newPage();
    await via.goto(`chrome-extension://${ext.extensionId}/popup.html`);
    await via.evaluate((e) => chrome.runtime.sendMessage({ type: "SITE_ACCESS", payload: { edit: e } }), edit);
    await via.close();
}

try {
    await configureExtension(ext.sw, { chatUrl: fake.url, apiKey: KEY, apiFormat: "openai", model: "fake-model", modelFilter: "", debugMode: "off" });
    fake.setScript([{ content: "Headlines: nothing to see here." }]);
    const page = await ext.context.newPage();
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(site.url("news.test"));
    await waitForMl(page, { approve: false });   // the person has allowed nothing

    // --- 1 -----------------------------------------------------------------------------------------------------------
    await beat(page, "1. A site nobody has allowed calls window.ml", `${NEWS} asks for a model answer.`, "01-call");
    await pageCalls(page, "unknown site");
    await beat(page, "The call is refused and the backend heard nothing", "The page received the refusal text only. No server URL, no key.", "01-refused");

    // --- 2 -----------------------------------------------------------------------------------------------------------
    await beat(page, "2. The person opens the toolbar popup on that site", "Its \"This site\" block says the site is not allowed, with the buttons that would allow it.", null, 600);
    let popup = await openPopup(page.url());
    await narrate(popup, "2. The toolbar popup, on that site", { sub: "It is not allowed, and its calls are refused. Allow this session, Always allow, or Deny." });
    await sleep(BEAT); await shot(popup, "02-popup-unknown");

    // --- 3 -----------------------------------------------------------------------------------------------------------
    await narrate(popup, "3. The person presses Deny", { sub: "The site is refused, and it stops being asked about." });
    await popup.locator("#siteDeny").click();
    await popup.locator("#siteState").filter({ hasText: "denied" }).waitFor();
    await sleep(BEAT); await shot(popup, "03-popup-denied");
    await popup.close();
    await page.bringToFront();
    await beat(page, "3. The next call from the denied site", "No reload. The worker reads the lists on every message.", null, 600);
    await pageCalls(page, "denied site");
    await sleep(BEAT); await shot(page, "03-denied-call");

    // --- 4 -----------------------------------------------------------------------------------------------------------
    await siteEdit({ op: "allow", origin: SHOP_HTTPS, scope: "always" });
    const shop = await ext.context.newPage();
    await shop.setViewportSize({ width: 1280, height: 800 });
    await shop.goto(site.url("shop.test"));
    await waitForMl(shop, { approve: false });
    await shop.bringToFront();
    await beat(shop, `4. ${SHOP_HTTPS} is on the allowed list`, `This copy of the site is ${SHOP_HTTP}: same host, same port, plain http.`, null, BEAT);
    const allowed = await ext.sw.evaluate(async () => (await chrome.storage.local.get("ml_site_always")).ml_site_always ?? []);
    await pageCalls(shop, "http copy of an allowed https site", [`the allowed list holds: ${allowed.join(", ")}`]);
    await beat(shop, "Refused: an origin is scheme, host and port, compared exactly", "The https decision does not cover the http copy.", "04-http-copy");
    await shop.close();

    // --- 5 -----------------------------------------------------------------------------------------------------------
    await page.bringToFront();
    fake.setScript([{ tool: "findByText", args: { text: "code" } }, { content: "The code on this page is 4417." }]);
    await beat(page, "5. The person starts an agent on the refused site themselves", "The Commander, the task bar the person opens with a shortcut, sends the task. The worker builds the run, so the page is not involved.", null, 600);
    const tabId = await ext.sw.evaluate(async (u) => (await chrome.tabs.query({})).find((t) => t.url === u)?.id, page.url());
    await ext.sw.evaluate((id) => chrome.tabs.sendMessage(id, { type: "ML_OPEN_COMPOSER" }), tabId);
    const card = await (async () => { for (let i = 0; i < 100; i++) { const f = page.frames().find((x) => /sidebar\.html/.test(x.url())); if (f && await f.locator(".card-cmp-input").count()) return f; await sleep(100); } throw new Error("the Commander never opened"); })();
    await card.locator(".card-cmp-input").fill("What is the code on this page?");
    await sleep(900); await shot(page, "05-commander");
    await card.locator(".card-cmp-input").press("Enter");
    for (let i = 0; i < 150 && fake.calls().length < 2; i++) await sleep(100);
    if (fake.calls().length < 2) throw new Error("the person's run did not complete on the denied site");
    await sleep(1200);
    // The sidebar is the surface that shows the run, so switch to it and reload; the run lives in the worker and is unaffected.
    await configureExtension(ext.sw, { debugMode: "overlay" });
    await page.reload();
    await waitForMl(page, { approve: false });
    const frame = await openRunInSidebar(page, { task: "What is the code on this page?" });
    await beat(page, "The run worked on the site that is still denied", "The worker built the run and called the model. The page saw none of it.", "05-run-worked");
    await pageCalls(page, "the same page, calling for itself");
    await beat(page, "Contrast: the page's own call is still refused", "A run the person starts is theirs. A call the page makes is the page's.", "05-contrast");

    // --- 6 -----------------------------------------------------------------------------------------------------------
    await frame.locator('button[aria-label="Settings"]').dispatchEvent("click");
    await frame.locator("button", { hasText: /^Permissions$/ }).first().click();
    await frame.locator(".perm-chip", { hasText: NEWS }).waitFor({ timeout: 15000 });
    await frame.locator(".perm-chip").first().scrollIntoViewIfNeeded();
    await beat(page, "6. DevTools Settings, Permissions: who may use window.ml", `Allowed: ${SHOP_HTTPS}. Denied: ${NEWS}.`, "06-settings-denied");
    await frame.locator(".perm-input").first().fill(NEWS);
    await frame.locator("button.test-btn", { hasText: "Allow" }).click();
    await frame.locator(".perm-row", { hasText: NEWS }).waitFor({ timeout: 15000 });
    await beat(page, "The person allows the site here", "Allowing a denied site lifts its denial.", "06-allowed", 1200);
    fake.setScript([{ content: "Headlines: nothing to see here." }]);
    await pageCalls(page, "now allowed");
    await beat(page, "The page's own call now works", "No reload. The same page, the same call.", "06-works");

    await narrateDone(page, "Demo finished", { sub: "Refused: unknown, denied, a different scheme. Allowed: what the person lists. Their own runs: always." });
    console.log("\ndone; screenshots in", OUT);
    if (HOLD) await sleep(24 * 3600 * 1000);
} finally {
    await ext.close().catch(() => {});
    await fake.stop();
    await site.stop();
}
