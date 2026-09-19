import { test, expect } from "@playwright/test";
import { launchExtension } from "./harness.mjs";

// THE SESSION ARCHIVE IN A REAL BROWSER: the SQLite worker the offscreen document starts, its wasm found beside a
// classic bundle, and its database on OPFS. None of that exists in node: the SQL is tested there (archive-db.test.mjs)
// against an in-memory database, and this is the plumbing around it — offscreen relay, worker, wasm, VFS.

const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

/** Send one archive operation from the service worker, as sw-archive.ts does. */
async function archive(ext, op, args) {
    return ext.sw.evaluate(async ([op, args]) => {
        if (!(await chrome.offscreen.hasDocument())) {
            await chrome.offscreen.createDocument({ url: "offscreen.html", reasons: ["WORKERS"], justification: "archive e2e" });
        }
        return chrome.runtime.sendMessage({ type: "ARCHIVE_OP", op, args });
    }, [op, args]);
}

test("a session goes into the OPFS archive and reads back, images restored, searchable", async () => {
    const ext = await launchExtension();
    try {
        const hash = "e2e0a001";
        const events = [
            { kind: "agent", id: hash, ts: 1, session: { hash, turn: 0 }, task: "find the brass lamp", images: [PNG] },
            { kind: "agent-step", id: hash, ts: 2, session: { hash, turn: 0 }, step: 1, seq: 1, tool: "look", result: { kind: "image", dataUrl: PNG } },
            { kind: "agent-result", id: hash, ts: 3, session: { hash, turn: 0 }, summary: "It costs 40 euros", steps: 1, hitCap: false },
        ];
        const summary = { id: { runtime: "local", hash }, kind: "agent", status: "done", task: "find the brass lamp", createdTs: 1, lastTs: 3, pendingApprovals: 0, saved: true };
        const put = await archive(ext, "put", { input: { summary, events, history: null, bytes: 1234 }, archivedTs: 99 });
        expect(put, JSON.stringify(put)).toEqual({ ok: true, result: true });

        const read = await archive(ext, "read", { hash });
        expect(read.ok).toBe(true);
        expect(read.result.events).toEqual(events);

        const stats = await archive(ext, "stats");
        expect(stats.result).toMatchObject({ sessions: 1, events: 3, images: 1 });

        const found = await archive(ext, "list", { query: "40 euros" });
        expect(found.result.map((r) => r.summary.id.hash)).toEqual([hash]);

        const exported = await archive(ext, "export");
        expect(exported.ok).toBe(true);

        const removed = await archive(ext, "remove", { hash });
        expect(removed.result).toBe(true);
        expect((await archive(ext, "stats")).result).toMatchObject({ sessions: 0, images: 0 });
    } finally {
        await ext.close();
    }
});

test("the folder: a sync writes the month's file, a delete rewrites it away, and an import restores what it holds", async () => {
    const ext = await launchExtension();
    try {
        const page = await ext.context.newPage();
        await page.goto(`chrome-extension://${ext.extensionId}/popup.html`);
        // A native picker cannot be clicked from a test. A directory in the origin-private file system is a real,
        // already-granted FileSystemDirectoryHandle, so it stands in for the folder a person picked.
        await page.evaluate(async () => {
            const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle("picked-folder", { create: true });
            const db = await new Promise((res, rej) => { const r = indexedDB.open("ml-archive-folder", 1); r.onupgradeneeded = () => r.result.createObjectStore("h"); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
            await new Promise((res) => { const t = db.transaction("h", "readwrite"); t.objectStore("h").put(dir, "dir"); t.oncomplete = res; });
        });
        const files = () => page.evaluate(async () => {
            const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle("picked-folder");
            const out = [];
            for await (const [name] of dir.entries()) out.push(name);
            return out.sort();
        });

        const sept = Date.UTC(2026, 8, 10);
        const session = (hash, lastTs) => ({ summary: { id: { runtime: "local", hash }, kind: "agent", status: "done", task: `task ${hash}`, createdTs: lastTs, lastTs, pendingApprovals: 0, saved: true },
            events: [{ kind: "agent", id: hash, ts: lastTs, session: { hash, turn: 0 }, task: `remember ${hash}` }], history: null, bytes: 100 });
        await archive(ext, "put", { input: session("f01de001", sept), archivedTs: 1 });
        await archive(ext, "put", { input: session("f01de002", sept + 1000), archivedTs: 1 });

        const picked = await archive(ext, "resync");
        expect(picked.result).toMatchObject({ state: "connected", written: ["2026-09"], pending: 0 });
        expect(await files()).toEqual(["2026-09.sqlite"]);

        // Both sessions deleted: the month is empty, so its file goes. A delete reaches the folder.
        await archive(ext, "remove", { hash: "f01de001" });
        await archive(ext, "remove", { hash: "f01de002" });
        const emptied = await archive(ext, "sync");
        expect(emptied.result).toMatchObject({ removed: ["2026-09"] });
        expect(await files()).toEqual([]);

        // A wiped profile: the file is in the folder, the archive is empty; import brings it back.
        await archive(ext, "put", { input: session("f01de003", sept), archivedTs: 1 });
        await archive(ext, "sync");
        await archive(ext, "remove", { hash: "f01de003" });   // gone from the archive; the folder still has it (not synced)
        const imported = await archive(ext, "import");
        expect(imported.result.imported).toEqual({ files: 1, sessions: 1 });
        expect((await archive(ext, "read", { hash: "f01de003" })).result.events[0].task).toBe("remember f01de003");
    } finally {
        await ext.close();
    }
});
