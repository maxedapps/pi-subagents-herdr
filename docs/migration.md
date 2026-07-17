# Migration to action-required automatic finalization

This private package intentionally changes lifecycle/artifact behavior without adding tools.

## Before upgrading

1. Inventory live/retained children, dirty worktrees, generated `herdr-subagents/*` branches, and `.subagents/runs/*`.
2. Preserve dirty/unintegrated owner work; do not edit journals or metadata to manufacture authority.
3. Back up custom profiles/settings.
4. Reload and run `/subagents-doctor`.

## Tool behavior

The five tools remain:

- `subagent_start`
- `subagent_status`
- `subagent_send`
- `subagent_interrupt`
- `subagent_stop`

Writer stop now defaults to automatic `remove_if_safe`; explicit `cleanup: "retain"` is exceptional. `subagent_stop` is idempotent for a proven already-stopped owned run, so the same call retries after integration, transient refusal, or reload. `parentReview` remains accepted as optional audit text but is not a deletion gate.

Pi results remain exact structured finals. Claude, Codex, and Grok results are bounded Herdr terminal transcripts with explicit source/truncation metadata; no CLI-specific parser is added. Results can contain `ACTION REQUIRED`; later unresolved transitions use `herdr-subagents.action-required.v1`. Status/UI expose the same attention state. Resolve it before final reporting.

## Runtime metadata and recovery

New runs write schema-v5 `run.json` with lifecycle, action state, ownership journal, and exact worktree snapshot while unresolved. Earlier metadata schemas are intentionally unsupported during early development; remove or archive old `.subagents/runs/*` state before loading this version.

Schema-v5 prior-session cleanup can be reauthorized only after exact stopped Git/Herdr/nonce/branch/path/anchor proof. This never adopts a process or prior private result.

Rollback must first resolve or intentionally retain owned runs. Disabling package loading does not stop children.

## Profile and artifact migration

Bundled profiles no longer configure `artifacts`; their self-contained final assistant response is the durable parent handoff. Remove redundant blocks like:

```yaml
artifacts:
  handoff: .subagents/runs/{id}/handoff.md
  progress: .subagents/runs/{id}/progress.md
  writer: child
```

Custom profiles may keep an explicit run-unique handoff/progress contract when intentional. Such files are supplemental: present worktree files are copied to parent-owned `captured/` and byte/SHA-256 verified; absent optional files do not gate cleanup. A capture failure retains rather than losing a present custom artifact.

Legacy `skills`, `preferredSkills`, `artifacts.prompt`, and `artifacts.system` remain invalid. Mutation-capable profiles still require isolated linked worktrees.

## Finalization and residue

After a parent-persisted result envelope or exact parent-persisted `failed` notice plus clean objective integration/no-change proof, finalization removes:

1. Herdr workspace/tabs/panes and linked worktree, non-forcibly;
2. only the exact manager-generated branch at its expected child HEAD;
3. transient `.subagents/runs/<id>` metadata/results.

Caller-supplied, moved, dirty, live, unintegrated, tampered, orphaned, and ambiguous resources remain. Verified custom `captured/` content remains intentionally. There is no age/path-only garbage collector or extra cleanup command.

## Activation and rollback

Package source tests do not activate the extension. Build one reviewed archive, record its SHA-256/source commit, install that exact file, reload Pi, and verify the installed copy plus `/subagents-doctor`. Keep the prior archive for rollback. Resolve or explicitly retain owned runs before either install or rollback because reload does not stop children.

## Settings

Delete obsolete `artifacts.retention`, `artifacts.maxAgeDays`, and `compatibilityAliases`; unknown keys fail validation. Existing writer isolation/security settings are unchanged.
