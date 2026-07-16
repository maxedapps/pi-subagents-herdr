import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface FakePtyCliFixture {
  readonly transport: "pty" | "pipe";
  readonly process: ChildProcessWithoutNullStreams;
  readonly screen: () => string;
  waitFor(text: string, timeoutMs?: number): Promise<void>;
  cleanup(): Promise<void>;
}

export async function createFakePtyCliFixture(): Promise<FakePtyCliFixture> {
  const directory = await mkdtemp(join(tmpdir(), "pi-herdr-pty-"));
  const executable = join(directory, "interactive.mjs");
  await writeFile(executable, `#!/usr/bin/env node
if (process.stdin.isTTY && process.stdin.setRawMode) process.stdin.setRawMode(true);
process.stdin.resume();
process.stdout.write("SCREEN:READY\\n");
let text = "";
process.stdin.on("data", (chunk) => {
  for (const byte of chunk) {
    if (byte === 0x1b) process.stdout.write("SCREEN:INTERRUPTED:ESCAPE\\n");
    else if (byte === 0x03) process.stdout.write("SCREEN:INTERRUPTED:CTRL_C\\n");
    else if (byte === 0x04) { process.stdout.write("SCREEN:EXIT:CTRL_D\\n"); process.exit(0); }
    else {
      text += String.fromCharCode(byte);
      if (text.endsWith("/exit\\r") || text.endsWith("/exit\\n")) { process.stdout.write("SCREEN:EXIT:SLASH\\n"); process.exit(0); }
    }
  }
});
`, { mode: 0o700 });
  await chmod(executable, 0o700);
  const wrapper = join(directory, "pty-wrapper.py");
  await writeFile(wrapper, `import os, pty, select, sys\nchild, fd = pty.fork()\nif child == 0:\n    os.execv(sys.argv[1], [sys.argv[1]])\nstdin_fd = sys.stdin.fileno()\nwhile True:\n    readable, _, _ = select.select([stdin_fd, fd], [], [])\n    if stdin_fd in readable:\n        data = os.read(stdin_fd, 4096)\n        if not data:\n            try: os.close(fd)\n            except OSError: pass\n            break\n        os.write(fd, data)\n    if fd in readable:\n        try: data = os.read(fd, 4096)\n        except OSError: break\n        if not data: break\n        os.write(sys.stdout.fileno(), data)\ntry: os.waitpid(child, 0)\nexcept ChildProcessError: pass\n`);
  const child = spawn("python3", [wrapper, executable], { stdio: ["pipe", "pipe", "pipe"] });
  let output = "";
  child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => { output += chunk; });
  child.stderr.on("data", (chunk: string) => { output += chunk; });
  const waitFor = async (text: string, timeoutMs = 2_000): Promise<void> => {
    const deadline = Date.now() + timeoutMs;
    while (!output.includes(text)) {
      if (Date.now() >= deadline) throw new Error(`Fake PTY screen did not contain ${text}: ${output}`);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  };
  await waitFor("SCREEN:READY");
  return {
    transport: "pty",
    process: child,
    screen: () => output,
    waitFor,
    async cleanup() {
      if (child.exitCode === null) child.kill("SIGTERM");
      await new Promise<void>((resolve) => child.exitCode !== null ? resolve() : child.once("close", () => resolve()));
      await rm(directory, { recursive: true, force: true });
    },
  };
}
