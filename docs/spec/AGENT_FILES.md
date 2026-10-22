# Spec (WIP): reading the agent files a person already keeps

**Status: idea, not started (2026-10-22, Shane).** Nothing here is built. It waits on `ml.sh` having workspace roots
and reads in host mode ([`SHELL.md`](SHELL.md)), because the extension reads no file except through the process host.

## What it is for

People who use coding agents already keep instructions for them in files: `AGENTS.md` in a repository, a Claude
Code setup (`CLAUDE.md`, skills, a memory folder), and others. When a window.ml run works in such a workspace, it
should be able to read those files, so the person does not keep a second copy for window.ml.

It is not a goal to behave like any other tool, or to track what another tool adds. A tool's file convention is
supported because someone has files in it, and only as far as reading them goes. A person who never used Claude Code
never sees anything about it: every convention but `AGENTS.md` is off until turned on.

## The shape every convention shares

Under the file names, the conventions seen so far are the same three things:

1. **Instructions found by where they sit**, read on every run: a file name looked up from the cwd to the workspace
   root (and sometimes a per-user file), with an import syntax that pulls in another file.
2. **An index read up front, with the text fetched on demand**: a folder of documents, each with a one-line
   description that is the index entry (Claude Code's skills and its memory, `MEMORY.md` plus one file per fact).
3. **A store the agent writes to**: Claude Code's memory folder.

So a convention is DATA, not code: a short description saying which file names, which folders, which field is the
index entry, and which import syntax. Adding a convention is adding a description. Two ship:

| Convention | Default | What it names (as of 2026-10-22; checked against the tool's docs when built) |
| --- | --- | --- |
| `agents-md` | on | `AGENTS.md`, nearest one from the cwd up to the root wins, following the agents.md convention |
| `claude-code` | off | `CLAUDE.md` and `CLAUDE.local.md` up from the cwd, `~/.claude/CLAUDE.md`, `@path` imports, `.claude/skills/<name>/SKILL.md` (frontmatter `description`), the project's memory folder |

A plugin system, where a convention is code, is not proposed: one extension point that data describes does not need
one. Revisit it when a second kind of extension needs code.

## Reading goes through the shell

- **Every read is an `ml.sh` read**, judged by the same policies as any other ([`POLICIES.md`](POLICIES.md)): free
  inside a workspace root, never of a secret path, asks otherwise. Nothing here widens what a run may read.
- **A file outside every root is not read** unless the person adds that folder as a root. Claude Code's per-user file
  and its memory folder live under `~/.claude/`, so turning `claude-code` on reads only the workspace's files until
  then; the setting says so.
- **No host, no files.** Without a process host, or in container mode without the workspace mounted, nothing is read
  and the run says so once.

## The context budget

This repository's `AGENTS.md` is about 9k tokens. That is a large share of a local model's window on every run, so
the instructions are not pasted whole:

- **Up to a cap, a file is loaded whole** (the cap is open; [`PROMPT_BUDGET.md`](PROMPT_BUDGET.md) decides it).
- **Past the cap, it is indexed**: each section by its heading and first sentence, fetched on demand by the model, the
  way skills already work. The index is what costs tokens on every run.
- **The run log and both exports carry exactly what the model saw** (the AGENTS.md rule), with the file and commit
  each piece came from.

## Trust

An instruction file is text written by whoever wrote the repository, and window.ml's agent also reads web pages.

- **Instructions never change a policy.** A file can tell the model what to try; whether a call needs the person is
  decided only by the person's policies and the bound.
- **What was loaded is shown with where it came from**: the card for the run names the files, so a person sees that a
  cloned repository's `AGENTS.md` steered it.
- **A file is read as text, never run.** A convention that names a script (a hook) is not followed.

## Not in this spec

- **Writing.** Writing into another tool's memory folder changes that tool's state and lies outside every root; it is
  a separate decision, made once reading has been used.
- **window.ml's own memory format.** If window.ml grows one, it is one more convention described the same way.

## Open

- Whether conventions are switched per workspace root as well as globally (the setting goes in DevTools Settings
  either way).
- The cap, and what the model sees of a file it has not fetched.
- What happens when two conventions name instructions for the same folder: both load, in a fixed order, or the person
  picks.
- Whether a file that changed since the run started is re-read (a run that edits its own `AGENTS.md`).
