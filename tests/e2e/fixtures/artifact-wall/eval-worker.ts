// eval-worker.ts — the read-only evaluator as the body of the worker an artifact frame starts from a blob (spike Q2 of
// docs/spec/ARTIFACTS.md): each message is one script, run in the worker realm over the `current` and `globals` sent.
import { evalReadonly } from "../../../../src/readonly-exec";

const started = performance.now();
self.onmessage = async (e: MessageEvent) => {
    const { id, code, current, globals } = e.data;
    const t = performance.now();
    try {
        const r = await evalReadonly(code, null, {}, undefined, { realm: "worker", current, globals });
        postMessage({ id, ok: true, value: r.value, logs: r.logs, ms: performance.now() - t });
    } catch (err) {
        postMessage({ id, ok: false, error: `${(err as Error)?.constructor?.name}: ${(err as Error)?.message}`, ms: performance.now() - t });
    }
};
postMessage({ ready: true, ms: performance.now() - started });
