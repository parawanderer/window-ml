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

@AGENTS.md
