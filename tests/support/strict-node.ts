const tsxImport = import.meta.resolve("tsx");

/** Build arguments for a project-owned TypeScript child process. */
export function strictTsxArgs(...args: readonly string[]): string[] {
  return ["--throw-deprecation", "--import", tsxImport, ...args];
}
