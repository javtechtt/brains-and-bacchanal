# Brains & Bacchanal — Start Here

This pack is prepared specifically for **Claude Code**.

## Put these files in the repository

```text
CLAUDE.md
START_HERE.md

docs/
  GAME_RULES_LOCKED.md
  OPEN_RULES.md
  DECISION_LOG.md
  ARCHITECTURE.md
  DEVELOPMENT_ROADMAP.md
  CONTENT_POLICY.md
  PLAYER_HOST_REFERENCE.md
```

Claude Code should automatically read `CLAUDE.md`.

For the first Claude Code session, use:

```text
Read CLAUDE.md and all referenced docs first.

We are starting Brains & Bacchanal cleanly.

Inspect the repository and tell me:
1. what already exists,
2. what is reusable,
3. what conflicts with the current docs,
4. your proposed Phase 1 implementation plan.

Do not implement yet until you have shown me the plan.
Do not invent any missing game rules.
```

After you approve Claude's plan:

```text
Proceed with Phase 1 exactly as approved.
Run the required checks before declaring it complete.
```

This setup intentionally separates:
- locked rules,
- unresolved rules,
- architecture,
- development phases,
- content safety,
- player/Host reference.

That makes it harder for Claude Code to mistake an old or unresolved rule for a final one.
