import type { Harness, ThinkingLevel } from "./harness.ts";

export type ProfileSourceScope = "bundled" | "user" | "project";
export type ProfileSourceNamespace = "shared" | "namespaced";

export interface ProfileSource {
  readonly path: string;
  readonly scope: ProfileSourceScope;
  readonly namespace: ProfileSourceNamespace;
  readonly priority: number;
}

export type ProfilePermission = "read-only" | "write";
export type ProfileWorktreePolicy = "forbidden" | "optional" | "required" | "required-for-concurrency";

export interface ProfileContextSettings {
  readonly project?: boolean;
  readonly parent?: boolean;
}

export interface ProfileArtifactSettings {
  readonly progress?: string;
  readonly handoff?: string;
  readonly writer?: "parent" | "child";
}

export interface AgentProfile {
  readonly name: string;
  readonly description: string;
  readonly body: string;
  readonly harness?: Harness;
  readonly model?: string;
  readonly thinking?: ThinkingLevel;
  readonly permissions?: ProfilePermission;
  readonly tools?: readonly string[];
  readonly preferredTools?: readonly string[];
  readonly context?: ProfileContextSettings;
  readonly timeout?: number;
  readonly worktree?: ProfileWorktreePolicy;
  readonly disabled?: boolean;
  readonly artifacts?: ProfileArtifactSettings;
  readonly source: ProfileSource;
}
