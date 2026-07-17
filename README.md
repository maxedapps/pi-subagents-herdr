# pi-subagents-herdr

Private Pi package that exposes safe, visible subagent orchestration through a Herdr backend. Agents see a backend-neutral five-tool lifecycle; operators retain Herdr diagnostics, active-branch ownership recovery, isolated writer worktrees, a live TUI, and read-only doctor checks.

> **Legal hold:** `package.json` remains `private: true`. Do not publish or add license/repository metadata without explicit user approval.

## Requirements and safety

- Node.js 22.19+, Pi 0.80.6+, Herdr 0.7.3/protocol 16.
- Parent Pi runs inside the matching Herdr pane/integration.
- The selected `pi`, `claude`, or `codex` executable is installed and authenticated.

Every child is visible and interactive. Missing/incompatible backend identity fails closed; there is no hidden subprocess, recursive delegation, cross-harness substitution, or fallback. Pi/Claude tool policies are not filesystem sandboxes; Codex uses its documented OS sandbox. Writers require isolated worktrees. Child completion and test claims are evidence, never parent verification.

Pi children receive no package-specific trust, skill, or prompt-template override flags. Each child independently uses normal Pi trust and resource discovery. Saved trust and global settings are available through the ordinary user environment, but transient parent `--approve` and session-only trust are not inherited by a separate child process.

Process control requires agreement between the current Pi session and active branch journal, immutable run nonce, durable `run.json`, stable terminal/native identity, and a fresh backend snapshot. Other-session, orphaned, uncertain, and global live records are observational only. A later parent session may reauthorize **cleanup only** for a proven-stopped schema-v5 journal when exact parent/child Git, Herdr workspace/anchors, run nonce, branch/path, and idle/no-agent evidence all reconcile; it never adopts the process or prior private result. Send/interrupt delivery is `confirmed`, `unconfirmed`, or `uncertain`; never retry uncertain input automatically. Force stop never authorizes dirty checkout discard.

## Install

```sh
npm ci
npm run check
pi install /absolute/path/to/pi-subagents-herdr
```

`npm ci` currently reports `node-domexception@1.0.0` from Pi's dev-only Google authentication graph. This is a reviewed upstream exception pending [fetch-blob's unreleased removal](https://github.com/node-fetch/fetch-blob/pull/176); overrides and warning suppression are intentionally rejected. `npm run deps:deprecations` audits lock metadata and fails for any new, widened, or stale exception.

Remove with `pi remove /absolute/path/to/pi-subagents-herdr`. Restart Pi or use `/reload`, then run `/subagents-doctor` and `/subagents`.

For an exact private archive install/load qualification, use `npm run pack:inspect`. It packs once, installs that exact archive under a temporary prefix, verifies the parent-only package skill, verifies ordinary child fixture-skill discovery without `--no-skills`, checks child guards/package-relative resources, and removes the temporary environment.

## Five tools

Exactly these model-facing tools are registered; there are no aliases:

```text
subagent_start({ profile: "scout", task: "Map the auth flow; do not modify files." })
subagent_status({})
subagent_status({ scope: "all_owned" })
subagent_status({ id: "<run>", lines: 160 })
subagent_status({ id: "<run>", states: ["done", "idle", "blocked"], timeoutMs: 900000, lines: 160 })
subagent_send({ id: "<run>", message: "Focus on token refresh." })
subagent_interrupt({ id: "<run>", timeoutMs: 15000 })
subagent_stop({ id: "<run>", mode: "graceful" })
```

`subagent_status` has one strict flat Google-compatible schema and three execution modes:

- **List:** omit `id`; optional `scope` is `current_session` (default), `project`, `all_owned`, or `global`.
- **Inspect:** provide `id` without `states`; optional `lines` is 1–2000 (default 160).
- **Wait then inspect:** provide `id` and non-empty unique `states`; optional bounded `timeoutMs` is 1–86400000 and optional `lines` bounds final recent output.

Execution rejects cross-mode combinations: `scope` with `id`; `states`, `timeoutMs`, or `lines` without `id`; and `timeoutMs` with `id` but no `states`. Wait preserves semantic `working`, `blocked`, `done`, `idle`, and `unknown` states, abort propagation, timeout errors, ownership defaults, and 50KB/2000-line output bounds. A successful wait returns detailed inspection/output, not only a matched state.

Every successful start reports `completion.pending` with `delivery: "automatic"`. Starts and sends return immediately. For Pi children, the structured final assistant response is captured and injected into the owning parent branch as `herdr-subagents.result.v1`. Writer results carry an extension-derived `ACTION REQUIRED` block with exact Git/worktree facts. Later blocked, failed, retained-cleanup, UI, or recovery transitions use deduplicated `herdr-subagents.action-required.v1` follow-ups and the same status/UI attention state. Missing bridge evidence is capture-unavailable—never an invented result. Parent verification and explicit stop/finalization remain mandatory.

Placement starts use fresh exact topology checks and retry only explicit `agent_placement_not_found`; exhaustion returns the managed run ID and ordinary stop action. See the architecture and operations guides for details.

## Bundled profiles and skill

- `scout`: Pi, read-only reconnaissance with a self-contained delivered final response.
- `researcher`: Pi, read-only sourced research when reviewed external tools are exposed, with a self-contained delivered final response.
- `worker`: Pi, mutation tools, mandatory isolated writer worktree, and a self-contained delivered final response.

Bundled profiles do not pin models and prohibit recursive delegation. Profiles require a self-contained final assistant response as the primary result transport. Profiles do not configure skills; Pi children discover them normally. The package contributes `use-herdr-subagents` dynamically in parent mode only. It teaches the extension's exact five-tool lifecycle, automatic result delivery, profile selection, least privilege, blocked/uncertain handling, writer isolation, parent verification, and cleanup. It also tells agents to pair other applicable subagent skills with it when available and possible, without requiring or naming one. Child mode contributes only a narrow result bridge (no orchestration tools or parent skill).

## Settings

Namespaced settings only:

- user: `${getAgentDir()}/herdr-subagents/settings.json`
- trusted project: `<project-config-root>/herdr-subagents/settings.json`

Merge order is defaults → user → trusted project; known nested objects merge by field and arrays/scalars replace. Unknown keys fail validation.

```json
{
  "concurrency": { "maxRunning": 4, "maxWriters": 1 },
  "defaultHarness": "pi",
  "profileDirectories": { "user": [], "project": [] },
  "widget": { "visibility": "auto" },
  "integrations": { "strictness": "strict" },
  "security": {
    "allowedRoots": ["/absolute/trusted/checkout"],
    "allowBroadeningOverrides": false,
    "requireWriterWorktree": true
  }
}
```

Overrides narrow by default. Broadening requires trusted configuration plus interactive human confirmation before resources are created. Unknown tools, recursive orchestration, root escapes, and mutation without required isolation remain prohibited.

## Artifacts and finalization

Bundled profiles create only transient parent-checkout operational state while unresolved:

```text
.subagents/runs/<id>/
├── run.json
└── results/             # when structured generations were captured
```

The parent-persisted structured result or explicit failure/action notice is the durable handoff. Bundled children do not write handoff/progress files. Custom profiles may explicitly configure run-unique handoff/progress artifacts; existing files in a disposable checkout are copied to parent-owned `captured/` storage and byte/SHA-256 verified before removal. Their absence is not a cleanup prerequisite; capture failure retains rather than losing a present custom artifact.

While live, schema-v5 `run.json` retains assignment, bounded output, action state, ownership journal, and exact worktree snapshot for recovery. Private system/session/exchange files remain only while live or capture-uncertain. After the result/failure notice is parent-persisted and finalization succeeds, runtime metadata/results are purged; verified custom captures remain intentionally. There is no age-based or path-only garbage collector.

Git protection appends anchored `/.subagents/` and explicitly requested `/.progress/` rules to Git-local `info/exclude`; tracked `.gitignore` is not edited. A pre-existing untracked `.progress/` requires explicit review before hiding it.

## TUI and operations

`/subagents` lists current-session owned runs plus stopped runs with unresolved attention. Visible controls are ↑/↓ selection, Enter focus, `x` graceful stop with automatic safe finalization, `r` refresh, and Escape close. Focus and stop run only after the overlay is disposed. Use model-facing `subagent_status` for detailed output and broader observational scopes; use explicit `subagent_send`, `subagent_interrupt`, and `subagent_stop` inputs for actions not exposed in the operator dashboard.

`/subagents-doctor` is read-only. It may mention Herdr because it diagnoses the actual backend: versions/protocol, parent identity, integrations, profiles/settings, Git/artifacts, recovery, topology, and retained worktrees. It never adopts, focuses, sends, stops, cleans, or rewrites settings.

See [`docs/architecture.md`](docs/architecture.md), [`docs/profile-reference.md`](docs/profile-reference.md), [`docs/operations.md`](docs/operations.md), and [`docs/migration.md`](docs/migration.md).

## Validation gates

Fast development gate—each core suite runs once; no subprocess fake-E2E matrix and no archive install:

```sh
npm test
npm run check
```

`check` runs typecheck, core tests, and docs links. Explicit layers:

```sh
npm run test:e2e                    # deterministic no-model subprocess matrix
npm run pack:inspect                # one exact pack/install/Pi-load pass
npm run skill:check                 # local pinned skills-ref validation
npm run conformance:herdr:no-model  # opt-in real placement check; harmless shell command, no coding model
```

Full release qualification runs typecheck, core tests, docs, deterministic E2E, exact archive qualification, and skill validation once each:

```sh
npm run check:full
```

No ordinary or full gate starts a real model. `scripts/e2e-herdr-smoke.mjs` remains opt-in and dry-runs unless `--confirm-model` is explicitly supplied.
