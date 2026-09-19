// chat-pairing.spec.mjs — THIS BROWSER JOINS AN ACCOUNT from the chat page's Settings → Devices, through a REAL hub:
// the page offers the browser as a runtime and shows a code and a fingerprint, the test plays the phone that holds the
// account's root (pair-flow.ts, as the root device's screens will), compares the fingerprint exactly as a person would,
// and confirms. Then the worker connects on its own, and leaving undoes it.
//
// Needs the pinned `wmlhub` binary (tests/fixtures/hub-harness.mjs); skipped with the reason when there is none.
import { test, expect } from "@playwright/test";
import { createRequire } from "node:module";
import { launchExtension } from "./harness.mjs";
import { HAVE_HUB, NO_HUB, startHub } from "../fixtures/hub-harness.mjs";

const { IDBFactory } = createRequire(import.meta.url)("fake-indexeddb");
const { Keyring } = await import("../../src/hub/keyring.ts");
const F = await import("../../src/hub/pair-flow.ts");
const { HubClient } = await import("../../src/hub/client.ts");
const { Role } = await import("../../src/hub/wire.ts");

test.skip(!HAVE_HUB, NO_HUB);

/** Settings → Devices on the chat page. */
async function openDevices(page) {
    await page.locator(".chat-list-foot .chat-gear-btn").click();
    await page.getByRole("menuitem", { name: "Settings" }).click();
    await page.getByRole("tab", { name: "Devices" }).click();
}

test("this browser joins an account as a runtime: code and fingerprint here, confirmed on the root device, then connected", async () => {
    const hub = await startHub();
    const ext = await launchExtension();
    let phoneClient = null;
    try {
        const page = await ext.context.newPage();
        const errors = [];
        page.on("pageerror", (e) => errors.push(e.message));
        await page.goto(`chrome-extension://${ext.extensionId}/chat.html`);
        await page.locator(".chat").waitFor();
        await openDevices(page);

        // A runtime joins; it never creates (the root is not a runtime's to hold), and says where that happens.
        await expect(page.locator(".pair-h").first()).toHaveText("This device is in no account");
        await expect(page.getByRole("button", { name: "Create an account" })).toHaveCount(0);
        await expect(page.locator(".pair-card").first()).toContainText("This browser joins an account; it never holds one");

        // A hub that is not there fails in words, with the form still up.
        await page.getByRole("button", { name: "Join an account" }).click();
        await page.getByLabel("Call this device").fill("Test laptop");
        await page.getByLabel("Hub", { exact: true }).fill("ws://127.0.0.1:1");
        await page.getByRole("button", { name: "Get a code" }).click();
        await expect(page.getByRole("alert")).toContainText(/hub/i, { timeout: 20_000 });

        // THE PHONE: it created the account, so it holds the root and may pair.
        const phone = await Keyring.open("phone", new IDBFactory());
        await F.createAccount(phone, { hubUrl: hub.url, label: "Shane's phone" });
        const me = await phone.load();
        const m = me.membership;
        phoneClient = await HubClient.connect({ url: m.hubUrl, hubName: m.hubName, identity: me.identity, agreement: me.agreement, chain: m.chain, accountRoot: m.accountRoot, role: Role.ROLE_CLIENT });

        await page.getByLabel("Hub", { exact: true }).fill(hub.url);
        await page.getByRole("button", { name: "Get a code" }).click();
        const code = (await page.locator(".pair-code").textContent()).trim();
        const shown = (await page.locator(".pair-fp").textContent()).replace(/\s/g, "");
        expect(code).toMatch(/^[0-9A-Z]{4} [0-9A-Z]{4}$/);

        // What the person does: type the code on the phone, and compare the fingerprint it computes with this screen's.
        const found = await F.lookupOffer(phoneClient, code);
        expect(found.fingerprint, "the phone computes the fingerprint this page shows").toBe(shown);
        expect(found.offer.label).toBe("Test laptop");
        expect(found.offer.role).toBe(Role.ROLE_RUNTIME);
        const issuer = await F.issuerOf(phone);
        await F.confirmOffer(phoneClient, issuer, found, F.defaultGrant(Role.ROLE_RUNTIME, issuer));

        // Joined: the page shows what this browser is on the account, and the worker connects by itself.
        await expect(page.locator(".pair-h").first()).toHaveText("“Test laptop”, a browser runtime", { timeout: 15_000 });
        await expect(page.locator(".pair-facts")).toContainText(hub.url);
        await expect(page.locator(".pair-conn")).toContainText("Connected", { timeout: 20_000 });
        // A runtime pairs nobody: that happens on the root device.
        await expect(page.getByRole("button", { name: "Pair a device" })).toHaveCount(0);

        // The phone is connected, so this browser's allowlist lists it (seen in presence, its chain verified): named as
        // its certificate names it, and removable from here.
        const list = page.getByRole("region", { name: "Devices on this account" });
        const phoneRow = list.locator(".pair-dev", { hasText: "Shane's phone" });
        await expect(phoneRow).toBeVisible({ timeout: 20_000 });
        await expect(phoneRow.locator(".pair-dev-seen")).toContainText("Seen");
        await phoneRow.getByRole("button", { name: "Remove…" }).click();
        await phoneRow.getByRole("button", { name: /^Remove it/ }).click();
        await expect(list.getByRole("status")).toContainText("was removed", { timeout: 10_000 });

        // Leaving asks first, says what it costs, and then this browser is in no account and stops connecting.
        await page.getByRole("button", { name: "Leave this account…" }).click();
        await expect(page.locator(".pair-leave")).toContainText("Your devices stop reaching this browser");
        await page.getByRole("button", { name: "Leave", exact: true }).click();
        await expect(page.locator(".pair-h").first()).toHaveText("This device is in no account");
        expect(errors).toEqual([]);
    } finally {
        phoneClient?.close();
        await ext.context.close();
        hub.stop();
    }
});

test("the standalone client creates the account and pairs this browser, then lists it as a runtime", async () => {
    const { serveStatic } = await import("./static-server.mjs");
    const hub = await startHub();
    const web = await serveStatic("dist-web");
    const ext = await launchExtension();
    try {
        const errors = [];
        // THE CLIENT: a plain page, no extension behind it. In no account, it shows only the account panel.
        const client = await ext.context.newPage();
        client.on("pageerror", (e) => errors.push(`client: ${e.message}`));
        await client.goto(`${web.url}client.html`);
        await expect(client.locator(".pair-h").first()).toHaveText("This device is in no account");
        await client.getByRole("button", { name: "Create an account" }).click();
        await expect(client.getByRole("note")).toContainText("this site's data in this browser");
        await client.getByLabel("Call this device").fill("Shane's desk");
        await client.getByLabel("Hub", { exact: true }).fill(hub.url);
        await client.getByRole("button", { name: "Create it" }).click();
        // It reloads into the chat page, connected, with nothing running on it: no runtimes until one joins.
        await expect(client.locator(".chat")).toBeVisible({ timeout: 20_000 });

        // THE BROWSER: joins from its own Settings → Devices, and shows a code.
        const page = await ext.context.newPage();
        page.on("pageerror", (e) => errors.push(`extension: ${e.message}`));
        await page.goto(`chrome-extension://${ext.extensionId}/chat.html`);
        await page.locator(".chat").waitFor();
        await openDevices(page);
        await page.getByRole("button", { name: "Join an account" }).click();
        await page.getByLabel("Call this device").fill("Test laptop");
        await page.getByLabel("Hub", { exact: true }).fill(hub.url);
        await page.getByRole("button", { name: "Get a code" }).click();
        const code = (await page.locator(".pair-code").textContent()).trim();
        const shown = (await page.locator(".pair-fp").textContent()).replace(/\s/g, "");

        // BACK ON THE CLIENT: Settings → Devices → Pair a device, the code typed, the fingerprints compared.
        await expect(client.locator(".chat")).toContainText("No runtimes yet");
        await openDevices(client);
        await client.getByRole("button", { name: "Pair a device" }).click();
        await client.getByLabel("Its code").fill(code);
        await client.getByRole("button", { name: "Find it" }).click();
        await expect(client.locator(".pair-h").first()).toHaveText("“Test laptop” wants to join as a browser runtime");
        expect((await client.locator(".pair-fp").textContent()).replace(/\s/g, ""), "both screens show the same fingerprint").toBe(shown);
        await client.getByRole("button", { name: "They match: pair it" }).click();
        await expect(client.locator(".pair-h").first()).toHaveText("Paired");

        // The browser joins and connects; the client lists it as a runtime, named by its verified label.
        await expect(page.locator(".pair-conn")).toContainText("Connected", { timeout: 20_000 });
        await client.reload();
        await expect(client.locator(".chat-rt", { hasText: "Test laptop" })).toBeVisible({ timeout: 30_000 });

        // THE HUB GOES AWAY: the page stays where it is (no reload: a marker set now survives) and says it is not
        // connected, instead of quietly going stale. HubHost.reconnecting keeps trying; hub-host.test.mjs covers the return.
        await client.evaluate(() => { globalThis.__stillHere = true; });
        hub.stop();
        await expect(client.locator(".chat-list .head .chat-chip")).toHaveText(/offline|connecting/, { timeout: 20_000 });
        expect(await client.evaluate(() => globalThis.__stillHere)).toBe(true);
        expect(errors).toEqual([]);
    } finally {
        await ext.context.close();
        await web.close();
        hub.stop();
    }
});

test("a session this browser had BEFORE the client paired opens on the client with its transcript", async () => {
    // Reported on a real phone as "Loading…" forever: the session had finished before the client paired, so it had no
    // key for the client and no frames on the hub. Fixed in #228 (a keyless ring ends, and the history is asked for).
    const { startFakeLlm } = await import("./fake-llm.mjs");
    const { configureExtension } = await import("./harness.mjs");
    const { serveStatic } = await import("./static-server.mjs");
    const fake = await startFakeLlm({ model: "fake-model" });
    const hub = await startHub();
    const web = await serveStatic("dist-web");
    const ext = await launchExtension();
    try {
        const errors = [];
        // A chat on this browser, the way Shane's "Hello there?" was: before any client existed.
        await configureExtension(ext.sw, { chatUrl: fake.url, apiKey: "", apiFormat: "openai", model: "fake-model", debugMode: "off" });
        fake.setScript([{ content: "General Kenobi." }]);
        const page = await ext.context.newPage();
        page.on("pageerror", (e) => errors.push(`extension: ${e.message}`));
        await page.goto(`chrome-extension://${ext.extensionId}/chat.html`);
        await page.locator(".chat").waitFor();
        await page.getByRole("radio", { name: "Chat" }).click();
        await page.locator(".chat-start-box textarea").fill("Hello there?");
        await page.locator(".chat-start-box textarea").press("Enter");
        await expect(page.locator(".chat-main")).toContainText("General Kenobi.");

        // The client makes the account; the browser joins it (the same steps as the test above).
        const client = await ext.context.newPage();
        client.on("pageerror", (e) => errors.push(`client: ${e.message}`));
        await client.goto(`${web.url}client.html`);
        await client.getByRole("button", { name: "Create an account" }).click();
        await client.getByLabel("Hub", { exact: true }).fill(hub.url);
        await client.getByRole("button", { name: "Create it" }).click();
        await expect(client.locator(".chat")).toBeVisible({ timeout: 20_000 });
        await page.goto(`chrome-extension://${ext.extensionId}/chat.html#/settings/devices`);
        await page.getByRole("button", { name: "Join an account" }).click();
        await page.getByLabel("Call this device").fill("Test laptop");
        await page.getByLabel("Hub", { exact: true }).fill(hub.url);
        await page.getByRole("button", { name: "Get a code" }).click();
        const code = (await page.locator(".pair-code").textContent()).trim();
        await client.goto(`${web.url}client.html#/settings/devices`);
        await client.getByRole("button", { name: "Pair a device" }).click();
        await client.getByLabel("Its code").fill(code);
        await client.getByRole("button", { name: "Find it" }).click();
        await client.getByRole("button", { name: "They match: pair it" }).click();
        await expect(page.locator(".pair-conn")).toContainText("Connected", { timeout: 20_000 });

        // The client lists the session, as Shane saw, and opening it shows the conversation rather than "Loading…".
        await client.goto(`${web.url}client.html`);
        const row = client.locator(".chat-row", { hasText: "Hello there?" });
        await expect(row).toBeVisible({ timeout: 30_000 });
        await row.click();
        await expect(client.locator(".chat-main")).toContainText("General Kenobi.", { timeout: 20_000 });
        expect(errors).toEqual([]);
    } finally {
        await ext.context.close();
        await web.close();
        hub.stop();
        await fake.stop();
    }
});
