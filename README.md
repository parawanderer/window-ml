# window.ml

I'm an applied mathematician. This repo holds experiments on LLM inference: whether a server can learn where to
load a model and for how long from recorded use, whether it can predict decode speed and correct itself, and what
becomes possible once every piece of a context has an address. Agents write and maintain the code and I don't read
it. What I'm after is the findings. Some of it replaced chat UIs I was fed up with, and I use those parts daily.

The loose theme: what would it take for calling a model to be as boring as calling `fetch`? You call it and stop thinking
about it. It fails in known ways, takes about as long as you expected, and when something does go wrong you can see
exactly what happened.

An idea gets tried in the cheapest place first, usually an agent with a prompt and a tool. If it still looks good it
goes further down: into the serving layer, the inference engine, and for a few, eventually training. Some only work
if several of those change together, which is why the [apparatus](#apparatus) spans all of them.

So this is a hypothesis-testing apparatus more than a codebase. Every row of the table below is a claim that might
be wrong rather than a feature that is planned. What should outlast any of them is the finding: a short technical
note on how the thing works and whether it held up, and a proper implementation wherever it actually belongs. That
is what the third column is saying. None of those places is this repository.

## The ideas, and how far each got

So far this is mostly glue. Few of the ideas have actually been tested; the middle column says which.

I looked for existing tools that do these things before starting and did not find any. A few rows have relatives
that work on the same problem by a different mechanism; those rows say what the relative is and how this differs.

| Idea | Tried so far | Where it would end up if it works |
| --- | --- | --- |
| You can see exactly what the model saw on every run, and where the time went | the sidebar, the exports, the serving layer's event stream | everywhere |
| A tool's output is referred to by a short pointer instead of being copied back into the context. The closest relative is [code execution with MCP](https://www.anthropic.com/engineering/code-execution-with-mcp) (Cloudflare calls it Code Mode), where intermediate results stay in an execution environment unless the script returns them. Here the pointer is how the context itself refers to a tool's output, not something that exists only inside a script, and the end goal is a model trained to use it | a prompt and a dereference tool; one A/B pilot | post-training |
| The agent manages its own context: it collapses stale tool outputs to their pointers with a projection it picks, and expands them when it needs them again. Pointers name typed objects (a table, not its text) that JavaScript and Python compute over | typed table pointers both runtimes read; collapse itself not started ([notes](docs/spec/AGENT_COMPACTION.md)) | the agent, then post-training |
| Once every frame has an address, a context can be built from a chosen set of frames rather than only accumulated, which allows asking a fresh window what it makes of a conclusion without the turns that produced it ([below](#building-a-context-from-chosen-frames)) | not started | the agent |
| Arithmetic in a thinking block is worked out exactly and the result spliced into the output | not started | the engine's decode loop, then post-training |
| Where a model is loaded and how long it stays loaded is decided by the serving layer, learned from how models actually get used, with no knobs for the caller | in the serving layer; the routing a mixture of experts actually does is recorded in the engine | the serving layer |
| The client tells the serving layer who is waiting on each request and which requests belong together | sent and recorded, as data for the placement and keep-alive predictor | the serving layer |
| Each generation's decode speed is predicted and the prediction corrected from what is measured | in the serving layer | the serving layer |
| Read-only work runs without asking me; everything else asks. The permission is whether the script is written in a small JavaScript dialect designed so that it can only read, always halts, and leaves nothing behind when it refuses | [the dialect](docs/dev/readonly-exec.md), still growing | the agent |
| An agent uses my credentials without ever being able to read them: it holds a handle, and the secret stays in the client's background worker. Holding a handle while a broker keeps the secret is an old pattern in security; I have not found it done for a browser agent | not started ([notes](docs/spec/SECRET_HANDLES.md)) | the client's background worker |
| I drive an agent at home from my phone through a relay designed so that it cannot drive the agent itself | [the relay](https://github.com/parawanderer/window-ml-hub) carries sealed traffic and a connector republishes a box's telemetry through it, self-hosted. The client's own connector is not built, so nothing drives an agent through it yet ([notes](docs/spec/RUNTIME_HUB.md)) | a small relay server, and the client |

<!-- TODO: one flat sentence in the placement row on what the stock scheduler could not do without the caller tuning it. -->

### Building a context from chosen frames

What the pointer mechanism then makes possible is itself the interesting part. Once every frame has an address, a
context is something you build from a chosen set rather than only accumulate: from a run of turns 1..N, assemble a
window holding only 1..N-K and ask it what it makes of the conclusion the dropped turns produced. It is seeded with
the original frames rather than a summary of them, so unlike a subagent it can read that conclusion without having
been told what to think of it, and sweeping K measures which turns the conclusion actually rested on.

Not started. Dropping a suffix is the sound case, since everything dropped is downstream of everything kept;
masking an interior block is not, because the conclusions it produced stay behind.

The closest relative is [ContextCite](https://github.com/MadryLab/context-cite) (Cohen-Wang et al., NeurIPS 2024),
which includes and excludes parts of a context and fits a surrogate model to score which parts a response depended
on. That attributes a single response to sources in a single prompt. This is a different object: an agent
reassembling its own history from the original frames, and a fresh window judging a conclusion rather than a score
being fitted. What it shares is the cost. One sample from a stochastic model says little, so each K needs several
runs; for scale, ContextCite reports its results from 32 ablations per attribution.

**Right now.** Finishing the first row, because the rest depends on it: the benchmark tooling reads that data and
the pointer A/B needs the benchmark, so both are paused until it is done. In the serving layer I am working on
predicting placement and keep-alive from recorded use, which is a statistics problem rather than a coding one.

## Apparatus

The experiments need a client that produces real tasks, a chat server, a serving layer and an inference engine.
Each is an existing tool, modified where an idea required it, because starting from them was cheaper than generating
the equivalent from scratch. None of them is the point, and any could be swapped for something that does the same
job.

- **Client:** a browser extension that puts `window.ml` on web pages (this repository). A web page is an easy
  source of real tasks with me watching.
- **Chat server:** [a modified OpenWebUI](https://github.com/parawanderer/open-webui), where the client needs a
  route it does not have.
- **Serving layer:** [a heavily modified Ollama](https://github.com/parawanderer/ollama). The changes are in the
  scheduler: what it reports about itself, and what it learns to predict from use.
- **Engine:** [a modified llama.cpp](https://github.com/parawanderer/llama.cpp), for what the serving layer cannot
  see or change.
- **Relay:** [window-ml-hub](https://github.com/parawanderer/window-ml-hub), written for this, which lets devices
  reach each other's runtimes.

The modified tools are not kept in step with their upstreams, and nothing is written up in them: notes and findings
land here, in `docs/`.

## About the code

Nearly all of it was generated by Claude Code. There is a lot of it because code got cheap, not because building
it was the aim: until recently, trying ideas at this scale meant first employing people to write the code, and
exploring what becomes possible once that cost is close to zero is part of the point. 

Whether agents can keep a codebase this size working with no person reading or reviewing it is itself one of the
experiments, and the most interesting one. Until recently it could not have been tried at all: no model could keep
even a small codebase working on its own. In its first three months this repository reached about 240,000 lines
over 1,800 commits, and about 285,000 counting the relay and what the modified tools add to their upstreams
(October 2026). So far they have, by the only measure I have: the parts I use daily keep working. That is a weak
measure. A proper one (regressions I notice, whether adding a piece gets more expensive as the code grows) is not
defined yet.

It is glue: whatever an idea needed in order to be tried at all, and that turns out to be a lot. The tests are not
a quality claim. They are there so the agents do not break the rest of the glue while they build the next piece.

So expect it to be uneven, and expect interfaces to change whenever an experiment needs them to. If an idea here
works, what is worth having is the write-up and a real implementation in the place the idea belongs, not this code
borrowed. The glue is scaffolding.

## If you run it

These are experimental research scripts, not a reviewed product. Nobody has reviewed the security either, including
the parts meant to keep a hostile page away from your API key, so run it in a browser profile you would not mind
losing. The same goes for the properties the table states, such as a dialect that can only read and a relay that
cannot read or drive what it carries: those are what the design intends, and no person has verified that the code
delivers them. If you want to review it or contribute, you are welcome to; I am not going to maintain it for anyone
else.

`window.ml` lives in the page's main world, so any page the extension is active on can call it, and a hostile page
can subvert it. Keep its site access on "On click". See [the trust model](docs/API.md#security--trust-model).

Against stock Ollama and OpenWebUI the agent works; the parts that need a modified backend say "not reported"
instead.

Docs: [setup](docs/SETUP.md), [backend from scratch](docs/FULL-SETUP.md), [page API](docs/API.md),
[what needs which modified backend](docs/FORKED-BACKENDS.md), [notes for the agent](AGENTS.md) and
[docs/dev/](docs/dev/), [building and testing](CONTRIBUTING.md).

## License

MIT. Fork whatever is useful.
