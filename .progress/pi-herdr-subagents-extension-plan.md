# Pi Herdr Subagents Extension — Planning Memory

## Goal

Create an implementation-ready plan for a greenfield Pi package that orchestrates visible subagents exclusively through Herdr, supports Pi/Claude/Codex harnesses, custom Markdown agent profiles, lifecycle tools, artifacts, and a TUI dashboard.

## Current workspace

- Project directory was empty before planning.
- No Git repository currently exists at this path.
- Local planning context versions: Pi 0.80.6; Herdr 0.7.3/protocol 16; Claude Code 2.1.208; Codex CLI 0.142.5.
- Current Herdr integrations: Pi v4, Claude v7, Codex v6.

## Confirmed product decisions

- Every subagent runs as an interactive Herdr-managed agent pane. There is no hidden/headless fallback and no `herdr: false` profile option.
- Pi is the default harness; Claude or Codex may be selected by profile or explicit user request.
- Expose start, interrupt, stop, list, and inspect/state-output tools. Add send/follow-up and wait because blocked and asynchronous coordination are incomplete without them.
- Ship a parent-only skill that decides when to delegate and uses only the extension tools/Herdr workflow.
- Render a compact status UI and an interactive `/subagents` view that can inspect and focus panes.
- Prevent automatic HTML final-message rendering in Pi children by setting `PI_SUBAGENT_CHILD=1`; the installed renderer already honors this flag. Do not disable all extensions because that would disable Herdr lifecycle integration.
- Support shared and namespaced agent-definition directories. Namespaced definitions win within the same scope; project scope wins over user scope; bundled defaults are lowest precedence.
- Resolve duplicate profiles by frontmatter runtime `name`, not filename alone; report shadowing/duplicates with source paths.
- Ship `scout`, `researcher`, and `worker` Markdown profiles. Do not pin provider models in defaults.
- Researcher declares preferred research tools/skill but does not hard-depend on another extension. Missing external research capability must be visible and must never be misrepresented as completed web research.
- Use `.subagents/` as the canonical runtime/artifact channel. Support `.progress/` when requested. Ensure runtime directories are locally Git-ignored without modifying tracked `.gitignore` automatically.
- Parent materializes handoffs for read-only profiles; write-capable workers may write their own artifacts, with parent fallback/validation.
- Plan for future distribution as a Pi package.

## Authoritative evidence and contracts

### Pi

- Installed docs: `docs/extensions.md`, `docs/tui.md`, `docs/skills.md`, `docs/packages.md` under `@earendil-works/pi-coding-agent` 0.80.6.
- Extensions can register tools/commands, run TUI components, persist custom entries, manage session lifecycle, and expose package resources.
- Extension factories must not start long-lived resources; initialize on `session_start` and tear down on `session_shutdown`.
- Pi package native resources are extensions, skills, prompts, and themes. Agent definitions require extension-owned discovery.
- `getAgentDir()` returns the configured user agent root and `CONFIG_DIR_NAME` avoids hardcoding `.pi`.
- Custom tool output must be bounded (50 KB/2,000 lines convention).
- Custom UI must obey terminal width, use injected themes, request renders after state changes, and be TUI-gated.

### Herdr

- Sources: https://herdr.dev/docs/agents/, https://herdr.dev/docs/socket-api/, https://herdr.dev/docs/cli-reference/, https://herdr.dev/docs/integrations/, https://herdr.dev/docs/session-state/, https://github.com/ogulcancelik/herdr/releases/tag/v0.7.3.
- Raw newline-delimited JSON socket API is intended for protocol clients and subscriptions; CLI wrappers are intended for simple scripting/debugging.
- Bootstrap with `ping` and `session.snapshot`; resnapshot after reconnect.
- Agent states are `working`, `blocked`, `done`, `idle`, and `unknown`; `done` is unseen completion and focus changes it to `idle`.
- Agent/pane APIs cover start/list/get/read/send/focus, send input/keys, close, waits, snapshots, and subscriptions.
- Pane IDs can change across workspace moves; terminal IDs are the stable identity to retain and verify.
- Native integrations add authoritative Pi lifecycle/session identity and Claude/Codex session identity. Claude/Codex state remains screen-detection based.
- `pane.send_input` supports text and key submission in one request.
- Herdr process launch accepts argv arrays and env maps; avoid shell command construction.

### Harnesses

- Pi adapter: `--session-id`, `--session-dir`, `--name`, explicit `--tools`, `--thinking`, private append-system-prompt file.
- Claude adapter: interactive CLI; `--session-id`, `--name`, `--tools`, `--effort`, append-system-prompt file; Escape/Control-C interrupt behavior is documented. `--safe-mode` disables hooks and therefore native Herdr session identity.
- Codex adapter: interactive CLI; `--sandbox read-only|workspace-write`, `--ask-for-approval`, `-c model_reasoning_effort=...`; Escape is the turn-interrupt path. Avoid dangerous bypass flags.

## Existing local inspiration

- `~/.pi/agent/extensions/subagent-dashboard` (symlink) provides snapshot parsing, ownership filtering, widget/overlay UI, status colors, and focus behavior; it is observational and polling-based.
- `~/.pi/agent/extensions/render-last-assistant-message/index.ts` skips auto-rendering when `PI_SUBAGENT_CHILD=1`.
- Installed `pi-subagents` 0.34.0 demonstrates profile discovery, bundled defaults, `PI_SUBAGENT_CHILD`, optional researcher tools, artifacts, model/thinking overrides, and package-specific agent manifests. It will be removed by the user and must not be a runtime dependency.
- Pi's official `examples/extensions/subagent/` demonstrates `~/.pi/agent/agents` and `.pi/agents` conventions, frontmatter parsing, custom tool rendering, and isolated child sessions, but uses hidden subprocesses and is not the target execution model.

## Chosen architecture

- One package with an extension entrypoint, core Herdr protocol client, state/ownership registry, harness adapters, profile discovery/parser, artifact manager, Pi tools, TUI components, bundled skill, and bundled agent profiles.
- Use a raw Herdr request client plus a subscription/reconciliation service. The socket server accepts one normal request per connection; subscriptions keep a connection open.
- Use extension-owned stable run IDs and terminal IDs; update mutable pane/tab/workspace IDs from snapshots/events.
- Maintain a dedicated no-focus subagent tab per parent delegation group/workspace, with explicit owned root/child resource records.
- Serialize topology and registry mutations because Pi may execute sibling tool calls concurrently.
- Persist ownership/lifecycle snapshots in Pi custom session entries and materialize operational metadata/artifacts under `.subagents/`; restore by reconciling session metadata with Herdr snapshots.
- Do not auto-stop children on Pi reload/session switch/quit. Detach UI/subscriptions and allow later recovery/adoption by the owning session.

## Profile discovery precedence

1. Bundled `agents/` defaults.
2. Shared user `${getAgentDir()}/agents/**/*.md`.
3. Namespaced user `${getAgentDir()}/herdr-subagents/agents/**/*.md`.
4. Shared trusted project `<config-root>/agents/**/*.md`.
5. Namespaced trusted project `<config-root>/herdr-subagents/agents/**/*.md`.

Namespaced wins only within its scope; project remains stronger than user. Resolve by parsed frontmatter `name`, emit source-aware diagnostics for shadows and same-priority duplicates, and reject invalid profiles.

## Agent profile contract

Required: `name`, `description`, non-empty Markdown body. Optional: `harness`, `model`, `thinking`, `permissions`, harness-native `tools`, `preferredTools`, `skills`, `preferredSkills`, context inheritance flags, artifacts, timeout, worktree policy, disabled flag. Herdr is implicit and mandatory.

Bundled defaults:

- scout: Pi, low thinking, read-only filesystem tools, parent-written structured handoff.
- researcher: Pi, medium thinking, soft web tool/skill preferences, parent-written sourced research handoff; block/degrade explicitly when no external research capability exists.
- worker: Pi, high thinking, explicit read/shell/edit/write tools, project context, child-write allowed with parent validation, worktree required for concurrent writers.

## Artifact and ignore policy

- Canonical files: prompt, system, progress, handoff, Herdr metadata, and group-tab metadata under `.subagents/`.
- Before first runtime write in a Git checkout, resolve the actual repository root and `git rev-parse --git-path info/exclude`; use anchored `/.subagents/` and `/.progress/` entries when not already ignored.
- Never modify tracked `.gitignore` automatically. If runtime paths contain tracked files, preserve them and warn.
- Serialize/atomically append exclude updates. Recheck per checkout/worktree.
- Validate artifact path containment and symlink traversal.
- Before removing a temporary worktree, copy/capture required handoff/progress artifacts into parent-owned storage and verify them.

## Tool surface

- `subagent_start`
- `subagent_list`
- `subagent_get`
- `subagent_send`
- `subagent_wait`
- `subagent_interrupt`
- `subagent_stop`

Default list/get scope is the current parent Pi session. Global views are explicit and observational. Stop is graceful by default and force-closes only identity-verified owned panes.

## UI

- Compact status/widget only while owned children exist.
- `/subagents` overlay with navigate, inspect output/details, send, interrupt, stop-confirm, refresh, and focus.
- Statuses include extension-local starting/interrupting/stopping/stopped/failed/lost plus Herdr semantic states.
- Use text/icons in addition to semantic colors. Close overlay before focusing another pane.

## Risks and unresolved implementation details

- Greenfield package name is inferred as `pi-subagents-herdr`; it is reversible until publication.
- Cross-harness final-output extraction is not uniform. Treat Herdr recent-unwrapped output as baseline; Pi session parsing can be an adapter enhancement, not a hidden requirement.
- Claude strict safe mode conflicts with the Herdr session hook. Expose an explicit integrated/default policy and document the tradeoff; never claim hermetic read-only guarantees unsupported by the harness.
- Research capability availability in a child may differ from the parent. Validate known tool/profile requirements before start and surface uncertainty.
- Parent session branching/forking must not automatically transfer live-child ownership.
- Existing `pi-subagents` may temporarily register colliding commands/tools during development; use package-specific names until migration/removal is complete or explicitly document collision behavior.

## Planned validation

- Unit tests: schemas, discovery precedence, argv mapping, state reducers, ownership, artifacts/path safety, ignore behavior, truncation, render widths.
- Fake-socket integration tests: request/response, snapshot, subscriptions, reconnect, timeout, malformed data, moved panes, startup/stop races.
- Adapter tests with fake binaries/argv capture.
- Manual Herdr E2E for Pi/Claude/Codex: start, task submission, done/idle, blocked, send, interrupt, stop, focus, reload/recovery, move, and cleanup.
- Package checks: typecheck, tests, `npm pack --dry-run`, package install smoke test.

## Review log

- Independent reviewer: Pi session `pi-herdr-plan-review-20260715-a1`; handoff at `.subagents/pi-herdr-plan-review-20260715-a1.handoff.md`.
- Accepted all ten material findings: child skill/extension isolation, monotonic permission overrides, branch-aware immutable ownership proof, explicit worktree subsystem, complete protocol-16 client/preflight, deterministic profile collisions/settings, non-Git/path-safe artifacts, real packed-artifact gate/license hold, independent protocol fixtures/conformance, and deferral of adoption.
- Incidental validation: the reviewer launch omitted `PI_SUBAGENT_CHILD=1`, causing the installed HTML renderer to open the final response. The implementation/E2E plan must assert this environment on every Pi child.
- Follow-up review found four remaining gaps, all accepted: extension settings must use namespaced files rather than rejecting ordinary Pi settings keys; writer leases need persistent live-Herdr-bound semantics across parent exit; worktree integration/discard/removal needs an executable `subagent_stop` cleanup contract and clarification that normal parent read/diff/Git tools remain allowed; observational overlay rows must disable focus/control unless owned by the current active branch.
- Final follow-up found one medium inconsistency around force stop versus worktree discard. Resolved by retaining LLM-callable `graceful|force` pane stop under strict current-branch identity proof while keeping dirty/unintegrated worktree discard human-only and independent from pane termination.
- Final reviewer confirmation: no material concerns remain after the force-stop/worktree-discard distinction was made consistent.
