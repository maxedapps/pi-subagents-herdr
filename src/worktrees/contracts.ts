import type { ArtifactReference } from "../contracts/artifact.ts";
import type { NativeSessionIdentity } from "../contracts/ownership.ts";

export const WORKTREE_STATES = [
  "created",
  "active",
  "dirty",
  "integration_pending",
  "integrated",
  "retained",
  "removed",
] as const;
export type WorktreeState = (typeof WORKTREE_STATES)[number];

/** Canonical Git identity. Repository identity is derived from the real common Git directory. */
export interface CheckoutIdentity {
  readonly schemaVersion: 1;
  readonly repositoryId: string;
  readonly commonGitDir: string;
  readonly checkoutPath: string;
  readonly gitHead: string;
}

export interface ParentBranchProof {
  readonly sessionId: string;
  readonly sessionPath?: string;
  readonly branchEntryId: string;
}

export interface WriterBinding {
  readonly runId: string;
  readonly runNonce: string;
  readonly terminalId: string;
  readonly nativeSession: NativeSessionIdentity;
  readonly parent: ParentBranchProof;
}

export interface HerdrLeaseReconciliation {
  readonly state: "live" | "gone" | "uncertain";
  readonly checkedAt: number;
  readonly herdrVersion: string;
  readonly protocol: 16;
  readonly reason: string;
  readonly boundTerminalId: string;
  readonly boundNativeSession: NativeSessionIdentity;
  readonly paneId?: string;
  readonly tabId?: string;
  readonly workspaceId?: string;
}

export interface WriterLease extends WriterBinding {
  readonly schemaVersion: 1;
  readonly checkout: CheckoutIdentity;
  readonly acquiredAt: number;
  readonly updatedAt: number;
  readonly lastReconciled: HerdrLeaseReconciliation;
}

export interface WorktreeOwner {
  readonly runId: string;
  readonly runNonce: string;
  readonly parent: ParentBranchProof;
}

export interface WorktreeWriterIdentity {
  readonly terminalId: string;
  readonly nativeSession: NativeSessionIdentity;
}

export interface WorktreeTabIdentity {
  readonly tabId: string;
  readonly rootPaneId: string;
  readonly rootTerminalId: string;
  readonly rootProcessBaseline: string;
}

export interface WorktreeCreationRoot {
  readonly tabId: string;
  readonly rootPaneId: string;
  readonly rootTerminalId: string;
  /** Absent only while the immediately persisted post-create baseline probe is incomplete/failed. */
  readonly rootProcessBaseline?: string;
}

export type ObjectiveIntegrationEvidence =
  | {
      readonly kind: "no_changes";
      readonly verifiedAt: number;
      readonly childHead: string;
      readonly baseCommit: string;
    }
  | {
      readonly kind: "commit_contained";
      readonly verifiedAt: number;
      readonly childHead: string;
      readonly parentHead: string;
      readonly parentCheckoutPath: string;
    }
  | {
      readonly kind: "tree_matches";
      readonly verifiedAt: number;
      readonly childTree: string;
      readonly parentTree: string;
      readonly parentHead: string;
      readonly parentCheckoutPath: string;
    };

export interface ParentVerificationState {
  readonly review: "pending" | "reviewed";
  readonly integration: "pending" | "verified" | "not_required";
  readonly reviewedAt?: number;
  readonly integrationEvidence?: ObjectiveIntegrationEvidence;
  readonly detail?: string;
}

export interface HumanDiscardDecision {
  readonly decisionId: string;
  readonly confirmedAt: number;
  readonly consequences: readonly string[];
}

export interface WorktreeRecord {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly repositoryId: string;
  readonly commonGitDir: string;
  readonly herdrRepositoryKey: string;
  readonly sourceWorkspaceId?: string;
  readonly sourceCheckoutPath: string;
  readonly workspaceId: string;
  readonly checkoutPath: string;
  readonly branch: string;
  /** True only when this extension generated the branch name during creation. */
  readonly generatedBranch?: boolean;
  readonly base: string;
  readonly state: WorktreeState;
  readonly createdRoot: WorktreeCreationRoot;
  readonly tab?: WorktreeTabIdentity;
  readonly owner: WorktreeOwner;
  /** Prior owner retained when a later parent session reauthorizes cleanup only. */
  readonly legacyOwner?: WorktreeOwner;
  readonly writer?: WorktreeWriterIdentity;
  /** Source artifact paths fixed before Herdr creates the disposable checkout. */
  readonly artifactPaths: readonly ArtifactReference[];
  readonly artifactsCaptured: boolean;
  readonly capturedArtifacts: readonly ArtifactReference[];
  readonly parentVerification: ParentVerificationState;
  readonly retentionReason?: string;
  readonly removalRefusal?: string;
  readonly humanDiscard?: HumanDiscardDecision;
  /** Durable write-ahead evidence that a destructive Herdr call may have started. */
  readonly removalAttempt?: { readonly force: boolean; readonly startedAt: number; readonly childHead: string };
  readonly finalization?: {
    readonly workspaceRemovedAt?: number;
    readonly removedPath?: string;
    readonly childHead?: string;
    readonly branchFinalizedAt?: number;
    readonly branchDisposition?: "deleted" | "preserved";
    readonly runtimeArtifactsPurgedAt?: number;
    readonly lastError?: string;
  };
  /** Recovery uncertainty always blocks further cleanup. */
  readonly recoveryIssue?: string;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface WorktreeStateView {
  readonly id: string;
  readonly repositoryId: string;
  readonly sourceWorkspaceId?: string;
  readonly workspaceId: string;
  readonly checkoutPath: string;
  readonly branch: string;
  readonly base: string;
  readonly state: WorktreeState;
  readonly writerRunId: string;
  readonly writerTerminalId?: string;
  readonly artifactsCaptured: boolean;
  readonly parentVerification: ParentVerificationState;
  readonly retentionReason?: string;
  readonly removalRefusal?: string;
  readonly finalized: boolean;
}

export function toWorktreeStateView(record: WorktreeRecord): WorktreeStateView {
  return {
    id: record.id,
    repositoryId: record.repositoryId,
    ...(record.sourceWorkspaceId === undefined ? {} : { sourceWorkspaceId: record.sourceWorkspaceId }),
    workspaceId: record.workspaceId,
    checkoutPath: record.checkoutPath,
    branch: record.branch,
    base: record.base,
    state: record.state,
    writerRunId: record.owner.runId,
    ...(record.writer === undefined ? {} : { writerTerminalId: record.writer.terminalId }),
    artifactsCaptured: record.artifactsCaptured,
    parentVerification: record.parentVerification,
    ...(record.retentionReason === undefined ? {} : { retentionReason: record.retentionReason }),
    ...(record.removalRefusal === undefined ? {} : { removalRefusal: record.removalRefusal }),
    finalized: record.state === "removed"
      && record.finalization?.branchFinalizedAt !== undefined
      && record.finalization.runtimeArtifactsPurgedAt !== undefined,
  };
}
