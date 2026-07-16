import { parseDocument } from "yaml";
import type { AgentProfile, ProfileSource } from "../contracts/profile.ts";
import { ProfileValidationError, validateProfile } from "./schema.ts";

export interface ParsedFrontmatter {
  readonly frontmatter: unknown;
  readonly body: string;
}

export function parseProfileFrontmatter(text: string, sourcePath: string): ParsedFrontmatter {
  const normalized = text.startsWith("\uFEFF") ? text.slice(1) : text;
  const lines = normalized.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") {
    throw new ProfileValidationError(sourcePath, ["profile must begin with YAML frontmatter delimited by ---"]);
  }
  const closingIndex = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
  if (closingIndex < 0) {
    throw new ProfileValidationError(sourcePath, ["profile frontmatter is missing its closing --- delimiter"]);
  }
  const yamlText = lines.slice(1, closingIndex).join("\n");
  const document = parseDocument(yamlText, {
    prettyErrors: true,
    strict: true,
    uniqueKeys: true,
  });
  if (document.errors.length > 0) {
    throw new ProfileValidationError(
      sourcePath,
      document.errors.map((error) => `YAML parse failed: ${error.message}`),
    );
  }
  let frontmatter: unknown;
  try {
    frontmatter = document.toJS({ maxAliasCount: 20 });
  } catch (error) {
    throw new ProfileValidationError(sourcePath, [
      `YAML conversion failed: ${error instanceof Error ? error.message : String(error)}`,
    ]);
  }
  return { frontmatter, body: lines.slice(closingIndex + 1).join("\n") };
}

export function parseProfile(text: string, source: ProfileSource): AgentProfile {
  const { frontmatter, body } = parseProfileFrontmatter(text, source.path);
  return validateProfile(frontmatter, body, source);
}
