// Opt-in tests against a real OpenWebUI instance — these validate the server
// assumptions the extension relies on (routes, capability metadata), which is
// where most real-world breakage has come from.
//
//   OPENWEBUI_URL=http://localhost:3000 OPENWEBUI_KEY=sk-... npm test
//
// The chat round-trip additionally requires OPENWEBUI_MODEL (explicit, so a
// test run never surprise-loads a huge model into VRAM).
const { test } = require("node:test");
const assert = require("node:assert");

const BASE = (process.env.OPENWEBUI_URL || "").replace(/\/$/, "");
const KEY = process.env.OPENWEBUI_KEY;
const MODEL = process.env.OPENWEBUI_MODEL;

const skipLive = !(BASE && KEY) && "set OPENWEBUI_URL and OPENWEBUI_KEY to run live tests";
const HEADERS = { "Content-Type": "application/json", "Authorization": `Bearer ${KEY}` };

test("live: /api/models returns a model list", { skip: skipLive }, async () => {
    const res = await fetch(`${BASE}/api/models`, { headers: HEADERS });
    assert.ok(res.ok, `HTTP ${res.status}`);
    const data = await res.json();
    const ids = (data.data || data.models || []).map(m => m.id || m.name).filter(Boolean);
    assert.ok(ids.length > 0, "no models in response");
});

test("live: /ollama/api/ps passthrough is reachable", { skip: skipLive }, async () => {
    const res = await fetch(`${BASE}/ollama/api/ps`, { headers: HEADERS });
    assert.ok(res.ok, `HTTP ${res.status}`);
    const data = await res.json();
    assert.ok(Array.isArray(data.models), "expected a models array");
});

test("live: /ollama/api/show reports capabilities", { skip: skipLive }, async () => {
    const listRes = await fetch(`${BASE}/ollama/api/tags`, { headers: HEADERS });
    assert.ok(listRes.ok, `HTTP ${listRes.status}`);
    const first = (await listRes.json()).models?.[0]?.name;
    assert.ok(first, "no Ollama models installed");

    const res = await fetch(`${BASE}/ollama/api/show`, {
        method: "POST",
        headers: HEADERS,
        body: JSON.stringify({ model: first })
    });
    assert.ok(res.ok, `HTTP ${res.status}`);
    const data = await res.json();
    assert.ok(Array.isArray(data.capabilities), "capabilities field missing — vision fail-fast would degrade");
});

test(
    "live: chat completion round trip",
    { skip: skipLive || (!MODEL && "set OPENWEBUI_MODEL (loads that model into VRAM)"), timeout: 120_000 },
    async () => {
        const res = await fetch(`${BASE}/api/chat/completions`, {
            method: "POST",
            headers: HEADERS,
            body: JSON.stringify({
                model: MODEL,
                messages: [{ role: "user", content: "Reply with exactly: OK" }],
                stream: false
            })
        });
        assert.ok(res.ok, `HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
        const data = await res.json();
        assert.equal(typeof data.choices?.[0]?.message?.content, "string");
    }
);
