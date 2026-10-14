// site-access-upgrade.test.mjs — an install's site lists, as the code before slice 3 wrote them, read by the new worker:
// the self-approval whitelist moves from `sync` hosts to `local` origins, every allowed origin gets the agent level
// "ask", and what a person sees afterwards (docs/spec/SITE_ACCESS_SLICE3.md, PR 1). Against the built bundle
// (tests/helpers.js `loadBackground`), with the real origin gate.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { jsonResponse, loadBackground } = require("./helpers");

const baseConfig = (o = {}) => ({ chatUrl: "http://host/api/chat/completions", apiKey: "sk-SECRET-KEY", model: "default-model", apiFormat: "openai", ocrModel: "", cdp: true, ...o });
const SETTINGS = { url: "chrome-extension://test/sidebar.html" };
const page = (url, id = 5) => ({ tab: { id, url }, url, origin: new URL(url).origin, frameId: 0 });
const onFetch = () => jsonResponse({ choices: [{ message: { content: "ok" } }] });

/** Storage exactly as the build before slice 3 left it: the gate's lists in local, the whitelist as hosts in sync. */
const OLD = {
    local: { ml_site_always: ["https://a.test", "http://b.test"], ml_site_denied: ["https://c.test"] },
    sync: { pageApprovalDomains: ["x.test"] },
};

/** A worker started over the old storage. */
const upgraded = (extra = {}) => loadBackground({
    config: baseConfig(structuredClone(OLD.sync)), local: { ...structuredClone(OLD.local), ...(extra.local || {}) }, siteGate: true, siteAgents: null, onFetch, ...(extra.opts || {}),
});
/** A value from the worker's realm as plain data, so it compares by structure. */
const plain = (x) => JSON.parse(JSON.stringify(x ?? null));
const levels = async (bg, origin) => plain((await bg.send({ type: "SITE_ACCESS", payload: { origin } }, SETTINGS)).data.levels);
const chat = (bg, url) => bg.send({ type: "FETCH_LLM", payload: { messages: [{ role: "user", content: "hi" }] } }, page(url));

// --- what a person sees after the upgrade ---

test("UPGRADE: a and b stay allowed with agents 'ask', c stays denied, x.test's https origin self-approves with agents always", async () => {
    const bg = upgraded();
    assert.deepEqual(await levels(bg, "https://a.test"), { use: "always", agents: "ask", selfApprove: false });
    assert.deepEqual(await levels(bg, "http://b.test"), { use: "always", agents: "ask", selfApprove: false });
    assert.deepEqual(await levels(bg, "https://c.test"), { use: "denied", agents: "off", selfApprove: false });
    assert.deepEqual(await levels(bg, "https://x.test"), { use: "always", agents: "always", selfApprove: true });
    assert.deepEqual(await levels(bg, "http://x.test"), { use: "unknown", agents: "off", selfApprove: false });
});

test("UPGRADE: the first page message that wakes the worker is judged on the migrated lists", async () => {
    // No await between the start and the messages: the migration must be finished before any of them is judged.
    const bg = upgraded();
    const [a, b, c, x, xHttp] = await Promise.all([chat(bg, "https://a.test/"), chat(bg, "http://b.test/"), chat(bg, "https://c.test/"), chat(bg, "https://x.test/"), chat(bg, "http://x.test/")]);
    assert.equal(a.data, "ok");
    assert.equal(b.data, "ok");
    assert.match(c.error, /not allowed/);
    assert.equal(x.data, "ok", "the whitelisted host's https origin is allowed by its self-approval");
    assert.match(xHttp.error, /not approved/, "its http origin is not");
});

test("UPGRADE: http://x.test is untrusted for CDP_CLICK and reads pageApprovalAllowed false, even once allowed to use window.ml", async () => {
    const bg = upgraded({ local: { ml_site_always: [...OLD.local.ml_site_always, "http://x.test"] } });
    const cdp = await bg.send({ type: "CDP_CLICK", payload: { x: 1, y: 2 } }, page("http://x.test/"));
    assert.match(String(cdp.error), /Refused/);
    assert.equal(bg.debuggerCalls.filter((c) => c[0] === "attach").length, 0);
    assert.equal((await bg.send({ type: "GET_CONFIG", payload: {} }, page("http://x.test/"))).data.pageApprovalAllowed, false);
    // Positive control: the https origin is trusted at both readers.
    assert.equal((await bg.send({ type: "GET_CONFIG", payload: {} }, page("https://x.test/"))).data.pageApprovalAllowed, true);
    const ok = await bg.send({ type: "CDP_CLICK", payload: { x: 1, y: 2 } }, page("https://x.test/"));
    assert.doesNotMatch(String(ok?.error ?? ""), /Refused/);
});

test("UPGRADE: a site allowed after the migration gets agents 'off'", async () => {
    const bg = upgraded();
    await levels(bg, "https://a.test");
    const res = await bg.send({ type: "SITE_ACCESS", payload: { origin: "https://d.test", edit: { op: "allow", origin: "https://d.test", scope: "always" } } }, SETTINGS);
    assert.deepEqual(plain(res.data.levels), { use: "always", agents: "off", selfApprove: false });
});

// --- what is stored, and a second start ---

test("UPGRADE: the new lists are in local under schema 2, the old sync setting is left for an older build on another machine", async () => {
    const bg = upgraded();
    await levels(bg, "https://a.test");
    assert.equal(bg.localStore.ml_site_schema, 2);
    assert.deepEqual(bg.localStore.ml_site_selfapprove, ["https://x.test"]);
    assert.deepEqual(bg.localStore.ml_site_agents, { "https://a.test": "ask", "http://b.test": "ask" });
    assert.deepEqual(bg.stored.pageApprovalDomains, ["x.test"], "read once, left in place");
});

test("UPGRADE: a restart after the upgrade migrates nothing again: a level the person changed stays changed, and a later sync write is not read", async () => {
    const bg = upgraded();
    await bg.send({ type: "SITE_ACCESS", payload: { edit: { op: "agents", origin: "https://a.test", level: "off" } } }, SETTINGS);
    await bg.send({ type: "SITE_ACCESS", payload: { edit: { op: "selfApprove", origin: "https://x.test", on: false } } }, SETTINGS);
    // A worker restart over the same storage, with an older build on another machine syncing a host in meanwhile.
    const again = loadBackground({ config: { ...bg.stored, pageApprovalDomains: ["x.test", "y.test"] }, local: structuredClone(bg.localStore), siteGate: true, siteAgents: null, siteAgents: null, onFetch });
    assert.deepEqual(await levels(again, "https://a.test"), { use: "always", agents: "off", selfApprove: false });
    assert.deepEqual(await levels(again, "https://x.test"), { use: "unknown", agents: "off", selfApprove: false });
    assert.deepEqual(await levels(again, "https://y.test"), { use: "unknown", agents: "off", selfApprove: false });
});

test("UPGRADE: a fresh install migrates to an empty schema 2 and allows nothing", async () => {
    const bg = loadBackground({ config: baseConfig(), siteGate: true, siteAgents: null, onFetch });
    assert.match((await chat(bg, "https://a.test/")).error, /not approved/);
    assert.equal(bg.localStore.ml_site_schema, 2);
    assert.deepEqual(bg.localStore.ml_site_selfapprove ?? [], []);
});

// --- the worker's writes: one at a time, a failed migration, an edit during it ---

test("S3: two edits sent together both land, a denial included", async () => {
    const bg = loadBackground({ config: baseConfig(), siteGate: true, siteAgents: null, onFetch, local: { ml_site_schema: 2, ml_site_always: ["https://a.test", "https://b.test", "https://c.test"], ml_site_agents: { "https://a.test": "ask", "https://b.test": "ask" } } });
    const edit = (e) => bg.send({ type: "SITE_ACCESS", payload: { edit: e } }, SETTINGS);
    await Promise.all([edit({ op: "agents", origin: "https://a.test", level: "denied" }), edit({ op: "revoke", origin: "https://b.test" }), edit({ op: "deny", origin: "https://c.test" }), edit({ op: "allow", origin: "https://d.test", scope: "always" })]);
    assert.deepEqual(await levels(bg, "https://a.test"), { use: "always", agents: "denied", selfApprove: false });
    assert.deepEqual(await levels(bg, "https://b.test"), { use: "unknown", agents: "off", selfApprove: false });
    assert.deepEqual(await levels(bg, "https://c.test"), { use: "denied", agents: "off", selfApprove: false });
    assert.deepEqual(await levels(bg, "https://d.test"), { use: "always", agents: "off", selfApprove: false });
});

test("UPGRADE: a migration whose write fails leaves no self-approval and no agent level (fails closed), and is tried again", async () => {
    const bg = upgraded();
    const local = bg.context.chrome.storage.local;
    const realSet = local.set;
    let failed = 0;
    local.set = async (obj) => { if ("ml_site_schema" in obj && failed === 0) { failed++; throw new Error("QUOTA_BYTES quota exceeded"); } return realSet(obj); };
    // The first reader meets the failed migration: the whitelisted https origin is not allowed and not trusted.
    assert.match((await chat(bg, "https://x.test/")).error, /not approved/);
    assert.equal(failed, 1);
    assert.equal(bg.localStore.ml_site_schema, undefined);
    // An edit is refused rather than applied to the lists in the old layout.
    const e = await bg.send({ type: "SITE_ACCESS", payload: { edit: { op: "allow", origin: "https://d.test", scope: "always" } } }, SETTINGS);
    assert.ok(e.error || plain(e.data?.lists?.always ?? []).includes("https://d.test"), "an edit either waits for a migration that worked or is refused");
    // The next reader tries again, and it works.
    assert.equal((await chat(bg, "https://x.test/")).data, "ok");
    assert.equal(bg.localStore.ml_site_schema, 2);
    // And a worker that starts over storage whose migration never landed migrates then.
    const again = loadBackground({ config: baseConfig(structuredClone(OLD.sync)), local: structuredClone(OLD.local), siteGate: true, siteAgents: null, siteAgents: null, onFetch });
    assert.deepEqual(await levels(again, "https://x.test"), { use: "always", agents: "always", selfApprove: true });
});

test("UPGRADE: an edit sent while the migration runs is not lost to it", async () => {
    const bg = upgraded();
    // Sent at once, before the migration's own write.
    const [a, x] = await Promise.all([
        bg.send({ type: "SITE_ACCESS", payload: { edit: { op: "agents", origin: "https://a.test", level: "always" } } }, SETTINGS),
        bg.send({ type: "SITE_ACCESS", payload: { edit: { op: "selfApprove", origin: "https://x.test", on: false } } }, SETTINGS),
    ]);
    assert.ok(a.data && x.data);
    assert.deepEqual(await levels(bg, "https://a.test"), { use: "always", agents: "always", selfApprove: false });
    assert.deepEqual(await levels(bg, "https://x.test"), { use: "unknown", agents: "off", selfApprove: false });
    assert.equal(bg.localStore.ml_site_agents["http://b.test"], "ask", "the migration's own levels landed too");
});

test("UPGRADE: entries that could not be carried over are named in the notice, also when none could", async () => {
    const bg = loadBackground({ config: baseConfig({ pageApprovalDomains: ["*.x.test", "y.test:8443"] }), siteGate: true, siteAgents: null, onFetch });
    const res = plain((await bg.send({ type: "SITE_ACCESS", payload: {} }, SETTINGS)).data);
    assert.equal(res.upgradeNotice, true);
    assert.deepEqual(res.upgradeDropped, ["*.x.test", "y.test:8443"]);
    assert.deepEqual(res.lists.selfApprove, []);
});
