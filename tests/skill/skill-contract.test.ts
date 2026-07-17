import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const skillPath = new URL("../../skills/use-herdr-subagents/SKILL.md", import.meta.url);
const referencePath = new URL("../../skills/use-herdr-subagents/references/prompt-and-safety.md", import.meta.url);

test("use-herdr-subagents is a distinct parent-only runtime skill with exactly five lifecycle tools", async () => {
  const [skill, reference] = await Promise.all([readFile(skillPath, "utf8"), readFile(referencePath, "utf8")]);
  assert.match(skill, /^name: use-herdr-subagents$/m);
  assert.match(skill, /parent-only/i);
  assert.match(skill, /Use other applicable subagent skills in conjunction with this skill when they are available and possible/i);
  assert.match(skill, /broader delegation strategy or decomposition.*this extension's exact lifecycle/is);
  assert.doesNotMatch(`${skill}\n${reference}`, /(?:^|[^-])\buse-subagents\b/i, "the runtime skill must not name a separate subagent skill");
  for (const name of ["subagent_start", "subagent_status", "subagent_send", "subagent_interrupt", "subagent_stop"]) {
    assert.match(skill, new RegExp(`\\b${name}\\b`));
  }
  assert.doesNotMatch(skill, /subagent_(list|get|wait)\b/);
  assert.match(skill, /required tool or ownership proof is unavailable/i);
  assert.match(skill, /Do not invent shell\/process fallbacks/i);
});

test("skill provides a compact standalone baseline and extension-specific profile guidance", async () => {
  const skill = await readFile(skillPath, "utf8");
  for (const contract of [
    /one bounded role, scope, output, and stopping condition/i,
    /materially exceeds coordination and verification cost/i,
    /Default to read-only/i,
    /Parallelize only separable work/i,
    /writer owns one isolated lane/i,
    /`scout`.*Read-only repository reconnaissance/is,
    /`researcher`.*launch blocks/is,
    /`worker`.*isolated writer worktree/is,
    /Prefer the selected profile's defaults/i,
    /Broadening can block or require interactive human confirmation/i,
  ]) assert.match(skill, contract);
  assert.doesNotMatch(skill, /independent fan-out|staged pipeline|select a runtime|non-interactive agent CLI/i);
});

test("skill teaches the mandatory start, inspect, follow-up, stop, and verification lifecycle", async () => {
  const [skill, reference] = await Promise.all([readFile(skillPath, "utf8"), readFile(referencePath, "utf8")]);
  for (const contract of [
    /completion\.pending: true.*automatic result delivery/is,
    /Results arrive automatically/i,
    /exact-ID `subagent_status`/i,
    /Same-run sends are serialized/i,
    /confirmed.*unconfirmed.*uncertain/is,
    /never resend uncertain input automatically/i,
    /interrupt.*current turn.*preserving the session/is,
    /Check `result\.stopped`.*outer tool success does not prove/is,
    /Resolve each owned run before finalizing/i,
    /Parent verification remains mandatory/i,
    /Child output, status, artifacts, exit state, and test claims are evidence, not proof/i,
  ]) assert.match(skill, contract);
  assert.match(reference, /Use `subagent_status` in exactly one mode/i);
  assert.match(reference, /scope.*list-only/i);
  assert.match(reference, /timeoutMs.*explicit `states`/i);
  assert.match(reference, /Graceful stop may return `stopped: false`/i);
});

test("skill uses concise progressive disclosure for runtime safety and cleanup", async () => {
  const [skill, reference] = await Promise.all([readFile(skillPath, "utf8"), readFile(referencePath, "utf8")]);
  assert.match(skill, /references\/prompt-and-safety\.md/);
  assert.ok(skill.split("\n").length <= 100);
  assert.ok(reference.split("\n").length <= 120);
  for (const contract of [
    /absolute checkout path.*starting files\/questions/i,
    /allowed tools\/paths.*forbidden operations/i,
    /no recursive delegation/i,
    /must not edit, format, install into, stash, restore, clean/i,
    /cleanup: "remove_if_safe"/i,
    /`parentReview` is optional audit text/i,
    /no_changes.*commit_contained.*tree_matches/is,
    /present explicit custom artifact.*verified parent capture/i,
    /compare-deletes only the exact generated branch/i,
    /Dirty discard.*human-only/i,
  ]) assert.match(reference, contract);
});
