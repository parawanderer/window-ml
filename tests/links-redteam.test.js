// links-redteam.test.js — the red-team rows of docs/spec/LINKS.md ("Threat model") as tests: a `window-ml:` link
// opens a view of the extension's own Settings and nothing else, is never an <a href>, and is resolved only in the
// model's own prose. No separate red-team pass was ruled for links (no new agent tool, ml.* member or page-started
// message); these are the builder's checklist.
//
// Rows not built in slice 1, each with its reason:
//   · "a page reaching the open-the-chat-page message": slice 1 adds no message. Session, search and attention
//     addresses are not resolved by the sidebar yet (parseAddress returns null for them, tested below), so there is
//     no message to reach. The row lands with the slice that adds that message.
//   · "an address starting, resuming or sending in a session": no session address resolves in slice 1 (below), and
//     a resolved route has only the fields that name a view (below).

const { test, after } = require("node:test");
const assert = require("node:assert");
const { closeSidebarWorlds, loadSidebarWorld } = require("./helpers");
const { agentStart, agentStep, agentResult, chatStart, chatResult, openRun } = require("./sidebar-helpers");

after(closeSidebarWorlds);

const LINK = "[set your key](window-ml:setting/apiKey)";

// --- a window-ml destination never reaches the browser as a navigation ---

test("no markdown() option makes a window-ml destination an <a>", async () => {
    const { markdown } = await import("../src/sidebar/format.ts");
    const { parseAddress, addressTip } = await import("../src/sidebar/links.ts");
    const addr = (a) => { const r = parseAddress(a); return r ? addressTip(r) : null; };
    for (const opts of [{}, { math: true }, { addr }, { math: true, addr }, { diagrams: "light" }, { addr: () => "x" }])
        for (const src of [LINK, `- ${LINK}`, `| a |\n| - |\n| ${LINK} |`, `# ${LINK}`, `**${LINK}**`])
            assert.doesNotMatch(markdown(src, opts), /<a\b/, `${JSON.stringify(src)} ${Object.keys(opts)}`);
});

test("an address with a query, a fragment or any character outside the grammar parses to nothing and stays text", async () => {
    const { markdown } = await import("../src/sidebar/format.ts");
    const { parseAddress } = await import("../src/sidebar/links.ts");
    const addr = () => "tip";
    for (const a of ["setting/apiKey?reveal=1", "setting/apiKey#x", "setting/apiKey%2F", "setting/apiKey\"onclick=\"x", "setting/api Key", "../setting/apiKey"]) {
        assert.equal(parseAddress(a), null, a);
        assert.doesNotMatch(markdown(`[x](window-ml:${a})`, { addr }), /<button/, a);
    }
});

test("a resolved route names a view and has no field that acts", async () => {
    const { parseAddress } = await import("../src/sidebar/links.ts");
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
