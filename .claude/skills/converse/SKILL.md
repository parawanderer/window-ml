---
name: converse
description: Talk to a model running in the real extension one turn at a time, through files — answer its questions, steer it, rule on its approval gates, interview it about the tooling. Use when observe's fixed task + one FOLLOWUP is not enough, e.g. a usability interview of a feature with a real model.
---

# converse — a run you talk to

`tests/e2e/converse.mjs` drives the same `runOnce()` core as observe (`tests/e2e/run-once.mjs`), but asks for each
next turn as the run goes, through a directory. Start it in the BACKGROUND (it waits for you), then write and read files.

```bash
D=tests/e2e/artifacts/talk-gemma
CONVERSE_DIR=$D USE_ENV=1 E2E_MODEL=gemma4:31b TASK="…first message…" node --import tsx tests/e2e/converse.mjs   # background
```

| File | Who writes it | What it is |
| --- | --- | --- |
| `inbox/<name>.txt` | you | the next message. Taken in name order (`001.txt`, `002.txt`), deleted once read. `/end` ends the session. |
| `outbox/turn-<n>.md` | the driver | turn n: the model's answer, then each step: tool, arguments, result (clipped), who approved it |
| `run.md`, `run.json`, `events.json` | the driver | the whole session so far, exactly as observe writes them |
| `status` | the driver | one line: `running turn n`, `turn n done …; waiting for inbox`, `gate: …`, `done after n turn(s)` |
| `gate.json` / `decision` | driver / you | with `APPROVE=ask` only: a gate waiting; write `approve` or `deny` into `decision` |

Wait for a turn with a loop on `status` (never a bare sleep):

```bash
until grep -q "waiting for inbox\|^done\|^gate" $D/status 2>/dev/null; do sleep 2; done; cat $D/status
```

Without `TASK`, the first message is the first inbox file. Everything else is observe's env (`START`, `TOOLS`,
`PYTHON`, `TOOLTOKENS`, `SHARED_WATCHES`, `WATCH_NOTES`, `SURFACE`, `WATCH`, `HEADFUL`, `WARM`, `APPROVE`). Each turn gets runOnce's
`timeoutMs`; a session with no inbox message for `CONVERSE_IDLE_MS` (default 30 min) ends on its own.

## Attaching to a run another process drives

`node tests/e2e/converse.mjs --attach <dir> "<message>"` posts the message to `<dir>/inbox/`, waits for the turn it starts
and prints it; without a message it prints `status` and the last turn; the message `/end` ends the session. It is how a
held bench cell (`bench/run.mjs --hold`, `bench/hold.mjs`) is talked to, and works on any converse directory. It needs
no TypeScript loader.

## Gotchas

- **Console run unless `SURFACE` is set.** The default is `ml.agent` from the page: no `click`, `type` or
  `python_exec`. A review of "the toolset" or "the prompt" should say which it saw; `SURFACE=hud` is what a person gets.

- **One driver per directory.** Two drivers on one inbox take turns' messages from each other.
- **`turn-<n>.md` is clipped** (arguments 800, results 1200 characters). Read `run.md` for the full record.
- **It is real traffic to a real backend**: requests say `synthetic` like observe's unless `SYNTHETIC=0`.
