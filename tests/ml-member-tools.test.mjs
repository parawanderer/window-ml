// An `ml` member that belongs to an agent tool (ml-member-tools.ts) is absent from a run without that tool, in every
// place a model meets it: the read-only exec's facade, the page's `window.ml` during an approved exec, and the
// `agent_api_docs` reference. `answer` is the one member today.
import { test } from "node:test";
import assert from "node:assert";
import { JSDOM } from "jsdom";
import { hiddenMlMembers, ML_MEMBER_TOOL } from "../src/ml/ml-member-tools.ts";
import { evalReadonly, NotInDialect, Denied } from "../src/readonly-exec.ts";
import { AnswerSet, makeAnswerFacade } from "../src/pointers/answer-set.ts";
import { executeTool, toolContext, currentHiddenMember } from "../src/tools/tool-exec.ts";
import { withoutMembers, queryApiDocs } from "../src/tools/api-docs-query.ts";
import { generateApiParts } from "../scripts/gen-api-docs.mjs";

const doc = () => new JSDOM("<!doctype html><body><p id=x>hi</p></body>").window.document;
const ML = { getModel: async () => "m" };
const WHY = /ml\.answer is not part of this run: it comes with the `answer` tool/;

// --- the table ---

test("a run without the answer tool lacks ml.answer, and one with it has it", () => {
    assert.equal(ML_MEMBER_TOOL.answer, "answer");
    assert.match(hiddenMlMembers(() => false).get("answer"), WHY);
    assert.equal(hiddenMlMembers((n) => n === "answer").size, 0);
});

// --- the read-only exec facade, adversarially: no spelling of the read reaches the set ---

const hiddenRun = (js, set = new AnswerSet()) => evalReadonly(js, doc(), ML, makeAnswerFacade(set), { hidden: hiddenMlMembers(() => false) });

test("a survey reaching a hidden member gets the reason as a runtime error, not a refusal that asks a person", async () => {
    const set = new AnswerSet();
    await assert.rejects(hiddenRun(`ml.answer.add("x")`, set), (e) => WHY.test(e.message) && !(e instanceof NotInDialect) && !(e instanceof Denied));
    assert.equal(set.items.length, 0, "nothing reached the set");
});

test("no other spelling reaches a hidden member: computed key, destructuring, an alias, optional chaining", async () => {
    const set = new AnswerSet();
    for (const js of [`ml["ans" + "wer"].add("x")`, `const { answer } = ml; answer.add("x")`, `const m = ml; m.answer.add("x")`,
        `ml?.answer?.add("x")`, `typeof ml.answer`]) {
        await assert.rejects(hiddenRun(js, set), (e) => WHY.test(e.message) && !(e instanceof NotInDialect) && !(e instanceof Denied), js);
    }
    assert.equal(set.items.length, 0, "nothing reached the set");
});

test("the same survey in a run that has the tool curates the set, as before", async () => {
    const set = new AnswerSet();
    await evalReadonly(`ml.answer.add("x")`, doc(), ML, makeAnswerFacade(set), { hidden: hiddenMlMembers(() => true) });
    assert.equal(set.items.length, 1);
});

test("hiding a member changes nothing else on the facade", async () => {
    assert.equal((await hiddenRun(`ml.getModel()`)).value, "m");
});

// --- the page's window.ml during a tool call ---

test("during a tool call, a run without the answer tool is told ml.answer is not its; outside a run nothing is hidden", async () => {
    let seen = "unset";
    const probe = { name: "probe", description: "", parameters: { type: "object", properties: {} }, run: () => { seen = currentHiddenMember("answer"); return "ok"; } };
    await executeTool(probe, {}, toolContext({ probe }));
    assert.match(seen, WHY);
    const answer = { name: "answer", description: "", parameters: { type: "object", properties: {} }, run: () => "" };
    await executeTool(probe, {}, toolContext({ probe, answer }));
    assert.equal(seen, null, "the run has the tool");
    assert.equal(currentHiddenMember("answer"), null, "no run: the page's own console keeps the member");
});

// --- the agent_api_docs reference ---

test("the reference for a run without answer drops the member and the types only it reaches, keeping shared ones", () => {
    const parts = generateApiParts();
    const cut = withoutMembers(parts, ["answer"]);
    const view = queryApiDocs(cut, {});
    assert.doesNotMatch(cut.mlApi, /\breadonly answer: MlAnswer/);
    assert.ok(!("MlAnswer" in cut.types), "MlAnswer is reached only through ml.answer");
    assert.ok("AgentResult" in cut.types, "a type ml.agent uses stays");
    assert.doesNotMatch(view, /MlAnswer/);
    assert.match(queryApiDocs(cut, { members: ["answer"] }), /not|unknown|no /i, "asking for it by name finds nothing");
    assert.strictEqual(withoutMembers(parts, []), parts, "nothing hidden: the same reference");
});

test("a type a hidden member shares with a kept one stays", () => {
    const parts = {
        preamble: "P",
        mlApi: ["## ml", "", "```ts", "export interface MlApi {", "    /** a */", "    a(): Shared;", "    /** b */", "    b(): Own;", "}", "```", ""].join("\n"),
        types: { Own: "### Own\n\n```ts\nexport interface Own { s: Shared }\n```\n", Shared: "### Shared\n\n```ts\nexport interface Shared {}\n```\n" },
    };
    const cut = withoutMembers(parts, ["b"]);
    assert.deepEqual(Object.keys(cut.types), ["Shared"]);
    assert.doesNotMatch(cut.mlApi, /b\(\)/);
    assert.match(cut.mlApi, /a\(\): Shared/);
});
