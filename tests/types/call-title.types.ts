// call-title.types.ts — a TYPE test, run by the project's own `tsc --noEmit` rather than by node:test.
//
// `title` is a reserved tool parameter, refused two ways: `defineTool` THROWS (the guard that protects everyone,
// since `window.ml` is called from a devtools console and from userscripts where nothing is compiled), and the
// signature rejects it for the callers we do compile.
//
// The second is the one that can rot silently — a widened signature stops catching it and nothing fails, because
// "no error" is the normal state of a type. `@ts-expect-error` inverts that: tsc fails when the line it marks
// STOPS being an error, so this file is the test. tsconfig includes `**/*.ts`, so it is checked by the pre-commit
// hook and in CI alongside everything else.
import { defineTool } from "../../src/ml-tool-factories";

// A tool with its own parameters: fine, and `title` is added to it later for the model.
const ok = defineTool({
    name: "fare_rules",
    parameters: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
    run: () => "",
});
void ok;

const clash = defineTool({
    name: "set_title",
    parameters: {
        type: "object",
        properties: {
            // @ts-expect-error `title` is reserved — every tool is given one for the model's own description of a
            // call. The diagnostic on this line quotes that sentence, which is the whole point of spelling the
            // rejection as a string literal rather than as `never`.
            title: { type: "string" },
        },
    },
    run: () => "",
});
void clash;

// A schema whose keys are not literal CANNOT be checked here — `keyof Record<string, unknown>` is `string`, so
// every schema would look like it declares `title`. It is passed through rather than rejected, and the runtime
// throw is what covers this caller. Asserting it compiles is the point: a stricter rule here would reject every
// tool built from a variable.
const dynamic: { type: string; properties: Record<string, unknown> } = { type: "object", properties: { whatever: { type: "string" } } };
const loose = defineTool({ name: "built_at_runtime", parameters: dynamic, run: () => "" });
void loose;
