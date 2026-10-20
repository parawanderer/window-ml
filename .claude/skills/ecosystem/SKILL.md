---
name: ecosystem
description: One command for "how much code have the agents written across window.ml, the hub, the host and the forks (ollama, llama.cpp, open-webui, cpython), and how much of it survives" - lines, commits, PRs, test cases, Claude-trailer share, churn, and with --blame who wrote the lines alive today. Use when the README's size or authorship claim needs a fresh number, or when asked how much is agent-written or how much has been thrown away.
---

# The whole ecosystem in one table

```bash
node scripts/ecosystem.mjs            # table + HEADLINE (a few seconds; PR counts and live fork diffs need `gh`)
node scripts/ecosystem.mjs --blame    # adds survival: lines alive today by last-touching commit's trailer, and by month (about a minute)
node scripts/ecosystem.mjs --no-gh    # git only; fork figures fall back to the newest snapshot in docs/vitals/history.json
node scripts/ecosystem.mjs --json     # the same figures as JSON
```

Repos come from `vitals.mjs` (`REPOS`: window-ml, window-ml-hub, window-ml-host; override the siblings with
`VITALS_HUB_DIR` / `VITALS_HOST_DIR`). The extended projects are counted as what they ADD over upstream: ollama,
llama.cpp and open-webui through GitHub's compare API (the `FORKS` list in `vitals.mjs`), cpython from a local clone
(`CPYTHON_DIR`, default `../cpython-restricted`, remote `fork`), because its fork branches off a 3.14.x release and a
compare against upstream `main` is thousands of commits of noise. Fork figures are a floor when marked `truncated`.

## How "agent-written" is decided

Every commit is authored under the owner's identity, so the only attribution is the `Co-Authored-By: Claude …` trailer.
A non-merge commit with one is agent-written. `--blame` gives a line to the last commit that touched it, so a formatter
pass or a bulk move re-attributes lines to the rewriting commit (usually an agent too). Say the number as "N% of commits
carry a Claude trailer", not "the owner wrote none of it".

## What it does not measure

- "Maintained successfully" has no git measure. `alive %` (code+test now over code+test ever added) says lines were not
  thrown away, not that they are right; moves count as added again, so it is a floor. For "does it keep working" read
  `vitals.mjs`: fix share and the CI failure rate on main.
- Test counts are a regex over test files, not a runner's count.
- Fork commits are counted from the owner's non-merge commits not reachable from upstream (cpython) or the compare API.

Not a replacement for `vitals`: that is the monthly trend and writes `history.json`; this is the point-in-time total and
writes nothing. Quote its numbers with the date and the head SHAs (`--json` has them).
