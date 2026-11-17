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

// --- OPEN_CHAT_PAGE through the relay, and with a forged URL in the payload ---
//
// The rows above pin a page sender with an address, and that the URL is `chat.html` plus a resolved address's hash.
// These two add the shapes left open: EVERY page-started type and HANDLE_MAP request, and a payload that names a URL,
// a hash and a tab of its own — the opened URL must still be ours, built from a parsed address and nothing else.
//
// MEASURED AT 14a5f228: green (8/8), each mutation applied alone with `node build.mjs`, then reverted and re-run green.
// (i) The router admitting a sender with `tab` set (the card's shape) as well as `isExtensionSender` reds row 1: the
// page's OPEN_CHAT_PAGE is answered instead of refused, and the lane's "OPEN_CHAT_PAGE is no page's" row with it.
// (ii) The hash taken from `message.payload.url` when `address` is absent reds row 2 on "a payload's url or hash was
// used as the page's".

const CHAT_PAGE = "chrome-extension://test/chat.html";
const FORGED_PAGE = `${CHAT_PAGE}#/setting/apiKey`;
/** The HUD card's sender: our iframe in a page tab, so `tab` is set and `url` is ours. */
const CARD = { url: "chrome-extension://test/sidebar.html", tab: { id: 9 }, frameId: 3 };

test("no page-started type or relayed HANDLE_MAP shape opens the chat page or Settings, whatever its payload names", async () => {
    const { HANDLE_MAP, PAGE_STARTED_TYPES } = require("../src/page-relay.ts");
    const bg = loadBackground({ config: {} });
    const page = { url: "https://evil.example/", origin: "https://evil.example", tab: { id: 9, url: "https://evil.example/" }, frameId: 0 };
    const payload = { address: "settings/extension/backup", url: FORGED_PAGE, href: FORGED_PAGE, hash: "#/setting/apiKey", tabId: 7, windowId: 3 };
    const shapes = [
        { type: "OPEN_CHAT_PAGE", payload }, { type: "OPEN_CHAT_PAGE", requestId: "r1", payload },
        ...[...PAGE_STARTED_TYPES].flatMap((t) => [{ type: t, payload }, { type: t, requestId: "r1", payload }]),
        ...Object.entries(HANDLE_MAP).flatMap(([k, v]) => [{ type: k, requestId: "r1", payload }, { type: v.type, requestId: "r1", payload }]),
    ];
    assert.ok(shapes.length > 40, "positive control: the page's whole reachable surface is enumerated");
    const answers = [];
    for (const m of shapes) {
        try { answers.push(await Promise.race([bg.send(m, page), new Promise((r) => setTimeout(() => r(undefined), 5))])); }
        catch (e) { answers.push({ threw: String(e?.message || e) }); }
    }
    assert.deepEqual(answers.filter((_, i) => shapes[i].type === "OPEN_CHAT_PAGE"), [{ error: "refused" }, { error: "refused" }],
        "a page's OPEN_CHAT_PAGE was not refused");
    assert.deepEqual(bg.tabsCreated.filter((t) => String(t.url).startsWith(CHAT_PAGE)), [], "a page's shape opened the chat page");
    assert.deepEqual(bg.tabsUpdated.filter(([, p]) => String(p?.url ?? "").startsWith(CHAT_PAGE)), [], "a page's shape moved the chat page");
    assert.equal(JSON.stringify([...bg.tabsCreated, ...bg.tabsUpdated, ...bg.windowsUpdated, ...answers]).includes("settings/extension/backup"), false,
        "a page's payload reached a tab or an answer");
    // Control: the same instruments see the card's own request open the page at the address's view.
    assert.deepEqual(await bg.send({ type: "OPEN_CHAT_PAGE", payload: { address: "settings/extension/backup" } }, CARD), { data: true });
    assert.deepEqual(bg.tabsCreated.map((t) => t.url).filter((u) => String(u).startsWith(CHAT_PAGE)), [`${CHAT_PAGE}#/settings/extension/backup`]);
});

test("the opened URL is chat.html plus a parsed address's hash: no url, hash or tab id the sender names reaches it", async () => {
    const bg = loadBackground({ config: {}, extensionTabs: [{ tabId: 7, windowId: 3, documentUrl: `${CHAT_PAGE}#/s/local:abc` }] });
    const forged = { url: "https://evil.example/x", href: FORGED_PAGE, hash: "#/setting/apiKey", address: "settings/extension/backup", tabId: 99, windowId: 99 };
    assert.deepEqual(await bg.send({ type: "OPEN_CHAT_PAGE", payload: forged }, CARD), { data: true });
    assert.deepEqual(bg.tabsUpdated, [[7, { active: true, url: `${CHAT_PAGE}#/settings/extension/backup` }]], "the open page was not sent to the address's hash");
    // No address at all: the page as it opens, whatever `url`/`hash` the payload names.
    assert.deepEqual(await bg.send({ type: "OPEN_CHAT_PAGE", payload: { url: FORGED_PAGE, hash: "#/setting/apiKey" } }, { url: "chrome-extension://test/popup.html" }), { data: true });
    assert.deepEqual(bg.tabsUpdated.slice(1), [[7, { active: true }]], "a payload's url or hash was used as the page's");
    // Addresses that LOOK like our URL, like a hash, or are not strings are not addresses a link resolves.
    for (const address of [FORGED_PAGE, "chat.html#/setting/apiKey", "#/setting/apiKey", "chrome-extension://test/chat.html",
        "//evil.example/setting/apiKey", { toString: () => "settings/extension/backup" }, new String("settings/extension/backup")])
        assert.deepEqual(await bg.send({ type: "OPEN_CHAT_PAGE", payload: { address } }, CARD), { error: "refused" }, String(address));
    assert.equal(bg.tabsUpdated.length, 2, "a refused address moved the page");
    const call = JSON.stringify([...bg.tabsCreated, ...bg.tabsUpdated, ...bg.windowsUpdated]);
    assert.equal(call.includes("evil.example"), false, "a payload's url reached a tab");
    assert.equal(call.includes("99"), false, "a payload's tab or window id reached a tab call");
});
