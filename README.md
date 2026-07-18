# Pi Herdr Subagents

A private, minimal Pi extension for visible subagents in Herdr. It supports Pi only, stores runs only in the current extension instance, and exposes exactly five tools.

## Install and reload

Use a local path while developing so `/reload` reads this checkout:

```bash
pi remove git:git@github-mschwarzmueller:maxedapps/pi-subagents-herdr.git
pi install /absolute/path/to/pi-subagents-herdr
```

Start Pi inside Herdr and run `/reload` only when no subagent is live. The extension requires `HERDR_SOCKET_PATH` and `HERDR_WORKSPACE_ID` from the parent Herdr workspace.

The child guard `PI_HERDR_SUBAGENT=1` prevents recursive tool and skill registration.

## Fixed profiles

| Profile | Thinking | Tools | Writes |
|---|---|---|---|
| `scout` | low | `read,grep,find,ls` | no |
| `researcher` | medium | `read,grep,find,ls,web_search,fetch_content,get_search_content` | no |
| `worker` | high | `read,grep,find,ls,bash,edit,write` | isolated worktree only |

Profiles, tools, thinking, cwd, and worktree policy are not configurable.

## Tools

```text
subagent_start({ profile: "scout" | "researcher" | "worker", task: string })
subagent_status({})
subagent_status({ id: string, wait?: boolean, timeoutMs?: number })
subagent_send({ id: string, message: string })
subagent_interrupt({ id: string })
subagent_stop({ id: string })
```

Unknown fields are rejected. IDs are valid only in the extension instance that returned them.

## Operating workflow

1. Start one bounded task.
2. Pull terminal output explicitly with exact-ID `subagent_status`. `wait: true` polls until `idle`, `done`, or `blocked`.
3. Send a follow-up, interrupt with `ctrl+c`, or stop the child as needed.
4. After a send or interrupt transport error, inspect status before retrying because the mutation may already have happened.

Parent-to-child communication uses `agent.start` and `pane.send_input`. Child-to-parent communication is only the bounded `agent.get`/`agent.read` response from explicit status. There is no automatic result message, child bridge, persisted handoff, or background delivery.

## Worker behavior

Only one worker may start at a time; readers remain independent. A worker gets one Herdr worktree beside the parent Git checkout and launches in that path.

Stopping a worker closes its pane, runs `git status --porcelain`, and:

- removes a clean worktree with `force:false`, while retaining and reporting its branch;
- retains a dirty or uncheckable worktree and reports its exact path and branch.

The extension never integrates commits, force-removes a worktree, or deletes a branch.

## Intentional limitations and manual cleanup

State is in memory only. Reload, restart, fork, tree navigation, or session replacement loses ownership. Stop all runs before any of those actions. Historical IDs, panes, tabs, worktrees, branches, and old `.subagents` data are never recovered or adopted.

If ownership was lost, use Herdr and Git directly:

```bash
herdr workspace list
herdr workspace get <workspace-id>
herdr worktree list --cwd /path/to/repository --json
git worktree list
git branch --list 'herdr-subagents/*'
```

Inspect resources before closing or removing them. Never delete a dirty worktree unless its changes are intentionally preserved elsewhere.

## Activation and rollback

Before activation:

1. stop old-extension children;
2. inventory `.subagents`, Herdr workspaces/tabs/panes, sibling worktrees, and generated branches;
3. run `npm ci && npm run check && npm pack --dry-run`;
4. install this checkout as the local Pi package and reload with no live run.

Rollback is branch-based: stop rewrite runs, switch this repository to `main`, run `npm ci` to restore the baseline dependencies, and reload the local package. `main` remains the baseline implementation. No compatibility or migration layer is provided.

Do not remove ignored historical residue until a human confirms no old live resource depends on it.

## Development

```bash
npm ci
npm run check
npm pack --dry-run
```
