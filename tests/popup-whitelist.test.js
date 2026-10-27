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
async function loadPopup({ tabUrl = "https://site.example/page", site = { decision: "unknown" }, startAsks = () => ({ asks: [] }), accessRequests = () => ({ requests: [] }) } = {}) {
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
                    : msg?.type === "ACCESS_REQUESTS" ? { data: accessRequests(msg.payload) }
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

// --- "Waiting for you": sites asking for access (ml.requestAccess) ---

/** A waiting request as ACCESS_REQUESTS lists one. */
const req = (o) => ({ domain: "site.example", agents: false, at: Date.now() - 60000, state: "pending", asks: 1, allowed: false, ...o });
/** The decisions the popup sent, in order. */
const decisions = (p) => p.sent.filter((m) => m.type === "ACCESS_REQUESTS" && m.payload?.decision).map((m) => m.payload);

test("popup: a site asking for access is a row above the start asks; its reason is quoted as text, and asking for agents is an unticked box", async () => {
    const r = req({ origin: "https://asker.example", kind: "access", agents: true, reason: "<b>trust me</b>" });
    const p = await loadPopup({ accessRequests: () => ({ requests: [r] }), startAsks: () => ({ asks: [{ requestId: "q1", origin: "https://site.example", since: 1 }] }) });
    assert.equal(p.doc.getElementById("waiting").hidden, false);
    const rows = [...p.doc.querySelectorAll("#waitingList > div")].map((d) => d.className);
    assert.deepEqual(rows, ["req-row", "wait-row"], "the request first, then the start ask");
    const row = p.doc.querySelector(".req-row");
    assert.equal(row.querySelector(".hint").textContent, "https://asker.example asks to use window.ml and to start agents.");
    assert.equal(row.querySelector(".site-says").textContent, "The site says: “<b>trust me</b>”");
    assert.equal(row.querySelector(".site-says b"), null, "the site's words never become markup");
    const box = row.querySelector(".req-check input");
    assert.equal(box.checked, false);
    assert.deepEqual([...row.querySelectorAll(".req-buttons button")].map((b) => b.textContent), ["Allow this session", "Always allow", "Deny"]);
});

test("popup: Allow this session, Always allow (with the agents box) and Deny each send that decision for the request's origin", async () => {
    const r = req({ origin: "https://asker.example", kind: "access", agents: true });
    const click = async (text, tick = false) => {
        const p = await loadPopup({ accessRequests: (pl) => ({ requests: pl.decision ? [] : [r] }) });
        if (tick) p.doc.querySelector(".req-check input").checked = true;
        [...p.doc.querySelectorAll(".req-buttons button")].find((b) => b.textContent === text).click();
        await p.flush();
        assert.equal(p.doc.getElementById("waiting").hidden, true, `${text}: answered, the block empties`);
        return decisions(p);
    };
    assert.deepEqual(await click("Allow this session"), [{ origin: "https://asker.example", decision: { kind: "access", answer: "session", agents: false } }]);
    assert.deepEqual(await click("Always allow", true), [{ origin: "https://asker.example", decision: { kind: "access", answer: "always", agents: true } }]);
    assert.deepEqual(await click("Deny"), [{ origin: "https://asker.example", decision: { kind: "access", answer: "deny" } }]);
});

test("popup: a site already allowed that asks for agents gets Let it start agents and Deny, with no box", async () => {
    const r = req({ origin: "https://asker.example", kind: "access", agents: true, allowed: true });
    const p = await loadPopup({ accessRequests: (pl) => ({ requests: pl.decision ? [] : [r] }) });
    assert.equal(p.doc.querySelector(".req-check"), null);
    assert.deepEqual([...p.doc.querySelectorAll(".req-buttons button")].map((b) => b.textContent), ["Let it start agents", "Deny"]);
    p.doc.querySelector(".req-buttons button").click();
    await p.flush();
    assert.deepEqual(decisions(p), [{ origin: "https://asker.example", decision: { kind: "access", answer: "agents" } }]);
});

test("popup: self-approval is never one click: Review… opens the confirmation, whose Allow is disabled for a second", async () => {
    const r = req({ origin: "https://asker.example", kind: "selfApprove", reason: "my own tool" });
    const p = await loadPopup({ accessRequests: (pl) => ({ requests: pl.decision ? [] : [r] }) });
    const dlg = p.doc.getElementById("selfApproveDialog");
    assert.equal(dlg.hidden, true);
    assert.equal(p.doc.querySelector(".req-row .hint").textContent, "https://asker.example asks to approve its own actions.");
    assert.deepEqual([...p.doc.querySelectorAll(".req-buttons button")].map((b) => b.textContent), ["Review…"]);
    p.doc.querySelector(".req-buttons button").click();
    assert.equal(dlg.hidden, false);
    assert.equal(p.doc.getElementById("selfApproveOrigin").textContent, "https://asker.example wants to approve its own actions.");
    assert.equal(p.doc.getElementById("selfApproveSays").textContent, "The site says: “my own tool”");
    const allow = p.doc.getElementById("selfApproveAllow");
    assert.equal(allow.disabled, true, "Allow is disabled as the dialog opens");
    assert.deepEqual(decisions(p), [], "opening the confirmation decides nothing");
    await new Promise((res) => setTimeout(res, 1100));
    assert.equal(allow.disabled, false);
    allow.click();
    await p.flush();
    assert.equal(dlg.hidden, true);
    assert.deepEqual(decisions(p), [{ origin: "https://asker.example", decision: { kind: "selfApprove", answer: "allow" } }]);

    const q = await loadPopup({ accessRequests: (pl) => ({ requests: pl.decision ? [] : [r] }) });
    q.doc.querySelector(".req-buttons button").click();
    q.doc.getElementById("selfApproveDeny").click();
    await q.flush();
    assert.deepEqual(decisions(q), [{ origin: "https://asker.example", decision: { kind: "selfApprove", answer: "deny" } }]);
});

// --- "This site": presence (docs/spec/SITE_PRESENCE.md): Let it ask / Hide window.ml ---

const LV = { use: "unknown", agents: "off", selfApprove: false };
const ASK_LINE = "can see window.ml and ask for access, but cannot use it.";
const visibleButton = (p, id) => { const b = p.doc.getElementById(id); return b.hidden ? null : b.textContent; };
const visibleEdits = (p) => p.sent.filter((m) => m.type === "SITE_ACCESS" && m.payload?.edit).map((m) => m.payload.edit);

test("popup: Let it ask is offered for an unknown origin that sees nothing, and only then", async () => {
    const hidden = await loadPopup({ site: { decision: "unknown", levels: LV, presence: "hidden" } });
    assert.equal(visibleButton(hidden, "siteLetAsk"), "Let it ask");
    assert.equal(hidden.doc.getElementById("siteLetAsk").title, "The site sees that window.ml is here, and may ask you for access after you click on it.");
    assert.equal(visibleButton(hidden, "siteHide"), null);
    for (const [decision, levels, presence] of [["always", { ...LV, use: "always" }, "full"], ["session", { ...LV, use: "session" }, "full"], ["denied", { ...LV, use: "denied" }, "hidden"]]) {
        const p = await loadPopup({ site: { decision, levels, presence } });
        assert.equal(visibleButton(p, "siteLetAsk"), null, decision);
        assert.equal(visibleButton(p, "siteHide"), null, decision);
    }
    hidden.doc.getElementById("siteLetAsk").click();
    await hidden.flush();
    assert.deepEqual(visibleEdits(hidden), [{ op: "visible", origin: "https://site.example", on: true }]);
});

test("popup: a marked origin shows the ask line and Hide window.ml, which sends on:false", async () => {
    const lists = { always: [], session: [], denied: [], agents: {}, selfApprove: [], visible: ["https://site.example"] };
    const p = await loadPopup({ site: { decision: "unknown", levels: LV, presence: "ask", lists } });
    assert.equal(p.doc.getElementById("siteOrigin").textContent, "https://site.example");
    assert.equal(p.doc.getElementById("siteState").textContent, ASK_LINE);
    assert.equal(visibleButton(p, "siteLetAsk"), null);
    assert.equal(visibleButton(p, "siteHide"), "Hide window.ml");
    assert.equal(p.doc.getElementById("siteHide").title, "The site sees nothing of window.ml again.");
    p.doc.getElementById("siteHide").click();
    await p.flush();
    assert.deepEqual(visibleEdits(p), [{ op: "visible", origin: "https://site.example", on: false }]);
    assert.doesNotMatch(p.doc.getElementById("siteAccess").textContent, /—/);
});

test("popup: an ask that comes from Let sites ask for access (not marked) shows the line and no Hide window.ml", async () => {
    const p = await loadPopup({ site: { decision: "unknown", levels: LV, presence: "ask" } });
    assert.equal(p.doc.getElementById("siteState").textContent, ASK_LINE);
    assert.equal(visibleButton(p, "siteHide"), null);
    assert.equal(visibleButton(p, "siteLetAsk"), null, "it already asks");
});
