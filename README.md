# Pi Herdr Subagents

Visible, persistent Pi subagents for [Herdr](https://herdr.dev).

This Pi package lets the parent agent delegate focused work to additional Pi sessions. Each subagent appears in its own Herdr pane, uses a fixed safety profile, and returns a structured result to the parent automatically. Read-only agents can investigate in parallel, while a worker makes changes only in an isolated Herdr worktree.

## What it provides

- Visible subagents running in dedicated Herdr panes
- Background execution by default
- Read-only `scout` and `researcher` profiles
- One isolated implementation `worker`
- Automatic structured result delivery
- Follow-up messages in the same child session
- A compact current-session status widget
- Durable Markdown artifacts for recovery after compaction
- Conservative cleanup that never discards uncommitted worker changes

## Requirements

- Node.js 22.19.0 or newer
- [Pi](https://github.com/earendil-works/pi-mono)
- [Herdr](https://herdr.dev)
- A persisted parent Pi session

Pi must be launched through Herdr so that `HERDR_SOCKET_PATH` and `HERDR_WORKSPACE_ID` are available. Do not start the parent with `--no-session`; durable ownership requires a persisted session.

Outside Herdr, the package deactivates safely. Pi still starts, no subagent tools or skill are registered, and UI-capable modes show a short informational notice.

## Installation

Install the package globally for your Pi user:

```bash
pi install npm:@maxedapps/pi-subagents-herdr
```

To try it for one Pi run without installing it permanently:

```bash
pi -e npm:@maxedapps/pi-subagents-herdr
```

Run that Pi process through Herdr to enable the package.

Update or remove it with:

```bash
pi update --extension npm:@maxedapps/pi-subagents-herdr
pi remove npm:@maxedapps/pi-subagents-herdr
```

## Quick start

Start Pi through Herdr and ask it to delegate a bounded task:

```text
Use a scout subagent to inspect how authentication is implemented and report the important files and risks.
```

Pi starts the child in a visible Herdr pane and continues monitoring it in the background. The `Subagents` widget shows the run while it is active. When the child finishes, its structured result is delivered automatically to the parent conversation.

Other examples:

```text
Use a researcher subagent to compare the current official documentation for these two APIs.
```

```text
Use a worker subagent to implement the validated input-handling fix and run the relevant tests.
```

You can also ask Pi to wait for the result when the current turn must block:

```text
Start a scout for this investigation and wait for its result.
```

A wait timeout does not stop the child. The run continues in the background and can still deliver its result later.

## Profiles

| Profile | Best for | Available capabilities | Writes |
|---|---|---|---|
| `scout` | Repository inspection and codebase questions | Read, grep, find, list | No |
| `researcher` | Repository inspection plus web research | Read-only repository and web tools | No |
| `worker` | One bounded implementation task | Read, shell, edit, write | Isolated worktree only |

Multiple reader profiles may run concurrently. At most one worker may be active at a time.

Profiles are intentionally fixed. Their models, thinking levels, tools, child working directories, and cleanup policy are not configurable.

## Available tools

Pi normally selects these tools for you based on your request.

| Tool | Purpose |
|---|---|
| `subagent_start` | Start one `scout`, `researcher`, or `worker` run |
| `subagent_status` | Inspect current-session runs and retained resources |
| `subagent_send` | Send one follow-up after the previous result was delivered |
| `subagent_stop` | Stop a run or retry retained cleanup |

Starts and follow-ups run in the background unless `wait: true` is requested. Blocking waits accept a timeout of up to five minutes.

Run IDs belong to the current parent session and extension instance. They cannot be reused from another session or after a reload.

## Results and follow-ups

Completed results come from the child’s persisted Pi session, not from terminal output. Background results are delivered once to the parent and trigger a parent turn. With `wait: true`, the result is returned directly instead and is not injected a second time.

A follow-up reuses the same child session, but it must be sent after the previous result arrives and before automatic cleanup becomes eligible. If the run has already been cleaned up, start a new subagent instead.

Use `subagent_status` when you need the full run ID, generation, result, artifact path, child session, worktree, branch, error, or retained-resource details.

## Status widget

While the current session owns visible runs, Pi shows a compact `Subagents` widget above the editor. It displays:

- Profile
- Short run ID
- Generation number
- Current phase
- Separate active and retained counts

A red `retained` phase means cleanup needs manual attention. Use `subagent_status` for the exact reason and paths.

## Recovery artifacts

Every run has one extension-managed Markdown artifact:

```text
<agentDir>/herdr-subagent-artifacts/<parentSessionId>/<runId>.md
```

The artifact records the exact parent requests, full textual child responses, and concise worktree and cleanup facts. Follow-ups are stored as later generations in the same file.

Artifacts survive child-session and worktree cleanup. After conversation compaction, Pi receives a recovery catalog containing the available artifact paths. Read the referenced artifact before relying on delegation details that may have been compacted away.

Do not create or edit these files manually; they are owned by the extension.

## Worker worktrees and cleanup

Workers never edit the parent checkout directly. Each worker receives an isolated Herdr worktree and generated branch.

The extension does not merge, cherry-pick, or otherwise integrate worker changes. Review the reported worktree and branch, then integrate the work yourself when appropriate.

During cleanup:

- Reader panes, tabs, and child-session storage are removed when safe.
- A clean worker worktree is removed without force.
- Generated worker branches are retained.
- Dirty or uncheckable worktrees are retained untouched.
- Child-session storage is kept until the result is safely archived and the child is stopped.

When cleanup is retained, Pi reports the exact worktree, branch, workspace, reason, artifact, and retry command. Inspect or preserve the work, make the checkout clean if appropriate, then ask Pi to retry `subagent_stop` with the same run ID.

Do not use raw Git-only worktree removal for extension-owned worktrees. The extension deliberately avoids force removal and branch deletion so that uncertain or uncommitted work is not lost.

## Session behavior

Open runs are owned by the current persisted parent session. While a run is open, Pi blocks `/tree` navigation so a result cannot be delivered onto another branch.

Quitting, reloading, creating or resuming a session, and forking all trigger bounded cleanup. Reloading does not transfer live run ownership. Resources that cannot be verified safely are reported and retained instead of being modified speculatively.

Child agents cannot create further Herdr subagents, preventing recursive delegation.

## Security

Pi extensions execute with the current user’s full system permissions. Install this package only from a source you trust and use it only in trusted repositories and Herdr workspaces.

The reader profiles cannot write files or run shell commands. The worker can run commands and edit files, but only in its isolated worktree. Always review worker output before integrating it.

## Support

Report bugs and feature requests through [GitHub Issues](https://github.com/maxedapps/pi-subagents-herdr/issues).

## License

[MIT](LICENSE)
