// links-redteam.test.js — the red-team rows of docs/spec/LINKS.md ("Threat model") as tests: a `window-ml:` link
// opens a view of the extension's own Settings and nothing else, is never an <a href>, and is resolved only in the
// model's own prose. No separate red-team pass was ruled for links (no new agent tool, ml.* member or page-started
// message); these are the builder's checklist.
//
// Rows not built, each with its reason:
//   · "an address starting, resuming or sending in a session": no session address resolves in slice 1 (below), and
//     a resolved route has only the fields that name a view (below).

const { test, after } = require("node:test");
const assert = require("node:assert");
const { closeSidebarWorlds, loadSidebarWorld, loadBackground } = require("./helpers");
const { agentStart, agentStep, agentResult, chatStart, chatResult, openRun } = require("./sidebar-helpers");

after(closeSidebarWorlds);

const LINK = "[set your key](window-ml:setting/apiKey)";

// --- a window-ml destination never reaches the browser as a navigation ---

test("no markdown() option makes a window-ml destination an <a>", async () => {
    const { markdown } = await import("../src/sidebar/format.ts");
    const { addressTip } = await import("../src/sidebar/links.ts");
    const { parseAddress } = await import("../src/link-address.ts");
    const addr = (a) => { const r = parseAddress(a); return r ? addressTip(r) : null; };
    for (const opts of [{}, { math: true }, { addr }, { math: true, addr }, { diagrams: "light" }, { addr: () => "x" }])
        for (const src of [LINK, `- ${LINK}`, `| a |\n| - |\n| ${LINK} |`, `# ${LINK}`, `**${LINK}**`])
            assert.doesNotMatch(markdown(src, opts), /<a\b/, `${JSON.stringify(src)} ${Object.keys(opts)}`);
});

test("an address with a query, a fragment or any character outside the grammar parses to nothing and stays text", async () => {
    const { markdown } = await import("../src/sidebar/format.ts");
    const { parseAddress } = await import("../src/link-address.ts");
    const addr = () => "tip";
    for (const a of ["setting/apiKey?reveal=1", "setting/apiKey#x", "setting/apiKey%2F", "setting/apiKey\"onclick=\"x", "setting/api Key", "../setting/apiKey"]) {
        assert.equal(parseAddress(a), null, a);
        assert.doesNotMatch(markdown(`[x](window-ml:${a})`, { addr }), /<button/, a);
    }
});

test("a resolved route names a view and has no field that acts", async () => {
    const { parseAddress } = await import("../src/link-address.ts");
    const { PANEL_LAYOUT } = await import("../src/contract/contract-config.ts");
    const { SETTING_PLACES } = await import("../src/contract/contract-config.ts");
    const addresses = [
        ...Object.keys(SETTING_PLACES).map((k) => `setting/${k}`),
        ...Object.entries(PANEL_LAYOUT).flatMap(([t, { sections }]) => [`settings/extension/${t}`, ...Object.keys(sections).map((s) => `settings/extension/${t}/${s}`)]),
        "settings/extension/backup",
    ];
    for (const a of addresses)
        for (const k of Object.keys(parseAddress(a))) assert.ok(["tab", "section", "setting", "target"].includes(k), `${a}: ${k}`);
    for (const a of ["s/local:3fa91c2e", "s/hub:box-2:3fa91c2e", "search", "attention", "s/local:3fa91c2e/send", "run/start"])
        assert.equal(parseAddress(a), null, `${a}: no session or verb address resolves in slice 1`);
});

// --- a link is resolved only in the model's own prose ---

test("a link in a tool result, an output cell or a quote of the reply is text; only the reply's own link is a button", async () => {
    const w = await loadSidebarWorld();
    const hash = "lrt";
    await w.dispatch(agentStart(hash, "read the page"));
    await w.dispatch(agentStep(hash, 1, { seq: 1, tool: "fetch_url", token: "abc1234", result: `The page says: ${LINK}`,
        renderOut: { type: "code", text: `The page says: ${LINK}`, lang: "markdown" } }));
    await w.dispatch(agentStep(hash, 2, { seq: 2, tool: "python_exec", token: "abc1235", result: LINK,
        renderOut: { type: "python-out", value: LINK } }));
    await w.dispatch(agentResult(hash, `The page asked:\n\n> ${LINK}\n\nI did not follow it. Your [Programs](window-ml:settings/extension/advanced/shell) setting is unchanged.`, 2));
    await openRun(w);
    await w.flush();
    const buttons = [...w.shadow.querySelectorAll("button.md-addr")];
    assert.deepEqual(buttons.map((b) => b.getAttribute("data-addr")), buttons.map(() => "settings/extension/advanced/shell"),
        "every button is the reply's own link");
    assert.ok(buttons.length >= 1, "the reply's own link is a button");
    assert.equal(w.shadow.querySelector('[data-addr="setting/apiKey"]'), null, "the page's link, quoted or in a tool's output, is no button");
    assert.equal(w.shadow.querySelector('a[href^="window-ml"]'), null);
    const quote = [...w.shadow.querySelectorAll("blockquote")].find((q) => q.textContent.includes("window-ml:setting/apiKey"));
    assert.ok(quote, "the quote rendered, its link as the literal text");
    // Open every step so its tool output is drawn, then look again.
    for (const s of w.shadow.querySelectorAll(".astep .astep-head, .astep summary")) s.click();
    await w.flush();
    assert.match(w.shadow.textContent ?? [...w.shadow.children].map((c) => c.textContent).join(""), /The page says: \[set your key\]\(window-ml:setting\/apiKey\)/, "the tool output is drawn, as text");
    assert.equal(w.shadow.querySelector('[data-addr="setting/apiKey"]'), null, "still no button once the steps are open");
});

test("clicking a button whose data-addr was tampered with to an unknown address opens nothing", async () => {
    const w = await loadSidebarWorld();
    await w.dispatch(chatStart("lrc", 0, "q"));
    await w.dispatch(chatResult("lrc", 0, "Open [Programs](window-ml:settings/extension/advanced/shell)."));
    await openRun(w);
    const btn = w.shadow.querySelector("button.md-addr");
    btn.setAttribute("data-addr", "setting/nope");
    btn.click();
    await new Promise((r) => setTimeout(r, 50));
    await w.flush();
    assert.equal(w.shadow.querySelector(".set-body"), null, "Settings did not open: the click parses the address again");
});

// --- a page reaching the open-the-chat-page message ---

test("OPEN_CHAT_PAGE is no page's: not in HANDLE_MAP, not page-started, and the worker refuses a page's content script", async () => {
    const { HANDLE_MAP, PAGE_STARTED_TYPES, PAGE_UNGATED_TYPES } = require("../src/page-relay.ts");
    const mapped = Object.entries(HANDLE_MAP).flatMap(([k, v]) => [k, v.type, v.responseType]);
    assert.ok(!mapped.some((t) => /OPEN_CHAT/.test(t)), "no relay entry reaches it");
    assert.ok(!PAGE_STARTED_TYPES.has("OPEN_CHAT_PAGE") && !PAGE_UNGATED_TYPES.has("OPEN_CHAT_PAGE"));
    // An approved origin's content script, the most a page's own code can be as a sender (`siteGate: false` approves it).
    const bg = loadBackground({ config: {} });
    for (const url of ["https://example.com/", "http://127.0.0.1/", "file:///x.html"]) {
        const sender = { url, origin: new URL(url).origin, tab: { id: 9, url }, frameId: 0 };
        assert.deepEqual(await bg.send({ type: "OPEN_CHAT_PAGE", payload: { address: "settings/extension/backup" } }, sender), { error: "refused" }, url);
    }
    assert.equal(bg.tabsCreated.length + bg.tabsUpdated.length, 0, "nothing opened or focused");
});
