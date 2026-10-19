// matplotlib.interview.ts — does a model, reading only python_exec's text, plot with matplotlib and know about `verify`?
//
// The task needs a chart of a page table; the check is that a python_exec step came back as an IMAGE (a figure left
// open or returned), read from the step's own result text, never from what the model says it did. The second turn
// asks whether it looked at the chart and what would have let it, to see whether `verify` is found from its
// one-line schema text.
import { defineInterview } from "../bench/spec";

const drewImage = (steps: { tool: string; result?: unknown }[]) =>
    steps.some((s) => s.tool === "python_exec" && /came back as an image|Returned an image/.test(String(s.result ?? "")));

export default defineInterview({
    about: "matplotlib in python_exec: plot a page table, then say how to check the chart (verify).",
    surface: "hud",
    start: "/spreadsheet",
    task: {
        ask: "Make a bar chart of each rep's Q1 to Q4 total from the table on this page, and show it to me.",
        expect: (t) => drewImage(t.steps),
        why: "a python_exec step returned the chart as an image",
    },
    asks: [{
        ask: "Did you look at the chart yourself before answering? If not, what in your tools would have let you, and what would it have cost? Quote the text you base that on.",
        expect: (t) => /verify/.test(t.answer),
        why: "names python_exec's verify",
    }],
});
