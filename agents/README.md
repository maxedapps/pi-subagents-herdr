# Bundled subagent profiles

- `scout.md` — read-only, low-thinking filesystem reconnaissance with a parent-materialized handoff and no progress file.
- `researcher.md` — read-only, medium-thinking sourced research when reviewed external tools are exposed; parent-materialized handoff and no progress file.
- `worker.md` — mutation-capable, high-thinking implementation in an isolated worktree with required handoff and explicitly configured optional progress.

Defaults omit `model`. Herdr is an operator/backend requirement but is not taught in child prompts. All profiles prohibit recursive delegation. Progress is supporting evidence only and is never required for safe worktree removal.
