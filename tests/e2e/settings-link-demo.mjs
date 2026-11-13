#!/usr/bin/env node
// settings-link-demo.mjs — a NARRATED VISUAL demo (not a test) of a `window-ml:setting/<key>` link (docs/spec/LINKS.md,
// slice 1): the model answers "how do I…" with a link to the setting, the reply draws it as a link-styled button with
// a tip saying where it goes, and one click opens Settings on that tab, with its section open and the row scrolled to
// and ringed. A scripted fake model stands in for a real one, so no backend or key is needed.
//
//   npm run build && node --import tsx tests/e2e/settings-link-demo.mjs
//
// Beats: the question; the reply with its link; the tip; the click; the row marked; a second link to a section.
// Screenshots land in tests/e2e/artifacts/settings-link-demo/. Env: HOLD=0 to exit at the end, PACE=<ms> per beat.
// The assertions are tests/setting-places.test.js and tests/links-redteam.test.js.
import fs from "node:fs";
import path from "node:path";
import { launchExtension, configureExtension, waitForMl, openRunInSidebar, narrate, narrateDone } from "./harness.mjs";
import { startFakeLlm } from "./fake-llm.mjs";
import { startPageServer } from "../../examples/cross-page/serve.mjs";

const ART = path.resolve("tests/e2e/artifacts/settings-link-demo");
fs.mkdirSync(ART, { recursive: true });
const HOLD = process.env.HOLD !== "0";
const PACE = +(process.env.PACE || 2200);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const QUESTION = "How do I let window.ml run programs on my machine?";
const REPLY = [
    "Programs run through `ml.sh`, which is **off by default**.",
    "",
    "1. Install the process host once (`wmlhost install`).",
    "2. Turn on [Let scripts run programs](window-ml:setting/shellEnabled).",
    "3. Add the folders a program may work in under [Workspace folders](window-ml:setting/shellRoots).",
    "",
    "Every call still asks you first. The whole section is [Programs (ml.sh)](window-ml:settings/extension/advanced/shell).",
].join("\n");

const fake = await startFakeLlm({ model: "fake-model" });
const site = await startPageServer({});
const ext = await launchExtension({ headful: true });
await configureExtension(ext.sw, { chatUrl: fake.url, apiKey: "", apiFormat: "openai", model: "fake-model", modelFilter: "", debugMode: "overlay" });

const page = await ext.context.newPage();
await page.setViewportSize({ width: 1400, height: 900 });
await page.bringToFront();
await page.goto(site.url + "/");
await waitForMl(page);
let n = 0;
const shot = (name) => page.screenshot({ path: path.join(ART, `${String(++n).padStart(2, "0")}-${name}.png`) }).catch(() => {});
const say = async (title, sub = "") => { console.log(`${title}${sub ? `: ${sub}` : ""}`); await narrate(page, title, { sub }); await sleep(PACE); };

await say("A question about the extension itself", `ml.chat("${QUESTION}")`);
fake.setScript([{ content: REPLY }]);
await page.evaluate((q) => window.ml.chat(q), QUESTION);

await say("The model answers with links to the settings", "It writes [label](window-ml:setting/<key>); the sidebar draws each as a link");
const sb = await openRunInSidebar(page, { width: 620 });
const link = sb.locator('button.md-addr[data-addr="setting/shellEnabled"]');
await link.waitFor({ timeout: 10000 });
await shot("reply-with-links");

await say("The tip says where it goes", "Taken from the address, never from the label the model wrote");
await link.hover();
await sleep(400);
await shot("tip");
console.log(`  tip: ${await link.getAttribute("data-tip")}`);

await say("One click opens Settings at that row", "The Advanced tab, the Programs section opened, the row scrolled to and ringed");
await link.click();
const row = sb.locator('[data-setting~="shellEnabled"].set-marked');
await row.waitFor({ timeout: 10000 });
await sleep(500);
await shot("row-marked");

await say("A link can name a whole section too", "Back to the reply, then [Programs (ml.sh)](window-ml:settings/extension/advanced/shell)");
// `‹` goes back to the session the link was clicked in.
await sb.locator("button.tt.nav", { hasText: "‹" }).first().click({ timeout: 3000 }).catch(() => {});
await sleep(600);
if (!(await sb.locator("button.md-addr").count())) { await sb.locator(".row").first().click().catch(() => {}); await sleep(600); }
const section = sb.locator('button.md-addr[data-addr="settings/extension/advanced/shell"]');
if (await section.count()) {
    await section.click();
    await sb.locator('[data-section="shell"][open]').waitFor({ timeout: 10000 });
    await sleep(500);
    await shot("section-open");
} else console.log("  (could not get back to the reply; skipped the section beat)");

await narrateDone(page, "Demo finished", { sub: "A link only OPENS a view: it never changes a setting, and a link inside a tool's output or a quote stays text." });
console.log(`screenshots: ${ART}`);
if (HOLD) await new Promise(() => {});
await ext.context.close();
await fake.stop?.();
await site.stop?.();
