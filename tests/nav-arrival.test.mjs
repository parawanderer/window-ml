// nav-arrival.test.mjs — a page the run's tab arrives on, judged as the `fetch` consumer before the run acts there
// (src/sw/nav-arrival.ts; docs/spec/POLICIES.md, "A navigation the model did not name is judged on arrival"), and the
// describe layer that refuses a click on a link a policy denies before the click (clickHref, src/tools/builtin-tools.ts).
//
// The pure verdict over every judgement shape, the per-tab judging order, and the texts. The run host's use of them is
// tested in nav-arrival-host.test.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

const A = await import("../src/sw/nav-arrival.ts");
const { clickHref } = await import("../src/tools/builtin-tools.ts");

const policy = (effect, label = "No admin pages") => ({ id: "p1", scope: "global", consumer: "fetch", effect, source: "(c) => true", label, origin: "person", created: 0 });
const judged = (decision, by) => ({ decision, ...(by !== undefined ? { by } : {}), broken: [] });

// --- the verdict: every decision, from every source, on every kind of URL ---

const DECISIONS = ["allow", "ask", "deny", undefined];
const SOURCES = { policy: (d) => policy(d ?? "allow"), builtin: () => "builtin", none: () => undefined };
const NETWORK = ["https://b.example/admin/x?q=1", "http://b.example:8080/"];
const NOT_NETWORK = ["about:blank", "chrome-error://chromewebdata/", "file:///etc/passwd", "data:text/html,hi", "javascript:void(0)", "not a url", ""];

test("a URL not read over the network is no policy's to judge: every judgement of it passes", () => {
    for (const url of NOT_NETWORK)
        for (const d of DECISIONS)
            for (const [src, by] of Object.entries(SOURCES))
                assert.deepEqual(A.arrivalVerdict(url, judged(d, by(d))), { kind: "pass" }, `${url} ${d} ${src}`);
});

test("a network URL: each decision from each source comes to exactly one verdict", () => {
    for (const url of NETWORK) {
        const href = new URL(url).href, origin = new URL(url).origin;
        for (const d of DECISIONS)
            for (const [src, by] of Object.entries(SOURCES)) {
                const v = A.arrivalVerdict(url, judged(d, by(d)));
                const what = `${url} ${d} ${src}`;
                if (d === "deny" && src === "policy") assert.deepEqual(v, { kind: "deny", url: href, label: "No admin pages" }, what);
                else if (d === "ask" && src === "policy") assert.deepEqual(v, { kind: "ask", url: href, origin, label: "No admin pages" }, what);
                // An ask with no policy behind it is the store that could not be read: it still asks, with no label.
                else if (d === "ask") assert.deepEqual(v, { kind: "ask", url: href, origin }, what);
                else if (d === "allow" && src === "policy") assert.deepEqual(v, { kind: "allow", origin }, what);
                else assert.deepEqual(v, { kind: "pass" }, what);
            }
    }
});

test("the default: no policy and no builtin answer lets the arrival through and consents nothing", () => {
    assert.deepEqual(A.arrivalVerdict("https://b.example/", judged(undefined)), { kind: "pass" });
});

test("a builtin deny or allow is not a policy's: it neither holds the run nor consents the origin", () => {
    assert.deepEqual(A.arrivalVerdict("https://b.example/", judged("deny", "builtin")), { kind: "pass" });
    assert.deepEqual(A.arrivalVerdict("https://b.example/", judged("allow", "builtin")), { kind: "pass" });
});

test("a label the page could shape is made speakable before any text quotes it", () => {
    const v = A.arrivalVerdict("https://b.example/", judged("deny", policy("deny", 'say "yes"\nnow')));
    assert.ok(!/["\n]/.test(v.label), v.label);
    assert.ok(A.arrivalLine(v).includes(`"${v.label}"`) && !A.arrivalLine(v).includes("\n"), "the line quotes it whole, on one line");
});

// --- the texts ---

test("every text names the page and, when a policy is behind it, the policy; none is padded", () => {
    const deny = { kind: "deny", url: "https://b.example/admin/", label: "No admin" };
    const ask = { kind: "ask", url: "https://b.example/x", origin: "https://b.example", label: "Ask on b" };
    const unread = { kind: "ask", url: "https://b.example/x", origin: "https://b.example" };
    const texts = [A.arrivalLine(deny), A.arrivalLine(ask), A.arrivalLine(unread), A.arrivalDeniedText(deny), A.clickDeniedText(deny),
        A.arrivalAnsweredText(ask, true), A.arrivalAnsweredText(ask, false, "not that one"), A.arrivalAnsweredText(unread, false), A.arrivalWaitingText(ask)];
    for (const t of texts) assert.ok(!/ {2}/.test(t), t);
    assert.match(A.arrivalLine(deny), /https:\/\/b\.example\/admin\/.*"No admin" denies/);
    assert.match(A.arrivalLine(ask), /"Ask on b" asks/);
    assert.match(A.arrivalLine(unread), /saved policies could not be read/);
    assert.match(A.clickDeniedText(deny), /"No admin" denies: the click was not made/);
    assert.match(A.arrivalAnsweredText(ask, false, "not that one"), /They said: not that one$/);
});

// --- judging per tab ---

test("a commit runs every live run's judge on the tab, in order, and a re-adopt does not judge the same URL twice", async () => {
    const seen = [];
    const un1 = A.watchArrivals(41, "r1", (u) => { seen.push(`r1 ${u}`); });
    const un2 = A.watchArrivals(41, "r2", async (u) => { await new Promise((r) => setTimeout(r, 5)); seen.push(`r2 ${u}`); });
    void A.judgeArrival(41, "https://a.example/");
    void A.judgeArrival(41, "https://b.example/");
    await A.arrivalSettled(41);
    assert.deepEqual(seen, ["r1 https://a.example/", "r2 https://a.example/", "r1 https://b.example/", "r2 https://b.example/"]);
    await A.judgeArrival(41, "https://b.example/", false);
    assert.equal(seen.length, 4, "a re-adopt on the URL already judged is not judged again");
    await A.judgeArrival(41, "https://b.example/");
    assert.equal(seen.length, 6, "a commit always is");
    un1(); un2();
    await A.judgeArrival(41, "https://c.example/");
    assert.equal(seen.length, 6, "an unwatched run is not judged");
});

test("a judge that throws does not stop the next run's judge or the next commit", async () => {
    const seen = [];
    const un1 = A.watchArrivals(42, "r1", () => { throw new Error("boom"); });
    const un2 = A.watchArrivals(42, "r2", (u) => { seen.push(u); });
    await A.judgeArrival(42, "https://a.example/");
    await A.judgeArrival(42, "https://b.example/");
    assert.deepEqual(seen, ["https://a.example/", "https://b.example/"]);
    un1(); un2();
});

test("a hold is the run's until it is cleared or the run stops watching", () => {
    const un = A.watchArrivals(43, "r3", () => {});
    const h = { kind: "deny", url: "https://b.example/admin/", label: "No admin" };
    A.holdArrival("r3", h);
    assert.deepEqual(A.arrivalHold("r3"), h);
    assert.equal(A.arrivalHold("r4"), undefined, "another run is not held");
    A.clearArrival("r3");
    assert.equal(A.arrivalHold("r3"), undefined);
    A.holdArrival("r3", h);
    un();
    assert.equal(A.arrivalHold("r3"), undefined, "a settled run leaves no hold behind");
});

// --- the describe layer: where a click would go ---

function mount(html) {
    const dom = new JSDOM(`<!doctype html><body>${html}</body>`, { url: "https://a.example/dir/page" });
    globalThis.window = dom.window;
    globalThis.document = dom.window.document;
    return dom.window.document;
}

test("clickHref is the absolute href of the clicked element's nearest link, and nothing for an element in no link", () => {
    mount(`<a id="rel" href="../admin/"><span id="inner">Admin</span></a><a id="abs" href="https://b.example/x">B</a>
        <map name="m"><area id="ar" href="/area" alt="x"></map><button id="btn">Go</button><a id="nohref">none</a>
        <a class="many" href="/one">1</a><a class="many" href="/two">2</a>`);
    assert.equal(clickHref({ selector: "#rel" }), "https://a.example/admin/");
    assert.equal(clickHref({ selector: "#inner" }), "https://a.example/admin/", "a click inside a link follows the link");
    assert.equal(clickHref({ selector: "#abs" }), "https://b.example/x");
    assert.equal(clickHref({ selector: "#ar" }), "https://a.example/area");
    assert.equal(clickHref({ selector: ".many", index: 1 }), "https://a.example/two");
    assert.equal(clickHref({ selector: "#btn" }), undefined);
    assert.equal(clickHref({ selector: "#nohref" }), undefined);
    assert.equal(clickHref({ selector: "#missing" }), undefined);
    assert.equal(clickHref({ selector: "[[bad" }), undefined, "a selector that does not parse");
    assert.equal(clickHref({ selector: "@pt:1:2:abc" }), undefined, "a point token has no element");
    assert.equal(clickHref({ selector: "" }), undefined);
});
