---
name: disk-space
description: See how much disk is free and which folders this repo's work fills (Playwright output, clones' node_modules and Python venvs, the Pyodide core build, in-tree CPython builds, Gradle, Android system images and emulators, Xcode's DerivedData and simulators), with the command to clear each. Use when the pre-commit hook warns that the disk is low, or when a build, the emulator or a test fails in a way that could be a full disk.
---

# Disk space

```bash
node scripts/check-disk.mjs --report     # free space, and every candidate with its size and how to clear it
WML_DISK_WARN_GB=40 node scripts/check-disk.mjs   # the hook's silent-unless-low form, with another threshold
```

The pre-commit hook runs the silent form on every commit (about 40 ms when space is fine; sizing the folders, which
takes a second or two, happens only when it is low). It warns under 20 GB by default and never fails a commit.

**It deletes nothing, and neither should you without asking.** When it warns, relay the list to the user with the
costs it prints (a re-download, a full rebuild, `npm ci` in a clone) and let them choose. Clearing another clone's
`node_modules` breaks that clone until `npm ci`, and another session may be working in it.

What it looks at: `test-results/`, `playwright-report/`, `coverage/`, `android/app/build/`, `node_modules/`, the
notebooks' `.venv/` and a stray `tmp/pyodide-build/` in this repo and every sibling `../window-ml*` clone; the SHARED
Pyodide core build in `~/git/window-ml/tmp/pyodide-build/` (clearing it turns the next core build back into hours);
the in-tree builds of the sibling `../cpython*` checkouts (their git-ignored files, cleared with `make clean`);
Gradle's, npm's, uv's and pip's caches; Playwright's browsers; the Android SDK's system images and the emulators;
Xcode's DerivedData, simulators and device support; Maestro's run logs. A path that does not exist on the machine is
left out, so Linux never hears about Xcode. Free space comes from `fs.statfsSync` (macOS, Linux, Windows); sizes from
`du`, shown as `?` where there is none.

To add a candidate: one entry in `candidates()` in the script, with what it is, the command that clears it, and the
cost of clearing it when there is one.
