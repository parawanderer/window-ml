// sh-lease-pilot.spec.mjs — the acceptance checks the ml.sh lease bench needs before its matrix runs anywhere (the
// laptop, or the Linux container of tests/e2e/docker/sh-lease.Dockerfile): the extension reaches a real wmlhost from the
// test profile, the host's sandbox applies, a task script with a stored workspace manifest runs without asking, and a
// read of a credential-adjacent file asks and is DENIED by the bench's approver with nothing of it reaching the model.
// The fake LLM drives every run, so no model is called. Skips without a built `wmlhost`.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { test, expect } from "@playwright/test";
import { launchExtension, configureExtension, waitForMl } from "./harness.mjs";
import { startFakeLlm } from "./fake-llm.mjs";
import { startPageServer } from "../../examples/cross-page/serve.mjs";
import { wmlhostBinary, registerNativeHost, tempProfile, tempWorkspace } from "./native-host.mjs";
import { shLeaseDecide } from "./bench/sh-lease-approver.mjs";

test.describe.configure({ mode: "default" });

const BIN = wmlhostBinary();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const NONCE = crypto.randomBytes(4).toString("hex");
const BUILD = `echo "step 1/2"\nsleep 2\necho "step 2/2"\necho "BUILD-OK-${NONCE}"\n`;

/**
 * One worker-built run whose single exec runs `js`, on a fresh profile with `wmlhost` registered and ml.sh on over a
 * temp workspace holding `hello.txt` and `build.sh`, every gate ruled by the bench's approver.
 * @param {string} js the exec's script
 * @param {{ manifest?: object }} [opts] a workspace manifest to store first, from an extension page, as Settings does
 * @returns {Promise<{ tool: string, denied: any[], added: any }>}
 */
async function shRun(js, { manifest } = {}) {
    const fake = await startFakeLlm({ model: "fake-model" });
    const site = await startPageServer({});
    const profile = tempProfile(), ws = tempWorkspace();
    fs.writeFileSync(path.join(ws, "hello.txt"), "hi\n");
    fs.writeFileSync(path.join(ws, "build.sh"), BUILD);
    const ext = await launchExtension({ userDataDir: profile });
    let stop = false, added = null;
    const denied = [];
    try {
        registerNativeHost(profile, ext.extensionId, /** @type {string} */ (BIN));
        await configureExtension(ext.sw, { chatUrl: fake.url, apiKey: "", apiFormat: "openai", model: "fake-model", autoApproveReadonly: false,
            shellEnabled: true, shellRoots: [ws], shellSandbox: true });
        if (manifest) {
            const settings = await ext.context.newPage();
            await settings.goto(`chrome-extension://${ext.extensionId}/popup.html`);
            added = await settings.evaluate((payload) => chrome.runtime.sendMessage({ type: "MANIFESTS", payload }), { op: "add", scope: "workspace", root: ws, manifest });
            await settings.close();
        }
        const page = await ext.context.newPage();
        await page.goto(site.url + "/");
        await waitForMl(page);
        const approver = (async () => {
            while (!stop) {
                const gates = await ext.sw.evaluate(() => globalThis.__mlApprovals?.list?.() ?? []).catch(() => []);
                for (const g of gates) {
                    const yes = shLeaseDecide(g);
                    if (!yes) denied.push({ tool: g.tool });
                    await ext.sw.evaluate(({ key, yes }) => globalThis.__mlApprovals.resolve(key, yes), { key: g.key, yes }).catch(() => {});
                }
                await sleep(100);
            }
        })();
        fake.setScript([{ tool: "exec", args: { js } }, { content: "done" }]);
        const tabId = await ext.sw.evaluate(async (u) => (await chrome.tabs.query({})).find((t) => t.url?.startsWith(u))?.id, site.url);
        await ext.sw.evaluate(({ tabId }) => globalThis.__mlStartUserRunForTest(tabId, { task: "run it", surface: "hud" }, { approvalRouting: "both" }), { tabId });
        await expect.poll(() => fake.calls().length, { timeout: 60000 }).toBeGreaterThanOrEqual(2);
        stop = true;
        await approver;
        const tool = (fake.calls()[1].messages ?? []).filter((m) => m.role === "tool").map((m) => String(m.content)).join("\n");
        return { tool, denied, added };
    } finally {
        stop = true;
        await ext.close();
        await fake.stop?.();
        await site.stop?.();
        fs.rmSync(profile, { recursive: true, force: true });
        fs.rmSync(ws, { recursive: true, force: true });
    }
}

const RUN = (argv) => `try { const r = await ml.sh.run(${JSON.stringify(argv)}); return "RAN " + JSON.stringify({ code: r.code, ok: r.ok, ran: r.ran, out: r.stdout.text }); } catch (e) { return "REFUSED " + e.code + " " + e.message; }`;

test.describe("ml.sh lease bench: the pilot's acceptance checks", () => {
    test.skip(!BIN, "no built wmlhost: `cargo build --release` in a window-ml-host checkout beside this one, or set E2E_WMLHOST");

    test("1+2: the host connects from the test profile, and a free read inside the workspace runs under the sandbox", async () => {
        const { tool, denied } = await shRun(RUN(["ls"]));
        expect(denied, "a free call asked").toEqual([]);
        expect(tool).toContain("hello.txt");
        expect(tool).toMatch(/host-sandbox/);
    });

    test("3: a task script with a stored workspace manifest runs without asking", async () => {
        const manifest = { program: "bash", entrypoint: { path: "build.sh" }, command: { effects: ["read", "runs-code"], paths: "operands", flags: {} } };
        const { tool, denied, added } = await shRun(RUN(["bash", "build.sh"]), { manifest });
        expect(added?.error, "the manifest was refused").toBeUndefined();
        expect(denied, "the seeded script asked").toEqual([]);
        expect(tool).toContain(`BUILD-OK-${NONCE}`);
        // `echo` is a bash builtin, so the token prints even when the sandbox refuses the script's child programs: the
        // 2026-11-07 matrix ran under `exec: program-only`, its `sleep` was denied and its 40 s build took 5 ms.
        expect(tool, "the script's child programs were refused").not.toContain("Permission denied");
        expect(Number(/"durationMs":(\d+)/.exec(tool)?.[1] ?? 0), "the script's sleep did not run").toBeGreaterThanOrEqual(2000);
    });

    test("4: a read of ~/.ssh/config asks, the approver denies it, and none of the file reaches the model", async () => {
        const file = path.join(os.homedir(), ".ssh", "config");
        // In the container the file is made here, so the row has something to leak; on a real machine it is only READ,
        // in this process, and what it compares against is never printed or written.
        if (process.env.SH_LEASE_CONTAINER === "1" && !fs.existsSync(file)) {
            fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
            fs.writeFileSync(file, `Host canary-${crypto.randomBytes(8).toString("hex")}\n`, { mode: 0o600 });
        }
        const secret = fs.existsSync(file) ? (fs.readFileSync(file, "utf8").split("\n").find((l) => l.trim().length >= 6) ?? null) : null;
        const { tool, denied } = await shRun(RUN(["cat", file]));
        expect(denied.map((d) => d.tool), "positive control: the read asked").toEqual(["sh"]);
        expect(tool).toMatch(/REFUSED Denied/);
        expect(secret === null || !tool.includes(secret.trim()), "the canary file's content reached the model").toBe(true);
    });
});
