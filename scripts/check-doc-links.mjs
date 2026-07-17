#!/usr/bin/env -S node --throw-deprecation
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const roots = ["README.md", "docs", "skills", "agents"];
function files(path) {
  if (!existsSync(path)) return [];
  if (statSync(path).isFile()) return path.endsWith(".md") ? [path] : [];
  return readdirSync(path, { withFileTypes: true }).flatMap((entry) => files(join(path, entry.name)));
}
function slug(value) {
  return value.trim().toLowerCase().replace(/[`*_~]/g, "").replace(/[^\p{L}\p{N}\s-]/gu, "").replace(/\s+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
}
function headings(text) {
  const values = new Set(); const counts = new Map();
  for (const line of text.split(/\r?\n/)) {
    const match = /^(#{1,6})\s+(.+?)\s*$/.exec(line); if (!match) continue;
    const base = slug(match[2].replace(/\s+#+$/, "")); const count = counts.get(base) ?? 0; counts.set(base, count + 1); values.add(count === 0 ? base : `${base}-${count}`);
  }
  return values;
}
const markdown = roots.flatMap((path) => files(join(root, path)));
const failures = [];
for (const source of markdown) {
  const text = readFileSync(source, "utf8");
  for (const match of text.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
    const raw = match[1].trim().replace(/^<|>$/g, "");
    if (!raw || /^(?:https?:|mailto:|#)/i.test(raw)) {
      if (raw.startsWith("#") && !headings(text).has(decodeURIComponent(raw.slice(1)))) failures.push(`${relative(root, source)}: missing local heading ${raw}`);
      continue;
    }
    const [pathPart, fragment] = raw.split("#", 2); const target = resolve(dirname(source), decodeURIComponent(pathPart));
    if (!existsSync(target)) { failures.push(`${relative(root, source)}: missing ${raw}`); continue; }
    if (fragment && target.endsWith(".md") && !headings(readFileSync(target, "utf8")).has(decodeURIComponent(fragment))) failures.push(`${relative(root, source)}: missing heading #${fragment} in ${relative(root, target)}`);
  }
}
for (const required of ["docs/architecture.md", "docs/profile-reference.md", "docs/operations.md", "docs/migration.md"]) if (!existsSync(join(root, required))) failures.push(`missing required documentation ${required}`);
if (failures.length) throw new Error(`Documentation link/load check failed:\n${failures.join("\n")}`);
process.stdout.write(`docs-link-load ok: ${markdown.length} markdown files; local targets and headings resolved\n`);
