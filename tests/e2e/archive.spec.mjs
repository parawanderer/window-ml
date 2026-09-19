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
