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

## What is left

- **Next: the lifter and a `fetch` bench task** (ruled in #921). The lifter is a syntactic recogniser that turns a
  dialect source into a tree when the source fits. Its test is that the original and the rendering agree on every
  cell representative over the corpus. The bench task asks the panel to propose `fetch` policies and feeds the
  proposals through the lifter, which gives the first coverage figure over model-written policies. It is held until
  Shane has read #921. An `sh` task joins only if he widens `propose_policy` to shell. Nothing else of the tree is
  built before that figure exists.
- Optional facts sent as an explicit `null` ride with the first PR that reads one from a policy (#921). This is not
  lane 11's.
- The two-profile residual of the `ended` record stands: profile B's `status` can consume profile A's record. It is
  named in the design note and not fixed.
