# The sign-in redirect chain — red-team measurement (2026-11-26)

What a `navigate` from a run with NO tab gets when the site sends its tab on, as an OAuth login does: card → login →
identity provider → callback with a `code`. Measured on `origin/main` at `30e75516` (TABLESS_RUN step 3, #2181 merged),
with a scratch probe first and then five committed rows, `tests/redteam-signin-chain.test.mjs`. No code is proposed,
because none of what is measured breaks a rule; one rule question is put to Shane (§4), and the uncovered-arrival rule
is NOT proposed for change (§5). Every claim below is a row or a line of source.

## 1. What the chain is

The harness starts the run the chat page's way with "No tab" (`agent.start`, a `detached` target), the model's first
call is `navigate("https://app.example/login")`, the person approves the card, and the tab the call opens reports a
SERVER redirect as its URL (`chrome.tabs.get` is answered with the landed page, as `no-tab-nav.ts` reads it). The move
is made at the step boundary by `applyLiveMove` (`src/sw/move-run.ts`), the run's page is judged by `judgeHere`
(`src/sw/sw-run-host.ts`), and the model gets `navigatedNote` (`src/sw/move-run.ts:77`).

## 2. What the model reads: the landed URL, whole

The note is one line and carries the tab's URL exactly as the browser reports it:
`[this run had no tab; its navigate opened tab "<host>" (<full landed URL>), and the run is on it now]`. For an
authorization callback that is the code and the state, e.g.
`(https://app.example/callback?code=CODE123&state=st456)`, committed as a row: the first test in
`tests/redteam-signin-chain.test.mjs` asserts the exact line, so the code is in the model's next request. The second
row lands on `https://app.example/start#access_token=TOK123&token_type=bearer&state=st456` and asserts the FRAGMENT is
carried too: `unfragmented` (`src/sw/nav-arrival.ts`) tells the arrival judge a fragment is not another page, but the
note never goes through it, so in an implicit flow the access token itself is in the model's request.

The card that was approved named only `https://app.example/login`; the note names the landed page. The person's
evidence that the tab went elsewhere is the tab, which is where the browser shows it.

## 3. What the run gets from an uncovered landing

All of this is the 2026-10-24 rule as TABLESS_RUN.md states it ("An arrival no policy covers passes, as a tab run's
does", part 3, as built 2026-11-25), now measured in the sign-in shape:

- **The run moves.** One `ADOPT_RUN_NOW` to the opened tab, no arrival card, no execution-log record. Row 3 lands on
  `idp.example` and asserts both, and that its `scroll` — a read-only call — reaches the page with no card of its own.
- **The landing consents nothing.** The card's approval grants the origin it NAMED (`grantRunOrigin`), and the move
  grants nothing. A credentialed `fetch_url` to `https://idp.example/data` raises its card; the same call to
  `https://app.example/data` does not, because that is the named origin and, after the bounce, the page the run is on.
  Row 5.
- **The page the run is ON is free in every fetch mode, so the bounce can hand the run a credentialed read it was never
  asked about.** After landing on `idp.example`, a credentialed `fetch_url` to `https://idp.example/session` raises
  NOTHING (row 4). The run did not have that read before the bounce: the card named `app.example`, and a read of
  `idp.example` while the run was anywhere else asks (row 5's control). The rule itself is not new — "the page you are
  ON is free in every fetch mode" (wire-and-fetch.md) — but a sign-in redirect is the cheapest way to put a run on a
  third party, and the person approved a page at a different host.

The per-call gates are intact behind all of it: an `exec` on the landed page asks (the probe's first script raised its
card at seq 2), and a credentialed read of any OTHER origin asks.

## 4. The one question for Shane: should an authorization URL reach the model?

Not a defect against today's rules. Full target URLs reaching the model is RULED (SITE_PRESENCE.md, "Redirects on
auto-approved fetches", 2026-10-30: the model and the person see the full target, the page does not), and `ml.current`
reports the page URL on request anyway (`src/agent/current-context.ts`), so the note is an unprompted push of what the
model can already ask for. What the sign-in chain adds is that the URL is a CREDENTIAL by construction: a `code`/`state`
pair, or an implicit flow's `access_token` in the fragment, now sits in a request to a cloud model the person chose for
an unrelated task.

The options, as a proposal and not a change:

1. **Keep it** (my recommendation): it is the ruled reading of a URL, the model needs to know where it is, and scrubbing
   the note alone buys nothing while `ml.current` still answers with the page URL. Record the sign-in case in
   TABLESS_RUN.md next to `navigatedNote` so the next reader does not re-derive it.
2. **Scrub credential-shaped parameters wherever the model reads a URL** (`code`, `state`, `access_token`, `id_token`,
   …): a real narrowing with a real cost, since it is a rule over every URL the model sees (the note, `movedNote`,
   `ml.current`, the fetch refusals' targets) and a param-name list that the web outruns. If Shane wants it, it is a
   POLICIES.md / SITE_PRESENCE.md rule first.
3. **Do not send the query or the fragment in the arrival note**: the narrowest patch; it breaks no defence but removes
   the model's bearings on exactly the pages where they matter (an OAuth flow's steps are told apart by query).

## 5. Not a finding: the uncovered arrival itself

The coordinator's condition was to report it if an uncovered arrival SHOULD NOT pass. It should:

- A redirect is the SITE's act, on a URL the person approved; the run acting on the page the person can watch is what a
  tab run has always done, and this rule is "as a tab run's does".
- The thing an uncovered pass does not buy is a grant: §3's rows show the named origin keeps its grant, another origin
  asks for a credentialed read, and an `exec` asks on arrival.
- What a person's policy buys on the landing is measured already and holds for the detached shape:
  `tests/no-tab-run.test.mjs` rows 399 (uncovered → moves, no grant), 418 (ask → held, unadopted, until answered), 433
  (deny → held, never adopted), 443/458 (declined / Go back with no page to return to). My rows are the same shapes
  with a credential-bearing URL and an identity provider; they pin, they do not repair.

## 6. Recorded so they are not re-derived

- **The redirect HOP is never judged; only the final URL is**, at the move. A chain `login → tracker.invalid → idp` is
  judged on what `chrome.tabs.get` reports at load. The browser's own redirect hops are not pages the run acts on.
- **A detached run's session row carries no `page` after the move** (`page` names where a session STARTED; the live tab
  is `bgRuns.tabId`, and `refreshTaskRow` only drops `background.noTab`). The sidebar shows the run without a page; the
  page is the tab. No row: `page` is not a run's-now field for any run shape, and `hasTab` reads the live map.
- **The fragment is two different readings of the same landing**: the arrival judge unfragments it (a fragment is not
  another page), the note sends it whole. That asymmetry is why §4 is a question and §2 is a fact.
- **A `read` step after the bounce** (the probe's first script) ran on the landed page in the same turn; the model then
  read the landing in the note. Nothing is sent to the page it left.

## 7. Re-running the rows

`node scripts/test-slot.mjs run --kind unit -- node --import tsx --test tests/redteam-signin-chain.test.mjs`, with
`dist/` built at the head under test. The file imports no other test file (its own harness, the shape of
`tests/no-tab-run.test.mjs`'s `run`), and `chrome.tabs.get` is answered with the landed URL the way `helpers.js`'
`onTabsGet` does it.
