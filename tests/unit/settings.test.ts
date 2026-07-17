import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  SettingsValidationError,
  getSettingsLocations,
  loadSettings,
} from "../../src/config/settings.ts";

async function fixture(): Promise<{
  root: string;
  agentDir: string;
  projectConfigRoot: string;
  workspaceRoot: string;
  cleanup(): Promise<void>;
}> {
  const root = await mkdtemp(join(tmpdir(), "pi-herdr-settings-"));
  return {
    root,
    agentDir: join(root, "agent"),
    projectConfigRoot: join(root, "project", ".pi"),
    workspaceRoot: join(root, "project"),
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

async function json(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(value), "utf8");
}

test("settings defaults use extension-owned locations and do not require Pi settings.json", async () => {
  const fx = await fixture();
  try {
    const result = await loadSettings({ ...fx, projectTrusted: true });
    assert.deepEqual(result.loaded, []);
    assert.equal(result.settings.defaultHarness, "pi");
    assert.deepEqual(result.settings.security.allowedRoots, [resolve(fx.workspaceRoot)]);
    assert.equal(result.locations.user, join(fx.agentDir, "herdr-subagents", "settings.json"));
    assert.equal(result.locations.project, join(fx.projectConfigRoot, "herdr-subagents", "settings.json"));
  } finally {
    await fx.cleanup();
  }
});

test("settings merge defaults then user then trusted project by field and replace arrays", async () => {
  const fx = await fixture();
  try {
    const locations = getSettingsLocations(fx.agentDir, fx.projectConfigRoot);
    await json(locations.user, {
      concurrency: { maxRunning: 8, maxWriters: 2 },
      defaultHarness: "claude",
      profileDirectories: { user: ["profiles-user"] },
      widget: { visibility: "never" },
      security: { allowedRoots: [fx.workspaceRoot], allowBroadeningOverrides: true },
    });
    assert.notEqual(locations.project, undefined);
    await json(locations.project!, {
      concurrency: { maxRunning: 3 },
      defaultHarness: "grok",
      profileDirectories: { user: ["project-replaces-user-list"], project: ["profiles-project"] },
      integrations: { strictness: "warn" },
    });

    const result = await loadSettings({ ...fx, projectTrusted: true });
    assert.deepEqual(result.loaded, ["user", "project"]);
    assert.deepEqual(result.settings.concurrency, { maxRunning: 3, maxWriters: 2 });
    assert.equal(result.settings.defaultHarness, "grok");
    assert.deepEqual(result.settings.profileDirectories.user, [
      resolve(dirname(locations.project!), "project-replaces-user-list"),
    ]);
    assert.deepEqual(result.settings.profileDirectories.project, [resolve(dirname(locations.project!), "profiles-project")]);
    assert.equal(result.settings.widget.visibility, "never");
    assert.equal(result.settings.security.allowBroadeningOverrides, true);
  } finally {
    await fx.cleanup();
  }
});

test("settings do not read an untrusted project file, even when it is malformed", async () => {
  const fx = await fixture();
  try {
    const locations = getSettingsLocations(fx.agentDir, fx.projectConfigRoot);
    assert.notEqual(locations.project, undefined);
    await mkdir(dirname(locations.project!), { recursive: true });
    await writeFile(locations.project!, "{ malformed", "utf8");
    const result = await loadSettings({ ...fx, projectTrusted: false });
    assert.deepEqual(result.loaded, []);
    assert.equal(result.diagnostics[0]?.code, "project-settings-untrusted");
  } finally {
    await fx.cleanup();
  }
});

test("settings reject unknown namespaced keys and security-relevant malformed values", async () => {
  const cases: readonly unknown[] = [
    { unrelatedPiKey: true },
    { security: { allowedRoots: ["/"] } },
    { security: { allowedRoots: [] } },
    { concurrency: { maxRunning: 0 } },
    { profileDirectories: { user: ["bad\0path"] } },
    { artifacts: { retention: "retain" } },
  ];

  for (const value of cases) {
    const fx = await fixture();
    try {
      const locations = getSettingsLocations(fx.agentDir, fx.projectConfigRoot);
      await json(locations.user, value);
      await assert.rejects(
        loadSettings({ ...fx, projectTrusted: true }),
        (error: unknown) => error instanceof SettingsValidationError || (error instanceof Error && /allowedRoots/.test(error.message)),
      );
    } finally {
      await fx.cleanup();
    }
  }
});

test("settings reject malformed JSON with source-aware diagnostics", async () => {
  const fx = await fixture();
  try {
    const locations = getSettingsLocations(fx.agentDir);
    await mkdir(dirname(locations.user), { recursive: true });
    await writeFile(locations.user, "not-json", "utf8");
    await assert.rejects(
      loadSettings({ ...fx, projectTrusted: true }),
      (error: unknown) => error instanceof SettingsValidationError && error.sourcePath === locations.user,
    );
  } finally {
    await fx.cleanup();
  }
});
