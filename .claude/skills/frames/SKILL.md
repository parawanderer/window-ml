---
name: frames
description: Record what the chat page draws frame by frame during a scripted reload, send or streamed reply, as frames.json (scroll, message count, running animations, watched elements' rect/opacity/transform), a CDP screencast and ONE contact-sheet PNG. Use to verify an animation or a layout shift when you cannot watch video, and to compare two builds with --dist.
---

# frames

```bash
node scripts/frames.mjs --scenario reload --turns 12                     # 12 turns, reload, record the reload (phone)
node scripts/frames.mjs --scenario send   --turns 6 --width desktop      # record sending one more message through its reply
node scripts/frames.mjs --scenario stream --turns 3 --ms 5000 --watch '.msg.asst:last-of-type' --watch '.composer'
node scripts/frames.mjs --scenario reload --turns 12 --dist ../other-clone/dist --out /tmp/frames-before
```

- Needs a build (`npm run build`); `--dist` loads another build the way `E2E_DIST` does. Flags: `--width phone|desktop`
  (390x844 / 1280x800), `--ms` (record length), `--out` (default `test-results/frames/<scenario>-<width>/`), `--watch` (CSS selector, repeatable).
- stdout: one line per frame where the `.msg` count, the scroller's scrollTop/scrollHeight, the running animations or a watched element changed. `t` is ms from the trigger.
- Read `contact.png` (up to 16 evenly spaced screencast frames, each labelled with its t) with the Read tool; `frames.json` has every requestAnimationFrame (with the scroller's clientHeight too); `shots/<t>.png` has every screencast frame.
- Expectations to assert: a reload draws the session ONCE (one jump of `msgs` to its full count, no intermediate counts); a send shows `msgs` +2 and a monotone scrollTop; a stream shows the reply growing in scrollHeight.
- It is a script, not a spec: the e2e suite never runs it. Detail and the traps: `docs/dev/e2e-harness.md`, "The frame recorder".
