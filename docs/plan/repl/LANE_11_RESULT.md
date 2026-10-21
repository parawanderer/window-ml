# Lane 11: the host's leftovers and the policy tree's design (result)

Work slug `repl-lane11`, session `a0a98fc7-c5c5-4a88-8d3d-02e4b20ac1fd`, model `claude-opus-5-5`, 2026-10-21. The brief
is [`LANE_11_HOST_AND_POLICY_TREE.md`](LANE_11_HOST_AND_POLICY_TREE.md). All three items are done.

## Security fix on the shipped host

**Sweeps ran on a state directory that was not private** (2026-10-21, lane 3's finding in its review of host #21; it
predates this lane). The owner-table sweep killed every process group a ledger named once its deadline had passed. The
`status` read and the warden swept the state directory without checking that it was the user's own `0700` directory,
so anyone who could plant a ledger there could have this user's host kill that user's processes. A test that kills a
live sleeper confirmed it. Fixed in two steps:

- window-ml-host #21 (`463eeb0`): `sweep`, `take_ended` and `sweep_file` do nothing unless `private_dir` holds. Test
  `nothing_is_swept_or_taken_from_a_directory_that_is_not_private`.
- window-ml-host #22 (`9b7d012`): the red team's post-merge read found that the warden checked this only when it
  started. Every pass now re-checks, and the warden exits once the directory stops being private. Test
  `a_directory_that_stops_being_private_is_not_swept_on_the_next_pass`.

SHELL.md's Ownership bullet records the rule (#917, #921).

## What was built and written

1. **Host issue #19**, window-ml-host #20 (`4dd4271`). `Direction::Write`'s rustdoc and test name say "changes".
   `write-names` on a path-valued flag or a path-taking find primary applies to that path, at both skip sites, with a
   test per site that failed first. The vector copy is pinned by a hash both repositories compute. Lane 10 agreed the
   input. Its window-ml side, the same pin in `tests/program-manifest.test.mjs`, is #910, still open when this was
   written, so until it merges only the host holds the pin. Lane 10 reviewed.
2. **The `ended` record.** The design is [`LANE_11_ENDED_RECORD_DESIGN.md`](LANE_11_ENDED_RECORD_DESIGN.md) (#913),
   ruled by the coordinator: host only, every ledger entry, `host-lost` included. It was built in window-ml-host #21
   and widened by one cause on the way, `owner-lost` (a `kill`-policy call killed when its port closes, which an MV3
   eviction triggers today). That makes five causes. The record is serialised by a `flock`, kept unique by a
   no-replace link, and consumed once through `status.ended`, which also carries `endedMore` and `endedDropped`. A
   record expires after 7 days and at most 64 are kept, both guesses. PROTOCOL.md and SANDBOX.md were updated in the
   same commit. The host version is 0.6.0. Lane 3 reviewed #21 and #22.
3. **The typed-node policy tree, a design note only**, [`LANE_11_POLICY_TREE_DESIGN.md`](LANE_11_POLICY_TREE_DESIGN.md)
   (#920). The coordinator's rulings are #921, recorded in POLICIES.md. The same PR fixed POLICIES.md and SHELL.md, which
   wrote the default policy as `c.effects.every` (the view has no `every`), tested `c.program` (an object), and listed
   a `run` fact the shell facts lack.

## What was measured

- Host: `cargo test`, clippy with `-D warnings`, and `cargo doc` with `-D warnings`, local and on CI on Linux and
  macOS, green on every merged head. The owner-table tests were mutation-checked: each new guard was removed in turn
  and a test failed. Stdio tests: `an_orphan_killed_at_its_deadline_is_reported_once_to_the_next_session`,
  `a_call_killed_with_its_port_is_reported_to_the_next_session` and `a_sandboxed_call_cannot_touch_the_state_dir`.
- Policy coverage: 36 of the 39 policies over a real consumer fit the grammar by machine, and 49 of all 60 functional
  ones. **No model- or person-written policy exists to measure**: every policy on disk is from tests, docs or
  built-ins, and the bench results on S3 were not searched. The corpus is committed as
  [`tests/fixtures/policy-corpus.json`](../../../tests/fixtures/policy-corpus.json) (docs/dev/policies.md, "The policy
  corpus"). The note's tables list every policy that was rewritten or did not fit.
- Not run: the extension against the new host. Window-ml makes no orphans and has no `status` reader, by the ruling;
  the first PR that asks for an orphan adds the reader.

## After the brief: the lifter and its measurement (2026-10-21)

The item the first version of this Result left as next, ruled in #921, was built and measured. The table's figures
are in [`tests/e2e/panel/policy-proposals.md`](../../../tests/e2e/panel/policy-proposals.md).

| PR | Merged | What |
| --- | --- | --- |
| #930 | `ba268bf7` | The lifter: a syntactic recogniser that turns a dialect source into a tree when it fits, held to the corpus and to the policy realm |
| #934 | `b8030ae8` | The `policy-fetch` and `policy-sh` interviews and their scorer: each need's hand-labelled calls, and lifted, right and broken per answer |
| #953 | `a40f7e29` | The first figure: the lifter covers 33 of 52 `fetch` proposals (63%) and 24 of 53 `sh` (45%), below the predicted 80-95 and 55-75. One fail-open: an ALLOW over a `null` `repoConfigRunsCode` |
| #961 | `c1d1f6ed` | The ruling built: an ALLOW whose evaluation read a `null` fact never fires, in the realm and in the tree's verdict. `propose_policy`'s details; with them `fetch` lifts 41 of 49 (84%), every lifted answer right |
| window-ml-host #23 | `fb436349` | `repoConfigRunsCode` is `true` or `false` on every call: `false` with no repository, `true` when the host cannot tell (an unreadable `.git`, `commondir` or config). `null` is left for a host that computed nothing |
| window-ml-host #24 | `afba286c` | The test #22 lacked: a running warden whose directory stops being private exits 2, leaving the group and the ledger alone. It fails without #22's in-loop check |
| #973 | `e7ab5488` | The scorer's calls outside a repository carry `false`, as #23 answers; `sh` rescored with nothing rerun, 29 of 53 right (27 before), no fail-open |

#973 merged before its assigned review was posted: `merge-when-green --wait` blocks only on posts that exist and are
unread. The janitor was asked to review it after the merge.

Filed, not lane 11's: #968, a page-built run's JSON export carries the page's tool texts where the wire carried ours.

## What is left

- `sh` in `propose_policy`: only if Shane widens it to shell (#921). The `sh` figure above is measured as text.
- Left by #961: the model-written proposals are not yet appended to
  [`tests/fixtures/policy-corpus.json`](../../../tests/fixtures/policy-corpus.json) (neither #934 nor #961 does it), and
  `riskyRegex` is not widened to accept the safe repeated groups opus and sonnet wrote; `propose_policy`'s details steer
  a model to the string methods instead.
- The two-profile residual of the `ended` record stands: profile B's `status` can consume profile A's record. It is
  named in the design note and not fixed.
- The committed figures are in `policy-proposals.md`. The sweep directories behind them (`panel-policy-fetch`,
  `panel-policy-sh`) live on this machine under the main clone's `tests/e2e/artifacts/bench/`, which is gitignored, so
  they are not committed; the bench store holds the durable copy.
