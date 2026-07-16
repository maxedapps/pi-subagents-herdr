import assert from "node:assert/strict";
import test from "node:test";
import type { AgentProfile } from "../../src/contracts/profile.ts";
import { resolveSoftCapabilities } from "../../src/profiles/diagnostics.ts";

function researcher(): AgentProfile {
  return {
    name: "researcher",
    description: "Research",
    body: "Use external sources.",
    permissions: "read-only",
    preferredTools: ["web_search", "fetch_content", "get_search_content"],
    source: { path: "/profiles/researcher.md", scope: "bundled", namespace: "shared", priority: 0 },
  };
}

test("soft capability resolution intersects with actual child-exposed tools, never parent resources", () => {
  const resolved = resolveSoftCapabilities(researcher(), {
    tools: ["fetch_content"],
    reviewedExternalResearchTools: ["fetch_content"],
  });
  assert.deepEqual(resolved.tools, ["fetch_content"]);
  assert.deepEqual(resolved.missingTools, ["web_search", "get_search_content"]);
  assert.equal(resolved.research.state, "available");
  assert.equal(resolved.research.canClaimExternalResearch, true);
});

test("research is blocked when the child exposes no preferred reviewed external research tool", () => {
  const resolved = resolveSoftCapabilities(researcher(), {
    tools: ["read"],
    reviewedExternalResearchTools: [],
  });
  assert.equal(resolved.research.state, "blocked");
  assert.equal(resolved.research.available, false);
  assert.equal(resolved.research.canClaimExternalResearch, false);
  assert.equal(resolved.diagnostics.some((item) => item.code === "external-research-unavailable" && item.severity === "error"), true);
  assert.match(resolved.diagnostics.map((item) => item.message).join("\n"), /memory-only output must not be labelled researched/);
});

test("a profile cannot turn an arbitrary preferred tool into external-research proof", () => {
  const profile = { ...researcher(), preferredTools: ["read"] };
  const resolved = resolveSoftCapabilities(profile, {
    tools: ["read"],
    reviewedExternalResearchTools: [],
  });
  assert.deepEqual(resolved.tools, ["read"]);
  assert.equal(resolved.research.state, "blocked");
  assert.equal(resolved.research.canClaimExternalResearch, false);
});

test("non-research assignments warn for missing tool preferences without becoming blocked", () => {
  const profile = { ...researcher(), name: "scout" };
  const resolved = resolveSoftCapabilities(profile, {
    tools: [],
    reviewedExternalResearchTools: [],
  });
  assert.equal(resolved.research.state, "not-applicable");
  assert.equal(resolved.research.available, true);
  assert.equal(resolved.diagnostics.filter((item) => item.severity === "warning").length, 3);
});
