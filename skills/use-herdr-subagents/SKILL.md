---
name: use-herdr-subagents
description: >-
  Operates visible, persistent Pi subagents through Herdr for bounded repository
  scouting, external research, or one isolated implementation worker. Use this
  skill when the parent should delegate a bounded task and receive an automatic
  structured result or optionally wait for it. Do not use inside a child, for
  trivial local work, recursive delegation, unbounded orchestration, parallel
  workers, direct subprocess agents, or automatic Git integration.
compatibility: Requires a persisted parent Pi session running inside Herdr with HERDR_SOCKET_PATH and HERDR_WORKSPACE_ID.
---

# Use Herdr Subagents

## Hard boundaries

- This is parent-only. A child receives neither these tools nor this skill; never ask a child to delegate again.
- Give each child one bounded assignment with explicit scope, constraints, expected evidence, checks, and handoff requirements.
- Use normal parent tools for small local work where delegation adds no value. Do not use this workflow as a general job queue, batch system, or replacement for direct browser, SSH, or shell workflows.
- Readers may run concurrently. Only one worker may be active, and it writes only in its isolated Herdr worktree.
- Do not request automatic commits, integration, force cleanup, branch deletion, ownership transfer, or configuration changes.
- The extension automatically owns every run artifact. Never ask a child to create or update that file, and never edit it as an agent.

## Profiles

- `scout`: read-only repository inspection with `read`, `grep`, `find`, and `ls`.
- `researcher`: read-only repository and web research.
- `worker`: bounded implementation with file and shell tools in one isolated worktree.

## Tool contract

```text
subagent_start({ profile, task, wait?: false })
subagent_start({ profile, task, wait: true, timeoutMs?: 1..300000 })
subagent_status({ id? })
subagent_send({ id, message, wait?: false })
subagent_send({ id, message, wait: true, timeoutMs?: 1..300000 })
subagent_stop({ id })
```

Unknown fields are rejected. `wait` defaults to `false`; `timeoutMs` is valid only with `wait:true`.

## Workflow

1. Start the smallest useful task with `subagent_start`. Record the returned run ID and artifact path and, for a worker, its exact worktree path and generated branch.
2. Prefer background mode. The child’s final assistant result is extracted from its persistent Pi session and delivered automatically as one provenanced `<subagent_result>` message that triggers a parent turn. Do not poll for terminal output.
3. Use `wait:true` only when the current parent turn must block for the same result. A successful wait returns the complete result directly without a duplicate message. A timeout leaves background monitoring active.
4. During the result-triggered turn, inspect the evidence. If more work is needed, call `subagent_send` before the parent settles. A follow-up is accepted only after the prior result was delivered or returned and uses the same child session with a fresh cursor.
5. Use `subagent_status({ id })` for diagnostic lifecycle, generation, delivery, artifact, child-session, worktree, and retained-resource facts. Use `subagent_status({})` to list current-parent runs.
6. Call `subagent_stop` when explicit early cleanup or a reported archival/finalization retry is needed. Otherwise, the first eligible post-result parent settlement cleans the run automatically.

## Exact artifact recovery

Each run is archived automatically at `<agentDir>/herdr-subagent-artifacts/<parentSessionId>/<runId>.md`. Parent starts and follow-ups appear as successive generation sections with the full textual child result. The extension writes every section; agents only read it.

After compaction or when prior delegation details are uncertain, list/read the relevant run file before continuing. A parent session with artifacts receives one transient path-only reminder after compaction; the reminder does not replace reading the exact file.

If result archival fails, the run and child session remain retained and the result is not delivered. Use `subagent_stop({ id })` as the sole retry operation; it archives and returns the preserved result without also injecting a background duplicate, then continues safe cleanup.

## Ownership and safety

- Starting requires a persisted parent session. Run IDs belong only to the exact parent session and current extension instance.
- Parent `/tree` navigation is blocked while an owned run is open.
- Early settlement is a no-op while a child works, a generation is pending, or a result is queued. A follow-up submitted during result processing also postpones cleanup.
- Quit, reload, new, resume, and fork abort monitors and perform bounded cleanup. Reload does not preserve live ownership.
- On a later start, only exact residue from a dead prior parent PID is cleanup-eligible. Live-owner, malformed, or identity-mismatched residue is reported and left untouched. Never reuse a prior-instance run ID or treat residue as adopted.

Reader cleanup closes its pane and owned tab, then removes its child session storage only after any result is archived. Worker cleanup closes its pane, removes only a clean worktree with `force:false`, and always retains the generated branch. Dirty or uncheckable worktrees remain untouched and reported with the same `subagent_stop` retry call.

A worker result and start response identify its checkout, branch, parent owner, artifact, and cleanup warning. Preserve reported work, make the checkout clean, then retry through `subagent_stop`; simultaneous retries share one attempt and a later call can retry a retained outcome. Do not use raw Git-only worktree removal, force cleanup, or branch deletion.

If the checkout was already removed externally, `subagent_stop` closes only the exact journal-owned Herdr workspace after `workspace.get` proves the same ID, normalized checkout path, and linked-worktree identity. Any mismatch or untyped lookup failure remains retained. Explicit stop reports the outcome without a duplicate action message; shutdown records it without triggering a turn.
