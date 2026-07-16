---
name: use-subagents
description: Split and coordinate bounded work through provided subagent lifecycle tools. Use when fresh context, independent judgment, specialist work, context isolation, or safe parallelism materially outweighs delegation and verification cost. Do not use inside a child, for recursive delegation, tightly coupled work, overlapping writers, or work the parent can complete more safely and cheaply.
compatibility: Requires the five provided subagent tools; lifecycle actions fail closed when they are unavailable.
metadata:
  short-description: Delegate and verify bounded subagent work
---

# Use Subagents

## Non-negotiable boundary

This is a parent-only orchestration skill. Use only the provided lifecycle tools:

- `subagent_start`
- `subagent_status`
- `subagent_send`
- `subagent_interrupt`
- `subagent_stop`

If a required tool or ownership proof is unavailable, fail closed: keep the work in the parent when delegation is optional, or report delegation blocked when it is required. Do not invent a fallback, launch agents through shell/process mechanisms, ask a child to delegate, or transfer control of an unknown run.

Every successful `subagent_start` creates an outstanding result obligation; its start result is never task completion. For that exact ID, call `subagent_status` with terminal/attention states, inspect the returned output, act on blockers, verify material claims, and resolve the run. List mode never counts as result inspection. Inspect every parallel run individually.

Before any write-enabled, parallel, sensitive, broad/expensive assignment, or blocked/failure intervention, read [prompt and safety guidance](references/prompt-and-safety.md). Read its cleanup section again before removing a writer lane.

## Decide deliberately

Delegate only when all are true:

1. The assignment has one bounded role, scope, output, and stopping condition.
2. It materially benefits from fresh context or expertise, independent judgment, context isolation, or meaningful parallelism.
3. That benefit exceeds startup, monitoring, synthesis, parent verification, and cleanup cost.

Keep work in the parent when direct checks are cheaper, context reconstruction dominates, iteration is tightly coupled, scopes overlap, or coordination cost erases the benefit. Complexity alone is not a reason to delegate.

Default to read-only and least privilege. Provide only necessary context; never include credentials, secrets, private transcripts, tokens, `.env` contents, or unrelated sensitive data. Project trust is not a sandbox.

Use a fresh child for a new assignment or independent judgment. Reuse a retained child only for useful same-assignment follow-up. Parallelize only separable work. One writer owns one isolated lane; the parent and other children must not mutate an active writer's checkout even when file lists appear disjoint.

## Orchestrate

1. Define the role, exact task and starting context, requirements and non-goals, permissions and forbidden operations, evidence and validation, concise handoff shape, stopping condition, and bounded timeout.
2. Call `subagent_start`. Record the run ID and returned ownership/worktree facts. Treat `completion.pending: true` as a mandatory next action, never as completion. A blocked or unavailable result is not permission to fall back.
3. Monitor every run with `subagent_status` using that exact `id`, explicit terminal/attention `states`, and a bounded `timeoutMs`; inspect its returned output. Never fire and forget, and never substitute an aggregate list call.
4. On `blocked`, `unknown`, timeout, or failure, inspect with `subagent_status({ id })` before deciding. Use `subagent_send` only for a narrow same-assignment clarification. Ask the human for credentials, approval, ambiguity, privacy, or material-risk decisions; never weaken policy or send approval data.
5. Do not retry blindly. Extend only after observed progress justifies the cost. After two failures with the same cause, change the bounded approach, continue in the parent, or request a human decision.
6. Use `subagent_interrupt` only to cancel the current turn while preserving the reusable child session. An unconfirmed interrupt remains uncertain. Use `subagent_stop` to end the child lifecycle; graceful stop already interrupts first when needed, so a separate interrupt is not an ordinary prerequisite.
7. Require an evidence-bound terminal handoff. Child status, claims, artifacts, exit state, or test output are evidence—not parent verification.
8. Resolve every owned run before finalizing: stop it or deliberately retain it with reason and useful identifiers. Never act destructively on observational, orphaned, uncertain, other-session, or unknown resources.

## Parent verification

The parent owns synthesis and correctness:

- wait until a writer is inactive before touching its lane;
- inspect the complete handoff, diff, changed files, Git state, checks, skips, and risks;
- spot-check material claims and rerun focused plus applicable repository checks;
- reject out-of-scope changes and unnecessary complexity;
- integrate only after review;
- request safe worktree removal only after required handoff capture, parent review, objective integration evidence, cleanliness, and current ownership are proven;
- otherwise retain the lane and report why.

Optional progress is supporting evidence, never a prerequisite for safe removal. Dirty or unintegrated discard requires a separate explicit human-only path; a model must never infer or simulate that authorization.

## Final reporting

Report delegated roles, material handoffs and child-made changes, parent verification and exact validation, unresolved/failed/cancelled/timed-out/running work, and intentionally retained resources with reasons. Include low-level identifiers only when useful for continuation or diagnosis.
