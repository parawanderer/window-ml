// The Settings archive folder section (src/sidebar/archive-section.tsx): each permission state says what to do next,
// Brave gets its flag, and a panel framed inside a web page points to the chat page instead of offering a click the
// browser would refuse.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { createRequire } from "node:module";
const require_ = createRequire(import.meta.url);

let h, render, ArchiveFolderBody, BRAVE_FLAG, keyToAdopt, forgetNotice, RetiredKeys, doc;
before(async () => {
    // An origin, so `localStorage` exists: whether the folder was reconnected before is remembered there.
    const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", { pretendToBeVisual: true, url: "https://extension.test/" });
    globalThis.localStorage = dom.window.localStorage;
    globalThis.window = dom.window;
    globalThis.document = dom.window.document;
    globalThis.Node = dom.window.Node;
    doc = dom.window.document;
    ({ h, render } = require_("preact"));
    ({ ArchiveFolderBody, BRAVE_FLAG, keyToAdopt, forgetNotice, RetiredKeys } = await import("../src/sidebar/settings/archive-section.tsx"));
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
    assert.match(text([skip("2026-08", "needs-key"), skip("2026-09", "needs-key")]), /2 months are encrypted, and this install has no backup key\. They are left as they were/);
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

// --- using the folder's key (part 3c) ---

const NOTICE = /This install will encrypt with the folder's key from now on\. Its own earlier backups and archive months still open here, but on another install they need this install's old passphrase or recovery key\./;
const skip = (month, reason, keyId, error = "x") => ({ month, reason, error, ...(keyId ? { keyId } : {}) });
const typeInto = (input, v) => { input.value = v; input.dispatchEvent(new doc.defaultView.Event("input", { bubbles: true })); };

test("the key to adopt is the one most skipped months are sealed under, read from the first of those months", () => {
    assert.deepEqual(keyToAdopt([skip("2026-07", "other-key", "kb"), skip("2026-08", "other-key", "ka"), skip("2026-09", "other-key", "ka"), skip("2026-10", "unreadable")]), { keyId: "ka", month: "2026-08", months: 2 });
    assert.deepEqual(keyToAdopt([skip("2026-07", "other-key")]), { keyId: null, month: "2026-07", months: 1 }, "a report from before 3c names no key: one month is enough");
    assert.equal(keyToAdopt([skip("2026-07", "unreadable")]), null);
    assert.equal(keyToAdopt([]), null);
});

test("other-key: beside the existing line, a field for the other install's secret, with what it costs said before it acts; the click sends the typed text and the month it is opened from", async () => {
    const got = [];
    const host = show({ report: conn({ skipped: [skip("2026-08", "other-key", "ka"), skip("2026-09", "other-key", "ka"), skip("2026-10", "other-key", "kb")] }), onAdoptKey: (t, m) => got.push([t, m]) });
    assert.match(host.textContent, /3 months are encrypted with another install's key/);
    assert.match(host.textContent, /Use this folder's key/);
    assert.match(host.textContent, NOTICE, "said once, before anything is sent");
    assert.equal(host.textContent.match(/This install will encrypt with/g).length, 1);
    const field = host.querySelector('.arch-adopt input[type="password"]');
    assert.ok(field, "the restore screen's field");
    const go = [...host.querySelectorAll("button")].find((b) => b.textContent === "Use this folder's key");
    assert.equal(go.disabled, true, "nothing typed, nothing to send");
    typeInto(field, "correct horse battery"); await flush();
    [...host.querySelectorAll("button")].find((b) => b.textContent === "Use this folder's key").click();
    assert.deepEqual(got, [["correct horse battery", "2026-08"]]);
});

test("other-key: a wrong secret says so and keeps the typed text", async () => {
    const host = show({ report: conn({ skipped: [skip("2026-08", "other-key", "ka")] }), adoptWrong: true, onAdoptKey() {} });
    assert.match(host.textContent, /does not open this folder's files/);
    const field = host.querySelector('.arch-adopt input[type="password"]');
    assert.ok(field.classList.contains("err"));
    typeInto(field, "typed"); await flush();
    assert.equal(host.querySelector('.arch-adopt input[type="password"]').value, "typed");
    assert.equal(show({ report: conn({ skipped: [skip("2026-08", "other-key", "ka")] }), busy: "adopt-key" }).querySelector(".arch-adopt input").disabled, true, "disabled while it works");
});

test("needs-key with no keyring at all (a new machine): the folder's key is the FIRST choice, then setting up a new key", async () => {
    const got = [];
    const host = show({ report: conn({ keyring: { set: false }, skipped: [skip("2026-08", "needs-key", "ka"), skip("2026-09", "needs-key", "ka")] }), onAdoptKey: (t, m) => got.push([t, m]) });
    const choices = [...host.querySelectorAll(".arch-skips > *")].map((e) => e.className + ":" + (e.querySelector(".bk-h")?.textContent ?? e.textContent.slice(0, 20)));
    assert.match(choices[1], /^arch-adopt first:Use this folder's key/, "adopting comes first");
    assert.deepEqual(buttons(host).filter((b) => /folder's key|new key/.test(b)), ["Use this folder's key", "Set up a new key instead"]);
    assert.doesNotMatch(host.textContent, /Its own earlier backups/, "no key of its own, so nothing earlier to lose");
    assert.match(host.textContent, /This install will encrypt with the folder's key from now on\./);
    typeInto(host.querySelector(".arch-adopt input"), "AAAA-BBBB-CCCC-DDDD-EEEE-FFFF-GGGG"); await flush();
    [...host.querySelectorAll("button")].find((b) => b.textContent === "Use this folder's key").click();
    assert.deepEqual(got, [["AAAA-BBBB-CCCC-DDDD-EEEE-FFFF-GGGG", "2026-08"]]);
    [...host.querySelectorAll("button")].find((b) => b.textContent === "Set up a new key instead").click(); await flush();
    assert.match(host.textContent, /Set up backup encryption/, "the same set-up as the form choice");
    assert.equal(host.querySelector(".arch-adopt"), null);
});

test("a new folder whose form is unchosen and holds encrypted months offers the folder's key above the form choice, and leaves the new-key set-up to it", () => {
    const host = show({ report: conn({ form: null, lastSync: null, keyring: { set: false }, skipped: [skip("2026-08", "needs-key", "ka")] }), onAdoptKey() {} });
    assert.ok(host.querySelector(".arch-adopt.first"));
    assert.doesNotMatch(buttons(host).join("|"), /Set up a new key instead/);
    assert.match(host.textContent, /choose Encrypted below to set up a new key/);
    assert.ok(host.querySelector('input[type="radio"]'), "the form choice is still there");
});

test("no skipped encrypted months, no field", () => {
    assert.equal(show({ report: conn({ skipped: [skip("2026-07", "unreadable")] }) }).querySelector(".arch-adopt"), null);
    assert.equal(show({ report: conn() }).querySelector(".arch-adopt"), null);
});

// --- forgetting a retired key (part 3d) ---

const RK = [{ keyId: "9f3a1c7e2b40d815", since: Date.UTC(2026, 9, 20, 12) }, { keyId: "c04b77aa19e2f6d3" }];
const rows = (host) => [...host.querySelectorAll(".arch-rk")].map((r) => r.querySelector(".arch-rk-row").textContent);

test("retired keys: short id, the date or 'retired earlier', and how many months are under each; the section lists them under the form", () => {
    const host = show({ report: conn({ keyring: { set: true, keyId: "k1", retired: RK } }), keyCounts: { "9f3a1c7e2b40d815": 2 } });
    const [dated, undated] = rows(host);
    assert.match(dated, /^9f3a1c7eretired \d+\/\d+\/\d+, 2 months in the folderForget$/);
    assert.match(undated, /^c04b77aaretired earlier, 0 months in the folderForget$/);
    assert.doesNotMatch(host.textContent, /9f3a1c7e2b40d815/, "the short id only");
    const order = [...host.querySelectorAll(".arch-form, .arch-retired")].map((e) => e.className);
    assert.deepEqual(order, ["arch-form", "arch-retired"]);
    assert.equal(show({ report: conn() }).querySelector(".arch-retired"), null, "nothing retired: no list");
});

test("retired keys with the folder unreadable here: the list without counts", () => {
    const host = show({ report: conn({ keyring: { set: true, keyId: "k1", retired: RK } }), keyCounts: null });
    assert.deepEqual(rows(host).map((r) => /month/.test(r)), [false, false]);
    assert.match(rows(host)[1], /retired earlier/);
});

test("forget says what it costs once, then acts only on the second click; cancel leaves it", async () => {
    const got = [];
    const host = show({ report: conn({ keyring: { set: true, keyId: "k1", retired: RK } }), keyCounts: { "9f3a1c7e2b40d815": 3 }, onForgetKey: (k) => got.push(k) });
    [...host.querySelectorAll(".arch-rk button")][0].click(); await flush();
    assert.deepEqual(got, [], "the first click only asks");
    const ask = host.querySelector(".arch-rk-ask");
    assert.match(ask.textContent, /Files under this key will ask for its passphrase or recovery key on this install\. 3 months in the folder are still under it and will be skipped until another install rewrites them\./);
    [...ask.querySelectorAll("button")].find((b) => b.textContent === "Cancel").click(); await flush();
    assert.equal(host.querySelector(".arch-rk-ask"), null);
    assert.deepEqual(got, []);
    [...host.querySelectorAll(".arch-rk button")][0].click(); await flush();
    [...host.querySelectorAll(".arch-rk-ask button")].find((b) => b.textContent === "Forget this key").click();
    assert.deepEqual(got, ["9f3a1c7e2b40d815"]);
});

test("the notice: months still under the key are skipped; none under it is said to be safe; one month is singular", () => {
    assert.match(forgetNotice(0), /^Files under this key will ask for its passphrase or recovery key on this install\. No month in the folder is under it, so nothing there is affected\.$/);
    assert.match(forgetNotice(1), /1 month in the folder is still under it and will be skipped until another install rewrites it\./);
    assert.match(forgetNotice(4), /4 months in the folder are still under it/);
    const host = show({ report: conn({ keyring: { set: true, keyId: "k1", retired: [RK[1]] } }), keyCounts: {} });
    host.querySelector(".arch-rk button").click();
    return flush().then(() => assert.match(host.querySelector(".arch-rk-ask").textContent, /No month in the folder is under it/));
});
