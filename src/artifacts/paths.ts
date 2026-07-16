import { existsSync, realpathSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, parse, relative, resolve } from "node:path";
import type { ArtifactKind } from "../contracts/artifact.ts";
import type { Harness } from "../contracts/harness.ts";

export const ARTIFACT_PLACEHOLDERS = Object.freeze(["id", "groupId", "profile", "harness"] as const);
export type ArtifactPlaceholder = (typeof ARTIFACT_PLACEHOLDERS)[number];

export interface ArtifactPlaceholderValues {
  readonly id: string;
  readonly groupId?: string;
  readonly profile: string;
  readonly harness: Harness;
}

export interface ArtifactRoots {
  readonly checkout: string;
  readonly subagents: string;
  readonly progress?: string;
  readonly additional: readonly string[];
}

export interface ResolveArtifactRootsOptions {
  readonly checkout: string;
  readonly allowProgress: boolean;
  /** Canonical roots authorized by trusted settings, never by a tool call alone. */
  readonly trustedAdditionalRoots?: readonly string[];
}

export interface CanonicalRunArtifacts {
  readonly root: string;
  readonly runDirectory: string;
  readonly runMetadata: string;
  readonly groupMetadata: string;
  readonly progress: string;
  readonly handoff: string;
}

function isWithin(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function safePlaceholderValue(name: string, value: string | undefined): string {
  if (value === undefined) throw new Error(`Artifact placeholder {${name}} has no value`);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value) || value === "." || value === "..") {
    throw new Error(`Artifact placeholder {${name}} contains an unsafe path component`);
  }
  return value;
}

export async function resolveArtifactRoots(options: ResolveArtifactRootsOptions): Promise<ArtifactRoots> {
  const checkout = await realpath(resolve(options.checkout));
  if (checkout === parse(checkout).root) throw new Error("Artifact checkout must not be a filesystem root");
  const additional: string[] = [];
  for (const requested of options.trustedAdditionalRoots ?? []) {
    const canonical = await realpath(resolve(requested));
    if (canonical === parse(canonical).root) throw new Error("Artifact additional root must not be a filesystem root");
    if (!additional.includes(canonical)) additional.push(canonical);
  }
  return {
    checkout,
    subagents: join(checkout, ".subagents"),
    ...(options.allowProgress ? { progress: join(checkout, ".progress") } : {}),
    additional,
  };
}

export function canonicalRunArtifactPaths(
  roots: ArtifactRoots,
  values: Pick<ArtifactPlaceholderValues, "id" | "groupId">,
): CanonicalRunArtifacts {
  const id = safePlaceholderValue("id", values.id);
  const groupId = safePlaceholderValue("groupId", values.groupId);
  const runDirectory = join(roots.subagents, "runs", id);
  return {
    root: roots.subagents,
    runDirectory,
    runMetadata: join(runDirectory, "run.json"),
    groupMetadata: join(roots.subagents, "groups", `${groupId}.json`),
    progress: join(runDirectory, "progress.md"),
    handoff: join(runDirectory, "handoff.md"),
  };
}

export function expandArtifactTemplate(template: string, values: ArtifactPlaceholderValues): string {
  if (template.length === 0 || template.includes("\0")) throw new Error("Artifact path template must be non-empty and contain no NUL bytes");
  const expanded = template.replace(/\{([^{}]+)\}/g, (_match, rawName: string) => {
    if (!ARTIFACT_PLACEHOLDERS.includes(rawName as ArtifactPlaceholder)) {
      throw new Error(`Unknown artifact placeholder {${rawName}}; supported placeholders: ${ARTIFACT_PLACEHOLDERS.join(", ")}`);
    }
    const name = rawName as ArtifactPlaceholder;
    return safePlaceholderValue(name, values[name]);
  });
  if (/[{}]/.test(expanded)) throw new Error("Malformed artifact placeholder syntax");
  return expanded;
}

function assertSafeArtifactTemplateComponents(template: string): void {
  if (template.split(/[\\/]/).some((component) => component === "." || component === "..")) {
    throw new Error("Artifact path template must not contain '.' or '..' path components");
  }
}

/** Prove normalization cannot erase the run-unique component from a profile artifact template. */
export function assertRunUniqueArtifactTemplate(template: string): void {
  assertSafeArtifactTemplateComponents(template);
  if (!template.includes("{id}")) {
    throw new Error("Artifact path template must include the run-unique {id} placeholder");
  }
  const common = { groupId: "scope-group", profile: "scope-profile", harness: "pi" as const };
  const first = resolve(expandArtifactTemplate(template, { ...common, id: "scope-run-a" }));
  const second = resolve(expandArtifactTemplate(template, { ...common, id: "scope-run-b" }));
  if (first === second) {
    throw new Error("Artifact path template must resolve distinct safe IDs to distinct run destinations");
  }
}

function canonicalizeExistingPrefix(path: string): string {
  let current = path;
  const missing: string[] = [];
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) return path;
    missing.unshift(basename(current));
    current = parent;
  }
  return join(realpathSync.native(current), ...missing);
}

export function assertArtifactPathAllowed(path: string, roots: ArtifactRoots): string {
  const lexical = resolve(path);
  const allowed = [roots.subagents, ...(roots.progress === undefined ? [] : [roots.progress]), ...roots.additional];
  if (allowed.some((root) => isWithin(root, lexical))) return lexical;
  // Normalize platform aliases such as macOS /var -> /private/var by resolving
  // only the existing prefix. Missing target components remain lexical.
  const canonical = canonicalizeExistingPrefix(lexical);
  if (!allowed.some((root) => isWithin(root, canonical))) {
    throw new Error(`Artifact path is outside allowed roots: ${lexical}`);
  }
  return canonical;
}

export function resolveArtifactPath(
  template: string,
  values: ArtifactPlaceholderValues,
  roots: ArtifactRoots,
): string {
  if (template.includes("{id}")) assertRunUniqueArtifactTemplate(template);
  else assertSafeArtifactTemplateComponents(template);
  const expanded = expandArtifactTemplate(template, values);
  const absoluteTemplate = isAbsolute(expanded);
  const absolute = absoluteTemplate ? resolve(expanded) : resolve(roots.checkout, expanded);
  const allowed = assertArtifactPathAllowed(absolute, roots);
  if (absoluteTemplate && !roots.additional.some((root) => isWithin(root, allowed))) {
    throw new Error("Absolute artifact templates require a trusted additional root");
  }
  return allowed;
}

export function defaultArtifactPath(kind: ArtifactKind, canonical: CanonicalRunArtifacts): string {
  switch (kind) {
    case "progress": return canonical.progress;
    case "handoff": return canonical.handoff;
    case "metadata": return canonical.runMetadata;
  }
}
