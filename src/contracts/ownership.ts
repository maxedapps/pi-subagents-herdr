export interface NativeSessionIdentity {
  readonly kind: "id" | "path";
  readonly value: string;
  readonly source: string;
}

export interface OwnershipProof {
  readonly runNonce: string;
  readonly parentSession: {
    readonly id?: string;
    readonly path?: string;
    readonly branchEntryId: string;
  };
  readonly createdFrom: {
    readonly workspaceId: string;
    readonly tabId: string;
    readonly paneId: string;
    readonly terminalId: string;
  };
  readonly child: {
    readonly terminalId?: string;
    readonly nativeSession?: NativeSessionIdentity;
  };
  readonly tab?: {
    readonly workspaceId: string;
    readonly tabId: string;
    readonly rootPaneId: string;
    readonly rootTerminalId: string;
    readonly rootProcessBaseline: string;
  };
  readonly worktree?: {
    readonly repositoryId: string;
    readonly commonGitDir: string;
    readonly herdrRepositoryKey: string;
    readonly sourceWorkspaceId?: string;
    readonly workspaceId: string;
    readonly checkoutPath: string;
    readonly branch: string;
    readonly base: string;
  };
}
