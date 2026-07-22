---
name: use-herdr-subagents
description: >-
  Operates visible, persistent Pi subagents through Herdr for bounded repository
  scouting, external research, or one isolated implementation worker. Use this
  skill when the parent should delegate a bounded task and receive an automatic
  structured result or optionally wait for it, and when asked to inspect, find,
  stop, or recover dangling/orphaned Herdr subagents, panes, sessions, or
  worktrees. Do not use inside a child, for trivial local work, recursive
  delegation, unbounded orchestration, parallel workers, direct subprocess
  agents, or automatic Git integration.
compatibility: Requires a persisted parent Pi session running inside Herdr with HERDR_SOCKET_PATH and HERDR_WORKSPACE_ID.
---

# Use Herdr Subagents

## Hard boundaries

- This is parent-only. A child receives neither these tools nor this skill; never ask a child to delegate again.
- Give each child one bounded assignment with explicit scope, constraints, expected evidence, checks, and handoff requirements.
- Use normal parent tools for small local work where delegation adds no value. Do not use this workflow as a general job queue, batch system, or replacement for direct browser, SSH, or shell workflows.
- Readers may run concurrently. Only one worker may be active, and it writes only in its isolated Herdr worktree.
- Do not request automatic commits, integration, force cleanup, branch deletion, ownership transfer, or configuration changes.
- The extension automatically owns every run artifact and recovery locator. Never ask a child to create or update those files, and never edit extension-owned locator, artifact, or journal files as an agent.
- Never use raw pane/filesystem/Git cleanup for extension-owned residue. Use the tools below.

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
subagent_stop({ id, discardIncompleteResult: true })
subagent_recover({})
subagent_recover({ parentSessionId, id })
subagent_recover({ parentSessionId, id, discardIncompleteResult: true })
```

Unknown fields are rejected. `wait` defaults to `false`; `timeoutMs` is valid only with `wait:true`. `discardIncompleteResult` accepts only literal `true`; it is explicit irreversible consent, not a retry mode.

## Workflow

1. Start the smallest useful task with `subagent_start`. Record the returned run ID and artifact path and, for a worker, its exact worktree path and generated branch.
2. Prefer background mode. The child’s final assistant result is extracted from its persistent Pi session and delivered automatically as one provenanced `<subagent_result>` message that triggers a parent turn. Do not poll for terminal output or completion: startup readiness is bounded, then the runtime keeps one exact-pane status stream. Status changes are candidates, not proof of Pi settlement; acceptance uses a 30-second quiet/reconciliation heuristic rather than exact `agent_settled`.
3. Use `wait:true` only when the current parent turn must block for the same result. A successful wait returns the complete result directly without a duplicate message. A timeout leaves background monitoring active.
4. During the result-triggered turn, inspect the evidence. If more work is needed, call `subagent_send` before the parent settles. A follow-up is accepted only after the prior result was delivered or returned and uses the same child session with a fresh cursor.
5. Use `subagent_status({ id })` for diagnostic lifecycle, generation, delivery, artifact, child-session, worktree, and retained-resource facts. Use `subagent_status({})` to list current-parent runs.
6. Call ordinary `subagent_stop({ id })` for explicit early cleanup or a reported archival/finalization retry. It remains fail-safe and recovers a raced complete result first. Only when a proven-stopped generation has no final result and the transcript may be irreversibly discarded, call `subagent_stop({ id, discardIncompleteResult: true })`. Repeated ordinary stops never imply consent. Otherwise, the first eligible post-result parent settlement cleans the run automatically.

## Dangling / cross-session recovery

When asked to inspect, find, stop, or recover dangling/orphaned subagents or worktrees:

1. Call `subagent_status({})` for current-owner runs.
2. Call `subagent_recover({})` for global locator-backed and legacy journal-backed residue. Inspect returned parent journal, artifact, child-session, workspace, and worktree facts.
3. Use `subagent_stop` only for current-parent/current-instance runs.
4. Use `subagent_recover({ parentSessionId, id })` for prior-owner residue. It retries non-discarding exact cleanup against the original parent journal.
5. Add `discardIncompleteResult: true` only after the user authorizes irreversible incomplete-transcript loss. A raced complete result is still recovered first.
6. Leave live-owner, dirty, malformed, ambiguous, artifact-only, or identity-mismatched records untouched. Report them; do not guess.

Exact extension-owned roots:

- Recovery locators: `<agentDir>/herdr-subagent-recovery/<parentSessionId>/<runId>.json`
- Artifacts: `<agentDir>/herdr-subagent-artifacts/<parentSessionId>/<runId>.md`
- Child sessions: `<agentDir>/herdr-subagents/<parentSessionId>/<runId>/`

Never edit those files directly and never authorize cleanup from a locator, PID, path prefix, branch prefix, artifact body, or Herdr topology alone. The original parent journal remains authoritative.

## Exact artifact recovery

Each run is archived automatically at `<agentDir>/herdr-subagent-artifacts/<parentSessionId>/<runId>.md`. Parent starts and follow-ups appear as successive generation sections with the full textual child result. The extension writes every section; agents only read it.

Every complete result preserves the full child text and names `Durable recovery artifact (read after compaction): <exact path>`. After compaction or compacted-session resume, the next context receives one transient catalog covering valid current and historical parent-session runs plus safe artifact-only files. Distinguish `current` from `latest durable`/historical facts; artifact-only status and completeness are unknown. Read each named available or incomplete artifact before relying on compacted details. The catalog injects no artifact bodies, persists nothing, and never authorizes editing an artifact.

Clean stream disconnects and transport failures reconnect with bounded backoff. Reconnect exhaustion or protocol/identity failure retains the run without a polling fallback; inspect the retained facts and use ordinary `subagent_stop({ id })`. If result archival fails, the run and child session likewise remain retained and the result is not delivered. Ordinary stop is the recovery action: it archives and returns a preserved or raced complete result without a background duplicate, then continues safe cleanup. When no complete result exists, ordinary stop retains the session; the explicit discard form records an aborted generation in the artifact and parent journal before session removal.

## Ownership and safety

- Starting requires a persisted parent session. Run IDs belong only to the exact parent session and current extension instance.
- Parent `/tree` navigation is blocked while an owned run is open.
- Early settlement is a no-op while a child works, a generation is pending, or a result is queued. A follow-up submitted during result processing also postpones cleanup.
- Esc/abort of the parent turn stops current-owner children and may durably discard unfinished child transcripts after recovering any raced final result.
- `/new`, `/resume`, and `/fork` require confirmation while non-closed runs exist; confirmation stops children before replacement. Headless/print/RPC modes cancel replacement and require explicit tool cleanup first.
- Quit and reload have no cancellable confirmation hook. They use non-discarding bounded shutdown and may leave indexed incomplete residue that later needs `subagent_recover(..., discardIncompleteResult: true)`.
- Startup performs bounded non-discarding reconciliation only for exact released/dead-owner locator residue and reports unresolved counts without injecting a model turn. Expensive legacy session scanning is `subagent_recover({})`-only.
- Live-owner, malformed, or identity-mismatched residue is reported and left untouched. Never reuse a prior-instance run ID or treat residue as adopted for follow-ups, delivery, `subagent_status`, or `subagent_stop`.

Reader cleanup closes its pane and owned tab, then removes child-session storage only after a result is archived or explicit abort evidence is durable. Worker cleanup closes its pane, removes only a clean worktree with `force:false`, and always retains the generated branch. Dirty or uncheckable worktrees remain untouched and use ordinary `subagent_stop` / `subagent_recover` after they are made safe. If only an incomplete session remains, the reported action names the explicit irreversible discard call; artifact, journal, and session-removal failures use ordinary retry.

A worker result and start response identify its checkout, branch, parent owner, artifact, and cleanup warning. Preserve reported work, make the checkout clean, then retry through the matching tool; simultaneous calls share the options of the attempt that started, while a later explicit discard can retry a retained incomplete generation. Do not use raw Git-only worktree removal, force cleanup, or branch deletion. Generated branches remain retained after successful closure and do not by themselves require an actionable widget row.

If the checkout was already removed externally, cleanup closes only the exact journal-owned Herdr workspace after `workspace.get` proves the same ID, normalized checkout path, and linked-worktree identity. Any mismatch or untyped lookup failure remains retained. Explicit stop reports the outcome without a duplicate action message; shutdown records it without triggering a turn.
