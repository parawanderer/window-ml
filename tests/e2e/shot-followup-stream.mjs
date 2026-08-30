// shot-followup-stream.mjs — a DEBUG capture (not a test) for the HUD "Show work" streaming-follow-up bug.
// It drives the OFF-MODE corner card: run → answer → expand Show work → a follow-up that streams SLOWLY, and
// screenshots MID-stream (the frame that used to be spammy) + after. Run:
//     npm run build && node --import tsx tests/e2e/shot-followup-stream.mjs
// Artifacts land in tests/e2e/artifacts/followup-<ts>/.
import { chromium } from "@playwright/test";
import { launchExtension, configureExtension, waitForMl } from "./harness.mjs";
import { startFakeLlm } from "./fake-llm.mjs";
import { startPageServer } from "../../examples/cross-page/serve.mjs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ART = path.join(HERE, "artifacts", `followup-${process.env.RUN_LABEL || Date.now()}`);
await mkdir(ART, { recursive: true });

const fake = await startFakeLlm({ model: "fake-model", streamDelayMs: 220 });   // pace words so mid-stream is catchable
const site = await startPageServer({});
const ext = await launchExtension();
await configureExtension(ext.sw, {
    chatUrl: fake.url, apiKey: "", apiFormat: "openai", model: "fake-model", modelFilter: "",
    debugMode: "off",   // the corner HUD card (not the overlay sidebar)
    autoApproveReadonly: true,   // the readonly survey below runs with no gate
});

const page = await ext.context.newPage();
await page.goto(site.url);
await waitForMl(page);

// The card lives in the shell's iframe (extension origin). Find that frame.
const cardFrame = async () => {
    for (let i = 0; i < 60; i++) {
        const f = page.frames().find((fr) => /sidebar\.html/.test(fr.url()));
        if (f) return f;
        await sleep(100);
    }
    throw new Error("card iframe never appeared (is off-mode mounting the card?)");
};

// Turn 1: a readonly survey (auto-approved → a real tool STEP so Show work exists), then a streamed answer.
fake.setScript([
    { tool: "exec", args: { js: "document.querySelectorAll('p,div,a').length" } },
    { content: "The page has plenty of elements; here is a first summary of what I found." },
]);
const started = await page.evaluate(() => {
    window.__run = window.ml.agent("survey this page", { stream: true, env: false });
    window.__run.then((r) => (window.__hash = r.hash));
    return true;
});
void started;

const frame = await cardFrame();
// Wait for the finished answer, then expand Show work.
await frame.waitForSelector(".card-answer", { timeout: 20000 });
await frame.waitForSelector(".card-work-toggle", { timeout: 20000 });
await frame.click(".card-work-toggle");
await frame.waitForSelector(".card-work-toggle.open, .card-work-toggle:has(.card-work-label)", { timeout: 5000 }).catch(() => {});
await sleep(300);
await page.screenshot({ path: path.join(ART, "1-answer-showwork-open.png") });
console.log("captured: finished answer with Show work expanded");

// Grab the run hash, then fire a follow-up that STREAMS SLOWLY into the same card.
const hash = await page.evaluate(async () => { await window.__run; return window.__hash; });
fake.setScript([
    { content: "Only one of the servers uses http rather than https, and it is the local test endpoint; everything else is secured over https as expected for production traffic." },
]);
await page.evaluate((h) => { window.ml.agent("and which use http?", { resume: h, stream: true }); return true; }, hash);

// Screenshot MID-stream — the frame that used to show the expanded trace looming/reflowing over the answer.
await frame.waitForSelector(".card-working, .live-scroll, .card-answer", { timeout: 10000 }).catch(() => {});
await sleep(500);
await page.screenshot({ path: path.join(ART, "2-followup-midstream.png") });
console.log("captured: follow-up MID-stream");
await sleep(900);
await page.screenshot({ path: path.join(ART, "3-followup-midstream-later.png") });

// And the settled state.
await sleep(2500);
await page.screenshot({ path: path.join(ART, "4-followup-done.png") });
console.log("captured: follow-up settled");

console.log("artifacts:", ART);
await ext.close();
await fake.stop();
await site.stop();
