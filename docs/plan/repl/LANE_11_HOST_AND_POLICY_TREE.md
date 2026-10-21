# Lane 11: the host's leftovers, then the typed-node policy tree's design (Opus)

Read first: [`ROUND_4.md`](ROUND_4.md); window-ml-host issue #19; [`LANE_4_RESULT_HOST_ROUND3.md`](LANE_4_RESULT_HOST_ROUND3.md)
(what the host is at the end of lane 4, and what it left); `docs/spec/SHELL.md` (the host's security list, the
Ownership bullet and its residuals); `docs/spec/EFFECTS.md`; the host repo's own `AGENTS.md`. For the third item,
`docs/spec/POLICIES.md`, all of it, with "Showing what was approved" twice.

## The three items, in order

1. **Host issue #19, three items**, each small: the `Direction::Write` rustdoc and test name say "changes", the
   spec's word, not "sends"; `write-names` joins the `read`/`write` skip in `apply` in `src/manifest.rs`, AND at the
   find-primary site that has the same skip (ruled 2026-10-21, the same for lane 10's two sites: a term that names
   the path it acts on applies to that path), a test per site failing first; and the vector test hashes the copied
   manifests and call fixtures so a change on either side fails until both move. Agree the hash's exact input with
   lane 10 directly (file list, order, what is hashed) so both sides compute the same number; whichever of you lands
   first, the other matches. One PR, lane 10 reviews (it is the other half of the seam); the red team reads it after
   merge, as it read host #17.
2. **The orphan's deadline-kill `ended` record.** K3b compares the protected names at `done` and at `status` for a live
   orphan; the compare at the deadline KILL of an orphan was left unassigned (plan, K3b paragraph, ruled 2026-10-19)
   because it adds persistence (a record that outlives the call) and a consume-once semantic (the next session's
   `status` returns it once). Design before code, as a short note in this folder (`LANE_11_ENDED_RECORD_DESIGN.md`):
   where the record lives (next to the ledger), what it holds (the compare's result, the call id, the deadline, the
   kill's cause), who consumes it and what consuming means, what happens to one never consumed, and what a hostile or
   crashed host process can do to it. Mail the coordinator the note; continue under the shape you proposed while it
   is read (the rule: state the assumption, do not block). Then build it in the host with the record in `PROTOCOL.md`
   and `SANDBOX.md`, the extension's `status` reader showing it once, and a test that kills an orphan at its deadline
   and reads the record from the NEXT session. Lane 3 reviews the host PR (it reviewed host #13); the red team reads it
   after merge.
3. **The typed-node policy tree: a design note, not code.** `POLICIES.md` says "code first, a tree later, and only as
   an option" (Shane, 2026-10-15) and names what the tree is for: the analysable fragment (boolean combinations of
   equality, prefix and membership atoms over the resolved facts and the effect set, finite domains) made visible, so a
   model-proposed policy's card can lead with a DERIVED breadth, a proof, where a code policy's can only be measured.
   Write `LANE_11_POLICY_TREE_DESIGN.md`: the node grammar (exactly the fragment, nothing a regex needs); how a tree
   renders to a sentence and to the same predicate the judge runs (one source, two renderings, never two sources);
   how breadth is enumerated from a tree (which programs, which effects, which hosts; the domains it enumerates over
   and where they come from); what the card shows for DERIVED versus MEASURED and how it says which; what a person's
   existing code policy does when a tree is proposed beside it; and what is NOT covered (the honest list). Measure
   before claiming: take the policies people and models have actually written in this repo's fixtures and bench runs
   and say what fraction the grammar covers, with the list of what it does not. The note goes to the coordinator and
   Shane; no code until it is ruled on.

## Order and size

Item 1 is a day. Item 2 is the design note on the first day and a few days of host work. Item 3 is a note of a few
pages, written when item 2's PR is in review. Each item is its own PR or note; nothing waits on the coordinator
except item 3's ruling.

## Not this lane

Nothing in `src/python/` or the fork (lane 3's); no change to a manifest's effects (a finding goes to the coordinator);
no code for the policy tree. The host's hub transport is gone and stays gone.

## Who reviews

Lane 10 for item 1; lane 3 for item 2's host PR; the janitor for anything in window-ml's CI; the red team reads host
changes after merge and gates nothing here unless an escape is involved.
