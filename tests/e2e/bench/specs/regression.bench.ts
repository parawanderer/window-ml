// regression.bench.ts — the regression suite as a sweep: every task any spec here marks `regression.included`, over the
// models given at run time. Not run automatically; run it when a change might have made the tools harder to use:
//
//   npm run build
//   USE_ENV=1 node --import tsx tests/e2e/bench/run.mjs --regression --models a,b,c [--repeats 3] --lanes --serve
//
// (`--regression` is this file.) Its runs are logged with `suite = 'regression'` in scores.sqlite, and regress.mjs
// reads them: did this build make the suite's tasks harder than the builds before it. A task runs as written, on the
// default build, with only the model varied; its own spec's other dimensions and `apply` do not reach it, which is why
// a task that depends on them is not included.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { type BenchSpec, type BenchTask, checkRegression } from "../spec";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Every spec module in this directory but this one, loaded. A spec whose default export is a function (this one) is skipped. */
export async function suiteSources(dir = HERE): Promise<{ file: string; spec: BenchSpec }[]> {
    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".bench.ts")).sort();
    const out: { file: string; spec: BenchSpec }[] = [];
    for (const f of files) {
        const mod = await import(pathToFileURL(path.join(dir, f)).href);
        const spec = mod.default ?? mod.spec;
        if (typeof spec === "function" || !spec?.tasks) continue;
        checkRegression(spec.tasks, f);
        out.push({ file: f, spec });
    }
    return out;
}

/** The suite's spec over `models`: each included task as written, with its spec's timeout, and kept off the store when its spec is. */
export async function regressionSpec({ models = [] as string[], dir = HERE } = {}): Promise<BenchSpec> {
    if (!models.length) throw new Error("the regression suite needs a model list: --models a,b,c");
    const tasks: BenchTask[] = [];
    const from = new Map<string, string>();
    for (const { file, spec } of await suiteSources(dir)) {
        for (const t of spec.tasks) {
            if (!t.regression.included) continue;
            if (from.has(t.id)) throw new Error(`regression suite: task id "${t.id}" is in both ${from.get(t.id)} and ${file}; rename one`);
            from.set(t.id, file);
            tasks.push({ ...t, timeoutMs: t.timeoutMs ?? spec.timeoutMs, ...(spec.sync === false ? { sync: false } : {}) });
        }
    }
    if (!tasks.length) throw new Error("no spec marks a task `regression: { included: true }`");
    return {
        name: "regression",
        suite: "regression",
        description: `The regression suite: ${tasks.length} task(s) from ${new Set(from.values()).size} spec(s), over the given models.`,
        repeats: 3,
        approve: "auto",
        dimensions: { model: models },
        apply: (combo) => ({ backend: { model: String(combo.model) } }),
        tasks,
    };
}

export default (load: { models?: string[] } = {}) => regressionSpec({ models: load.models ?? [] });
