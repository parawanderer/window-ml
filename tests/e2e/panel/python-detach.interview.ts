// python-detach.interview.ts — does a model, reading only python_exec's Detached text, do the right next thing?
//
// ASYNC_CALLS.md mode 1, rule 2: the two wakes call for different behaviour. Past the DEFAULT lease the call is still
// live and the right move is to wait on it with an estimate (or check its tail); past the model's OWN estimate the
// right move is to investigate (tail) before waiting longer. And while a cell is detached the run's Python is busy: a
// second python_exec is refused, so it awaits or cancels first. Each turn hands the model the exact text a run would
// show (`pyDetachedText`, the `task` tool's own description) and asks for its next call as text; nothing runs.
import { defineInterview } from "../bench/spec";
import { pyDetachedText } from "../../../src/sw/sw-python-task";
import { taskTool } from "../../../src/tools/task-tool";
import { defineTool } from "../../../src/ml/ml-tool-factories";
import { PY_LEASE_MS } from "../../../src/python/py-lease";

const task = taskTool(defineTool);
const TOOLS = `You have these tools, among others:
- python_exec(code, expect_ms?): runs a Python cell in this run's sandbox. expect_ms: "Your estimate of this cell's run time in ms. Past it, or a short default without it, the call detaches into a task."
- ${task.name}(op, id, timeout_ms?, lines?): ${task.description}`;

const FORMAT = "Answer with the ONE tool call you make next, as `tool({ ...args })` on its own line, then one sentence saying why. Call no tools: nothing runs, we are measuring how the text is read.";

const tail = "stdout (3 lines so far):\nchecked 1000000\nchecked 2000000\nchecked 3000000";
const DEFAULT = pyDetachedText("t4f2a91", PY_LEASE_MS, null, tail);
const EXPECTED = pyDetachedText("t7c03be", 20_000, 20_000, "stdout: nothing printed yet");

/** The call the answer makes, as written: the first `name(` it opens. */
const firstCall = (answer: string): string => (answer.match(/\b(python_exec|task)\s*\(/)?.[1] ?? "");

export default defineInterview({
    about: "python_exec's Detached text: the default wake (await with an estimate), the missed estimate (investigate first), and the busy kernel (await or cancel before another cell).",
    task: {
        ask: `${TOOLS}\n\nYou are counting primes below 50 million. You called:\npython_exec({ code: "count = sum(1 for n in range(2, 50_000_000) if is_prime(n)); count" })\nIt returned:\n${DEFAULT}\n\n${FORMAT}`,
        expect: (t) => firstCall(t.answer) === "task" && /t4f2a91/.test(t.answer) && /await|tail/.test(t.answer),
        why: "acts on task t4f2a91 (await or tail), not a new python_exec",
    },
    asks: [{
        ask: `New situation, same tools. You expected a cell that sums a 1,000-row column to finish in 20 s, so you called:\npython_exec({ code: "df['total'].sum()", expect_ms: 20000 })\nIt returned:\n${EXPECTED}\n\n${FORMAT}`,
        expect: (t) => firstCall(t.answer) === "task" && /t7c03be/.test(t.answer) && /tail|cancel/.test(t.answer) && !/op:\s*["']await["']/.test(t.answer),
        why: "investigates (tail) or cancels task t7c03be; does not just wait longer on a missed estimate",
    }, {
        ask: `Back to the first situation: task t4f2a91 (the prime count) is still running. You now also need 17 * 23 computed in Python for another part of the answer.\n\n${FORMAT}`,
        expect: (t) => firstCall(t.answer) === "task" && /t4f2a91/.test(t.answer),
        why: "knows python_exec is refused while t4f2a91 runs: awaits or cancels it first",
    }, {
        ask: "Quote the sentence in the text you were given that your three answers relied on most, and name anything in it that was unclear or that you had to guess.",
    }],
});
