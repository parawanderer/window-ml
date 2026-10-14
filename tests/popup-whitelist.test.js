// tests/popup-whitelist.test.js — the toolbar popup's "This site" block and the self-approval list: the popup no longer
// edits the self-approval list (slice 3, Q14: it is the strongest grant, and the popup is the one-click surface), and it
// shows the current site's agent level on a line of its own.
//
// The popup bundle is loaded into jsdom over the real popup.html, with a chrome mock that answers what the popup asks at
// load (storage, SITE_ACCESS for the current tab's origin) and nothing else.
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { JSDOM } = require("jsdom");

const DIST = path.join(__dirname, "../dist");

/**
 * The popup in jsdom, its active tab at `tabUrl`.
 * @param {{ tabUrl?: string, site?: object }} opts the current tab's URL, and the worker's SITE_ACCESS answer for its origin
 * @returns the window, the document, the sync store, what the popup sent, and a flush
 */
async function loadPopup({ tabUrl = "https://site.example/page", site = { decision: "unknown" } } = {}) {
    const html = fs.readFileSync(path.join(DIST, "popup.html"), "utf8").replace(/<script[^>]*src=[^>]*><\/script>/g, "");
    const dom = new JSDOM(html, { runScripts: "outside-only", url: "chrome-extension://test/popup.html" });
    const win = dom.window;
    const syncStore = {};
    const sent = [];
    win.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
    win.chrome = {
        runtime: {
            id: "test", lastError: undefined, getURL: (f) => `chrome-extension://test/${f}`, ContextType: { TAB: "TAB" },
            getContexts: async () => [],
            sendMessage: (msg, cb) => {
                sent.push(msg);
                const reply = msg?.type === "SITE_ACCESS" ? { data: { lists: { always: [], session: [], denied: [], agents: {}, selfApprove: [] }, origin: msg.payload?.origin, ...site } } : { error: "not in this test" };
                if (typeof cb === "function") { setTimeout(() => cb(reply), 0); return undefined; }
                return Promise.resolve(reply);
            },
        },
        storage: {
            sync: { get: async (d) => ({ ...(typeof d === "object" && d ? d : {}), ...syncStore }), set: async (o) => { Object.assign(syncStore, structuredClone(o)); } },
            local: { get: async (d) => ({ ...(d || {}) }), set: async () => {} },
            onChanged: { addListener() {}, removeListener() {} },
        },
        permissions: { contains: (_o, cb) => cb?.(false), getAll: async () => ({ origins: [] }), request: async () => false, remove: async () => true },
        tabs: { query: async () => [{ id: 1, url: tabUrl }], create: async () => ({}), update: async () => ({}) },
        windows: { update: async () => ({}) },
        extension: { isAllowedIncognitoAccess: (cb) => cb(false) },
    };
    win.eval(fs.readFileSync(path.join(DIST, "popup.js"), "utf8"));
    const flush = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 10)); };
    await flush();
    return { win, doc: win.document, syncStore, sent, flush };
}

// --- the self-approval list is edited in DevTools Settings only ---

test("popup: there is no self-approval editor, and nothing the popup does at load writes the old sync whitelist", async () => {
    const p = await loadPopup();
    for (const id of ["permDomain", "permAdd", "permList", "permUncovered"]) assert.equal(p.doc.getElementById(id), null, id);
    assert.doesNotMatch(p.doc.body.textContent, /Trusted domains/);
    assert.equal("pageApprovalDomains" in p.syncStore, false);
    assert.ok(!p.sent.some((m) => m.type === "SITE_ACCESS" && m.payload?.edit?.op === "selfApprove"), "the popup never edits the self-approval list");
});

// --- "This site": the agents line ---

/** [decision, levels, implied, the state line, the agents line or null when it is hidden]. */
const CASES = [
    ["always", { use: "always", agents: "off", selfApprove: false }, false, "is allowed to use window.ml.", "Agents: it may not start agents."],
    ["always", { use: "always", agents: "ask", selfApprove: false }, false, "is allowed to use window.ml.", "Agents: it may start agents, and each start asks you."],
    ["session", { use: "session", agents: "always", selfApprove: false }, false, "is allowed to use window.ml until the browser restarts.", "Agents: it starts agents without asking."],
    ["always", { use: "always", agents: "denied", selfApprove: false }, false, "is allowed to use window.ml.", "Agents: denied. It cannot ask again."],
    ["always", { use: "always", agents: "always", selfApprove: true }, true, "is allowed, and approves its own actions (DevTools Settings → Permissions).", "Agents: it approves its own actions (DevTools Settings → Permissions)."],
    ["denied", { use: "denied", agents: "off", selfApprove: false }, false, "is denied: its calls are refused.", null],
    ["unknown", { use: "unknown", agents: "off", selfApprove: false }, false, "is not allowed to use window.ml. Its calls are refused.", null],
];

test("popup: This site shows the agent level on its own line, hidden while the site itself is not allowed", async () => {
    for (const [decision, levels, implied, state, agents] of CASES) {
        const p = await loadPopup({ site: { decision, levels, ...(implied ? { implied } : {}) } });
        const label = `${decision}/${levels.agents}/${levels.selfApprove}`;
        assert.equal(p.doc.getElementById("siteAccess").hidden, false, label);
        assert.equal(p.doc.getElementById("siteOrigin").textContent, "https://site.example", label);
        assert.equal(p.doc.getElementById("siteState").textContent, state, label);
        const line = p.doc.getElementById("siteAgents");
        assert.equal(line.hidden, agents === null, `${label}: hidden`);
        if (agents) assert.equal(line.textContent, agents, label);
        // Revoke takes every grant away, self-approval included, so an approval it implies is revocable here too.
        if (implied) assert.equal(p.doc.getElementById("siteRevoke").hidden, false, label);
    }
});

test("popup: no user-facing line in This site uses an em-dash", async () => {
    for (const [decision, levels, implied] of CASES) {
        const p = await loadPopup({ site: { decision, levels, ...(implied ? { implied } : {}) } });
        assert.doesNotMatch(p.doc.getElementById("siteAccess").textContent, /—/);
    }
});
