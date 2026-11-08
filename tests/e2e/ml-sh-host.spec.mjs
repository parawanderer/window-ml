// ml-sh-host.spec.mjs — ml.sh against a REAL process host (window-ml-host's `wmlhost`) in a real browser: a run the
// person starts calls `ml.sh.run` from its exec, the call reaches the host registered in the test profile
// (native-host.mjs), and what it printed reaches the model. Skips without a built `wmlhost`.
//
// The approver here rules as an unattended harness must: it approves the run's exec gate and DENIES every ml.sh ask,
// so only a call the built-in default lets run without asking (a read inside the temp workspace) ever runs. The host
// reads everything but credential stores, as the person's own user; an approver that said yes to an ml.sh card would
// hand the model any file on the machine.
import fs from "node:fs";
import path from "node:path";
import { test, expect } from "@playwright/test";
import { launchExtension, configureExtension, waitForMl } from "./harness.mjs";
import { startFakeLlm } from "./fake-llm.mjs";
import { startPageServer } from "../../examples/cross-page/serve.mjs";
import { wmlhostBinary, registerNativeHost, tempProfile, tempWorkspace } from "./native-host.mjs";

test.describe.configure({ mode: "default" });

const BIN = wmlhostBinary();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * One worker-built run whose single exec runs `js`, on a fresh profile with `wmlhost` registered and ml.sh turned on over
 * a temp workspace holding `hello.txt`, on the default config (read-only exec auto-approved). Every exec gate is approved
 * and every ml.sh ask DENIED.
 * @param {string} js the exec's script
 * @returns {Promise<{ tool: string, denied: any[], routing: string[] }>} the tool result the model was sent, the ml.sh asks
 *   denied, and the run's routing records (`kind reason`)
 */
async function shRun(js) {
    const fake = await startFakeLlm({ model: "fake-model" });
    const site = await startPageServer({});
    const profile = tempProfile(), ws = tempWorkspace();
    fs.writeFileSync(path.join(ws, "hello.txt"), "hi\n");
    const ext = await launchExtension({ userDataDir: profile });
    let stop = false;
    const denied = [];
    try {
        registerNativeHost(profile, ext.extensionId, /** @type {string} */ (BIN));
        await configureExtension(ext.sw, { chatUrl: fake.url, apiKey: "", apiFormat: "openai", model: "fake-model",
            shellEnabled: true, shellRoots: [ws], shellSandbox: true });
        const page = await ext.context.newPage();
        await page.goto(site.url + "/");
        await waitForMl(page);
        const approver = (async () => {
            while (!stop) {
                const gates = await ext.sw.evaluate(() => globalThis.__mlApprovals?.list?.() ?? []).catch(() => []);
                for (const g of gates) {
                    // A nested ml.sh ask carries the call's facts (sw-asks.ts, `tool: "sh"`): never approved here.
                    const yes = g.tool === "exec" && !g.askId;
                    if (!yes) denied.push({ tool: g.tool, argv: g.facts?.argv ?? g.arguments?.argv });
                    await ext.sw.evaluate(({ key, yes }) => globalThis.__mlApprovals.resolve(key, yes), { key: g.key, yes }).catch(() => {});
                }
                await sleep(100);
            }
        })();
        fake.setScript([{ tool: "exec", args: { js } }, { content: "done" }]);
        const tabId = await ext.sw.evaluate(async (u) => (await chrome.tabs.query({})).find((t) => t.url?.startsWith(u))?.id, site.url);
        await ext.sw.evaluate(({ tabId }) => globalThis.__mlStartUserRunForTest(tabId, { task: "list the workspace", surface: "hud" }, { approvalRouting: "both" }), { tabId });
        await expect.poll(() => fake.calls().length, { timeout: 30000 }).toBeGreaterThanOrEqual(2);
        stop = true;
        await approver;
        const tool = (fake.calls()[1].messages ?? []).filter((m) => m.role === "tool").map((m) => String(m.content)).join("\n");
        const routing = await ext.sw.evaluate(async () => (await globalThis.__mlRunLog.all()).filter((r) => r.subsystem === "routing").map((r) => `${r.kind} ${r.reason}`));
        return { tool, denied, routing };
    } finally {
        stop = true;
        await ext.close();
        await fake.stop?.();
        await site.stop?.();
        fs.rmSync(profile, { recursive: true, force: true });
        fs.rmSync(ws, { recursive: true, force: true });
    }
}

test.describe("ml.sh on a real host", () => {
    test.skip(!BIN, "no built wmlhost: `cargo build --release` in a window-ml-host checkout beside this one, or set E2E_WMLHOST");

    test("a free read inside the workspace runs on the host, and what it printed reaches the model", async () => {
        const { tool, denied, routing } = await shRun(`const r = await ml.sh.run(["ls"]); return JSON.stringify({ code: r.code, ok: r.ok, ran: r.ran, out: r.stdout.text });`);
        expect(denied, "a free call asked").toEqual([]);
        // The script names ml.sh, so its read-only survey never goes to the page's world, and the exec runs isolated.
        expect(routing).toEqual(["readonly-worker script-isolated", "exec-isolated sh"]);
        expect(tool).toContain("hello.txt");
        expect(tool).toMatch(/\\?"code\\?":0/);
        expect(tool).toMatch(/host-sandbox/);
    });

    test("a read OUTSIDE the workspace asks, the harness denies it, and nothing outside reaches the model", async () => {
        const { tool, denied } = await shRun(`try { const r = await ml.sh.run(["cat", "/etc/hosts"]); return "RAN " + r.stdout.text; } catch (e) { return "REFUSED " + e.code + " " + e.message; }`);
        expect(denied.map((d) => d.tool), "positive control: the read asked").toEqual(["sh"]);
        expect(tool).toMatch(/REFUSED Denied/);
        expect(tool).not.toMatch(/localhost/);
    });
});
