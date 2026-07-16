import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  ProfileDiscoveryError,
  discoverProfiles,
} from "../../src/profiles/discovery.ts";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "pi-herdr-profiles-"));
  const bundledDirectory = join(root, "bundle", "agents");
  const agentDir = join(root, "user");
  const projectConfigRoot = join(root, "project", ".pi");
  return {
    root,
    bundledDirectory,
    agentDir,
    projectConfigRoot,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

function profile(name: string, description: string, extra = "", body = "Observed body."): string {
  return `---\nname: ${name}\ndescription: ${description}\n${extra}---\n${body}\n`;
}

async function put(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, "utf8");
}

test("profile discovery is recursive and applies exact bundled < user shared < user namespaced < project shared < project namespaced precedence", async () => {
  const fx = await fixture();
  try {
    const paths = [
      join(fx.bundledDirectory, "nested", "one.md"),
      join(fx.agentDir, "agents", "deeper", "two.md"),
      join(fx.agentDir, "herdr-subagents", "agents", "three.md"),
      join(fx.projectConfigRoot, "agents", "four.md"),
      join(fx.projectConfigRoot, "herdr-subagents", "agents", "nested", "five.md"),
    ];
    for (const [index, path] of paths.entries()) {
      await put(path, profile("same-name", `priority-${index}`, index === 0 ? "model: weak-model\ntools: [read, grep]\n" : "tools: [read]\n"));
    }
    await put(join(fx.agentDir, "agents", "recursive", "other.md"), profile("other", "recursive"));
    const result = await discoverProfiles({ ...fx, projectTrusted: true });
    const winner = result.profiles.find((candidate) => candidate.name === "same-name");
    assert.equal(winner?.description, "priority-4");
    assert.equal(winner?.source.path, await realpath(paths[4]!));
    assert.deepEqual(winner?.tools, ["read"]);
    assert.equal(winner?.model, undefined, "whole-profile replacement must not inherit weak fields");
    assert.equal(result.shadows.length, 4);
    assert.equal(result.profiles.some((candidate) => candidate.name === "other"), true);
    assert.equal(result.diagnostics.filter((item) => item.code === "profile-shadowed").length, 4);
  } finally {
    await fx.cleanup();
  }
});

test("shared project profile overrides namespaced user profile", async () => {
  const fx = await fixture();
  try {
    await put(join(fx.bundledDirectory, "base.md"), profile("priority-check", "bundle"));
    await put(join(fx.agentDir, "herdr-subagents", "agents", "user.md"), profile("priority-check", "namespaced-user"));
    await put(join(fx.projectConfigRoot, "agents", "project.md"), profile("priority-check", "shared-project"));
    const result = await discoverProfiles({ ...fx, projectTrusted: true });
    assert.equal(result.profiles[0]?.description, "shared-project");
  } finally {
    await fx.cleanup();
  }
});

test("untrusted project profiles are never read and trusted malformed profiles fail", async () => {
  const fx = await fixture();
  try {
    await put(join(fx.bundledDirectory, "base.md"), profile("safe", "safe"));
    const malformed = join(fx.projectConfigRoot, "agents", "malformed.md");
    await put(malformed, "---\nname: [broken\n---\nbody");
    const untrusted = await discoverProfiles({ ...fx, projectTrusted: false });
    assert.deepEqual(untrusted.profiles.map((item) => item.name), ["safe"]);
    assert.equal(untrusted.diagnostics.some((item) => item.code === "project-profiles-untrusted"), true);
    await assert.rejects(discoverProfiles({ ...fx, projectTrusted: true }), ProfileDiscoveryError);
  } finally {
    await fx.cleanup();
  }
});

test("same-priority runtime-name collisions hard-error with every source path", async () => {
  const fx = await fixture();
  try {
    const first = join(fx.agentDir, "agents", "a", "first.md");
    const second = join(fx.agentDir, "agents", "b", "second.md");
    await put(first, profile("duplicate", "first"));
    await put(second, profile("duplicate", "second"));
    await assert.rejects(
      discoverProfiles({ ...fx, projectTrusted: false }),
      (error: unknown) => error instanceof ProfileDiscoveryError
        && error.message.includes(first)
        && error.message.includes(second)
        && /Same-priority duplicate/.test(error.message),
    );
  } finally {
    await fx.cleanup();
  }
});

test("a stronger disabled profile intentionally hides weaker definitions", async () => {
  const fx = await fixture();
  try {
    await put(join(fx.bundledDirectory, "enabled.md"), profile("hidden", "weak"));
    const disabled = join(fx.projectConfigRoot, "agents", "disabled.md");
    await put(disabled, profile("hidden", "disabled", "disabled: true\n"));
    const result = await discoverProfiles({ ...fx, projectTrusted: true });
    assert.equal(result.profiles.some((item) => item.name === "hidden"), false);
    assert.equal(result.winners.find((item) => item.name === "hidden")?.source.path, await realpath(disabled));
    assert.equal(result.shadows[0]?.disabledByWinner, true);
    assert.equal(result.diagnostics.some((item) => item.code === "profile-disabled-shadow"), true);
  } finally {
    await fx.cleanup();
  }
});

test("configured directories share namespaced priority and cannot gain filesystem-order precedence", async () => {
  const fx = await fixture();
  try {
    const first = join(fx.root, "extra-a", "one.md");
    const second = join(fx.root, "extra-b", "two.md");
    await put(first, profile("configured-duplicate", "one"));
    await put(second, profile("configured-duplicate", "two"));
    await assert.rejects(discoverProfiles({
      ...fx,
      projectTrusted: false,
      additionalUserDirectories: [dirname(first), dirname(second)],
    }), /Same-priority duplicate/);
  } finally {
    await fx.cleanup();
  }
});
