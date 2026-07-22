# Pi Herdr Subagents

Visible, persistent Pi subagents for [Herdr](https://herdr.dev).

This Pi package lets a parent agent delegate bounded work to additional Pi sessions. Each child appears in its own Herdr pane, uses a Markdown profile loaded when the extension activates, and returns a structured result automatically. Profiles choose launch controls and checkout isolation; a non-worktree profile with write-capable tools can modify the shared parent checkout.

## What it provides

- Visible subagents in dedicated Herdr panes
- Background execution by default, with optional bounded waits
- Bundled `scout`, `researcher`, and `worker` Markdown profiles
- User-defined profiles and whole-file overrides
- Automatic structured results and follow-ups in the same child session
- At most one active worktree-backed run; concurrent non-worktree runs
- Durable artifacts and journal-backed cross-session recovery
- Conservative cleanup that never discards uncommitted worktree changes

## Requirements

- Node.js 22.19.0 or newer
- [Pi](https://github.com/earendil-works/pi-mono)
- [Herdr](https://herdr.dev)
- A persisted parent Pi session

Pi must be launched through Herdr so `HERDR_SOCKET_PATH` and `HERDR_WORKSPACE_ID` are available. Do not start the parent with `--no-session`; durable ownership requires a persisted session.

Outside Herdr, the package deactivates safely. Pi still starts, no subagent tools or skill are registered, and UI-capable modes show a short informational notice.

## Installation

```bash
pi install npm:@maxedapps/pi-subagents-herdr
```

For one Pi run without a permanent installation:

```bash
pi -e npm:@maxedapps/pi-subagents-herdr
```

Run Pi through Herdr to enable the package. Update or remove it with:

```bash
pi update --extension npm:@maxedapps/pi-subagents-herdr
pi remove npm:@maxedapps/pi-subagents-herdr
```

## Quick start

Ask Pi to delegate a bounded task:

```text
Use a scout subagent to inspect how authentication is implemented and report the important files and risks.
```

```text
Use a researcher subagent to compare the current official documentation for these two APIs.
```

```text
Use a worker subagent to implement the validated input-handling fix and run the relevant tests.
```

These are bundled profile names, not fixed runtime roles. Custom profiles are selected the same way. To block the current turn for a result, request a wait:

```text
Start a scout for this investigation and wait for its result.
```

A wait timeout does not stop the child; it continues in the background and may deliver later.

## Profiles

### Bundled profiles

| Name | Bundled configuration |
|---|---|
| `scout` | Repository inspection; `read`, `grep`, `find`, `ls`; `thinking: medium`; shared checkout |
| `researcher` | Repository and web research; explicit repository/web allowlist; `thinking: high`; shared checkout |
| `worker` | Bounded implementation; explicit file/shell allowlist; `thinking: high`; isolated worktree |

### Markdown format

Profiles are flat Markdown files with YAML frontmatter and a non-empty body:

```md
---
name: my-profile
description: Short model-facing description
use-worktree: false
tools:
  - read
  - grep
model: provider/model
thinking: medium
---
The Markdown body is the child system prompt.
```

Required fields and content:

- `name`: 1–64 characters of lowercase kebab-case
- `description`: non-empty, at most 256 characters
- `use-worktree`: a YAML boolean
- Body: the non-empty child system prompt

Optional fields:

- `tools`: a non-empty array of unique identifiers (letters, numbers, `_`, or `-`, starting with a letter)
- `model`: a non-empty model string such as `provider/model`
- `thinking`: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`

Unknown keys, wrong types, malformed YAML, empty prompts, and same-layer duplicate names fail activation with the offending path. Discovery is deterministic and flat: regular `*.md` files are sorted; `README.md`, directories, non-Markdown files, and symlinks are skipped.

Bundled files load first. User profiles load from:

```text
${getAgentDir()}/herdr-subagents/agents/
```

`getAgentDir()` is Pi's agent directory (normally `~/.pi/agent`, or `PI_CODING_AGENT_DIR`). A user file with the same `name` replaces the bundled profile as a whole; frontmatter and body are not merged.

Profiles load once when the active parent extension activates. After adding, changing, or removing a file, reload or restart Pi. There is no live watcher.

### Launch defaults and isolation

- Explicit profile `model`, `thinking`, and `tools` values win.
- Omitted `model` and `thinking` inherit the parent's current values at each `subagent_start`.
- Omitted `tools` gives the child Pi's normal full default tool set; it does **not** inherit the parent's active-tool subset.
- Explicit `tools` is a Pi allowlist.
- `use-worktree` controls checkout isolation only, not permissions or role inference.
- `use-worktree: false` runs in the shared parent checkout. Write-capable tools can modify it directly.
- `use-worktree: true` creates an isolated Herdr worktree and generated branch.
- At most one worktree-backed run may be active. Profile name and tool list do not affect this limit.

## Available tools

Pi normally selects these tools from your request.

| Tool | Purpose |
|---|---|
| `subagent_start` | Start one profile loaded at extension activation |
| `subagent_status` | Inspect current-session runs and retained resources |
| `subagent_send` | Send one follow-up after the previous result was delivered |
| `subagent_stop` | Stop a current-owner run, retry retained cleanup, or explicitly abort an incomplete generation |
| `subagent_recover` | List global/legacy journal-backed residue or retry exact prior-owner cleanup |

Starts and follow-ups run in the background unless `wait: true` is requested. Blocking waits accept a timeout of up to five minutes. Run IDs belong to the current parent session and extension instance; they cannot be reused after session replacement or reload.

## Results, artifacts, and follow-ups

Results come from the child's persisted Pi session, not terminal output. Background results are delivered once and trigger a parent turn. With `wait: true`, the result is returned directly without duplicate injection.

A follow-up reuses the child session, but must be sent after the previous result arrives and before automatic cleanup becomes eligible. If cleanup already ran, start a new subagent.

Every run has one extension-managed artifact:

```text
<agentDir>/herdr-subagent-artifacts/<parentSessionId>/<runId>.md
```

It records exact parent requests, full textual child responses, and concise worktree/cleanup facts. After conversation compaction, Pi receives a transient recovery catalog with available artifact paths. Read referenced artifacts before relying on compacted-away delegation details. Never create or edit extension-owned artifacts.

Ordinary `subagent_stop({ id: "<run-id>" })` is fail-safe: it recovers any raced complete result, but retains a generation with no archived final result. Irreversible discard requires:

```text
subagent_stop({ id: "<run-id>", discardIncompleteResult: true })
```

A complete raced result is still recovered first. Repeated ordinary stops never imply discard consent, and transcript discard never authorizes dirty-worktree removal.

## Worktree isolation and cleanup

Profiles with `use-worktree: true` receive an isolated Herdr worktree. Profiles with `use-worktree: false` use the shared parent checkout, where write-capable tools can edit directly.

The extension does not merge, cherry-pick, or otherwise integrate changes. Review reported work and integrate it yourself when appropriate.

During cleanup:

- Non-worktree panes, tabs, and child-session storage are removed when safe.
- A clean extension-owned worktree is removed without force.
- Generated worktree branches are retained.
- Dirty or uncheckable worktrees are retained untouched.
- Child-session storage remains until the result is archived or explicit abort evidence is durable, and the child is proven stopped.

For a dirty or uncheckable worktree, preserve the work, make the checkout safe if appropriate, then retry ordinary `subagent_stop`. For an incomplete session only, use `discardIncompleteResult: true` only when transcript loss is intended. For artifact, journal, or session-removal failures, address the named failure and retry ordinary stop.

Do not use raw pane, filesystem, or Git-only cleanup for extension-owned resources. The extension deliberately avoids force removal and branch deletion.

## Cross-session recovery

Each started run gets a private locator:

```text
<agentDir>/herdr-subagent-recovery/<parentSessionId>/<runId>.json
```

Locators find the authoritative original parent journal; they never authorize cleanup by themselves.

```text
subagent_recover({})
subagent_recover({ parentSessionId: "<parent-session-id>", id: "<run-id>" })
```

Add `discardIncompleteResult: true` only with explicit intent to lose an incomplete transcript. Live unreleased owners, dirty worktrees, malformed records, and identity mismatches are reported and left untouched.

Historical cleanup is classified from persisted worktree/topology facts, never from the current profile catalog. Removing or overriding a profile cannot reclassify owned resources. Do not edit locator, artifact, or journal files, and do not use raw pane/Git cleanup.

## Session behavior

Open runs belong to the current persisted parent session. While one is open, Pi blocks `/tree` navigation so results cannot land on another branch.

Esc/abort stops current-owner children and consents to discarding unfinished child transcripts after raced-result recovery. Dirty extension-owned worktrees and generated branches remain preserved.

`/new`, `/resume`, and `/fork` are cancellable and require confirmation while non-closed runs exist. Headless modes cancel replacement and require explicit cleanup first. Quit and reload have no confirmation hook; they perform bounded non-discarding cleanup and may leave indexed incomplete residue for later `subagent_recover`.

Startup performs bounded non-discarding reconciliation only for exact released/dead-owner residue. Unverifiable resources are reported and retained. Child agents cannot create further Herdr subagents, preventing recursion.

## Status widget

The `Subagents` widget shows each current-session run's profile, short ID, generation, phase, and active/retained state. Use `subagent_status` for exact paths, results, errors, and retained-resource details.

## Security

Pi extensions execute with the current user's full system permissions. Install this package only from a trusted source and use it only in trusted repositories and Herdr workspaces.

Capabilities come from each profile's tool configuration. Omitted `tools` enables Pi's normal full defaults. `use-worktree` controls isolation, not permissions. Review user profiles before use, and remember that non-worktree write-capable profiles can modify the shared checkout.

## Support

Report bugs and feature requests through [GitHub Issues](https://github.com/maxedapps/pi-subagents-herdr/issues).

## License

[MIT](LICENSE)
