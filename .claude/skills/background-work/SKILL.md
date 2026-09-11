---
name: background-work
description: Run anything slow (CI, an e2e suite, a bench sweep, a build-and-test loop) without stalling the session — start it in the background, do other work, and let the completion notification come to you. Use whenever a command will take more than about a minute, and especially when you catch yourself about to poll for its result.
---

# Background work: start it, leave it, keep going

Everything in this repo that tells you something useful is slow. The full e2e suite is ~10 minutes,
a CI run ~5, the fast suite ~50s, a bench sweep longer than any of them. A session that waits for
each one in turn spends most of its life doing nothing while the user watches it do nothing.

The harness already solves this: a command started with `run_in_background: true` keeps running
across turns and **re-invokes you when it exits**. You do not have to watch it. You will be told.

```
Bash(command: "npx playwright test tests/e2e/resource-panel.spec.mjs", run_in_background: true)
→ returns immediately with a task id and an output file path
→ a <task-notification> arrives when it exits
```

## The anti-pattern, which is the whole reason this file exists

**Backgrounding a command and then immediately blocking on its output is WORSE than not
backgrounding it**, because it looks from the outside like you did the right thing.

```bash
# ✗ every one of these is a foreground wait wearing a disguise
until [ -s "$OUTPUT_FILE" ]; do sleep 20; done          # blocks the session
until gh pr checks 36 | grep -q pass; do sleep 30; done # blocks the session
sleep 120; cat "$OUTPUT_FILE"                           # blocks, and guesses the duration
```

Committed four times in one session — three e2e runs and a CI watch — each time within a minute of
having correctly backgrounded the thing. The tell is that you are writing a loop whose body is
`sleep`. If you are, stop: the notification you are re-implementing already exists and is more
reliable than your poll interval.

(The Bash tool blocks a bare foreground `sleep` outright for this reason. A `sleep` inside an
`until` loop is the same thing with extra steps, and the same judgement applies.)

## What to do instead

**Start it, then pick up the next piece of work.** There is essentially always one: writing the
handover the run does not depend on, updating a doc, reading a report, fixing an unrelated thing you
noticed. If there genuinely is not, say so to the user rather than burning turns on `sleep`.

```
1. Bash(… , run_in_background: true)          # the slow thing
2. do something else entirely
3. the notification arrives → read the output file → act
```

**Check on it without blocking** whenever you want a mid-flight peek — one read, no loop:

```bash
gh pr checks 36                    # a snapshot, exits immediately
tail -5 "$OUTPUT_FILE"             # what it has printed so far
```

That is fine to do at any point. What is not fine is doing it in a loop until it changes.

**When your very next action genuinely depends on the result** and nothing else could usefully
happen — a mutation-revert check whose whole purpose is the pass/fail — run it in the FOREGROUND
with an honest timeout. Do not background something you are about to block on; that is the
anti-pattern above, and a foreground call at least reports its duration truthfully.

**When you must wait on a condition rather than on a command** — a file a detached process writes, a
deploy settling — use the `Monitor` tool, which is built for an until-loop and does not eat the
session. Not a hand-rolled `sleep` loop in Bash.

## Ordering, when several slow things are queued

Run them **concurrently** when they do not touch the same thing — several background Bash calls in
one message. The one exception in this repo is load-bearing:

**Never rebuild `dist/` while an e2e suite is running.** The suite loads the built bundle, so a
rebuild mid-run silently re-points it at different code and the result means nothing. Finish
editing, build, then start the run — and do not start an edit-and-build while one is in flight.
Four full runs were invalidated this way in one session, each by a mutation-revert check fired
while an unrelated suite was still going.

## CI specifically

See the `ci` skill for the whole loop. The one line that belongs here: `gh pr checks --watch`
**blocks by design**, so it is only ever a background call — and having backgrounded it, read its
output file when the notification arrives rather than polling it.

Its exit code is not trustworthy on its own (a dropped connection and a superseded run both exit 0),
so confirm with a plain `gh pr checks <PR>` snapshot and read that every line says `pass`. That
snapshot is non-blocking, which makes it the right thing to reach for at any point mid-run.
