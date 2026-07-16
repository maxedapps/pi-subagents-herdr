import assert from "node:assert/strict";
import test from "node:test";
import { resolve } from "node:path";
import {
  HERDR_PROTOCOL_VERSION,
  assertSubagentRecord,
  updateMutableTopology,
  type SubagentRecord,
} from "../../src/contracts/index.ts";
import { getPackageRoot, PACKAGE_ASSETS, resolvePackagePath } from "../../src/package-paths.ts";

function record(): SubagentRecord {
  return {
    schemaVersion: 1,
    id: "run-1",
    ownership: {
      runNonce: "nonce-1",
      parentSession: { id: "parent", branchEntryId: "entry-1" },
      createdFrom: { workspaceId: "w1", tabId: "t1", paneId: "p1", terminalId: "parent-term" },
      child: { terminalId: "child-term" },
    },
    profileName: "scout",
    harness: "pi",
    lifecycle: "running",
    herdrStatus: "working",
    terminalId: "child-term",
    paneId: "p2",
    tabId: "t1",
    workspaceId: "w1",
    createdAt: 1,
    updatedAt: 1,
  };
}

test("contracts keep Herdr protocol and lifecycle states distinct", () => {
  assert.equal(HERDR_PROTOCOL_VERSION, 16);
  const current = record();
  current.lifecycle = "interrupting";
  current.herdrStatus = "blocked";
  assert.equal(current.lifecycle, "interrupting");
  assert.equal(current.herdrStatus, "blocked");
});

test("contracts preserve immutable terminal identity while topology moves", () => {
  const current = record();
  const moved = updateMutableTopology(current, { paneId: "p9", tabId: "t4", workspaceId: "w2" }, 2);
  assert.equal(moved.terminalId, "child-term");
  assert.equal(moved.ownership.child.terminalId, "child-term");
  assert.deepEqual(
    { paneId: moved.paneId, tabId: moved.tabId, workspaceId: moved.workspaceId, updatedAt: moved.updatedAt },
    { paneId: "p9", tabId: "t4", workspaceId: "w2", updatedAt: 2 },
  );
});

test("contracts reject conflicting stable identity proof", () => {
  const current = record();
  const invalid = { ...current, terminalId: "other-term" };
  assert.throws(() => assertSubagentRecord(invalid), /does not match ownership proof/);
});

test("contracts resolve assets relative to the package and block escapes", () => {
  assert.equal(PACKAGE_ASSETS.skill, resolve(getPackageRoot(), "skills/use-subagents/SKILL.md"));
  assert.equal(PACKAGE_ASSETS.agents, resolve(getPackageRoot(), "agents"));
  assert.throws(() => resolvePackagePath("..", "outside"), /escapes/);
  assert.throws(() => resolvePackagePath(resolve("/tmp")), /must be relative/);
});
