import { fileURLToPath } from "node:url";
import { isAbsolute, relative, resolve } from "node:path";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));

export function getPackageRoot(): string {
  return packageRoot;
}

export function resolvePackagePath(...segments: readonly string[]): string {
  if (segments.some((segment) => isAbsolute(segment))) {
    throw new Error("Package asset paths must be relative");
  }
  const target = resolve(packageRoot, ...segments);
  const rel = relative(packageRoot, target);
  if (rel === ".." || rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(rel)) {
    throw new Error("Package asset path escapes the package root");
  }
  return target;
}

export const PACKAGE_ASSETS = Object.freeze({
  skill: resolvePackagePath("skills", "use-herdr-subagents", "SKILL.md"),
  agents: resolvePackagePath("agents"),
});
