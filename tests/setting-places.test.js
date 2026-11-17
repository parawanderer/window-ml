// setting-places.test.js — where each setting is in the DevTools Settings panel (SETTING_PLACES, contract-config.ts),
// checked against the panel as it renders, and a `window-ml:setting/<key>` link in a reply opening that row
// (docs/spec/LINKS.md).

const { test, after } = require("node:test");
const assert = require("node:assert");
const { closeSidebarWorlds, loadSidebarWorld } = require("./helpers");
const { openSettings, chatStart, chatResult, agentStart, agentResult } = require("./sidebar-helpers");

after(closeSidebarWorlds);

const SITE_LISTS = { always: [], session: [], denied: [], agents: {}, selfApprove: [] };
const TABS = ["connection", "models", "appearance", "advanced", "permissions"];

/** Open Settings and draw one tab after another, collecting what each one renders. */
async function renderPanel() {
    const w = await loadSidebarWorld({ siteLists: SITE_LISTS });
    // The two Permissions sections that draw from the worker's answer: the host permissions and the policy store.
    w.window.chrome.permissions = { ...(w.window.chrome.permissions || {}), contains: (_q, cb) => { cb?.(true); return Promise.resolve(true); }, getAll: (cb) => { cb?.({ origins: [] }); return Promise.resolve({ origins: [] }); } };
    const send = w.window.chrome.runtime.sendMessage;
    w.window.chrome.runtime.sendMessage = (msg, cb) => msg?.type === "POLICIES"
        ? cb?.({ data: { global: [], runs: [], builtin: { label: "", source: "" }, broken: {} } })
        : send(msg, cb);
    await openSettings(w);
    const tabs = {};
    for (const id of TABS) {
        const btn = [...w.shadow.querySelectorAll(".set-tab")].find((b) => b.textContent.trim().toLowerCase() === id);
        btn.click();
        await w.flush();
        await new Promise((r) => setTimeout(r, 50));
        await w.flush();
        const body = w.shadow.querySelector(".set-body");
        tabs[id] = {
            sections: Object.fromEntries([...body.querySelectorAll("[data-section]")]
                .map((s) => [s.getAttribute("data-section"), s.querySelector(".set-group").textContent.trim()])),
            rows: [...body.querySelectorAll("[data-setting]")].flatMap((el) => el.getAttribute("data-setting").split(" ")
                .map((key) => ({ key, section: el.closest("[data-section]")?.getAttribute("data-section") }))),
            // Each row's own text and tooltip pops (a Section's `data-setting` lists keys it has no row for, so it is skipped).
            labelled: [...body.querySelectorAll("[data-setting]:not([data-section])")].map((el) => ({
                key: el.getAttribute("data-setting"), text: el.textContent, pops: [...el.querySelectorAll(".tt-pop")].map((p) => p.textContent) })),
            unmarked: [...body.querySelectorAll("input, select, textarea")].filter((c) => !c.closest("[data-setting]"))
                .map((c) => `${c.closest("[data-section]")?.getAttribute("data-section")}: ${(c.closest(".set-field, .set-check, label")?.textContent || c.placeholder || "").trim().slice(0, 40)}`),
        };
    }
    return { w, tabs };
}

// Controls that edit something other than a `DEFAULT_CONFIG` key: display preferences in local storage
// (sidebar/store.ts), the backup's own form, and the permission lists' add and filter boxes. A new control
// fails here until it is either given its key's `data-setting` or listed as not a setting.
const NOT_SETTINGS = [
    /^storage: (Encrypted|Compressed SQLite|Plain SQLite)/,
    /^codeblocks: (Colour theme|Long lines|Tool output height|Timestamp streamed|Show line numbers)/,
    /^runstats: Show (cumulative tokens|generation speed)/,
    /^siteapprovals: Filter sites, or type one to allow/,
    /^hostaccess: Filter sites, or type a hostname to add/,
    /^whitelist: https:\/\/example\.com$/,
    /^policies: (Label)?$/,
];

// --- the setting-place table against DEFAULT_CONFIG and the rendered panel ---

test("every DEFAULT_CONFIG key with a row has its place in SETTING_PLACES, and every place's row carries the key", async () => {
    const { DEFAULT_CONFIG, SETTING_PLACES } = await import("../src/contract/contract-config.ts");
    const { tabs } = await renderPanel();
    const rendered = {};
    for (const [tab, t] of Object.entries(tabs))
        for (const r of t.rows) {
            assert.equal(rendered[r.key], undefined, `${r.key} has two rows (${rendered[r.key]?.tab} and ${tab})`);
            rendered[r.key] = r.section ? { tab, section: r.section } : { tab };
        }
    for (const key of Object.keys(DEFAULT_CONFIG)) {
        if (rendered[key]) assert.deepEqual(SETTING_PLACES[key], rendered[key], `${key}: its row is at ${JSON.stringify(rendered[key])}, the table says ${JSON.stringify(SETTING_PLACES[key])}`);
        else assert.equal(SETTING_PLACES[key], undefined, `${key} has a place but no row carries data-setting="${key}"`);
    }
    for (const key of Object.keys(SETTING_PLACES)) assert.ok(key in DEFAULT_CONFIG, `${key} is placed but is not a config key`);
    const unplaced = Object.keys(DEFAULT_CONFIG).filter((k) => !SETTING_PLACES[k]);
    // ocrNumCtx has no control; pageApprovalDomains is the legacy sync list, migrated once into the local list of
    // origins that "Sites that approve their own actions" edits (site-access.ts), so no row edits that key.
    assert.deepEqual(unplaced, ["ocrNumCtx", "pageApprovalDomains"], "only a key with no control in the panel goes without a place");
});

test("ocrNumCtx has no control in the panel, so it has no place and its link renders as its label", async () => {
    const { SETTING_PLACES } = await import("../src/contract/contract-config.ts");
    const { parseAddress } = await import("../src/link-address.ts");
    assert.equal(SETTING_PLACES.ocrNumCtx, undefined);
    assert.equal(parseAddress("setting/ocrNumCtx"), null);
});

test("every control in the panel is a setting's row or is listed as not a setting", async () => {
    const { tabs } = await renderPanel();
    const strays = Object.values(tabs).flatMap((t) => t.unmarked).filter((u) => !NOT_SETTINGS.some((re) => re.test(u)));
    assert.deepEqual(strays, [], "a control that edits a config key needs data-setting on its row and a place");
});

test("PANEL_LAYOUT names exactly the sections each tab draws, with their titles", async () => {
    const { PANEL_LAYOUT } = await import("../src/contract/contract-config.ts");
    const { tabs } = await renderPanel();
    assert.deepEqual(Object.keys(PANEL_LAYOUT), TABS);
    for (const tab of TABS) {
        const drawn = tabs[tab].sections, listed = PANEL_LAYOUT[tab].sections;
        // "Waiting for an answer" draws only while a request waits; every other section always draws.
        const always = Object.fromEntries(Object.entries(listed).filter(([id]) => id !== "waitingrequests"));
        assert.deepEqual(Object.fromEntries(Object.entries(drawn).filter(([id]) => id !== "waitingrequests")), always, tab);
    }
});

// --- each row's name and tooltip come from SETTING_TEXT ---

test("every rendered row whose key has a SETTING_TEXT entry shows that name, and its tooltip when it has one", async () => {
    const { SETTING_TEXT } = await import("../src/setting-text.ts");
    const { tabs } = await renderPanel();
    const seen = new Set();
    for (const t of Object.values(tabs))
        for (const row of t.labelled) {
            const entry = SETTING_TEXT[row.key];
            if (!entry) continue;
            seen.add(row.key);
            assert.ok(row.text.includes(entry.name), `${row.key}: the row does not contain "${entry.name}"`);
            if (entry.tip !== undefined) assert.ok(row.pops.includes(entry.tip), `${row.key}: no .tt-pop equals its tip`);
            else assert.deepEqual(row.pops, [], `${row.key}: has a tooltip but SETTING_TEXT has no tip`);
        }
    // An entry with no row of its own is a key its section lists (the server-side tools' two lists).
    const listed = new Set(Object.values(tabs).flatMap((t) => t.rows.map((r) => r.key)));
    assert.deepEqual(Object.keys(SETTING_TEXT).filter((k) => !seen.has(k) && !listed.has(k)), [], "an entry the panel never draws");
});

test("every key the model may write has a SETTING_TEXT entry with a name", async () => {
    const { SETTING_TEXT } = await import("../src/setting-text.ts");
    const { modelWritable } = await import("../src/setting-class.ts");
    const { DEFAULT_CONFIG } = await import("../src/contract/contract-config.ts");
    const missing = Object.keys(DEFAULT_CONFIG).filter((k) => modelWritable(k) && !SETTING_TEXT[k]?.name);
    assert.deepEqual(missing, []);
});

// --- a link in a reply opens the row ---

test("a window-ml:setting link in a chat reply is a button; clicking it opens Settings at the row and marks it", async () => {
    const w = await loadSidebarWorld({ siteLists: SITE_LISTS });
    await w.dispatch(chatStart("lnk", 0, "how do I let scripts run programs?"));
    await w.dispatch(chatResult("lnk", 0, "Turn on [Let scripts run programs](window-ml:setting/shellEnabled) first."));
    w.shadow.querySelector(".row").click();
    await w.tick();
    const btn = w.shadow.querySelector("button.md-addr");
    assert.ok(btn, "the link renders as a button");
    assert.equal(btn.textContent, "Let scripts run programs");
    assert.equal(btn.getAttribute("data-tip"), "Opens Settings → Advanced → Programs (ml.sh), at shellEnabled");
    assert.equal(w.shadow.querySelector('a[href^="window-ml"]'), null, "never an <a href>");
    btn.click();
    await new Promise((r) => setTimeout(r, 100));
    await w.flush();
    await new Promise((r) => setTimeout(r, 100));
    const row = w.shadow.querySelector('[data-setting~="shellEnabled"]');
    assert.ok(row, "Settings is open with the row drawn");
    assert.equal(w.shadow.querySelector(".set-tab.on")?.textContent.trim(), "Advanced");
    assert.ok(row.closest("details").open, "its section is open");
    assert.ok(row.classList.contains("set-marked"), "the row is marked");
});

test("after a link opened Settings, the panel's back control returns to the session the link was clicked in", async () => {
    const w = await loadSidebarWorld({ siteLists: SITE_LISTS });
    await w.dispatch(chatStart("lnbk", 0, "how do I let scripts run programs?"));
    await w.dispatch(chatResult("lnbk", 0, "Turn on [Let scripts run programs](window-ml:setting/shellEnabled) first."));
    w.shadow.querySelector(".row").click();
    await w.tick();
    w.shadow.querySelector("button.md-addr").click();
    await new Promise((r) => setTimeout(r, 100));
    await w.flush();
    assert.ok(w.shadow.querySelector('[data-setting~="shellEnabled"]'), "Settings is open");
    const back = w.shadow.querySelector("button.tt.nav");
    assert.equal(back.getAttribute("aria-label"), "Back", "a return, not the way to the sessions list");
    back.click();
    await w.flush();
    assert.equal(w.shadow.querySelector(".set-body"), null, "Settings closed");
    assert.ok(w.shadow.querySelector('button.md-addr[data-addr="setting/shellEnabled"]'), "the reply with its link is drawn again: the session, not the list");
});

// link-address.ts copies the Backup block's tab and id from settings.tsx (which a renderer does not import); the panel
// itself is what the copy is held to here, so a renamed or moved block fails this rather than scrolling nowhere.
test("clicking the backup alias opens the tab the panel draws its Backup block on, with the block the link names", async () => {
    const { parseAddress } = await import("../src/link-address.ts");
    const { target } = parseAddress("settings/extension/backup");
    const w = await loadSidebarWorld({ siteLists: SITE_LISTS });
    await w.dispatch(chatStart("lnb", 0, "how do I back up?"));
    await w.dispatch(chatResult("lnb", 0, "Open [Backup and restore](window-ml:settings/extension/backup)."));
    w.shadow.querySelector(".row").click();
    await w.tick();
    w.shadow.querySelector('button.md-addr[data-addr="settings/extension/backup"]').click();
    await new Promise((r) => setTimeout(r, 100));
    await w.flush();
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(w.shadow.querySelector(".set-tab.on")?.textContent.trim(), "Appearance");
    const block = w.shadow.querySelector(`#${target}`);
    assert.equal(block?.getAttribute("aria-label"), "Backup and restore", "the link's target is the panel's Backup block, drawn");
    assert.ok(block.closest('[data-section="storage"]').open, "its Storage section is open");
});

test("an unresolved window-ml address in a reply renders as its label, with no button", async () => {
    const w = await loadSidebarWorld();
    await w.dispatch(chatStart("lnu", 0, "q"));
    await w.dispatch(chatResult("lnu", 0, "See [the context size](window-ml:setting/ocrNumCtx) and [nowhere](window-ml:settings/extension/advanced/nope)."));
    w.shadow.querySelector(".row").click();
    await w.tick();
    const md = [...w.shadow.querySelectorAll(".md")].find((e) => /context size/.test(e.textContent));
    assert.equal(md.querySelector("button.md-addr"), null);
    assert.match(md.textContent, /See the context size and nowhere\./);
});

test("on the HUD card, which draws no Settings, a link is a button that asks the worker to open the chat page at its address", async () => {
    const w = await loadSidebarWorld();
    await w.raw({ __mlSidebarSurface: "card" });
    await w.dispatch(agentStart("lcard", "how do I run programs?"));
    await w.dispatch(agentResult("lcard", "Turn on [Let scripts run programs](window-ml:setting/shellEnabled), in [Programs](window-ml:settings/extension/advanced/shell).", 1));
    await w.tick();
    const answer = w.shadow.querySelector(".card-answer");
    assert.ok(answer, "the card drew the answer");
    const buttons = [...answer.querySelectorAll("button.md-addr")];
    assert.deepEqual(buttons.map((b) => b.textContent), ["Let scripts run programs", "Programs"]);
    for (const b of buttons) b.click();
    await w.flush();
    assert.deepEqual(w.openChatCalls, [{ address: "setting/shellEnabled" }, { address: "settings/extension/advanced/shell" }]);
    assert.equal(w.shadow.querySelector(".set-body"), null, "the card itself opened no Settings");
});
