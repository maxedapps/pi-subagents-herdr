export type ArtifactKind = "progress" | "handoff" | "metadata";
export type ArtifactWriter = "parent" | "child";

export interface ArtifactContract {
  readonly kind: ArtifactKind;
  readonly path: string;
  readonly writer: ArtifactWriter;
  readonly required: boolean;
}

export interface ArtifactReference extends ArtifactContract {
  readonly absolutePath: string;
  readonly capturedAt?: number;
  readonly byteLength?: number;
  readonly sha256?: string;
}
