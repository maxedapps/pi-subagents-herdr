import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerHerdrSubagentsExtension } from "../../src/lifecycle/extension.ts";
import type { AgentProfile } from "../../src/contracts/profile.ts";
import type { EffectiveLaunchPolicy } from "../../src/contracts/harness.ts";
import { prepareHarnessLaunch } from "../../src/harnesses/index.ts";
import { createFakeCliFixture } from "../support/fake-cli.ts";


test("PI_HERDR_SUBAGENT code guard omits parent tools, events, commands, and UI registrations", () => {
  const registrations: string[] = [];
  const pi = {
    on(name: string) { registrations.push(`event:${name}`); },
    registerTool(tool: { name: string }) { registrations.push(`tool:${tool.name}`); },
    registerCommand(name: string) { registrations.push(`command:${name}`); },
  } as unknown as ExtensionAPI;
  const result = registerHerdrSubagentsExtension(pi, { environment: { PI_HERDR_SUBAGENT: "1" } });
  assert.deepEqual(result, { mode: "child", registeredEvents: [], registeredTools: [] });
  assert.deepEqual(registrations, []);
});

test("Pi child uses normal resource discovery without package parent resources or orchestration tools", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "p6-child-resources-")));
  const cwd = join(root, "checkout"); const sessions = join(root, "sessions"); const system = join(root, "system.md");
  await mkdir(cwd, { mode: 0o700 }); await mkdir(sessions, { mode: 0o700 }); await writeFile(system, "boundary", { mode: 0o600 }); await chmod(system, 0o600);
  const cli = await createFakeCliFixture();
  try {
    const profile: AgentProfile = { name: "scout", description: "Scout", body: "Inspect only.", harness: "pi", permissions: "read-only", tools: ["read"], source: { path: "/profile.md", scope: "bundled", namespace: "shared", priority: 0 } };
    const policy: EffectiveLaunchPolicy = { harness: "pi", allowedModels: [], thinking: "low", cwd, trustedRoots: [cwd], tools: [{ name: "read", capabilities: ["read"] }], permissions: { mutation: false, network: false }, requireWorktree: false, broadeningReasons: [] };
    const prepared = await prepareHarnessLaunch({ policy, profile, executable: cli.executable, sessionId: "550e8400-e29b-41d4-a716-446655440000", sessionName: "run-child", sessionDirectory: sessions, systemPromptPath: system, metadata: { runId: "run-child", runNonce: "nonce-child", profileName: "scout", parentSessionId: "parent" } });
    assert.equal(prepared.launch.env.PI_HERDR_SUBAGENT, "1");
    assert.equal(prepared.launch.env.PI_SUBAGENT_CHILD, "1");
    assert.equal(prepared.launch.env.HERDR_SUBAGENT_NO_RECURSION, "1");
    for (const removed of ["--approve", "--no-approve", "--no-skills", "--skill", "--no-prompt-templates"]) {
      assert.equal(prepared.launch.argv.includes(removed), false);
    }
    assert.doesNotMatch(prepared.launch.argv.join(" "), /use-herdr-subagents\/SKILL\.md|subagent_start/);
  } finally { await cli.cleanup(); await rm(root, { recursive: true, force: true }); }
});
