# Pi Herdr Subagents

A private Pi extension for visible, persistent subagents in Herdr. It exposes exactly four strict tools, delivers structured results automatically by default, and binds every run to one persisted parent session and extension instance.

## Requirements

The parent Pi process must run inside Herdr with `HERDR_SOCKET_PATH` and `HERDR_WORKSPACE_ID`. Starting a child from an ephemeral parent is rejected because durable ownership cannot be recorded.

Children set `PI_HERDR_SUBAGENT=1`, which prevents recursive extension and skill registration.

## Fixed profiles

| Profile | Thinking | Tools | Writes |
|---|---|---|---|
| `scout` | low | `read,grep,find,ls` | no |
| `researcher` | medium | `read,grep,find,ls,web_search,fetch_content,get_search_content` | no |
| `worker` | high | `read,grep,find,ls,bash,edit,write` | isolated worktree only |

Readers may run concurrently. At most one worker may be active. Profiles, models, tools, child cwd, and cleanup policy are not configurable.

## Tools

```text
subagent_start({ profile, task, wait?: false })
subagent_start({ profile, task, wait: true, timeoutMs?: 1..300000 })
subagent_status({ id? })
subagent_send({ id, message, wait?: false })
subagent_send({ id, message, wait: true, timeoutMs?: 1..300000 })
subagent_stop({ id })
```

`profile` is `scout`, `researcher`, or `worker`. Unknown fields are rejected. `wait` defaults to `false`; `timeoutMs` is accepted only with `wait:true`.

## Results and follow-ups

`subagent_start` and `subagent_send` acknowledge input and monitor the child in the background by default. A completed generation is extracted from the child’s persistent Pi session, not terminal output, and delivered once as a provenanced `herdr-subagent-result` custom message using steer delivery with a triggered parent turn.

With `wait:true`, the same complete structured result is returned directly and is not injected again. A wait timeout leaves the generation running in the background; it is not an implicit stop.

Use `subagent_status` for lifecycle, generation, delivery, child-session, worktree, and retained-resource facts. Polling is not required for result delivery. A follow-up may be sent only after the previous generation was delivered or returned; it reuses the same child session with a fresh branch cursor. To continue after an automatic result, send the follow-up during the result-triggered parent turn before settlement cleanup becomes eligible.

## Parent ownership and lifecycle

Each meaningful transition is stored as a compact `herdr-subagent-state` custom entry on the active parent branch. These entries do not enter model context. Ownership includes the parent session ID/file/leaf, extension instance ID, PID, run and child session IDs, and exact Herdr topology.

Tools accept only runs owned by the current parent session and extension instance. While an owned run is open, parent `/tree` navigation is cancelled so results cannot move to another branch.

After every completed generation is delivered or returned, the next eligible parent `agent_settled` cleans remaining runs. Settlement does nothing while a child is working, a generation is pending, or a result is queued. Submitting a follow-up during result processing suppresses cleanup until that generation is complete.

Every parent shutdown reason—quit, reload, new, resume, or fork—aborts all monitors first and performs one bounded cleanup pass. Reload cleans rather than transfers ownership. On a later non-reload start, records from a dead prior PID are cleanup-only and require exact topology, child identity, and deterministic child storage. Live-owner, malformed, or mismatched residue is reported and left untouched; prior runs are never adopted for follow-ups or delivery.

## Cleanup policy

Reader cleanup closes the child pane, closes only its owned tab, then removes its generated child session directory.

Worker cleanup closes the child pane, runs bounded `git status --porcelain`, and:

- removes a clean Herdr worktree with `force:false`;
- retains dirty or uncheckable worktrees with their exact path;
- retains and reports every generated branch;
- removes child session storage only after the child is stopped and its result is recorded.

Partial cleanup is recorded as `retained` and is not destructively retried. The extension never force-removes a worktree, deletes a branch, integrates commits, or scans for unknown resources. Resolve reported retained resources manually after preserving any work.

Herdr labels are diagnostic only: `subagent:<parentSessionShortId>:<runId>`.

## Development

```bash
npm run check
npm pack --dry-run
```

The package is private, has no runtime dependencies, and declares only Pi AI, Pi coding-agent, and TypeBox as peers.
