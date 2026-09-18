# CLAUDE.md

The project's agent instructions live in **[AGENTS.md](AGENTS.md)** (the tool-agnostic
standard). This file just imports them so Claude Code picks them up too.

Setting the project up from scratch — install, build, load into Chrome, and what to check when it does
not work — is **[CONTRIBUTING.md](CONTRIBUTING.md)**, which is written for a human. AGENTS.md is the
detailed version and assumes the setup already happened.

Before adding anything reusable — a module, an exported helper, or a UI primitive (a chip, a pill, a drag
handle, a disclosure, a tooltip, a panel) — search for it by CONCEPT: **`node scripts/index.mjs 'pill|chip'`**.
It indexes every module, module-scope declaration and documented CSS class by the first sentence of its
docstring, and takes a regex. See `.claude/skills/code-index/SKILL.md`; the rule and the reasoning are in
AGENTS.md.

To move functions, types or constants to another file, run **`node scripts/move-symbols.mjs`** (`--dry-run
--diff` first) instead of copying code by hand. It updates every import, including tests' `await import()`,
and refuses on a new type error or import cycle. See `.claude/skills/move-symbols/SKILL.md`.

@AGENTS.md
