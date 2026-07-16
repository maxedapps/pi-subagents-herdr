import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const skillPath = new URL("../../skills/use-subagents/SKILL.md", import.meta.url);
const referencePath = new URL("../../skills/use-subagents/references/prompt-and-safety.md", import.meta.url);

test("use-subagents is parent-only, implementation-neutral, and exposes exactly five lifecycle tools", async () => {
  const [skill, reference] = await Promise.all([readFile(skillPath, "utf8"), readFile(referencePath, "utf8")]);
  assert.match(skill, /^name: use-subagents$/m);
  assert.match(skill, /parent-only/i);
  for (const name of ["subagent_start", "subagent_status", "subagent_send", "subagent_interrupt", "subagent_stop"]) {
    assert.match(skill, new RegExp(`\\b${name}\\b`));
  }
  assert.doesNotMatch(`${skill}\n${reference}`, /\bHerdr\b|herdr_|command -v|child_process|spawn\(|native-and-cli-backends/i);
  assert.doesNotMatch(skill, /subagent_(list|get|wait)\b/);
  assert.match(skill, /Every successful `subagent_start` creates an outstanding result obligation/i);
  assert.match(skill, /start result is never task completion/i);
  assert.match(skill, /List mode never counts as result inspection/i);
  assert.match(skill, /Inspect every parallel run individually/i);
  assert.match(reference, /mandatory result obligation/i);
  assert.match(reference, /Call `subagent_status` for that exact ID/i);
  assert.match(skill, /required tool or ownership proof is unavailable, fail closed/i);
  assert.match(skill, /Do not invent a fallback/i);
  assert.match(skill, /ask a child to delegate/i);
});

test("skill covers deliberate delegation, fresh context, least privilege, isolation, monitoring, verification, and lifecycle resolution", async () => {
  const [skill, reference] = await Promise.all([readFile(skillPath, "utf8"), readFile(referencePath, "utf8")]);
  for (const contract of [
    /one bounded role, scope, output, and stopping condition/i,
    /fresh context or expertise, independent judgment, context isolation, or meaningful parallelism/i,
    /exceeds startup, monitoring, synthesis, parent verification, and cleanup cost/i,
    /Default to read-only and least privilege/i,
    /fresh child for a new assignment or independent judgment/i,
    /One writer owns one isolated lane/i,
    /must not mutate an active writer's checkout/i,
    /blocked`, `unknown`, timeout, or failure/i,
    /After two failures with the same cause/i,
    /Child status, claims, artifacts, exit state, or test output are evidence—not parent verification/i,
    /Resolve every owned run before finalizing/i,
  ]) assert.match(skill, contract);
  assert.match(skill, /subagent_interrupt.*cancel the current turn.*subagent_stop.*end the child lifecycle/is);
  assert.match(skill, /separate interrupt is not an ordinary prerequisite/i);
  assert.match(skill, /Optional progress is supporting evidence, never a prerequisite for safe removal/i);
  assert.match(reference, /Never fire and forget/i);
  assert.match(reference, /observed evidence.*separated from inference/i);
  assert.match(reference, /capture optional progress when present, without requiring it/i);
  assert.match(reference, /Never delete durable run metadata or handoff evidence/i);
});

test("skill uses concise progressive disclosure with complete safety routing", async () => {
  const [skill, reference] = await Promise.all([readFile(skillPath, "utf8"), readFile(referencePath, "utf8")]);
  assert.match(skill, /references\/prompt-and-safety\.md/);
  assert.ok(skill.split("\n").length <= 100);
  assert.ok(reference.split("\n").length <= 120);
  for (const contract of [
    /absolute checkout path and starting files\/questions/i,
    /permission.*forbidden operations/i,
    /evidence and validation required/i,
    /stopping condition and explicit timeout\/budget/i,
    /unconditional prohibition on recursive delegation/i,
    /must not edit, format, install into, stash, restore, clean/i,
    /Child claims, status, exit codes, and artifacts are not proof/i,
  ]) assert.match(reference, contract);
});
