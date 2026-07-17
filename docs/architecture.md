# Architecture

## Boundaries

The package is a Pi extension with a Herdr backend. Model-facing orchestration is the five backend-neutral `subagent_*` tools; operator diagnostics may name Herdr.

Invariants:

1. Children start visibly in dedicated no-focus topology; no hidden/native fallback exists.
2. Mutation-capable children always use an extension-owned isolated linked worktree; the child cannot choose or bypass this policy.
3. Run nonce, terminal/native identity, repository identity, generated branch, and checkout path are immutable authority inputs.
4. Every input, focus, interrupt, stop, and destructive cleanup step revalidates current authority and mutable topology.
5. Dirty, live, unintegrated, moved-ref, tampered, orphaned, or uncertain evidence retains resources.
6. Interrupt stops a turn; stop resolves the child lifecycle. Neither authorizes dirty discard.

## Extension and result lifecycle

Factory registration has no runtime side effects. `session_start` loads settings/profiles, verifies the owning parent, recovers active-branch state, reconciles stopped cleanup journals, and starts result/action/subscription services. `session_shutdown` closes extension services only; children survive.

Parent mode contributes `use-herdr-subagents` dynamically. `PI_HERDR_SUBAGENT=1` registers only the narrow Pi result bridge—no parent tools, commands, UI, or orchestration skill.

Each generation follows `preparing → submitted → captured | closed | blocked`. Structured Pi final messages become envelopes under `.subagents/runs/<id>/results/` with delivery stages `captured → dispatched → parent_persisted`. They are injected one-at-a-time as `herdr-subagents.result.v1` follow-ups. Missing/malformed bridge evidence closes capture as unavailable; terminal text is never invented as a structured result.

A writer result carries the same-revision extension-derived action block. Later blocked, failed, delivery-uncertain, cleanup-retained, UI, and recovery transitions use `herdr-subagents.action-required.v1`. Stable notice identity, runtime-epoch in-flight state, active-branch scans, and ownership authorization ensure one model-visible message per unchanged action revision. Status and TUI project the same `attention` object.

## Ownership and recovery

`herdr-subagents.ownership.v1` journals append returned worktree/group/terminal/native identities on the active Pi branch. Schema-v5 `run.json` stores operational metadata, action state, the ownership journal, and the exact worktree snapshot; it never grants process authority alone.

Live process control requires current-session active-branch ownership plus fresh matching pane/agent/native topology. `/tree`, fork/new sessions, malformed metadata, and partial identity make live runs observational.

A stopped run has a terminal `stopped` ownership phase. `subagent_stop` can therefore skip process control and retry cleanup after terminal exit or reload. A later parent session may create a terminal `cleanup_adopted` phase only when a schema-v5 parent journal, run nonce, source/child repository identity, generated branch/path, Herdr workspace/anchors, clean checkout, idle shells, and no agent all reconcile. This grants cleanup only: it never adopts/stops a prior process or delivers prior private output. Schema-v3/v4 metadata is parsed for current-branch cleanup migration; if it lacks the exact worktree/ownership snapshot required for cross-session adoption, startup retains it and injects one consolidated recovery notice.

## Launch and worktree policy

Adapters validate executable, canonical cwd/roots, capabilities, model/thinking, and prohibited options before topology creation. Writers always create a linked worktree under the run-bound sibling container and a dedicated group tab inside its Herdr worktree workspace. Read-only profiles share the verified checkout but use a dedicated group tab. The group and writer terminal are journaled before task mutation.

A group is launch-ready only after a fresh snapshot contains its exact workspace, tab, root pane, and root terminal and the root process probe returns the same pane. Creation waits within a short fixed bound; cached groups are freshly revalidated and stale/moved provenance is never replaced implicitly. `agent.start` performs the same exact check before each call and retries only `HerdrApiError.code === "agent_placement_not_found"`, with three total attempts and fixed abort-aware waits. All transport, timeout, malformed, abort, and other API outcomes remain non-retryable because acceptance could be uncertain.

Exhausted explicit placement rejection proves no child identity, not absence of extension-owned topology. The managed run and journal enter failed attention and return a blocked start payload with the exact run ID. A new read-only group uses the existing partial-start idle/identity cleanup proof; reused/ambiguous groups retain. Writer workspace/worktree provenance remains durable and the existing stop/finalization state machine skips process control, waits for parent-persisted failure evidence, derives no-change/integration, and performs normal exact cleanup—there is no provisioning rollback path.

Pi children independently resolve ordinary trust/resources; transient parent approval is not inherited. Recursive orchestration tools are rejected.

## Artifacts

Bundled profiles create no child handoff/progress files. Their self-contained final assistant response is the primary handoff and is persisted in the parent Pi branch. While unresolved, parent operational state is:

```text
.subagents/runs/<id>/
├── run.json
└── results/             # when captures exist
```

Custom profiles may explicitly configure run-unique handoff/progress files. Existing custom files inside a disposable checkout are copied to parent-owned `captured/` storage and byte/SHA-256 verified before removal. Missing optional files do not block; a failed copy of a present file retains. Public profiles still cannot customize internal prompt/system paths.

Private system/session/exchange files are canonical run-bound OS-temp state. They remain while live or capture-uncertain and are removed after proven stop. Assignment/runtime metadata remains until a structured result or explicit failure/action notice is parent-persisted. Successful default finalization removes the runtime run directory; verified custom captures remain intentional.

## Writer finalization state machine

The existing stop tool owns a stop-once/finalize-many flow:

```text
live writer → stop → parent evidence persistence → safe cleanup attempt
stopped writer → skip process control → retry safe cleanup
```

Safe cleanup requires exact ownership, parent-persisted result/failure evidence, clean checkout, and objective integration. The extension derives `no_changes`, direct commit containment, or exact current parent/child tree equivalence; callers may supply existing containment/tree evidence for older equivalent parent refs. Parent review text is optional audit detail, not a deletion gate.

Historical foreground snapshot hashes are not destructive gates. Current exact workspace/tab/terminal topology must contain only recorded anchors, no agent/unknown pane, and each anchor must be a known idle shell. Process information that is missing or active fails closed.

After final revalidation, cleanup journals milestones:

1. non-force Herdr worktree removal (closes its workspace/tabs/panes);
2. compare-delete only the exact manager-generated branch at its expected child HEAD (`git update-ref -d`); caller-supplied/moved refs are preserved;
3. safe runtime artifact purge.

A crash resumes only unfinished milestones. Dirty discard remains separate interactive-human-only behavior unavailable to model tools.

## Test layers

- unit/profile/artifact/result/protocol/harness/runtime/worktree/tool/UI/integration core tests;
- deterministic fake E2E;
- exact pack/install/isolated Pi RPC load via `pack:inspect`;
- pinned skill validation;
- opt-in no-model real Herdr placement conformance using a harmless short-lived `/bin/sh` command with exact pane/tab cleanup and retained-ID reporting;
- opt-in no-model real Herdr worktree conformance proving zero workspace/tab/pane/worktree/generated-branch/runtime-artifact residue;
- opt-in model-backed smoke, dry-run by default.
