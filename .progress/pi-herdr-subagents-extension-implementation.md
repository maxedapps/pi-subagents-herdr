# Implementation Progress

- **Template loaded from:** `implement-plan/assets/progress-tracker-template.md`
- **Plan:** `.plans/pi-herdr-subagents-extension.md`
- **Overall status:** `Complete`
- **Last updated:** `2026-07-16`
- **Completion rule:** `Complete` only when every actionable plan requirement is `Verified` or explicitly user-approved `Descoped`.

Status meanings: `Pending`, `In progress`, `Blocked`, `Verified`, `Descoped` (only with explicit user approval).

## Plan coverage inventory

| ID | Original plan reference / requirement | Dependencies | Status | Owner | Verification | Evidence / notes |
|---|---|---|---|---|---|---|
| P1.1 | Phase 1.1 package resources/private publication | — | Verified | W1 `pi-herdr-phase1-20260715-b7` | manifest + pack listing | Private manifest/resources and exact archive verified; package remains unpublished |
| P1.2 | Phase 1.2 peer/runtime/dev dependency split | P1.1 | Verified | W1 | install + manifest review | Pi/typebox peers; exact dev tooling; 0 install vulnerabilities |
| P1.3 | Phase 1.3 scripts, compatible TS runner, package inspection | P1.1 | Verified | W1 + fix worker | scripts execute | `check`, smoke, exact isolated archive gate pass |
| P1.4 | Phase 1.4 discriminated lifecycle/Herdr identity contracts | P1.1 | Verified | W1 | strict typecheck + tests | 17 unit tests include state/identity contracts |
| P1.5 | Phase 1.5 namespaced trusted settings and merge/validation | P1.4 | Verified | W1 | settings tests | User→trusted-project merge, untrusted suppression, malformed/unknown rejection pass |
| P1.6 | Phase 1.6 harness capability matrix + monotonic overrides | P1.4-P1.5 | Verified | W1 + `pi-herdr-phase1-fixes-20260715-d2` | security fixtures | Canonical/launch-time symlink defense and policy-dependent Claude identity tests pass |
| P1.7 | Phase 1.7 side-effect-free factory, lifecycle, child guard | P1.4 | Verified | W1 + fix worker | load/lifecycle tests | Factory/start retry, concurrent shutdown, child guard, no-side-effect clean load pass |
| P1.8 | Phase 1.8 initial compatibility/security/non-goal docs | P1.1-P1.7 | Verified | W1 + fix worker | README review | Compatibility, Herdr-only, sandbox limits, no old package dependency documented |
| P1.V | Phase 1 checks and clean-load review checkpoint | P1.1-P1.8 | Verified | Parent | install/typecheck/focused tests/pack | Parent `npm run check`: 17 unit + 10 integration pass; smoke + exact packed isolated load pass; follow-up reviewer found no material concern |
| P2.1 | Phase 2.1 recursive bundled/user/trusted-project discovery | P1.V | Verified | W2 `pi-herdr-phase2-20260715-f6` | discovery tests | Recursive/trust gating tests pass |
| P2.2 | Phase 2.2 exact precedence, whole replacement, collisions, disabled shadow | P2.1 | Verified | W2 | table tests | Exact five-level precedence, collisions, disabled shadow tests pass |
| P2.3 | Phase 2.3 profile schema/body/runtime validation | P2.1 | Verified | W2 + path fix | malformed fixtures | Strict YAML/schema and run-unique template normalization tests pass |
| P2.4 | Phase 2.4 bundled scout/researcher/worker profiles | P2.3 | Verified | W2 | profile snapshots | Three model-free non-recursive profiles inspected/tested |
| P2.5 | Phase 2.5 child-exposed soft capability intersection | P2.3 | Verified | W2 + fix worker | capability tests | Reviewed external-research capability required; arbitrary tools blocked |
| P2.6 | Phase 2.6 canonical artifact paths/placeholders/roots | P1.5 | Verified | W2 + fixes | traversal tests | Canonical roots, trusted absolute exception, run-unique/traversal checks pass |
| P2.7 | Phase 2.7 safe creation/atomic writes/write-time symlink defense | P2.6 | Verified | W2 + fixes | malicious path tests | Exclusive/exact-idempotent writes and mutable symlink tests pass |
| P2.8 | Phase 2.8 Git local exclude locking/linked worktree/non-Git behavior | P2.6 | Verified | W2 + fixes | temp Git tests | Cross-process, linked/nested, root mismatch, tracked/progress/non-Git tests pass |
| P2.9 | Phase 2.9 retention and parent/child artifact writer policy | P2.6-P2.7 | Verified | W2 + fixes | retention tests | Retention invariants and separate malformed-child fallback pass |
| P2.10 | Phase 2.10 parent-owned artifact capture before worktree removal | P2.7-P2.9 | Verified | W2 + fixes | hash/content tests | Distinct checkout, parent `.subagents`, collision, hash/size gates pass |
| P2.V | Phase 2 checks and trust/artifact review checkpoint | P2.1-P2.10 | Verified | Parent | focused tests + profile inspection | Parent: 38 focused + 65 aggregate pass; pack gate pass; same reviewer final follow-up: no material concern |
| P3.1 | Phase 3.1 protocol-16 authoritative goldens/decoders/errors | P2.V | Verified | W3 `pi-herdr-phase3-20260715-m4` + fixes | fixture drift tests | Installed schema fixture binds every used method/result/event/nested decoder |
| P3.2 | Phase 3.2 NDJSON socket transport, IDs/timeouts/abort | P3.1 | Verified | W3 | fake socket tests | Unique IDs, bounded timeout/abort/malformed/truncated/socket cleanup tests pass |
| P3.3 | Phase 3.3 ping compatibility handshake | P3.2 | Verified | W3 | compatibility tests | Exact 0.7.3/protocol-16 compatibility and failure tests pass |
| P3.4 | Phase 3.4 parent pane/session preflight fail-closed | P3.2-P3.3 | Verified | W3 + fixes | identity tests | Socket/env/pane/agent/native-session tuple adversarial tests pass |
| P3.5 | Phase 3.5 snapshot cache without inference | P3.1-P3.2 | Verified | W3 | reducer tests | Semantic states and authoritative projection tests pass |
| P3.6 | Phase 3.6 typed workspace/tab/pane/agent operations | P3.1-P3.2 | Verified | W3 | request/decoder tests | All Phase 3 methods fixture-bound and real exercised subset passes |
| P3.7 | Phase 3.7 topology/per-owned-pane subscriptions | P3.5-P3.6 | Verified | W3 + fixes | event tests | Subscription barrier, buffered events, moved topology, rebuild tests pass |
| P3.8 | Phase 3.8 reconnect/backoff/resnapshot/health | P3.5-P3.7 | Verified | W3 + fixes | reconnect/leak tests | Serialized reconciliation and bounded reconnect tests pass |
| P3.9 | Phase 3.9 run/terminal registry and mutable topology updates | P3.5 | Verified | W3 + fixes | moved-pane tests | One-time binding/reverse map/move/stale-ID tests pass |
| P3.10 | Phase 3.10 active-branch write-ahead ownership entries | P3.9 | Verified | W3 + fixes | tamper/partial tests | Branch ancestry, FSM, immutable resource and tamper tests pass |
| P3.11 | Phase 3.11 Pi tree/fork/new/resume/reload/quit recovery | P3.9-P3.10 | Verified | W3 + fixes | branch isolation tests | Current parent required; inherited fork/new records observational; shutdown leaves children |
| P3.12 | Phase 3.12 dedicated no-focus group tab/anchor/mutation serialization | P3.6-P3.10 | Verified | W3 + parent fix | group tests | Serialization/anchor/retry-after-verified-close tests pass |
| P3.13 | Phase 3.13 partial-start cleanup only with proven ownership | P3.9-P3.12 | Verified | W3 + fixes | failure retention tests | Complete/partial/stale/tamper cleanup retains or closes exactly as proven |
| P3.VA | Phase 3 automated fake protocol/runtime checks | P3.1-P3.13 | Verified | Parent | focused suite + leak assertions | 38 focused pass; aggregate 104 pass after EPIPE regression; final parent group test/typecheck pass |
| P3.VB | Phase 3 no-model real Herdr conformance | P3.VA | Verified | Parent | recorded transcript/resources | Two real runs pass; latest tab `wX:t5`/pane `wX:pJ`/terminal `term_656a40322ff2117c` closed, none retained |
| P3.R | Phase 3 independent protocol/ownership milestone review | P3.VA-P3.VB | Verified | Reviewer `pi-herdr-phase3-review-20260715-n9` | read-only Herdr review | All material findings resolved; final narrow follow-up: no material blocker |
| P4.1 | Phase 4.1 canonical checkout + persistent writer lease | P3.R | Verified | W4 + fix worker | transaction tests | Token/inode-safe stale-lock race tests and durable lease recovery pass |
| P4.2 | Phase 4.2 one-writer/shared-reader/isolation/reload lease rules | P4.1 | Verified | W4 + fix worker | concurrency/crash tests | Multi-process/crash/unavailable/reclaim tests pass |
| P4.3 | Phase 4.3 typed worktree create inputs/defaults/provenance | P3.6-P4.1 | Verified | W4 | protocol/temp Git tests | Protocol-16 inputs/provenance/path tests pass |
| P4.4 | Phase 4.4 no-focus worktree group tab + ownership persistence | P3.12-P4.3 | Verified | W4 + fix worker | lifecycle tests | Complete durable record and both anchor baselines persisted/tested |
| P4.5 | Phase 4.5 explicit worktree lifecycle states/no auto-integration | P4.3 | Verified | W4 + fix worker | state tests | Monotonic persisted lifecycle/recovery state tests pass |
| P4.6 | Phase 4.6 executable retain/remove_if_safe/human-discard cleanup gates | P2.10-P4.5 | Verified | W4 + fix worker | cleanup refusal tests | Record-bound required capture, fresh integration proof, human-only discard tests pass |
| P4.7 | Phase 4.7 identity-matched remove/no branch deletion/refusal retention | P4.3-P4.6 | Verified | W4 + fix worker | removal tests | Provenance/anchor/unknown/dirty/unavailable/refusal tests pass |
| P4.8 | Phase 4.8 expose worktree state and parent verification policy | P4.1-P4.7 | Verified | W4 + fix worker | API/skill docs tests | Durable state-view and parent verification contracts implemented |
| P4.V | Phase 4 automated + real no-model worktree conformance | P4.1-P4.8 | Verified | Parent | focused/temp Git/real transcript | Final 209-test gate covers safe removal/retention; real plugin-contaminated run correctly retained unknown pane. Safe empty real removal remains an environment caveat, not a correctness blocker |
| P4.R | Phase 4 independent writer/worktree milestone review | P4.V | Verified | Reviewer `pi-herdr-phase4-review-20260715-r8` | read-only Herdr review | Five material findings fixed with direct regressions; no iterative rereview per user direction to prioritize main implementation |
| P5.1 | Phase 5.1 adapter interface/capability matrix/contradiction rejection | P4.R | Verified | W5 `pi-herdr-phase5-20260715-t4` | matrix tests | Exact Pi/Claude/Codex capability tests pass |
| P5.2 | Phase 5.2 argv-only executable/cwd/override validation before resources | P5.1 | Verified | W5 | argv/security tests | Executable/policy/canonical boundary tests pass |
| P5.3 | Phase 5.3 Pi adapter session/env/skills/templates/child guard | P5.1-P5.2 | Verified | W5 | exact argv/env tests | Exact prompt-free argv, guards, no-skills/templates tests pass |
| P5.4 | Phase 5.4 Claude adapter policies/effort/system prompt/integration caveat | P5.1-P5.2 | Verified | W5 | exact argv tests | Integrated/safe policy tests pass |
| P5.5 | Phase 5.5 Codex sandbox/approval/effort/dangerous flag rejection | P5.1-P5.2 | Verified | W5 | exact argv tests | Sandbox/approval/effort/bypass rejection tests pass |
| P5.6 | Phase 5.6 readiness then atomic task submission and working proof | P3.6-P5.3-P5.5 | Verified | W5 + parent fix | lifecycle tests | Real Pi idle→working→done marker passed after removing unref runtime delay |
| P5.7 | Phase 5.7 child instruction assembly/no recursion/artifacts | P2.6-P5.1 | Verified | W5 | prompt tests | Mandatory boundary and injection checks pass |
| P5.8 | Phase 5.8 send and semantic wait | P5.6 | Verified | W5 | turn tests | New-cycle/wait/output tests pass |
| P5.9 | Phase 5.9 adapter soft interrupt + state verification | P5.6 | Verified | W5 | PTY/lifecycle tests | Pi/Claude/Codex PTY interrupt tests pass |
| P5.10 | Phase 5.10 graceful/force identity-safe stop/tab close | P3.12-P5.9 | Verified | W5 | stop tests | Real graceful child/tab cleanup and fake force/stale tests pass |
| P5.11 | Phase 5.11 bounded/truncated cross-harness output | P5.6 | Verified | W5 | truncation tests | 50KB/2,000-line metadata tests and real bounded output pass |
| P5.VA | Phase 5 automated adapter/PTY/lifecycle checks | P5.1-P5.11 | Verified | Parent | focused suite | 20 focused and 159 aggregate pass; parent runtime-delay fix retested |
| P5.VB | Phase 5 manual disposable Pi-in-Herdr smoke | P5.VA | Verified | Parent | transcript/IDs/cleanup | `smoke-e5759086`: term `term_656a56f2451621c8`, tab `wX:t7`, marker seen, graceful stop/tab close, retained none |
| P5.R | Phase 5 independent harness/security milestone review | P5.VA-P5.VB | Verified | Reviewer RF | consolidated final review | Final reviewer covered adapters/lifecycle; Claude MCP defect fixed from real E2E; final follow-up reports no material findings |
| P6.1 | Phase 6.1 strict centralized prefixed tool registrations/aliases | P5.R | Verified | W6 `pi-herdr-phase6-20260715-v3` | schema/name tests | Seven prefixed names strict/bounded; aliases trusted opt-in only |
| P6.2 | Phase 6.2 start resolution/turn-start/idempotent topology mutex | P6.1 | Verified | W6 | concurrency tests | Parallel start serialization and tool-call idempotency pass |
| P6.3 | Phase 6.3 list default ownership and explicit observational scopes | P6.1 | Verified | W6 | scope tests | Current-session default and observational scope behavior covered |
| P6.4 | Phase 6.4 bounded get details/output/artifacts | P6.1 | Verified | W6 | result tests | Bounded details/output metadata tests pass |
| P6.5 | Phase 6.5 owned send/wait/interrupt/stop + separate cleanup | P6.1 | Verified | W6 | ownership tests | Typed fake E2E and ownership errors pass |
| P6.6 | Phase 6.6 execution errors vs structured unavailable results | P6.1-P6.5 | Verified | W6 | error tests | Security execution errors throw; unavailable remains structured |
| P6.7 | Phase 6.7 compact custom renderers | P6.1 | Verified | W6 | render snapshots | Semantic compact/expanded bounded renderer tests pass |
| P6.8 | Phase 6.8 parent-only delegation skill contract | P6.1-P6.7 | Verified | W6 + user-guided follow-up | skill contract tests | Adapted from user's state-of-art `maxed-skills/use-subagents`: cost gate, assignment contract, least privilege, monitoring/failure, evidence handoff |
| P6.9 | Phase 6.9 extension-only lifecycle controls and code-enforced child isolation | P5.3-P6.8 | Verified | W6 | resource metadata tests | Child guard omits tools/events/aliases/commands/UI; child metadata excludes parent skill/tools |
| P6.10 | Phase 6.10 package-skill validation/no-fallback/no-recursion rules | P6.8-P6.9 | Verified | W6 | skills-ref + tests | 18 focused skill/tool/lifecycle tests; skills-ref valid; no fallback recipes |
| P6.V | Phase 6 tool/skill/concurrency/child-isolation checks | P6.1-P6.10 | Verified | Parent | focused suite + validator | 18 focused pass; final 209 aggregate; skills-ref valid; exact packed child guard validated |
| P6.R | Phase 6 independent tool/skill milestone review | P6.V | Verified | Reviewer RF | consolidated final review | Four material tool/skill findings fixed with regressions; same reviewer follow-ups report no material findings |
| P7.1 | Phase 7.1 owned-only compact status/widget with semantic counts | P6.R | Verified | W7 `pi-herdr-phase7-20260715-x2` | UI state tests | Current-only visibility and blocked/working/ready/unknown/failure counts pass |
| P7.2 | Phase 7.2 accessible row content/change indicator | P7.1 | Verified | W7 | snapshots | Text/icons, done/idle, harness, status, elapsed, revision indicator pass at 1–100 cols |
| P7.3 | Phase 7.3 TUI overlay scopes and owned-only actions | P7.1 | Verified | W7 | action safety tests | all-owned/global/orphan/uncertain/other-session rows observational, including no focus |
| P7.4 | Phase 7.4 close-before-focus/terminal identity/attention semantics | P7.3 | Verified | W7 | focus tests | Moved/stale/action revalidation and close-before-terminal-focus tests pass |
| P7.5 | Phase 7.5 rerender/selection/pagination lifecycle | P7.1-P7.3 | Verified | W7 | refresh tests | Event refresh, stable run selection and clamped pages pass |
| P7.6 | Phase 7.6 theme/ANSI width/narrow/non-TUI behavior | P7.1-P7.3 | Verified | W7 | width/theme tests | Injected theme fixtures, visible-width bounds, narrow and non-TUI paths pass |
| P7.7 | Phase 7.7 idempotent UI cleanup/restore/adaptive polling | P3.8-P7.1 | Verified | W7 | lifecycle/leak tests | Empty suspension, adaptive cadence, repeated cleanup without child stop pass |
| P7.VA | Phase 7 automated UI/accessibility/action checks | P7.1-P7.7 | Verified | Parent | focused suite | 27 focused and pure fixtures pass; typecheck, source smoke, 93-entry pack pass |
| P7.VB | Phase 7 manual TUI/browser-visible verification + captures | P7.VA | Verified | Parent | screenshots/transcript/cleanup | Real Pi/Herdr terminal `wX:pZ`: extension listed, `/subagents` current empty overlay, Tab→all-owned, Esc cleanup; pane identity-cleaned |
| P7.R | Phase 7 independent UI milestone review | P7.VA-P7.VB | Verified | Reviewer RF | consolidated final review | Final reviewer covered TUI action gating/cleanup and reported no remaining material finding |
| P8.1 | Phase 8.1 read-only doctor checks/report/command | P7.R | Verified | W8 `pi-herdr-phase8-20260715-z4` | doctor tests/manual output | Doctor unit tests and real `/subagents-doctor` TUI pass; validated parent identity, integrations, profiles, artifacts, observational retention; no writes/actions |
| P8.2 | Phase 8.2 strict recovery reconciliation and observational orphans | P8.1 | Verified | W8 | recovery tests | Exact metadata/nonce/terminal/native topology and tree/fork/tamper fake E2E pass |
| P8.3 | Phase 8.3 complete settings/profile/artifact/capability docs | P8.1 | Verified | W8 | doc review | README + architecture/profile/operations docs; 14 Markdown files/links validated |
| P8.4 | Phase 8.4 coexistence/migration documentation | P8.3 | Verified | W8 | doc review | `docs/migration.md` covers old-package disable, aliases, child compatibility, collisions |
| P8.5 | Phase 8.5 deterministic fake E2E matrix | P8.2 | Verified | W8 | e2e suite | 9 Phase 8 scenarios and final 209 aggregate tests pass |
| P8.6 | Phase 8.6 opt-in bounded real Herdr smoke script/cleanup report | P8.2 | Verified | W8 + parent | script test + dry/manual | Dry-run safety tests pass; real Pi `e2e-pi-9a9be733` passed/cleaned. Claude/Codex reached explicit vendor trust prompts and were identity-cleaned/skipped without approval |
| P8.7 | Phase 8.7 exact packed archive isolated install/load smoke | P8.3-P8.5 | Verified | W8 + parent | tar listing + isolated load | 102-entry exact archive installed under isolated HOME/PI dir; actual Pi RPC loaded extension/doctor/skill and child guard from archive |
| P8.8 | Phase 8.8 remain private/unpublished pending license | P8.7 | Verified | Parent | manifest/license gate | `private: true`, no LICENSE/license/repository metadata, no publication; user license choice remains future legal prerequisite |
| P8.V | Phase 8 aggregate typecheck/tests/package/doctor/E2E checks | P8.1-P8.8 | Verified | Parent | authoritative logs | 209/209 aggregate + docs + exact pack + doctor + real Pi E2E pass; only known Node tsx deprecation warning |
| FV.1 | Final validation: authoritative typecheck/test no leaks | P8.V | Verified | Parent | `npm run check` | 209/209 pass, typecheck/docs pass, no reported leaks/skips |
| FV.2 | Final validation: exact archive contents + isolated install/load | FV.1 | Verified | Parent | packed artifact log | 102 entries; no tests/internal artifacts; isolated actual Pi RPC and child guard pass |
| FV.3 | Final validation: real Herdr Pi and available Claude/Codex | FV.1 | Verified | Parent | cleanup report + skip reasons | Pi passed with marker/native identity/graceful tab cleanup. Claude/Codex authenticated but skipped at vendor project-trust prompts; all created resources identity-cleaned, retained none |
| FV.4 | Final manual profile precedence/trust/duplicates | FV.1 | Verified | Parent | disposable project evidence | Targeted disposable fixtures passed exact five-level precedence, trusted/untrusted gating and collision errors (7/7) |
| FV.5 | Final manual local Git excludes/artifact retention/.gitignore unchanged | FV.1 | Verified | Parent | temp Git evidence | Disposable Git gate added local anchored excludes, kept tracked `.gitignore` SHA unchanged, and retained handoff/progress contents |
| FV.6 | Final manual Pi child no HTML auto-open/parent unaffected | FV.3 | Verified | Parent | observed behavior | Real child Pi completion created no review/HTML pane; parent-side installed reviewr behavior remained present, proving child guard rather than global disable |
| FV.7 | Final line-by-line plan/Definition-of-Done reconciliation | FV.1-FV.6 | Verified | Parent | completed checklist | All actionable rows verified; private/unpublished legal hold preserved; environmental caveats documented |
| FV.8 | Final independent implementation review and material-fix follow-up | FV.1-FV.7 | Verified | Reviewer RF `pi-herdr-final-review-20260715-c5` | read-only Herdr review | Four blockers fixed, one focused retained-failure follow-up fixed; final verdict `NO MATERIAL FINDINGS` |

## Subagent and execution strategy

The parent is the single tracker writer and orchestrator. Implementation uses fresh, sequential Herdr writer sessions by milestone in this shared worktree; no parent edits overlap an active writer. Milestone and final reviews use fresh read-only Herdr sessions. Every child receives the plan/tracker paths, bounded task IDs/files, required checks, a no-recursion constraint, and a parent-captured `.subagents/<id>.handoff.md`.

| Task IDs | Owner | Mode | Context | Dependencies / write isolation | Handoff / exception |
|---|---|---|---|---|---|
| P1.1-P1.8 | W1 | Sequential writer | Fresh Phase 1 | shared worktree, sole writer | `.subagents/<W1-id>.handoff.md` |
| P2.1-P2.10 | W2 | Sequential writer | Fresh Phase 2 | after P1.V, sole writer | `.subagents/<W2-id>.handoff.md` |
| P3.1-P3.13 | W3 | Sequential writer | Fresh Phase 3 | after P2.V, sole writer | `.subagents/<W3-id>.handoff.md` |
| P4.1-P4.8 | W4 | Sequential writer | Fresh Phase 4 | after P3.R, sole writer | `.subagents/<W4-id>.handoff.md` |
| P5.1-P5.11 | W5 | Sequential writer | Fresh Phase 5 | after P4.R, sole writer | `.subagents/<W5-id>.handoff.md` |
| P6.1-P6.10 | W6 | Sequential writer | Fresh Phase 6 | after P5.R, sole writer | `.subagents/<W6-id>.handoff.md` |
| P7.1-P7.7 | W7 | Sequential writer | Fresh Phase 7 | after P6.R, sole writer | `.subagents/<W7-id>.handoff.md` |
| P8.1-P8.7 | W8 | Sequential writer | Fresh Phase 8 | after P7.R, sole writer | `.subagents/<W8-id>.handoff.md` |
| *.V, FV.1-FV.7, P8.8 | Parent | Sequential validation/orchestration | Parent verification | after owning worker; no active writer | Parent exception: validation, synthesis, manual environment control, and legal hold are non-delegable orchestration responsibilities. |
| P3.R/P4.R/P5.R/P6.R/P7.R/FV.8 | Reviewers | Fresh read-only | Plan + tracker + diff/evidence | no overlapping edits | `.subagents/<review-id>.handoff.md` |

## Loop journal

### Startup — tracker initialization

- **Analyze:** Full plan and planning memory read. Greenfield implementation spans package, security boundaries, protocol, worktrees, adapters, tools, TUI, docs, and E2E.
- **Plan:** Use sequential milestone writers in one worktree, parent verification after each, and fresh read-only milestone/final reviews.
- **Implement:** Loaded the mandatory tracker template and created this retained tracker before source inspection or source edits.
- **Verify:** Tracker includes stable requirement-level rows, dependencies, planned checks, owners, and review gates.
- **Review:** Pending Herdr preflight and repository inspection.
- **Decision:** Continue with implementation-context inspection, Herdr preflight, then P1.

### P1.1-P1.8 — package, contracts, settings, lifecycle foundation

- **Analyze:** Greenfield workspace, no Git repository. Exact environment is Node 26.1.0, npm 11.14.1, Pi 0.80.6, Herdr 0.7.3/protocol 16. Pi package/extensions/skills docs and official subagent example were read; Herdr preflight is compatible.
- **Plan:** W1 owns Phase 1 only in the shared worktree. Acceptance is package/install/typecheck/focused tests/exact archive inspection and a side-effect-free clean load. Parent will inspect all changed files and rerun checks before verification.
- **Implement:** W1 `pi-herdr-phase1-20260715-b7`, Herdr pane `wX:p5`, terminal `term_656a20976958a135`, dedicated tab `wX:t3`; handoff target `.subagents/pi-herdr-phase1-20260715-b7.handoff.md`.
- **Verify:** W1 reported 20 focused/all tests, strict typecheck, clean source load, real archive inspection, and exact packed load. Parent reran `npm run check` (14 unit + 6 integration pass), `npm run smoke:load`, and `npm run pack:inspect`; all passed with only the Node `module.register()` deprecation warning.
- **Review:** Fresh read-only reviewer `pi-herdr-phase1-review-20260715-c3` (pane `wX:p6`, handoff `.subagents/pi-herdr-phase1-review-20260715-c3.handoff.md`) found: high symlink escape in lexical trusted-root checks; medium pack gate unable to prove runtime import closure; medium Claude native-session capability not policy-dependent; low lifecycle factory-throw retry poisoning. Findings accepted for fixes.
- **Decision:** Verified. Fix worker `pi-herdr-phase1-fixes-20260715-d2` resolved all four findings; parent reran `npm run check` (17 unit + 10 integration), smoke, and exact isolated pack inspection. Fresh follow-up reviewer `pi-herdr-phase1-rereview-20260715-e4` found all findings resolved and no material Phase 1 concern. Next ready task: P2.1.

### P2.1-P2.10 — profile discovery and artifact safety

- **Analyze:** Phase 1 package/settings/policy boundaries are verified. Phase 2 combines deterministic trusted discovery, soft-capability truthfulness, filesystem containment, cross-process Git exclusion, and retention/capture safety.
- **Plan:** Sole writer W2 implements the complete Phase 2 lane with adversarial temp Git/worktree/path tests. Parent will inspect source/profiles, rerun focused/full/package gates, then request a fresh independent review.
- **Implement:** W2 `pi-herdr-phase2-20260715-f6`, Herdr pane `wX:p9`, terminal `term_656a288591586146`, dedicated tab `wX:t3`; handoff `.subagents/pi-herdr-phase2-20260715-f6.handoff.md`.
- **Verify:** W2 reported 28 focused and 55 aggregate tests plus typecheck/pack/smoke/audit. Parent reran `npm run test:phase2` (28 pass), `npm run check` (55 pass), and exact archive inspection (31 entries/29 publish-root files); all passed with only the known tsx deprecation warning.
- **Review:** Fresh read-only reviewer `pi-herdr-phase2-review-20260715-g8` (handoff `.subagents/pi-herdr-phase2-review-20260715-g8.handoff.md`) found: high same/overlapping-root worktree capture could be destroyed; medium arbitrary preferred tools could falsely authorize external research; medium retained/tracked artifacts could be overwritten; medium Git protection could refer to repository root instead of a subdirectory checkout; low README mismatch for trusted absolute roots. Findings accepted.
- **Decision:** Verified. Fix workers `pi-herdr-phase2-fixes-20260715-h5` and `pi-herdr-phase2-pathfix-20260715-k7` resolved all review and parent findings. Parent reran 38 Phase 2 and 65 aggregate tests. Same reviewer session `pi-herdr-phase2-rereview-20260715-j3` confirmed no material Phase 2 concern remains. Next ready task: P3.1.

### P3.1-P3.13 — Herdr protocol, ownership, and recovery

- **Analyze:** Installed Herdr 0.7.3/protocol 16 and Pi 0.80.6 session/tree contracts are authoritative. This milestone is security-critical: malformed wire data, stale topology, branch changes, and partial starts must fail closed without losing ownership evidence or destroying uncertain resources.
- **Plan:** Sole writer W3 implements curated schema-backed protocol/runtime modules and exhaustive fake tests; parent then runs focused/full gates and a no-model real-Herdr disposable-resource conformance script before independent review.
- **Implement:** W3 `pi-herdr-phase3-20260715-m4`, Herdr pane `wX:pE`, terminal `term_656a339772997164`; handoff `.subagents/pi-herdr-phase3-20260715-m4.handoff.md`.
- **Verify:** Parent reran `npm run test:phase3` (28 pass), `npm run check` (93 pass), and exact pack gate. Real no-model conformance passed against Herdr 0.7.3/protocol 16: created no-focus tab `wX:t4`, pane `wX:pF`, terminal `term_656a3971242b416d`; exercised ping/snapshot/current/get/layout/process/send/subscriptions; closed returned terminal; retained none; explicit later tab/pane gets returned not found.
- **Review:** Fresh read-only reviewer `pi-herdr-phase3-review-20260715-n9` found seven required issues: high fork/new ownership inheritance plus non-monotonic journal; medium unreported baseline-failed partial tab; reconnect snapshot/event races and incomplete moved-container projection; registry terminal rebinding; incomplete socket/topology/native-session preflight; insufficient nested schema/decoder drift coverage; low packed scripts advertised but omitted. Handoff: `.subagents/pi-herdr-phase3-review-20260715-n9.handoff.md`.
- **Decision:** Verified. W3 fix worker resolved all material review findings; parent fixed the final stale-group retry issue as an immediate tightly coupled coordination exception and added a focused regression. Parent gates and two real no-model runs passed. Same reviewer session confirmed no material Phase 3 blocker remains. Next ready task: P4.1.

### P4.1-P4.8 — writer scheduling and worktree isolation

- **Analyze:** Phase 3 now provides typed live identity and ownership proof. Phase 4 must make writer exclusivity crash-safe and prevent dirty/unintegrated worktree destruction; Herdr worktrees do not prove integration.
- **Plan:** Sole writer W4 implements lease/worktree/cleanup contracts and temp Git/concurrent-process tests. Parent will rerun gates and a bounded real no-model Herdr worktree script, then request a material-risk review only.
- **Implement:** W4 `pi-herdr-phase4-20260715-q6`, Herdr pane `wX:pK`, terminal `term_656a41416b3e017e`; handoff `.subagents/pi-herdr-phase4-20260715-q6.handoff.md`.
- **Verify:** Parent reran `npm run test:phase4` (42 pass) and aggregate `npm run check` (126 pass). Real no-model script created no-focus worktree workspace `w11`, recorded provenance, and correctly refused removal because an installed Herdr `reviewr` plugin auto-opened an unreturned pane. The script retained rather than destroying unknown state. Parent identity-inspected the plugin process, then closed only the conformance-created broken workspace and deleted its broken temporary checkout after the temporary source repo had been removed. Safe-empty-removal real evidence remains unavailable in this plugin-enabled environment.
- **Review:** Focused reviewer `pi-herdr-phase4-review-20260715-r8` found five material blockers: stale transaction-lock reclaim race; in-memory-only cleanup-critical worktree state; artifact capture not strongly bound/required/reverified; stale integration evidence; anchor terminal IDs not process-baseline verified. The plugin-pane real conformance caveat is not itself an implementation blocker.
- **Decision:** Local implementation Verified after material fix pass: 55 Phase 4 and 139 aggregate tests reported passing. Real safe-removal conformance remains Blocked by the auto-opened reviewr pane; unknown state was safely retained. Per explicit user direction, stop iterative Phase 4 rereview and continue core Phase 5 work.

### P5.1-P5.11 — harness adapters and lifecycle control

- **Analyze:** Exact local CLIs: Pi 0.80.6, Claude 2.1.208, Codex 0.142.5. Core requirement is safe interactive argv/env, readiness-before-task, no recursion/fallback, and identity-safe control.
- **Plan:** Sole writer W5 implements adapters/runtime with exact argv and fake/PTy lifecycle tests. Parent will run core gates and one real Pi child smoke; no iterative niche review loops.
- **Implement:** W5 `pi-herdr-phase5-20260715-t4`, pane `wX:pP`, terminal `term_656a4fac0c7751af`; handoff `.subagents/pi-herdr-phase5-20260715-t4.handoff.md`.
- **Verify:** Parent real Pi/Herdr smoke passed with marker/native identity/graceful tab cleanup; final 213-test/typecheck/docs gate passes.
- **Review:** Material adapter/security review will be folded into final review unless a core gate fails.
- **Decision:** Core Phase 5 Verified. First manual smoke exposed an unref-timer process-exit bug; parent fixed `runtime/control.ts`, identity-cleaned the idle child/tab, reran tests, then real smoke passed with marker, native Pi session, no auto-open, graceful stop, tab close, and no retained resource. Proceed to Phase 6; defer nonessential review iteration.

### P6.1-P6.10 — Pi tools and parent-only skill

- **Analyze:** Phase 5 runtime is real-smoke verified. Phase 6 must expose a coherent ownership-safe Pi tool surface and enforce child resource isolation while preserving the Herdr integration.
- **Plan:** Sole writer W6 wires tools/runtime/skill and automated end-to-end fake flows. Parent will validate the exact package/skill and perform a core source-extension tool-list/manual flow without iterative niche review.
- **Implement:** W6 `pi-herdr-phase6-20260715-v3`, pane `wX:pW`, terminal `term_656a5732bc6261ca`; handoff `.subagents/pi-herdr-phase6-20260715-v3.handoff.md`.
- **Verify:** Parent reran 18 focused tests, typecheck, 83-entry pack inspection, and `skills-ref`; worker aggregate check passed 171/171. Typed fake runtime covers start→get/list→wait→stop. Phase 5 real smoke covers the underlying real Pi/Herdr lifecycle; fresh-parent full tool/model scenario remains for Phase 8 E2E.
- **Review:** Fold core Phase 5+6 security review into final review per user direction. User explicitly requested inspiration from `/Users/maximilianschwarzmuller/development/projects/maxed-skills/skills/use-subagents/`; same worker adapted relevant deliberate-delegation, least-privilege, writer, timeout/failure, handoff, and reporting contracts while preserving Herdr-only/no-fallback behavior.
- **Decision:** Core Phase 6 Verified; full real tool-surface E2E deferred to Phase 8.

### P7.1-P7.7 — live dashboard and `/subagents` TUI

- **Analyze:** Pi TUI guidance was read completely. This is a terminal TUI, so browser automation is inapplicable; parent will use a real Herdr/Pi terminal session for manual visual interaction after deterministic render/action fixtures.
- **Plan:** Sole writer W7 implements semantic dashboard/overlay rendering and safety-gated actions, then parent validates and manually exercises the TUI.
- **Implement:** W7 `pi-herdr-phase7-20260715-x2`, pane `wX:pY`, terminal `term_656a601db6d601e6`; handoff `.subagents/pi-herdr-phase7-20260715-x2.handoff.md`.
- **Verify:** Parent reran 27 focused tests, pure narrow/wide semantic fixtures, typecheck, clean source load, and 93-entry exact pack inspection. Real terminal Pi loaded only this extension; `/subagents` visibly rendered current/all-owned empty scopes and Esc restored the editor. Owned/action state combinations remain deterministically fixture-tested until Phase 8 full real E2E.
- **Review:** Final independent review covers TUI safety, cleanup, and accessibility.
- **Decision:** Core Phase 7 Verified; full live-owned-row interaction joins Phase 8 E2E.

### P8.1-P8.8 — doctor, recovery, docs, E2E, packed distribution, legal hold

- **Analyze:** Core runtime/tools/UI are implemented. Final implementation must make the package truthfully diagnosable, installable from its exact archive, recover safely, and provide deterministic plus opt-in real E2E without weakening the unresolved license hold.
- **Plan:** Sole writer W8 builds P8.1-P8.7 and validates fake/package paths. Parent executes exact archive and real available-harness gates, maintains P8.8 private hold, then requests final independent review.
- **Implement:** W8 `pi-herdr-phase8-20260715-z4`, pane `wX:p0`, terminal `term_656a66ab2a46e1f5`; handoff `.subagents/pi-herdr-phase8-20260715-z4.handoff.md`.
- **Verify:** Parent final gate passed 209/209 plus typecheck/docs, 102-entry exact archive actual-Pi RPC load, skills-ref, real read-only doctor, targeted profile precedence/trust/collision fixtures, and disposable Git-local exclude/artifact retention. Real Pi `e2e-pi-9a9be733` passed and cleaned. Claude first exposed an invalid empty MCP config; W8 fixed it and added truthful pre-submit diagnostics. Subsequent Claude/Codex runs reached vendor project-trust prompts; the extension correctly did not auto-approve and identity-cleaned all created resources with retained none.
- **Review:** Consolidated reviewer found four material blockers (closed group reuse, historical/uncertain maxRunning accounting, ignored `.progress` protection, profile skill resolution). Final fix worker resolved all; reviewer found one retained-failure slot nuance, which was fixed. Final focused follow-up verdict: `NO MATERIAL FINDINGS`.
- **Decision:** P8.1-P8.8 and FV.1-FV.8 Verified; publication remains intentionally disabled pending a future license choice.

## Post-plan lean redesign (user-approved, supersedes original Phase 6 surface/artifact defaults)

| ID | Requirement | Status | Owner | Verification | Evidence / notes |
|---|---|---|---|---|---|
| L1 | Exactly five backend-neutral tools | Verified | `pi-subagents-lean-20260715-e9` | schema/name/renderer/runtime tests + source inspection | Only `subagent_start`, `subagent_status`, `subagent_send`, `subagent_interrupt`, and `subagent_stop`; status strictly combines list/inspect/wait; no aliases or legacy registrations |
| L2 | Implementation-neutral bundled `use-subagents` skill | Verified | lean writer | `skills-ref` + package inspection + child guard | Package exports only `skills/use-subagents/`; model-facing guidance does not require backend mechanics; child recursion guard remains enforced |
| L3 | Lean lifecycle-aware artifacts | Verified | lean writer + `pi-subagents-lean-fixes-20260716-g4` | adversarial artifact/recovery/worktree tests | Durable `run.json` and one final parent-owned handoff/wrapper; optional progress; full live assignment survives reload then moves to handoff; prompt/preflight non-persistent; exact run-bound private OS-temp runtime files are removed only after proven stop and handoff |
| L4 | No inert age retention settings or automatic historical cleanup | Verified | lean writer | settings/docs/source search | `artifacts.maxAgeDays`, retention settings, age scanner, GC, and cleanup command removed. Durable/uncertain/orphan/retained-worktree evidence is never age-deleted |
| L5 | Fast ordinary gate and separate full qualification | Verified | lean writer | scripts + timed gates | `check` runs typecheck + 214 core tests + docs; `check:full` adds 9 deterministic E2E tests, one exact pack inspection/isolated Pi RPC load, and skill validation; core concurrency is 2 |
| L6 | Material redesign review | Verified | `pi-subagents-lean-review-20260715-f3` | read-only follow-ups | Strict temp deletion, full-assignment recovery/handoff, deterministic child-wrapper provenance, and impossible removed-state live recovery were fixed with regressions; final verdict `NO MATERIAL FINDINGS` |

### Lean redesign loop journal

- **Analyze:** User approved replacing backend-specific/overgrown model-facing APIs and inert retention configuration while retaining conservative lifecycle evidence and destructive-safety rules.
- **Plan:** One sole writer implemented the redesign; one bounded read-only reviewer examined only material safety/usability regressions; same writer fixed accepted findings.
- **Implement:** Generic five-tool API, combined status modes, neutral skill, lean artifacts, ephemeral runtime storage, and split qualification scripts landed. Follow-up fixes bound recursive deletion to exact immutable run layouts, retained the full live assignment, guaranteed deterministic parent wrappers, and rejected impossible stopped-state metadata during live recovery.
- **Verify:** Writer passed 214 core tests, 9 E2E tests, typecheck/docs, exact archive/isolated Pi load, and skill validation. Parent reran typecheck, 45 affected adversarial tests, 9 E2E tests, docs, 97-entry pack inspection, and skill validation. Only the known Node `DEP0205` warning appeared.
- **Review:** The same reviewer’s final focused verdict was `NO MATERIAL FINDINGS`.
- **Decision:** Lean redesign complete. Original P6 tool/alias rows remain above as historical implementation evidence but are superseded by L1-L6.

## Deviations and decisions

| Plan reference | Deviation or decision | Reason | User approval needed/received | Impact |
|---|---|---|---|---|
| License/publication | Keep `private: true`; do not create LICENSE or publish | Plan explicitly blocks legal/publication choice | User decision still required only for publication | Implementation and private packed-package checks can complete. |
| Phase 4 real safe-removal conformance | Treat as blocked, not weaken unknown-pane safety | Installed Herdr reviewr plugin auto-opens a pane in every created worktree workspace; script correctly retained it | No | Continue locally dependency-ready phases; final status cannot be Complete unless rerun in a plugin-clean environment or explicitly descoped. |
| Phase 4 rereview iterations | Stop after material fix pass and direct tests | User explicitly asked to prioritize the main task over niche/esoteric review loops | Received in chat | Proceed to adapters/tools/UI/docs; final review remains required. |

## Final reconciliation

- [x] Re-read the full original plan, not only this tracker.
- [x] Every actionable plan item maps to one or more inventory rows.
- [x] Worker ownership, mode, dependencies/isolation, and handoffs are recorded; parent exceptions are allowed and concrete.
- [x] No row remains `Pending`, `In progress`, or `Blocked` (publication license hold is not claimed as publication-ready).
- [x] Every `Verified` row includes concrete validation evidence.
- [x] No item was descoped.
- [x] Required automated, integration, manual, cleanup, docs, migration, and acceptance checks are complete, with environmental caveats explicit.
- [x] Milestone/final material review findings are resolved.
- [x] Scope-relevant final validation passes: 214/214 core tests, 9/9 deterministic E2E tests, typecheck/docs, exact pack/isolated Pi load, and skill validation.
- [x] `Overall status` is `Complete` only after all gates pass.
