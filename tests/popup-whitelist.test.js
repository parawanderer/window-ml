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
 * @param {{ tabUrl?: string, site?: object, startAsks?: (payload: object) => object }} opts the current tab's URL, the
 *   worker's SITE_ACCESS answer for its origin, and its START_ASKS answer (`data`) for a payload (default: nothing waits)
 * @returns the window, the document, the sync store, what the popup sent, whether it closed, and a flush
 */
async function loadPopup({ tabUrl = "https://site.example/page", site = { decision: "unknown" }, startAsks = () => ({ asks: [] }) } = {}) {
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
                const reply = msg?.type === "SITE_ACCESS" ? { data: { lists: { always: [], session: [], denied: [], agents: {}, selfApprove: [] }, origin: msg.payload?.origin, ...site } }
                    : msg?.type === "START_ASKS" ? { data: startAsks(msg.payload) }
                    : { error: "not in this test" };
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
    const closed = { value: false };
    win.close = () => { closed.value = true; };
    win.eval(fs.readFileSync(path.join(DIST, "popup.js"), "utf8"));
    const flush = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 10)); };
    await flush();
    return { win, doc: win.document, syncStore, sent, closed, flush };
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

// --- "This site": the agents buttons (slice 3 PR 3) ---

/** The buttons each agent level offers, and the level each one sets (SITE_ACCESS_SLICE3.md 1.3). */
const AGENT_BUTTONS = {
    off: [["Let it start agents", "ask"]],
    ask: [["Always allow agents", "always"], ["No agents", "off"]],
    always: [["Ask each time", "ask"], ["No agents", "off"]],
    denied: [["Stop denying", "off"]],
};
const buttonsOf = (p) => [...p.doc.querySelectorAll("#siteAgentButtons button")].map((b) => b.textContent);

test("popup: each agent level offers its buttons, and each sends the agents edit for this origin with the level it names", async () => {
    for (const [decision, levels, implied, , agents] of CASES) {
        const label = `${decision}/${levels.agents}/${levels.selfApprove}`;
        const p = await loadPopup({ site: { decision, levels, ...(implied ? { implied } : {}) } });
        const row = p.doc.getElementById("siteAgentButtons");
        // Hidden with the agents line (the site may not use window.ml), and while the site approves its own actions.
        if (agents === null || levels.selfApprove) {
            assert.equal(row.hidden, true, `${label}: hidden`);
            assert.deepEqual(buttonsOf(p), [], `${label}: no buttons`);
            continue;
        }
        assert.equal(row.hidden, false, label);
        assert.deepEqual(buttonsOf(p), AGENT_BUTTONS[levels.agents].map(([t]) => t), label);
        for (const [text, level] of AGENT_BUTTONS[levels.agents]) {
            const q = await loadPopup({ site: { decision, levels } });
            [...q.doc.querySelectorAll("#siteAgentButtons button")].find((b) => b.textContent === text).click();
            await q.flush();
            const edits = q.sent.filter((m) => m.type === "SITE_ACCESS" && m.payload?.edit).map((m) => m.payload.edit);
            assert.deepEqual(edits, [{ op: "agents", origin: "https://site.example", level }], `${label}: ${text}`);
        }
    }
});

// --- "Waiting for you": this tab's start asks ---

test("popup: nothing waiting hides the block; each start ask on this tab is a row naming the origin, asked for this tab", async () => {
    const empty = await loadPopup({ site: { decision: "always", levels: { use: "always", agents: "ask", selfApprove: false } } });
    assert.equal(empty.doc.getElementById("waiting").hidden, true);
    assert.deepEqual(empty.sent.filter((m) => m.type === "START_ASKS").map((m) => m.payload), [{ tabId: 1 }]);

    const asks = [{ requestId: "q1", origin: "https://site.example", since: 1 }, { requestId: "q2", origin: "https://other.example", since: 2 }];
    const p = await loadPopup({ startAsks: () => ({ asks }) });
    assert.equal(p.doc.getElementById("waiting").hidden, false);
    const rows = [...p.doc.querySelectorAll("#waitingList .wait-row")];
    assert.deepEqual(rows.map((r) => r.querySelector(".hint").textContent), [
        "An agent start from https://site.example is waiting on this tab.",
        "An agent start from https://other.example is waiting on this tab.",
    ]);
    assert.deepEqual(rows.map((r) => r.querySelector("code").textContent), ["https://site.example", "https://other.example"]);
    for (const r of rows) assert.equal(r.querySelector("button").textContent, "Show");
    assert.doesNotMatch(p.doc.getElementById("waiting").textContent, /—/);
});

test("popup: Show asks the worker to show that ask on this tab; the popup closes when it did, and redraws when the ask is gone", async () => {
    const ask = { requestId: "q1", origin: "https://site.example", since: 1 };
    const shown = await loadPopup({ startAsks: (pl) => (pl.show ? { asks: [ask], shown: true } : { asks: [ask] }) });
    shown.doc.querySelector("#waitingList button").click();
    await shown.flush();
    assert.deepEqual(shown.sent.filter((m) => m.type === "START_ASKS").map((m) => m.payload), [{ tabId: 1 }, { tabId: 1, show: "q1" }]);
    assert.equal(shown.closed.value, true);

    // Answered or expired between the popup opening and the click: nothing shows, the block empties, the popup stays.
    const gone = await loadPopup({ startAsks: (pl) => (pl.show ? { asks: [], shown: false } : { asks: [ask] }) });
    gone.doc.querySelector("#waitingList button").click();
    await gone.flush();
    assert.equal(gone.closed.value, false);
    assert.equal(gone.doc.getElementById("waiting").hidden, true);
});
