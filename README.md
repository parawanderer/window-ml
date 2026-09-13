# window.ml

[![tests](https://github.com/parawanderer/window-ml/actions/workflows/tests.yml/badge.svg)](https://github.com/parawanderer/window-ml/actions/workflows/tests.yml)

A one-person systems research program on LLM inference as a boring primitive, co-designing the client and the server.

It is an exploration of one question: what should running an autoregressive model look like if it were a boring,
reliable, hands-off primitive? Something you call and stop thinking about, like `fetch`: it fails in known ways,
costs what you expected, and can be inspected down to the byte when you do care.

Any idea I have on that goes here. Each is tried first where it is cheapest, usually in an agent harness with a
prompt and a tool, and goes further down only if it earns it: into the server, the inference engine, and for some,
eventually training. The interesting ones tend to need the whole stack, so this repo reaches into forks of
[OpenWebUI](https://github.com/parawanderer/open-webui), [Ollama](https://github.com/parawanderer/ollama) (heavily
modified) and [llama.cpp](https://github.com/parawanderer/llama.cpp). It is uneven as a result: each idea is only as
deep as it has had to go so far.

The harness happens to be a Chrome extension that puts `window.ml` on web pages. That is where this started, and a
web page is a convenient source of real tasks with a person watching, but it is incidental.

## Where the ideas stand

| Idea | Tried so far in | Would belong in |
| --- | --- | --- |
| Every run can be inspected down to exactly what the model saw, and where the time went | the harness and the server: the sidebar, the exports, the server's event stream | every layer |
| A tool's output is referred to by a short pointer instead of being copied back into the context | the harness: a prompt, a dereference tool, an A/B pilot | post-training |
| Arithmetic in a thinking block is evaluated deterministically and the result spliced into the output | not started | the inference engine's decode loop, then post-training |
| The server decides where a model goes and how long it stays loaded, predicted from how models are actually used; the caller sets no knobs | the server (Ollama fork) | the server's scheduler |
| The client tells the scheduler who is waiting on each request and which requests belong together | client and server; recorded as data for the placement and keep-alive predictor | the server's scheduler |
| The server predicts each generation's decode speed and corrects itself from what it measures | the server (Ollama fork) | the server |
| Read-only work runs without asking a person; everything else asks | the harness: a mediated JavaScript dialect | the harness |

**Right now.** The inspection row is being finished first, because the rest depends on it: the benchmark tooling
consumes that data, and the pointer A/B needs both, so those two are paused until it is done. On the server side,
the active work is predicting placement and keep-alive from recorded use, which is an applied statistics problem
rather than an engineering one.

## What it is not

Not a framework or a product, and it will not become one. The code is largely AI-written. It has tests and it runs
on my machine, but there is no roadmap and no support, and interfaces change whenever an experiment needs them to.
Against stock Ollama and OpenWebUI the harness works; the parts that need a fork say "not reported" instead.

If you do run the extension: `window.ml` lives in the page's main world, so any page it is active on can call it,
and a hostile page can subvert it. Keep its site access on "On click". See
[the trust model](docs/API.md#security--trust-model).

## If you want to look

- Run it: [docs/SETUP.md](docs/SETUP.md) for the extension, [docs/FULL-SETUP.md](docs/FULL-SETUP.md) for a backend
  from scratch.
- The page API (`ml.chat`, `ml.agent`, …): [docs/API.md](docs/API.md).
- What needs which fork: [docs/FORKED-BACKENDS.md](docs/FORKED-BACKENDS.md).
- How the code works: [AGENTS.md](AGENTS.md) and [docs/dev/](docs/dev/). Building and testing:
  [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT. Fork whatever is useful.
