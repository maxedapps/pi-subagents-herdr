import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import type { SlashCommandInfo } from "@earendil-works/pi-coding-agent";
import type { AgentProfile } from "../../src/contracts/profile.ts";
import { resolveProfileSkills } from "../../src/profiles/skills.ts";

async function putSkill(path: string, name: string): Promise<string> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `---\nname: ${name}\ndescription: ${name} fixture\n---\n\nUse only this reviewed fixture.\n`, "utf8");
  return realpath(path);
}

function command(name: string, path: string, scope: "user" | "project" | "temporary", origin: "package" | "top-level"): SlashCommandInfo {
  return { name: `skill:${name}`, description: `${name} fixture`, source: "skill", sourceInfo: { path, source: origin === "package" ? "npm:fixture" : "local", scope, origin, baseDir: dirname(path) } };
}

function profile(skills: readonly string[], preferredSkills: readonly string[] = []): AgentProfile {
  return {
    name: "skill-profile", description: "skill fixture", body: "Use reviewed skills.", harness: "pi", permissions: "read-only",
    skills, preferredSkills,
    source: { path: "/profiles/skill-profile.md", scope: "bundled", namespace: "shared", priority: 0 },
  };
}

test("required and preferred skills resolve from actual packed, user, and trusted-project Pi resources to canonical explicit paths", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-herdr-skills-"));
  try {
    const packed = await putSkill(join(root, "packed", "skills", "packed-skill", "SKILL.md"), "packed-skill");
    const user = await putSkill(join(root, "agent", "skills", "user-skill", "SKILL.md"), "user-skill");
    const project = await putSkill(join(root, "project", ".pi", "skills", "project-skill", "SKILL.md"), "project-skill");
    const resolved = await resolveProfileSkills(
      profile(["packed-skill", "user-skill"], ["project-skill", "missing-preference"]),
      "pi",
      {
        cwd: join(root, "project"), agentDir: join(root, "agent"), projectTrusted: true,
        commands: [command("packed-skill", packed, "user", "package"), command("user-skill", user, "user", "top-level"), command("project-skill", project, "project", "top-level")],
      },
    );
    assert.deepEqual(resolved.names, ["packed-skill", "user-skill", "project-skill"]);
    assert.deepEqual(resolved.paths, [packed, user, project]);
    assert.deepEqual(resolved.resources.map((item) => item.required), [true, true, false]);
    assert.equal(resolved.diagnostics.some((item) => item.code === "profile-preferred-skill-unavailable" && item.message.includes("missing-preference")), true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("missing required skills block and untrusted project resources are suppressed before launch", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-herdr-skills-trust-"));
  try {
    const project = await putSkill(join(root, "project", ".agents", "skills", "project-only", "SKILL.md"), "project-only");
    const projectCommand = command("project-only", project, "project", "top-level");
    await assert.rejects(
      resolveProfileSkills(profile(["project-only"]), "pi", { cwd: join(root, "project"), agentDir: join(root, "agent"), projectTrusted: false, commands: [projectCommand] }),
      /Required Pi profile skill is unavailable.*project-only/,
    );
    const preferred = await resolveProfileSkills(profile([], ["project-only"]), "pi", { cwd: join(root, "project"), agentDir: join(root, "agent"), projectTrusted: false, commands: [projectCommand] });
    assert.deepEqual(preferred.paths, []);
    assert.equal(preferred.diagnostics.some((item) => item.message.includes("project-only")), true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("profile skills are rejected for unsupported harnesses and parent orchestration skills remain child-ineligible", async () => {
  const options = { cwd: "/tmp", agentDir: "/tmp", projectTrusted: true, commands: [] } as const;
  await assert.rejects(resolveProfileSkills(profile([], ["web-research"]), "claude", options), /does not support Pi profile skills/);
  await assert.rejects(resolveProfileSkills(profile(["use-subagents"]), "pi", options), /parent-only orchestration/);
});
