// tests/self-approval-origin.test.js — the self-approval list trusts one ORIGIN per entry, the same one the site gate
// approves, at every reader, against the real bundle. The tests seed the old sync whitelist (`pageApprovalDomains`), which
// the worker migrates at start into the local list of origins (`ml_site_selfapprove`), so they also hold across the upgrade.
//
// A bare host on the whitelist means `https://host` on the default port. Every check that consults the whitelist
// (`senderTrust` for the privileged handlers, `publicConfig`'s `pageApprovalAllowed`, the site gate's implied approval)
// goes through one rule (site-access.ts `selfApproves`), so plain http, another port, a subdomain or a sub-frame of a
// whitelisted host is never trusted as the https site. The table below is every sender shape x every reader.
const { test } = require("node:test");
const assert = require("node:assert");
const { jsonResponse, loadBackground } = require("./helpers");

const baseConfig = (o = {}) => ({ chatUrl: "http://host/api/chat/completions", apiKey: "sk-SECRET-KEY", model: "default-model", apiFormat: "openai", ocrModel: "", cdp: true, ...o });
const WHITELIST = ["trusted.example"];

/** A content script's message from `url`, as Chrome stamps it. `origin`/`frameId` are left out when null. */
const page = (url, { origin, frameId = 0, id = 5 } = {}) => ({ tab: { id, url }, url, ...(origin !== null ? { origin: origin ?? new URL(url).origin } : {}), ...(frameId !== null ? { frameId } : {}) });

/** One of the extension's own frames (the overlay sidebar) inside the tab at `tabUrl`. */
const extFrame = (tabUrl) => ({ tab: { id: 5, url: tabUrl }, url: "chrome-extension://test/sidebar.html", origin: "chrome-extension://test", frameId: 4, extension: true });

// --- the sender shapes: one positive control, and every shape a host match confuses with it ---

/** [label, sender, may it act as the whitelisted site]. */
const SENDERS = [
    ["https, the whitelisted origin (positive control)", page("https://trusted.example/p"), true],
    ["https, no origin or frame field (tab URL only)", page("https://trusted.example/p", { origin: null, frameId: null }), true],
    ["plain http, same host", page("http://trusted.example/p"), false],
    ["https, another port", page("https://trusted.example:8443/p"), false],
    ["http, another port", page("http://trusted.example:8080/p"), false],
    ["a subdomain", page("https://sub.trusted.example/p"), false],
    ["a suffix lookalike", page("https://trusted.example.evil.test/p"), false],
    ["a sub-frame of the whitelisted origin", page("https://trusted.example/f", { frameId: 3 }), false],
    ["an opaque origin on the whitelisted URL", page("https://trusted.example/p", { origin: "null" }), false],
    ["another origin claiming the whitelisted URL", page("https://trusted.example/p", { origin: "https://evil.example" }), false],
    // The extension's own frame inside a tab (the overlay sidebar's Python bench) speaks for the tab it sits in.
    ["the extension's frame in the whitelisted https tab", { ...extFrame("https://trusted.example/p") }, true],
    ["the extension's frame in an http tab of the host", { ...extFrame("http://trusted.example/p") }, false],
];

const refused = (res) => /Refused/.test(String(res?.error ?? ""));

// --- the readers: each privileged handler that trusts a whitelisted sender, and what "trusted" looks like there ---

/** [label, run(bg, sender) → whether the sender got the whitelisted site's privilege]. The site gate is the harness's
 *  default here (the sender's own origin approved for window.ml), so each reader is reached and judged on its own. */
const READERS = [
    ["CDP_CLICK (trusted-input debugger click)", async (bg, s) => {
        const res = await bg.send({ type: "CDP_CLICK", payload: { x: 1, y: 2 } }, s);
        return !refused(res) && bg.debuggerCalls.some((c) => c[0] === "attach");
    }],
    ["GET_CONFIG pageApprovalAllowed (the page's own approve() gate)", async (bg, s) => {
        const res = await bg.send({ type: "GET_CONFIG", payload: {} }, s);
        return res?.data?.pageApprovalAllowed === true;
    }],
    ["SERVER_TOOL_EXEC without a grant", async (bg, s) => {
        const res = await bg.send({ type: "SERVER_TOOL_EXEC", payload: { toolId: "srv1", name: "search_web", args: {} } }, s);
        return !refused(res);
    }],
    ["FETCH_SHEET without a grant (the person's Google cookies)", async (bg, s) => {
        const res = await bg.send({ type: "FETCH_SHEET", payload: { url: "https://docs.google.com/spreadsheets/d/A/export?format=csv&gid=0" } }, s);
        return !refused(res);
    }],
    ["PYTHON_EXEC outside the dialect without a grant", async (bg, s) => {
        const res = await bg.send({ type: "PYTHON_EXEC", payload: { code: "1+1" } }, s);
        return !refused(res);
    }],
    ["FETCH_URL credentialed, cross-origin, without a grant", async (bg, s) => {
        const res = await bg.send({ type: "FETCH_URL", payload: { url: "https://other.example/private", credentials: true } }, s);
        return !refused(res);
    }],
    ["FETCH_URL uncredentialed, cross-origin, without consent", async (bg, s) => {
        const res = await bg.send({ type: "FETCH_URL", payload: { url: "https://other.example/public" } }, s);
        return !refused(res);
    }],
];

const onFetch = (call) => /chat\/completions/.test(call.url)
    ? jsonResponse({ choices: [{ message: { content: "ok" } }] })
    : { ok: true, status: 200, url: call.url, headers: { get: () => "text/csv" }, text: async () => "a,b\n1,2\n", json: async () => ({}) };

test("every reader of the self-approval whitelist trusts the https origin only, for every sender shape", async () => {
    const wrong = [];
    for (const [reader, run] of READERS) for (const [shape, sender, wantBase] of SENDERS) {
        const bg = loadBackground({ config: baseConfig({ pageApprovalDomains: WHITELIST }), onFetch, onPyRun: async () => ({ ok: true, value: 2, stdout: "" }) });
        const got = await run(bg, structuredClone(sender));
        // Python has no unhardened mode any more, so the extension's own frame (the bench) needs no whitelist to run a cell:
        // the network power that rule guarded is gone.
        const want = reader.startsWith("PYTHON_EXEC") && /extension's frame/.test(shape) ? true : wantBase;
        if (got !== want) wrong.push(`${reader} x ${shape}: ${got ? "trusted" : "refused"}, want ${want ? "trusted" : "refused"}`);
    }
    assert.deepEqual(wrong, []);
});

test("approving http://host for window.ml does not make it self-approving: the whitelist is https://host", async () => {
    // The person allowed the http origin to USE window.ml (site gate), and the host is on the whitelist. Someone on the
    // network path who injects into http://host gets window.ml, but none of the https site's self-approval.
    const http = page("http://trusted.example/p");
    for (const [reader, run] of READERS) {
        const bg = loadBackground({ config: baseConfig({ pageApprovalDomains: WHITELIST }), siteGate: true, local: { ml_site_always: ["http://trusted.example"] }, onFetch, onPyRun: async () => ({ ok: true, value: 2, stdout: "" }) });
        assert.equal(await run(bg, structuredClone(http)), false, reader);
    }
});

// --- the site gate's implied approval reads the same rule ---

test("the site gate's whitelist approval is the https origin only, for every sender shape", async () => {
    const wrong = [];
    // The gate judges pages; the extension's own frames are not under it.
    for (const [shape, sender, want] of SENDERS.filter(([, s]) => !s.extension)) {
        const bg = loadBackground({ config: baseConfig({ pageApprovalDomains: WHITELIST }), siteGate: true, onFetch });
        const res = await bg.send({ type: "FETCH_LLM", payload: { messages: [{ role: "user", content: "hi" }] } }, structuredClone(sender));
        const got = res?.data === "ok";
        if (got !== want) wrong.push(`FETCH_LLM x ${shape}: ${got ? "allowed" : res?.error}`);
    }
    assert.deepEqual(wrong, []);
});

test("the popup's question about an origin answers 'always, implied' for the https origin only", async () => {
    const bg = loadBackground({ config: baseConfig({ pageApprovalDomains: WHITELIST }), siteGate: true });
    const ask = async (origin) => (await bg.send({ type: "SITE_ACCESS", payload: { origin } }, { url: "chrome-extension://test/popup.html" })).data;
    assert.deepEqual([(await ask("https://trusted.example")).decision, (await ask("https://trusted.example")).implied], ["always", true], "positive control");
    for (const o of ["http://trusted.example", "https://trusted.example:8443", "https://sub.trusted.example", "http://trusted.example:8080"])
        assert.equal((await ask(o)).decision, "unknown", o);
});

// --- the upgrade: a whitelist of hosts, as every earlier build stored it ---

test("UPGRADE: a stored whitelist of bare hosts keeps working for https senders, at every reader", async () => {
    // What settings.tsx and popup.ts `normDomain` wrote to sync: normalised hostnames, several of them.
    const stored = ["docs.example", "trusted.example", "127.0.0.1"];
    for (const [reader, run] of READERS) for (const host of stored) {
        const bg = loadBackground({ config: baseConfig({ pageApprovalDomains: stored }), onFetch, onPyRun: async () => ({ ok: true, value: 2, stdout: "" }) });
        assert.equal(await run(bg, page(`https://${host}/any`)), true, `${reader} x https://${host}`);
    }
});

test("UPGRADE: a bare loopback or LAN entry no longer self-approves the http ports it covered by host, at every reader, until the origin is added", async () => {
    // What an install before #628 held: bare hosts on the whitelist, and the http origins allowed in the site gate so
    // those pages could use window.ml at all. Each self-approved by host before; now each needs its exact origin.
    const stored = ["localhost", "127.0.0.1", "mlbox.lan"];
    const always = ["http://localhost:3000", "http://127.0.0.1:8080", "http://mlbox.lan:8080"];
    const wrong = [];
    for (const [entries, want] of [[stored, false], [[...stored, ...always], true]])
        for (const [reader, run] of READERS) for (const o of always) {
            const bg = loadBackground({ config: baseConfig({ pageApprovalDomains: entries }), siteGate: true, local: { ml_site_always: always }, onFetch, onPyRun: async () => ({ ok: true, value: 2, stdout: "" }) });
            const got = await run(bg, page(`${o}/app`));
            if (got !== want) wrong.push(`${reader} x ${o} (${entries.length} entries): ${got ? "trusted" : "refused"}, want ${want ? "trusted" : "refused"}`);
        }
    assert.deepEqual(wrong, []);
});

test("a whitelisted origin also approved for this session self-approves, at every reader", async () => {
    const wrong = [];
    for (const [reader, run] of READERS) {
        const bg = loadBackground({ config: baseConfig({ pageApprovalDomains: WHITELIST }), siteGate: true, session: { ml_site_session: ["https://trusted.example"] }, onFetch, onPyRun: async () => ({ ok: true, value: 2, stdout: "" }) });
        if (!await run(bg, page("https://trusted.example/p"))) wrong.push(reader);
    }
    assert.deepEqual(wrong, []);
});

// --- every reader is enumerated: nothing else reads the whitelist ---

test("the whitelist is read only through the one rule: no other source file matches a sender against it", () => {
    const fs = require("node:fs");
    const path = require("node:path");
    const root = path.join(__dirname, "../src");
    const files = [];
    const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (/\.tsx?$/.test(e.name) && !/\.gen\.ts$/.test(e.name)) files.push(p); } };
    walk(root);
    const readers = files.filter((f) => /pageApprovalDomains/.test(fs.readFileSync(f, "utf8"))).map((f) => path.relative(root, f).split(path.sep).join("/")).sort();
    // Since slice 3 the sync setting is read ONCE, by the migration (sw-site-access.ts) into the local list of origins,
    // through site-access.ts's rule. The config type and default only declare it; no editor or watcher names it.
    // A restore of an old backup (backup/backup-settings.ts) runs the same migration over the backup's copy of the setting.
    assert.deepEqual(readers, ["backup/backup-settings.ts", "contract/contract-config.ts", "site-access.ts", "sw/sw-site-access.ts"]);
    // Pinned to the LINE as well, so a new reader inside one of those files fails here too: the sync setting is read by
    // the migration and nowhere else. Comments are left out.
    const uses = [];
    for (const f of files) {
        const rel = path.relative(root, f).split(path.sep).join("/");
        for (const raw of fs.readFileSync(f, "utf8").split("\n")) {
            const line = raw.trim();
            if (/^(\/\/|\*|\/\*)/.test(line)) continue;
            const code = line.replace(/\s\/\/\s.*$/, "").replace(/\s+/g, " ");
            if (/pageApprovalDomains/.test(code)) uses.push(`${rel}: ${code}`);
        }
    }
    assert.deepEqual(uses.sort(), [
        "backup/backup-settings.ts: const legacyHosts = sync.pageApprovalDomains;",
        // not a read: the key's row in the restore's risky list, which says what restoring it does
        "backup/backup-settings.ts: pageApprovalDomains: \"the old self-approval whitelist: its sites are migrated into the self-approval list, which grants use\",",
        "contract/contract-config.ts: pageApprovalDomains: [],",
        "contract/contract-config.ts: pageApprovalDomains: string[];",
        "sw/sw-site-access.ts: const [stored, sync] = await Promise.all([readStored(), chrome.storage.sync.get({ pageApprovalDomains: [] }).catch(none)]);",
        "sw/sw-site-access.ts: const syncHosts = (sync as Record<string, unknown>).pageApprovalDomains;",
    ].sort(), "a new read of the whitelist: route it through selfApproves (site-access.ts), then add its line here");
    const config = fs.readFileSync(path.join(root, "contract/contract-config.ts"), "utf8");
    assert.doesNotMatch(config.replace(/\/\*\*[\s\S]*?\*\//g, ""), /\.pageApprovalDomains/, "contract-config.ts matches against the whitelist itself");
});
