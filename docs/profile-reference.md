# Profile and settings reference

## Discovery and precedence

Profiles are recursively discovered Markdown files; `README.md` and symlinks are ignored. Project roots load only after trust.

Lowest to highest precedence:

1. bundled `<package>/agents/**/*.md`
2. shared user `${getAgentDir()}/agents/**/*.md`
3. namespaced user `${getAgentDir()}/herdr-subagents/agents/**/*.md`
4. shared trusted project `<project-config-root>/agents/**/*.md`
5. namespaced trusted project `<project-config-root>/herdr-subagents/agents/**/*.md`

Configured user/project directories join the corresponding namespaced priority. Stronger profiles replace weaker profiles whole; fields do not merge. Same-priority duplicate runtime names are fatal. A stronger `disabled: true` profile hides weaker definitions.

Runtime names are lowercase kebab-case frontmatter `name` values.

## Profile format

```yaml
---
name: reviewer
description: Review one bounded change and report evidence
harness: pi
thinking: medium
permissions: read-only
tools: [read, grep, find, ls]
preferredTools: []
context:
  project: true
  parent: false
timeout: 900000
worktree: forbidden
disabled: false
artifacts:
  handoff: .subagents/runs/{id}/handoff.md
  writer: parent
---

Inspect only the assigned scope. Do not delegate. Return evidence and limitations.
```

Required: `name`, `description`, and a non-empty Markdown body.

Optional fields:

| Field | Contract |
|---|---|
| `harness` | `pi`, `claude`, `codex`; omitted uses settings default |
| `model` | safe harness model identifier; bundled profiles omit |
| `thinking` | `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max` when supported |
| `permissions` | `read-only` or `write` |
| `tools` | hard reviewed tool requests; contradictions fail |
| `preferredTools` | soft preferences intersected with child-exposed tools |
| `context.project` | permit project context where supported |
| `context.parent` | intent only; never transfers transcript or authority |
| `timeout` | integer 1–86400000 ms |
| `worktree` | `forbidden`, `optional`, `required`, `required-for-concurrency` |
| `disabled` | winning disabled profile hides weaker definitions |
| `artifacts.progress` | optional run-unique progress path |
| `artifacts.handoff` | optional run-unique handoff path; canonical default otherwise |
| `artifacts.writer` | `parent` default or mutation-only `child`; child file is preserved and a deterministic parent wrapper becomes final required evidence |

`artifacts.prompt` and `artifacts.system` do not exist. System prompt files are internal ephemeral runtime data. Unknown fields, duplicate YAML keys, invalid values, missing requirements, and empty bodies fail discovery.

## Tools, skills, and recursion guard

Pi supports explicit child tool allowlists but not filesystem confinement. Claude uses reviewed built-in mappings and native permission policy, also without filesystem confinement. Codex profiles cannot claim an explicit per-tool allowlist; its sandbox/approval policy is used instead.

Pi children receive no trust, skill, or prompt-template override flags. Each separate Pi process resolves project trust normally, then discovers global/project/package/settings skills and prompt templates as an ordinary Pi instance. Saved trust and global settings are shared through the normal user environment; transient parent `--approve` and session-only trust choices are not inherited. The package contributes `use-herdr-subagents` dynamically in parent mode only, while child guards still prohibit orchestration/delegation tools.

Legacy profile `skills` and `preferredSkills` fields are rejected with a migration error; remove them and rely on normal Pi discovery. Bundled researcher preferences count only when a preferred reviewed external-source tool is actually exposed. Otherwise launch blocks rather than presenting memory output as researched.

## Artifact templates

Supported placeholders: `{id}`, `{groupId}`, `{profile}`, `{harness}`. Every public profile artifact template must include run-unique `{id}`.

Relative templates resolve from the selected checkout and must remain under `.subagents/` or explicitly enabled `.progress/`. Absolute templates require a canonical additional root granted by trusted namespaced settings. Unknown placeholders, NULs, `.`/`..`, traversal, symlink escape, and non-unique templates fail.

`progress` is optional evidence even when configured. Required final handoff remains the only artifact prerequisite for safe worktree removal. For `writer: child`, the configured path is child-owned and its deterministic `.parent` sibling is registered from outset as that required final handoff. Parent-owned `run.json` always uses `.subagents/runs/<id>/run.json` and is not profile-customizable.

## Bundled defaults

| Name | Harness | Permission | Worktree | Durable output |
|---|---|---|---|---|
| `scout` | Pi | read-only | forbidden/shared | handoff only |
| `researcher` | Pi | read-only + soft research | forbidden/shared | handoff only |
| `worker` | Pi | write | isolated | preserved child handoff + required parent wrapper + optional configured progress |

All prohibit recursive delegation and omit models.

## Settings

Locations:

- user: `${getAgentDir()}/herdr-subagents/settings.json`
- trusted project: `<project-config-root>/herdr-subagents/settings.json`

Relative configured paths resolve against the settings file. Empty paths, NULs, duplicate grants, and filesystem roots fail. Defaults merge with user then trusted project; nested known fields merge and arrays/scalars replace.

| Key | Default | Contract |
|---|---|---|
| `concurrency.maxRunning` | `4` | 1–64 active/starting or retained-live failed runs |
| `concurrency.maxWriters` | `1` | 1–16, not above maxRunning |
| `defaultHarness` | `pi` | Pi/Claude/Codex |
| `profileDirectories.user/project` | `[]` | trusted path arrays |
| `widget.visibility` | `auto` | `auto`, `always`, `never` |
| `integrations.strictness` | `strict` | `strict` or `warn` doctor behavior |
| `security.allowedRoots` | current workspace | existing non-root roots |
| `security.allowBroadeningOverrides` | `false` | still requires interactive human confirmation |
| `security.requireWriterWorktree` | `true` | mutation isolation floor |

There are no compatibility-alias or artifact-retention settings.

Narrowing can reduce thinking/tools/permissions, choose a deeper cwd, or strengthen isolation. Broadening tools, capabilities, thinking, cwd/roots, models, or isolation requires trusted configuration and interactive confirmation before resource creation. Unknown tools, root escapes, dangerous options, recursive orchestration, and unsafe mutation remain rejected.
