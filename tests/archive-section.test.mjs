// The Settings archive folder section (src/sidebar/archive-section.tsx): each permission state says what to do next,
// Brave gets its flag, and a panel framed inside a web page points to the chat page instead of offering a click the
// browser would refuse.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { createRequire } from "node:module";
const require_ = createRequire(import.meta.url);

let h, render, ArchiveFolderBody, BRAVE_FLAG, doc;
before(async () => {
    // An origin, so `localStorage` exists: whether the folder was reconnected before is remembered there.
    const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", { pretendToBeVisual: true, url: "https://extension.test/" });
    globalThis.localStorage = dom.window.localStorage;
    globalThis.window = dom.window;
    globalThis.document = dom.window.document;
    globalThis.Node = dom.window.Node;
    doc = dom.window.document;
    ({ h, render } = require_("preact"));
    ({ ArchiveFolderBody, BRAVE_FLAG } = await import("../src/sidebar/settings/archive-section.tsx"));
});

const clicks = [];
const base = { archiveOn: true, isBrave: false, canAskHere: true, busy: null, message: "",
    onPick: () => clicks.push("pick"), onRegrant: () => clicks.push("regrant"), onSync: () => clicks.push("sync"), onImport: () => clicks.push("import"), onForget: () => clicks.push("forget") };
const show = (over) => { const host = doc.getElementById("root"); render(null, host); render(h(ArchiveFolderBody, { ...base, ...over }), host); return host; };
const buttons = (host) => [...host.querySelectorAll("button")].map((b) => b.textContent);

test("no folder: one primary action, and why a folder is worth having", () => {
    const host = show({ report: { state: "none", pending: 0, lastSync: null } });
    assert.deepEqual(buttons(host), ["Pick a folder…"]);
    assert.match(host.textContent, /one SQLite file per month/);
    host.querySelector("button").click();
    assert.equal(clicks.at(-1), "pick");
});

test("a lapsed grant: says what happened, what waits, and to choose Allow on every visit", () => {
    const host = show({ report: { state: "needs-grant", name: "Archive", pending: 3, lastSync: 1 } });
    assert.deepEqual(buttons(host), ["Reconnect"]);
    assert.match(host.textContent, /Allow on every visit/);
    assert.match(host.textContent, /3 month files wait to be written\. Nothing is lost/);
});

test("lapsed AGAIN after a reconnect: it was allowed only once, so this time choose Always allow", () => {
    localStorage.setItem("wml-archive-regranted", "1");
    try {
        const host = show({ report: { state: "needs-grant", name: "Archive", pending: 1, lastSync: 1 } });
        assert.match(host.textContent, /Archive lapsed again/);
        assert.match(host.textContent, /allowed only until the browser restarted/);
        assert.match(host.textContent, /Always allow/);
        // …and the connected state's heads-up is gone once it has been through a reconnect.
        const conn = show({ report: { state: "connected", name: "Archive", pending: 0, lastSync: Date.now() } });
        assert.doesNotMatch(conn.textContent, /may ask for this folder again/);
    } finally {
        localStorage.removeItem("wml-archive-regranted");
    }
});

test("connected: the folder, its last write, and the four actions", () => {
    const host = show({ report: { state: "connected", name: "Archive", pending: 0, lastSync: Date.now() } });
    assert.deepEqual(buttons(host), ["Write now", "Import from this folder", "Change folder…", "Stop using this folder"]);
    assert.match(host.textContent, /Archive, written just now/);
    // The lasting grant is only offered on the NEXT ask, so it is said before that ask arrives.
    assert.match(host.textContent, /may ask for this folder again\. Choose Always allow then/);
});

test("unsupported: Brave gets its flag to copy, anything else a plain sentence", () => {
    const brave = show({ report: { state: "unsupported", pending: 0, lastSync: null }, isBrave: true });
    assert.ok(brave.textContent.includes(BRAVE_FLAG));
    assert.deepEqual(buttons(brave), ["Copy that address"]);
    const other = show({ report: { state: "unsupported", pending: 0, lastSync: null } });
    assert.match(other.textContent, /does not let an extension use a folder/);
    assert.deepEqual(buttons(other), []);
});

test("inside a web page's frame, a click the browser would refuse becomes where to go instead", () => {
    const host = show({ report: { state: "needs-grant", name: "Archive", pending: 1, lastSync: null }, canAskHere: false });
    assert.deepEqual(buttons(host), []);
    assert.match(host.textContent, /open Settings in the chat page/);
    const conn = show({ report: { state: "connected", name: "Archive", pending: 0, lastSync: null }, canAskHere: false });
    assert.deepEqual(buttons(conn), ["Write now", "Import from this folder", "Stop using this folder"]);
});

test("the archive switched off is said, since nothing would reach the folder", () => {
    const host = show({ report: { state: "none", pending: 0, lastSync: null }, archiveOn: false });
    assert.match(host.textContent, /Archive sessions instead of deleting them/);
});

// --- a picked folder that already holds an earlier archive ---

test("a picked folder with earlier month files asks first: import them (the default) or start fresh, nothing deleted", () => {
    const host = show({ report: { state: "connected", name: "Archive", pending: 0, lastSync: null },
        found: { name: "Archive", files: 14, first: "2025-09", last: "2026-10" },
        onAdopt: () => clicks.push("adopt"), onFresh: () => clicks.push("fresh") });
    assert.deepEqual(buttons(host), ["Import them and use this folder", "Start fresh"]);
    assert.match(host.textContent, /Archive already holds 14 month files \(2025-09 to 2026-10\)/);
    assert.match(host.textContent, /nothing is deleted/);
    assert.ok(host.querySelector("button").classList.contains("arch-primary"), "importing is the default");
    const [adopt, fresh] = host.querySelectorAll("button");
    adopt.click(); assert.equal(clicks.at(-1), "adopt");
    fresh.click(); assert.equal(clicks.at(-1), "fresh");
    // One file says its month once, not "2026-10 to 2026-10".
    const one = show({ report: { state: "connected", name: "Archive", pending: 0, lastSync: null }, found: { name: "Archive", files: 1, first: "2026-10", last: "2026-10" } });
    assert.match(one.textContent, /holds 1 month file \(2026-10\),/);
});

// --- the folder's form (part 3a) ---

const conn = (over = {}) => ({ state: "connected", name: "Archive", pending: 0, lastSync: 1790000000000, form: "encrypted", keyring: { set: true, keyId: "k1" }, ...over });
const WARNING = /These files hold whole transcripts, and a synced folder's service can read them/;
const SWITCH_NOTICE = /next sync rewrites every month in the new form and removes the old files\. A sync service may keep earlier versions/;
const choose = (host, i) => { const r = host.querySelectorAll('input[type="radio"]')[i]; r.checked = true; r.dispatchEvent(new doc.defaultView.Event("change", { bubbles: true })); };
const flush = () => new Promise((r) => setTimeout(r, 0));
const sent = [];

test("the form is a choice of three, showing the report's form, and the warning shows for plain and compressed only", async () => {
    for (const [form, i, warned] of [["encrypted", 0, false], ["gzip", 1, true], ["plain", 2, true]]) {
        const host = show({ report: conn({ form }), onForm: (f) => sent.push(f) });
        const radios = [...host.querySelectorAll('input[type="radio"]')];
        assert.deepEqual(radios.map((r) => r.parentElement.textContent), ["Encrypted (.wmlbak), recommended", "Compressed (.sqlite.gz)", "Plain SQLite (.sqlite)"]);
        assert.deepEqual(radios.map((r) => r.checked), [0, 1, 2].map((k) => k === i), form);
        assert.equal(WARNING.test(host.textContent), warned, form);
        assert.doesNotMatch(host.textContent, SWITCH_NOTICE, "nothing is being switched yet");
    }
    // Looking at a form that is not encrypted: the warning is about the choice on screen, so it follows the pick.
    const host = show({ report: conn({ form: "encrypted" }) });
    choose(host, 2); await flush();
    assert.match(host.textContent, WARNING);
});

test("a switch says what it does BEFORE it is sent, and Cancel leaves the form as it was", async () => {
    sent.length = 0;
    const host = show({ report: conn({ form: "plain" }), onForm: (f) => sent.push(f) });
    choose(host, 1); await flush();
    assert.match(host.textContent, SWITCH_NOTICE);
    assert.deepEqual(sent, [], "picking is not sending");
    assert.deepEqual(buttons(host).filter((b) => /Switch|Cancel/.test(b)), ["Switch to compressed", "Cancel"]);
    [...host.querySelectorAll("button")].find((b) => b.textContent === "Cancel").click(); await flush();
    assert.doesNotMatch(host.textContent, SWITCH_NOTICE);
    assert.equal(host.querySelectorAll('input[type="radio"]')[2].checked, true, "back on what is there");
    choose(host, 1); await flush();
    [...host.querySelectorAll("button")].find((b) => /^Switch to/.test(b.textContent)).click(); await flush();
    assert.deepEqual(sent, ["gzip"]);
});

test("choosing Encrypted with no keyring shows the recovery-key set-up, not a form message, and sends nothing until it completes", async () => {
    sent.length = 0;
    const host = show({ report: conn({ form: "plain", keyring: { set: false } }), onForm: (f) => sent.push(f) });
    choose(host, 0); await flush();
    assert.match(host.textContent, SWITCH_NOTICE, "the notice comes first");
    [...host.querySelectorAll("button")].find((b) => /^Switch to/.test(b.textContent)).click(); await flush();
    assert.match(host.textContent, /Set up backup encryption/);
    assert.doesNotMatch(host.textContent, SWITCH_NOTICE);
    assert.equal(host.querySelector('input[type="radio"]'), null, "the set-up replaces the choice while it is up");
    assert.deepEqual(sent, []);
    // Cancelling leaves the form as it was.
    [...host.querySelectorAll("button")].find((b) => b.textContent === "Cancel").click(); await flush();
    assert.deepEqual(sent, []);
    assert.equal(host.querySelectorAll('input[type="radio"]')[2].checked, true);
    assert.doesNotMatch(host.textContent, /Set up backup encryption/);
});

test("choosing Encrypted with a keyring sends the form straight away: no set-up", async () => {
    sent.length = 0;
    const host = show({ report: conn({ form: "gzip" }), onForm: (f) => sent.push(f) });
    choose(host, 0); await flush();
    [...host.querySelectorAll("button")].find((b) => /^Switch to/.test(b.textContent)).click(); await flush();
    assert.deepEqual(sent, ["encrypted"]);
    assert.doesNotMatch(host.textContent, /Set up backup encryption/);
});

test("a connected folder whose form is unchosen (report.form null) shows the choice with Encrypted preselected and an explicit Continue, and no switch notice", async () => {
    sent.length = 0;
    const host = show({ report: conn({ form: null, lastSync: null, keyring: { set: true, keyId: "k1" } }), onForm: (f) => sent.push(f) });
    assert.match(host.textContent, /Nothing is written to it until you choose/);
    assert.equal(host.querySelectorAll('input[type="radio"]')[0].checked, true);
    assert.doesNotMatch(host.textContent, SWITCH_NOTICE);
    assert.deepEqual(buttons(host), ["Continue"]);
    choose(host, 2); await flush();
    assert.match(host.textContent, WARNING);
    host.querySelector("button").click(); await flush();
    assert.deepEqual(sent, ["plain"]);
    // With no keyring, Continue on the preselected Encrypted starts the set-up and sends nothing yet.
    sent.length = 0;
    const fresh = show({ report: conn({ form: null, lastSync: null, keyring: { set: false } }), onForm: (f) => sent.push(f) });
    fresh.querySelector("button").click(); await flush();
    assert.match(fresh.textContent, /Set up backup encryption/);
    assert.deepEqual(sent, []);
    // Not connected: no form question yet.
    assert.doesNotMatch(show({ report: { state: "none", pending: 0, lastSync: null, form: null, keyring: { set: false } } }).textContent, /Nothing is written to it/);
});

// --- skipped months, by reason ---

test("each skip reason renders its own text, and a damaged file keeps its month and the error", () => {
    const skip = (month, reason, error = "x") => ({ month, reason, error });
    const text = (skipped) => show({ report: conn({ skipped }) }).textContent;
    assert.match(text([skip("2026-08", "needs-key"), skip("2026-09", "needs-key")]), /2 months are encrypted, and this install has no backup key: set one up under Backup and restore/);
    assert.match(text([skip("2026-08", "needs-key")]), /1 month is encrypted, and this install has no backup key/);
    const other = text([skip("2026-09", "other-key"), skip("2026-10", "other-key"), skip("2026-11", "other-key")]);
    assert.match(other, /3 months are encrypted with another install's key/);
    assert.doesNotMatch(other, /no backup key/);
    const bad = text([skip("2026-07", "unreadable", "not an archive")]);
    assert.match(bad, /2026-07 \(not an archive\)/);
    assert.doesNotMatch(bad, /encrypted/);
    assert.doesNotMatch(text([]), /could not be read|another install|no backup key/);
    // All three together: three separate lines.
    assert.equal(show({ report: conn({ skipped: [skip("a", "needs-key"), skip("b", "other-key"), skip("c", "unreadable")] }) }).querySelectorAll(".arch-skips .set-warn").length, 3);
});
