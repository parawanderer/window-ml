# Pyodide mount notebooks

Measurements for #1780 route A: a synchronous host-backed filesystem in the Pyodide worker, blocking on a sliced
`Atomics.wait` while a request goes worker, offscreen document, service worker, `wmlhost` and back. Each notebook has
a generator beside it (`make-<name>.py`, the file to edit). Its inputs are the committed files in `data/`, written by
the scripts below.

- [route-a.ipynb](route-a.ipynb): whether route A's Stop latency and cost are good enough or route B (a JSPI rebuild)
  is needed, and what size cap a whole-file fetch needs: Stop latency, per-operation cost, each hop, the end-to-end
  chain, `os.walk` by cache mode, `import` by variant, large files, the lockdown reach probes, and a derived estimate of
  the product cost of a walk and an import (requests times the chain's small-request round trip, plus the Node
  sandbox-side time; an estimate composed from two measurements). Generator: `make-route-a.py`.

The scripts, each saying how to run it in its header (the measurements are done; the large-file and Chromium runs are slow):

1. `measure-node.mjs` (with `node-worker.mjs`): the sandbox side in Node, real Pyodide with a prototype filesystem type;
   writes `data/node-stop.json`, `node-cost.json`, `node-walk.json`, `node-import.json`, `node-large.json`,
   `node-lockdown.json`.
2. `measure-hops.mjs` (with `hops-ext/`, the probe page and worker): the message hops in a real Chromium with the built
   extension and a real `wmlhost`; writes `data/hops-*.json`.
