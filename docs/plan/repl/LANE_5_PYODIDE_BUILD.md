# Lane 5: build the patched CPython into Pyodide and ship it (MiMo)

Read first: [`ROUND_3.md`](ROUND_3.md); [`LANE_3_RUNTIME.md`](LANE_3_RUNTIME.md) and [`LANE_3_RESULT_H.md`](LANE_3_RESULT_H.md)
(the fork, the vectors, what the build plumbing in window-ml #754 already does); `docs/dev/python-sandbox.md`; the
fork itself, `parawanderer/cpython` branch `ml/restricted-mode`, rebased onto v3.14.2 in #760.

## The goal

`python_exec` today runs stock Pyodide and the dialect's restriction is enforced by the fork only in the Node tests.
This lane produces a Pyodide distribution built from the fork, puts it where `npm run fetch-pyodide` can fetch it, and
makes the 87 dialect vectors pass under the extension's real `dist/pyodide/`. Lane 3 wrote "it needs the emscripten
toolchain and hours per build; write down what it will take when you know". Writing that down, with numbers, is the
first deliverable.

## Deliverables, in order

1. **A build recipe that reproduces**, as a script under `tools/` (not `scripts/`, which is the repo's self-tools):
   pin the Pyodide version, the fork commit, the emscripten version; build; record wall time, output size, and the
   machine. If a laptop build is impractical, the GPU box is an option: write a handover file for the agent there
   (ask Shane to run it; the file goes to its inbox, the protocol is in Shane's instructions) and do not drive the box
   yourself. A build that takes hours runs in the background from the first attempt.
2. **Where the artefact lives** is Shane's decision. Propose one (a GitHub release on the fork, or a release asset on
   window-ml) with the size and the fetch URL shape, mail the coordinator, continue under the assumption you named.
3. **`fetch-pyodide` takes the built distribution**, keyed by a pinned version in one place, and the real-CPython tests
   that self-skip without `dist/pyodide/` run against it. The measure is the 87 vectors, the Python genre
   (`node scripts/test.mjs python`), and the e2e that drives `python_exec`.
4. **CI**: whatever the test and build jobs need so the uploaded extension can run `python_exec` under the fork. The
   `ci` skill is the playbook; the CI janitor is who to ask about the jobs.

## Not this lane

Option A (specialized forms) stays deferred. No change to the dialect, the vectors or the worker's Python beyond what
loading the new distribution requires; lane 6 is in `src/python/` too, so message it before touching a file there.
`mode` removal is lane 7's.

## Who reviews

The generalist (it was lane 3 and owns the fork); the CI janitor for the CI half.
