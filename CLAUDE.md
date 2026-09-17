# CLAUDE.md

The project's agent instructions live in **[AGENTS.md](AGENTS.md)** (the tool-agnostic
standard). This file just imports them so Claude Code picks them up too.

Setting the project up from scratch — install, build, load into Chrome, and what to check when it does
not work — is **[CONTRIBUTING.md](CONTRIBUTING.md)**, which is written for a human. AGENTS.md is the
detailed version and assumes the setup already happened.

Before adding any UI primitive to the sidebar — a chip, a pill, a drag handle, a disclosure, a tooltip, a
panel — run **`node scripts/components.mjs`** and grep it by concept (`| grep -i pill`). It lists every
existing component, hook and documented CSS class with the first sentence of its docstring. See
`.claude/skills/components/SKILL.md`; the rule and the reasoning are in AGENTS.md.

To move functions, types or constants to another file, run **`node scripts/move-symbols.mjs`** (`--dry-run
--diff` first) instead of copying code by hand. It updates every import, including tests' `await import()`,
and refuses on a new type error or import cycle. See `.claude/skills/move-symbols/SKILL.md`.

@AGENTS.md
