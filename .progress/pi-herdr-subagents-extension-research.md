# Pi Herdr Subagents Extension — Implementation Research

- Date: 2026-07-15
- Runtime context: Node 26.1.0, npm 11.14.1, Pi 0.80.6, Herdr 0.7.3/protocol 16.
- Decision supported: Implement the plan against exact installed Pi/Herdr APIs and current Pi/Claude/Codex CLI behavior without relying on memory.

## Research questions

1. Exact Pi 0.80.6 package manifest, extension lifecycle/tool/session/UI, skill, and TUI APIs.
2. Exact Herdr protocol-16 envelopes/methods/events/worktree behavior and conformance evidence.
3. Exact installed Pi/Claude/Codex interactive argv, permission, model/thinking, interrupt, and session controls.
4. Package-relative loading and packed-artifact behavior.

## Evidence requirements

- Installed official Pi docs/source/examples for 0.80.6.
- Herdr 0.7.3 CLI/schema plus a no-model protocol conformance transcript.
- Installed CLI help/version evidence for harness adapters.
- Automated fixtures plus independent real behavior where wire/protocol behavior matters.

## Initial evidence

- `.progress/pi-herdr-subagents-extension-plan.md` records official source URLs, installed versions, confirmed contracts, and prior independent plan review.
- `.plans/pi-herdr-subagents-extension.md` requires protocol-16 golden fixtures and real no-model conformance, preventing self-consistent fake-client assumptions.
- Local Pi docs root: `/Users/maximilianschwarzmuller/.nvm/versions/node/v26.1.0/lib/node_modules/@earendil-works/pi-coding-agent/docs`.
- Local Pi examples root: `/Users/maximilianschwarzmuller/.nvm/versions/node/v26.1.0/lib/node_modules/@earendil-works/pi-coding-agent/examples`.

## Findings / decisions

### Pi 0.80.6 package and extension foundation

Primary evidence read completely:

- Installed `docs/packages.md`: package `pi` resources are package-relative; Pi core packages and `typebox` belong in `peerDependencies` with `*`; non-core runtime imports must be in `dependencies`; production package installs omit dev dependencies.
- Installed `docs/skills.md`: `--no-skills` disables discovery while repeated explicit `--skill` paths still load; package skill resources are supported; missing descriptions prevent loading.
- Installed `docs/extensions.md`: factories can register static resources but must not start long-lived sockets/timers/processes because some invocations never emit `session_start`; session resources start from `session_start` and clean up idempotently on `session_shutdown`; project config requires `CONFIG_DIR_NAME` and `ctx.isProjectTrusted()`; `appendEntry` plus active branch/session manager are persistence primitives; tools must throw for `isError`; custom output must honor 50 KB/2,000-line bounds; TUI-only APIs require `ctx.mode === "tui"`.
- Official installed `examples/extensions/subagent/{README.md,index.ts,agents.ts}` inspected for discovery/tool/rendering patterns only; its hidden subprocess model is explicitly rejected by this project.

### Herdr 0.7.3 / protocol 16

Primary evidence:

- `herdr --version` and `herdr status`: client/server 0.7.3, protocol 16, compatible.
- `herdr api schema --json`: installed schema is 223,527 bytes and declares protocol metadata plus request/result/error/event schemas. This installed artifact is the authoritative golden source for Phase 3.
- Official docs read: https://herdr.dev/docs/socket-api/, `/agents/`, `/session-state/`, `/integrations/`.

Implementation implications:

- NDJSON raw API normally uses one request per connection; subscriptions keep the acknowledged connection open. Bootstrap with `ping` and `session.snapshot`; resnapshot after reconnect and accept unknown fields.
- `pane.current` accepts `caller_pane_id`; mutable public pane IDs can change on cross-workspace moves while terminal identity remains stable.
- `pane.send_input` sends text and keys atomically. Raw read enum is `recent_unwrapped`.
- Required methods/events and worktree APIs exist in protocol 16. `worktree.remove` never deletes branches.
- Pi lifecycle integration is state/session authority; Claude/Codex integrations report native sessions while screen manifests remain state authority. `done` is unseen completion and focus can make it `idle`.
- Exact schema plus a real no-model conformance run is required; fake round trips alone are insufficient.

## Open questions

- Exact schema field subsets to curate for each implemented protocol method/event (Phase 3 worker).
- Exact current CLI flags and integration tradeoffs for installed Claude/Codex builds (Phase 5 research).
