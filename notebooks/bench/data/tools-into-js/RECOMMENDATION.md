**Keep `fetch_url` as a tool beside `ml.fetch`; do not fold it into JS alone.** Over 90 runs (gemma4:31b, gemma4:12b,
qwen3.8-flash-next:vision; 5 repeats; same-origin fixture):
- **A read is the tool's.** On `find-out`, fetch_url alone took 2.3 steps, 12.6k tokens and 11.2 s per run (means);
  exec alone took 5.0 steps, 28.6k tokens and 26.4 s, at 15/15 against 14/15 correct.
- **A computation is JS's.** On `sales-total`, fetch_url alone was 0/15, and 7 of those runs hit the 300 s cap. Exec alone was 14/15 in 4.2 steps and 26.0 s.
- **With both, models choose well on their own.** fetch_url was the first reader in 29 of 30 runs. On `sales-total`
  all 15 used exec (14 of them after opening with fetch_url), and 13 of 15 were correct; on `find-out` 2 of 15 used
  exec, and all 15 were correct.

**The cloud pair agrees.** deepseek.deepseek-flash and openrouter.openai/gpt-6-luna (60 runs, 0.18 USD; gpt-6-luna in
place of Sonnet 5.5, Shane's choice) repeat every line above. `find-out`: tool 10/10 in 2.7 steps and 7.8 s, exec 9/10
in 6.0 steps and 15.5 s. `sales-total`: tool 0/10, exec 10/10. Both arms: 20/20 correct, fetch_url first in 19 of 20,
every `sales-total` run went on to exec. With fetch_url alone on `sales-total`, no cloud run hit the 300 s cap: 4 said
they could not compute an exact total, 3 stopped at the 10-step cap, and 3 (all gpt-6-luna) gave a wrong number as the
answer. In the exec arm, all 19 that read anything read through `ml.fetch` first; none read `agent_api_docs` first.

**Finding the member.** With fetch_url's description absent, 26 of the 30 exec-arm runs used `ml.fetch`, each in its
first or second step (median: the first); the other 4 (gemma4:12b, `sales-total`) used the
page's own `fetch`, and all 4 were correct. None read `agent_api_docs` before its first `ml.fetch`: exec's one clause
naming `ml.fetch(url)` was enough.

**A defect the sweep found.** `ml.fetch('/sales.csv')` is refused as "not a valid URL": the worker parses the URL
with no base (`src/sw/sw-fetch-url.ts:62`). 9 calls in 9 local runs and 10 in 10 cloud runs passed the task's relative path;
each was refused, and each run recovered with an absolute URL. #1541 (open) resolves it against the page. Resolving a relative URL against the page would save
those turns.

**Negative results and limits.**
- Five models: three local, two cloud. Sonnet 5.5 was not run.
- Same-origin only, so a page-world `fetch` works; cross-origin would force `ml.fetch`.
- In the tool arm, 15 calls in 9 runs went to a tool the arm did not offer, all on
  `sales-total`.
- Two exec-arm runs were wrong. qwen3.8 (`sales-total`, repeat 2) had the right total in its `answer` step, then a
  final message about line counts; the bench scores the final message, so it counts as wrong. gemma4:12b
  (`find-out`, repeat 3) called `ml.fetch` 7 times and answered "v1.4.0", a version the changelog does not have
  (it runs 2.0.0 to 2.4.0).
- One cloud exec run was wrong: gpt-6-luna (`find-out`, repeat 2) read nothing and asked the user to open the page.
- `exec-bare` (exec with the `ml.fetch` clause removed) was left out by design, so whether a model finds the member
  with no hint at all is not measured.
