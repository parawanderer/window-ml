// links.test.mjs — `[label](window-ml:<address>)` in the model's prose (src/sidebar/links.ts, src/link-address.ts,
// docs/spec/LINKS.md): the panel's address grammar, the tip, how markdown() draws a link, and the upgrade from a build
// without links.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { addressTip, addressHash, onAddressClick } from "../src/sidebar/links.ts";
import { parseAddress } from "../src/link-address.js";
import { installServices, services } from "../src/sidebar/services.ts";
import { PANEL_LAYOUT } from "../src/contract/contract-config.js";
import { markdown, mdInline } from "../src/sidebar/format.ts";
import { SETTING_PLACES } from "../src/contract/contract-config.ts";

/** markdown()'s `addr` for a surface that can open the panel. */
const addr = (a) => { const r = parseAddress(a); return r ? addressTip(r) : null; };

// --- the address grammar ---

test("every setting with a place parses to its tab, section and key", () => {
    for (const [key, place] of Object.entries(SETTING_PLACES))
        assert.deepEqual(parseAddress(`setting/${key}`), { ...place, setting: key }, key);
});

test("every panel tab and every section of it parses", () => {
    for (const [tab, { sections }] of Object.entries(PANEL_LAYOUT)) {
        assert.deepEqual(parseAddress(`settings/extension/${tab}`), { tab });
        for (const section of Object.keys(sections))
            assert.deepEqual(parseAddress(`settings/extension/${tab}/${section}`), { tab, section });
    }
});

test("backup stays the alias of Storage's Backup block", () => {
    assert.deepEqual(parseAddress("settings/extension/backup"), { tab: "appearance", section: "storage", target: "set-backup" });
});

test("an unknown key, tab or section, a section of another tab, or an extra part parses to nothing", () => {
    for (const a of ["setting/nope", "setting/ocrNumCtx", "setting/constructor", "setting/__proto__", "setting/",
        "settings/extension/nope", "settings/extension/advanced/nope", "settings/extension/models/shell",
        "settings/extension/advanced/shell/more", "settings/extension", "settings", "settings/devices",
        "setting/apiKey/x", "s/local:3fa91c2e", "search", "attention", "",
        // parseRoute drops empty parts and trailing ones and falls back to a wider view; a link does not
        "settings//extension/models", "settings/extension/advanced//shell", "setting//apiKey", "settings/extension/backup/x",
        "settings/extension/models/", "/settings/extension/models", "s/x"])
        assert.equal(parseAddress(a), null, a);
});

test("formatAddress is parseAddress's inverse on every address that parses", async () => {
    const { formatAddress } = await import("../src/link-address.ts");
    const addresses = [...Object.keys(SETTING_PLACES).map((k) => `setting/${k}`), "settings/extension/backup",
        ...Object.entries(PANEL_LAYOUT).flatMap(([t, { sections }]) => [`settings/extension/${t}`, ...Object.keys(sections).map((s) => `settings/extension/${t}/${s}`)])];
    for (const a of addresses) assert.equal(formatAddress(parseAddress(a)), a, a);
});

// --- the chat page's hash for a link it opens ---

// The extension's chat page opens a link by setting its own hash (`addressHash`); the router reads it with parseRoute.
// Every address a link can name, enumerated: each one's hash names the same view the link resolved to.
test("every address a link resolves to has a chat-page hash that names the same view", () => {
    const addresses = ["settings/extension/backup", ...Object.keys(SETTING_PLACES).map((k) => `setting/${k}`)];
    for (const [tab, { sections }] of Object.entries(PANEL_LAYOUT)) {
        addresses.push(`settings/extension/${tab}`);
        for (const section of Object.keys(sections)) addresses.push(`settings/extension/${tab}/${section}`);
    }
    for (const a of addresses) {
        const r = parseAddress(a);
        assert.ok(r, a);
        assert.equal(addressHash(r), `#/${a}`, a);
    }
});

// --- the tip names the view, never the label ---

test("the tip says where a link goes, from the resolved address", () => {
    assert.equal(addressTip(parseAddress("settings/extension/advanced/shell")), "Opens Settings → Advanced → Programs (ml.sh)");
    assert.equal(addressTip(parseAddress("settings/extension/permissions")), "Opens Settings → Permissions");
    assert.equal(addressTip(parseAddress("setting/apiKey")), "Opens Settings → Connection, at apiKey");
    assert.equal(addressTip(parseAddress("settings/extension/backup")), "Opens Settings → Appearance → Storage → Backup and restore");
});

// --- how markdown() draws a link ---

test("a resolved link in the model's reply is a button with the address and the tip; never an <a>", () => {
    const html = markdown("Open [**Programs**](window-ml:settings/extension/advanced/shell).", { addr });
    assert.equal(html, '<p>Open <button type="button" class="md-link md-addr tt" data-addr="settings/extension/advanced/shell" data-tip="Opens Settings → Advanced → Programs (ml.sh)"><strong>Programs</strong></button>.</p>');
    assert.doesNotMatch(html, /<a /);
});

test("an unresolved link renders as its label", () => {
    assert.equal(markdown("See [the size](window-ml:setting/ocrNumCtx).", { addr }), "<p>See the size.</p>");
});

test("a surface that cannot open the panel draws every link as its label", () => {
    assert.equal(markdown("See [Programs](window-ml:settings/extension/advanced/shell).", { addr: () => null }), "<p>See Programs.</p>");
});

test("without addr (a tool's output, a description, an export) a window-ml link stays the text it was written as", () => {
    assert.equal(markdown("[x](window-ml:setting/apiKey)"), "<p>[x](window-ml:setting/apiKey)</p>");
    assert.equal(mdInline("[x](window-ml:setting/apiKey)"), "[x](window-ml:setting/apiKey)");
});

test("inside a > quote, a code span or a fence, a window-ml link stays text", () => {
    assert.equal(markdown("> [x](window-ml:setting/apiKey)", { addr }), "<blockquote><p>[x](window-ml:setting/apiKey)</p></blockquote>");
    assert.equal(markdown("`[x](window-ml:setting/apiKey)`", { addr }), "<p><code>[x](window-ml:setting/apiKey)</code></p>");
    assert.doesNotMatch(markdown("```\n[x](window-ml:setting/apiKey)\n```", { addr }), /md-addr/);
});

test("every other non-http(s) destination stays text, with or without addr", () => {
    for (const d of ["javascript:alert(1)", "data:text/html,x", "chrome-extension://abc/chat.html#/settings", "chrome://settings", "window-ml:setting/apiKey?x=1", "window-ml:setting/apiKey#frag", "window-ml:./setting"]) {
        for (const o of [{}, { addr }]) {
            const html = markdown(`[x](${d})`, o);
            assert.doesNotMatch(html, /<a |<button/, `${d} ${JSON.stringify(Object.keys(o))}`);
        }
    }
});

test("an image of a window-ml address is not turned into a link", () => {
    assert.doesNotMatch(markdown("![x](window-ml:setting/apiKey)", { addr }), /<button/);
});

test("mdInline with addr draws the button too (Prose's margin notes)", () => {
    assert.match(mdInline("[x](window-ml:setting/cdp)", addr), /^<button type="button" class="md-link md-addr tt" data-addr="setting\/cdp"/);
});

// --- the upgrade: transcripts written before links, and links read by an older build ---

const UPGRADE = JSON.parse(readFileSync(new URL("./fixtures/links/upgrade.json", import.meta.url), "utf8"));

test("a reply written before links renders exactly as it did", () => {
    assert.equal(markdown(UPGRADE.before.text, { math: true, addr }), UPGRADE.before.oldHtml);
});

test("a reply with a link, read by an older build, showed the literal text; this build's no-addr path draws the same", () => {
    assert.match(UPGRADE.withLink.oldHtml, /\[Let scripts run programs\]\(window-ml:setting\/shellEnabled\)/);
    assert.equal(markdown(UPGRADE.withLink.text, { math: true }), UPGRADE.withLink.oldHtml);
    const now = markdown(UPGRADE.withLink.text, { math: true, addr });
    assert.match(now, /<button[^>]+data-addr="setting\/shellEnabled"[^>]*>Let scripts run programs<\/button>/);
    assert.match(now, /<blockquote><p>\[quoted\]\(window-ml:setting\/apiKey\)<\/p><\/blockquote>/, "the quoted one stays text");
});

// --- the click: a parsed route, or nothing at all ---

// A link opens a view; it never acts (links.ts's header). The render half (a destination is a button, never an `<a
// href>`) and the hash half (`addressHash` names the view its address parsed to) are pinned above and in "every address
// a link resolves to has a chat-page hash"; this is the CLICK half, which nothing drove before: the handler parses the
// button's attribute again and hands the page a route, so a destination that is not one — a query, a fragment, another
// scheme, a traversing path — opens nothing, and a click is swallowed without opening anything at all where the surface
// cannot open a panel view.
//
// MEASURED AT 7de62b0d: green (19/19). Mutations, each alone and reverted: `onAddressClick` calling
// `services().openAddress?.(address)` (the button's own attribute instead of `resolveLink(address)?.route`) reds this
// row on "the click opened something other than the parsed route", with every other row green; `format.ts`'s
// `window-ml:` arm drawing `<a class="md-link tt" href="${address}">` reds this row on its first destination (and the
// lane's three render rows). The hash half is a lexical guard here; the equality it rests on (each address's hash
// naming the same view) is pinned by "every address a link resolves to has a chat-page hash that names the same view"
// above, which a route-to-hash mutation reds there.

test("a window-ml: destination never becomes an <a href>, and a click opens the parsed route or nothing at all", async () => {
    const before = services();
    const opened = [];
    let prevented = 0;
    installServices({ ...before, openAddress: (r) => opened.push(r) });
    const click = (dataAddr, target) => onAddressClick({
        target: target ?? { closest: () => ({ getAttribute: () => dataAddr }) },
        preventDefault: () => { prevented++; },
    });
    try {
        // Every destination shape a model can write reaches the chat page's own `addr`: none of them is an anchor.
        for (const d of ["setting/apiKey", "settings/extension/advanced/shell", "javascript:alert(1)", "data:text/html,x",
            "setting/apiKey?x=1", "setting/apiKey#frag", "//evil.example/setting/apiKey", "setting/../apiKey", "setting/%2e%2e/x"]) {
            const html = markdown(`[go](window-ml:${d})`, { addr });
            assert.doesNotMatch(html, /<a\b/, `a window-ml:${d} destination became an anchor`);
            if (!parseAddress(d)) assert.doesNotMatch(html, /md-addr/, `an unresolvable window-ml:${d} was drawn as a link`);
        }
        // A click on a link's inner element (the label's <strong>) opens the ROUTE the grammar parsed, not the text.
        const inner = { closest: (sel) => (sel === "button.md-addr" ? { getAttribute: () => "settings/extension/advanced/shell" } : null) };
        assert.equal(click("unused", inner), true, "the click was not recognised as a link's");
        assert.equal(prevented, 1, "the click was not swallowed");
        assert.deepEqual(opened, [{ tab: "advanced", section: "shell" }], "the click opened something other than the parsed route");
        // A button whose attribute is not an address the grammar accepts opens NOTHING: no query, fragment, scheme or
        // traversing path is handed on, and the raw string never leaves the handler.
        for (const d of ["javascript:alert(1)", "settings/extension/advanced/shell?x=1", "setting/apiKey#frag",
            "settings/extension/../shell", "settings/extension/advanced/shell%00", "//evil.example/x", "setting/"]) {
            opened.length = 0;
            assert.equal(click(d), true, `${JSON.stringify(d)} was not recognised as a link's`);
            assert.deepEqual(opened, [], `a click on data-addr ${JSON.stringify(d)} opened something`);
        }
        // A button with an EMPTY address is no link at all (`if (!address) return false`): nothing opens, and — a
        // `<button type="button">` having no default action — leaving the click alone is safe.
        opened.length = 0;
        assert.equal(click(""), false);
        assert.deepEqual(opened, [], "a click on an empty data-addr opened something");
        // A click that is not on a link is left alone.
        assert.equal(onAddressClick({ target: { closest: () => null }, preventDefault: () => { throw new Error("preventDefault on a non-link"); } }), false);
        // A window-ml: destination is never a hash the page acts on beyond its own: no query, fragment or scheme in it.
        for (const [key, place] of Object.entries(SETTING_PLACES)) {
            const h = addressHash({ ...place, setting: key });
            assert.match(h, /^#\/[A-Za-z0-9_/-]+$/, `addressHash(setting/${key}) = ${h}`);
        }
        // On a surface without `openAddress` (a transcript drawn elsewhere), the click opens nothing, though it is still
        // swallowed rather than left to the browser.
        installServices({ ...before, openAddress: undefined });
        opened.length = 0;
        assert.equal(click("setting/apiKey"), true);
        assert.deepEqual(opened, []);
    } finally { installServices(before); }
});

// --- what agent_api_docs tells the model ---

test("agent_api_docs' settings section names every placed setting, and every address in it resolves", async () => {
    const { settingsLinksSection } = await import("../src/tools/api-docs-tool.ts");
    const { DEFAULT_CONFIG, publicConfig } = await import("../src/contract/contract-config.ts");
    const text = settingsLinksSection();
    const addresses = [...text.matchAll(/`(settings\/extension\/[A-Za-z0-9_/]+)`/g)].map((m) => m[1]);
    assert.ok(addresses.length > 30, "every tab and section is listed with its address");
    for (const a of addresses) assert.ok(parseAddress(a), `${a} resolves`);
    const listed = new Set([...text.matchAll(/^\s*- .*?\): (.+)$/gm)].flatMap((m) => m[1].split(", ")));
    assert.deepEqual([...listed].sort(), Object.keys(SETTING_PLACES).sort(), "every placed key, once, under its place");
    const readable = Object.keys(publicConfig(DEFAULT_CONFIG, false)).filter((k) => k in DEFAULT_CONFIG);
    assert.match(text, new RegExp(`\`ml\\.config\\(\\)\` returns ${readable.map((k) => `\`${k}\``).join(", ")}\\.`));
    assert.doesNotMatch(text, /\S {2,}\S/, "no padding: the model pays for every space");
});

test("agent_api_docs' default view names the settings section, and a search for 'settings' returns it", async () => {
    const { apiDocsTool } = await import("../src/tools/api-docs-tool.ts");
    const tool = apiDocsTool((d) => d, { invocation: async () => null, config: async () => null });
    assert.match(await tool.run({}), /"Your settings"/);
    assert.match(await tool.run({ search: "window-ml:" }), /## Your settings, and linking the person to one/);
});
