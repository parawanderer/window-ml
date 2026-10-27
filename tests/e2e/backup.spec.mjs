import { test, expect } from "@playwright/test";
import { readFile, writeFile, mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { launchExtension } from "./harness.mjs";

// BACKUP AND RESTORE IN A REAL BROWSER: the Settings screens, the BACKUP message, the archive worker writing the file
// into the origin-private file system, Argon2 and the keyring in IndexedDB, and a second profile restoring the file
// with only the recovery key. Node covers each part (backup-*.test.mjs, backup-section.test.mjs, the BACKUP section of
// background-sessions.test.js); this is the path between them, which none of those can run.

test.describe.configure({ mode: "default" });

const SITE = "https://backup-e2e.example";
const MODEL = "backup-e2e-model";
const PASSPHRASE = "a long enough passphrase for e2e";

/** Put one finished session into the archive, as the archive does when it moves one there. */
async function archiveSession(ext, hash, task, ts) {
    return ext.sw.evaluate(async ([hash, task, ts]) => {
        if (!(await chrome.offscreen.hasDocument())) {
            await chrome.offscreen.createDocument({ url: "offscreen.html", reasons: ["WORKERS"], justification: "backup e2e" }).catch(() => { /* the worker created it first */ });
        }
        const input = {
            summary: { id: { runtime: "local", hash }, kind: "agent", status: "done", task, createdTs: ts, lastTs: ts + 1, pendingApprovals: 0, saved: true },
            events: [{ kind: "agent", id: hash, ts, session: { hash, turn: 0 }, task }], history: null, bytes: 200,
        };
        for (let i = 0; ; i++) {
            try { return await chrome.runtime.sendMessage({ type: "ARCHIVE_OP", op: "put", args: { input, archivedTs: ts + 2 } }); }
            catch (e) { if (i >= 50 || !/Receiving end does not exist/.test(String(e?.message || e))) throw e; await new Promise((r) => setTimeout(r, 100)); }
        }
    }, [hash, task, ts]);
}

/** The archive's session hashes, read through the worker. */
const archivedHashes = (ext) => ext.sw.evaluate(async () => {
    const r = await chrome.runtime.sendMessage({ type: "ARCHIVE_OP", op: "list", args: {} });
    return r.result.map((x) => x.summary.id.hash).sort();
});

/** The extension's Settings on the chat page, at phone width so every group is on one page. Headless Chromium has no
 *  save dialog to answer, so `showSaveFilePicker` is a stand-in whose file is `saved-<name>` in the page's own OPFS:
 *  the stream the real dialog would get. */
async function settingsPage(ext, { picker = true } = {}) {
    const page = await ext.context.newPage();
    await page.setViewportSize({ width: 390, height: 900 });
    if (!picker) await page.addInitScript(() => { Object.defineProperty(window, "showSaveFilePicker", { value: undefined, configurable: true }); });
    else await page.addInitScript(() => {
        window.showSaveFilePicker = async ({ suggestedName }) => {
            const h = await (await navigator.storage.getDirectory()).getFileHandle(`saved-${suggestedName}`, { create: true });
            return { createWritable: () => h.createWritable() };
        };
    });
    await page.goto(`chrome-extension://${ext.extensionId}/chat.html#/settings/extension`);
    const block = page.locator('[role=group][aria-label="Backup and restore"]');
    await block.waitFor();
    return { page, block };
}

/** Press "Make a backup" (or the set-up button), wait for the result line, and copy the saved file out to `dir/name`. */
async function saveBackup(page, block, button, dir, name, sessions) {
    await button.click();
    const result = block.locator(".bk-result");
    await expect(result).toContainText(sessions, { timeout: 30_000 });
    const saved = (await result.locator("code").textContent()).trim();
    const bytes = await page.evaluate(async (n) => [...new Uint8Array(await (await (await (await navigator.storage.getDirectory()).getFileHandle(`saved-${n}`)).getFile()).arrayBuffer())], saved);
    const to = path.join(dir, name);
    await writeFile(to, Buffer.from(bytes));
    return to;
}

/** Pick `file` with the restore button's chooser. */
async function pickForRestore(page, block, file) {
    const [chooser] = await Promise.all([page.waitForEvent("filechooser"), block.getByRole("button", { name: "Restore from a file…" }).click()]);
    await chooser.setFiles(file);
}

// --- an encrypted backup, restored elsewhere with the recovery key ---

test("an encrypted backup restores into a fresh profile with the recovery key, and a file swapped after the preview is refused", async () => {
    test.setTimeout(120_000);
    const dir = await mkdtemp(path.join(os.tmpdir(), "wml-backup-e2e-"));
    let groups, first, second;

    // --- the first browser: set up encryption, back up twice ---
    const a = await launchExtension();
    try {
        await a.sw.evaluate(async ([site, model]) => {
            await globalThis._siteSchemaReady();
            await chrome.storage.local.set({ ml_site_always: [site] });
            await chrome.storage.sync.set({ model });
        }, [SITE, MODEL]);
        expect((await archiveSession(a, "bk0e2e01", "find the brass lamp", 1_700_000_000_000)).ok).toBe(true);

        const { page, block } = await settingsPage(a);
        await block.getByRole("button", { name: "Set up encryption and back up…" }).click();
        const pass = block.locator("input[type=password]");
        await pass.nth(0).fill(PASSPHRASE);
        await pass.nth(1).fill(PASSPHRASE);
        await block.getByRole("button", { name: "Continue" }).click();

        const key = block.locator('[aria-label="Recovery key"] .bk-group');
        await expect(key).toHaveCount(7, { timeout: 15_000 });   // Argon2 runs first
        groups = await key.allTextContents();
        await block.getByRole("button", { name: "I have saved it" }).click();

        const asked = Number((await block.locator(".set-field span", { hasText: /^Group \d+$/ }).textContent()).match(/\d+/)[0]);
        const field = block.locator(".set-field input");
        const wrongGroup = groups.find((g, i) => i !== asked - 1 && g !== groups[asked - 1]);
        await field.fill(wrongGroup);
        await block.getByRole("button", { name: "Finish set-up" }).click();
        await expect(block.getByText(`That is not group ${asked}.`, { exact: false })).toBeVisible();

        await field.fill(groups[asked - 1].toLowerCase());
        first = await saveBackup(page, block, block.getByRole("button", { name: "Finish set-up" }), dir, "first.wmlbak", "1 session.");

        // The recovery key went nowhere the UI could have put it.
        const stored = await page.evaluate(async () => JSON.stringify([
            await chrome.storage.local.get(null), await chrome.storage.sync.get(null), await chrome.storage.session.get(null), { ...localStorage }, { ...sessionStorage },
        ]));
        for (const g of groups) expect(stored.includes(g), `group ${g} of the recovery key in storage`).toBe(false);

        // A second backup, one session more: the keyring is set now, so no set-up.
        expect((await archiveSession(a, "bk0e2e02", "compare two kettles", 1_700_000_100_000)).ok).toBe(true);
        second = await saveBackup(page, block, block.getByRole("button", { name: "Make a backup" }), dir, "second.wmlbak", "2 sessions.");
        expect((await readFile(first)).equals(await readFile(second))).toBe(false);
    } finally {
        await a.context.close();
    }

    // --- a fresh browser: only the file and the recovery key ---
    const b = await launchExtension();
    try {
        const { page, block } = await settingsPage(b);
        await pickForRestore(page, block, first);
        await expect(block.getByText("Enter the passphrase it was made with, or its recovery key.", { exact: false })).toBeVisible();

        const secret = block.locator("input[type=password]");
        await secret.fill("not the passphrase at all");
        await block.getByRole("button", { name: "Unlock" }).click();
        await expect(block.getByText("That passphrase or recovery key does not open this file.", { exact: false })).toBeVisible({ timeout: 15_000 });

        await secret.fill(groups.join("-"));
        await block.getByRole("button", { name: "Unlock" }).click();
        const heads = block.locator(".bk-preview .bk-h");
        await expect(heads.first()).toHaveText("These sites will be able to use window.ml", { timeout: 15_000 });
        await expect(block.locator(".bk-preview")).toContainText(SITE);
        await expect(block.locator(".bk-sessions li")).toHaveCount(1);
        await expect(block.locator(".bk-sessions")).toContainText("find the brass lamp");

        // Swap the file under the preview: the restore must not write what was not shown.
        await page.evaluate(async (bytes) => {
            const h = await (await navigator.storage.getDirectory()).getFileHandle("wml-backup-in.tmp", { create: true });
            const w = await h.createWritable(); await w.write(new Uint8Array(bytes)); await w.close();
        }, [...await readFile(second)]);
        await block.getByRole("button", { name: "Restore", exact: true }).click();
        await expect(block.getByText("The file changed after it was previewed, so nothing was restored.", { exact: false })).toBeVisible({ timeout: 15_000 });
        expect(await archivedHashes(b), "nothing restored from a swapped file").toEqual([]);
        expect(await b.sw.evaluate(async () => (await chrome.storage.sync.get("model")).model)).not.toBe(MODEL);

        // Read it again: the preview is now of the file that is there, and that is what lands.
        await block.getByRole("button", { name: "Read it again" }).click();
        await expect(block.locator(".bk-sessions li")).toHaveCount(2, { timeout: 15_000 });
        await block.getByRole("button", { name: "Restore", exact: true }).click();
        await expect(block.locator(".bk-result")).toContainText("Restored 2 sessions", { timeout: 15_000 });

        expect(await archivedHashes(b)).toEqual(["bk0e2e01", "bk0e2e02"]);
        const landed = await b.sw.evaluate(async () => ({ sites: (await chrome.storage.local.get("ml_site_always")).ml_site_always, model: (await chrome.storage.sync.get("model")).model }));
        expect(landed).toEqual({ sites: [SITE], model: MODEL });
    } finally {
        await b.context.close();
    }
});

// --- saving a backup with no save dialog ---

// Without a save dialog the backup leaves as a download. The slot's file is removed as soon as the save returns, and a
// download reads its blob after that: handed the slot's File, Chromium cancelled it.
test("with no save dialog, a backup still arrives whole as a download", async () => {
    const ext = await launchExtension();
    try {
        expect((await archiveSession(ext, "bk0e2e03", "the download path", 1_700_000_200_000)).ok).toBe(true);
        const { page, block } = await settingsPage(ext, { picker: false });
        await block.getByRole("radio", { name: "Plain SQLite (.sqlite)" }).check();
        const [download] = await Promise.all([page.waitForEvent("download"), block.getByRole("button", { name: "Make a backup" }).click()]);
        const to = path.join(await mkdtemp(path.join(os.tmpdir(), "wml-backup-dl-")), download.suggestedFilename());
        await download.saveAs(to);
        await expect(block.locator(".bk-result")).toContainText("1 session.");
        const bytes = await readFile(to);
        expect(bytes.subarray(0, 16).toString("latin1")).toBe("SQLite format 3\0");
    } finally {
        await ext.context.close();
    }
});
