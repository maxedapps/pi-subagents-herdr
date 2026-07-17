# Migration to the lean tool and artifact contract

This private package intentionally breaks its 0.1 model-facing API. There are no compatibility aliases.

## Before upgrading

1. Inventory live/retained children and dirty worktrees under the currently owning session/package.
2. Finish, stop, or deliberately retain each run; preserve handoffs and integration evidence.
3. Back up custom profiles and namespaced settings.
4. Disable other packages that register the same canonical `subagent_*` lifecycle tools. Tool load order is not an ownership protocol.
5. Upgrade/reload this package and run `/subagents-doctor`.

Never edit journals or `run.json` to transfer ownership. Old/global resources remain observational when current authority cannot be proven.

## Tool migration

Removed model-facing names:

- every `herdr_subagent_*` name;
- separate `subagent_list`, `subagent_get`, and `subagent_wait` tools;
- compatibility alias settings.

Use exactly:

- `subagent_start`
- `subagent_status`
- `subagent_send`
- `subagent_interrupt`
- `subagent_stop`

Status replacements:

```text
# old list
subagent_status({ scope: "current_session" })

# old get
subagent_status({ id: "<id>", lines: 160 })

# old wait followed by get
subagent_status({ id: "<id>", states: ["done", "idle", "blocked"], timeoutMs: 900000, lines: 160 })
```

`scope` is list-only. `timeoutMs` requires `id` plus explicit `states`. Invalid mixed modes fail instead of guessing.

## Skill migration

The bundled runtime skill is now `skills/use-herdr-subagents/SKILL.md` with command `/skill:use-herdr-subagents`. It is contributed dynamically in parent mode only and can coexist with separately installed subagent strategy skills. Package installation does not modify global skill files.

Child mode contributes neither `use-herdr-subagents` nor recursive orchestration tools.

## Result delivery migration

Runs write schema-v4 `run.json` only (generation/bridge summaries and durable captures under `.subagents/runs/<id>/results/`). Older schema versions are not readable for control recovery. The previous in-memory “must call `subagent_status`” reminder loop is removed: starts/sends stay asynchronous, and completed Pi generations are injected automatically into the active owning parent branch as `herdr-subagents.result.v1` custom messages.

Same-run `subagent_send` requires the child to be `blocked`/`done`/`idle` with the prior generation captured or closed. There is no terminal/legacy result invent path and no final-output handoff substitute for missing child writer content.

Rollback requires resolving or retaining v4 runs and preserving `results/` files; never edit metadata to fake delivery stages. Automatic result capture applies only to Pi children with a working result bridge.

## Profile migration

Remove `skills` and `preferredSkills`; child Pi now uses normal skill discovery and these legacy fields produce a migration error. Remove `artifacts.prompt` and `artifacts.system`; they are invalid. Remove progress from read-only scout/research profiles unless it is intentionally needed. Progress remains optional evidence even when configured.

Recommended artifacts:

```yaml
artifacts:
  handoff: .subagents/runs/{id}/handoff.md
  writer: parent
```

Writer profile:

```yaml
artifacts:
  handoff: .subagents/runs/{id}/handoff.md
  progress: .subagents/runs/{id}/progress.md
  writer: child
```

Mutation-capable writers still require isolated worktrees. The required parent wrapper/handoff remains the only artifact prerequisite for safe removal; configured progress stays optional.

## Settings migration

Delete:

- `artifacts.retention`
- `artifacts.maxAgeDays`
- the entire `compatibilityAliases` object

Unknown old keys now fail validation. There is no age-based garbage collection or historical cleanup command.

## Artifact migration

Existing `.subagents/` content is retained. New runs keep parent-checkout `.subagents/runs/<id>/run.json` and a durable handoff. Live metadata temporarily includes the full assignment and bounded output for reload; final metadata removes the assignment after the single proven-stop handoff. No persistent prompt/system files or `<id>-preflight` directories are created.

Internal temporary system/Pi-session files remain only while live or uncertain and are removed after proven stop plus handoff materialization and exact run-bound layout revalidation. Child writers preserve their child file and use a deterministic parent wrapper as the required artifact. For safe writer removal, required wrapper/handoff and present optional progress are copied to parent-owned `captured/` storage and verified first.

Do not delete old prompt/system/preflight files automatically during migration: they may belong to live, uncertain, orphaned, or retained-worktree evidence. Review them manually only after proving ownership and lifecycle state outside this package.

## Rollback

Before rollback, resolve or deliberately retain all new owned runs while authority is available. Preserve run metadata, handoffs, captures, branches, and dirty worktrees. Disabling package loading does not stop live backend resources.

The package remains private and unpublished; migration does not authorize publication metadata or a license.
