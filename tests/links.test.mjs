// links.test.mjs — `[label](window-ml:<address>)` in the model's prose (src/sidebar/links.ts, docs/spec/LINKS.md):
// the panel's address grammar, the tip, how markdown() draws a link, and the upgrade from a build without links.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseAddress, addressTip, addressHash } from "../src/sidebar/links.ts";
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
