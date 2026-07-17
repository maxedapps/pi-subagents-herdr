---
name: use-herdr-subagents
description: Operate visible subagents through the provided five-tool lifecycle. Use when starting or managing runs with subagent_start, subagent_status, subagent_send, subagent_interrupt, or subagent_stop, including blocked or uncertain runs, isolated writers, parent verification, and cleanup. Do not use inside a child, for recursive delegation, ordinary background processes, or unowned observational runs.
compatibility: Requires the five lifecycle tools provided by the pi-subagents-herdr extension; actions fail closed when ownership or required capabilities are unavailable.
metadata:
  short-description: Operate and resolve Herdr subagent runs
---

# Use Herdr Subagents

Use other applicable subagent skills in conjunction with this skill when they are available and possible. Let them guide broader delegation strategy or decomposition; use this skill for this extension's exact lifecycle, ownership, worktree, and cleanup mechanics. If none are available, apply the compact baseline below.

## Boundary and baseline

This is a parent-only skill. Use only:

- `subagent_start`
- `subagent_status`
- `subagent_send`
- `subagent_interrupt`
- `subagent_stop`

Do not invent shell/process fallbacks, ask a child to delegate, or control unknown resources. If a required tool or ownership proof is unavailable, keep optional work in the parent or report required delegation blocked.

Delegate only one bounded role, scope, output, and stopping condition when fresh context, independent judgment, isolation, or real parallelism materially exceeds coordination and verification cost. Default to read-only. Parallelize only separable work. A writer owns one isolated lane that the parent and other children must not mutate.

Before write-enabled, parallel, sensitive, broad/expensive work, blocked or uncertain intervention, or writer cleanup, read [runtime safety and tool guidance](references/prompt-and-safety.md). Re-read its cleanup section before `remove_if_safe`.

## Choose a profile

Bundled defaults are:

| Profile | Use |
|---|---|
| `scout` | Read-only repository reconnaissance. |
| `researcher` | Source-backed external research; launch blocks when reviewed research tools are unavailable. |
| `worker` | Bounded implementation in an isolated writer worktree. |

Custom profiles may exist. Prefer the selected profile's defaults; omit `harness`, `model`, `thinking`, `cwd`, and `worktree` overrides unless the assignment requires them. Broadening can block or require interactive human confirmation.

## Run the lifecycle

1. Define the exact task, starting path/files, requirements and non-goals, allowed operations, evidence/checks, handoff shape, stopping condition, timeout, and unconditional no-delegation rule.
2. Call `subagent_start`. Record the returned ID and effective profile/worktree facts. Starts return immediately while children run asynchronously; `completion.pending: true` means automatic result delivery is still outstanding, not task completion.
3. Results arrive automatically into the owning parent branch when a generation settles: Pi supplies an exact structured final; Claude, Codex, and Grok supply a bounded Herdr terminal transcript with explicit source/truncation, not an exact-message claim. A writer result may include an extension-derived `ACTION REQUIRED` block; later blocked/failed/cleanup/recovery transitions may inject a deduplicated follow-up. Treat `run.attention` as unresolved. Use exact-ID `subagent_status` for live inspection/recovery—not as a mandatory result-delivery gate.
4. On `blocked`, `unknown`, timeout, or failure, inspect with `subagent_status({ id })` before deciding. Never auto-approve, weaken policy, send secrets, or retry blindly.
5. Use `subagent_send` only for a narrow same-assignment follow-up while the child is `blocked`, `done`, or `idle` and the prior generation is captured or closed. Same-run sends are serialized to one unresolved model generation. Inspect `confirmed`, `unconfirmed`, and `uncertain` delivery; never resend uncertain input automatically.
6. Use `subagent_interrupt` to cancel only the current turn while preserving the session. Use `subagent_stop` to end the lifecycle; graceful stop already interrupts when needed, so interruption is not a normal prerequisite. Check `result.stopped`—outer tool success does not prove the child stopped.
7. Resolve each owned run before finalizing. For a writer, inspect/test/integrate, then call `subagent_stop({ id })`; cleanup defaults to safe removal and the same call retries after stop/reload. If retained, follow the exact action reason and retry, or report the blocker. Explicit `cleanup: "retain"` is exceptional. Never mutate dirty, live, ambiguous, or observational resources. Cleanup-only prior-session adoption never grants process/result authority.

## Verify and report

Parent verification remains mandatory: child output, status, artifacts, exit state, and test claims are evidence, not proof. Wait until a writer is inactive, inspect its delivered result and complete diff/Git state, spot-check claims, rerun relevant checks, reject scope creep, and integrate only verified work. Do not finish while an owned run has unresolved attention unless its exact blocker and retained resources are reported.

Report delegated roles, material handoffs or changes, parent verification and exact checks, unresolved/failed/cancelled/timed-out/running work, and intentionally retained resources with reasons.
