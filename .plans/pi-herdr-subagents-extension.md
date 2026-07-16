# Build the Pi Herdr Subagents extension and package

> **Status:** Ready for implementation; package publication blocked until the user selects a license
> **Planning memory:** `.progress/pi-herdr-subagents-extension-plan.md`

## Outcome and approach

Build a production-ready Pi package that defines, launches, observes, controls, and inspects subagents exclusively as interactive Herdr agents. The package will include a Pi extension, a parent-only delegation skill, bundled `scout`, `researcher`, and `worker` profiles, lifecycle/artifact management, Pi/Claude/Codex harness adapters, and a compact plus interactive TUI.

Use Herdr's protocol-16 raw socket API for typed control and subscriptions, while treating Herdr as the live-state authority and the extension registry as the ownership authority. Keep execution visible and fail closed when Herdr is unavailable; never fall back to hidden processes. This is a greenfield package, so establish package/test conventions before feature work and preserve package-relative paths for later npm/git distribution.

## Sources and traceability

| Reference | Required use |
|---|---|
| `.progress/pi-herdr-subagents-extension-plan.md#Confirmed product decisions` | Preserve the complete product contract and agreed exclusions. |
| `.progress/pi-herdr-subagents-extension-plan.md#Profile discovery precedence` | Implement shared/namespaced profile merging and deterministic shadowing. |
| `.progress/pi-herdr-subagents-extension-plan.md#Artifact and ignore policy` | Enforce local Git exclusions, path safety, and worktree handoff retention. |
| [Pi extension docs](https://github.com/earendil-works/pi-mono/blob/main/packages/coding-agent/docs/extensions.md) | Follow extension lifecycle, tools, persistence, modes, and output limits. |
| [Pi TUI docs](https://github.com/earendil-works/pi-mono/blob/main/packages/coding-agent/docs/tui.md) | Implement width-safe, theme-aware widgets and overlays. |
| [Pi package docs](https://github.com/earendil-works/pi-mono/blob/main/packages/coding-agent/docs/packages.md) | Package the extension and skill with correct runtime/peer dependencies. |
| [Herdr socket API](https://herdr.dev/docs/socket-api/) | Implement `ping`, snapshots, requests, subscriptions, input, reads, waits, and reconnect behavior. |
| [Herdr agents](https://herdr.dev/docs/agents/) | Preserve semantic `working`, `blocked`, `done`, `idle`, and `unknown` meanings. |
| [Herdr integrations](https://herdr.dev/docs/integrations/) | Validate Pi/Claude/Codex integration capabilities and native session identity. |
| [Herdr session restore](https://herdr.dev/docs/session-state/) | Reconcile live panes and native agent sessions after parent/server lifecycle events. |
| [Claude CLI reference](https://docs.anthropic.com/en/docs/claude-code/cli-reference) and [interactive controls](https://docs.anthropic.com/en/docs/claude-code/interactive-mode) | Build safe interactive argv and adapter-specific interrupt behavior. |
| [Codex CLI reference](https://developers.openai.com/codex/cli/reference) and [approval/security model](https://developers.openai.com/codex/agent-approvals-security) | Map sandbox, approvals, model effort, and interactive interruption without bypass flags. |
| `~/.pi/agent/extensions/subagent-dashboard` | Reuse proven snapshot projection, ownership filtering, status presentation, focus flow, and testing ideas without depending on that extension. |
| `~/.pi/agent/extensions/render-last-assistant-message/index.ts` — `isSubagentChildProcess` | Set `PI_SUBAGENT_CHILD=1` so Pi child final responses do not auto-open as HTML. |

## Decisions and constraints

| Decision | Why | Status / consequence |
|---|---|---|
| Every child uses Herdr | Visibility, interactive inspection, state, and lifecycle control are core product guarantees. | Confirmed; fail closed without compatible Herdr. |
| Use raw Herdr socket requests plus subscriptions/reconciliation | This is a protocol client, and repeated CLI polling is slower and harder to keep coherent. | Confirmed; CLI remains a doctor/manual-debug aid only. |
| Prefer stable extension run IDs and Herdr terminal IDs | Public pane IDs can change after moves. | Confirmed; re-resolve mutable pane IDs before control/destruction. |
| Pi is the default harness; profiles/user requests may select Claude or Codex | Preserves the requested default while supporting specialist CLIs. | Confirmed; no automatic cross-harness substitution. |
| Discovery precedence is bundled < shared user < namespaced user < shared project < namespaced project | Supports both requested paths while retaining normal project-over-user semantics. | Confirmed; project paths require trust. |
| Resolve profile collisions by frontmatter `name` | Filenames do not guarantee unique runtime identities. | Confirmed; report both winning and shadowed source paths. |
| Default profiles do not pin models | Published model IDs and user authentication vary. | Confirmed; model omission means harness/config default. |
| Research tools/skill are soft preferences | The package must not hard-depend on another extension. | Confirmed; never claim web research when capability is absent. |
| Parent writes read-only-agent handoffs | Granting general write tools solely for an artifact breaks read-only guarantees. | Confirmed; workers may use child-write mode with parent validation. |
| Use local Git exclude, not tracked `.gitignore`, for runtime artifacts | Prevent accidental commits without changing project policy. | Confirmed; warn on already tracked runtime paths. |
| Do not stop children on Pi reload/new/resume/quit | Interactive children may legitimately outlive one parent runtime instance. | Confirmed; restore/reconcile ownership on resume. |
| Initially use package-specific public command/tool names if collisions exist | The currently installed `pi-subagents` package may coexist during development. | Inferred-reversible; generic aliases can be enabled after migration. |
| Runtime overrides are monotonic by default | An LLM tool call must not broaden profile permissions/tools, escape trusted roots, or weaken worktree isolation. | Confirmed; broader overrides require trusted configuration plus explicit human confirmation. |
| Active-branch session entries plus live identity form ownership proof | Writable `.subagents` metadata alone is tamperable and session IDs survive `/tree` navigation. | Confirmed; uncertain ownership means retain and report, never destroy. |
| Orphan/global agents remain observational | Safe adoption requires a separate transfer-of-ownership protocol not yet requested. | Confirmed deferment; no adoption action in this plan. |
| Inferred package name: `pi-subagents-herdr` | Matches the workspace and intent without blocking implementation. | Inferred-reversible until publication. |
| License remains undecided | Legal terms cannot be inferred safely. | Approval required before removing `private: true`, creating final `LICENSE`, or publishing. |

## Phase 1 — Establish package, contracts, configuration, and test harness

**Files and references**

- Create `package.json`: private package metadata, Pi manifest, scripts, peer/runtime/dev dependencies, and published files.
- Create `.gitignore`: source-development ignores such as `node_modules/`, coverage, build output, packed tarballs, and runtime test artifacts; this is separate from runtime checkout exclusion behavior.
- Create `tsconfig.json`: strict TypeScript settings compatible with Pi's TypeScript extension loading.
- Create `extensions/herdr-subagents/index.ts`: minimal extension factory and lifecycle wiring placeholder.
- Create `src/contracts/*.ts`: shared result, state, ownership, profile, artifact, harness, and protocol-facing types.
- Create `src/config/settings.ts`: trusted user/project settings loading and validation.
- Create `tests/support/fake-herdr-server.ts` and `tests/support/fake-cli.ts`: reusable protocol and argv test fixtures.
- Create `README.md`: initial requirements, development commands, compatibility floor, and non-goals.

**Implementation**

1. Declare Pi package resources for `extensions/herdr-subagents/index.ts` and `skills/herdr-subagents/SKILL.md`; keep `agents/` in the published files even though Pi does not natively discover it. Set `private: true` until the user selects a license and publication metadata is approved.
2. Put Pi core packages and `typebox` in peer dependencies per Pi package guidance; use only necessary runtime dependencies and place TypeScript/test tooling in dev dependencies.
3. Add exact scripts for `typecheck`, unit/integration tests, the aggregate test gate, and real package creation/inspection; use a Node-version-compatible TS runner rather than depending on Node 26 type stripping.
4. Define a discriminated runtime state model that separates extension lifecycle states from Herdr semantic states and records immutable run/terminal identity separately from mutable topology IDs.
5. Define extension-owned settings locations (`${getAgentDir()}/herdr-subagents/settings.json` and trusted `<project-config-root>/herdr-subagents/settings.json`) with explicit user→project precedence, whole-object/field merge rules, concurrency, default harness, profile directories, artifact retention, widget visibility, integration strictness, allowed roots, and temporary compatibility aliases. Reject unknown/unsafe keys only inside these namespaced files; never reject unrelated keys from Pi's own `settings.json`.
6. Define a per-harness capability matrix and monotonic override resolver. Explicit tool calls may narrow model/thinking/cwd/tools/permissions but may not broaden mutation/network capability, leave configured/trusted roots, or weaken required worktree isolation without a trusted setting and interactive human confirmation.
7. Keep the extension factory side-effect free; start sockets/timers only from `session_start` or explicit tools/commands and make shutdown idempotent. When `PI_HERDR_SUBAGENT=1`, return a child-safe registration that omits parent orchestration tools, commands, dashboard, and parent skill injection while leaving Herdr's separate integration untouched.
8. Document Node/Pi/Herdr compatibility, exclusive-Herdr execution, optional research capabilities, Pi/Claude tool-policy versus filesystem-sandbox limitations, and the absence of a runtime dependency on the old `pi-subagents` package.

**Contract or shape**

```ts
export type Harness = "pi" | "claude" | "codex";
export type HerdrStatus = "working" | "blocked" | "done" | "idle" | "unknown";
export type RunLifecycle =
  | "starting" | "running" | "interrupting" | "stopping"
  | "stopped" | "failed" | "lost";

export interface OwnershipProof {
  runNonce: string;
  parentSession: { id?: string; path?: string; branchEntryId: string };
  createdFrom: { workspaceId: string; tabId: string; paneId: string; terminalId: string };
  child: { terminalId?: string; nativeSession?: { kind: "id" | "path"; value: string; source: string } };
  tab?: { workspaceId: string; tabId: string; rootPaneId: string; rootTerminalId: string; rootProcessBaseline: string };
  worktree?: { repositoryId: string; workspaceId: string; checkoutPath: string; branch: string; base: string };
}

export interface SubagentRecord {
  schemaVersion: 1;
  id: string;
  ownership: OwnershipProof;
  profileName: string;
  harness: Harness;
  lifecycle: RunLifecycle;
  herdrStatus: HerdrStatus;
  terminalId?: string;              // stable identity after launch
  paneId?: string;                  // mutable after pane moves
  tabId?: string;
  workspaceId?: string;
  createdAt: number;
  updatedAt: number;
}
```

**Pitfalls and safeguards**

- Do not start a watcher or socket in the extension factory; Pi may load factories in invocations that never start a session.
- Do not bind the runtime to local absolute package paths; resolve bundled assets relative to the loaded module/package.
- Keep settings separate from live registry state so `/reload` cannot reinterpret stale runtime records as user configuration.

**Checks**

- `npm install` — expect a reproducible lockfile and no missing runtime peer imports during tests.
- `npm run typecheck` — expect strict compilation with no broad `any` escape around protocol/state contracts.
- `npm test -- --test-name-pattern="contracts|settings"` (or the equivalent focused script established in `package.json`) — expect valid config/state fixtures accepted and malformed/security-relevant fixtures rejected.
- `npm pack --json` — expect a real tarball path; inspect that exact archive and confirm extension, skill, bundled agents, README, and required source files are present while tests, progress, plans, and runtime artifacts are excluded unless deliberately published.

**Review checkpoint**

- Review the dependency split, package-relative asset resolution, state invariants, and lifecycle startup boundaries against Pi package/extension docs.
- Evidence: package manifest, dry-run tarball listing, strict typecheck, and focused contract tests.
- Exit when a clean install can load the minimal extension without creating processes, sockets, repository files, or UI leaks.

## Phase 2 — Implement profile discovery, bundled agents, and artifact safety

**Files and references**

- Create `src/profiles/schema.ts`, `parser.ts`, `discovery.ts`, and `diagnostics.ts`: YAML parsing, validation, recursive discovery, precedence, and capability projection.
- Create `agents/scout.md`, `agents/researcher.md`, and `agents/worker.md`: bundled defaults.
- Create `src/artifacts/paths.ts`, `git-ignore.ts`, `store.ts`, and `handoff.ts`: canonical paths, local ignores, safe writes, and handoff capture.
- Create `tests/profiles/*.test.ts` and `tests/artifacts/*.test.ts`.

**Implementation**

1. Discover bundled defaults and recursive Markdown files from both requested user/project roots using `getAgentDir()` and `CONFIG_DIR_NAME`; load project profiles only after `ctx.isProjectTrusted()`.
2. Merge in this exact order: bundled, shared user, namespaced user, shared project, namespaced project. Define profile names as case-sensitive lowercase kebab-case identifiers and apply whole-profile replacement, not field merging, when a stronger source shadows a weaker runtime name. Reject same-priority duplicate runtime names as an error listing every source path; do not pick a filesystem-order winner. A stronger disabled profile intentionally shadows/hides weaker definitions.
3. Validate required `name`, `description`, and non-empty body plus optional harness, model, thinking, permissions, tools, soft preferred tools/skills, context flags, timeout, worktree, disabled, and artifact settings. Herdr is implicit; reject a `herdr: false` or unsupported runtime field with a migration-oriented error.
4. Keep bundled models unset. Define scout as read-only/low-thinking filesystem recon, researcher as medium-thinking with soft `web_search`/`fetch_content`/`get_search_content` and `web-research` preferences, and worker as high-thinking with explicit implementation tools and writer/worktree rules.
5. Resolve soft capabilities by intersecting profile preferences with capabilities the child launch will actually expose, not merely parent tools. Return warnings for missing preferences; if a research assignment has no external research tool, mark it blocked/unavailable and prohibit memory-only output from being labelled researched.
6. Create canonical `.subagents/` run/group metadata, prompt, system, progress, and handoff paths. Allowed roots are the selected checkout's `.subagents/` and an explicitly profile-requested `.progress/` beneath that checkout. Expand only a documented placeholder set and reject absolute/out-of-root paths unless a trusted setting explicitly allows an additional root.
7. Implement component-by-component safe directory creation and write-time containment/realpath checks, using exclusive/atomic file creation or replacement as appropriate. Treat symlink state as mutable and revalidate immediately before rename/write; never rely only on an earlier lexical check.
8. If the checkout is Git-backed, inspect the real Git root and `git check-ignore`; append anchored `/.subagents/` and only extension-owned/requested `/.progress/` rules to `git rev-parse --git-path info/exclude` under a cross-process lock plus atomic append. Never hide a pre-existing untracked `.progress/` tree wholesale without explicit confirmation, never rewrite tracked `.gitignore`, and warn if runtime paths are already tracked. In a non-Git directory, create artifacts normally, report that Git-ignore protection is not applicable, and do not treat `git rev-parse` failure as launch failure.
9. Define retention so live, orphaned, uncertain-ownership, and unconsumed handoff evidence is never automatically deleted. Default `artifact.writer` to `parent` for read-only profiles. Allow `child` only when the effective profile is mutation-capable; parent must still validate existence/containment and capture a fallback handoff from final output.
10. Record absolute artifact paths in registry metadata. Before worktree removal, copy required outputs into parent-owned storage and verify byte size/hash or content presence.

**Contract or shape**

```yaml
---
name: researcher
description: Produce a focused, source-backed research brief
harness: pi
thinking: medium
permissions: read-only
preferredTools: [web_search, fetch_content, get_search_content]
preferredSkills: [web-research]
artifacts:
  handoff: .subagents/{id}.handoff.md
  progress: .subagents/{id}.progress.md
  writer: parent
---

Use available external research tools and the web-research skill when present.
If external research is unavailable, report that limitation and do not answer from memory as if sources were checked.
```

**Pitfalls and safeguards**

- A namespaced user profile must not override a shared project profile; namespaced precedence applies within a scope, then project beats user.
- Do not use directory iteration order to resolve equal-priority runtime names; hard-error the ambiguity.
- Do not grant `write` to scout/researcher solely for handoff creation.
- `git/info/exclude` paths differ in linked worktrees; always ask Git for the path and coordinate concurrent Pi processes, not only in-process tool calls.
- Do not ignore or delete pre-existing `.progress/` content merely because one profile requests a progress artifact.
- Do not delete worktree artifacts before the parent-owned handoff copy is verified.

**Checks**

- `npm test -- --test-name-pattern="profile|discovery|artifact|ignore"` — expect recursive discovery, whole-profile replacement, exact precedence, same-priority hard errors, disabled shadowing, malformed YAML rejection, placeholder/path traversal rejection, write-time symlink defense, cross-process-safe ignore behavior, and non-Git success-with-diagnostic behavior.
- Run fixture nested-Git/linked-worktree tests — expect anchored local excludes, unchanged tracked `.gitignore`, no silent hiding of pre-existing `.progress/`, warnings for tracked runtime files, and retained handoffs after simulated worktree cleanup.
- Inspect bundled profiles — expect no pinned model, no `herdr` opt-out, explicit output contracts, no recursive delegation, and researcher soft rather than hard extension dependencies.

**Review checkpoint**

- Review trust boundaries, precedence, soft-capability semantics, artifact writer rules, and Git path handling.
- Evidence: table-driven discovery tests, malicious-path fixtures, temporary Git/worktree tests, and bundled profile snapshots.
- Exit when a profile's effective source/config is deterministic and no runtime artifact can escape its allowed root or be accidentally presented as Git-safe without evidence.

## Phase 3 — Build the Herdr protocol client, live cache, ownership, and recovery

**Files and references**

- Create `src/herdr/transport.ts`, `protocol.ts`, `client.ts`, `subscriptions.ts`, and `reconcile.ts`.
- Create `src/runtime/registry.ts`, `ownership.ts`, `groups.ts`, and `recovery.ts`.
- Create `tests/herdr/*.test.ts` and `tests/runtime/*.test.ts` using `tests/support/fake-herdr-server.ts`.

**Implementation**

1. Generate/curate protocol-16 golden fixtures from `herdr api schema --json` and recorded authoritative responses for every used method/event. Encode exact request/result/error envelopes, snake-case enum values (`recent_unwrapped` on the wire), optional fields, revision semantics, and known `not_found`, timeout, invalid-params, unavailable, and compatibility errors in `protocol.ts`; fail tests when local fixtures and implemented decoders drift.
2. Implement newline-delimited JSON request transport over `HERDR_SOCKET_PATH` with unique request IDs, bounded connection/response timeouts, abort support, typed top-level success/error handling, and one connection per normal request.
3. Handshake with `ping`; require a compatible server/client protocol (initially protocol 16/Herdr 0.7.3+), report exact incompatibility, and accept unknown response fields.
4. Preflight the owning parent using `pane.current` with the caller's `HERDR_PANE_ID`, then reconcile that pane, terminal, workspace, tab, agent kind, and native Pi session against `session.snapshot`. Require `HERDR_ENV=1`, socket path, and matching environment IDs; never choose placement from another client's focused/sidebar state. If identity cannot be proven, block orchestration rather than create resources.
5. Bootstrap the local cache with `session.snapshot`. Track workspaces, tabs, panes, agents, layouts, focus, revisions, and native session references without inferring missing fields.
6. Implement typed operations required downstream: `workspace.get/list`, `tab.create/get/list/close`, `pane.current/get/list/layout/process_info/send_input/send_keys/close`, `agent.start/get/list/read/focus`, `events.subscribe`, `events.wait`, and worktree operations added in Phase 4. Treat CLI-only conveniences as outside the raw client unless explicitly wrapped.
7. Maintain concrete protocol-16 subscriptions for topology lifecycle (`pane.created`, `pane.closed`, `pane.moved`, `pane.exited`, tab/workspace closure where relevant) and one `pane.agent_status_changed` subscription per owned pane. Rebuild the subscription set when ownership changes, and add low-frequency snapshot reconciliation to recover missed events/stale connections.
8. Reconnect with bounded backoff, resnapshot before declaring connected, and expose `connecting`, `connected`, and `unavailable` health states without losing last-known ownership metadata.
9. Build a registry keyed by extension run ID/run nonce and terminal ID. Update pane/tab/workspace IDs when snapshots/events show moves; never transfer ownership based only on profile name, cwd, sidebar order, or writable `.subagents` metadata.
10. Before topology creation, append a write-ahead active-branch Pi custom entry containing parent branch entry, run nonce, requested group, and intended resources. After each successful create/start, append the returned terminal/tab/root/worktree identity. Treat `.subagents` metadata as operational evidence only and reconcile it against active-branch entries plus live Herdr identities.
11. Handle `session_before_tree`/`session_tree`, fork/new/resume/reload, and quit explicitly. Rebuild ownership from the active Pi branch; children created on an abandoned `/tree` branch become observational/orphaned for the new branch, not owned merely because the Pi session ID is unchanged. Do not implicitly transfer ownership to forked/new sessions.
12. Create one dedicated no-focus subagent tab per active parent delegation group/workspace, reserve its root pane as an anchor, and serialize group/tab/pane mutations. Store the root terminal/process baseline and verify it before later tab closure.
13. On partial start/retry failure, record every returned resource before cleanup; close only identities proven by the write-ahead record and live reconciliation. If proof is incomplete, retain and surface the resource. On parent lifecycle shutdown, stop extension sockets/timers/UI but do not terminate children.

**Contract or shape**

```ts
interface HerdrRequestClient {
  ping(signal?: AbortSignal): Promise<{ version: string; protocol: number }>;
  snapshot(signal?: AbortSignal): Promise<SessionSnapshot>;
  currentPane(callerPaneId: string, signal?: AbortSignal): Promise<PaneInfo>;
  createTab(input: TabCreateInput, signal?: AbortSignal): Promise<{ tab: TabInfo; rootPane: PaneInfo }>;
  getTab(tabId: string, signal?: AbortSignal): Promise<TabInfo>;
  getPane(paneId: string, signal?: AbortSignal): Promise<PaneInfo>;
  getPaneLayout(paneId: string, signal?: AbortSignal): Promise<PaneLayout>;
  getPaneProcessInfo(paneId: string, signal?: AbortSignal): Promise<PaneProcessInfo>;
  startAgent(input: AgentStartInput, signal?: AbortSignal): Promise<HerdrAgent>;
  getAgent(target: string, signal?: AbortSignal): Promise<HerdrAgent>;
  readAgent(target: string, input: ReadInput, signal?: AbortSignal): Promise<ReadResult>;
  sendInput(paneId: string, text: string, keys: string[], signal?: AbortSignal): Promise<void>;
  sendKeys(paneId: string, keys: string[], signal?: AbortSignal): Promise<void>;
  waitForEvent(input: EventMatch, signal?: AbortSignal): Promise<HerdrEvent>;
  subscribe(input: Subscription[]): AsyncIterable<HerdrSubscriptionEvent>;
  focusAgent(target: string, signal?: AbortSignal): Promise<void>;
  closePane(paneId: string, signal?: AbortSignal): Promise<void>;
  closeTab(tabId: string, signal?: AbortSignal): Promise<void>;
  // Typed worktree methods are added in Phase 4.
}
```

**Pitfalls and safeguards**

- The raw API reads one initial request per normal connection; do not build an unsupported multiplexed request channel.
- A fake server derived only from client assumptions can validate an invented protocol; golden fixtures and no-model real-Herdr conformance are required before adapter work.
- `done` is unseen completion, while `idle` is seen/waiting; focusing can change `done` to `idle` without new work.
- A pane move can change public pane ID. Destructive operations must resolve and verify terminal/native-session/run-nonce identity immediately before execution.
- Session ID is not branch ownership: `/tree` keeps one session while changing the active branch.
- Snapshot polling alone is insufficient for responsive UI, while subscriptions alone need reconnect/reconciliation coverage.

**Checks**

- `npm test -- --test-name-pattern="protocol|herdr|registry|ownership|reconnect|tree"` — expect golden protocol-16 envelopes to decode, handshake/parent-preflight failures to fail closed, snapshots to bootstrap correctly, events to update cache, reconnect to resnapshot, moved panes to retain terminal ownership, active-branch ownership to change correctly across `/tree`, tampered metadata to be rejected, and stale IDs never to close another pane.
- Fake malformed/truncated socket responses, partial-start/retry, timeout/disconnect, and stale/tampered metadata cases — expect typed unavailable/error states, retained uncertain resources, bounded completion, and no unhandled socket/timer leaks.
- Run a no-model real-Herdr conformance script that creates a no-focus disposable tab/pane, exercises snapshot/get/layout/process/send/close plus subscription events, and identity-verifies cleanup — expect recorded responses to match golden decoders without invoking an LLM.
- Inspect `session_shutdown` and `session_tree` tests — expect resources disposed idempotently while live child records remain recoverable only on the owning active branch.

**Review checkpoint**

- Review protocol compatibility, reconnect ordering, attention-aware states, ownership proof, and destructive-operation verification.
- Evidence: fake-socket transcripts, reducer tests, timer/socket leak assertions, and moved-pane identity fixtures.
- Exit when every cache transition is either backed by a Herdr response/event or explicitly marked last-known/unknown, never guessed.

## Phase 4 — Implement writer scheduling and Herdr worktree isolation

**Files and references**

- Create `src/worktrees/contracts.ts`, `manager.ts`, `writer-locks.ts`, `artifacts.ts`, and `cleanup.ts`.
- Extend `src/herdr/client.ts` and `protocol.ts` with protocol-16 `worktree.list/create/open/remove` contracts and golden fixtures.
- Extend `src/runtime/registry.ts` and `ownership.ts` with repository/checkout/worktree ownership state.
- Create `tests/worktrees/*.test.ts` and no-model real-Herdr worktree conformance coverage.

**Implementation**

1. Identify a checkout by canonical repository/common-Git-dir identity plus canonical checkout path. Use in-process/cross-process locks only to serialize lease transactions; store a persistent writer lease bound to checkout identity, run nonce, child terminal/native session, parent branch proof, and last reconciled live Herdr state.
2. Permit parallel read-only children in one checkout. Permit at most one live mutation-capable child per checkout; when another writer must run concurrently, require an isolated Herdr worktree workspace rather than trusting non-overlapping file promises. On parent reload/crash, preserve the lease while the bound child remains live. Reclaim a stale lease only after compatible Herdr is available and proves the bound child/session is gone; unavailable or uncertain Herdr fails closed and retains the lease.
3. Implement typed worktree creation with explicit source workspace/cwd, branch, base, optional path/label, and `focus: false`. Generate collision-resistant branch/path defaults but persist every resolved value returned by Herdr/Git.
4. Create the delegation group's dedicated no-focus tab in the returned worktree workspace before starting the writer. Persist repository ID, base, branch, checkout path, workspace, tab/root, child terminal, and artifact paths in the write-ahead ownership record.
5. Track worktree lifecycle as `created`, `active`, `dirty`, `integration_pending`, `integrated`, `retained`, or `removed`; never collapse this to a boolean. The extension does not merge or declare integration automatically.
6. Define executable cleanup through `subagent_stop` options: `cleanup: "retain" | "remove_if_safe"` (default `retain` for writer worktrees), optional objective integration evidence (for example parent commit contains/applies the reviewed child change), and a separate interactive human-only discard confirmation path. Before `remove_if_safe`, require no live child, captured/verified parent-owned handoff/progress, reviewed/integrated state, clean checkout, and Git/Herdr confirmation. Never let an LLM-only assertion authorize discard.
7. Use `worktree.remove` only on an identity-matched extension-owned workspace. Record whether Herdr/Git refused removal and retain the workspace/branch/path with an actionable reason; never delete branches as part of worktree removal. An explicitly confirmed discard may enable Herdr's force path only after displaying dirty/unintegrated consequences and recording the human decision.
8. Expose worktree state through list/get/doctor/UI. The parent skill must use extension tools for subagent/Herdr lifecycle, but may and should use normal parent read/diff/Git tools to inspect, validate, and integrate child changes before requesting `remove_if_safe`; it must never use Bash to bypass extension ownership/cleanup controls.

**Contract or shape**

```ts
interface WorktreeRecord {
  repositoryId: string;
  sourceWorkspaceId: string;
  workspaceId: string;
  checkoutPath: string;
  branch: string;
  base: string;
  state: "created" | "active" | "dirty" | "integration_pending" | "integrated" | "retained" | "removed";
  tab?: { tabId: string; rootPaneId: string; rootTerminalId: string };
  writerRunId?: string;
  artifactsCaptured: boolean;
  retentionReason?: string;
}
```

**Pitfalls and safeguards**

- Herdr worktrees isolate checkouts; they do not merge, resolve conflicts, validate changes, or prove integration.
- File non-overlap does not make concurrent writers in one checkout safe because tools can modify lockfiles, generated files, Git state, or broad config.
- Do not remove a worktree merely because its child pane stopped; preserve dirty/unintegrated work and branch identity.
- Artifact copying must happen before removal and be verified from the parent checkout/state, not from a path about to disappear.

**Checks**

- `npm test -- --test-name-pattern="worktree|writer|lease|integration|retention|cleanup"` — expect one-writer enforcement, parallel read-only allowance, isolated writer creation, parent-reload/live-child lease preservation, Herdr-unavailable fail-closed behavior, proven stale-lease reclamation, partial-failure retention, dirty/unintegrated refusal, human-only discard, verified artifact capture, and identity-safe removal.
- Run temporary Git repository tests with two concurrent extension instances plus simulated parent crash/reload — expect transactional persistent writer-lease enforcement and no accidental branch/path reuse or ambiguous lease stealing.
- Run a no-model real-Herdr worktree conformance case — expect no-focus workspace creation, returned provenance recorded, safe empty-worktree removal, and every created Herdr/Git resource reported.

**Review checkpoint**

- Review repository identity, cross-process locking, worktree provenance, artifact retention, integration gates, and removal proof.
- Evidence: temporary Git/worktree tests, protocol fixtures, no-model Herdr transcript, and retained-refusal cases.
- Exit when concurrent mutation can occur only in isolated checkouts and no dirty/unintegrated checkout can be silently destroyed.

## Phase 5 — Implement Pi, Claude, and Codex harness adapters and lifecycle control

**Files and references**

- Create `src/harnesses/base.ts`, `pi.ts`, `claude.ts`, `codex.ts`, `capabilities.ts`, and `prompt.ts`.
- Create `src/runtime/start.ts`, `send.ts`, `wait.ts`, `interrupt.ts`, and `stop.ts`.
- Create `tests/harnesses/*.test.ts` and `tests/runtime/lifecycle.test.ts`.

**Implementation**

1. Define a harness adapter interface and explicit capability matrix for executable discovery, enforceable tool/resource visibility, filesystem confinement, approval behavior, model/thinking mapping, initial readiness, turn interrupt, graceful exit, and session/output metadata. Reject contradictory profiles such as read-only plus a mutation-capable tool; never infer equivalent controls across harnesses.
2. Build argv arrays only; never concatenate a shell command. Validate executable presence and model/thinking/permission compatibility before creating Herdr resources. Resolve effective cwd against configured/trusted roots and apply the monotonic override policy from Phase 1.
3. For Pi, generate a unique session ID/name and private session/system-prompt paths, use explicit tool allowlists, translate thinking to `--thinking`, and set `PI_SUBAGENT_CHILD=1`, `PI_HERDR_SUBAGENT=1`, run/profile/parent metadata, and recursion-blocking environment. Launch with `--no-skills --no-prompt-templates`; add only each resolved, reviewed profile skill via explicit `--skill` paths. Keep extensions loaded so the Herdr Pi lifecycle integration survives, while this package's own child guard suppresses parent orchestration registration.
4. For Claude, launch interactively with name/session ID, a restrictive built-in `--tools` list, explicit permission mode matching the capability matrix, and `--effort` plus append-system-prompt file. Specify how MCP/project/user customizations are included or denied for each policy. Keep the Herdr integration active in the default integrated policy; document that strict `--safe-mode` disables native session reporting and that tool policy is not an OS filesystem sandbox.
5. For Codex, launch interactively with read-only/never-approval or workspace-write/on-request policy, translate effort via documented config override, and reject dangerous bypass flags in profiles/settings. Use its OS sandbox as the enforceable boundary and list writable/additional roots explicitly.
6. Start the CLI without the task, wait for initial agent readiness with a startup timeout, then submit the assembled task through atomic `pane.send_input` text plus Enter. Confirm a new `working` cycle or unambiguous turn evidence before returning success.
7. Assemble child instructions as runtime boundary, profile body, delegated task, expanded artifact contract, and final handoff shape. Make no-recursive-delegation and ownership/permission constraints non-optional.
8. Implement `send` as atomic pane input and verify a new turn where applicable. Implement waits against semantic states with timeouts and post-wait output/state inspection.
9. Implement soft interrupts per adapter (Pi Control-C; Claude/Codex Escape, with documented fallback where appropriate), then verify the pane leaves `working` or return an uncertain/failed interrupt result.
10. Implement graceful stop as interrupt-if-needed, adapter exit, bounded wait, and final identity check. Force stop closes only a verified extension-owned pane. Close a dedicated tab only after all owned children are closed, only the untouched anchor remains, and no unknown pane/process is present.
11. Bound all returned output to the Pi tool convention and preserve explicit truncation metadata. Use recent-unwrapped Herdr output as the cross-harness baseline; treat Pi final-session extraction as an optional adapter enhancement.

**Contract or shape**

```ts
interface HarnessAdapter {
  readonly kind: Harness;
  check(input: EffectiveProfile): Promise<CapabilityReport>;
  buildLaunch(input: LaunchContext): Promise<{ argv: string[]; env: Record<string, string> }>;
  interruptKeys: readonly string[];
  gracefulExit(input: { paneId: string }): Promise<void>;
}

// Mandatory Pi child compatibility signal:
env.PI_SUBAGENT_CHILD = "1";
env.PI_HERDR_SUBAGENT = "1";
```

**Pitfalls and safeguards**

- Do not submit prompts in argv; they can leak through process listings and obscure startup failures.
- Do not describe Pi/Claude read-only tool restriction as filesystem confinement; only Codex's documented sandbox provides that stronger boundary here.
- Do not let explicit launch overrides broaden tools/permissions, escape trusted roots, or bypass a required writer worktree.
- Do not use Claude background agents, Codex native subagents, Pi hidden subprocess delegation, or any recursive agent mechanism.
- Sending an interrupt key is not proof of interruption; inspect resulting state/output.
- A child may be blocked on permission or human input. Do not force-stop by default or auto-approve through terminal input.

**Checks**

- `npm test -- --test-name-pattern="adapter|capability|argv|resource-isolation|lifecycle|interrupt|stop"` — expect exact argv/env for all harness/policy/thinking combinations, contradictory permissions and broadening overrides rejected, cwd containment enforced, dangerous options rejected, prompt omitted from argv, and `PI_SUBAGENT_CHILD=1` always set for Pi.
- Pi child resource tests — expect `--no-skills --no-prompt-templates`, only reviewed profile `--skill` paths, parent orchestration extension/tools/commands/UI absent under `PI_HERDR_SUBAGENT=1`, and the Herdr lifecycle integration still active.
- PTY/screen fixture tests — expect each harness's readiness, prompt submission, blocked state, completion, Escape/Control-C interruption, and graceful exit detection to be exercised independently of the fake socket implementation.
- Fake lifecycle tests — expect startup timeout cleanup, task submission only after readiness, working-cycle confirmation, blocked preservation, interrupt uncertainty handling, graceful-to-force separation, and identity-safe close.
- Manual smoke in a disposable Herdr test tab: start one Pi child and finish a trivial prompt — expect no HTML auto-open, no parent-only skill/tool registration, a native Pi session reference, visible working→done/idle, and deliberate cleanup.

**Review checkpoint**

- Review permission claims, process argument secrecy, no-recursion enforcement, interrupt/stop semantics, and cleanup ownership.
- Evidence: argv snapshots, fake CLI captures, lifecycle tests, and the Pi manual smoke transcript/Herdr IDs.
- Exit when each adapter is explicit about what it can and cannot enforce and no unsafe cross-harness fallback exists.

## Phase 6 — Expose the Pi tools and parent-only orchestration skill

**Files and references**

- Create `src/tools/start.ts`, `list.ts`, `get.ts`, `send.ts`, `wait.ts`, `interrupt.ts`, `stop.ts`, `schemas.ts`, and `renderers.ts`.
- Complete `extensions/herdr-subagents/index.ts`: register tools, lifecycle services, and prompt metadata.
- Create `skills/herdr-subagents/SKILL.md` plus conditional `skills/herdr-subagents/references/prompt-and-safety.md`.
- Create `tests/tools/*.test.ts` and `tests/skill/skill-contract.test.ts`.

**Implementation**

1. Register separate, strict tools for start, list, get, send, wait, interrupt, and stop. Prefix public names during coexistence if configured; centralize names so generic aliases can replace them after old-package removal.
2. Make start accept a profile name, task, and optional harness/model/thinking/cwd/worktree requests, resolve them through the trusted-root/capability/monotonic policy, and return after verified turn start rather than full completion. Narrowing overrides may proceed; broadening overrides require trusted configuration plus interactive human confirmation before any resource creation. Use an internal topology mutex/idempotency record for parallel sibling starts.
3. Make list default to children owned by the current parent Pi session; require explicit scope for project/all-owned/global observational views. Distinguish live, stopped, failed, lost, and orphan records.
4. Make get return current Herdr state, effective profile/harness, ownership/session/topology, recent bounded output, revisions/truncation, task synopsis, elapsed time, and artifact paths. Never expose unbounded transcripts or private system-prompt contents.
5. Make send target only one resolved current-active-branch owned run, wait support semantic completion/attention states with abort/timeout, and interrupt preserve the session. Keep LLM-callable pane stop modes `graceful | force`: force may close only a freshly identity-verified current-branch-owned pane and does not authorize deleting its checkout or artifacts. Add independent `cleanup: "retain" | "remove_if_safe"` for owned writer worktrees; dirty/unintegrated worktree discard remains available only through an interactive human confirmation command/UI.
6. Throw execution errors for invalid/security-sensitive operations so Pi receives `isError`; keep expected blocked/unavailable states as structured non-crash results where the main agent can act.
7. Give every tool compact custom renderers with semantic statuses and expanded details; do not duplicate the persistent dashboard.
8. Write a parent-only skill that decides deliberately between parent work and delegation, defaults to Pi, uses Claude/Codex only by request/profile, assigns bounded roles, forbids recursive delegation, limits concurrency, isolates writers, monitors every child, handles blocked states through get/send, verifies handoffs/changes, and stops or deliberately retains every owned resource.
9. Make the skill use only the extension's tools for starting, messaging, waiting, focusing, interrupting, stopping, or cleaning up Herdr/subagent resources; never let it bypass ownership through Bash/Herdr CLI. Explicitly allow and require ordinary parent read/diff/test/Git tools for verification and integration of child code. Enforce child isolation in code: Pi argv disables discovered skills/templates, adds only reviewed profile skills, explicit tool allowlists exclude orchestration, and the package extension's `PI_HERDR_SUBAGENT=1` guard omits parent tools/commands/UI. Keep prompt no-recursion language as defense in depth, not the primary enforcement.
10. Add package-skill validation and tests that assert mandatory Herdr-only/no-fallback/no-recursion/parent-verification rules remain present and that the parent skill is absent from child resource metadata.

**Contract or shape**

```ts
// Representative tool surface; exact TypeBox schemas live in src/tools/schemas.ts.
subagent_start({ profile: "scout", task: "Map the auth flow" });
subagent_list({ scope: "current_session" });
subagent_get({ id: "...", lines: 160 });
subagent_send({ id: "...", message: "Focus on token refresh." });
subagent_wait({ id: "...", states: ["done", "idle", "blocked"], timeoutMs: 900_000 });
subagent_interrupt({ id: "..." });
subagent_stop({ id: "...", mode: "graceful", cleanup: "retain" });
// `mode: "force"` may terminate only the proven-owned pane; it never implies worktree discard.
```

**Pitfalls and safeguards**

- Pi executes sibling tools concurrently; serialize shared topology/registry mutations without serializing independent child work unnecessarily.
- Do not let global Herdr agents appear owned merely because their cwd/profile matches.
- The skill must not treat a child claim or `done` status as proof of correctness; require parent verification.
- Do not rely on prompt wording to hide the parent skill. Child resource flags, explicit reviewed skill paths, tool exclusion, and extension registration guards must enforce the boundary.

**Checks**

- `npm test -- --test-name-pattern="tool|skill|concurrency|truncation|child-isolation"` — expect schema validation, monotonic override rejection/confirmation gates, current-session scoping, ownership rejection, blocked/send/wait flow, abort propagation, parallel start serialization, bounded output, and parent-only resources absent in child mode.
- `npx -y skills-ref validate skills/herdr-subagents` — expect a valid skill name/description/frontmatter and resolvable references.
- Inspect Pi child system prompt/resource metadata plus active/all tool lists in fake and manual launches — expect the parent skill, orchestration tools/commands/UI, and unrelated discovered templates absent; expect only reviewed profile skills/tools and the `PI_SUBAGENT_CHILD`/Herdr lifecycle boundary active.

**Review checkpoint**

- Review the LLM-facing schemas/descriptions, ownership defaults, concurrency behavior, skill delegation rubric, and no-recursion enforcement.
- Evidence: tool result fixtures/render snapshots, concurrency tests, skill validator output, and child tool-list evidence.
- Exit when a fresh main Pi can complete start→wait/get→verify→send/interrupt/stop using only documented tools and the skill cannot instruct a hidden fallback.

## Phase 7 — Build the live dashboard and `/subagents` inspection workflow

**Files and references**

- Create `src/ui/status.ts`, `widget.ts`, `overlay.ts`, `details.ts`, `actions.ts`, and `theme.ts`.
- Complete UI lifecycle/command registration in `extensions/herdr-subagents/index.ts`.
- Create `tests/ui/*.test.ts` with width/theme/state fixtures.

**Implementation**

1. Show a compact status/footer entry and above-editor widget only when the current parent session owns visible runs. Summarize blocked, working, ready (`done`/`idle`), unknown, and failure states without erasing the `done` versus `idle` distinction in details.
2. Render rows with icon, profile/run label, harness, semantic status text, optional short custom status, elapsed time, and changed-output indicator. Use text/icons in addition to color.
3. Implement `/subagents` as a TUI-only overlay with current-session default and explicit all-owned/global observational scope. Enable send, interrupt, confirmed stop/cleanup, and focus only for records proven owned by the current active branch. Render orphan, uncertain, other-session, and global rows as details/recent-output-only with explicit disabled-action explanations; even focus is disabled because it mutates Herdr's done→idle attention state.
4. Close the overlay before `agent.focus`; target terminal ID when possible and report focus failure without mutating ownership. Focusing a done pane may turn it idle and must be reflected as attention state, not a new task.
5. Request rerenders on relevant state/cache changes, preserve selection across refreshes by run ID, and clamp pagination when agents close/move.
6. Respect injected Pi themes, terminal width, ANSI-visible width, narrow-terminal fallback, and `ctx.mode === "tui"`. In RPC/JSON/print modes, keep tools operational and make the command return a clear non-TUI message.
7. Stop subscriptions/widgets/statuses/overlay handles idempotently on session shutdown/reload and restore them from reconciled state on session start.

**Contract or shape**

```text
Subagents · 1 blocked · 2 working · 1 ready
! auth-review   Claude  blocked   approval needed
● api-research  Pi      working   03:42
✓ test-review   Codex   done      01:18
```

**Pitfalls and safeguards**

- Never rely on color alone; blocked/done/idle need visible labels and distinct icons.
- Every rendered line must fit the supplied width, including ANSI sequences.
- Do not let a stale overlay action focus, close, interrupt, or send to a moved/replaced pane; re-resolve current-active-branch ownership and identity immediately before action.
- Observational scope is not a weaker control scope: orphan/global/uncertain/other-session rows expose no focus or lifecycle actions.
- Avoid a one-second permanent global poll when no runs/UI are active; adapt reconciliation frequency and suspend when appropriate.

**Checks**

- `npm test -- --test-name-pattern="ui|widget|overlay|width|focus|observational"` — expect all state mappings, narrow/wide widths, pagination, stable selection, moved-pane actions, no-TUI fallback, and every focus/control action disabled for orphan/global/uncertain/other-session rows.
- Manual TUI check through `pi -e ./extensions/herdr-subagents/index.ts` inside Herdr — expect live widget updates, keyboard actions, readable light/dark themes, focus jump, and UI cleanup after the final child closes.
- Capture screenshots or ANSI render fixtures for blocked/working/done/idle/unknown/failed and narrow/wide layouts as review evidence.

**Review checkpoint**

- Review accessibility, attention semantics, action safety, render performance, and lifecycle cleanup against Pi TUI guidance and the existing dashboard's proven patterns.
- Evidence: render snapshots/screenshots, manual action transcript, and socket/timer cleanup assertions.
- Exit when status changes are visible without polling noise and every destructive UI action re-verifies ownership.

## Phase 8 — Harden recovery, package distribution, documentation, and real-harness E2E

**Files and references**

- Create `src/doctor/report.ts` and register `/subagents-doctor` (or the temporary namespaced equivalent).
- Expand `README.md`: install, profile schema/paths/precedence, default agents, tools/commands, artifacts, Git excludes, permissions, recovery, troubleshooting, and migration from `pi-subagents`.
- Create `docs/architecture.md` and `docs/profile-reference.md` for durable protocol/state/profile contracts.
- Create `tests/e2e/*.test.ts` for fake-process/package smoke coverage and `scripts/e2e-herdr-smoke.mjs` for explicit operator-run real Herdr checks.
- Finalize `package.json` publishing metadata and files.

**Implementation**

1. Add read-only doctor checks for Pi/Herdr/client-server protocol, validated parent identity, harness executables, integration versions, profile diagnostics/shadows, optional research capabilities, Git/non-Git ignore status, artifact path safety, worktree/ownership proof, owned/orphan observational panes, and package version.
2. Reconcile recoverable records only when active-branch custom entries, run nonce, terminal/native session identity, and live Herdr topology agree. Show global/orphan/uncertain agents observationally with retention guidance; do not implement adoption, ownership transfer, or destructive orphan cleanup in this scope.
3. Document exact settings/profile roots and precedence, whole-profile replacement, runtime-name collision errors, soft researcher capability behavior, capability/override matrix, model/thinking translation, parent/child artifact writer modes, and why tracked `.gitignore` is not modified automatically.
4. Document migration: remove/disable the old package before enabling generic aliases, retain `PI_SUBAGENT_CHILD` compatibility, and identify potential command/tool/profile collisions during overlap.
5. Add deterministic fake E2E tests for start→submit→working→done/idle→handoff, blocked→inspect/send, interrupt, graceful/force stop, pane move, extension reload/reconcile, `/tree` active-branch isolation, parent session fork isolation, socket reconnect, tampered metadata retention, partial starts, and worktree artifact capture.
6. Provide an opt-in real Herdr smoke script that creates a dedicated no-focus test workspace/tab, records every resource, runs bounded Pi/Claude/Codex scenarios only when installed/configured, and always performs identity-verified cleanup or reports retained resources.
7. Create a real archive with `npm pack --json`, inspect the returned tarball, and install/load that exact archive under a temporary isolated `PI_CODING_AGENT_DIR` without source-tree fallback or global settings changes. Verify skill, extension, bundled agents, child guards, and package-relative imports from the installed tarball.
8. Keep `private: true` and publication disabled until the user chooses a license. After approval, create the matching `LICENSE`, finalize package/repository metadata and minimum versions, rerun the packed-artifact gate, and only then mark publication-ready; this plan does not publish.

**Pitfalls and safeguards**

- Real E2E tests can consume model quota and alter Herdr topology; make them explicit, bounded, no-focus, and cleanup-audited rather than part of ordinary unit tests.
- Do not report an outdated/missing integration as total failure when screen detection remains valid; distinguish state capability from native session restore capability.
- Package smoke tests must use the packed artifact, not only the source tree, to catch omitted agents/skills/runtime modules.
- Do not remove a dirty/unintegrated worktree or orphan pane merely to make cleanup green.

**Checks**

- `npm run typecheck && npm test` — expect all unit, integration, fake E2E, UI, profile, artifact, and lifecycle tests to pass with no leaked timers/processes.
- `npm pack --json`, inspect the returned tarball, and install/load that exact archive in a temporary `PI_CODING_AGENT_DIR` — expect the extension, parent-only skill, default agents, child guards, docs, and runtime imports to work from package layout with no source fallback.
- Run `node scripts/e2e-herdr-smoke.mjs --harness pi`; then opt into Claude/Codex runs where authenticated — expect verified start/status/output/interrupt/stop/focus/recovery and a cleanup report listing every created/closed/retained resource.
- Run `/subagents-doctor` in source and packed-package sessions — expect current compatibility, profile sources, optional capability warnings, Git exclusion status, and no unowned destructive recommendations.

**Review checkpoint**

- Review active-branch recovery proof, observational orphan handling, doctor truthfulness, packed distribution, migration, real-harness safety, and cleanup evidence.
- Evidence: authoritative test log, tarball contents/install transcript, doctor output, real Herdr run IDs/pane cleanup report, and reviewed changed-file/documentation inventory (plus a diff when the implementer has initialized version control).
- Exit when a new user can install the packed package, discover defaults/custom profiles, run and inspect a Pi child, and safely diagnose missing optional capabilities without consulting source code.

## Final validation and review

- Run `npm run typecheck && npm test` — expect the authoritative repository gate to pass without open handles, leaked processes, unhandled rejections, or skipped security/ownership tests.
- Run `npm pack --json`, inspect the returned tarball, and install/load that exact archive under a temporary `PI_CODING_AGENT_DIR` — expect package-relative extension, skill, default-agent discovery, and child isolation to work outside the source tree with no source fallback.
- Run the real Herdr Pi scenario and authenticated Claude/Codex scenarios where available; retain the resource/cleanup report and explicitly name any skipped harness with the reason and confidence impact.
- Manually verify both shared and namespaced user/project profile precedence in a trusted disposable project, including duplicate runtime names and untrusted-project suppression.
- Manually verify `.subagents/` and requested `.progress/` are ignored through local Git exclude, tracked `.gitignore` remains byte-identical, and worktree handoffs survive safe worktree cleanup.
- Manually verify Pi child completion does not auto-open HTML while the parent still does, proving `PI_SUBAGENT_CHILD=1` compatibility without disabling Herdr's Pi integration.
- Request an independent implementation review focused on protocol correctness, ownership/destructive actions, permission claims, artifact path/Git safety, profile trust/precedence, cross-harness argv/interrupt behavior, TUI cleanup, and package completeness. Provide this plan, the implementation tracker, changed files/diff, tests, packed artifact listing, manual Herdr evidence, skipped harnesses, and known constraints.
- Convert every material finding into tracked work, fix it, rerun affected focused checks plus the authoritative gate, and obtain follow-up review until no material concern remains or a human decision blocks completion.

## Definition of Done

- All subagents launched by the package run exclusively as visible Herdr agents; unavailable/incompatible Herdr fails closed with actionable diagnostics.
- Start, list, get, send, wait, interrupt, and graceful/force-stop tools enforce current-session ownership by default and never act destructively on an unverified pane.
- Pi, Claude, and Codex adapters use safe interactive argv/env, explicit capability matrices, monotonic overrides, supported permission/thinking controls, verified turn lifecycles, and no hidden/native recursive subagent path; Pi/Claude tool policies are not misrepresented as filesystem sandboxes.
- Pi children set `PI_SUBAGENT_CHILD=1`, suppress this package's parent orchestration extension/UI, launch without automatically discovered skills/templates, receive only reviewed profile skills/tools, retain the separate Herdr lifecycle integration, and do not auto-open final HTML.
- The parent-only skill makes deliberate delegation decisions, defaults to Pi, forbids recursive delegation, isolates writers, verifies handoffs/changes, and resolves or reports every child.
- Shared and namespaced user/project agent paths merge with documented precedence, trusted-project gating, runtime-name collision diagnostics, and bundled scout/researcher/worker defaults.
- Researcher uses available research tools/skill without a hard package dependency and never represents memory-only output as completed external research.
- Runtime artifacts are path-safe under explicit roots, handle non-Git/pre-existing directories truthfully, and are locally Git-ignored without automatic tracked `.gitignore` edits; read-only handoffs are parent-written and worktree artifacts survive cleanup.
- Ownership/destructive control requires active-branch Pi evidence plus immutable run/terminal/native-session/topology identity; `/tree`, fork, tampered metadata, partial starts, stale IDs, and uncertain proof retain/report resources instead of transferring or destroying them.
- Concurrent writers run only in isolated Herdr worktree checkouts with typed provenance, artifact capture, integration/retention state, and no dirty/unintegrated forced removal.
- The compact dashboard and `/subagents` overlay accurately display semantic/attention states, inspect output, control owned children, focus panes, and clean up UI resources across Pi lifecycle changes.
- Pi children never auto-open final HTML responses, while parent behavior remains unaffected.
- Source and exact-packed-artifact automated tests pass, protocol-16 goldens and no-model conformance prevent a self-consistent fake protocol, real Herdr validation is recorded for available harnesses, documentation is complete, and independent review has no unresolved material findings.
- The package remains private/unpublished until the user selects a license; after that approval, the matching license and publication metadata are present and the packed-artifact gate has been rerun.
