# Runtime Safety and Tool Guidance

Read this before write-enabled, parallel, sensitive, broad/expensive work, blocked or uncertain intervention, or writer cleanup. Re-read Cleanup before requesting `remove_if_safe`.

## Assignment payload

Give `subagent_start` one bounded assignment containing:

- role, exact objective, absolute checkout path, and starting files/questions;
- requirements, non-goals, allowed scope, and forbidden scope creep;
- read-only/write permission, allowed tools/paths, and forbidden operations;
- required sources, diffs, tests, checks, and skipped-check reporting;
- concise handoff shape, completion condition, timeout/budget, and no recursive delegation;
- assumptions, risks, blockers, and unresolved questions.

Send only assignment-relevant context. Never include secrets, credentials, tokens, `.env` contents, private transcripts, approvals, bypass flags, or unrelated sensitive data. Project trust and prompt text are not sandboxes or permission boundaries.

For research/review, require sources or `path:line` evidence, confidence, limitations, and an explicit no-material-findings outcome when applicable. For implementation, require behavior changed, every changed file, exact checks/results, skips/reasons, risks, and remaining work.

## Tool modes and obligations

Use `subagent_status` in exactly one mode:

```text
# List; observation only
subagent_status({})
subagent_status({ scope: "all_owned" })

# Inspect one run and recent output
subagent_status({ id: "<id>", lines: 160 })

# Wait, then inspect that run and output
subagent_status({ id: "<id>", states: ["done", "idle", "blocked"], timeoutMs: 900000, lines: 160 })
```

`scope` is list-only. `timeoutMs` requires `id` plus explicit `states`. A successful start or accepted send creates an exact-ID result obligation. Working/blocked output, list/UI observation, and aggregate status do not complete that obligation; inspect each run's terminal `done`/`idle` output or explicitly stop the run.

For send and interrupt results:

- `confirmed`: expected state/revision evidence appeared;
- `unconfirmed`: the request was acknowledged but expected evidence did not appear;
- `uncertain`: the mutation may have happened before its response was lost.

Inspect `unconfirmed` or `uncertain` runs. Never resend uncertain input, repeat an uncertain interrupt automatically, or destroy a run to resolve ambiguity. After two failures with one cause, change the bounded approach, continue in the parent, or request a human decision.

On a blocker, distinguish missing input, ordinary clarification, trust/approval, absent capability, hang, failure, privacy, and material risk. Use `subagent_send` only for same-assignment clarification; ask the human for credentials, approval, privacy, ambiguity, or material-risk decisions.

## Writer isolation and verification

- One active writer owns one isolated checkout.
- The parent and other children must not edit, format, install into, stash, restore, clean, or otherwise mutate that checkout.
- Prohibit broad formatters, codemods, generators, installs, and unrelated changes unless the assignment requires them.
- The child must not merge, remove its lane, delete branches, or declare integration.
- Parent verification must inspect the delivered result, complete diff and Git state, checks/skips, risks, and scope; rerun relevant validation before integration.

Do not grant write access merely to produce a handoff; parent-captured terminal output is sufficient for read-only work.

## Stop, recovery, and cleanup

Graceful stop may return `stopped: false`; retain and inspect rather than claiming completion. Force stop only closes a freshly identity-verified child and never authorizes worktree or artifact discard. Extension reload/shutdown does not stop children; recovery grants control only when current session, active branch, metadata, terminal/native identity, and fresh topology agree.

Writer cleanup defaults to automatic `remove_if_safe`; omitting `cleanup` is equivalent to `cleanup: "remove_if_safe"`, while explicit `retain` is exceptional. Before accepting successful finalization:

1. Prove the child is stopped and current ownership—or exact cleanup-only adoption—agrees.
2. Confirm a result envelope (exact Pi final or bounded non-Pi transcript), or an exact `failed` notice, is parent-persisted. Cleanup/recovery/blocked/writer-review notices do not qualify.
3. Inspect the complete diff/Git status and rerun relevant checks; integrate manually.
4. Let the extension derive `no_changes`, direct containment, or exact current tree equivalence; provide existing `commit_contained`/`tree_matches` evidence only for another integrated parent ref.
5. Preserve any present explicit custom artifact through verified parent capture.
6. Require clean Git state, exact worktree provenance, no agent/unknown pane, and known idle anchors.

`parentReview` is optional audit text. On success, non-force Herdr removal closes the writer workspace, compare-deletes only the exact generated branch at expected HEAD, and purges transient runtime files. Retain on stale, missing, uncertain, active, dirty, unintegrated, moved-ref, artifact-copy, or identity mismatch. Never delete unrelated/custom/moved evidence. Dirty discard remains explicit human-only behavior unavailable through these tools.
