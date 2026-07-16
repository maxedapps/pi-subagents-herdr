import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { PACKAGE_ASSETS } from "../../src/package-paths.ts";
import { parseProfile } from "../../src/profiles/parser.ts";
import { ProfileValidationError } from "../../src/profiles/schema.ts";
import type { ProfileSource } from "../../src/contracts/profile.ts";

function source(path = "/profiles/test.md"): ProfileSource {
  return { path, scope: "user", namespace: "shared", priority: 1 };
}

function document(frontmatter: string, body = "Do the bounded task."): string {
  return `---\n${frontmatter}\n---\n${body}\n`;
}

test("profile schema accepts every documented optional field", () => {
  const parsed = parseProfile(document(`name: complete-profile
description: Complete strict profile
harness: codex
model: configured-model
thinking: xhigh
permissions: write
tools: [read, edit]
preferredTools: [web_search]
skills: [code-review]
preferredSkills: [web-research]
context: { project: true, parent: false }
timeout: 60000
worktree: required-for-concurrency
disabled: false
artifacts:
  progress: .progress/{id}.md
  handoff: .subagents/{id}.handoff.md
  writer: child`), source());
  assert.equal(parsed.name, "complete-profile");
  assert.equal(parsed.harness, "codex");
  assert.deepEqual(parsed.preferredTools, ["web_search"]);
  assert.equal(parsed.artifacts?.writer, "child");
});

test("profile schema rejects malformed YAML, duplicate YAML keys, unknown fields, invalid names, missing requirements, and empty bodies", () => {
  const invalid = [
    document("name: [broken\ndescription: broken"),
    document("name: duplicate\nname: duplicate\ndescription: duplicate"),
    document("name: unknown\ndescription: unknown\nsurprise: true"),
    document("name: Not_Lowercase\ndescription: invalid"),
    document("name: missing-description"),
    document("name: empty-body\ndescription: empty", "   \n"),
    document("name: bad-tools\ndescription: bad\ntools: read"),
    document("name: bad-artifacts\ndescription: bad\nartifacts: { writer: child, escape: true }"),
    document("name: old-prompt\ndescription: bad\nartifacts: { prompt: .subagents/{id}.prompt.md }"),
    document("name: old-system\ndescription: bad\nartifacts: { system: .subagents/{id}.system.md }"),
    document("name: static-artifact\ndescription: bad\nartifacts: { handoff: .subagents/handoff.md }"),
  ];
  for (const [index, text] of invalid.entries()) {
    assert.throws(() => parseProfile(text, source(`/profiles/${index}.md`)), ProfileValidationError);
  }
});

test("profile schema rejects artifact templates that normalize away run scoping", () => {
  const unsafeTemplates = [
    ".subagents/{id}/../handoff.md",
    ".subagents/./{id}.handoff.md",
    ".subagents/runs/{id}/nested/../../handoff.md",
  ];
  for (const [index, template] of unsafeTemplates.entries()) {
    assert.throws(
      () => parseProfile(document(`name: unsafe-${index}\ndescription: unsafe artifact template\nartifacts:\n  handoff: ${template}`), source()),
      (error: unknown) => error instanceof ProfileValidationError
        && /must not contain '\.' or '\.\.' path components/.test(error.message),
    );
  }
});

test("legacy Herdr opt-out and runtime fields receive migration-oriented errors", () => {
  for (const field of ["herdr: false", "herdr: true", "runtime: hidden", "command: pi", "argv: []"]) {
    assert.throws(
      () => parseProfile(document(`name: migration\ndescription: migration\n${field}`), source()),
      (error: unknown) => error instanceof ProfileValidationError
        && /implicit|mandatory|unsupported runtime field/.test(error.message),
    );
  }
});

test("bundled scout, researcher, and worker are strict, model-free, non-recursive profiles with explicit output contracts", async () => {
  const expected = ["scout", "researcher", "worker"] as const;
  for (const name of expected) {
    const path = join(PACKAGE_ASSETS.agents, `${name}.md`);
    const text = await readFile(path, "utf8");
    const parsed = parseProfile(text, { path, scope: "bundled", namespace: "shared", priority: 0 });
    assert.equal(parsed.name, name);
    assert.equal(parsed.model, undefined);
    assert.equal(/^herdr\s*:/m.test(text), false);
    assert.match(parsed.body, /handoff/i);
    assert.match(parsed.body, /not delegate recursively|do not delegate recursively/i);
  }
  const scoutText = await readFile(join(PACKAGE_ASSETS.agents, "scout.md"), "utf8");
  const researcherText = await readFile(join(PACKAGE_ASSETS.agents, "researcher.md"), "utf8");
  const workerText = await readFile(join(PACKAGE_ASSETS.agents, "worker.md"), "utf8");
  assert.doesNotMatch(scoutText, /\n\s*progress:/);
  assert.doesNotMatch(researcherText, /\n\s*progress:/);
  assert.match(workerText, /\n\s*progress:/);
  const researcher = parseProfile(researcherText, source(join(PACKAGE_ASSETS.agents, "researcher.md")));
  assert.deepEqual(researcher.preferredTools, ["web_search", "fetch_content", "get_search_content"]);
  assert.deepEqual(researcher.preferredSkills, ["web-research"]);
  assert.deepEqual(researcher.tools, ["read", "grep", "find", "ls"]);
  assert.match(researcher.body, /memory.*not|never.*memory/is);
});
