---
name: use-herdr-subagents
description: >-
  Operates visible, persistent Pi subagents through Herdr using loaded Markdown
  profiles, including one optional worktree-backed run. Use when the parent
  should delegate bounded work and receive an automatic structured result or
  wait for it, and when asked to inspect, stop, or recover dangling Herdr
  subagents, panes, sessions, or worktrees. Do not use inside a child, for
  trivial local work, recursive delegation, unbounded orchestration, parallel
  worktree writers, direct subprocess agents, or automatic Git integration.
compatibility: Requires a persisted parent Pi session running inside Herdr with HERDR_SOCKET_PATH and HERDR_WORKSPACE_ID.
---

# Use Herdr Subagents

## Hard boundaries

- This is parent-only. A child receives neither these tools nor this skill; never ask a child to delegate again.
- Give each child one bounded assignment with explicit scope, constraints, evidence, checks, and handoff requirements.
- Use normal parent tools for small local work. Do not use this workflow as a general queue, batch system, or replacement for browser, SSH, or shell workflows.
- Non-worktree runs may run concurrently. Only one worktree-backed run may be active.
- `use-worktree` controls isolation only. A non-worktree profile with write-capable tools can modify the shared parent checkout.
- Do not request automatic commits, integration, force cleanup, branch deletion, ownership transfer, or configuration changes.
- The extension owns every artifact and recovery locator. Never ask a child to create or update them, and never edit extension-owned locator, artifact, or journal files.
- Never use raw pane, filesystem, or Git cleanup for extension-owned residue. Use the tools below.

## Profiles

Bundled profile names—not runtime roles:

- `scout`: repository inspection; explicit read-only repository-tool allowlist; shared checkout.
- `researcher`: repository and web research; explicit allowlist; shared checkout.
- `worker`: bounded implementation with file/shell tools; isolated worktree.

User profiles are flat regular Markdown files in `${getAgentDir()}/herdr-subagents/agents/`. A matching `name` replaces a bundled profile as a whole; fields and body are not merged. Profiles load once when the active parent extension activates, so reload or restart Pi after changes.

Required frontmatter is `name` (1–64 lowercase kebab-case), non-empty `description` (maximum 256 characters), and boolean `use-worktree`. The non-empty body is the child system prompt. Optional fields are non-empty unique `tools`, non-empty `model`, and `thinking` set to `off|minimal|low|medium|high|xhigh|max`. Unknown keys, wrong types, malformed files, and same-layer duplicate names fail activation with the profile path.

Omitted `model` and `thinking` inherit the parent's current values at each start. Explicit `tools` is a Pi allowlist; omitted `tools` gives the child Pi's normal full defaults, not the parent's active subset. Profile name and tools never determine topology: `use-worktree` alone selects the shared checkout or an isolated worktree and the one-active-worktree limit.

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

1. Start the smallest useful task with `subagent_start`. Record its run ID and artifact path and, for a worktree-backed run, the exact checkout and generated branch.
2. Prefer background mode. The final assistant result is extracted from the persistent child session and delivered automatically as one provenanced `<subagent_result>` message that triggers a parent turn. Do not poll for terminal output: startup readiness is bounded, then one exact-pane status stream is monitored. Status is only a candidate; acceptance uses a 30-second quiet/reconciliation period rather than exact `agent_settled` timing.
3. Use `wait:true` only when this parent turn must block. Success returns the result directly without duplicate injection. A timeout leaves background monitoring active.
4. During a result-triggered turn, inspect the evidence. If needed, call `subagent_send` before the parent settles. A follow-up is accepted only after the prior result was delivered or returned and uses a fresh child-session cursor.
5. Use `subagent_status({ id })` for lifecycle, generation, delivery, artifact, child-session, worktree, and retained-resource facts. Use `subagent_status({})` to list current-owner runs.
6. Use ordinary `subagent_stop({ id })` for early cleanup or an archival/finalization retry. It recovers a raced complete result first. Only when a proven-stopped generation has no final result and transcript loss is intended, use `discardIncompleteResult: true`. Repeated ordinary stops never imply consent. Otherwise, the first eligible post-result parent settlement cleans automatically.

## Dangling and cross-session recovery

When asked to inspect or recover dangling subagents or worktrees:

1. Call `subagent_status({})` for current-owner runs.
2. Call `subagent_recover({})` for global locator-backed and legacy journal-backed residue. Inspect parent-journal, artifact, child-session, workspace, and worktree facts.
3. Use `subagent_stop` only for current-parent/current-instance runs.
4. Use `subagent_recover({ parentSessionId, id })` for prior-owner residue. It performs non-discarding exact cleanup against the original parent journal.
5. Add `discardIncompleteResult: true` only after authorization for irreversible incomplete-transcript loss. A raced complete result is still recovered first.
6. Leave live-owner, dirty, malformed, ambiguous, artifact-only, or identity-mismatched records untouched. Report them; do not guess.

Extension-owned roots:

- Profiles: `${getAgentDir()}/herdr-subagents/agents/`
- Recovery locators: `<agentDir>/herdr-subagent-recovery/<parentSessionId>/<runId>.json`
- Artifacts: `<agentDir>/herdr-subagent-artifacts/<parentSessionId>/<runId>.md`
- Child sessions: `<agentDir>/herdr-subagents/<parentSessionId>/<runId>/`

Never authorize cleanup from a locator, PID, path/branch prefix, artifact body, or Herdr topology alone. The original parent journal is authoritative. Historical recovery and cleanup use persisted worktree/topology facts, never the current profile catalog; removing or overriding a profile cannot reclassify owned resources.

## Exact artifact recovery

The extension automatically archives each run at `<agentDir>/herdr-subagent-artifacts/<parentSessionId>/<runId>.md`. Parent starts and follow-ups appear as successive generations with the full textual child result. Agents may read but never edit this file.

Every complete result names `Durable recovery artifact (read after compaction): <exact path>`. After compaction or compacted-session resume, the next context receives one transient catalog covering valid current and historical parent-session runs plus safe artifact-only files. Distinguish `current` from `latest durable`/historical facts; artifact-only status and completeness are unknown. Read each named available or incomplete artifact before relying on compacted details. The catalog includes no artifact bodies and never authorizes editing.

Clean stream disconnects and transport failures reconnect with bounded backoff. Reconnect exhaustion or protocol/identity failure retains the run without polling fallback. If result archival fails, the run and child session remain retained and no result is delivered. Ordinary stop retries archival and returns a preserved/raced result without background duplication. If no complete result exists, ordinary stop retains the session; explicit discard records an aborted generation in the artifact and parent journal before session removal.

## Ownership and cleanup

- Starting requires a persisted parent session. Run IDs belong only to the exact parent session and current extension instance.
- Parent `/tree` navigation is blocked while an owned run is open.
- Settlement is a no-op while a child works, a generation is pending, or a result is queued. A follow-up during result processing postpones cleanup.
- Esc/abort stops current-owner children and may durably discard unfinished transcripts after raced-result recovery.
- `/new`, `/resume`, and `/fork` require confirmation while non-closed runs exist. Headless modes cancel replacement and require explicit cleanup first.
- Quit and reload use bounded non-discarding shutdown and may leave indexed incomplete residue for later recovery.
- Startup performs bounded non-discarding reconciliation only for exact released/dead-owner locator residue. Expensive legacy scanning is `subagent_recover({})`-only.
- Live-owner, malformed, and identity-mismatched residue is reported and untouched. Never reuse a prior-instance run ID or adopt residue for follow-ups, delivery, status, or stop.

Non-worktree cleanup closes the exact pane and owned tab, then removes child-session storage only after result archival or durable explicit-abort evidence. Worktree-backed cleanup closes the pane, removes only a clean worktree with `force:false`, and always retains the generated branch. Dirty or uncheckable worktrees remain untouched; preserve the work, make it safe if appropriate, then retry ordinary `subagent_stop` or `subagent_recover`.

A worktree-backed start/result identifies the checkout, branch, parent owner, artifact, and cleanup warning. Simultaneous stop calls share the options of the attempt that began; a later explicit discard may retry a retained incomplete generation. Never use raw Git-only worktree removal, force cleanup, or branch deletion. Retained generated branches alone do not require an actionable widget row.

If a checkout was removed externally, cleanup closes only the exact journal-owned Herdr workspace after `workspace.get` proves matching ID, normalized path, and linked-worktree identity. Any mismatch or untyped lookup failure remains retained. Explicit stop reports its outcome without duplicate action injection; shutdown records it without triggering a turn.
