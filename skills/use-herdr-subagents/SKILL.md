---
name: use-herdr-subagents
description: Operate visible Pi subagents through Herdr with explicit status polling. Use for bounded read-only scouting, external research, or one isolated worker. Do not use inside a child.
---

# Use Herdr Subagents

This is parent-only. Children set `PI_HERDR_SUBAGENT=1` and receive neither these tools nor this skill.

## Profiles

- `scout`: repository reads only.
- `researcher`: repository reads plus web research.
- `worker`: implementation tools in one isolated Herdr worktree. Only one worker may be active.

## Lifecycle

1. Start one bounded task with `subagent_start({ profile, task })`.
2. Pull status and terminal output with the exact returned ID: `subagent_status({ id })`. Use `wait: true` and a bounded `timeoutMs` when useful.
3. Use `subagent_send`, `subagent_interrupt`, or `subagent_stop` only with current-instance IDs.
4. After a send or interrupt transport error, inspect status before retrying; delivery may already have happened.

Results are never injected automatically. A Pi reload loses all in-memory ownership, so stop every run before reloading. Unknown or historical IDs are intentionally unmanaged.

Stopping a reader closes its owned tab. Stopping a worker removes its worktree only when `git status --porcelain` is clean and always retains the branch. Dirty or uncheckable worktrees remain at the reported path for manual Git/Herdr handling. No integration, recovery, adoption, forced cleanup, or branch deletion is automatic.
