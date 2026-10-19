# Lane 4, the host's hub transport, H1–H3 (result)

Work slug `repl-lane4`, session `b9bc1868-816e-4f91-86bc-4fc2e0f3047e`, model `claude-opus-5-5`, 2026-10-19. Rulings:
the coordinator's of 2026-10-19 (Q1–Q5, and the H2 and H3 additions). Each slice had a MiMo security review
(window-ml-flaky-3f) before it merged.

## What landed

- **window-ml-host [#9](https://github.com/parawanderer/window-ml-host/pull/9)** (H1, `d211507`): the host's identity
  on a hub. It pairs as a `Runtime`, and keeps two local files that only `wmlhost hub` on that machine writes:
  `hub-roots` and `hub-callers`.
- **[#10](https://github.com/parawanderer/window-ml-host/pull/10)** (H2, `3ef2184`): `wmlhost hub serve`. A command is
  admitted in a fixed order (seal, `desktop` scope, revocation, callers), and each caller gets a session of its own.
- **[#11](https://github.com/parawanderer/window-ml-host/pull/11)** (H3, `ea4b8f4`), tag `v0.5.0`: `done` is published on
  a stream of the caller's own. A caller gone past the grace loses its calls, and only its own.

All of it is behind the `hub` Cargo feature, and the default build still compiles no `wmlhub-*` crate
(window-ml-host's `check-no-hub.sh`). The wire as built is
[`HUB.md`](https://github.com/parawanderer/window-ml-host/blob/main/docs/HUB.md) and
[`PROTOCOL.md`](https://github.com/parawanderer/window-ml-host/blob/main/docs/PROTOCOL.md) (`transport`, `hub`, `v`).

## The host as built

- **Admission.** A refusal is sealed back as `Refused` with a `reason`: `scope`, `revoked`, `stale` or `notACaller`.
  Nothing is routed when a command is refused. A command whose seal does not open gets no answer at all.
  `hub-callers` is re-read for every command, so a `disallow` holds from the next call.
- **Revocation.** It reuses `wmlhub_connector::revoked` v0.4.3, so the logic is not copied. The 7-day freshness floor
  applies per call: a week without hearing the revoker refuses every caller.
- **Over the hub, `configure` only narrows.** It refuses a root outside `hub-roots`, `sandbox: false`, and any call on a
  machine without a working sandbox.
- **One session per caller.** Each caller gets its own `Host`, `Store` and `owners/<principal hex>` table. Seqs are
  rewritten to host-chosen ones and restored on the answer.
- **Events.** A caller's events are sealed under a `StreamKey` of its own, on
  `channel("host.events", <caller>)`. The key is wrapped to that caller's agreement key alone, on the retained
  `channel("host.keys", <caller>)`, and only when its leaf holds `view`; `hello` reports `hub.events`. Each frame is the
  native event JSON plus `v` (`session::PROTOCOL`). The counter starts at `max(now_ms * 1000, mark)`. The mark, kept in
  `<state>/stream-counter`, is leased 1000 ahead and written before a frame is sealed, so a restart with the clock
  stepped back still counts up.
- **A caller going away.** Presence offline starts a 30 s grace (`PRESENCE_GRACE`). Presence online, or a command from
  that caller, clears it. When it expires, only that caller's session input closes, and `onOwnerLoss` then applies to
  its calls.

## What the tests showed

`hub-tests/tests/serve.rs` runs 16 tests against an in-process hub with the real sandbox, and `pairing` runs 6. Every
admission check, the configure ceiling, the `view` gate, the expiry filter and the counter mark was removed in turn, and
each removal failed a test. The reviewer repeated the mutation checks on the order and callers check, `sandbox: false`,
the `view` gate and the due-only expiry. CI's `hub-feature` job sets `WMLHOST_REQUIRE_SANDBOX=1`, so a missing sandbox
fails the job instead of skipping it. CI was green on macOS and Ubuntu for every slice, with and without the feature.

## Verified against the extension

- **The revocation channel matches.** The extension publishes the list on `channel("revocations", client.principal)`
  with `KIND_SESSION_EVENTS` (`src/hub/runtime/hub-runtime.ts:184`). The host subscribes to
  `channel(REVOCATIONS_PURPOSE, revoker)`, where `REVOCATIONS_PURPOSE` is `"revocations"` from `wmlhub_connector`, for
  each revoker it sees in presence.

## Found by building

- **The owner ledger is named per process.** Callers that shared the native ledger directory would overwrite each
  other's rows, and `status` would show the person's own orphans and their `owner` JSON to a caller. Each caller now
  gets `<state>/owners/<principal hex>`.
- **A shared `Store` collides.** Call temp dirs are named by the per-session id (`c1`, …), so two callers sharing one
  store got `SpawnFailed: temp dir: File exists`. Production already gave each session its own store through
  `Host::from_system`. The test helper now does too, `MakeHost` documents the requirement, and a test asserts that one
  caller's `read` of another's pointer is `UnknownPtr`.

## Open, and not done

- **For Shane: who receives the events key.** It goes to the calling principal only, where the extension's
  `SessionPublisher` sends to every `view` device of the account. Each caller's held output and owner table are already
  private to it. Widening the recipients later is one change; narrowing them after a release is not.
- **The 30 s grace was chosen, not derived.** It is a constant (`PRESENCE_GRACE`) and is not configurable.
- **The frame is the host's native `done` JSON**, not the extension's `SessionStreamMessage` envelope
  (`epoch`/`cursor`). Whether a reader in the extension wants that envelope is for its consumer to decide.
- **The phone's UX for pairing a desktop runtime** is not built (chat-hub topic). Pairing works from the CLI only.
- **Non-blocking review notes.** An `asked` entry is removed only when its answer arrives, so a caller that abandons
  calls grows the map until the connection ends. A leaf whose agreement key is not 32 bytes is dropped without an
  answer, because there is no key to seal one to. Two callers granted in the same millisecond share a counter start,
  but they have different keys and channels.
- **No reconnect loop.** `serve` exits when the connection ends, and a service manager restarts it.
