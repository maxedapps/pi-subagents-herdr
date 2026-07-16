# Architecture

## Boundaries

The package is a Pi extension with a Herdr backend. Model-facing orchestration is backend-neutral; operator diagnostics may name Herdr.

Invariants:

1. Children start visibly in dedicated no-focus topology; no hidden/native fallback exists.
2. Stable run nonce, terminal identity, and native session identity are immutable; pane/tab/workspace IDs are mutable projections.
3. Every input, focus, interrupt, stop, and cleanup action resolves fresh topology and current active-branch ownership.
4. Unavailable, stale, split, tampered, orphaned, or uncertain evidence retains resources.
5. Reload/shutdown closes extension sockets, timers, and UI only—never children.
6. Interrupt stops a turn; stop resolves the child lifecycle. Neither implies destructive worktree discard.

## Extension lifecycle

`extensions/herdr-subagents/index.ts` delegates to `src/lifecycle/extension.ts`. Factory registration performs no settings read, filesystem write, socket connection, timer, process start, or UI installation.

`session_start` loads namespaced settings/profiles, validates backend parent identity, recovers active-branch runs/worktrees, and starts subscriptions. `/tree` changes authority in place, so actions reread the active branch. `session_shutdown` is idempotent and non-destructive.

Parent mode contributes `use-herdr-subagents` through Pi's dynamic `resources_discover` event. `PI_HERDR_SUBAGENT=1` returns child mode immediately: no parent tools, commands, dashboard, lifecycle runtime, or package-provided orchestration skill. Pi children receive no trust, skill, or prompt-template override flags and use ordinary independent Pi trust/resource discovery. Saved trust and global settings remain available normally; transient parent `--approve` and session-only trust do not transfer to a separate child process.

## Five-tool surface

Only `subagent_start`, `subagent_status`, `subagent_send`, `subagent_interrupt`, and `subagent_stop` register.

`subagent_status` uses one flat Google-compatible schema. Execution validates mode combinations:

- no `id`: list with optional scope;
- `id` without `states`: detailed inspect/output;
- `id` with `states`: bounded abortable wait followed by detailed inspect/output.

Internal list/get/wait runtime methods remain implementation details; status dispatch uses all three, while the TUI projects only current-session `list` results and performs no per-run output reads. They are not registered tools or aliases. Output is bounded to 50KB/2000 lines and preserves backend semantic `working`, `blocked`, `done`, `idle`, and `unknown` states.

The `/subagents` overlay lists only current-session owned runs and exposes selection, focus, graceful retained stop, refresh, and close. Focus/stop are terminal overlay results, so the overlay is disposed before either mutation. Detailed output, broader observational scopes, send, interrupt, force stop, and safe worktree cleanup remain available only through the explicit model-facing tools. Normal focus validates the returned post-focus `agent_info` identity/state without a second snapshot; a lost response gets one fresh reconciliation snapshot and otherwise reports that focus may have succeeded.

A successful start and each accepted follow-up create a small in-memory per-run result generation. Only model-facing, ID-specific status returning `done`/`idle` output consumes it; list/UI observations do not, blocked remains unresolved, and proven stop clears it. On parent `agent_settled`, the extension may inject one follow-up reminder per uninspected generation and trigger one turn. There is no polling loop, durable acknowledgement state, delivery queue, or child message bus.

## Ownership and recovery

Before topology creation, an active-branch `herdr-subagents.ownership.v1` journal records intent and then monotonically appends returned worktree/group/terminal/native identities. `run.json` stores operational metadata but never grants authority alone.

Recovery requires:

- valid journal chain on the current active branch;
- matching parent Pi session/path;
- contained regular `run.json` with exact run nonce/terminal/native identity and a canonical run-bound private OS-temp layout;
- fresh matching pane/agent topology;
- available matching native child identity.

Full-session entries preserve abandoned evidence but cannot grant control. There is no adoption or ownership-transfer API.

## Launch and harness policy

Adapters validate executable identity, canonical cwd/trusted roots, capabilities, model/thinking mapping, private ephemeral system prompt, and prohibited options before `agent.start`. Launch argv is an array and never contains task text.

1. A private temporary validation directory is created and always removed; no durable preflight run directory exists.
2. Writer worktree/group topology is created when required.
3. Durable artifact paths are prepared.
4. A private live runtime directory is created with `system.md`; Pi also gets `sessions/`, while Claude/Codex do not.
5. The harness starts without task text in argv.
6. Returned identity is journaled and `run.json` is written.
7. Readiness/native identity is proven.
8. Assembled instructions are submitted atomically and a new work cycle is proven.

After any input mutation is attempted, a lost/aborted response is treated as submission/delivery uncertainty and the child is retained. Send/interrupt results use `confirmed`, `unconfirmed` (acknowledged request without bounded state/revision evidence), or `uncertain` (request may have applied before response loss). No automatic retry, message ID, deduplication ledger, or destructive uncertainty cleanup exists. Confirmed interrupt output is reread before graceful exit so stop/handoff uses the newest available pre-exit output.

Pi children independently resolve ordinary project trust and resource discovery; this is not parent trust inheritance. Pi and Claude tool policies are not filesystem sandboxes. Codex uses its documented sandbox. Capability overrides are monotonic unless trusted configuration and interactive human confirmation authorize broadening before resource creation. Recursive orchestration tools are rejected for all children.

## Artifacts

Durable defaults are `run.json` and `handoff.md`. `progress.md` exists only when a profile explicitly configures it and is always optional evidence. Public profiles can customize progress/handoff paths and writer mode, not prompt/system paths.

While live, `run.json` stores the full delegated assignment and last bounded output for exact reload recovery. Wait/done observation only updates metadata; it never materializes a handoff. A proven stop moves the assignment into one final handoff and removes it from final metadata.

Read-only handoffs are parent-materialized with full assignment and bounded final output. For a child writer, the child file is preserved and a deterministic parent-owned sibling (`handoff.parent.md` for the default) wraps the full assignment plus validated child content, or bounded final-output fallback when child content is missing/invalid. That wrapper is registered as the required cleanup artifact before worktree creation, so provenance is never rebound later.

System prompt and Pi session paths are recorded in internal `run.json` only while retained. Their directory must be the exact canonical private OS-temp `mkdtemp` layout derived from immutable run ID, with real non-symlink `system.md` and (Pi only) `sessions/` children and no unexpected root entry. Tampering makes recovery observational. After a proven stop, handoff materialization occurs first, then the layout is revalidated immediately before recursive removal and `run.json` is atomically rewritten with `runtime.ephemeralFiles: "removed"`, no ephemeral paths, and no assignment. Live, blocked, uncertain, or stop-unproven runs retain those files.

For disposable worktrees, the required parent wrapper/handoff and any present optional progress are copied to parent-owned `captured/` storage and byte/hash verified before removal. `captured/` is not created for ordinary history. Parent `run.json` remains outside the disposable worktree. After proven removal, metadata points to retained captures rather than removed source paths.

There is no age/retention policy, garbage collector, cleanup command, or automatic historical deletion. Durable run/handoff evidence, uncertain/live/orphan evidence, and retained-worktree evidence remain.

## Writers and destructive safety

A persistent writer lease binds canonical repository/common-Git-dir + checkout path, run nonce, parent branch proof, terminal/native session, and fresh backend reconciliation. Concurrent writers never share a checkout.

Safe removal requires current ownership, no live/unknown child, unchanged anchor process identities, required handoff capture, parent review, objective integration/no-change evidence, clean exact checkout, and matching Herdr/Git worktree provenance. Progress is not required. Removal never deletes branches. Dirty discard remains a separate interactive-human-only path unavailable to model tools.

## Test layers

- unit/profile/artifact/protocol/harness/runtime/worktree/tool/UI/integration core tests;
- deterministic subprocess fake E2E, explicit via `test:e2e`;
- exact one-pass archive pack/install/isolated Pi RPC load via `pack:inspect`;
- pinned local `skills-ref` validation;
- opt-in model-backed smoke, dry-run by default.

See [`operations.md`](operations.md) for commands and failure handling.
