// site-refusal-demo.mjs — a NARRATED demo (not a test) of a website that may not use window.ml: it does not SEE it.
//
//   npm run build && node tests/e2e/site-refusal-demo.mjs        (HEADLESS=1 captures the screenshots without a window)
//
// Six beats, each captioned on screen (`narrate`) and photographed to tests/e2e/artifacts/site-refusal-demo/. A page whose
// origin may not use window.ml is HIDDEN (docs/spec/SITE_PRESENCE.md, step 2): the page's readout shows `typeof window.ml`.
//   1. a site nobody allowed: `typeof window.ml` is "undefined" and the backend heard nothing
//   2. the toolbar popup for that site: it is not allowed, and where the person would allow it
//   3. the person presses Deny: the page still has no window.ml, and Settings lists the site as denied
//   4. the https:// origin of a host is allowed, its plain-http copy has no window.ml: each scheme and port is its own site
//   5. the person starts an agent themselves on the hidden site: it works, because the WORKER builds that run
//   6. the person allows the site in Settings: window.ml appears in the open page WITHOUT a reload, and its call works
//
// The backend is fake-llm.mjs (a scriptable OpenAI-shaped server); the key is a recognisable fake so a leak into a
// page's readout would be visible. One local server answers for several hostnames through Chromium's
// --host-resolver-rules (fixtures/hostile/server.mjs), so each hostname is a distinct origin.
// Env: BEAT=<ms> pacing between beats, HOLD=0 exits at the end instead of leaving the browser open.
// What is asserted is tests/e2e/site-access.spec.mjs; this file is the one to watch.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync } from "node:fs";
import { launchExtension, configureExtension, waitForMl, narrate, narrateDone, inShell, waitInShell } from "./harness.mjs";
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

/** The page looks for window.ml, and the readout says what it found. A hidden page finds nothing: no object, so no call to refuse. */
async function pageLooks(page, what, extra = []) {
    const type = await page.evaluate(() => typeof window.ml);
    console.log(`   typeof window.ml: ${type}   (backend requests: ${fake.calls().length})`);
    await readout(page, `${what}: typeof window.ml`, [`page sees: "${type}"`, `backend requests: ${fake.calls().length}`, ...extra], type !== "undefined");
    return type;
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
    await beat(page, "1. A site nobody has allowed looks for window.ml", `${NEWS} checks typeof window.ml.`, "01-call");
    if (await pageLooks(page, "unknown site") !== "undefined") throw new Error("an unknown site sees window.ml");
    await beat(page, "The page has no window.ml at all", "Nothing to call, nothing to refuse, and nothing the page posts is answered. The backend heard nothing.", "01-refused");

    // --- 2 -----------------------------------------------------------------------------------------------------------
    await beat(page, "2. The person opens the toolbar popup on that site", "Its \"This site\" block says the site is not allowed, with the buttons that would allow it.", null, 600);
    let popup = await openPopup(page.url());
    await narrate(popup, "2. The toolbar popup, on that site", { sub: "It is not allowed, so the page does not see window.ml. Allow this session, Always allow, or Deny." });
    await sleep(BEAT); await shot(popup, "02-popup-unknown");

    // --- 3 -----------------------------------------------------------------------------------------------------------
    await narrate(popup, "3. The person presses Deny", { sub: "The site stays hidden, and it stops being asked about." });
    await popup.locator("#siteDeny").click();
    await popup.locator("#siteState").filter({ hasText: "denied" }).waitFor();
    await sleep(BEAT); await shot(popup, "03-popup-denied");
    await popup.close();
    await page.bringToFront();
    await beat(page, "3. The denied site looks again", "A denied site is hidden exactly like an unknown one.", null, 600);
    if (await pageLooks(page, "denied site") !== "undefined") throw new Error("a denied site sees window.ml");
    await sleep(BEAT); await shot(page, "03-denied-look");

    // --- 4 -----------------------------------------------------------------------------------------------------------
    await siteEdit({ op: "allow", origin: SHOP_HTTPS, scope: "always" });
    const shop = await ext.context.newPage();
    await shop.setViewportSize({ width: 1280, height: 800 });
    await shop.goto(site.url("shop.test"));
    await waitForMl(shop, { approve: false });
    await shop.bringToFront();
    await beat(shop, `4. ${SHOP_HTTPS} is on the allowed list`, `This copy of the site is ${SHOP_HTTP}: same host, same port, plain http.`, null, BEAT);
    const allowed = await ext.sw.evaluate(async () => (await chrome.storage.local.get("ml_site_always")).ml_site_always ?? []);
    if (await pageLooks(shop, "http copy of an allowed https site", [`the allowed list holds: ${allowed.join(", ")}`]) !== "undefined") throw new Error("the http copy sees window.ml");
    await beat(shop, "Hidden: an origin is scheme, host and port, compared exactly", "The https decision does not cover the http copy.", "04-http-copy");
    await shop.close();

    // --- 5 -----------------------------------------------------------------------------------------------------------
    await page.bringToFront();
    fake.setScript([{ tool: "findByText", args: { text: "code" } }, { content: "The code on this page is 4417." }]);
    await beat(page, "5. The person starts an agent on the hidden site themselves", "The Commander, the task bar the person opens with a shortcut, sends the task. The worker builds the run, so the page is not involved.", null, 600);
    const tabId = await ext.sw.evaluate(async (u) => (await chrome.tabs.query({})).find((t) => t.url === u)?.id, page.url());
    await ext.sw.evaluate((id) => chrome.tabs.sendMessage(id, { type: "ML_OPEN_COMPOSER" }), tabId);
    const card = await (async () => { for (let i = 0; i < 100; i++) { for (const f of page.frames().filter((x) => /sidebar\.html/.test(x.url()))) if (await f.locator(".card-cmp-input").count().catch(() => 0)) return f; await sleep(100); } throw new Error("the Commander never opened"); })();
    await card.locator(".card-cmp-input").fill("What is the code on this page?");
    await sleep(900); await shot(page, "05-commander");
    await card.locator(".card-cmp-input").press("Enter");
    for (let i = 0; i < 150 && fake.calls().length < 2; i++) await sleep(100);
    if (fake.calls().length < 2) throw new Error("the person's run did not complete on the hidden site");
    await sleep(1200);
    const answer = await card.locator("body").innerText();
    console.log(`   Commander shows: ${JSON.stringify(answer.slice(0, 200))}`);
    await beat(page, "The run worked on the site that is still denied", "The worker built the run and called the model. The Commander shows the answer, and the page was not involved.", "05-run-worked");
    const during = await pageLooks(page, "the same page, right after the run");
    await beat(page, `The run's page scripts are in this document: typeof window.ml is "${during}"`, "The worker puts them into a hidden page for a run the person starts. A reload takes them away again.", "05-contrast");
    // Settings is on the sidebar, so switch the surface and reload; the overlay of a hidden page has no run history to list.
    await configureExtension(ext.sw, { debugMode: "overlay" });
    await page.reload();
    await waitForMl(page, { approve: false });
    if (await pageLooks(page, "the reloaded page") !== "undefined") throw new Error("a reloaded hidden page sees window.ml");
    await beat(page, "Reloaded: the site is hidden again", "The denial stands; only the person's run was let in.", "05-reloaded", 1200);
    await waitInShell(page, (roots) => !!roots.sidebar?.getElementById("ml-sb-tab"));
    await inShell(page, (roots) => { roots.sidebar.getElementById("ml-sb-host").style.width = "620px"; roots.sidebar.getElementById("ml-sb-tab").click(); });
    const frame = await (async () => { for (let i = 0; i < 150; i++) { const f = page.frames().find((x) => /sidebar\.html/.test(x.url())); if (f) return f; await sleep(100); } throw new Error("the sidebar never opened"); })();

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
    await page.waitForFunction(() => !!(window.ml && window.ml.ready), null, { timeout: 15000 });
    await pageLooks(page, "now allowed");
    await beat(page, "window.ml appeared in the open page", "No reload: the page script was injected into the tab when the origin was allowed.", "06-appeared", 1200);
    await pageCalls(page, "now allowed");
    await beat(page, "The page's own call now works", "The same page, the same call.", "06-works");

    await narrateDone(page, "Demo finished", { sub: "Hidden: unknown, denied, a different scheme. Visible: what the person lists. Their own runs: always." });
    console.log("\ndone; screenshots in", OUT);
    if (HOLD) await sleep(24 * 3600 * 1000);
} finally {
    await ext.close().catch(() => {});
    await fake.stop();
    await site.stop();
}
