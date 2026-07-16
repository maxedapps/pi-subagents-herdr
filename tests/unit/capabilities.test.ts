import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import {
  HARNESS_CAPABILITIES,
  revalidateLaunchFilesystemBoundary,
  resolveHarnessCapabilities,
  resolveMonotonicOverrides,
} from "../../src/policy/capabilities.ts";
import type { LaunchPolicy, OverrideResolutionContext, ToolGrant } from "../../src/contracts/harness.ts";

const fixture = mkdtempSync(join(tmpdir(), "herdr-capabilities-"));
const root = join(fixture, "fixture-workspace");
const outside = join(fixture, "outside");
const additional = join(fixture, "confirmed-workspace");
mkdirSync(join(root, "src"), { recursive: true });
mkdirSync(outside);
mkdirSync(join(additional, "src"), { recursive: true });
after(() => rmSync(fixture, { recursive: true, force: true }));
const read: ToolGrant = { name: "read", capabilities: ["read"] };
const edit: ToolGrant = { name: "edit", capabilities: ["read", "mutation"] };
const fetchTool: ToolGrant = { name: "fetch", capabilities: ["network"] };

function baseline(): LaunchPolicy {
  return {
    harness: "pi",
    model: "model-a",
    allowedModels: ["model-a", "model-b"],
    thinking: "high",
    cwd: root,
    trustedRoots: [root],
    tools: [read, edit, fetchTool],
    permissions: { mutation: true, network: true },
    requireWorktree: false,
  };
}

function context(overrides: Partial<OverrideResolutionContext> = {}): OverrideResolutionContext {
  return {
    toolCatalog: { read, edit, fetch: fetchTool, shell: { name: "shell", capabilities: ["mutation"] } },
    trustedBroadeningEnabled: false,
    humanConfirmed: false,
    ...overrides,
  };
}

test("capability matrix does not claim Pi or Claude tool policy is a filesystem sandbox", () => {
  assert.equal(HARNESS_CAPABILITIES.pi.filesystemBoundary, "tool-policy");
  assert.equal(HARNESS_CAPABILITIES.claude.filesystemBoundary, "tool-policy");
  assert.equal(HARNESS_CAPABILITIES.codex.filesystemBoundary, "os-sandbox");
});

test("Claude native-session capability is resolved by integration policy", () => {
  assert.equal(HARNESS_CAPABILITIES.claude.nativeSessionIdentity, "integrated-policy-only");
  assert.equal(resolveHarnessCapabilities("claude", "integrated").nativeSessionIdentity, true);
  assert.equal(resolveHarnessCapabilities("claude", "safe-mode").nativeSessionIdentity, false);
  assert.throws(() => resolveHarnessCapabilities("pi", "safe-mode"), /not a supported integration policy/);
});

test("capability resolver accepts monotonic narrowing", () => {
  const result = resolveMonotonicOverrides(
    baseline(),
    {
      model: "model-b",
      thinking: "low",
      cwd: join(root, "src"),
      tools: ["read"],
      permissions: { mutation: false, network: false },
      requireWorktree: true,
    },
    context(),
  );
  assert.equal(result.accepted, true);
  if (!result.accepted) return;
  assert.deepEqual(result.policy.tools.map((tool) => tool.name), ["read"]);
  assert.equal(result.policy.thinking, "low");
  assert.equal(result.policy.requireWorktree, true);
  assert.deepEqual(result.policy.broadeningReasons, []);
});

test("capability resolver rejects broadening without both trusted setting and human confirmation", () => {
  const restricted: LaunchPolicy = {
    ...baseline(),
    thinking: "low",
    tools: [read],
    permissions: { mutation: false, network: false },
    requireWorktree: true,
  };
  const broad = { thinking: "high" as const, tools: ["read", "shell"], permissions: { mutation: true }, requireWorktree: false };
  for (const gate of [
    context(),
    context({ trustedBroadeningEnabled: true }),
    context({ humanConfirmed: true }),
  ]) {
    const result = resolveMonotonicOverrides(restricted, broad, gate);
    assert.equal(result.accepted, false);
    if (!result.accepted) assert.match(result.reasons.join("\n"), /trusted namespaced setting.*human confirmation/);
  }

  const accepted = resolveMonotonicOverrides(
    restricted,
    broad,
    context({ trustedBroadeningEnabled: true, humanConfirmed: true }),
  );
  assert.equal(accepted.accepted, true);
  if (accepted.accepted) assert.equal(accepted.policy.broadeningReasons.length >= 3, true);
});

test("capability resolver rejects unknown tools and cwd outside trusted roots", () => {
  const unknown = resolveMonotonicOverrides(baseline(), { tools: ["made-up"] }, context());
  assert.equal(unknown.accepted, false);
  if (!unknown.accepted) assert.match(unknown.reasons.join("\n"), /Unknown tool/);

  const escaped = resolveMonotonicOverrides(baseline(), { cwd: outside }, context());
  assert.equal(escaped.accepted, false);
  if (!escaped.accepted) assert.match(escaped.reasons.join("\n"), /outside configured trusted roots/);
});

test("capability resolver requires gated confirmation for an additional root", () => {
  const denied = resolveMonotonicOverrides(
    baseline(),
    { cwd: join(additional, "src") },
    context({ confirmedAdditionalRoots: [additional] }),
  );
  assert.equal(denied.accepted, false);

  const accepted = resolveMonotonicOverrides(
    baseline(),
    { cwd: join(additional, "src") },
    context({ confirmedAdditionalRoots: [additional], trustedBroadeningEnabled: true, humanConfirmed: true }),
  );
  assert.equal(accepted.accepted, true);
  if (accepted.accepted) assert.equal(accepted.policy.trustedRoots.includes(realpathSync.native(additional)), true);
});

test("capability resolver rejects symlink escapes and invalid directories", () => {
  const escapeLink = join(root, "escape-link");
  symlinkSync(outside, escapeLink, "dir");

  const escaped = resolveMonotonicOverrides(baseline(), { cwd: escapeLink }, context());
  assert.equal(escaped.accepted, false);
  if (!escaped.accepted) assert.match(escaped.reasons.join("\n"), /outside configured trusted roots/);

  const missing = resolveMonotonicOverrides(baseline(), { cwd: join(root, "missing") }, context());
  assert.equal(missing.accepted, false);
  if (!missing.accepted) assert.match(missing.reasons.join("\n"), /must be an existing directory/);
});

test("launch boundary revalidates canonical cwd immediately before launch", () => {
  const mutableRoot = join(fixture, "mutable-root");
  const cwd = join(mutableRoot, "cwd");
  mkdirSync(cwd, { recursive: true });
  const policy = baseline();
  const resolved = resolveMonotonicOverrides(
    { ...policy, cwd, trustedRoots: [mutableRoot] },
    {},
    context(),
  );
  assert.equal(resolved.accepted, true);
  if (!resolved.accepted) return;
  assert.equal(revalidateLaunchFilesystemBoundary(resolved.policy).valid, true);

  renameSync(cwd, `${cwd}-original`);
  symlinkSync(outside, cwd, "dir");
  const revalidated = revalidateLaunchFilesystemBoundary(resolved.policy);
  assert.equal(revalidated.valid, false);
  if (!revalidated.valid) assert.match(revalidated.reasons.join("\n"), /changed after policy resolution/);
});
