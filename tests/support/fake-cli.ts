import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface FakeCliCapture {
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly stdin: string;
}

export interface FakeCliFixture {
  readonly executable: string;
  readonly capturePath: string;
  readCapture(): Promise<FakeCliCapture>;
  cleanup(): Promise<void>;
}

export async function createFakeCliFixture(environmentKeys: readonly string[] = []): Promise<FakeCliFixture> {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "pi-herdr-fake-cli-")));
  const executable = join(directory, "fake-cli.mjs");
  const capturePath = join(directory, "capture.json");
  const source = `#!/usr/bin/env -S node --throw-deprecation
import { writeFile } from "node:fs/promises";
let stdin = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) stdin += chunk;
const keys = ${JSON.stringify(environmentKeys)};
const env = Object.fromEntries(keys.flatMap((key) => process.env[key] === undefined ? [] : [[key, process.env[key]]]));
await writeFile(${JSON.stringify(capturePath)}, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), env, stdin }));
`;
  await writeFile(executable, source, { mode: 0o700 });
  await chmod(executable, 0o700);

  return {
    executable,
    capturePath,
    async readCapture() {
      return JSON.parse(await readFile(capturePath, "utf8")) as FakeCliCapture;
    },
    async cleanup() {
      await rm(directory, { recursive: true, force: true });
    },
  };
}
