# Operations and troubleshooting

## Backend preflight

1. Start Pi inside the intended Herdr pane.
2. Confirm matching `HERDR_ENV`, socket, pane, tab, and workspace variables.
3. Confirm Pi 0.80.6+, Herdr 0.7.3/protocol 16, current integrations, and selected harness authentication.
4. Reload the package and run `/subagents-doctor`.

Useful read-only operator commands:

```sh
pi --version
herdr --version
herdr status
herdr integration status
npm run smoke:load
```

Herdr CLI commands are for diagnosis, not bypassing extension ownership or lifecycle controls.

## Pi child trust and resources

Pi children receive neither `--approve` nor `--no-approve`, and no skill/prompt-template suppression or explicit-skill flags. Each child process resolves project trust normally. Persisted trust and global settings/resources are available in the ordinary user environment; a transient parent `--approve` or session-only trust decision is not inherited. If a child shows the standard trust prompt, resolve it as an ordinary Pi trust decision before expecting project settings, skills, or templates to load.

The package contributes `use-herdr-subagents` only to the parent through dynamic resource discovery. Child mode still contributes no orchestration skill, tools, commands, UI, or lifecycle handlers.

## Start and monitor

```text
subagent_start({ profile: "scout", task: "Map src/auth; return paths and flow; do not modify files." })
subagent_status({ id: "<id>", states: ["done", "idle", "blocked"], timeoutMs: 900000, lines: 160 })
```

List without an ID:

```text
subagent_status({})
subagent_status({ scope: "all_owned" })
```

Inspect without waiting:

```text
subagent_status({ id: "<id>", lines: 160 })
```

A blocked result is not failure or permission to approve automatically. Inspect, decide, then send one bounded same-assignment clarification:

```text
subagent_send({ id: "<id>", message: "Limit scope to refresh-token handling; request no new permissions." })
```

Interrupt preserves the session:

```text
subagent_interrupt({ id: "<id>", timeoutMs: 15000 })
```

Mutation delivery reports one of:

- `confirmed`: Herdr acknowledged and the expected state/revision evidence appeared;
- `unconfirmed`: Herdr acknowledged, but bounded follow-up evidence did not appear;
- `uncertain`: the mutation may have applied before its response was lost or aborted.

Inspect `unconfirmed`/`uncertain` runs and their output. Never resend uncertain input, repeat interrupt automatically, or destroy the run merely to resolve ambiguity.

## Parent verification and stop

A done/idle state, handoff, or child test claim is not correctness proof. The parent reads artifacts/output, inspects every diff, checks Git state, and reruns relevant tests.

```text
subagent_stop({ id: "<id>", mode: "graceful", cleanup: "retain" })
```

Force mode only permits freshly identity-verified pane termination. It never discards worktree changes or artifacts.

`remove_if_safe` additionally requires a parent review note and objective `no_changes`, `commit_contained`, or `tree_matches` evidence. Removal still refuses unless current ownership agrees, child/unknown panes are gone, the required parent wrapper/handoff is captured and verified, checkout is clean, and exact backend/Git provenance agrees. Optional progress is captured when present but not required. Branches are never deleted.

## Operator dashboard

`/subagents` shows current-session owned runs only. Controls are ↑/↓ selection, Enter focus, `x` graceful stop with artifacts/worktree retained, `r` refresh, and Escape close. The overlay closes before focus or stop. A stop timeout/refusal is reported as not stopped with its reason, never as completion. Use `subagent_status` for detailed output or `all_owned`/`global` observation.

Interrupt cancels only the current turn and keeps the child reusable. Graceful stop ends the child and already interrupts first when necessary, so interrupt is not an ordinary prerequisite for stop. Send, interrupt, force stop, and safe worktree cleanup remain explicit model-facing tool operations rather than dashboard hotkeys.

## Recovery

Children survive reload/shutdown. Control recovers only from exact current-session active-branch journal + safe parent-checkout `run.json` + canonical run-bound private OS-temp layout + live terminal/native/topology agreement. Redirected external paths, symlinks, permissive modes, or unexpected runtime-root entries make the run observational and authorize no deletion.

- `/tree` away from the creation branch removes control; returning recovers only if all evidence still agrees.
- Fork/new sessions do not inherit ownership.
- Moved panes are followed by stable terminal identity, never stale pane ID.
- Partial starts and disconnects retain every returned identity when cleanup cannot be proven.
- Missing/tampered metadata and orphan/global panes remain observational; do not edit metadata to adopt them.

## Artifact lifecycle

Read-only default:

```text
.subagents/runs/<id>/
├── run.json
└── handoff.md
```

A profile may explicitly add `progress.md`; bundled scout/researcher do not, bundled worker does. Prompt/system profile customization is removed.

Launch validation uses an always-removed private temporary directory. Live runtime uses another canonical private OS-temp directory containing internal `system.md`; Pi also uses `sessions/`. Claude/Codex do not create unused package session directories. While live, `run.json` retains the full assignment and last bounded output; repeated waits do not create handoffs. These files remain while live/blocked/uncertain. After a proven stop, the package creates the single final handoff, removes its assignment from metadata, revalidates the exact temporary layout immediately before deletion, and atomically rewrites `run.json` without ephemeral paths.

For child writers, `handoff.md` remains child-owned while deterministic `handoff.parent.md` is the required parent-owned final wrapper containing full assignment plus validated child content (missing/invalid child content fails closed). Its path is registered before worktree creation. For safe disposable-worktree removal, that wrapper and present optional progress are copied under parent-owned `.subagents/runs/<id>/captured/` and byte/hash verified. `captured/` exists only for this removal boundary. `run.json`, handoff/captures, uncertain/live/orphan evidence, and retained-worktree evidence are not automatically deleted. There is no age-based retention or cleanup command.

## Git behavior

The selected checkout must be the real repository/worktree root. The package asks Git for `info/exclude` and append-locks:

```gitignore
/.subagents/
/.progress/
```

`/.progress/` is requested only by an enabled profile. A pre-existing untracked `.progress/` is not hidden without explicit review. Tracked `.gitignore` remains unchanged. Non-Git directories report protection as not applicable.

## Doctor interpretation

`/subagents-doctor` is read-only. It checks package/Pi/Herdr versions, protocol/parent identity, harnesses/integrations, profiles/settings, optional research capability, Git/artifacts, recovery/topology, and retained worktrees. It never writes, adopts, focuses, sends, stops, or cleans.

Common failures:

| Diagnostic | Response |
|---|---|
| missing/mismatched Herdr environment | restart Pi in the intended managed pane; do not copy identity variables |
| incompatible protocol/integration | install a reviewed compatible Herdr/integration version and restart |
| profile collision/schema error | remove same-priority duplicate or unsupported fields |
| research unavailable | expose a reviewed preferred external tool or choose a non-research assignment |
| artifact root/ignore failure | correct trusted roots/template or review Git-local excludes before retry |
| orphan/uncertain recovery | retain and inspect; no adoption exists |
| dirty/unintegrated writer | review/test/integrate and retry safe cleanup, otherwise retain |

## Validation

Fast core gate:

```sh
npm run check
```

Release qualification:

```sh
npm run check:full
```

Explicit layers are `npm run test:e2e`, `npm run pack:inspect`, and `npm run skill:check`. All are deterministic/no-model. `pack:inspect` packs exactly once and installs/loads that archive.

The real backend script remains opt-in and dry-run by default:

```sh
node scripts/e2e-herdr-smoke.mjs --harness pi
node scripts/e2e-herdr-smoke.mjs --harness pi --confirm-model --parent-session-path <session.jsonl>
```

Never use `--confirm-model`, `--exercise-focus`, or `--force-cleanup` without explicit authorization for the corresponding cost/mutation.
