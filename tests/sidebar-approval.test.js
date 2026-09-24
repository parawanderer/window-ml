// sidebar-approval.test.js — the approval gate in both surfaces: what a card SAYS it will do, the host
// it grants in the same gesture, the raise it is asking for, and how a decided step then reads.

const { test, after } = require("node:test");
const assert = require("node:assert");
const { closeSidebarWorlds, loadSidebarWorld } = require("./helpers");
const { agentStart, agentStep, agentResult, openSettings, sidebarCss } = require("./sidebar-helpers");

// Close every jsdom window after the file — the VRAM panel's setInterval keeps a
// window's timers alive, which would otherwise hang the runner after all pass.
after(closeSidebarWorlds);

const grantStep = (hash) => agentStep(hash, 1, {
    seq: 1, pending: true, awaitingApproval: true, tool: "exec",
    arguments: { js: 'await ml.fetch("https://x.test/a.json"); await ml.fetch("https://x.test/b.json")' },
    grants: [{ kind: "fetch-url", urls: ["https://x.test/a.json", "https://x.test/b.json"] }],
});

// The CDP master toggle (Settings → Advanced). `debugger` is an INSTALL-time permission; the toggle just
// gates USAGE (runtime-requesting `debugger` from the embedded settings iframe returns denied — unreliable).
const cdpToggle = (w) => [...w.shadow.querySelectorAll(".set-check")].find(l => /debugger-based actions/i.test(l.textContent))?.querySelector('input[type=checkbox]');

// --- button #3 — Approve + remember: the click in both surfaces, and what it persists --------------------

test("button #3 (sidebar step): 'Approve + remember' renders, unfurls its URLs, and posts persist:true", async () => {
    const w = await loadSidebarWorld();
    await w.dispatch(agentStart("b3s", "fetch stuff"));
    await w.dispatch(grantStep("b3s"));
    w.shadow.querySelector(".row").click();
    await w.tick();

    const remember = w.shadow.querySelector(".astep-approve .appr-btn.remember");
    assert.ok(remember, "the short 'Keep' button rendered on the awaiting step");
    assert.match(remember.textContent, /keep/i);
    // The collapsed grant card summarises deterministically and lists EXACTLY the URLs that persist.
    const grant = w.shadow.querySelector(".astep-approve .appr-grant");
    assert.ok(grant, "the grant card rendered");
    assert.match(grant.querySelector(".appr-grant-sum").textContent, /fetch 2 URLs.*without approval/i, "explains the grant in plain terms");
    const urls = [...grant.querySelectorAll(".grant-url-list code")].map(n => n.textContent);
    assert.deepEqual(urls, ["https://x.test/a.json", "https://x.test/b.json"], "the exact two literals");

    const posted = [];
    w.window.postMessage = (d) => posted.push(d);
    remember.click();
    const msg = posted.find(m => m.__mlSidebarApp === "approval");
    assert.ok(msg, "clicking posts an approval message");
    assert.equal(msg.decision, true, "it approves");
    assert.equal(msg.persist, true, "…and asks to persist (button #3)");
    assert.equal(msg.hash, "b3s");
    assert.equal(msg.seq, 1);
});

test("button #3 (sidebar step): plain Approve posts persist:false (one-off)", async () => {
    const w = await loadSidebarWorld();
    await w.dispatch(agentStart("b3s2", "fetch stuff"));
    await w.dispatch(grantStep("b3s2"));
    w.shadow.querySelector(".row").click();
    await w.tick();
    const posted = [];
    w.window.postMessage = (d) => posted.push(d);
    // The plain Approve is the .yes button that is NOT .remember.
    const approve = [...w.shadow.querySelectorAll(".astep-approve .appr-btn.yes")].find(b => !b.classList.contains("remember"));
    approve.click();
    const msg = posted.find(m => m.__mlSidebarApp === "approval");
    assert.equal(msg.decision, true);
    assert.equal(msg.persist, false, "plain Approve does NOT persist");
});

test("button #3 (sidebar step): a gate with NO grants shows no remember button", async () => {
    const w = await loadSidebarWorld();
    await w.dispatch(agentStart("b3s3", "click something"));
    await w.dispatch(agentStep("b3s3", 1, { seq: 1, pending: true, awaitingApproval: true, tool: "click", arguments: { selector: "#go" } }));
    w.shadow.querySelector(".row").click();
    await w.tick();
    assert.ok(w.shadow.querySelector(".astep-approve"), "the approval bar rendered");
    assert.equal(w.shadow.querySelector(".astep-approve .appr-btn.remember"), null, "no Keep button without grants");
    assert.equal(w.shadow.querySelector(".astep-approve .appr-grant"), null, "and no grant card");
});

test("button #3 (HUD card): 'Approve + remember' renders in the card foot and posts persist:true", async () => {
    const w = await loadSidebarWorld();
    await w.raw({ __mlSidebarSurface: "card" });   // become the off-mode corner card
    await w.dispatch(agentStart("b3c", "fetch stuff"));
    await w.dispatch(grantStep("b3c"));
    await w.tick();

    const remember = w.shadow.querySelector(".card-foot .appr-btn.remember");
    assert.ok(remember, "the 'Approve + remember' button rendered in the card footer");
    const posted = [];
    w.window.postMessage = (d) => posted.push(d);
    remember.click();
    const msg = posted.find(m => m.__mlSidebarApp === "approval");
    assert.ok(msg && msg.decision === true && msg.persist === true, "card posts approval with persist:true");
    assert.equal(msg.hash, "b3c");
    // The Keep button carries the deliberate two-key hint (⌘K / Ctrl K), not an Enter-adjacent combo.
    assert.match(remember.textContent, /(⌘K|Ctrl K)/);
});

test("button #3 (HUD card): ⌘K/Ctrl+K is a deliberate Approve+Keep combo; plain Enter is Approve-only", async () => {
    const w = await loadSidebarWorld();
    await w.raw({ __mlSidebarSurface: "card" });
    await w.dispatch(agentStart("kbk", "fetch stuff"));
    await w.dispatch(grantStep("kbk"));
    await w.flush();
    const posted = [];
    w.window.postMessage = (d) => posted.push(d);
    // The two-key combo (Ctrl/⌘ + K) approves AND remembers.
    w.window.dispatchEvent(new w.window.KeyboardEvent("keydown", { key: "k", ctrlKey: true, bubbles: true }));
    const keep = posted.find(m => m.__mlSidebarApp === "approval");
    assert.ok(keep, "⌘/Ctrl+K resolves the gate");
    assert.equal(keep.decision, true);
    assert.equal(keep.persist, true, "…and persists (it's Keep, not plain Approve)");
});

test("button #3 (HUD card): plain Enter approves WITHOUT persisting (Keep is only the two-key combo)", async () => {
    const w = await loadSidebarWorld();
    await w.raw({ __mlSidebarSurface: "card" });
    await w.dispatch(agentStart("kbe", "fetch stuff"));
    await w.dispatch(grantStep("kbe"));
    await w.flush();
    const posted = [];
    w.window.postMessage = (d) => posted.push(d);
    w.window.dispatchEvent(new w.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    const msg = posted.find(m => m.__mlSidebarApp === "approval");
    assert.ok(msg && msg.decision === true, "Enter approves");
    assert.equal(msg.persist, false, "…but does NOT persist — Keep requires the deliberate combo");
});

// --- granting a host: the origin note, the Chrome prompt, and the settings list --------------------------

test("host access (fetch_url): a first-time origin shows the note; approving requests that host in the same gesture", async () => {
    const w = await loadSidebarWorld();
    const reqCalls = [];
    w.window.chrome.permissions = {
        contains: async () => false,   // host not yet granted (Chrome withholds <all_urls> under "On click")
        request: async ({ origins }) => { reqCalls.push(origins); return true; },
    };
    await w.dispatch(agentStart("ha", "fetch it"));
    await w.dispatch(agentStep("ha", 1, {
        seq: 1, pending: true, awaitingApproval: true, tool: "fetch_url",
        arguments: { url: "https://raw.githubusercontent.com/o/r/main/x.json" },
        renderIn: { type: "action", verb: "fetch", target: "https://raw.githubusercontent.com/o/r/main/x.json" },
    }));
    w.shadow.querySelector(".row").click();
    await w.flush();
    const note = w.shadow.querySelector(".action-host");
    assert.ok(note, "the first-time host-access note rendered");
    assert.match(note.textContent, /raw\.githubusercontent\.com/, "names the site being granted");
    // Approving requests that exact host pattern (gesture-preserved), then posts the decision.
    const posted = [];
    w.window.postMessage = (d) => posted.push(d);
    w.shadow.querySelector(".astep-approve .appr-btn.yes").click();
    await w.flush();
    assert.deepEqual(reqCalls[0], ["https://raw.githubusercontent.com/*"], "requested the target's host pattern");
    assert.ok(posted.find(m => m.__mlSidebarApp === "approval" && m.decision === true), "and the approval was still posted");
});

test("host access (fetch_url): an ALREADY-granted origin shows no note", async () => {
    const w = await loadSidebarWorld();
    w.window.chrome.permissions = { contains: async () => true, request: async () => true };
    await w.dispatch(agentStart("ha2", "fetch it"));
    await w.dispatch(agentStep("ha2", 1, {
        seq: 1, pending: true, awaitingApproval: true, tool: "fetch_url",
        arguments: { url: "https://x.test/a.json" },
        renderIn: { type: "action", verb: "fetch", target: "https://x.test/a.json" },
    }));
    w.shadow.querySelector(".row").click();
    await w.flush();
    assert.equal(w.shadow.querySelector(".action-host"), null, "no note when the host is already granted");
});

test("host access (fetch_url): the user clicks NO on Chrome's host prompt → the approval still posts (fetch runs, then fails gracefully)", async () => {
    const w = await loadSidebarWorld();
    const reqCalls = [];
    // Chrome's native grant prompt is DENIED: request resolves false (not a throw).
    w.window.chrome.permissions = {
        contains: async () => false,
        request: async ({ origins }) => { reqCalls.push(origins); return false; },
    };
    await w.dispatch(agentStart("hn", "fetch it"));
    await w.dispatch(agentStep("hn", 1, {
        seq: 1, pending: true, awaitingApproval: true, tool: "fetch_url",
        arguments: { url: "https://raw.githubusercontent.com/o/r/main/x.json" },
        renderIn: { type: "action", verb: "fetch", target: "https://raw.githubusercontent.com/o/r/main/x.json" },
    }));
    w.shadow.querySelector(".row").click();
    await w.flush();
    const posted = [];
    w.window.postMessage = (d) => posted.push(d);
    w.shadow.querySelector(".astep-approve .appr-btn.yes").click();
    await w.flush();
    // The host grant was attempted (in-gesture) but DENIED — yet the approval is still sent: the tool
    // runs and the background fetch returns its actionable "grant host access" error for the model to see.
    assert.deepEqual(reqCalls[0], ["https://raw.githubusercontent.com/*"], "still requested the host in-gesture");
    assert.ok(posted.find(m => m.__mlSidebarApp === "approval" && m.decision === true), "approval posted despite the denied host grant");
});

test("host access (navigate): approving a CROSS-SITE navigate grants the destination host in the same gesture", async () => {
    const w = await loadSidebarWorld();
    const reqCalls = [];
    w.window.chrome.permissions = {
        contains: async () => false,   // destination host not yet granted (needed to re-inject the content script there)
        request: async ({ origins }) => { reqCalls.push(origins); return true; },
    };
    await w.dispatch(agentStart("nv", "go to the docs"));
    await w.dispatch(agentStep("nv", 1, {
        seq: 1, pending: true, awaitingApproval: true, tool: "navigate",
        arguments: { url: "https://docs.other.dev/guide" },
        renderIn: { type: "action", verb: "navigate", target: "https://docs.other.dev/guide", crossOrigin: "docs.other.dev" },
    }));
    w.shadow.querySelector(".row").click();
    await w.flush();
    const note = w.shadow.querySelector(".action-host");
    assert.ok(note, "the first-time host-access note renders for a cross-site navigate too");
    assert.match(note.textContent, /docs\.other\.dev/, "names the destination site");
    assert.match(note.textContent, /after navigating/, "the reason is navigate-specific, not the fetch wording");
    const posted = [];
    w.window.postMessage = (d) => posted.push(d);
    w.shadow.querySelector(".astep-approve .appr-btn.yes").click();
    await w.flush();
    assert.deepEqual(reqCalls[0], ["https://docs.other.dev/*"], "requested the destination's host pattern in-gesture");
    assert.ok(posted.find(m => m.__mlSidebarApp === "approval" && m.decision === true), "and the approval was posted");
});

test("Settings → Site access: a long granted list is filterable (it gets spammed fast)", async () => {
    const w = await loadSidebarWorld();
    const many = ["ani.sidestore.io", "ani.sidestore.app", "ani.npeg.us", "api.github.com", "github.com", "raw.githubusercontent.com", "www.youtube.com"].map(h => `https://${h}/*`);
    w.window.chrome.permissions = {
        getAll: (cb) => cb({ origins: many }),
        remove: (_o, cb) => cb(true), request: (_o, cb) => cb(true),
        onAdded: { addListener() {}, removeListener() {} }, onRemoved: { addListener() {}, removeListener() {} },
    };
    await openSettings(w, "Permissions");
    await w.flush();
    const sect = () => [...w.shadow.querySelectorAll(".set-section")].find(s => /Site access/.test(s.querySelector(".set-group")?.textContent || ""));
    const hosts = () => [...sect().querySelectorAll(".perm-host")].map(e => e.textContent);
    assert.equal(hosts().length, 7, "all granted hosts show initially");
    // ONE box: typing a partial word filters the granted list (no separate search field).
    const filter = sect().querySelector(".perm-add .perm-input");
    assert.ok(filter, "the add/filter input is present");
    filter.value = "github";
    filter.dispatchEvent(new w.window.Event("input", { bubbles: true }));
    await w.tick();
    const shown = hosts();
    assert.deepEqual(shown.sort(), ["api.github.com", "github.com", "raw.githubusercontent.com"], "only matching sites remain");
    // A partial word isn't a valid hostname → Add stays disabled (it's a filter, not an add).
    assert.equal(sect().querySelector(".perm-add .test-btn").disabled, true, "Add is disabled for a partial filter");
});

test("Settings → Site access: granted hosts list, revoke, and add (mirrors the popup)", async () => {
    const w = await loadSidebarWorld();
    const removed = [], requested = [];
    let origins = ["https://raw.githubusercontent.com/*", "https://api.example.com/*"];
    w.window.chrome.permissions = {
        getAll: (cb) => cb({ origins }),
        remove: ({ origins: o }, cb) => { removed.push(o); origins = origins.filter(x => !o.includes(x)); cb(true); },
        request: ({ origins: o }, cb) => { requested.push(o); origins = [...origins, ...o]; cb(true); },
        onAdded: { addListener() {}, removeListener() {} },
        onRemoved: { addListener() {}, removeListener() {} },
    };
    await openSettings(w, "Permissions");
    await w.flush();
    // Scope to the "Site access" section — the self-approval whitelist above it also uses .perm-* classes.
    const sect = () => [...w.shadow.querySelectorAll(".set-section")].find(s => /Site access/.test(s.querySelector(".set-group")?.textContent || ""));
    const hosts = () => [...sect().querySelectorAll(".perm-host")].map(e => e.textContent);
    assert.ok(hosts().includes("raw.githubusercontent.com"), "lists a granted host (label stripped of scheme/glob)");
    assert.ok(hosts().includes("api.example.com"), "lists all granted hosts");
    // Revoke one → chrome.permissions.remove with its origin pattern, and it drops from the list.
    const chip = [...sect().querySelectorAll(".perm-chip")].find(c => c.textContent.includes("api.example.com"));
    chip.querySelector(".perm-x").click();
    await w.flush();
    assert.deepEqual(removed[0], ["https://api.example.com/*"], "revoke requests removal of that exact origin");
    assert.ok(!hosts().includes("api.example.com"), "revoked host disappears from the list");
    // Add a new one via the input → chrome.permissions.request with the derived pattern.
    const input = sect().querySelector(".perm-add .perm-input");
    input.value = "docs.example.org";
    input.dispatchEvent(new w.window.Event("input", { bubbles: true }));
    await w.tick();
    [...sect().querySelectorAll(".perm-add .test-btn")].find(b => b.textContent.trim() === "Add").click();
    await w.flush();
    assert.deepEqual(requested[requested.length - 1], ["https://docs.example.org/*"], "add requests the typed host's pattern");
    assert.ok(hosts().includes("docs.example.org"), "the newly granted host appears");
});

test("Settings → Site access: 'On all sites' (<all_urls>) shows the note instead of an add form", async () => {
    const w = await loadSidebarWorld();
    w.window.chrome.permissions = {
        getAll: (cb) => cb({ origins: ["<all_urls>"] }),
        remove: (_o, cb) => cb(true), request: (_o, cb) => cb(true),
        onAdded: { addListener() {}, removeListener() {} }, onRemoved: { addListener() {}, removeListener() {} },
    };
    await openSettings(w, "Permissions");
    await w.flush();
    const sect = [...w.shadow.querySelectorAll(".set-section")].find(s => /Site access/.test(s.querySelector(".set-group")?.textContent || ""));
    assert.ok(sect, "the Site access section rendered");
    assert.match(sect.textContent, /all sites/i, "explains that all-sites access is granted");
    assert.equal(sect.querySelector(".perm-add"), null, "no add form when everything is already allowed");
});

test("Settings CDP toggle: enabling just flips the `cdp` flag (no fragile runtime permission request)", async () => {
    const w = await loadSidebarWorld();
    let requested = false;
    w.window.chrome.permissions = { contains: (_q, cb) => cb(true), request: () => { requested = true; } };   // install-time → granted
    await openSettings(w, "Advanced");
    const cb = cdpToggle(w);
    assert.ok(cb, "the CDP toggle renders under Advanced");
    assert.equal(cb.checked, false, "off by default");
    cb.checked = true; cb.dispatchEvent(new w.window.Event("change", { bubbles: true }));
    await w.flush();
    assert.equal(w.syncStore.cdp, true, "enabling persists the flag ON");
    assert.equal(requested, false, "it does NOT call the unreliable runtime permission request");
    assert.match([...w.shadow.querySelectorAll(".set-hint")].map(e => e.textContent).join(" "), /Ready/i, "shows the granted/ready note");
});

test("Settings CDP toggle: flag ON but the debugger permission is INACTIVE → an actionable reload note", async () => {
    const w = await loadSidebarWorld({ sync: { cdp: true } });
    w.window.chrome.permissions = { contains: (_q, cb) => cb(false) };   // e.g. an update pending re-approval
    await openSettings(w, "Advanced");
    await w.flush();
    const hint = [...w.shadow.querySelectorAll(".set-hint")].map(e => e.textContent).join(" ");
    assert.match(hint, /isn't active|reload the extension/i, "guides the user to reload + accept, not a dead end");
});

// --- what an approval SAYS it will do, and the raise it is asking for ------------------------------------

test("an approval SAYS what it will do, and says it once", async () => {
    // The consent surface's one job is to be read. Naming the TOOL ("Approve running fetch_url?") named the least
    // interesting part of the call — the host is what a person judges — and unfurling the arguments underneath a
    // sentence that already carries the host stated the same fact twice.
    const w = await loadSidebarWorld();
    await w.dispatch(agentStart("say", "fetch it"));
    await w.dispatch(agentStep("say", 1, {
        seq: 1, pending: true, awaitingApproval: true, tool: "fetch_url",
        arguments: { url: "https://transavia.example/fare-rules/" },
        renderIn: { type: "action", verb: "fetch", target: "https://transavia.example/fare-rules/" },
    }));
    w.shadow.querySelector(".row").click();
    await w.flush();
    const card = w.shadow.querySelector(".astep-approve");
    assert.match(card.textContent, /Agent wants to fetch/, "the sentence, not the tool name");
    assert.match(card.textContent, /transavia\.example/, "and the host it is judged on");
    assert.doesNotMatch(card.textContent, /Approve running/, "the tool-name question is gone where a sentence exists");
    // THE BUSY VIEW keeps the whole debug render — it is the developer's projection of the run, the same trace the
    // DevTools panel draws, and there the raw call is the point.
    assert.ok(w.shadow.querySelectorAll(".astep.tool .io").length > 0, "the arguments are unfurled in the busy view");
    // In FOCUS the sentence is enough: unfurling them too states the fact being judged twice.
    w.shadow.querySelector('[aria-label="Focus mode"]').click();
    await w.tick();
    assert.equal(w.shadow.querySelectorAll(".astep.tool .io").length, 0, "the In does not auto-open behind the sentence");
    assert.match(w.shadow.querySelector(".astep-approve").textContent, /Agent wants to fetch/, "the sentence stays");
    // Both answers are still there, and Deny is still called Deny — it is a decision, not a step being skipped.
    assert.ok(w.shadow.querySelector(".astep-approve .appr-btn.yes"), "approve");
    assert.match(w.shadow.querySelector(".astep-approve .appr-btn.no").textContent, /Deny/);
});

test("a fetch AS THE USER says so as its own fact, not as a dimmed aside", async () => {
    // Sending the user's cookies is not a qualifier on the fetch, it is a different act — the agent reads whatever
    // they can read signed in. It used to ride the trailing `.action-note`, which is DIMMED: the faintest thing on
    // the card carrying the most consequential fact on it.
    const w = await loadSidebarWorld();
    await w.dispatch(agentStart("cred", "read my dashboard"));
    await w.dispatch(agentStep("cred", 1, {
        seq: 1, pending: true, awaitingApproval: true, tool: "fetch_url",
        arguments: { url: "https://dash.example/private", credentials: true },
        renderIn: { type: "action", verb: "fetch", target: "https://dash.example/private", asYou: "dash.example" },
    }));
    w.shadow.querySelector(".row").click();
    await w.flush();
    const warned = w.shadow.querySelector(".astep-approve .action-xorigin");
    assert.ok(warned, "it gets the same treatment as the other facts that change what approving means");
    assert.match(warned.textContent, /runs as you/);
    assert.match(warned.textContent, /dash\.example/, "and names the site the cookies go to");
    // Not buried in the dim note beside "full page" and "schema only".
    const note = w.shadow.querySelector(".astep-approve .action-note");
    assert.ok(!note || !/cookies/.test(note.textContent), "the dimmed note does not carry it");
});

test("an approval with no sentence to give still shows what it would run", async () => {
    // A code tool has no deterministic intent, and you cannot approve code you cannot see: there the arguments must
    // still open themselves. This is the half that the rule above must not take away.
    const w = await loadSidebarWorld();
    await w.dispatch(agentStart("code", "run it"));
    await w.dispatch(agentStep("code", 1, {
        seq: 1, pending: true, awaitingApproval: true, tool: "exec",
        arguments: { js: "document.title" },
    }));
    w.shadow.querySelector(".row").click();
    await w.flush();
    assert.ok(w.shadow.querySelectorAll(".astep.tool .io").length > 0, "the In opens itself when nothing else says what will run");
    assert.match(w.shadow.querySelector(".astep-approve").textContent, /Approve running/, "and the plain question stands in");
});

test("output-cap raise: the approval card calls out the raised limit + the model's justification", async () => {
    const w = await loadSidebarWorld();
    await w.dispatch(agentStart("orc", "big dump"));
    await w.dispatch(agentStep("orc", 1, {
        seq: 1, pending: true, awaitingApproval: true, tool: "exec",
        arguments: { js: "return bigThing()", maxChars: 8000, maxCharsReason: "need the whole config file" },
        renderIn: { type: "code", text: "return bigThing()", lang: "javascript", format: true },
    }));
    w.shadow.querySelector(".row").click();
    await w.tick();
    const raise = w.shadow.querySelector(".action-raise");
    assert.ok(raise, "the raise note rendered on the approval card");
    assert.match(raise.textContent, /8,?000 chars/, "shows the raised cap");
    assert.match(raise.textContent, /default 500/, "and the default it's exceeding");
    assert.match(raise.textContent, /need the whole config file/, "shows the model's justification");
});

test("output-cap raise (HUD card): the raised limit + justification appear on the corner card too (parity)", async () => {
    const w = await loadSidebarWorld();
    await w.raw({ __mlSidebarSurface: "card" });   // off-mode corner card
    await w.dispatch(agentStart("orcC", "big dump"));
    await w.dispatch(agentStep("orcC", 1, {
        seq: 1, pending: true, awaitingApproval: true, tool: "python_exec",
        arguments: { code: "df.to_string()", maxChars: 15000, maxCharsReason: "the whole frame" },
        renderIn: { type: "python-in", mode: "script", code: "df.to_string()" },
    }));
    await w.tick();
    const raise = w.shadow.querySelector(".action-raise");
    assert.ok(raise, "the raise note rendered on the HUD card");
    assert.match(raise.textContent, /15,?000 chars/);
    assert.match(raise.textContent, /the whole frame/);
});

test("output-cap raise: an UNRAISED exec approval shows no raise note", async () => {
    const w = await loadSidebarWorld();
    await w.dispatch(agentStart("orc2", "survey"));
    await w.dispatch(agentStep("orc2", 1, {
        seq: 1, pending: true, awaitingApproval: true, tool: "exec",
        arguments: { js: "return x" }, renderIn: { type: "code", text: "return x", lang: "javascript", format: true },
    }));
    w.shadow.querySelector(".row").click();
    await w.tick();
    assert.equal(w.shadow.querySelector(".action-raise"), null, "no note when the cap isn't raised");
});

test("approval card: a fetch_url gate styles the URL like navigate/submit (action-link: warm + dotted), not 'the element'", async () => {
    const w = await loadSidebarWorld({ sync: { chatUrl: "http://x" }, listModels: () => ({ data: ["m"] }) });
    await w.raw({ __mlSidebarSurface: "card" });
    const url = "https://raw.githubusercontent.com/SideStore/anisette-servers/main/servers.json";
    await w.dispatch(agentStart("fu", "Fetch and list servers"));
    await w.dispatch(agentStep("fu", 1, { seq: 1, pending: true, awaitingApproval: true, tool: "fetch_url", arguments: { url }, renderIn: { type: "action", verb: "fetch", target: url } }));
    await w.tick();
    const link = w.shadow.querySelector(".action-link");
    assert.ok(link, "the fetch URL renders in an action-link (the warm + dotted 'significant detail' style, like navigate)");
    assert.equal(link.textContent, url, "it's the exact URL");
    const sentence = w.shadow.querySelector(".action-sentence").textContent;
    assert.match(sentence, /wants to\s+fetch/i, "the verb is 'fetch'");
    assert.doesNotMatch(sentence, /the element/i, "NOT the generic 'the element' wording");
});

test("awaiting approval of a python_exec that loads an EXTERNAL sheet warns it's a session-scoped grant", async () => {
    const w = await loadSidebarWorld();
    await w.dispatch(agentStart("shg", "sum the sheet"));
    // A pending, approval-gated python_exec loading an external Google Sheet. The In is the PRE-RUN
    // preview (code-only, no tables loaded yet) — the note MUST come from the ARGS (`tables`), which is
    // the real approval-time scenario (the earlier renderIn-based detection silently showed nothing).
    await w.dispatch(agentStep("shg", 1, {
        seq: 1, pending: true, awaitingApproval: true, tool: "python_exec",
        arguments: { code: "return df['A'].sum()", tables: "https://docs.google.com/spreadsheets/d/SHEETID/edit" },
        renderIn: { type: "python-in", mode: "script", code: "return df['A'].sum()" },   // code-only, no tables
    }));
    w.shadow.querySelector(".row").click();
    await w.tick();

    const note = w.shadow.querySelector(".astep-approve .appr-note");
    assert.ok(note, "the approval bar shows a session-grant note (from the args, pre-run)");
    assert.match(note.textContent, /rest of this session/i, "explains the grant is session-scoped");
    // A smart chip (not the raw 44-char id): a link to the sheet, the id in its tooltip.
    const chip = note.querySelector(".sheet-chip");
    assert.ok(chip, "the sheet is a smart chip, not a raw id");
    assert.match(chip.getAttribute("href"), /spreadsheets\/d\/SHEETID/, "chip links to the sheet");
    assert.match(chip.querySelector(".tt-pop").textContent, /SHEETID/, "the full id is on hover");
    // A page-table run (a selector, not a Sheets URL) must NOT show the grant note.
    await w.dispatch(agentStep("shg", 2, {
        seq: 2, pending: true, awaitingApproval: true, tool: "python_exec",
        arguments: { code: "return df.sum()", tables: "#t" },
        renderIn: { type: "python-in", mode: "script", code: "return df.sum()" },
    }));
    await w.tick();
    const notes = [...w.shadow.querySelectorAll(".astep-approve .appr-note")];
    assert.equal(notes.length, 1, "only the external-sheet step warns — a page-table step doesn't");
});

// --- a decided step afterwards: reused grants, denials and focus mode ------------------------------------

// Focus mode reads the run as a conversation. A tool call is kept OPEN after you decide so the result fills
// in on the same cell — right when you are debugging, wrong when you are reading: every approval would
// permanently widen the transcript, which is the thing focus mode exists to narrow.
test("focus mode: a decided step collapses; outside focus mode it stays open", async () => {
    const openAfterDecide = async (focus) => {
        const w = await loadSidebarWorld(focus ? { local: { ml_debug_focus: true } } : undefined);
        await w.dispatch(agentStart("fm", "fetch stuff"));
        await w.dispatch(grantStep("fm"));
        w.shadow.querySelector(".row").click();
        await w.tick();
        // An awaiting step auto-unfurls, so you review the call before deciding — true in both modes.
        assert.ok(!w.shadow.querySelector(".astep-preview"), "a gate is open before you decide");
        w.window.postMessage = () => {};
        w.shadow.querySelector(".astep-approve .appr-btn:not(.remember)").click();
        await w.tick();
        return !w.shadow.querySelector(".astep-preview");   // a preview line only shows while COLLAPSED
    };
    assert.equal(await openAfterDecide(false), true, "debugging: it stays open and the Out fills in there");
    assert.equal(await openAfterDecide(true), false, "reading: it collapses back to its one-line preview");
});

test("reused-grant step: a readonly exec that re-read a cached URL shows a collapsed 'reused a grant' note", async () => {
    const w = await loadSidebarWorld();
    const url = "https://x.test/servers.json";
    await w.dispatch(agentStart("ru", "reuse a fetch"));
    await w.dispatch(agentStep("ru", 1, { seq: 1, tool: "exec", arguments: { js: `ml.fetch("${url}").json` }, result: "[…]", approval: "readonly", reused: [{ kind: "fetch-url", detail: url }] }));
    w.shadow.querySelector(".row").click();
    await w.tick();
    const head = [...w.shadow.querySelectorAll(".astep.tool .astep-head")].find(h => /exec/.test(h.textContent));
    head.click();
    await w.tick();
    const reused = w.shadow.querySelector(".astep-reused");
    assert.ok(reused, "the reused-grant disclosure renders on the step");
    assert.match(reused.textContent, /Reused a grant you approved/i);
    assert.match(reused.querySelector(".reused-why").textContent, /1 URL/, "deterministic summary of what was reused");
    // Collapsed by default; the exact URL is in the (expandable) list.
    assert.match(reused.querySelector(".reused-list code").textContent, /servers\.json/);
});

test("reused-grant step: a python_exec that reused an approved Sheet renders it as a smart chip", async () => {
    const w = await loadSidebarWorld();
    await w.dispatch(agentStart("rs", "reuse a sheet"));
    await w.dispatch(agentStep("rs", 1, { seq: 1, tool: "python_exec", arguments: { code: "df.sum()" }, result: "42", approval: "sandbox", reused: [{ kind: "sheet", detail: "1AbCdEfGh" }] }));
    w.shadow.querySelector(".row").click();
    await w.tick();
    const head = [...w.shadow.querySelectorAll(".astep.tool .astep-head")].find(h => /python_exec/.test(h.textContent));
    head.click();
    await w.tick();
    const reused = w.shadow.querySelector(".astep-reused");
    assert.ok(reused, "the reused-grant disclosure renders");
    assert.match(reused.querySelector(".reused-why").textContent, /1 sheet/, "summarised as a sheet, not a URL");
    assert.ok(reused.querySelector(".reused-list .sheet-chip"), "the sheet renders as a smart chip (resolves its name)");
});

test("denying a gated step KEEPS its In render (the DONE's blank renderIn doesn't clobber the START's)", async () => {
    const w = await loadSidebarWorld();
    await w.dispatch(agentStart("dng", "click something"));
    // The awaiting-approval START carries the In preview (e.g. click's targeted @pt).
    await w.dispatch(agentStep("dng", 1, {
        seq: 1, pending: true, awaitingApproval: true, tool: "click",
        arguments: { selector: "@pt:ce6c8a40" },
        renderIn: { type: "elements", items: [{ path: "@pt:ce6c8a40" }] },
    }));
    // The DONE after DENIAL: result + approval, but NO renderIn/renderOut — the tool never ran.
    await w.dispatch(agentStep("dng", 1, {
        seq: 1, tool: "click", arguments: { selector: "@pt:ce6c8a40" },
        result: "Denied by the user. Do not retry this exact call; try another approach.", approval: "denied",
    }));
    w.shadow.querySelector(".row").click();
    await w.tick();
    const toolStep = w.shadow.querySelector(".astep.tool");
    toolStep.querySelector(".astep-head").click();
    await w.tick();
    // The In still renders the elements descriptor (not raw JSON) despite the blank DONE.
    assert.ok(toolStep.querySelector(".r-el"), "the In render persists after denial");
    assert.match(toolStep.querySelector(".r-el-path").textContent, /@pt:ce6c8a40/);
    assert.match(toolStep.textContent, /Denied by the user/, "the denial result still shows");
});

// Focus mode: read a run as a conversation. Every rule is a HIDE, never a restructure — the elements stay in
// the document, so search, copy and the export see the same transcript whichever way the toggle is set, and
// turning it off brings everything back. What must SURVIVE it is the point of the test: a run is a sequence of
// actions, so the tool names and their bodies are content, not chrome.
test("focus mode: quiets the machinery, keeps what happened, and is fully reversible", async () => {
    const w = await loadSidebarWorld();
    await w.dispatch(agentStart("f1", "find the login button", "qwen3:14b"));
    await w.dispatch(agentStep("f1", 1, { thought: "Let me look" }));
    await w.dispatch(agentStep("f1", 1, { tool: "exec", arguments: { js: "1" }, result: "a top navigation bar", approval: "readonly" }));
    await w.dispatch(agentResult("f1", "Top-right.", 2));
    w.shadow.querySelector(".row").click();
    await w.tick();

    // jsdom applies no stylesheet, so VISIBILITY is not observable here — the rules themselves are asserted
    // against a real browser in tests/e2e. What this checks is the contract the CSS rests on: the toggle sets
    // the attribute, and every element the rules name is still in the document either way.
    const present = (sel) => w.shadow.querySelectorAll(sel).length;
    const before = {
        step: present(".step-pill"), appr: present(".appr-badge"),
        you: present(".msg.user .who"), preview: present(".astep-preview"),
    };
    assert.ok(before.step && before.appr && before.you && before.preview, `all four are there to begin with (${JSON.stringify(before)})`);

    const btn = w.shadow.querySelector('[aria-label="Focus mode"]');
    assert.ok(btn, "the detail header offers the toggle");
    btn.click();
    await w.tick();

    assert.equal(w.shadow.documentElement.hasAttribute("data-focus"), true,
        "it rides a root attribute, so CSS owns all of it and no component learns about the mode");
    // The elements are still THERE — hidden by CSS, not removed. That is what keeps the export, a text search
    // and the toggle's own reversal reading the same document.
    assert.ok(w.shadow.querySelector(".step-pill"), "hidden, not deleted");
    assert.ok(w.shadow.querySelector(".appr-badge"), "hidden, not deleted");
    // …and what stays visible is everything that says what actually happened.
    assert.ok(w.shadow.querySelector(".astep.tool .tool-name"), "the tool name survives — it IS the transcript");
    assert.ok(w.shadow.querySelector(".utext"), "the user's own message survives");
    assert.match(w.shadow.body.textContent, /Top-right\./, "and the answer");

    btn.click();
    await w.tick();
    assert.equal(w.shadow.documentElement.hasAttribute("data-focus"), false, "off again");
});

// WHAT FOCUS MODE HIDES is a CSS question (jsdom applies no stylesheet), so the rules are read directly.
// The distinction it encodes: focus mode quiets CHROME — step counters, approval badges, provenance — and
// never the thing you came to do. Copying the answer is the reason you are reading it.
test("focus mode hides the raw toggle and the model pill, and KEEPS the copy button on a reply", () => {
    const css = sidebarCss();
    const hidden = css.split("\n").filter((l) => l.startsWith("html[data-focus]") && !l.includes("{ display: inline"));
    const named = (sel) => hidden.some((l) => l.includes(sel));
    assert.ok(named(".raw-btn"), "the raw toggle is chrome — hidden");
    assert.ok(named(".tt:has(> .model-name)"), "so is the model pill");
    assert.ok(named(".step-pill") && named(".appr-badge"), "…and the step counter and approval badge");
    // The copy button is hidden ONLY on the user's own bubble, where the row is repositioned as an overlay
    // and there is nothing to copy you did not just write.
    const copyRules = hidden.filter((l) => l.includes(".icon-btn"));
    assert.equal(copyRules.length, 1, "exactly one rule touches the copy button");
    assert.match(copyRules[0], /\.msg\.user\b/, "and it is scoped to the user's bubble, so a reply keeps its copy");
});
