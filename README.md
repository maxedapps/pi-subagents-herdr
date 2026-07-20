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

`subagent_start` and `subagent_send` acknowledge input and monitor the child in the background by default. Startup readiness still uses bounded `agent.get` polling, but each live generation then owns one acknowledged exact-pane Herdr status subscription; steady state does not continuously poll. `idle` and `done` are only result candidates. Delivery waits for a 30-second quiet period and one exact status/session reconciliation. This is an approximation, not a Pi `agent_settled` guarantee, because Herdr’s Pi integration derives `idle` from debounced `agent_end`.

A completed generation is extracted from the child’s persistent Pi session, not terminal output, and delivered once as a provenanced `herdr-subagent-result` custom message using steer delivery with a triggered parent turn. Clean disconnects and subscription transport failures use bounded reconnect backoff. Exhausted reconnects, unsupported protocol, or identity/topology failures retain the run and never fall back to continuous polling.

With `wait:true`, the same complete structured result is returned directly and is not injected again. A wait timeout leaves the generation running in the background; it is not an implicit stop.

Use `subagent_status` for lifecycle, generation, delivery, artifact, child-session, worktree, and retained-resource facts—not to poll for completion. A follow-up may be sent only after the previous generation was delivered or returned; it reuses the same child session with a fresh branch cursor. To continue after an automatic result, send the follow-up during the result-triggered parent turn before settlement cleanup becomes eligible.

## Exact run artifacts

The extension automatically owns one Markdown artifact per run:

```text
<agentDir>/herdr-subagent-artifacts/<parentSessionId>/<runId>.md
```

It writes every exact parent start/follow-up before sending it and the full textual child response before readiness or delivery. Follow-ups become later generation sections in the same file. Artifacts contain only concise run/worktree/cleanup facts and verbatim exchanged text—not thinking, tool traffic, or full transcripts—and survive child-session and worktree cleanup.

Agents must never create or edit these files. After every successful compaction—or when a compacted session resumes—the next model context receives one hidden, transient parent-session recovery catalog, even when no runs exist. It lists one row for every valid journal run across active and historical branches plus every safe artifact-only file. Only a currently owned run with an active latest record is labeled `current`; other journal facts are `latest durable` and may not be live. Each row reports exact artifact availability/completeness or `artifact unavailable`; artifact-only status and completeness remain unknown. The catalog never copies artifact bodies, persists a message, or triggers a turn, so read the named file before relying on compacted delegation details.

Artifact paths appear in start, result, status, and stop surfaces. Every complete result keeps the full child text and names `Durable recovery artifact (read after compaction): <agentDir>/herdr-subagent-artifacts/<parentSessionId>/<runId>.md`. If result archival fails, execution is retained without delivery or child-session deletion and one action notice identifies the file. Calling the existing `subagent_stop` retries exact archival from the cached result or preserved child session, returns the result once, and then finalizes resources; later inspection does not inject it again.

## Current-session widget

In Pi’s interactive UI, the extension automatically shows a compact `Subagents` widget above the editor while the current parent session owns visible runs. A responsive rounded border uses Pi’s semantic border color (blue in the bundled themes), and each row pairs a semantic colored dot with the textual phase. Rows still contain only the profile, shortened run ID, optional generation number, and phase. The titled border plus at most five rows uses no more than seven lines, summarizing overflow as `+N more`; RPC clients retain the plain six-line text representation.

Active and retained counts are separate. A red indicator and `retained` phase warn that resources need manual attention; the run is not counted as active, and the literal phase remains visible without color. The widget hides when no rows remain and clears during session shutdown or reload. Use `subagent_status` for full IDs, errors, child-session, worktree, branch, and retained-resource details.

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
- removes child session storage only after the child is stopped and its result artifact is recorded.

Retained proven-stopped cleanup is safely retryable through the same `subagent_stop` run ID. Each retry performs a fresh status check; dirty work remains untouched, while a checkout made clean by the parent is removed non-forcibly. Automatic retention sends one concise action with the exact run, worktree, branch, workspace, reason, artifact, and retry call; explicit stop returns the same facts without another message, and shutdown never triggers a turn.

Do not use raw Git-only worktree removal. If an operator already removed the checkout externally, the extension calls `workspace.get` and closes Herdr state only when the exact journaled workspace ID, normalized checkout path, and linked-worktree flag match. Structured `workspace_not_found` means it is already finalized; every malformed, mismatched, or other error remains retained. The extension never force-removes a worktree, deletes a branch, integrates commits, or scans for unknown resources.

Herdr labels are diagnostic only: `subagent:<parentSessionShortId>:<runId>`.

## Development

```bash
npm run check
npm pack --dry-run
```

The package is private, has no runtime dependencies, and declares only Pi AI, Pi coding-agent, and TypeBox as peers.
