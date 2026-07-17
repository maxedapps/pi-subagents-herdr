# Operations and troubleshooting

## Backend preflight

1. Start Pi inside the intended Herdr pane.
2. Confirm matching `HERDR_ENV`, socket, pane, tab, and workspace variables.
3. Confirm Pi 0.80.6+, Herdr 0.7.3/protocol 16, integrations, and selected Pi/Claude/Codex/Grok authentication.
4. Reload and run `/subagents-doctor`.

Useful read-only commands:

```sh
pi --version
herdr --version
herdr status
herdr integration status
npm run smoke:load
```

Herdr CLI is diagnostic, not an ownership bypass. Before releasing Grok support, verify the installed `grok --version`/`grok --help`, no-model PTY interrupt and `/exit`, Herdr `agent=grok` status/read behavior, and whether `agent_session` is present. If real behavior differs from the adapter, block release rather than weakening identity.

## Start, monitor, and act

```text
subagent_start({ profile: "scout", task: "Map src/auth; return paths and flow; do not modify files." })
subagent_status({ id: "<id>", states: ["done", "idle", "blocked"], timeoutMs: 900000, lines: 160 })
subagent_status({ id: "<id>", lines: 160 })
subagent_status({ scope: "all_owned" })
```

Results arrive automatically as separate custom messages: Pi delivers an exact structured final; Claude, Codex, and Grok deliver a bounded Herdr terminal transcript labeled with source/truncation. Collapsed result messages show the first meaningful child line; Ctrl+O expands the exact bounded parent-visible content. Exact-ID status shows `capture_pending` while a submitted generation has no durable envelope and `capture_unavailable` plus its bounded close reason when capture closes without one. A writer result can include `ACTION REQUIRED` with exact checkout/branch/base/HEAD/clean/ahead facts and the next stop/integration step. Later blockers, failures, cleanup refusals, and recovery issues use a deduplicated follow-up message and the same `run.attention` status/TUI state. Treat it as unresolved until cleanup succeeds or an explicit blocker is reported.

Blocked state is not permission to self-approve. Use one bounded same-assignment follow-up when appropriate. For send/interrupt, inspect `unconfirmed` and `uncertain`; never retry uncertain input automatically.

Placement exhaustion returns `status: "blocked"` with the exact run ID and `subagent_stop({ id })` action. New read-only tabs use exact partial cleanup; reused, ambiguous, and writer resources remain visible for ordinary stop/finalization.

## Parent verification, integration, and stop

Child output and test claims are evidence, not proof. For a writer, inspect the complete diff/status, rerun relevant checks, and integrate manually. Then call:

```text
subagent_stop({ id: "<id>", mode: "graceful" })
```

Writer cleanup defaults to `remove_if_safe`. The same call is idempotent after the child is stopped and after reload. The extension automatically derives clean `no_changes`, direct `commit_contained`, or exact current-tree evidence. For another integrated parent ref, provide the existing `commit_contained`/`tree_matches` object. `parentReview` is optional audit text.

Cleanup retains and reports an exact retry action unless all of these hold:

- current ownership or exact cleanup-only adoption is authoritative;
- child/native agent is gone and only recorded idle anchors remain;
- a result envelope or exact `failed` notice is parent-persisted; other notices never qualify;
- checkout is clean and no-change/integration is objectively proven;
- Herdr/Git repository, workspace, worktree path, branch, and child HEAD match;
- every present explicit custom artifact is copied and hash verified.

On success it removes the Herdr workspace/tabs/panes and linked worktree, compare-deletes the exact manager-generated branch at its expected HEAD, and purges transient run metadata/results. Caller-supplied or moved branches are never deleted. Force stop affects only the process; dirty discard remains human-only.

Explicit `cleanup: "retain"` remains available for exceptional intentional retention and creates action-required state.

## Dashboard

`/subagents` shows current-session runs plus stopped runs needing action. Controls are ↑/↓, Enter focus, `x` graceful stop with automatic safe finalization, `r`, and Escape. A refusal is shown as warning/action-required, never completion.

## Recovery

Children survive extension reload/shutdown.

- Current-session active-branch stopped journals resume through the same stop/finalize path.
- Schema-v3/v4 metadata is accepted for current-branch migration.
- A later parent session may reauthorize cleanup only for a schema-v5 stopped journal with exact parent/child Git, nonce, branch/path, Herdr workspace/anchors, idle/no-agent, and clean-checkout proof.
- Cross-session cleanup adoption never controls a process or delivers prior private output.
- Legacy/ambiguous/dirty/live/moved/tampered resources remain untouched and appear in one consolidated startup recovery notice.
- `/tree`-abandoned and global resources remain observational.

Do not edit journals or metadata to manufacture authority.

## Artifact lifecycle

Bundled profiles write no handoff/progress files. While unresolved, parent operational files are `run.json` and optional `results/`. The delivered result envelope (exact Pi final or bounded non-Pi transcript), or an exact persisted `failed` notice, is the durable handoff. Private prompt/session/exchange files remain only while live or capture-uncertain.

Custom profile artifacts are explicit supplemental retention. Present files inside a writer worktree are copied under parent-owned `captured/` and byte/SHA-256 verified. Missing optional files do not gate cleanup; a failed copy of a present file retains. Successful default finalization leaves no `.subagents/runs/<id>` directory; custom captures remain.

Git-local excludes protect `/.subagents/` and only explicitly requested `/.progress/`; tracked `.gitignore` is unchanged.

## Doctor diagnostics

`/subagents-doctor` is read-only. Common responses:

| Diagnostic | Response |
|---|---|
| missing/mismatched Herdr environment | restart Pi in the intended managed pane |
| incompatible protocol/integration | install a reviewed compatible version |
| profile collision/schema error | remove duplicate/unsupported fields |
| research unavailable | expose reviewed research tools or choose another task |
| action/cleanup required | inspect exact run facts, resolve blocker, retry `subagent_stop` |
| dirty/unintegrated writer | review/test/integrate; never discard automatically |
| legacy cleanup proof incomplete | retain; inspect the consolidated recovery notice |

## Exact archive activation and rollback

Run full/package gates first, pack once, record the archive SHA-256 and source commit, then install that exact archive. Reload Pi and verify `/subagents-doctor`, five tool registrations, installed package contents, and one bounded result-source smoke. Preserve the previous archive/path for rollback. Before replacing or rolling back, stop or explicitly retain every owned run; package reload never stops children.

## Validation

```sh
npm run check
npm run check:full
npm run pack:inspect
npm run conformance:herdr:no-model
npm run conformance:herdr:worktree:no-model -- --confirm-create --source-cwd <clean-repo>
```

Both conformance commands are no-model and opt-in. `conformance:herdr:no-model` creates one uniquely labeled no-focus tab, reconciles its exact placement, starts `/bin/sh` with a harmless short-lived command through `agent.start`, and closes only the returned child pane and exact idle root tab; failures print retained IDs. The worktree command creates and fully finalizes a real disposable worktree. Model-backed smoke remains separately opt-in; never use model/focus/force flags without explicit authorization.
