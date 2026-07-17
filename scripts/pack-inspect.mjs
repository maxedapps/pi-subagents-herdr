import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packed = JSON.parse(execFileSync("npm", ["pack", "--json"], { cwd: projectRoot, encoding: "utf8" }));
if (!Array.isArray(packed) || packed.length !== 1 || typeof packed[0]?.filename !== "string") {
  throw new Error("npm pack --json returned an unexpected result");
}
const filename = packed[0].filename;
const archivePath = resolve(projectRoot, filename);
const listing = execFileSync("tar", ["-tzf", archivePath], { encoding: "utf8" }).trim().split("\n");
const required = [
  "package/extensions/herdr-subagents/index.ts",
  "package/skills/use-herdr-subagents/SKILL.md",
  "package/agents/README.md",
  "package/agents/scout.md",
  "package/agents/researcher.md",
  "package/agents/worker.md",
  "package/README.md",
  "package/package.json",
  "package/src/index.ts",
  "package/src/lifecycle/extension.ts",
  "package/src/results/contracts.ts",
  "package/src/results/store.ts",
  "package/src/results/child-bridge.ts",
  "package/src/results/coordinator.ts",
  "package/src/results/delivery.ts",
  "package/src/results/extractors.ts",
  "package/src/results/presentation.ts",
  "package/src/config/settings.ts",
  "package/src/policy/capabilities.ts",
  "package/src/profiles/discovery.ts",
  "package/src/profiles/parser.ts",
  "package/src/artifacts/store.ts",
  "package/src/tools/index.ts",
  "package/src/tools/service.ts",
  "package/src/tools/schemas.ts",
  "package/skills/use-herdr-subagents/references/prompt-and-safety.md",
  "package/src/artifacts/git-ignore.ts",
  "package/src/artifacts/handoff.ts",
  "package/scripts/conformance-herdr-no-model.ts",
  "package/scripts/conformance-herdr-worktree-no-model.ts",
  "package/scripts/update-herdr-protocol-fixtures.mjs",
  "package/scripts/pack-inspect.mjs",
  "package/scripts/smoke-load.ts",
  "package/scripts/e2e-herdr-smoke.mjs",
  "package/scripts/check-doc-links.mjs",
  "package/scripts/check-deprecated-dependencies.mjs",
  "package/docs/architecture.md",
  "package/docs/profile-reference.md",
  "package/docs/operations.md",
  "package/docs/migration.md",
];
for (const path of required) {
  if (!listing.includes(path)) throw new Error(`Packed archive is missing ${path}`);
}

function filesBelow(directory) {
  if (!existsSync(directory)) return [];
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...filesBelow(path));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

const publishedRoots = ["extensions", "src", "skills", "agents", "docs", "scripts"];
const expectedPublishedFiles = publishedRoots.flatMap((root) => filesBelow(join(projectRoot, root)))
  .map((path) => `package/${relative(projectRoot, path).split(sep).join("/")}`);
for (const path of expectedPublishedFiles) {
  if (!listing.includes(path)) throw new Error(`Packed archive omits published source/resource file ${path}`);
}

const packedManifest = JSON.parse(execFileSync("tar", ["-xOzf", archivePath, "package/package.json"], { encoding: "utf8" }));
const packedScriptContracts = {
  "conformance:herdr:no-model": { command: "node --throw-deprecation --import tsx scripts/conformance-herdr-no-model.ts", file: "package/scripts/conformance-herdr-no-model.ts" },
  "conformance:herdr:worktree:no-model": { command: "node --throw-deprecation --import tsx scripts/conformance-herdr-worktree-no-model.ts", file: "package/scripts/conformance-herdr-worktree-no-model.ts" },
  "protocol:fixtures": { command: "node --throw-deprecation scripts/update-herdr-protocol-fixtures.mjs", file: "package/scripts/update-herdr-protocol-fixtures.mjs" },
  "e2e:herdr:real": { command: "node --throw-deprecation scripts/e2e-herdr-smoke.mjs", file: "package/scripts/e2e-herdr-smoke.mjs" },
  "docs:check": { command: "node --throw-deprecation scripts/check-doc-links.mjs", file: "package/scripts/check-doc-links.mjs" },
  "deps:deprecations": { command: "node --throw-deprecation scripts/check-deprecated-dependencies.mjs package-lock.json", file: "package/scripts/check-deprecated-dependencies.mjs" },
};
for (const [name, contract] of Object.entries(packedScriptContracts)) {
  if (packedManifest.scripts?.[name] !== contract.command) throw new Error(`Packed script ${name} does not match its executable contract`);
  if (!listing.includes(contract.file)) throw new Error(`Packed script ${name} points to missing archive file ${contract.file}`);
}
if (packedManifest.dependencies?.tsx !== "4.23.1") throw new Error("Packed no-model TypeScript operator script requires tsx as an exact runtime dependency");
if (packedManifest.private !== true || packedManifest.license !== undefined || packedManifest.repository !== undefined || packedManifest.publishConfig !== undefined) throw new Error("Packed manifest violates the private legal/publication hold");

const forbiddenFragments = ["/.plans/", "/.progress/", "/.subagents/", "/tests/", "/node_modules/"];
for (const path of listing) {
  if (forbiddenFragments.some((fragment) => path.includes(fragment))) {
    throw new Error(`Packed archive contains forbidden path: ${path}`);
  }
}

const temporaryRoot = mkdtempSync(join(tmpdir(), "pi-subagents-herdr-pack-"));
const installRoot = join(temporaryRoot, "isolated-install");
const installedPackage = join(installRoot, "node_modules", "pi-subagents-herdr");
let isolatedLoadOutput;
try {
  writeFileSync(join(temporaryRoot, "runner.mjs"), `
import { existsSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const packageRoot = realpathSync(process.argv[2]);
const entryPath = join(packageRoot, "extensions", "herdr-subagents", "index.ts");
const packagePathsPath = join(packageRoot, "src", "package-paths.ts");
const lifecyclePath = join(packageRoot, "src", "lifecycle", "extension.ts");
const contractsPath = join(packageRoot, "src", "contracts", "index.ts");
const policyPath = join(packageRoot, "src", "policy", "capabilities.ts");
const profilesPath = join(packageRoot, "src", "profiles", "parser.ts");
const artifactsPath = join(packageRoot, "src", "artifacts", "index.ts");
const worktreesPath = join(packageRoot, "src", "worktrees", "index.ts");
const entry = await import(pathToFileURL(entryPath).href);
const packagePaths = await import(pathToFileURL(packagePathsPath).href);
const lifecycle = await import(pathToFileURL(lifecyclePath).href);
const profiles = await import(pathToFileURL(profilesPath).href);
await import(pathToFileURL(contractsPath).href);
await import(pathToFileURL(policyPath).href);
await import(pathToFileURL(artifactsPath).href);
await import(pathToFileURL(worktreesPath).href);
const registrations = [];
const handlers = new Map();
const tools = [];
const commands = [];
entry.default({ on(event, handler) { registrations.push(event); handlers.set(event, handler); }, registerTool(tool) { tools.push(tool.name); }, registerCommand(name) { commands.push(name); }, registerMessageRenderer() {}, getAllTools() { return []; } });
if (registrations.join(",") !== "resources_discover,session_start,agent_settled,message_end,session_shutdown") {
  throw new Error(\`Unexpected packed-extension registrations: \${registrations.join(",")}\`);
}
const discovered = handlers.get("resources_discover")?.({});
if (discovered?.skillPaths?.length !== 1 || realpathSync(discovered.skillPaths[0]) !== realpathSync(packagePaths.PACKAGE_ASSETS.skill)) {
  throw new Error("Packed parent resource handler did not expose the exact archive skill");
}
if (tools.join(",") !== "subagent_start,subagent_status,subagent_send,subagent_interrupt,subagent_stop") {
  throw new Error(\`Unexpected packed-extension tools: \${tools.join(",")}\`);
}
if (commands.join(",") !== "subagents,subagents-doctor") throw new Error(\`Unexpected packed-extension commands: \${commands.join(",")}\`);
if (realpathSync(packagePaths.getPackageRoot()) !== packageRoot) {
  throw new Error("Packed package paths resolved outside the isolated install");
}
if (!existsSync(packagePaths.PACKAGE_ASSETS.skill) || !existsSync(packagePaths.PACKAGE_ASSETS.agents)) {
  throw new Error("Packed package-relative assets are unavailable");
}
for (const name of ["scout", "researcher", "worker"]) {
  const profilePath = join(packagePaths.PACKAGE_ASSETS.agents, name + ".md");
  if (!existsSync(profilePath)) throw new Error("Packed bundled profile is unavailable: " + name);
  const source = await import("node:fs/promises").then((fs) => fs.readFile(profilePath, "utf8"));
  const parsed = profiles.parseProfile(source, { path: profilePath, scope: "bundled", namespace: "shared", priority: 0 });
  if (parsed.name !== name || parsed.model !== undefined) throw new Error("Packed bundled profile contract failed: " + name);
}
const childRegistrations = [];
const child = lifecycle.registerHerdrSubagentsExtension(
  { on(event) { childRegistrations.push(event); }, registerTool() { throw new Error("child must not register tools"); }, registerCommand() { throw new Error("child must not register commands"); } },
  { environment: { PI_HERDR_SUBAGENT: "1", PI_HERDR_SUBAGENT_RUN_ID: "run-1", PI_HERDR_SUBAGENT_RUN_NONCE: "nonce", PI_HERDR_SUBAGENT_RESULT_EXCHANGE: "/tmp/exchange" } },
);
if (child.mode !== "child" || child.registeredTools.length !== 0) {
  throw new Error("Packed child guard registered parent tools");
}
if (childRegistrations.sort().join(",") !== "agent_settled,message_end") {
  throw new Error("Packed child bridge must register only message_end and agent_settled: " + childRegistrations.join(","));
}
process.stdout.write("packed-isolated-load ok: extension import closure + contracts/policy/worktrees + assets + child guard\\n");
`);
  writeFileSync(join(temporaryRoot, "package.json"), '{"private":true,"type":"module"}\n');
  execFileSync(
    "npm",
    [
      "install",
      "--ignore-scripts",
      "--omit=dev",
      "--no-audit",
      "--no-fund",
      "--no-package-lock",
      "--prefix",
      installRoot,
      archivePath,
    ],
    { cwd: temporaryRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  if (!statSync(installedPackage).isDirectory()) throw new Error("Exact archive was not installed in isolation");

  const isolatedAgentDir = join(temporaryRoot, "pi-agent");
  const isolatedHome = join(temporaryRoot, "home");
  mkdirSync(isolatedAgentDir, { recursive: true });
  mkdirSync(isolatedHome, { recursive: true });
  writeFileSync(join(isolatedAgentDir, "settings.json"), `${JSON.stringify({ packages: [installedPackage], enableSkillCommands: true }, null, 2)}\n`);
  const fixtureSkill = join(isolatedAgentDir, "skills", "ordinary-fixture", "SKILL.md");
  mkdirSync(dirname(fixtureSkill), { recursive: true });
  writeFileSync(fixtureSkill, "---\nname: ordinary-fixture\ndescription: Ordinary child discovery fixture\n---\nUse this fixture only to prove normal skill discovery.\n");
  const genericSubagentSkill = join(isolatedAgentDir, "skills", "use-subagents", "SKILL.md");
  mkdirSync(dirname(genericSubagentSkill), { recursive: true });
  writeFileSync(genericSubagentSkill, "---\nname: use-subagents\ndescription: Generic subagent strategy fixture\n---\nUse this fixture only to prove that a generic subagent skill can coexist with the package runtime skill.\n");
  const environment = {
    ...process.env,
    HOME: isolatedHome,
    PI_CODING_AGENT_DIR: isolatedAgentDir,
    PI_OFFLINE: "1",
    PI_SKIP_VERSION_CHECK: "1",
    PI_TELEMETRY: "0",
    PI_HERDR_SUBAGENT: "0",
    HERDR_ENV: "",
    HERDR_SOCKET_PATH: "",
    HERDR_PANE_ID: "",
    HERDR_TAB_ID: "",
    HERDR_WORKSPACE_ID: "",
  };
  delete environment.NODE_OPTIONS;
  delete environment.NODE_PATH;
  const strictExecutionEnvironment = { ...environment, NODE_OPTIONS: "--throw-deprecation" };

  const installedAuditOutput = execFileSync(
    "npm",
    ["--prefix", installedPackage, "run", "deps:deprecations"],
    { cwd: temporaryRoot, env: strictExecutionEnvironment, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  if (!installedAuditOutput.includes("not applicable: source package-lock.json is intentionally excluded from the installed archive")) {
    throw new Error(`Installed archive deprecation audit reported an unexpected result: ${installedAuditOutput}`);
  }

  const tsxBin = join(installRoot, "node_modules", ".bin", process.platform === "win32" ? "tsx.cmd" : "tsx");
  if (!existsSync(tsxBin)) throw new Error("Exact archive runtime dependency did not install an isolated tsx executable");
  isolatedLoadOutput = execFileSync(
    tsxBin,
    [join(temporaryRoot, "runner.mjs"), installedPackage],
    { cwd: temporaryRoot, env: strictExecutionEnvironment, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  ).trim();
  if (!isolatedLoadOutput.startsWith("packed-isolated-load ok:")) throw new Error(`Unexpected isolated load result: ${isolatedLoadOutput}`);

  const rpc = (extraEnvironment, extraArgs = []) => {
    const output = execFileSync(
      "pi",
      ["--mode", "rpc", "--no-session", "--no-builtin-tools", "--no-context-files", ...extraArgs],
      { cwd: temporaryRoot, env: { ...strictExecutionEnvironment, ...extraEnvironment }, input: '{"id":"commands","type":"get_commands"}\n', encoding: "utf8", timeout: 20_000, stdio: ["pipe", "pipe", "pipe"] },
    );
    const response = output.trim().split("\n").map((line) => JSON.parse(line)).find((item) => item.id === "commands");
    if (!response?.success || !Array.isArray(response.data?.commands)) throw new Error(`Isolated Pi RPC package load failed: ${output}`);
    return response.data.commands;
  };
  const parentCommands = rpc({ PI_HERDR_SUBAGENT: "0" });
  for (const name of ["subagents", "subagents-doctor", "skill:use-herdr-subagents", "skill:use-subagents"]) {
    if (!parentCommands.some((command) => command.name === name)) throw new Error(`Actual isolated Pi package load omitted ${name}`);
  }
  const packageCommands = parentCommands.filter((command) => ["subagents", "subagents-doctor", "skill:use-herdr-subagents"].includes(command.name));
  for (const command of packageCommands) {
    const sourcePath = command.sourceInfo?.path ?? command.path;
    if (typeof sourcePath !== "string" || !realpathSync(sourcePath).startsWith(`${realpathSync(installedPackage)}${sep}`)) throw new Error(`Pi loaded ${command.name} outside the exact archive install: ${String(sourcePath)}`);
  }
  const genericCommand = parentCommands.find((command) => command.name === "skill:use-subagents");
  const genericSourcePath = genericCommand?.sourceInfo?.path ?? genericCommand?.path;
  if (typeof genericSourcePath !== "string" || realpathSync(genericSourcePath) !== realpathSync(genericSubagentSkill)) throw new Error("Generic subagent fixture did not coexist with the package runtime skill");
  const childCommands = rpc({ PI_HERDR_SUBAGENT: "1" });
  if (childCommands.some((command) => command.name === "subagents" || command.name === "subagents-doctor" || command.name === "skill:use-herdr-subagents")) throw new Error("Actual isolated Pi child-mode load exposed parent orchestration resources");
  for (const name of ["skill:ordinary-fixture", "skill:use-subagents"]) {
    if (!childCommands.some((command) => command.name === name)) throw new Error(`Actual isolated Pi child-mode load failed to discover ${name}`);
  }
  isolatedLoadOutput += "; actual Pi RPC loaded parent extension+doctor+runtime skill from the exact archive alongside a generic subagent skill, child mode hid package parent resources, and child normal discovery loaded both ordinary fixtures";
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}

process.stdout.write(`${JSON.stringify({
  filename,
  entryCount: listing.length,
  required,
  expectedPublishedFileCount: expectedPublishedFiles.length,
  packedScriptContracts,
  forbiddenFragments,
  isolatedLoad: isolatedLoadOutput,
}, null, 2)}\n`);
