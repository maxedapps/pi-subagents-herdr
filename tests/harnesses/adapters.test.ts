import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { EffectiveLaunchPolicy, Harness, ThinkingLevel, ToolGrant } from "../../src/contracts/harness.ts";
import type { AgentProfile } from "../../src/contracts/profile.ts";
import {
  ADAPTER_CAPABILITIES,
  HarnessConfigurationError,
  prepareHarnessLaunch,
  type LaunchContext,
  type PreparedHarnessLaunch,
} from "../../src/harnesses/index.ts";
import { createFakeCliFixture } from "../support/fake-cli.ts";

const ENV_KEYS = [
  "HERDR_SUBAGENT", "HERDR_SUBAGENT_NO_RECURSION", "HERDR_SUBAGENT_RUN_ID", "HERDR_SUBAGENT_RUN_NONCE",
  "HERDR_SUBAGENT_PROFILE", "HERDR_SUBAGENT_PARENT_SESSION_ID", "PI_SUBAGENT_CHILD", "PI_HERDR_SUBAGENT",
  "PI_HERDR_SUBAGENT_RUN_ID", "CLAUDE_HERDR_SUBAGENT", "CLAUDE_CODE_SAFE_MODE", "CODEX_HERDR_SUBAGENT",
  "CODEX_HERDR_DISABLE_NATIVE_SUBAGENTS",
] as const;

interface Fixture {
  readonly root: string;
  readonly cwd: string;
  readonly sessions: string;
  readonly system: string;
  cleanup(): Promise<void>;
}

async function fixture(): Promise<Fixture> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "p5-adapter-")));
  const cwd = join(root, "checkout");
  const sessions = join(root, "sessions");
  await mkdir(cwd, { mode: 0o700 });
  await mkdir(sessions, { mode: 0o700 });
  const system = join(root, "system.md");
  await writeFile(system, "immutable child boundary", { mode: 0o600 });
  await chmod(system, 0o600);
  return { root, cwd, sessions, system, cleanup: () => rm(root, { recursive: true, force: true }) };
}

function tool(name: string, capabilities: ToolGrant["capabilities"]): ToolGrant { return { name, capabilities }; }

function context(input: {
  harness: Harness;
  fixture: Fixture;
  executable: string;
  thinking?: ThinkingLevel;
  tools?: readonly ToolGrant[];
  mutation?: boolean;
  network?: boolean;
  integrationPolicy?: "integrated" | "safe-mode";
  writableRoots?: readonly string[];
  model?: string;
  profileSkills?: readonly string[];
  profilePreferredSkills?: readonly string[];
  reviewedSkillPaths?: readonly string[];
}): LaunchContext {
  const profile: AgentProfile = {
    name: "test-profile", description: "test", body: "Do only the bounded task.", harness: input.harness,
    permissions: input.mutation ? "write" : "read-only",
    ...(input.profileSkills === undefined ? {} : { skills: input.profileSkills }),
    ...(input.profilePreferredSkills === undefined ? {} : { preferredSkills: input.profilePreferredSkills }),
    source: { path: "/fixture/profile.md", scope: "bundled", namespace: "shared", priority: 0 },
  };
  const policy: EffectiveLaunchPolicy = {
    harness: input.harness,
    ...(input.model === undefined ? {} : { model: input.model }),
    allowedModels: input.model === undefined ? [] : [input.model],
    thinking: input.thinking ?? "low",
    cwd: input.fixture.cwd,
    trustedRoots: [input.fixture.cwd],
    tools: input.tools ?? [],
    permissions: { mutation: input.mutation ?? false, network: input.network ?? false },
    requireWorktree: input.mutation ?? false,
    broadeningReasons: [],
  };
  return {
    policy, profile, executable: input.executable,
    sessionId: "550e8400-e29b-41d4-a716-446655440000",
    sessionName: "run-test",
    ...(input.harness === "pi" ? { sessionDirectory: input.fixture.sessions } : {}),
    systemPromptPath: input.fixture.system,
    ...(input.reviewedSkillPaths === undefined ? {} : { reviewedSkillPaths: input.reviewedSkillPaths }),
    ...(input.integrationPolicy === undefined ? {} : { integrationPolicy: input.integrationPolicy }),
    ...(input.writableRoots === undefined ? {} : { writableRoots: input.writableRoots }),
    metadata: { runId: "run-test", runNonce: "nonce-test", profileName: "test-profile", parentSessionId: "parent-session" },
  };
}

async function executeFake(prepared: PreparedHarnessLaunch) {
  const processResult = await new Promise<number>((resolve, reject) => {
    const child = spawn(prepared.launch.argv[0]!, prepared.launch.argv.slice(1), {
      cwd: prepared.launch.cwd,
      env: { ...process.env, ...prepared.launch.env },
      stdio: ["pipe", "ignore", "pipe"],
    });
    child.once("error", reject); child.once("close", (code) => resolve(code ?? 1)); child.stdin.end();
  });
  assert.equal(processResult, 0);
}

test("Pi adapter builds exact prompt-free argv/env and fake CLI observes child guards", async () => {
  const fx = await fixture(); const cli = await createFakeCliFixture(ENV_KEYS);
  try {
    const prepared = await prepareHarnessLaunch(context({
      harness: "pi", fixture: fx, executable: cli.executable,
      tools: [tool("read", ["read"]), tool("grep", ["read"])], thinking: "medium",
      model: "anthropic/sonnet",
    }));
    assert.deepEqual(prepared.launch.argv, [
      cli.executable, "--session-id", "550e8400-e29b-41d4-a716-446655440000",
      "--session-dir", fx.sessions, "--name", "run-test", "--thinking", "medium",
      "--append-system-prompt", fx.system, "--no-skills", "--no-prompt-templates", "--no-approve",
      "--model", "anthropic/sonnet", "--tools", "read,grep", "--no-context-files",
    ]);
    assert.equal(prepared.launch.argv.includes("TOP SECRET TASK"), false);
    assert.equal(prepared.launch.env.PI_SUBAGENT_CHILD, "1");
    assert.equal(prepared.launch.env.PI_HERDR_SUBAGENT, "1");
    await executeFake(prepared);
    const capture = await cli.readCapture();
    assert.deepEqual(capture.argv, prepared.launch.argv.slice(1));
    assert.equal(capture.cwd, fx.cwd);
    assert.equal(capture.env.HERDR_SUBAGENT_NO_RECURSION, "1");
    assert.equal(capture.env.PI_SUBAGENT_CHILD, "1");
  } finally { await cli.cleanup(); await fx.cleanup(); }
});

test("Claude integrated and safe policies have exact tools/permission/customization boundaries", async () => {
  const fx = await fixture(); const cli = await createFakeCliFixture(ENV_KEYS);
  try {
    const readOnly = await prepareHarnessLaunch(context({
      harness: "claude", fixture: fx, executable: cli.executable,
      tools: [tool("read", ["read"]), tool("grep", ["read"])], thinking: "low",
    }));
    assert.deepEqual(readOnly.launch.argv, [
      cli.executable, "--session-id", "550e8400-e29b-41d4-a716-446655440000", "--name", "run-test",
      "--tools", "Read,Grep", "--disallowedTools", "Agent,Task", "--permission-mode", "plan",
      "--effort", "low", "--append-system-prompt-file", fx.system, "--strict-mcp-config", "--mcp-config", "{\"mcpServers\":{}}",
      "--disable-slash-commands", "--agents", "{}", "--no-chrome",
    ]);
    const mcpIndex = readOnly.launch.argv.indexOf("--mcp-config");
    assert.deepEqual(JSON.parse(readOnly.launch.argv[mcpIndex + 1]!), { mcpServers: {} }, "strict config must be schema-valid and load no external MCP servers across Claude CLI versions");
    const safeWriter = await prepareHarnessLaunch(context({
      harness: "claude", fixture: fx, executable: cli.executable,
      tools: [tool("Read", ["read"]), tool("Bash", ["mutation", "network"]), tool("Edit", ["mutation"])],
      mutation: true, network: true, thinking: "high", integrationPolicy: "safe-mode",
    }));
    assert.equal(safeWriter.launch.argv.includes("acceptEdits"), true);
    assert.equal(safeWriter.launch.argv.at(-1), "--safe-mode");
    assert.equal(safeWriter.launch.env.CLAUDE_CODE_SAFE_MODE, "1");
    assert.equal(ADAPTER_CAPABILITIES.claude.filesystemConfinement, "none");
    await executeFake(safeWriter);
    assert.equal((await cli.readCapture()).env.CLAUDE_HERDR_SUBAGENT, "1");
  } finally { await cli.cleanup(); await fx.cleanup(); }
});

test("Codex adapter emits exact sandbox/approval/effort roots and disables native subagents", async () => {
  const fx = await fixture(); const extra = join(fx.cwd, "generated"); await mkdir(extra, { mode: 0o700 });
  const cli = await createFakeCliFixture(ENV_KEYS);
  try {
    const readOnly = await prepareHarnessLaunch(context({ harness: "codex", fixture: fx, executable: cli.executable, thinking: "low" }));
    assert.deepEqual(readOnly.launch.argv, [
      cli.executable, "--strict-config", "--sandbox", "read-only", "--ask-for-approval", "never", "--cd", fx.cwd,
      "--disable", "multi_agent", "--disable", "multi_agent_v2", "-c", "model_reasoning_effort=\"low\"",
      "-c", `model_instructions_file=${JSON.stringify(fx.system)}`, "-c", "sandbox_workspace_write.writable_roots=[]",
      "-c", "sandbox_workspace_write.network_access=false", "-c", "web_search=\"disabled\"",
    ]);
    const writer = await prepareHarnessLaunch(context({
      harness: "codex", fixture: fx, executable: cli.executable, thinking: "high", mutation: true, network: true,
      writableRoots: [extra], model: "gpt-5.4",
    }));
    assert.equal(writer.launch.argv.includes("workspace-write"), true);
    assert.equal(writer.launch.argv.includes("on-request"), true);
    assert.deepEqual(writer.launch.argv.slice(-5), ["--search", "--model", "gpt-5.4", "--add-dir", extra]);
    assert.equal(writer.launch.env.CODEX_HERDR_DISABLE_NATIVE_SUBAGENTS, "1");
    await executeFake(writer);
  } finally { await cli.cleanup(); await fx.cleanup(); }
});

test("adapters reject contradictions, unsupported mappings, dangerous values, and cross-harness fallback before launch", async () => {
  const fx = await fixture(); const cli = await createFakeCliFixture();
  try {
    await assert.rejects(
      prepareHarnessLaunch(context({ harness: "claude", fixture: fx, executable: cli.executable, tools: [tool("Bash", ["mutation"])], network: true })),
      /read-only policy contradicts/,
    );
    await assert.rejects(
      prepareHarnessLaunch(context({ harness: "claude", fixture: fx, executable: cli.executable, tools: [tool("ls", ["read"])] })),
      /no reviewed tool mapping/,
    );
    await assert.rejects(
      prepareHarnessLaunch(context({ harness: "codex", fixture: fx, executable: cli.executable, tools: [tool("read", ["read"])] })),
      /no equivalent explicit tool allowlist/,
    );
    await assert.rejects(
      prepareHarnessLaunch(context({ harness: "pi", fixture: fx, executable: cli.executable, tools: [tool("subagent_start", ["read"])] })),
      /Recursive orchestration tool is prohibited/,
    );
    await assert.rejects(
      prepareHarnessLaunch(context({ harness: "claude", fixture: fx, executable: cli.executable, thinking: "minimal" })),
      /cannot safely map thinking/,
    );
    await assert.rejects(
      prepareHarnessLaunch(context({ harness: "codex", fixture: fx, executable: cli.executable, model: "--dangerously-bypass-approvals-and-sandbox" })),
      HarnessConfigurationError,
    );
    await assert.rejects(
      prepareHarnessLaunch(context({ harness: "claude", fixture: fx, executable: cli.executable, profilePreferredSkills: ["web-research"] })),
      /skills\/preferredSkills are not loaded/,
    );
    await assert.rejects(
      prepareHarnessLaunch(context({ harness: "codex", fixture: fx, executable: cli.executable, profilePreferredSkills: ["web-research"] })),
      /skills\/preferredSkills are not loaded/,
    );
    const mismatch = context({ harness: "pi", fixture: fx, executable: cli.executable });
    await assert.rejects(prepareHarnessLaunch({ ...mismatch, profile: { ...mismatch.profile, harness: "claude" } }), /No cross-harness fallback/);
  } finally { await cli.cleanup(); await fx.cleanup(); }
});

test("executable and private cwd/prompt/session validation completes before any resource API exists", async () => {
  const fx = await fixture();
  try {
    await assert.rejects(prepareHarnessLaunch(context({ harness: "pi", fixture: fx, executable: join(fx.root, "missing") })), /not found/);
    await chmod(fx.system, 0o644);
    const cli = await createFakeCliFixture();
    try {
      await assert.rejects(prepareHarnessLaunch(context({ harness: "pi", fixture: fx, executable: cli.executable })), /must not be group\/world accessible/);
    } finally { await cli.cleanup(); }
  } finally { await fx.cleanup(); }
});
