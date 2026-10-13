// tests/popup-whitelist.test.js — the toolbar popup's self-approval whitelist: what it stores when a person adds an
// entry, and the notice it shows an install whose bare-host entries stopped covering an http origin (#628).
//
// The popup bundle is loaded into jsdom over the real popup.html, with a chrome mock that answers what the popup asks at
// load (storage, SITE_ACCESS) and nothing else.
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { JSDOM } = require("jsdom");

const DIST = path.join(__dirname, "../dist");

/**
 * The popup in jsdom.
 * @param {{ sync?: object, siteLists?: object }} opts the stored sync settings, and the site gate's lists
 * @returns the window, the sync store, and a flush
 */
async function loadPopup({ sync = {}, siteLists = { always: [], session: [], denied: [] } } = {}) {
    const html = fs.readFileSync(path.join(DIST, "popup.html"), "utf8").replace(/<script[^>]*src=[^>]*><\/script>/g, "");
    const dom = new JSDOM(html, { runScripts: "outside-only", url: "chrome-extension://test/popup.html" });
    const win = dom.window;
    const syncStore = structuredClone(sync);
    const pick = (defaults) => ({ ...(typeof defaults === "object" && defaults ? defaults : {}), ...structuredClone(syncStore) });
    win.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
    win.chrome = {
        runtime: {
            id: "test", lastError: undefined, getURL: (f) => `chrome-extension://test/${f}`, ContextType: { TAB: "TAB" },
            getContexts: async () => [],
            sendMessage: (msg, cb) => {
                const reply = msg?.type === "SITE_ACCESS" ? { data: { lists: siteLists, decision: "unknown" } } : { error: "not in this test" };
                if (typeof cb === "function") { setTimeout(() => cb(reply), 0); return undefined; }
                return Promise.resolve(reply);
            },
        },
        storage: {
            sync: { get: async (d) => pick(d), set: async (o) => { Object.assign(syncStore, structuredClone(o)); } },
            local: { get: async (d) => ({ ...(d || {}) }), set: async () => {} },
            onChanged: { addListener() {}, removeListener() {} },
        },
        permissions: { contains: (_o, cb) => cb?.(false), getAll: async () => ({ origins: [] }), request: async () => false, remove: async () => true },
        tabs: { query: async () => [], create: async () => ({}), update: async () => ({}) },
        windows: { update: async () => ({}) },
        extension: { isAllowedIncognitoAccess: (cb) => cb(false) },
    };
    win.eval(fs.readFileSync(path.join(DIST, "popup.js"), "utf8"));
    const flush = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 10)); };
    await flush();
    return { win, doc: win.document, syncStore, flush };
}

// --- adding an entry, and the upgrade notice ---

test("popup: an origin typed into the whitelist is stored as that origin; an https URL as its bare host", async () => {
    const p = await loadPopup({ sync: { pageApprovalDomains: ["127.0.0.1"] } });
    const input = p.doc.getElementById("permDomain");
    for (const typed of ["http://127.0.0.1:5123/page", "https://Docs.Example/x"]) {
        input.value = typed;
        p.doc.getElementById("permAdd").click();
        await p.flush();
    }
    assert.deepEqual(p.syncStore.pageApprovalDomains, ["127.0.0.1", "docs.example", "http://127.0.0.1:5123"]);
    assert.deepEqual([...p.doc.querySelectorAll("#permList .perm-host")].map((e) => e.textContent), p.syncStore.pageApprovalDomains, "shown as stored");
});

test("UPGRADE (popup): a bare entry's http origins that stopped self-approving are listed, loopback too, and Add trusts that exact origin", async () => {
    const p = await loadPopup({ sync: { pageApprovalDomains: ["localhost", "mlbox.lan"] },
        siteLists: { always: ["http://localhost:3000", "http://mlbox.lan:8080"], session: [], denied: [] } });
    const box = () => p.doc.getElementById("permUncovered");
    assert.ok(box(), "the popup has the notice's place");
    assert.match(box().textContent, /no longer answer their own approval prompts/);
    assert.deepEqual([...box().querySelectorAll(".perm-host")].map((e) => e.textContent), ["http://localhost:3000", "http://mlbox.lan:8080"]);
    for (const o of ["http://localhost:3000", "http://mlbox.lan:8080"]) {
        box().querySelector(`button[aria-label="Trust ${o} to self-approve"]`).click();
        await p.flush();
    }
    assert.deepEqual(p.syncStore.pageApprovalDomains, ["http://localhost:3000", "http://mlbox.lan:8080", "localhost", "mlbox.lan"]);
    assert.equal(box().textContent, "", "the notice is gone once every origin is trusted");
});
