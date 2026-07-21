import type { RunArtifact } from "./artifact.ts";
import type { Run } from "./runtime.ts";
import {
  inventoryHerdrJournal,
  type HerdrLifecycleState,
  type JournalGeneration,
} from "./session.ts";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { AgentStatus } from "./herdr.ts";
import type { ProfileName } from "./profiles.ts";

export interface RecoveryCatalogRow {
  runId: string;
  profile?: ProfileName;
  source: "current" | "durable" | "artifact-only";
  lifecycle?: HerdrLifecycleState | Run["lifecycle"];
  status?: AgentStatus;
  generation?: number;
  delivery?: JournalGeneration["delivery"];
  outcome?: JournalGeneration["outcome"];
  branch: "active" | "historical" | "unknown";
  artifactPath?: string;
  artifactCompleteness?: "available" | "incomplete" | "unknown";
}

export interface RecoveryCatalogInput {
  entries: readonly SessionEntry[];
  branch: readonly SessionEntry[];
  parentSessionId: string;
  parentSessionFile: string;
  currentRuns: readonly Run[];
  artifacts: readonly RunArtifact[];
}

export function buildRecoveryCatalog(input: RecoveryCatalogInput): {
  rows: RecoveryCatalogRow[];
  invalidEntries: number;
} {
  const inventory = inventoryHerdrJournal(input.entries, input.parentSessionId, input.parentSessionFile);
  const activeEntryIds = new Set(input.branch.map(({ id }) => id));
  const currentRuns = new Map(input.currentRuns.map((run) => [run.id, run]));
  const artifacts = new Map(input.artifacts.map((artifact) => [artifact.runId, artifact.path]));
  const rows: RecoveryCatalogRow[] = [];

  for (const item of inventory.runs.values()) {
    const active = activeEntryIds.has(item.latestEntryId);
    const current = active ? currentRuns.get(item.runId) : undefined;
    const artifactPath = artifacts.get(item.runId);
    const artifactCompleteness = artifactPath
      ? item.latest.generation?.artifactResultPersisted === true
        || item.latest.generation?.outcome === "aborted"
        ? "available"
        : "incomplete"
      : undefined;
    rows.push(current ? {
      runId: item.runId,
      profile: current.profile,
      source: "current",
      lifecycle: current.lifecycle,
      status: current.status,
      ...(current.generation ? {
        generation: current.generation.number,
        delivery: current.generation.delivery,
        ...(current.generation.outcome ? { outcome: current.generation.outcome } : {}),
      } : {}),
      branch: "active",
      ...(artifactPath ? { artifactPath, artifactCompleteness } : {}),
    } : {
      runId: item.runId,
      profile: item.latest.profile,
      source: "durable",
      lifecycle: item.latest.state,
      ...(item.latest.status ? { status: item.latest.status } : {}),
      ...(item.latest.generation ? {
        generation: item.latest.generation.number,
        delivery: item.latest.generation.delivery,
        ...(item.latest.generation.outcome ? { outcome: item.latest.generation.outcome } : {}),
      } : {}),
      branch: active ? "active" : "historical",
      ...(artifactPath ? { artifactPath, artifactCompleteness } : {}),
    });
    artifacts.delete(item.runId);
  }

  for (const [runId, artifactPath] of artifacts) {
    rows.push({
      runId,
      source: "artifact-only",
      branch: "unknown",
      artifactPath,
      artifactCompleteness: "unknown",
    });
  }
  return { rows, invalidEntries: inventory.invalidEntries };
}

function generation(row: RecoveryCatalogRow): string {
  return row.generation === undefined
    ? "g? unknown"
    : `g${row.generation} ${row.outcome ?? row.delivery ?? "unknown"}`;
}

function artifact(row: RecoveryCatalogRow): string {
  return row.artifactPath
    ? `${row.artifactPath} (${row.artifactCompleteness ?? "unknown"})`
    : "artifact unavailable";
}

export function formatRecoveryCatalog(rows: readonly RecoveryCatalogRow[]): string {
  const header = "Parent-session subagent recovery catalog after compaction:";
  if (rows.length === 0) return `${header}\nNo parent-session subagent runs or artifacts were discovered.`;
  const lines = rows.map((row) => {
    const profile = row.profile ? ` [${row.profile}]` : "";
    if (row.source === "artifact-only") {
      return `- ${row.runId}${profile} — status/branch/completeness unknown (artifact only); artifact: ${artifact(row)}`;
    }
    const source = row.source === "current" ? "current" : "latest durable";
    return `- ${row.runId}${profile} — ${source} ${row.lifecycle}/${row.status ?? "unknown"}/${generation(row)}; ${row.branch} branch; artifact: ${artifact(row)}`;
  });
  return [header, ...lines].join("\n");
}
