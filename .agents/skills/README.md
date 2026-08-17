# Repo-local skills

Skills that ship **with kobai** and are shared by every agent harness. This directory is
the canonical location; `.claude/skills` is a symlink to it, and Codex picks skills up
from here too.

Do not confuse these with the personal/plugin skills an individual dev has installed
(`/grill-with-docs`, `/implement`, and friends). Those are configured per-machine. These
are kobai's own — the ones a fresh contributor should get for free on clone.

## Layout

```
.agents/skills/<skill-name>/
├── SKILL.md                 ← the skill itself
├── agents/
│   └── openai.yaml          ← optional: exposes the skill to Codex
├── references/              ← optional: docs the skill points at
└── scripts/                 ← optional: executables the skill invokes
```

`SKILL.md` opens with YAML frontmatter:

```markdown
---
name: skill-name
description: What it does, and — critically — *when* an agent should reach for it. This
  is the only text the agent sees when deciding whether to load the skill, so make it
  concrete about triggering situations, not just capabilities.
---

# Skill Name

...
```

`agents/openai.yaml`, for Codex:

```yaml
interface:
  display_name: "Human Readable Name"
  short_description: "One line."
  default_prompt: "Use $skill-name to ..."
```

## When to add one

When a procedure is specific to kobai, hard to rediscover, and gets repeated — running
the test suite against a seeded store, resetting local infra, verifying a migration.
Ordinary code conventions belong in `AGENTS.md`; a skill is for a *procedure*.

See `/writing-for-agents` for how to write documents agents actually consume.
