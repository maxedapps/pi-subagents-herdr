# pi-subagents-herdr

Private Pi package that exposes safe, visible subagent orchestration through a Herdr backend. Agents see a backend-neutral five-tool lifecycle; operators retain Herdr diagnostics, active-branch ownership recovery, isolated writer worktrees, a live TUI, and read-only doctor checks.

> **Legal hold:** `package.json` remains `private: true`. Do not publish or add license/repository metadata without explicit user approval.

## Requirements and safety

- Node.js 22.19+, Pi 0.80.6+, Herdr 0.7.3/protocol 16.
- Parent Pi runs inside the matching Herdr pane/integration.
- The selected `pi`, `claude`, or `codex` executable is installed and authenticated.

Every child is visible and interactive. Missing/incompatible backend identity fails closed; there is no hidden subprocess, recursive delegation, cross-harness substitution, or fallback. Pi/Claude tool policies are not filesystem sandboxes; Codex uses its documented OS sandbox. Writers require isolated worktrees. Child completion and test claims are evidence, never parent verification.

Pi children receive no package-specific trust, skill, or prompt-template override flags. Each child independently uses normal Pi trust and resource discovery. Saved trust and global settings are available through the ordinary user environment, but transient parent `--approve` and session-only trust are not inherited by a separate child process.

Control requires agreement between the current Pi session and active branch journal, immutable run nonce, durable `run.json`, stable terminal/native identity, and a fresh backend snapshot. Other-session, orphaned, uncertain, and global records are observational only. Send/interrupt delivery is `confirmed`, `unconfirmed` (Herdr acknowledged but expected evidence did not appear), or `uncertain` (the mutation may have succeeded but its response was lost). Inspect uncertain runs; never retry input or destroy a run automatically. Interrupt remains distinct from stop. Force stop can affect only a freshly revalidated owned pane and never authorizes dirty checkout discard.

## Install

```sh
npm ci
npm run check
pi install /absolute/path/to/pi-subagents-herdr
```

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
subagent_stop({ id: "<run>", mode: "graceful", cleanup: "retain" })
```

`subagent_status` has one strict flat Google-compatible schema and three execution modes:

- **List:** omit `id`; optional `scope` is `current_session` (default), `project`, `all_owned`, or `global`.
- **Inspect:** provide `id` without `states`; optional `lines` is 1–2000 (default 160).
- **Wait then inspect:** provide `id` and non-empty unique `states`; optional bounded `timeoutMs` is 1–86400000 and optional `lines` bounds final recent output.

Execution rejects cross-mode combinations: `scope` with `id`; `states`, `timeoutMs`, or `lines` without `id`; and `timeoutMs` with `id` but no `states`. Wait preserves semantic `working`, `blocked`, `done`, `idle`, and `unknown` states, abort propagation, timeout errors, ownership defaults, and 50KB/2000-line output bounds. A successful wait returns detailed inspection/output, not only a matched state.

Every successful start reports `completion.pending` with the exact required `subagent_status` call. Start/list output is never task completion: inspect terminal output for each ID individually, act on blockers, verify claims, and resolve the run. Parent mode emits at most one in-memory follow-up reminder per uninspected start/send generation; it does not poll children or persist an acknowledgement queue.

## Bundled profiles and skill

- `scout`: Pi, read-only reconnaissance, parent-materialized handoff, no progress file.
- `researcher`: Pi, read-only sourced research when reviewed external tools are actually exposed, parent-materialized handoff, no progress file.
- `worker`: Pi, mutation tools, isolated writer worktree, preserved child handoff, parent-owned final wrapper, plus optional configured progress.

Bundled profiles do not pin models and prohibit recursive delegation. Profiles do not configure skills; Pi children discover them normally. The package contributes `use-subagents` dynamically in parent mode only. It teaches deliberate bounded delegation, least privilege, fresh context, writer isolation, blocked-flow monitoring, parent verification, and lifecycle resolution without exposing backend architecture. Child mode contributes neither that skill nor orchestration tools.

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

## Artifacts

Normal read-only run:

```text
.subagents/runs/<id>/
├── run.json
└── handoff.md
```

Bundled worker run inside its disposable worktree:

```text
.subagents/runs/<id>/
├── handoff.md           # preserved child-authored file
├── handoff.parent.md    # required parent-owned final wrapper
└── progress.md          # optional supporting evidence
```

The wrapper always contains the full delegated assignment and either a validated child handoff or bounded final-output fallback. Its deterministic path is registered as required removal evidence before worktree creation; the child file is never overwritten. The parent checkout retains `.subagents/runs/<id>/run.json`; `captured/` is created only when copying worktree evidence before safe removal. Required wrapper/handoff is captured and hash/byte verified; configured progress is captured when present but is never required for removal.

There are no persistent prompt artifacts or public prompt/system profile fields. While live, `run.json` retains the full delegated assignment and last bounded output so exact context survives reload; wait/done observation does not create handoffs. At proven stop the assignment moves into the single final handoff and is removed from `run.json`. Internal system prompt files live in a canonical, run-bound private OS-temp directory. Pi alone receives a private session directory; Claude/Codex do not get unused session directories. Recovery rejects redirected, symlinked, non-private, or structurally unexpected runtime paths as observational. Internal files remain while a run is live or uncertain and are removed only after handoff materialization and immediate layout revalidation. `run.json` then reports ephemeral files as removed; model-facing inspection exposes only retained/removed state, not private paths.

Launch validation uses an always-removed private temporary directory; no `<id>-preflight` run directory is created. Durable run metadata/handoffs, uncertain/live/orphan evidence, and retained-worktree evidence are never garbage-collected automatically. There is no retention-age setting or cleanup command.

Git protection appends anchored `/.subagents/` and explicitly requested `/.progress/` rules to Git-local `info/exclude`; tracked `.gitignore` is not edited. A pre-existing untracked `.progress/` requires explicit review before hiding it.

## TUI and operations

`/subagents` lists only current-session owned runs. Visible controls are ↑/↓ selection, Enter focus, `x` graceful stop with retained artifacts/worktree, `r` refresh, and Escape close. Focus and stop run only after the overlay is disposed. Use model-facing `subagent_status` for detailed output and broader observational scopes; use explicit `subagent_send`, `subagent_interrupt`, and `subagent_stop` inputs for actions not exposed in the operator dashboard.

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
npm run test:e2e      # deterministic no-model subprocess matrix
npm run pack:inspect  # one exact pack/install/Pi-load pass
npm run skill:check   # local pinned skills-ref validation
```

Full release qualification runs typecheck, core tests, docs, deterministic E2E, exact archive qualification, and skill validation once each:

```sh
npm run check:full
```

No ordinary or full gate starts a real model. `scripts/e2e-herdr-smoke.mjs` remains opt-in and dry-runs unless `--confirm-model` is explicitly supplied.
