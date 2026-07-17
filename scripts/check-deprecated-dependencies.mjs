#!/usr/bin/env -S node --throw-deprecation
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const EXPECTED_EXCEPTION = Object.freeze({
  name: "node-domexception",
  version: "1.0.0",
  deprecated: "Use your platform's native DOMException instead",
});

function packageName(packagePath, entry) {
  const marker = "node_modules/";
  const index = packagePath.lastIndexOf(marker);
  if (index < 0) return typeof entry.name === "string" && entry.name.length > 0 ? entry.name : "<unknown>";
  const tail = packagePath.slice(index + marker.length);
  const parts = tail.split("/");
  return tail.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

export function auditDeprecatedDependencies(lock, lockfilePath = "package-lock.json") {
  if (lock === null || typeof lock !== "object" || Array.isArray(lock) || lock.packages === null || typeof lock.packages !== "object" || Array.isArray(lock.packages)) {
    return { allowed: [], errors: [`${lockfilePath}: expected a package-lock object with a packages map`] };
  }

  const allowed = [];
  const errors = [];
  for (const packagePath of Object.keys(lock.packages).sort()) {
    const entry = lock.packages[packagePath];
    if (entry === null || typeof entry !== "object" || Array.isArray(entry) || !("deprecated" in entry)) continue;
    if (typeof entry.deprecated !== "string") {
      errors.push(`${packagePath || "<root>"}: malformed deprecated metadata; expected a non-empty string`);
      continue;
    }
    if (entry.deprecated.length === 0) continue;

    const name = packageName(packagePath, entry);
    if (name !== EXPECTED_EXCEPTION.name) {
      errors.push(`${packagePath || "<root>"}: unreviewed deprecated dependency ${name}@${String(entry.version ?? "<missing>")}: ${entry.deprecated}`);
      continue;
    }
    if (entry.version !== EXPECTED_EXCEPTION.version) {
      errors.push(`${packagePath}: node-domexception exception requires version ${EXPECTED_EXCEPTION.version}, found ${String(entry.version ?? "<missing>")}`);
      continue;
    }
    if (entry.dev !== true) {
      errors.push(`${packagePath}: node-domexception exception requires dev=true; production or mixed paths are forbidden`);
      continue;
    }
    if (entry.deprecated !== EXPECTED_EXCEPTION.deprecated) {
      errors.push(`${packagePath}: node-domexception exception message changed; review the dependency before updating the allowlist`);
      continue;
    }
    allowed.push(packagePath);
  }

  if (allowed.length === 0) {
    errors.push(`stale node-domexception exception: no exact dev-only ${EXPECTED_EXCEPTION.name}@${EXPECTED_EXCEPTION.version} deprecated entry remains; remove the allowlist and contributor warning`);
  }
  return { allowed, errors };
}

function main() {
  const lockfilePath = resolve(process.argv[2] ?? "package-lock.json");
  let lock;
  try {
    lock = JSON.parse(readFileSync(lockfilePath, "utf8"));
  } catch (error) {
    process.stderr.write(`deprecated dependency audit failed: ${lockfilePath}: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
    return;
  }

  const result = auditDeprecatedDependencies(lock, lockfilePath);
  if (result.errors.length > 0) {
    process.stderr.write(`deprecated dependency audit failed for ${lockfilePath}:\n${result.errors.map((error) => `- ${error}`).join("\n")}\n`);
    process.exitCode = 1;
    return;
  }
  for (const packagePath of result.allowed) {
    process.stdout.write(`temporarily allowed ${EXPECTED_EXCEPTION.name}@${EXPECTED_EXCEPTION.version} (dev-only): ${packagePath}\n`);
  }
  process.stdout.write(`deprecated dependency audit passed: ${result.allowed.length} reviewed lock entr${result.allowed.length === 1 ? "y" : "ies"}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
